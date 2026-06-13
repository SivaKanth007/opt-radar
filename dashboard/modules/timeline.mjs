/**
 * dashboard/modules/timeline.mjs
 * Personal projection tool ("My timeline") + Similar cases.
 *
 * Renders the calculator into #calculator (form #calc-form, output #calc-out)
 * and the similar-cases panel into #similar (#similar-out).
 *
 * This is the highest-value, correctness-critical module. It ports and improves
 * the logic that previously lived inline in dashboard/app.js. It is fully
 * defensive: tolerates null/missing fields and empty result sets, never throws,
 * and always renders a clear empty state instead of all-dash projections.
 *
 * MODULE CONTRACT:
 *   export function render(ctx)                   // build form + restore + initial compute
 *   export function onCaseChange(ctx, myCase)     // re-render similar cases for a case
 *
 * ctx provides: data, diff, today, state, bus, and the destructured helpers
 * ($, $$, el, fmt, pct, wrapTable, countUp, ring, toast, confetti,
 *  prefersReducedMotion), plus ctx.dates / ctx.stats / ctx.cohort.
 *
 * PAIRING CONTRACT (honored exactly):
 *   dateField:'date_applied'  pairs with  mode:'applied'
 *   dateField:'pp_start'      pairs with  mode:'pp'
 */

const LS_KEY = 'opt-radar-mycase';
const SIM_WINDOW = 14;   // ±days for "similar" cohort (independent of the percentile cohort window)
const PAGE_SIZE = 15;    // similar-cases table pagination

// Module-local pagination state for the similar table. Reset whenever the case changes.
let _simState = { rows: [], page: 0, ctx: null };

// ---------------------------------------------------------------------------
// Helpers (defensive)
// ---------------------------------------------------------------------------

/** A case is usable for projection if it doesn't have impossible dates. */
function notImpossible(c) {
  return c && !((c.flags || []).includes('impossible_dates'));
}

/** Read a saved case from localStorage; tolerate corrupt / absent stores. */
function loadSaved() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null; // corrupt store — start fresh
  }
}

/** Persist the raw form values (the inputs, not the derived projection). */
function persist(form) {
  try {
    const state = {
      applied: form.elements.applied?.value || '',
      biometrics: form.elements.biometrics?.value || '',
      pp: form.elements.pp?.value || '',
      type: form.elements.type?.value || 'initial',
      ppstart: !!form.elements.ppstart?.checked,
    };
    localStorage.setItem(LS_KEY, JSON.stringify(state));
  } catch {
    /* storage disabled / full — non-fatal */
  }
}

/** Status label for a case row: 'approved' | 'stale' | 'pending'. */
function statusOf(c) {
  if (c.date_approved) return 'approved';
  if ((c.flags || []).includes('stale_pending')) return 'stale';
  return 'pending';
}

// ---------------------------------------------------------------------------
// render — build form, restore saved values, run initial compute
// ---------------------------------------------------------------------------

export function render(ctx) {
  const { $, el } = ctx;
  const form = $('#calc-form');
  if (!form) return; // section missing — nothing to do

  if (!form.dataset.built) {
    form.dataset.built = '1';
    // font-size:16px on inputs (via theme) stops iOS zoom; type/checkbox come from theme.
    form.innerHTML = `
      <label>Applied <input type="date" name="applied" required></label>
      <label>Biometrics <input type="date" name="biometrics"></label>
      <label>PP upgrade <input type="date" name="pp"></label>
      <label>Type
        <select name="type">
          <option value="initial">Initial OPT</option>
          <option value="stem">STEM extension</option>
        </select>
      </label>
      <label><input type="checkbox" name="ppstart"> Premium from start</label>
      <button type="submit">Project my timeline</button>`;

    // Restore saved inputs.
    const saved = loadSaved();
    if (saved) {
      for (const [k, v] of Object.entries(saved)) {
        const f = form.elements[k];
        if (!f) continue;
        if (f.type === 'checkbox') f.checked = !!v;
        else f.value = v ?? '';
      }
    }

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      compute(ctx, /* fromSubmit */ true);
    });
  }

  // Auto-compute on load if a saved applied date exists (restore path — no confetti).
  if (form.elements.applied && form.elements.applied.value) {
    compute(ctx, /* fromSubmit */ false);
  } else {
    // No saved case yet: gentle placeholder + ensure similar panel has an empty state.
    const out = $('#calc-out');
    if (out && !out.childElementCount) {
      out.replaceChildren(el('p', 'muted',
        'Enter your applied date above and hit Project to see where you stand against ~comparable cases.'));
    }
    renderSimilarEmpty(ctx, 'Project your timeline above to see cases similar to yours.');
  }
}

