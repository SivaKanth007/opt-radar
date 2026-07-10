/**
 * lib/cardstats.mjs — post-approval card logistics analytics.
 *
 * Approved → card_produced → card_received are mechanical stages (card
 * printer + USPS), so their distributions are tight and stabilize at modest
 * n. Coverage note: reporting drops after approval (people celebrate and
 * stop updating), so every consumer should surface the per-stage n.
 *
 * Pure functions over the merged case list — shared by the dashboard module
 * (browser) and any node-side consumer/tests.
 */

import { daysBetween, addDays } from './dates.mjs';

/** Gaps longer than this are treated as data errors (lost mail ≠ 4 months). */
const MAX_GAP_DAYS = 120;

/** Full-journey (applied → card in hand) sanity cap — long waits are real here. */
const MAX_TOTAL_DAYS = 500;

const isGood = (c) => !((c?.flags) || []).includes('impossible_dates');

/** Sorted day-gaps between two date fields across all clean cases. */
function gaps(cases, fromField, toField, cap = MAX_GAP_DAYS) {
  const out = [];
  for (const c of cases) {
    if (!isGood(c) || !c[fromField] || !c[toField]) continue;
    const d = daysBetween(c[fromField], c[toField]);
    if (d != null && d >= 0 && d < cap) out.push(d);
  }
  return out.sort((a, b) => a - b);
}

/** Distribution summary of a SORTED values array (floor-index quantiles). */
function dist(values) {
  if (!values.length) return null;
  const q = (p) => values[Math.min(values.length - 1, Math.floor(p * values.length))];
  return {
    n: values.length,
    p25: q(0.25), p50: q(0.5), p75: q(0.75), p90: q(0.9),
    max: values[values.length - 1],
    values,
  };
}

/**
 * cardStats — the three post-approval stage distributions.
 * @returns {{a2p, p2r, a2r}|null}  each a dist() or null when that stage
 *          has no reports; null overall when nothing is reported at all.
 *  a2p: approved → card produced
 *  p2r: card produced → card received
 *  a2r: approved → card received (end-to-end)
 */
export function cardStats(cases) {
  const list = Array.isArray(cases) ? cases : [];
  const a2p = dist(gaps(list, 'date_approved', 'card_produced'));
  const p2r = dist(gaps(list, 'card_produced', 'card_received'));
  const a2r = dist(gaps(list, 'date_approved', 'card_received'));
  if (!a2p && !p2r && !a2r) return null;
  return { a2p, p2r, a2r };
}

/**
 * gapDist — distribution of day-gaps between any two date fields.
 * Generic building block for journey stages (e.g. applied → biometrics).
 */
export function gapDist(cases, fromField, toField, cap = MAX_GAP_DAYS) {
  return dist(gaps(Array.isArray(cases) ? cases : [], fromField, toField, cap));
}

/**
 * journeyStats — full end-to-end distribution: applied → card in hand.
 * Uses the wide MAX_TOTAL_DAYS cap because adjudication waits are long.
 */
export function journeyStats(cases) {
  return gapDist(cases, 'date_applied', 'card_received', MAX_TOTAL_DAYS);
}

/**
 * journeyCompare — how a completed personal journey stacks up against every
 * completed journey in the data.
 * @returns {{n, similar, window, fasterThanPct, p50, p90}|null}
 *   similar        completed journeys within ±window days of totalDays
 *   fasterThanPct  share of completed journeys strictly slower than the user
 */
export function journeyCompare(cases, totalDays, window = 7) {
  if (totalDays == null || !isFinite(totalDays) || totalDays < 0) return null;
  const s = journeyStats(cases);
  if (!s) return null;
  const slower = s.values.filter(v => v > totalDays).length;
  const similar = s.values.filter(v => Math.abs(v - totalDays) <= window).length;
  return {
    n: s.n,
    similar,
    window,
    fasterThanPct: Math.round((slower / s.n) * 100),
    p50: s.p50,
    p90: s.p90,
  };
}

/**
 * cardHistogram — per-day bins for charting; the last bin absorbs everything
 * at/above `cap` (rendered as "cap+").
 */
export function cardHistogram(values, cap = 21) {
  const bins = Array.from({ length: cap + 1 }, (_, i) => ({ day: i, count: 0, overflow: i === cap }));
  for (const v of values || []) {
    if (v == null || v < 0) continue;
    bins[Math.min(v, cap)].count++;
  }
  return bins;
}

/**
 * cardProjection — personal countdown dates from an anchor.
 * @param {object} stats       cardStats() result
 * @param {string} anchorDate  ISO date
 * @param {'approved'|'produced'} anchorKind
 *   'approved' → project produced (a2p) and delivered (a2r)
 *   'produced' → USCIS already says the card is being produced; project
 *                delivery from the produced→received distribution only.
 */
export function cardProjection(stats, anchorDate, anchorKind = 'approved') {
  if (!stats || !anchorDate) return null;

  if (anchorKind === 'produced') {
    const s = stats.p2r;
    if (!s) return null;
    return {
      anchorKind,
      producedP50: null, producedP90: null,
      deliveredP50: addDays(anchorDate, s.p50),
      deliveredP90: addDays(anchorDate, s.p90),
      basis: { p2r: s.n },
    };
  }

  const p = stats.a2p, r = stats.a2r;
  if (!p && !r) return null;
  return {
    anchorKind: 'approved',
    producedP50: p ? addDays(anchorDate, p.p50) : null,
    producedP90: p ? addDays(anchorDate, p.p90) : null,
    deliveredP50: r ? addDays(anchorDate, r.p50) : null,
    deliveredP90: r ? addDays(anchorDate, r.p90) : null,
    basis: { a2p: p?.n ?? 0, a2r: r?.n ?? 0 },
  };
}
