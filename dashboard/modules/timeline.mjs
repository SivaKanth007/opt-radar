/**
 * dashboard/modules/timeline.mjs
 * Personal projection tool ("My timeline") + Similar cases.
 *
 * Renders the calculator into #calculator (form #calc-form, output #calc-out)
 * and the similar-cases panel into #similar (#similar-out).
 *
 * #calc-out order: cohort line → premium deadline (pp only) → percentile ruler
 * ("you are here") → approval-chance curve (Chart.js, canvas #chance-curve) +
 * headline stat → naive-vs-survival projection table → honest caveat.
 * The similar panel shows BOTH the reported approval rate and a rate adjusted
 * for silent drop-offs (stale_pending removed from the denominator), because
 * many users never update after approval — true denials are rare.
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

// Latest ctx from render(). The submit listener is bound ONCE (permanent form
// node) but app.js builds a fresh ctx every load — the handler must use the
// current one, not the first load's snapshot.
let _ctx = null;

// Module-level Chart.js handle for the approval-chance curve (destroy-before-recreate).
let _chanceChart = null;

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
      approved: form.elements.approved?.value || '',
      produced: form.elements.produced?.value || '',
      received: form.elements.received?.value || '',
    };
    localStorage.setItem(LS_KEY, JSON.stringify(state));
  } catch {
    /* storage disabled / full — non-fatal */
  }
}

/**
 * Prefills for the journey fields, in priority order:
 * 1. the old card-tracker anchor ('opt-radar-card-anchor', pre-merge store)
 * 2. the USCIS status watch's last approval reading ("On July 1, 2026, …")
 *
 * A field is only filled while its key has NEVER been persisted post-merge
 * (absent from the saved record). persist() writes every key — including
 * empty strings — so once the user saves anything, a deliberately cleared
 * date stays cleared instead of resurrecting from the legacy stores.
 */
function migrateJourneyFields(saved) {
  const out = { ...(saved || {}) };
  const virgin = (k) => !(k in out);
  try {
    const a = JSON.parse(localStorage.getItem('opt-radar-card-anchor') || 'null');
    if (a && /^\d{4}-\d{2}-\d{2}$/.test(a.date || '')) {
      if (a.kind === 'produced' && virgin('produced')) out.produced = a.date;
      if (a.kind === 'approved' && virgin('approved')) out.approved = a.date;
    }
  } catch { /* corrupt/absent — skip */ }
  try {
    const w = JSON.parse(localStorage.getItem('opt-radar-case-watch') || 'null');
    const last = w?.last;
    if (last?.kind === 'approved' && virgin('approved') && virgin('produced')) {
      const m = String(last.detail || '').match(/on ([A-Z][a-z]+ \d{1,2}, \d{4})/i);
      const t = m ? new Date(m[1] + ' 12:00:00') : null; // noon dodges tz day-shift
      if (t && !isNaN(t)) {
        const iso = t.toISOString().slice(0, 10);
        if (/card .*(being )?produced|card was mailed/i.test(last.status || '')) out.produced = iso;
        else out.approved = iso;
      }
    }
  } catch { /* corrupt/absent — skip */ }
  return out;
}

/** Status label for a case row: 'approved' | 'stale' | 'pending'. */
function statusOf(c) {
  if (c.date_approved) return 'approved';
  if ((c.flags || []).includes('stale_pending')) return 'stale';
  return 'pending';
}

/** Destroy any live approval-chance chart (module handle + canvas registry). */
function destroyChanceChart() {
  try {
    if (_chanceChart) { _chanceChart.destroy(); _chanceChart = null; }
    const cv = document.getElementById('chance-curve');
    if (cv && window.Chart) window.Chart.getChart(cv)?.destroy();
  } catch { /* never let chart teardown break a re-render */ }
}

/**
 * Chart palette read live from CSS variables so the chart follows the active
 * light/dark scheme (same convention as modules/trends.mjs COLORS). The
 * literals are dark-theme fallbacks.
 */
function chanceColors() {
  const v = (name, fb) => {
    try { return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fb; }
    catch { return fb; }
  };
  return {
    axis:         v('--muted', '#8b97b0'),
    legend:       v('--text', '#e8edf7'),
    grid:         v('--border', 'rgba(140, 165, 220, 0.14)'),
    accent:       v('--accent', '#22d3ee'),
    accentFill:   'rgba(34, 211, 238, 0.14)', // low-alpha cyan reads fine on both themes
    marker:       v('--warn', '#fbbf24'),
    tooltipBg:    v('--tooltip-bg', 'rgba(7, 10, 19, 0.92)'),
    tooltipTitle: v('--text', '#e8edf7'),
    tooltipBody:  v('--muted', '#cbd5e1'),
  };
}