// ---------------------------------------------------------------------------
// compute — the projection core
// ---------------------------------------------------------------------------

function compute(ctx, fromSubmit) {
  const { $, el, fmt, wrapTable, toast, confetti, prefersReducedMotion } = ctx;
  const { data } = ctx;
  const { daysBetween, addDays, addBusinessDays, localToday } = ctx.dates;
  const { naivePercentiles, kmCurve, kmQuantile, kmConditionalQuantile } = ctx.stats;
  const { matchCohort, buildObservations } = ctx.cohort;

  const form = $('#calc-form');
  const out = $('#calc-out');
  if (!form || !out) return;

  persist(form);

  const v = Object.fromEntries(new FormData(form));
  const applied = v.applied || '';
  if (!applied) {
    out.replaceChildren(el('p', 'muted', 'Enter your applied date to project your timeline.'));
    return;
  }
  const type = v.type || 'initial';
  const biometrics = v.biometrics || '';
  const pp = v.pp || '';
  const ppStartChecked = !!form.elements.ppstart?.checked;

  // premium = checkbox OR a pp date provided. ppMode = premium. ppStart = pp || applied.
  const premium = ppStartChecked || !!pp;
  const ppMode = premium;
  const ppStart = pp || applied;
  const start = ppMode ? ppStart : applied;

  const today = data?.today || localToday();

  // Cohort + observations — HONOR THE PAIRING CONTRACT EXACTLY.
  const cases = Array.isArray(data?.cases) ? data.cases : [];
  const { cohort, windowDays, premiumFilterDropped } = matchCohort(cases, {
    refDate: start,
    optType: type,
    premium,
    dateField: ppMode ? 'pp_start' : 'date_applied',
  });

  // The shared myCase object — set even on the empty path so cheer/similar can react.
  const myCaseBase = {
    applied, biometrics, pp, type, premium, ppStart,
    projection: { p10Date: null, p50Date: null, p90Date: null, kmP50Date: null },
  };

  // EMPTY-COHORT GUARD: no comparable cases. Show a clear message, still update
  // similar cases, set state, emit, and return (no all-dash table, no spurious
  // 'premium filter dropped' note).
  if (!cohort || cohort.length === 0) {
    out.replaceChildren(el('p', 'muted',
      'No comparable cases in the data for these dates and type — try a different applied date, type, or toggle premium.'));
    commitCase(ctx, myCaseBase, /* fromSubmit */ false);
    return;
  }

  const obs = buildObservations(cohort, {
    today,
    staleCap: data?.stale_cutoff_days,
    mode: ppMode ? 'pp' : 'applied',
  });

  const events = obs.filter(o => o.event).map(o => o.t);
  const naive = naivePercentiles(events, [0.1, 0.5, 0.9]) || {};
  const curve = kmCurve(obs);

  const elapsed = Math.max(0, daysBetween(start, today));
  const censShare = obs.length ? (obs.length - events.length) / obs.length : 0;

  // KM percentiles (days from start).
  const kmP10 = kmQuantile(curve, 0.1);
  const kmP50 = kmQuantile(curve, 0.5);
  const kmP90 = kmQuantile(curve, 0.9);

  // Date renderers.
  const dateOf = (days) => days == null ? 'not reached in data' : `${addDays(start, days)} (day ${days})`;
  const condOf = (p) => {
    const t = kmConditionalQuantile(curve, elapsed, p);
    if (t == null) return 'not reached in data';
    const more = Math.max(0, t - elapsed);
    return `${addDays(start, t)} (${more} more day${more === 1 ? '' : 's'})`;
  };

  // ---- Build output ----
  out.replaceChildren();

  // Cohort description line (premium-filter-dropped only shown when cohort non-empty).
  const desc = el('p', 'muted');
  desc.textContent =
    `${ppMode ? `Premium clock from ${ppStart}` : `Regular clock from ${applied}`}` +
    ` · cohort n=${cohort.length} (±${windowDays}d${premiumFilterDropped ? ', premium filter dropped' : ''})` +
    ` · ${Math.round(censShare * 100)}% still pending (censored)`;
  out.append(desc);

  // USCIS premium 30-business-day deadline (holiday-aware). Premium path only.
  if (ppMode) {
    const deadline = addBusinessDays(ppStart, 30);
    const p = el('p', null);
    p.append(
      el('strong', null, 'USCIS premium 30-business-day target: '),
      el('span', null, deadline),
      el('span', 'muted', '  (skips weekends + US federal holidays)'),
    );
    out.append(p);
  }

  // ---- Personal percentile ruler ----
  out.append(buildRuler(ctx, { start, elapsed, kmP10, kmP50, kmP90 }));

  // ---- Projection table: naive (events only) vs survival-adjusted ----
  const rows = [
    ['Best case (p10)', dateOf(naive.p10), dateOf(kmP10)],
    ['Typical (median, p50)', dateOf(naive.p50), dateOf(kmP50)],
    ['Worst case (p90)', dateOf(naive.p90), dateOf(kmP90)],
    [`Given you've waited ${elapsed}d — typical remaining`, '—', condOf(0.5)],
    [`Given you've waited ${elapsed}d — p90 remaining`, '—', condOf(0.9)],
  ];
  const tbl = el('table');
  tbl.innerHTML =
    '<tr><th></th><th>Naive (approved only)</th><th>Survival-adjusted</th></tr>';
  for (const [label, a, b] of rows) {
    const tr = el('tr');
    const tdL = el('td', null, label);
    const tdA = el('td', null, a);
    const tdB = el('td', null, b);
    tr.append(tdL, tdA, tdB);
    tbl.append(tr);
  }
  out.append(wrapTable(tbl));

  // Honest caveat about lengthening waits — never fabricate good news.
  out.append(el('p', 'muted',
    'Naive uses approved cases only (biased fast). Survival-adjusted counts pending cases as "at least N days" (Kaplan-Meier) and is the more honest estimate. Waits have been lengthening recently — these are projections, not promises.'));

  // ---- Commit shared state + emit ----
  const myCase = {
    ...myCaseBase,
    projection: {
      p10Date: kmP10 == null ? null : addDays(start, kmP10),
      p50Date: kmP50 == null ? null : addDays(start, kmP50),
      p90Date: kmP90 == null ? null : addDays(start, kmP90),
      kmP50Date: kmP50 == null ? null : addDays(start, kmP50),
    },
  };

  // Celebrate only on an explicit submit, and only a TRUE positive: the user is
  // already past the typical (p50) wait, so approval should be imminent.
  const pastMedian = kmP50 != null && elapsed >= kmP50;
  commitCase(ctx, myCase, /* fromSubmit */ fromSubmit && pastMedian, { toast, confetti, prefersReducedMotion });
}

