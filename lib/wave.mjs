// Approval-wave analytics. Pure, browser-safe (no node: imports).
//
// Two questions this answers, both validated against live data (2026-07-01):
//
// 1. REGULAR wave front — "filers who applied around {date} are getting
//    approved NOW". Approvals are roughly FIFO by applied date, so the applied
//    dates behind the last ~14 days of approvals locate the front of the queue.
//    (Observed: last-14-day approvals went to Mar 17–21 filers.)
//
// 2. PREMIUM clock distribution — premium is a 30-BUSINESS-DAY promise from
//    the clock start (biometrics for premium-from-start, upgrade date for
//    upgrades — see ppStart in lib/merge.mjs), NOT from the applied date.
//    Measured on the right clock: p50 = 26 BD, p90 = 30 BD, 94% within 30 BD.
//    The few cases that blow past 30 BD get the premium fee refunded but stay
//    prioritized — they show up here as the small tail beyond 30.

import { daysBetween, parseDate, DAY } from './dates.mjs';
import { businessDaysBetween } from './holidays.mjs';
import { quantileSorted } from './stats.mjs';

function good(c) {
  return c && !((c.flags || []).includes('impossible_dates'));
}

/** ISO Monday of the week containing dateStr. */
export function weekOf(dateStr) {
  const t = parseDate(dateStr);
  if (!isFinite(t)) return null;
  return new Date(t - ((new Date(t).getUTCDay() + 6) % 7) * DAY).toISOString().slice(0, 10);
}

/**
 * Regular-processing wave front: applied-date stats of approvals granted in
 * the trailing `windowDays`. Returns null when there are none.
 */
export function waveFront(cases, { today, windowDays = 14, optType = null } = {}) {
  if (!today) return null;
  const cutoff = new Date(parseDate(today) - windowDays * DAY).toISOString().slice(0, 10);
  const recent = (cases || []).filter(c =>
    good(c) && !c.premium && c.date_applied && c.date_approved
    && c.date_approved >= cutoff && c.date_approved <= today
    && (!optType || c.opt_type === optType));
  if (!recent.length) return null;
  const applied = recent.map(c => c.date_applied).sort();
  const q = (p) => applied[Math.min(applied.length - 1, Math.floor(applied.length * p))];
  return {
    n: recent.length,
    windowDays,
    appliedMin: applied[0],
    appliedP25: q(0.25),
    appliedP50: q(0.5),
    appliedP75: q(0.75),
    appliedMax: applied[applied.length - 1],
  };
}

/**
 * Weekly applied-date cohorts for regular cases: size, approvals so far,
 * first/latest approval dates. Rows sorted by week ascending; weeks with
 * fewer than `minN` cases are dropped (too noisy to display).
 */
export function weeklyCohorts(cases, { optType = null, minN = 5, maxWeeks = 16 } = {}) {
  const byWeek = new Map();
  for (const c of cases || []) {
    if (!good(c) || c.premium || !c.date_applied) continue;
    if (optType && c.opt_type !== optType) continue;
    const w = weekOf(c.date_applied);
    if (!w) continue;
    if (!byWeek.has(w)) byWeek.set(w, []);
    byWeek.get(w).push(c);
  }
  const rows = [];
  for (const w of [...byWeek.keys()].sort()) {
    const cs = byWeek.get(w);
    if (cs.length < minN) continue;
    const appr = cs.filter(c => c.date_approved).map(c => c.date_approved).sort();
    rows.push({
      week: w,
      n: cs.length,
      approved: appr.length,
      pct: Math.round((100 * appr.length) / cs.length),
      firstApproval: appr[0] || null,
      lastApproval: appr[appr.length - 1] || null,
    });
  }
  return rows.slice(-maxWeeks);
}

/**
 * Premium clock → approval distribution in BUSINESS days (weekends + US
 * federal holidays skipped). Uses pp_start (already the correct clock start —
 * lib/merge.mjs). Splits initial-premium vs upgraded for the histogram.
 */
export function ppClockDist(cases) {
  const all = [];
  const initial = [];
  const upgraded = [];
  for (const c of cases || []) {
    if (!good(c) || !c.premium || !c.pp_start || !c.date_approved) continue;
    const bd = businessDaysBetween(c.pp_start, c.date_approved);
    if (bd == null) continue;
    all.push(bd);
    (c.pp_upgrade_date ? upgraded : initial).push(bd);
  }
  if (!all.length) return null;
  const sorted = [...all].sort((a, b) => a - b);
  const within = (n) => Math.round((100 * sorted.filter(x => x <= n).length) / sorted.length);
  return {
    n: sorted.length,
    p50: quantileSorted(sorted, 0.5),
    p90: quantileSorted(sorted, 0.9),
    within30: within(30),
    over30: sorted.filter(x => x > 30).length,
    max: sorted[sorted.length - 1],
    values: { all: sorted, initial, upgraded },
  };
}

/** Histogram buckets for BD values: one bar per BD 1..cap, last bucket = ">cap". */
export function bdHistogram(values, cap = 35) {
  const bins = new Array(cap + 1).fill(0); // index 0 unused-ish (bd 0 possible: same-day)
  let over = 0;
  for (const v of values || []) {
    if (v > cap) over++;
    else bins[Math.max(0, v)]++;
  }
  return { bins, over, cap };
}

/**
 * Where the user stands relative to the regular wave front.
 * Returns { deltaDays, position } — deltaDays > 0 means the user applied
 * AFTER the current front (wave still approaching), < 0 means the front has
 * passed their applied date.
 */
export function wavePosition(front, appliedDate) {
  if (!front || !appliedDate) return null;
  const delta = daysBetween(front.appliedP50, appliedDate);
  let position;
  if (delta > 7) position = 'ahead';           // wave hasn't reached them yet
  else if (delta >= -7) position = 'at';       // wave is at their doorstep
  else position = 'behind';                    // wave passed; they're overdue
  return { deltaDays: delta, position };
}