// ---------------------------------------------------------------------------
// render — build form, restore saved values, run initial compute
// ---------------------------------------------------------------------------

export function render(ctx) {
  const { $, el } = ctx;
  _ctx = ctx; // keep the once-bound submit handler on the current snapshot
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
      <span class="form-divider">Got further? Fill what you have — everything below is optional.</span>
      <label>Approved <input type="date" name="approved"></label>
      <label>Card produced <input type="date" name="produced"></label>
      <label>Card in hand <input type="date" name="received"></label>
      <button type="submit">Project my journey</button>`;

    // Restore saved inputs (+ one-time prefill from pre-merge stores).
    const saved = migrateJourneyFields(loadSaved());
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
      compute(_ctx || ctx, /* fromSubmit */ true);
    });
  }

  // Auto-compute on load if a saved applied date exists (restore path — no confetti).
  if (form.elements.applied && form.elements.applied.value) {
    compute(ctx, /* fromSubmit */ false);
  } else {
    // No applied date: reset ALL three panels together so a re-render never
    // leaves a stale projection next to an empty stepper/similar panel.
    destroyChanceChart();
    const out = $('#calc-out');
    if (out) {
      out.replaceChildren(el('p', 'muted',
        'Enter your applied date (and any later milestones you\'ve hit) and hit Project to see your whole journey against comparable cases.'));
    }
    paintStepper(ctx, null);
    renderSimilarEmpty(ctx, 'Project your journey above to see cases similar to yours.');
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

  // Every path below replaces #calc-out — release the old chart first so
  // Chart.js instances never leak or stack across re-renders.
  destroyChanceChart();

  persist(form);

  const v = Object.fromEntries(new FormData(form));
  const applied = v.applied || '';
  if (!applied) {
    out.replaceChildren(el('p', 'muted', 'Enter your applied date to project your journey.'));
    paintStepper(ctx, null);
    return;
  }
  const type = v.type || 'initial';
  const biometrics = v.biometrics || '';
  const pp = v.pp || '';
  // Journey milestones (all optional) — they decide which stage the console shows.
  const approvedD = v.approved || '';
  const producedD = v.produced || '';
  const receivedD = v.received || '';
  const stage = receivedD ? 'complete' : producedD ? 'produced' : approvedD ? 'approved' : 'pending';
  const ppStartChecked = !!form.elements.ppstart?.checked;

  // premium = checkbox OR a pp date provided. Premium CLOCK START (the
  // 30-business-day promise runs from here, same rule as lib/merge.mjs ppStart):
  // max(upgrade date, biometrics) — biometrics resets the clock for
  // premium-from-start filers; fallback applied when neither is known.
  const premium = ppStartChecked || !!pp;
  const ppMode = premium;
  const clockCands = [pp, biometrics].filter(Boolean);
  const ppStart = clockCands.length ? clockCands.sort().at(-1) : applied;
  const start = ppMode ? ppStart : applied;

  const today = data?.today || localToday();
  const cases = Array.isArray(data?.cases) ? data.cases : [];
  const cardSt = ctx.cards?.cardStats ? ctx.cards.cardStats(cases) : null;

  // The shared myCase object — set even on the empty path so cheer/similar can react.
  const myCaseBase = {
    applied, biometrics, pp, type, premium, ppStart,
    approved: approvedD || null,
    produced: producedD || null,
    received: receivedD || null,
    journeyStage: stage,
    projection: { p10Date: null, p50Date: null, p90Date: null, kmP50Date: null },
  };

  // Date-order sanity — warn, never block (people mistype; the math guards itself).
  const orderProblems = [];
  const chk = (a, b, label) => { if (a && b && daysBetween(a, b) < 0) orderProblems.push(label); };
  chk(applied, approvedD, 'approved is before applied');
  chk(approvedD || applied, producedD, 'card produced is before approval');
  chk(producedD || approvedD || applied, receivedD, 'card received is before produced');

  // ---- POST-APPROVAL BRANCH: the approval question is settled — the console
  // becomes a card countdown / full-journey recap instead of survival math.
  if (stage !== 'pending') {
    const model = {
      applied, biometrics, approved: approvedD, produced: producedD, received: receivedD,
      stage, today, cardSt,
    };
    paintStepper(ctx, journeyStepperModel(ctx, model));
    renderJourneyConsole(ctx, out, model, orderProblems);
    const complete = stage === 'complete' && !orderProblems.length;
    commitCase(ctx, myCaseBase, /* celebrate */ fromSubmit && complete,
      { toast, confetti, prefersReducedMotion },
      'Card in hand — journey complete. Congratulations! 🎉');
    return;
  }

  // ---- PENDING BRANCH: cohort + observations — HONOR THE PAIRING CONTRACT EXACTLY.
  const { cohort, windowDays, premiumFilterDropped } = matchCohort(cases, {
    refDate: start,
    optType: type,
    premium,
    dateField: ppMode ? 'pp_start' : 'date_applied',
  });

  // EMPTY-COHORT GUARD: no comparable cases. Show a clear message, still update
  // similar cases, set state, emit, and return (no all-dash table, no spurious
  // 'premium filter dropped' note).
  if (!cohort || cohort.length === 0) {
    out.replaceChildren(el('p', 'muted',
      'No comparable cases in the data for these dates and type — try a different applied date, type, or toggle premium.'));
    paintStepper(ctx, journeyStepperModel(ctx, { applied, biometrics, stage, today, cardSt }));
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

    // Where they are on the clock + how the community's premium clocks resolved.
    const bdb = ctx.dates.businessDaysBetween;
    const dist = ctx.wave?.ppClockDist ? ctx.wave.ppClockDist(cases) : null;
    const bdElapsed = bdb ? bdb(ppStart, today) : null;
    if (bdElapsed != null) {
      const clockLine = el('p', 'muted');
      let msg = `You are on business day ${bdElapsed} of 30 (clock started ${ppStart}).`;
      if (dist) {
        msg += ` Across ${dist.n} premium cases, median resolution was BD ${fmt(dist.p50)} and ${dist.within30}% resolved by BD 30.`;
        if (bdElapsed > 30) {
          msg += ` Past BD 30 the premium fee is refunded but your case keeps priority — ${dist.over30} cases in the data ran over and still resolved.`;
        }
      }
      clockLine.textContent = msg;
      out.append(clockLine);
    }
  }

  // ---- Personal percentile ruler ----
  out.append(buildRuler(ctx, { start, elapsed, kmP10, kmP50, kmP90 }));

  // ---- Approval-chance curve (the centerpiece) + headline stat ----
  buildChanceChart(ctx, out, { curve, elapsed, kmP50, kmP90, obs });

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

  const kmP10Date = kmP10 == null ? null : addDays(start, kmP10);
  const kmP50Date = kmP50 == null ? null : addDays(start, kmP50);
  const kmP90Date = kmP90 == null ? null : addDays(start, kmP90);

  // ---- Then your card: chain the community card medians off the projected
  // approval, so the whole journey is visible from day one.
  if (cardSt && kmP50Date && ctx.cards?.cardProjection) {
    const chain = ctx.cards.cardProjection(cardSt, kmP50Date, 'approved');
    if (chain && (chain.producedP50 || chain.deliveredP50)) {
      out.append(el('h3', null, 'Then your card — chained off the typical approval date'));
      if (chain.producedP50) out.append(ctLine(ctx, 'Card produced', chain.producedP50));
      if (chain.deliveredP50) {
        const slow = (kmP90Date && cardSt.a2r) ? addDays(kmP90Date, cardSt.a2r.p90) : null;
        out.append(ctLine(ctx, 'In your mailbox', chain.deliveredP50, slow, 'slow lane: by'));
      }
      out.append(el('p', 'muted',
        `Chained medians (typical approval date + community card logistics · ${chain.basis.a2p || 0} produced / ` +
        `${chain.basis.a2r || 0} delivered reports). Rough by construction — enter your approval date once it lands and this sharpens.`));
    }
  }

  paintStepper(ctx, journeyStepperModel(ctx, {
    applied, biometrics, stage: 'pending', today, cardSt,
    projApprovedDate: kmP50Date,
  }));

  // ---- Commit shared state + emit ----
  const myCase = {
    ...myCaseBase,
    projection: {
      p10Date: kmP10Date,
      p50Date: kmP50Date,
      p90Date: kmP90Date,
      kmP50Date,
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
function commitCase(ctx, myCase, celebrate, fx, message) {
  ctx.state = ctx.state || {};
  ctx.state.myCase = myCase;
  // Refresh similar cases directly (also re-rendered by the bus listener in app.js).
  renderSimilar(ctx, myCase);
  if (ctx.bus && typeof ctx.bus.emit === 'function') {
    ctx.bus.emit('caseChange', myCase);
  }
  if (celebrate && fx && !fx.prefersReducedMotion()) {
    fx.toast(message ||
      'You\'re past the typical wait — approvals around your mark are landing now. Hang in there.', 'good');
    fx.confetti({ count: 90 });
  }
}

// ---------------------------------------------------------------------------
// Journey stepper + post-approval console
// ---------------------------------------------------------------------------

/** "Jul 8" this year, "Jul 8, 2025" otherwise. Falls back to the raw ISO. */
function fmtNice(iso) {
  if (!iso) return '—';
  const t = new Date(iso + 'T12:00:00'); // noon dodges timezone day-shift
  if (isNaN(t)) return iso;
  const opts = { month: 'short', day: 'numeric' };
  if (t.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
  return t.toLocaleDateString(undefined, opts);
}

/** One projection line: "Card produced ~Jul 7 · almost certainly by Jul 9". */
function ctLine(ctx, label, p50Iso, p90Iso, p90Label = 'almost certainly by') {
  const { el } = ctx;
  const p = el('p', 'ct-line');
  p.append(document.createTextNode(label + ' '));
  p.append(el('strong', 'ct-date', `~${fmtNice(p50Iso)}`));
  if (p90Iso) p.append(el('span', 'muted', ` · ${p90Label} ${fmtNice(p90Iso)}`));
  return p;
}

/**
 * journeyStepperModel — resolve the projected date for every stage the user
 * hasn't reached, chaining community medians off the latest known anchor
 * (pending → projected approval; approved → a2p/a2r; produced → p2r).
 */
function journeyStepperModel(ctx, m) {
  const { addDays } = ctx.dates;
  const cardSt = m.cardSt;
  let projBio = null, projApproved = null, projProduced = null, projReceived = null;

  if (m.stage === 'pending' || !m.stage) {
    projApproved = m.projApprovedDate || null;
    if (projApproved && cardSt) {
      if (cardSt.a2p) projProduced = addDays(projApproved, cardSt.a2p.p50);
      if (cardSt.a2r) projReceived = addDays(projApproved, cardSt.a2r.p50);
    }
    // Biometrics: only project while the typical date is still ahead.
    if (!m.biometrics && ctx.cards?.gapDist) {
      const bio = ctx.cards.gapDist(ctx.data?.cases || [], 'date_applied', 'biometrics_date');
      if (bio) {
        const d = addDays(m.applied, bio.p50);
        if (m.today && d >= m.today) projBio = d;
      }
    }
  } else if (m.stage === 'approved') {
    if (cardSt?.a2p) projProduced = addDays(m.approved, cardSt.a2p.p50);
    if (cardSt?.a2r) projReceived = addDays(m.approved, cardSt.a2r.p50);
  } else if (m.stage === 'produced') {
    if (cardSt?.p2r) projReceived = addDays(m.produced, cardSt.p2r.p50);
  }
  return { ...m, projBio, projApproved, projProduced, projReceived };
}

/** Paint the five-stage strip into #journey-strip. model=null → hint only. */
function paintStepper(ctx, model) {
  const { $, el } = ctx;
  const host = $('#journey-strip');
  if (!host) return;
  host.replaceChildren();

  if (!model) {
    host.append(el('p', 'muted jr-hint',
      'Your five milestones appear here — enter your dates below and the journey lights up as you go.'));
    return;
  }

  const { daysBetween } = ctx.dates;
  const steps = [
    { label: 'Applied', actual: model.applied },
    { label: 'Biometrics', actual: model.biometrics, proj: model.projBio, prev: model.applied, optional: true },
    { label: 'Approved', actual: model.approved, proj: model.projApproved, prev: model.applied, delta: 'from filing' },
    { label: 'Card produced', actual: model.produced, proj: model.projProduced, prev: model.approved, delta: 'after approval' },
    { label: 'Card in hand', actual: model.received, proj: model.projReceived,
      prev: model.produced || model.approved, delta: model.produced ? 'in the mail' : 'after approval' },
  ];

  let lastDone = 0;
  steps.forEach((s, i) => { if (s.actual) lastDone = i; });
  const nextIdx = steps.findIndex((s, i) => !s.actual && i > lastDone);

  const strip = el('div', 'jr-strip');
  steps.forEach((s, i) => {
    const state = s.actual ? 'done' : (i === nextIdx ? 'next' : 'todo');
    const node = el('div', `jr-step ${state}`);
    node.append(el('span', 'jr-label', s.label));
    if (s.actual) {
      node.append(el('span', 'jr-date', fmtNice(s.actual)));
      const d = s.prev ? daysBetween(s.prev, s.actual) : null;
      node.append(el('span', 'jr-sub',
        s.prev == null ? 'day 0' : (d != null && d >= 0 ? `+${d}d ${s.delta || ''}`.trim() : ' ')));
    } else if (s.proj) {
      node.append(el('span', 'jr-date jr-proj', `~${fmtNice(s.proj)}`));
      node.append(el('span', 'jr-sub', 'typical · projected'));
    } else {
      node.append(el('span', 'jr-date jr-proj', '—'));
      node.append(el('span', 'jr-sub', s.optional ? 'optional' : ' '));
    }
    strip.append(node);
  });
  host.append(strip);
}

/**
 * renderJourneyConsole — replaces the survival console once the approval
 * question is settled. Three faces: approved (card countdown), produced
 * (delivery countdown), complete (full-journey recap vs the community).
 */
function renderJourneyConsole(ctx, out, model, orderProblems) {
  const { el, fmt, wrapTable } = ctx;
  const { daysBetween } = ctx.dates;
  const cases = Array.isArray(ctx.data?.cases) ? ctx.data.cases : [];
  const cardSt = model.cardSt;

  out.replaceChildren();

  if (orderProblems.length) {
    const warn = el('p', null, `Check your dates — ${orderProblems.join('; ')}. Everything below uses them as entered.`);
    warn.style.color = 'var(--warn)';
    out.append(warn);
  }

  const wait = model.approved ? daysBetween(model.applied, model.approved) : null;
  const basisLine = (b) => el('p', 'muted',
    `based on ${b.a2p ?? b.p2r ?? 0}${b.a2p != null ? ` produced / ${b.a2r ?? 0} delivered` : ' delivered'} community reports` +
    ' · your dates stay in this browser only');

  // ---- APPROVED: countdown to card produced + delivered -------------------
  if (model.stage === 'approved') {
    const head = el('p');
    head.append(el('strong', null, `Approved on ${fmtNice(model.approved)}`));
    if (wait != null && wait >= 0) head.append(el('span', 'muted', ` · after a ${wait}-day wait`));
    out.append(head);

    const proj = (cardSt && ctx.cards?.cardProjection) ? ctx.cards.cardProjection(cardSt, model.approved, 'approved') : null;
    if (proj) {
      if (proj.producedP50) out.append(ctLine(ctx, 'Card produced', proj.producedP50, proj.producedP90));
      if (proj.deliveredP50) out.append(ctLine(ctx, 'In your mailbox', proj.deliveredP50, proj.deliveredP90));
      if (proj.deliveredP90 && model.today > proj.deliveredP90) {
        const late = el('p', null,
          `You're past the point where 9 in 10 cards have arrived (${fmtNice(proj.deliveredP90)}). ` +
          'Worth checking your address on USCIS and, if it still says nothing, filing an e-request for card delivery.');
        late.style.color = 'var(--warn)';
        out.append(late);
      }
      out.append(basisLine(proj.basis));
    } else {
      out.append(el('p', 'muted', 'No community card reports yet to project your card dates from.'));
    }
    return;
  }

  // ---- PRODUCED: countdown to delivery ------------------------------------
  if (model.stage === 'produced') {
    const recap = el('div', 'cards');
    const chip = (value, label) => {
      const c = el('div', 'card');
      c.append(el('div', 'value', value), el('div', 'label', label));
      recap.append(c);
    };
    if (wait != null && wait >= 0) chip(`${fmt(wait)} d`, 'applied → approved');
    if (model.approved) {
      const a2p = daysBetween(model.approved, model.produced);
      if (a2p != null && a2p >= 0) {
        chip(`${fmt(a2p)} d`, `approved → produced${cardSt?.a2p ? ` (community median ${cardSt.a2p.p50})` : ''}`);
      }
    }
    if (recap.childElementCount) out.append(recap);

    const head = el('p');
    head.append(el('strong', null, `Card produced ${fmtNice(model.produced)}`),
      el('span', 'muted', ' — it\'s at the printer or already with USPS.'));
    out.append(head);

    const proj = (cardSt && ctx.cards?.cardProjection) ? ctx.cards.cardProjection(cardSt, model.produced, 'produced') : null;
    if (proj && proj.deliveredP50) {
      out.append(ctLine(ctx, 'In your mailbox', proj.deliveredP50, proj.deliveredP90));
      if (proj.deliveredP90 && model.today > proj.deliveredP90) {
        const late = el('p', null,
          `Your card has been "produced" longer than 9 in 10 delivered cases took (${fmtNice(proj.deliveredP90)}). ` +
          'Check USPS Informed Delivery and your USCIS mailing address; an e-request is reasonable at this point.');
        late.style.color = 'var(--warn)';
        out.append(late);
      }
      out.append(basisLine(proj.basis));
    } else {
      out.append(el('p', 'muted', 'No produced→delivered reports in the data yet to project from.'));
    }
    return;
  }

  // ---- COMPLETE: full-journey recap vs the community -----------------------
  const total = daysBetween(model.applied, model.received);
  if (total == null || total < 0) {
    out.append(el('p', 'muted', 'Fix the dates above to see your full-journey recap.'));
    return;
  }

  const cmp = ctx.cards?.journeyCompare ? ctx.cards.journeyCompare(cases, total) : null;

  const cards = el('div', 'cards');
  const stat = (cls, value, label) => {
    const c = el('div', cls ? `card ${cls}` : 'card');
    c.append(el('div', 'value', value), el('div', 'label', label));
    cards.append(c);
    return c;
  };
  stat('good', `${fmt(total)} d`, 'applied → card in hand, end to end');
  if (cmp) {
    stat('', `${cmp.fasterThanPct}%`, `of ${cmp.n} completed journeys were slower than yours`);
    const simCard = stat('', String(cmp.similar), `journeys finished within ±${cmp.window} days of yours`);
    ctx.explain?.(simCard, () => ({
      title: 'Completed journeys like yours',
      lines: [
        ['completed journeys in the data', String(cmp.n)],
        [`within ±${cmp.window} days of your ${total}`, String(cmp.similar)],
        ['community median', `${cmp.p50} days`],
        ['community p90', `${cmp.p90} days`],
      ],
      note: 'Counts every clean case reporting both an applied date and a card-received date.',
    }));
  }
  out.append(cards);

  // Per-stage breakdown: you vs the community median, only for legs you reported.
  const legs = [];
  if (wait != null && wait >= 0) {
    const g = ctx.cards?.gapDist ? ctx.cards.gapDist(cases, 'date_applied', 'date_approved', 500) : null;
    legs.push(['Applied → approved', wait, g?.p50]);
  }
  if (model.approved && model.produced) {
    const d = daysBetween(model.approved, model.produced);
    if (d != null && d >= 0) legs.push(['Approved → card produced', d, cardSt?.a2p?.p50]);
  }
  if (model.produced) {
    const d = daysBetween(model.produced, model.received);
    if (d != null && d >= 0) legs.push(['Produced → in your mailbox', d, cardSt?.p2r?.p50]);
  }
  legs.push(['End to end', total, cmp?.p50]);

  if (legs.length) {
    const tbl = el('table');
    tbl.innerHTML = '<tr><th>Stage</th><th>You</th><th>Community median</th></tr>';
    for (const [label, you, med] of legs) {
      const tr = el('tr');
      tr.append(
        el('td', null, label),
        el('td', null, `${you} d`),
        el('td', null, med != null ? `${med} d` : '—'),
      );
      tbl.append(tr);
    }
    out.append(wrapTable(tbl));
  }

  out.append(el('p', 'muted',
    'Journey complete — congratulations! 🎉 Your data points would help the next person: consider reporting your timeline on the r/f1visa megathread.'));
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
  const posPctNum = (t) => Math.max(0, Math.min(100, (t / maxT) * 100));
  const posPct = (t) => `${posPctNum(t)}%`;

  const track = el('div', 'ruler-track');

  // Fill up to the user's elapsed position.
  const fill = el('div', 'ruler-fill');
  fill.style.width = posPct(Math.min(elapsed, maxT));
  track.append(fill);

  // On narrow viewports, drop the projected date (keeps just "Best · p10")
  // and stagger ticks into two rows — three full labels ("Best ·
  // 2026-06-25") each near half the track width would otherwise pile up
  // unreadably on a ~320px screen. See util.mjs edgeAnchor/isCompactViewport.
  const compact = ctx.isCompactViewport ? ctx.isCompactViewport() : false;
  const anchor = ctx.edgeAnchor || (() => 'translateX(-50%)');

  // Percentile ticks (best/typical/worst), only when defined.
  const ticks = [
    [kmP10, 'Best', 'p10'],
    [kmP50, 'Typical', 'p50'],
    [kmP90, 'Worst', 'p90'],
  ];
  let tickIdx = 0;
  for (const [t, name, tag] of ticks) {
    if (t == null || !isFinite(t)) continue;
    const p = posPctNum(t);
    const tick = el('div', 'ruler-tick');
    tick.style.left = `${p}%`;
    track.append(tick);
    const lab = el('div', 'ruler-tick-label' + (compact && tickIdx % 2 ? ' row-b' : ''),
      compact ? `${name} · ${tag}` : `${name} · ${addDays(start, t)}`);
    lab.style.left = `${p}%`;
    lab.style.transform = anchor(p);
    track.append(lab);
    tickIdx++;
  }

  // "You are here" glowing marker at elapsed.
  const youPct = posPctNum(Math.min(elapsed, maxT));
  const marker = el('div', 'ruler-marker');
  marker.style.left = `${youPct}%`;
  track.append(marker);
  const markerLabel = el('div', 'ruler-marker-label', `You · day ${elapsed}`);
  markerLabel.style.left = `${youPct}%`;
  markerLabel.style.transform = anchor(youPct);
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
// Approval-chance curve ("what are my approval chances")
// ---------------------------------------------------------------------------