/**
 * commitCase — set ctx.state.myCase, emit 'caseChange', refresh similar panel,
 * and optionally fire a celebration (only when celebrate=true).
 */
function commitCase(ctx, myCase, celebrate, fx) {
  ctx.state = ctx.state || {};
  ctx.state.myCase = myCase;
  // Refresh similar cases directly (also re-rendered by the bus listener in app.js).
  renderSimilar(ctx, myCase);
  if (ctx.bus && typeof ctx.bus.emit === 'function') {
    ctx.bus.emit('caseChange', myCase);
  }
  if (celebrate && fx && !fx.prefersReducedMotion()) {
    fx.toast('You\'re past the typical wait — approvals around your mark are landing now. Hang in there.', 'good');
    fx.confetti({ count: 90 });
  }
}

// ---------------------------------------------------------------------------
// Percentile ruler ("you are here")
// ---------------------------------------------------------------------------

function buildRuler(ctx, { start, elapsed, kmP10, kmP50, kmP90 }) {
  const { el } = ctx;
  const { addDays } = ctx.dates;

  const wrap = el('div', 'ruler');

  // Scale: 0 .. max(p90, elapsed, p50, 1). Guard against null percentiles.
  const candidates = [kmP10, kmP50, kmP90, elapsed].filter(n => n != null && isFinite(n));
  const maxT = Math.max(1, ...candidates);
  const posPct = (t) => `${Math.max(0, Math.min(100, (t / maxT) * 100))}%`;

  const track = el('div', 'ruler-track');

  // Fill up to the user's elapsed position.
  const fill = el('div', 'ruler-fill');
  fill.style.width = posPct(Math.min(elapsed, maxT));
  track.append(fill);

  // Percentile ticks (best/typical/worst), only when defined.
  const ticks = [
    [kmP10, 'Best', 'p10'],
    [kmP50, 'Typical', 'p50'],
    [kmP90, 'Worst', 'p90'],
  ];
  for (const [t, name] of ticks) {
    if (t == null || !isFinite(t)) continue;
    const tick = el('div', 'ruler-tick');
    tick.style.left = posPct(t);
    track.append(tick);
    const lab = el('div', 'ruler-tick-label', `${name} · ${addDays(start, t)}`);
    lab.style.left = posPct(t);
    track.append(lab);
  }

  // "You are here" glowing marker at elapsed.
  const marker = el('div', 'ruler-marker');
  marker.style.left = posPct(Math.min(elapsed, maxT));
  track.append(marker);
  const markerLabel = el('div', 'ruler-marker-label', `You · day ${elapsed}`);
  markerLabel.style.left = posPct(Math.min(elapsed, maxT));
  track.append(markerLabel);

  wrap.append(track);

  // Encouraging-but-honest copy when past the median.
  if (kmP50 != null && isFinite(kmP50) && elapsed >= kmP50) {
    const ahead = elapsed - kmP50;
    wrap.append(el('p', 'muted',
      `You're ${ahead} day${ahead === 1 ? '' : 's'} past the typical wait for your cohort. Most comparable cases this far along have already been approved — yours should be close. (No guarantees; waits have been stretching lately.)`));
  } else if (kmP50 != null && isFinite(kmP50)) {
    const toMedian = kmP50 - elapsed;
    wrap.append(el('p', 'muted',
      `About ${toMedian} day${toMedian === 1 ? '' : 's'} to the typical (median) approval mark for your cohort.`));
  }

  return wrap;
}

