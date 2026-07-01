/**
 * dashboard/modules/cheer.mjs
 * The LIVE + encouragement layer. Renders into section #live and reacts to
 * the user's entered case via the 'caseChange' bus event.
 *
 * HONESTY GUARDRAIL (from the data story): waits are currently lengthening.
 * This module celebrates ONLY true positives — fresh approvals, rising
 * throughput, personal milestones, real progress toward the user's date — and
 * is gentle + honest when a projection extends. It never fabricates good news.
 *
 * MODULE CONTRACT:
 *   export function render(ctx)              — builds/updates the #live section
 *   export function onCaseChange(ctx, myCase) — personal hope panel + toasts
 *
 * Every DOM op is defensive: tolerate a missing #live, null/missing fields, and
 * empty result sets. Never throw.
 */

// ---------------------------------------------------------------------------
// Module-level session state (resets on full page reload, which is intended).
// ---------------------------------------------------------------------------
let confettiFiredThisSession = false;

const LS_LAST_P50 = 'opt-radar-lastp50';

// ---------------------------------------------------------------------------
// Small local helpers (pure — no external deps)
// ---------------------------------------------------------------------------

/** Defensive flag check. */
function hasFlag(c, f) {
  return Array.isArray(c?.flags) && c.flags.includes(f);
}

/** A "good" case is one without impossible dates. */
function isGood(c) {
  return c && !hasFlag(c, 'impossible_dates');
}

/** Clamp n into [lo, hi]. */
function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

/** ISO week key (YYYY-Www) for a 'YYYY-MM-DD' string. Null on bad input. */
function isoWeek(dateStr) {
  if (typeof dateStr !== 'string' || dateStr.length < 10) return null;
  const d = new Date(dateStr + 'T00:00:00Z');
  if (isNaN(d)) return null;
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day + 3);
  const firstThu = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const fday = (firstThu.getUTCDay() + 6) % 7;
  firstThu.setUTCDate(firstThu.getUTCDate() - fday + 3);
  const week = 1 + Math.round((d - firstThu) / (7 * 86400000));
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/**
 * Normalize whatever case shape arrives (calculator state OR a data case) into
 * the fields this module needs. Tolerates both naming styles.
 */
function normalizeCase(myCase) {
  if (!myCase || typeof myCase !== 'object') return null;
  const applied     = myCase.applied      ?? myCase.date_applied      ?? null;
  const biometrics  = myCase.biometrics   ?? myCase.biometrics_date   ?? null;
  const pp          = myCase.pp           ?? myCase.pp_upgrade_date    ?? myCase.pp_start ?? null;
  const ppStartFlag = myCase.ppstart      ?? myCase.pp_from_start      ?? false;
  const type        = myCase.type         ?? myCase.opt_type           ?? 'initial';
  if (!applied) return null;
  const premium = !!ppStartFlag || !!pp;
  return { applied, biometrics, pp, type, premium, ppStartFlag: !!ppStartFlag };
}

// ---------------------------------------------------------------------------
// Fresh-approvals source resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the list of "fresh" approvals to celebrate.
 * Prefer diff.newly_approved (real deltas since last fetch). If that isn't
 * usable (first snapshot / missing / empty), fall back to good cases whose
 * date_approved equals the latest approval date present in the data.
 *
 * @returns {{ list: Array, sinceLastUpdate: boolean, latestDate: string|null }}
 *   list items are normalized {date_applied, date_approved, days, reddit_url}
 */