/**
 * buildChanceChart — append the cumulative approval-probability chart and its
 * headline stat into `out`.
 *
 * y(t) = (1 - KM survival at t) * 100 = share of comparable cases approved by
 * day t, with silent drop-offs treated as censored (not as denials). Rendered
 * as a stepped line (the KM estimator IS a step function) with a dashed
 * vertical "you are here" marker at the user's elapsed days.
 *
 * Defensive: empty/null curve → muted note, no chart. Chart.js missing →
 * headline stat still renders. Reduced motion → animation disabled.
 */
function buildChanceChart(ctx, out, { curve, elapsed, kmP50, kmP90, obs }) {
  const { el, prefersReducedMotion } = ctx;
  const { kmSurvivalAt, kmQuantile } = ctx.stats;

  out.append(el('h3', null, 'Chance of approval by day N (survival-adjusted)'));

  if (!Array.isArray(curve) || curve.length === 0) {
    out.append(el('p', 'muted',
      'Not enough approvals in this cohort yet to chart your approval chances.'));
    return;
  }

  // ---- Headline stat (rendered under the chart; kept even if Chart.js is out) ----
  const chanceNow = Math.round(Math.max(0, Math.min(100, (1 - kmSurvivalAt(curve, elapsed)) * 100)));
  const headline = el('p');
  const headStrong = el('strong', null,
    `By today (day ${elapsed}): ${chanceNow}% of similar cases were already approved`);
  headline.append(headStrong);
  const tail = [];
  if (kmP50 != null && isFinite(kmP50)) tail.push(`by day ${kmP50}: 50%`);
  if (kmP90 != null && isFinite(kmP90)) tail.push(`by day ${kmP90}: 90%`);
  if (tail.length) headline.append(el('span', 'muted', ' · ' + tail.join(' · ')));

  // Click the percentage → the Kaplan-Meier math behind it, with real counts.
  if (ctx.explain && Array.isArray(obs)) {
    const events = obs.filter(x => x.event).length;
    ctx.explain(headStrong, () => ({
      title: `How ${chanceNow}% was computed`,
      lines: [
        ['cohort observations', String(obs.length)],
        ['approved (events)', String(events)],
        ['still pending (censored)', String(obs.length - events)],
        ['estimator', 'Kaplan-Meier survival S(t)'],
        [`chance by day ${elapsed}`, `1 − S(${elapsed}) = ${chanceNow}%`],
      ],
      note: 'Censored cases count as "waited at least N days" instead of being ignored — that is what keeps this honest about people who never report their approval.',
    }));
  }

  if (!window.Chart) {
    out.append(el('p', 'muted', 'Chart unavailable (Chart.js did not load) — the numbers below still stand.'));
    out.append(headline);
    return;
  }

  // ---- Chart data: KM step points 0..xMax ----
  const maxCurveT = curve[curve.length - 1].t;
  const p95 = kmQuantile(curve, 0.95);
  const horizon = Math.min(maxCurveT, p95 == null ? maxCurveT : p95); // p95ish horizon
  // Extend the axis to the user's position when they've waited past the horizon
  // (capped at the last observed event so we never draw past the data).
  const xMax = Math.max(1, horizon, Math.min(Math.max(0, elapsed), maxCurveT));

  const points = [{ x: 0, y: 0 }];
  for (const pt of curve) {
    if (pt.t > xMax) break;
    points.push({ x: pt.t, y: Math.max(0, Math.min(100, (1 - pt.S) * 100)) });
  }
  const last = points[points.length - 1];
  if (last.x < xMax) points.push({ x: xMax, y: last.y }); // flat-extend to the axis edge

  // "You are here" marker (clamped into view; the label keeps the true day count).
  const markerX = Math.max(0, Math.min(elapsed, xMax));

  const box = el('div', 'chart-box');
  const canvas = document.createElement('canvas');
  canvas.id = 'chance-curve';
  box.append(canvas);
  out.append(box);
  out.append(headline);

  const C = chanceColors();
  try {
    _chanceChart = new window.Chart(canvas, {
      type: 'line',
      data: {
        datasets: [
          {
            label: 'share of similar cases approved by day N',
            data: points,
            stepped: true,          // KM is a step function — draw it as one
            borderColor: C.accent,
            backgroundColor: C.accentFill,
            borderWidth: 2.5,
            pointRadius: 0,
            pointHitRadius: 8,
            fill: 'origin',
            order: 1,
          },
          {
            label: `you · day ${elapsed}`,
            data: [{ x: markerX, y: 0 }, { x: markerX, y: 100 }],
            borderColor: C.marker,
            backgroundColor: C.marker,
            borderDash: [6, 4],
            borderWidth: 2,
            pointRadius: 0,
            fill: false,
            order: 2,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: prefersReducedMotion() ? false : { duration: 700 },
        interaction: { mode: 'nearest', axis: 'x', intersect: false },
        plugins: {
          legend: { labels: { color: C.legend, boxWidth: 12, usePointStyle: true } },
          tooltip: {
            backgroundColor: C.tooltipBg,
            borderColor: C.grid,
            borderWidth: 1,
            titleColor: C.tooltipTitle,
            bodyColor: C.tooltipBody,
            padding: 10,
            callbacks: {
              title: () => '',
              label: (item) => item.datasetIndex === 1
                ? `you are here — day ${elapsed}`
                : `day ${Math.round(item.parsed.x)}: ${Math.round(item.parsed.y)}% of similar cases approved by now`,
            },
          },
        },
        scales: {
          x: {
            type: 'linear',
            min: 0,
            max: xMax,
            title: { display: true, text: 'days since clock start', color: C.axis },
            ticks: { color: C.axis, maxTicksLimit: 9, precision: 0 },
            grid: { color: C.grid },
          },
          y: {
            min: 0,
            max: 100,
            title: { display: true, text: 'approved by day N (%)', color: C.axis },
            ticks: { color: C.axis, callback: (v) => v + '%' },
            grid: { color: C.grid },
          },
        },
      },
    });
  } catch (err) {
    // A Chart.js hiccup must never take down the projection panel.
    _chanceChart = null;
    box.replaceChildren(el('p', 'muted', 'Chart could not be rendered — the numbers below still stand.'));
    // eslint-disable-next-line no-console
    console.error('[timeline] chance chart error:', err);
  }
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
  const ratePct = sims.length ? (approved.length / sims.length) * 100 : 0; // reported (raw)

  // Adjusted rate: stale_pending cases are mostly silent approvals/abandonment
  // (people stop updating once approved — true denials are low single digits),
  // so they're removed from the denominator instead of counted as "not approved".
  const stalePending = sims.filter(c => (c.flags || []).includes('stale_pending')).length;
  const adjDenom = sims.length - stalePending;
  const adjPct = adjDenom > 0
    ? Math.max(0, Math.min(100, (approved.length / adjDenom) * 100))
    : ratePct; // degenerate cohort (all stale) — fall back to the reported rate

  const apprDurs = approved
    .map(c => daysBetween(c.date_applied, c.date_approved))
    .filter(d => d >= 0)
    .sort((a, b) => a - b);
  const medianApproved = apprDurs.length ? quantileSorted(apprDurs, 0.5) : null;

  out.replaceChildren();

  // ---- Ring (adjusted rate) + summary strip ----
  const head = el('div', 'cards');

  const ringWrap = el('div', 'ring-wrap');
  ringWrap.append(ring({
    percent: adjPct,
    size: 132,
    label: `${Math.round(adjPct)}%`,
    sublabel: 'likely approved',
  }));
  head.append(ringWrap);

  // Click the ring → exactly how the adjusted percentage was computed.
  if (ctx.explain) {
    ctx.explain(ringWrap, () => ({
      title: `How ${Math.round(adjPct)}% was computed`,
      lines: [
        [`similar cases (±${SIM_WINDOW}d, same type & processing)`, String(sims.length)],
        ['approved', String(approved.length)],
        ['reported rate', `${approved.length} ÷ ${sims.length} = ${Math.round(ratePct)}%`],
        ['stale silent drop-offs excluded', String(stalePending)],
        ['adjusted rate', `${approved.length} ÷ ${adjDenom} = ${Math.round(adjPct)}%`],
      ],
      note: 'Stale = pending longer than the 99th percentile of all approved waits — statistically those are almost always approvals that were never reported. True denials are rare (low single digits).',
    }));
  }

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

  // Honest dual-rate note: show BOTH figures and why they differ.
  out.append(el('p', 'muted',
    `Reported: ${Math.round(ratePct)}% · Adjusted for silent drop-offs (${stalePending} stale case${stalePending === 1 ? '' : 's'} excluded): ${Math.round(adjPct)}%. ` +
    'Most people stop updating once approved — the adjusted figure is the better estimate; true denials are rare.'));

  // Personal benchmark once the user is approved: where their wait landed.
  const myWait = myCase.approved ? daysBetween(myCase.applied, myCase.approved) : null;
  if (myWait != null && myWait >= 0 && apprDurs.length) {
    const slower = apprDurs.filter(d => d > myWait).length;
    const bench = el('p', null,
      `You: approved in ${myWait} days — faster than ${slower} of the ${apprDurs.length} approved peers in this window.`);
    bench.style.color = 'var(--good)';
    out.append(bench);
  }

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
      // link_partial: the linked comment doesn't assert every field shown here
      // (some fills came from opt-tracker submissions) — mark it 'reddit*'.
      const a = el('a', null, c.link_partial ? 'reddit*' : 'reddit');
      a.href = c.reddit_url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      if (c.link_partial) {
        a.title = 'The linked comment may show an earlier update — some fields were merged from opt-tracker submissions.';
      }
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