// ---------------------------------------------------------------------------
// onCaseChange — re-render similar cases for a (possibly external) case
// ---------------------------------------------------------------------------

export function onCaseChange(ctx, myCase) {
  if (!myCase || !myCase.applied) {
    renderSimilarEmpty(ctx, 'Project your timeline above to see cases similar to yours.');
    return;
  }
  renderSimilar(ctx, myCase);
}

// ---------------------------------------------------------------------------
// Similar cases (#similar / #similar-out)
// ---------------------------------------------------------------------------

function renderSimilarEmpty(ctx, message) {
  const { $, el } = ctx;
  const out = $('#similar-out');
  if (!out) return;
  out.replaceChildren(el('p', 'muted', message));
}

function renderSimilar(ctx, myCase) {
  const { $, el, fmt, ring, countUp } = ctx;
  const { data } = ctx;
  const { daysBetween, localToday } = ctx.dates;
  const { quantileSorted } = ctx.stats;

  const out = $('#similar-out');
  if (!out) return;

  if (!myCase || !myCase.applied) {
    renderSimilarEmpty(ctx, 'Project your timeline above to see cases similar to yours.');
    return;
  }

  const today = data?.today || localToday();
  const cases = Array.isArray(data?.cases) ? data.cases : [];
  const { applied, type, premium } = myCase;

  // Similar = same type + premium, applied within ±SIM_WINDOW days, not impossible-dated.
  const sims = cases
    .filter(c =>
      notImpossible(c) &&
      c.date_applied &&
      c.opt_type === type &&
      !!c.premium === !!premium &&
      Math.abs(daysBetween(applied, c.date_applied)) <= SIM_WINDOW)
    .sort((a, b) =>
      Math.abs(daysBetween(applied, a.date_applied)) - Math.abs(daysBetween(applied, b.date_applied)));

  if (!sims.length) {
    renderSimilarEmpty(ctx,
      `No cases within ±${SIM_WINDOW} days of ${applied} with the same type and premium status. Try widening your search by toggling premium or picking a nearby date.`);
    return;
  }

  // Approval rate + summary among the similar cohort.
  const approved = sims.filter(c => c.date_approved);
  const pending = sims.filter(c => !c.date_approved);
  const ratePct = sims.length ? (approved.length / sims.length) * 100 : 0;
  const apprDurs = approved
    .map(c => daysBetween(c.date_applied, c.date_approved))
    .filter(d => d >= 0)
    .sort((a, b) => a - b);
  const medianApproved = apprDurs.length ? quantileSorted(apprDurs, 0.5) : null;

  out.replaceChildren();

  // ---- Ring + summary strip ----
  const head = el('div', 'cards');

  const ringWrap = el('div', 'ring-wrap');
  ringWrap.append(ring({
    percent: ratePct,
    size: 132,
    label: `${Math.round(ratePct)}%`,
    sublabel: 'approved',
  }));
  head.append(ringWrap);

  // Summary card with animated counts.
  const sumCard = el('div', 'card good');
  const sumVal = el('div', 'value', '0');
  const sumLab = el('div', 'label',
    `of ${sims.length} comparable case${sims.length === 1 ? '' : 's'} approved` +
    (medianApproved != null ? ` · median wait ${fmt(medianApproved)}d` : ''));
  sumCard.append(sumVal, sumLab);
  head.append(sumCard);
  countUp(sumVal, approved.length, { suffix: ` approved · ${pending.length} pending` });

  out.append(head);

  // ---- Paginated table ----
  _simState = { rows: sims, page: 0, ctx, today };
  const tableHost = el('div');
  tableHost.id = 'similar-table-host';
  out.append(tableHost);
  renderSimilarPage(tableHost);
}