function resolveFreshApprovals(ctx) {
  const diff = ctx?.diff;
  const cases = Array.isArray(ctx?.data?.cases) ? ctx.data.cases : [];

  const fromDiff =
    diff && !diff.first_snapshot && Array.isArray(diff.newly_approved)
      ? diff.newly_approved
      : null;

  if (fromDiff && fromDiff.length) {
    const list = fromDiff.map((a) => ({
      date_applied: a.date_applied ?? null,
      date_approved: a.date_approved ?? null,
      days: a.days ?? null,
      reddit_url: a.reddit_url ?? null,
      // diff.newly_approved entries don't carry link_partial — only mark when present and true.
      link_partial: a.link_partial === true,
    }));
    return { list, sinceLastUpdate: true, latestDate: null };
  }

  // Fallback: good cases approved on the latest approval date in the data.
  const good = cases.filter((c) => isGood(c) && c.date_approved);
  if (!good.length) return { list: [], sinceLastUpdate: false, latestDate: null };

  let latestDate = null;
  for (const c of good) if (latestDate == null || c.date_approved > latestDate) latestDate = c.date_approved;

  const daysBetween = ctx?.dates?.daysBetween;
  const list = good
    .filter((c) => c.date_approved === latestDate)
    .map((c) => ({
      date_applied: c.date_applied ?? null,
      date_approved: c.date_approved ?? null,
      days:
        c.date_applied && typeof daysBetween === 'function'
          ? daysBetween(c.date_applied, c.date_approved)
          : null,
      reddit_url: c.reddit_url ?? null,
      link_partial: c.link_partial === true,
    }));

  return { list, sinceLastUpdate: false, latestDate };
}

// ---------------------------------------------------------------------------
// Throughput (true-positive) computation
// ---------------------------------------------------------------------------

/**
 * Compute a TRUE-positive throughput line, or null if recent throughput does
 * NOT exceed a month ago (never fabricate good news).
 *
 * Approach: approvals per ISO week (good cases). Compare the most recent week
 * that has data against the week ~4 weeks earlier. Because the latest week may
 * be partial (today is mid-week), we take the MAX of the last two complete-ish
 * recent weeks vs the comparison window a month back.
 *
 * @returns {{ recentWeek: string, recentRate: number, pastRate: number }|null}
 */
function computeThroughput(ctx) {
  const cases = Array.isArray(ctx?.data?.cases) ? ctx.data.cases : [];
  const byWeek = new Map();
  for (const c of cases) {
    if (!isGood(c) || !c.date_approved) continue;
    const w = isoWeek(c.date_approved);
    if (!w) continue;
    byWeek.set(w, (byWeek.get(w) || 0) + 1);
  }
  const weeks = [...byWeek.keys()].sort();
  if (weeks.length < 6) return null; // not enough history to claim a trend

  // Recent: best of the last two weeks (guards against a partial newest week).
  const recentWeeks = weeks.slice(-2);
  let recentWeek = recentWeeks[recentWeeks.length - 1];
  let recentRate = -Infinity;
  for (const w of recentWeeks) {
    const r = byWeek.get(w);
    if (r > recentRate) { recentRate = r; recentWeek = w; }
  }

  // "A month ago": the window 4–5 weeks back from the latest week.
  const pastWindow = weeks.slice(-6, -4); // two weeks, ~a month prior
  if (!pastWindow.length) return null;
  const pastRate = Math.round(
    pastWindow.reduce((s, w) => s + (byWeek.get(w) || 0), 0) / pastWindow.length
  );

  // Only return when recent GENUINELY exceeds a month ago.
  if (!(recentRate > pastRate)) return null;
  return { recentWeek, recentRate, pastRate };
}

// ---------------------------------------------------------------------------
// Personal projection (p50) for the user's case
// ---------------------------------------------------------------------------

/**
 * Build the KM curve + key quantiles for the user's normalized case.
 * Returns null when there's no usable cohort.
 *
 * @returns {{ curve:Array, p25:number|null, p50:number|null, elapsed:number,
 *             start:string, premium:boolean, p50Date:string|null,
 *             cohortN:number }|null}
 */
function projectCase(ctx, nc) {
  const data = ctx?.data;
  if (!nc || !data || !Array.isArray(data.cases)) return null;
  const { matchCohort, buildObservations } = ctx.cohort || {};
  const { kmCurve, kmQuantile } = ctx.stats || {};
  const { addDays, daysBetween } = ctx.dates || {};
  if (!matchCohort || !buildObservations || !kmCurve || !kmQuantile || !addDays || !daysBetween) {
    return null;
  }

  const today = ctx.today || data.today;
  const ppMode = nc.premium;
  // Premium clock start = max(upgrade, biometrics), applied as last resort —
  // same rule as lib/merge.mjs ppStart and the calculator.
  const clockCands = [nc.pp, nc.biometrics].filter(Boolean);
  const ppStart = clockCands.length ? clockCands.sort().at(-1) : nc.applied;
  const start = ppMode ? ppStart : nc.applied;

  let cohort;
  try {
    ({ cohort } = matchCohort(data.cases, {
      refDate: start,
      optType: nc.type,
      premium: nc.premium,
      dateField: ppMode ? 'pp_start' : 'date_applied',
    }));
  } catch {
    return null;
  }
  if (!Array.isArray(cohort) || cohort.length === 0) return null;

  let obs;
  try {
    obs = buildObservations(cohort, {
      today,
      staleCap: data.stale_cutoff_days,
      mode: ppMode ? 'pp' : 'applied',
    });
  } catch {
    return null;
  }

  const curve = kmCurve(obs);
  const p25 = kmQuantile(curve, 0.25);
  const p50 = kmQuantile(curve, 0.5);
  const elapsed = daysBetween(start, today);
  const p50Date = p50 == null ? null : addDays(start, p50);

  return { curve, p25, p50, elapsed, start, premium: ppMode, p50Date, cohortN: cohort.length };
}

// ---------------------------------------------------------------------------
// render(ctx) — live banner + throughput note
// ---------------------------------------------------------------------------

/**
 * @param {object} ctx
 */
export function render(ctx) {
  if (!ctx) return;
  const root = ctx.$ ? ctx.$('#live') : document.getElementById('live');
  if (!root) return; // section not present — nothing to do, never throw

  const el = ctx.el;
  if (typeof el !== 'function') return;

  // Fresh, idempotent render: clear everything we own.
  root.replaceChildren();

  // ---- LIVE BANNER -------------------------------------------------------
  let fresh;
  try {
    fresh = resolveFreshApprovals(ctx);
  } catch {
    fresh = { list: [], sinceLastUpdate: false, latestDate: null };
  }
  const list = fresh.list || [];
  const n = list.length;

  const banner = el('div', 'glass');
  banner.style.padding = '14px 18px';
  banner.style.display = 'flex';
  banner.style.flexDirection = 'column';
  banner.style.gap = '8px';

  const headRow = el('div');
  headRow.style.display = 'flex';
  headRow.style.alignItems = 'center';
  headRow.style.gap = '10px';
  headRow.style.flexWrap = 'wrap';

  if (n > 0) {
    headRow.append(el('span', 'pulse-dot'));
    const since = fresh.sinceLastUpdate ? 'since the last update' : 'today';
    const verb = n === 1 ? 'person reported an' : 'people reported an';
    const headline = el(
      'strong',
      null,
      `🎉 ${n} ${verb} approval ${since}`
    );
    headline.style.fontSize = '15px';
    headRow.append(headline);
    banner.append(headRow);

    // Expandable list (collapsed by default).
    const toggle = el('button', null, `Show the ${n === 1 ? 'approval' : `${n} approvals`}`);
    toggle.type = 'button';
    toggle.style.alignSelf = 'flex-start';
    toggle.setAttribute('aria-expanded', 'false');

    const details = el('div');
    details.classList.add('hidden');
    details.style.width = '100%';

    const tbl = el('table');
    const head = el('tr');
    head.innerHTML = '<th>Applied</th><th>Approved</th><th>Days</th><th>Link</th>';
    tbl.append(head);
    // Cap the rendered rows defensively.
    for (const a of list.slice(0, 60)) {
      const tr = el('tr');
      tr.classList.add('ok');
      const applied = a.date_applied ?? '—';
      const approved = a.date_approved ?? '—';
      const days = a.days == null ? '—' : `${a.days}d`;
      const tdApplied = el('td', null, applied);
      const tdApproved = el('td', null, approved);
      const tdDays = el('td', null, days);
      const tdLink = el('td');
      if (a.reddit_url) {
        const link = el('a', null, a.link_partial === true ? 'reddit*' : 'reddit');
        link.href = a.reddit_url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        if (a.link_partial === true) {
          link.title = 'The linked comment may show an earlier update — some fields were merged from opt-tracker submissions.';
        }
        tdLink.append(link);
      } else {
        tdLink.textContent = '—';
      }
      tr.append(tdApplied, tdApproved, tdDays, tdLink);
      tbl.append(tr);
    }
    const wrapped = ctx.wrapTable ? ctx.wrapTable(tbl) : tbl;
    details.append(wrapped);

    toggle.addEventListener('click', () => {
      const open = details.classList.toggle('hidden') === false;
      toggle.setAttribute('aria-expanded', String(open));
      toggle.textContent = open
        ? 'Hide approvals'
        : `Show the ${n === 1 ? 'approval' : `${n} approvals`}`;
    });

    banner.append(toggle, details);
  } else {
    // Calm, honest empty state — still alive (pulse dot).
    headRow.append(el('span', 'pulse-dot'));
    const calm = el(
      'span',
      null,
      'No new approvals since the last update — checking continuously.'
    );
    calm.style.fontSize = '14px';
    headRow.append(calm);
    banner.append(headRow);
  }

  root.append(banner);

  // ---- THROUGHPUT NOTE (true-positive only) ------------------------------
  let tp = null;
  try {
    tp = computeThroughput(ctx);
  } catch {
    tp = null;
  }
  if (tp) {
    const note = el(
      'p',
      'muted',
      `Approvals are speeding up — ${tp.recentWeek} saw ${tp.recentRate}/wk vs ${tp.pastRate}/wk a month ago.`
    );
    note.style.color = 'var(--good)';
    root.append(note);
  }
  // If throughput is NOT rising, we deliberately show nothing here (honesty).

  // ---- Personal hope panel mount point -----------------------------------
  // Re-render the hope panel if the user already has a case in shared state.
  const existing = ctx.state && ctx.state.myCase ? ctx.state.myCase : null;
  if (existing) {
    try {
      onCaseChange(ctx, existing);
    } catch {
      /* defensive — never let a stale case break the live render */
    }
  }
}