/** Render the current page of the similar-cases table into `host`. */
function renderSimilarPage(host) {
  const { ctx, rows, page, today } = _simState;
  const { el, wrapTable } = ctx;
  const { daysBetween } = ctx.dates;

  host.replaceChildren();

  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const clamped = Math.max(0, Math.min(page, totalPages - 1));
  _simState.page = clamped;
  const slice = rows.slice(clamped * PAGE_SIZE, clamped * PAGE_SIZE + PAGE_SIZE);

  const tbl = el('table');
  tbl.innerHTML =
    '<tr><th>Applied</th><th>Biometrics</th><th>PP upgrade</th><th>Approved</th>' +
    '<th>Card</th><th>Days</th><th>Status</th><th>Link</th></tr>';

  for (const c of slice) {
    const status = statusOf(c);
    const days = c.date_approved
      ? daysBetween(c.date_applied, c.date_approved)
      : daysBetween(c.date_applied, today);
    const daysCell = `${days}${c.date_approved ? '' : '+'}`;

    const tr = el('tr');
    if (status === 'approved') tr.className = 'ok';

    tr.append(
      el('td', null, c.date_applied ?? '—'),
      el('td', null, c.biometrics_date ?? '—'),
      el('td', null, c.pp_upgrade_date ?? '—'),
      el('td', null, c.date_approved ?? '—'),
      el('td', null, c.card_received ?? c.card_produced ?? '—'),
      el('td', null, daysCell),
      el('td', null, status),
    );

    const linkTd = el('td');
    if (c.reddit_url) {
      const a = el('a', null, 'reddit');
      a.href = c.reddit_url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      linkTd.append(a);
    } else {
      linkTd.textContent = '—';
    }
    tr.append(linkTd);

    tbl.append(tr);
  }

  host.append(wrapTable(tbl));

  // Pager (only when more than one page).
  if (totalPages > 1) {
    const pager = el('div', 'cards');
    pager.style.marginTop = '12px';
    pager.style.alignItems = 'center';

    const prev = el('button', null, '‹ Prev');
    prev.type = 'button';
    prev.disabled = clamped === 0;
    prev.addEventListener('click', () => { _simState.page = clamped - 1; renderSimilarPage(host); });

    const info = el('div', 'label',
      `Page ${clamped + 1} / ${totalPages} · ${rows.length} similar case${rows.length === 1 ? '' : 's'}`);

    const next = el('button', null, 'Next ›');
    next.type = 'button';
    next.disabled = clamped >= totalPages - 1;
    next.addEventListener('click', () => { _simState.page = clamped + 1; renderSimilarPage(host); });

    pager.append(prev, info, next);
    host.append(pager);
  }
}