// ---------------------------------------------------------------------------
// onCaseChange(ctx, myCase) — personal hope panel + projection-shift toasts
// ---------------------------------------------------------------------------

/**
 * @param {object} ctx
 * @param {object|null} myCase
 */
export function onCaseChange(ctx, myCase) {
  if (!ctx) return;
  const root = ctx.$ ? ctx.$('#live') : document.getElementById('live');
  if (!root) return;
  const el = ctx.el;
  if (typeof el !== 'function') return;

  // Remove any prior hope panel (idempotent).
  const prior = root.querySelector('[data-cheer-hope]');
  if (prior) prior.remove();

  const nc = normalizeCase(myCase);
  if (!nc) return; // user cleared their case — leave the live banner alone

  let proj = null;
  try {
    proj = projectCase(ctx, nc);
  } catch {
    proj = null;
  }

  // ---- Projection-shift toasts (compare against stored p50 DATE) ----------
  // Done regardless of whether we can render a full ring, as long as we have a
  // projected p50 date.
  if (proj && proj.p50Date) {
    try {
      const stored = localStorage.getItem(LS_LAST_P50);
      if (stored) {
        // Earlier date == good news; later == gentle honest warning.
        if (proj.p50Date < stored) {
          ctx.toast?.(
            'Good news — approvals near your cohort are moving faster; your typical date moved earlier',
            'good'
          );
        } else if (proj.p50Date > stored) {
          ctx.toast?.(
            'Heads up: recent reports show waits lengthening; your typical date moved a bit later',
            'warn'
          );
        }
      }
      localStorage.setItem(LS_LAST_P50, proj.p50Date);
    } catch {
      /* localStorage unavailable (private mode) — skip silently */
    }
  }

  // ---- Hope panel ---------------------------------------------------------
  const panel = el('div', 'glass');
  panel.dataset.cheerHope = '1';
  panel.style.marginTop = '14px';
  panel.style.padding = '18px';
  panel.style.display = 'flex';
  panel.style.gap = '18px';
  panel.style.alignItems = 'center';
  panel.style.flexWrap = 'wrap';

  if (!proj || proj.p50 == null) {
    panel.append(
      el(
        'p',
        'muted',
        "We don't have enough similar cases yet to project your typical date — your numbers update as more approvals come in."
      )
    );
    root.append(panel);
    return;
  }

  const { p50, p25, elapsed } = proj;
  const total = p50 > 0 ? p50 : 1;
  const percent = clamp((elapsed / total) * 100, 0, 100);
  const frac = elapsed / total;

  // Progress ring toward the projected typical (p50) date.
  if (typeof ctx.ring === 'function') {
    const ringWrap = el('div', 'ring-wrap');
    let svg;
    try {
      svg = ctx.ring({
        percent,
        size: 132,
        label: `${Math.round(percent)}%`,
        sublabel: 'to typical',
      });
    } catch {
      svg = null;
    }
    if (svg) {
      ringWrap.append(svg);
      panel.append(ringWrap);
    }
  }

  // Encouraging, honest copy that warms as the date nears.
  const copyWrap = el('div');
  copyWrap.style.flex = '1 1 240px';
  copyWrap.style.minWidth = '0';

  const elapsedDays = Math.max(0, Math.round(elapsed));
  const remaining = Math.max(0, Math.round(p50 - elapsed));

  let headline;
  let body;
  const enteredWindow = (p25 != null && elapsed >= p25) || !!nc.biometrics;

  if (frac >= 1) {
    headline = "You're past the typical mark";
    body =
      `Most similar cases are approved by around day ${Math.round(p50)}, and you're at day ${elapsedDays}. ` +
      `Waits have been running long lately, so a little extra time here is normal — hang in there.`;
  } else if (frac > 0.8) {
    headline = "You're in the home stretch";
    body =
      `Most similar cases are approved right around now (typical is ~day ${Math.round(p50)}; you're at day ${elapsedDays}). ` +
      `About ${remaining} day${remaining === 1 ? '' : 's'} to the typical mark.`;
  } else if (enteredWindow) {
    headline = "You've entered the approval window 🎉";
    body =
      `Cases like yours start getting approved around now. Typical is ~day ${Math.round(p50)} — ` +
      `you're at day ${elapsedDays}, about ${remaining} to go.`;
  } else if (frac > 0.5) {
    headline = 'Past the halfway point';
    body =
      `You're at day ${elapsedDays} of a ~${Math.round(p50)}-day typical wait — about ${remaining} more to the typical mark. ` +
      `Steady progress.`;
  } else {
    headline = 'Your clock is running';
    body =
      `Typical for cases like yours is ~day ${Math.round(p50)}. You're at day ${elapsedDays} — ` +
      `roughly ${remaining} to the typical mark. Early days yet.`;
  }

  const h = el('strong', null, headline);
  h.style.fontSize = '15px';
  h.style.display = 'block';
  h.style.marginBottom = '6px';
  copyWrap.append(h, el('p', 'muted', body));
  panel.append(copyWrap);
  root.append(panel);

  // ---- Confetti: fire ONCE per session when crossing into the window ------
  // Window entry = elapsed past the ~p25 mark OR biometrics already done.
  if (enteredWindow && !confettiFiredThisSession) {
    confettiFiredThisSession = true;
    // confetti util already no-ops under reduced motion; double-guard anyway.
    const reduced =
      typeof ctx.prefersReducedMotion === 'function' ? ctx.prefersReducedMotion() : false;
    if (!reduced && typeof ctx.confetti === 'function') {
      try {
        ctx.confetti();
      } catch {
        /* never let a celebration throw */
      }
    }
  }
}
