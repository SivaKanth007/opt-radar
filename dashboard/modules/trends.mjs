/**
 * dashboard/modules/trends.mjs
 * Redesigned Trends section — three Chart.js v4 charts rendered into #trends.
 *
 * THE FIX: every chart groups by APPROVAL week (the week date_approved falls in),
 * NOT application week. The old chart grouped by application week behind a
 * ">=70% resolved" guard, which left every recent (and most relevant) week blank.
 * Grouping by approval week populates the current weeks and surfaces the real,
 * honest trend: time-to-approval is climbing.
 *
 * Charts:
 *   1. Processing Momentum (hero) — median applied->approved by approval week,
 *      with a shaded p25–p75 band. Last ~16 weeks.
 *   2. Approval throughput — approvals per approval week (bars) + 4-week moving avg (line).
 *   3. Premium vs Regular — median applied->approved by approval week, two lines.
 *
 * MODULE CONTRACT: export render(ctx). Defensive against null/empty data;
 * renders a small "not enough data yet" note instead of a broken chart.
 * window.Chart is loaded globally via CDN.
 */

// ---------------------------------------------------------------------------
// Constants — section + canvas ids (own, to avoid clashing with legacy ids in
// index.html that app.js still drives). Heights stay capped via .chart-box CSS.
// ---------------------------------------------------------------------------

const WEEKS_SHOWN  = 16;   // last N approval-weeks rendered on the time charts
const MAX_DURATION = 400;  // sanity cap on applied->approved durations (days)
const MIN_GROUP    = 4;    // min n per side for the premium/regular comparison

// Theme-aligned palette. Chart.js needs literal color strings, so we read the
// live CSS variables at render time — this makes the charts follow the active
// light/dark scheme. Defaults below are the dark-theme fallbacks.
let COLORS = {
  axis:        '#8b97b0',
  legend:      '#e8edf7',
  grid:        'rgba(140, 165, 220, 0.14)',
  accent:      '#22d3ee',
  accentFill:  'rgba(34, 211, 238, 0.16)',
  bandFill:    'rgba(34, 211, 238, 0.12)',
  bar:         '#3b82f6',
  barBorder:   '#3b82f6',
  movingAvg:   '#7c5cff',
  premium:     '#34d399',
  regular:     '#fbbf24',
  pointHalo:   '#0a0e1a',
  tooltipBg:   'rgba(7, 10, 19, 0.92)',
  tooltipTitle:'#e8edf7',
  tooltipBody: '#cbd5e1',
};

/** Read the active palette from CSS variables (follows light/dark). */
function readPalette() {
  const v = (name, fb) => {
    try { return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fb; }
    catch { return fb; }
  };
  return {
    axis:         v('--muted', COLORS.axis),
    legend:       v('--text', COLORS.legend),
    grid:         v('--border', COLORS.grid),
    accent:       v('--accent', COLORS.accent),
    accentFill:   COLORS.accentFill,   // low-alpha cyan reads fine on both
    bandFill:     COLORS.bandFill,
    bar:          v('--accent-blue', COLORS.bar),
    barBorder:    v('--accent-blue', COLORS.barBorder),
    movingAvg:    v('--accent-2', COLORS.movingAvg),
    premium:      v('--good', COLORS.premium),
    regular:      v('--warn', COLORS.regular),
    pointHalo:    v('--bg', COLORS.pointHalo),
    tooltipBg:    v('--tooltip-bg', COLORS.tooltipBg),
    tooltipTitle: v('--text', COLORS.tooltipTitle),
    tooltipBody:  v('--muted', COLORS.tooltipBody),
  };
}

const CANVASES = [
  { id: 'trends-momentum',   title: 'Processing Momentum' },
  { id: 'trends-throughput', title: 'Approval throughput' },
  { id: 'trends-premium',    title: 'Premium vs Regular' },
];

// ---------------------------------------------------------------------------
// Date helpers (inline, UTC, Monday-anchored ISO week)
// ---------------------------------------------------------------------------

/**
 * isoWeek — Monday-anchored week key for a 'YYYY-MM-DD' date.
 * Returns the ISO date ('YYYY-MM-DD') of that week's Monday (UTC), which sorts
 * chronologically as a string and reads cleanly as a label.
 * @param {string} dateStr
 * @returns {string|null}
 */
function isoWeek(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr + 'T00:00:00Z');
  if (isNaN(d)) return null;
  const dow = d.getUTCDay();              // 0=Sun..6=Sat
  const back = dow === 0 ? 6 : dow - 1;   // days back to Monday
  d.setUTCDate(d.getUTCDate() - back);
  return d.toISOString().slice(0, 10);
}

/** median — numeric median of an array (null if empty). */
function median(arr, ctx) {
  if (!arr || !arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  // Prefer the tested lib helper when available; fall back to a local impl.
  if (ctx?.stats?.quantileSorted) return ctx.stats.quantileSorted(s, 0.5);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** quantileLocal — pth quantile of an array (null if empty), lib-backed when possible. */
function quantileLocal(arr, p, ctx) {
  if (!arr || !arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  if (ctx?.stats?.quantileSorted) return ctx.stats.quantileSorted(s, p);
  const idx = (s.length - 1) * p;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (idx - lo);
}

/** valid case for trend computation: not impossible, has both dates. */
function usable(c) {
  return c && !(c.flags || []).includes('impossible_dates')
    && c.date_applied && c.date_approved;
}

/** applied->approved duration in days, or null if invalid/out of range. */
function durationOf(c, daysBetween) {
  const d = daysBetween(c.date_applied, c.date_approved);
  return (d != null && d >= 0 && d < MAX_DURATION) ? d : null;
}

// ---------------------------------------------------------------------------
// DOM scaffolding
// ---------------------------------------------------------------------------

/**
 * ensureScaffold — (re)build the chart-box/canvas wrappers inside #trends,
 * preserving the existing <h2>. Returns the section element, or null if absent.
 */
function ensureScaffold(ctx) {
  const { el } = ctx;
  const section = ctx.$('#trends');
  if (!section) return null;

  // Keep the heading, drop everything else (including legacy canvases so the
  // legacy renderer's charts don't linger underneath ours).
  const heading = ctx.$('h2', section);
  section.replaceChildren();
  section.append(heading || el('h2', null, 'Trends'));

  for (const { id, title } of CANVASES) {
    section.append(el('h3', null, title));
    const box = el('div', 'chart-box');
    const canvas = document.createElement('canvas');
    canvas.id = id;
    box.append(canvas);
    section.append(box);
  }
  return section;
}

/** noteUnder — replace a chart-box's content with a muted "not enough data" note. */
function noteUnder(ctx, canvasId, msg) {
  const canvas = ctx.$('#' + canvasId);
  const box = canvas?.closest('.chart-box');
  if (!box) return;
  box.replaceChildren(ctx.el('p', 'muted', msg));
}

// ---------------------------------------------------------------------------
// Shared Chart.js options (dark theme)
// ---------------------------------------------------------------------------

function baseOptions(yTitle) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { labels: { color: COLORS.legend, boxWidth: 12, usePointStyle: true } },
      tooltip: {
        backgroundColor: COLORS.tooltipBg,
        borderColor: COLORS.grid,
        borderWidth: 1,
        titleColor: COLORS.tooltipTitle,
        bodyColor: COLORS.tooltipBody,
        padding: 10,
      },
    },
    scales: {
      x: {
        ticks: { color: COLORS.axis, maxRotation: 0, autoSkip: true, maxTicksLimit: 8 },
        grid: { color: COLORS.grid },
      },
      y: {
        beginAtZero: true,
        title: yTitle ? { display: true, text: yTitle, color: COLORS.axis } : undefined,
        ticks: { color: COLORS.axis },
        grid: { color: COLORS.grid },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Chart 1 — Processing Momentum (median + p25–p75 band, by approval week)
// ---------------------------------------------------------------------------

function renderMomentum(ctx, byApprovalWeek, weeks) {
  const id = 'trends-momentum';
  const labels = [], med = [], p25 = [], p75 = [];
  for (const w of weeks) {
    const durs = byApprovalWeek.get(w) || [];
    if (durs.length < 3) continue;            // too few to summarize that week
    labels.push(w);
    med.push(median(durs, ctx));
    p25.push(quantileLocal(durs, 0.25, ctx));
    p75.push(quantileLocal(durs, 0.75, ctx));
  }
  if (labels.length < 2) {
    noteUnder(ctx, id, 'Not enough approval-week data yet to chart processing momentum.');
    return;
  }

  const canvas = ctx.$('#' + id);
  if (!canvas || !window.Chart) return;

  // Band: draw p25 first, then p75 filling DOWN to the previous dataset (p25).
  new window.Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'p25 (faster quarter)',
          data: p25,
          borderColor: 'transparent',
          backgroundColor: COLORS.bandFill,
          pointRadius: 0,
          fill: false,
          tension: 0.3,
          order: 3,
        },
        {
          label: 'p75 (slower quarter)',
          data: p75,
          borderColor: 'transparent',
          backgroundColor: COLORS.bandFill,
          pointRadius: 0,
          fill: '-1',          // fill toward the previous dataset (p25) → the band
          tension: 0.3,
          order: 3,
        },
        {
          label: 'median days waited (applied → approved)',
          data: med,
          borderColor: COLORS.accent,
          backgroundColor: COLORS.accentFill,
          borderWidth: 2.5,
          pointRadius: 3,
          pointBackgroundColor: COLORS.accent,
          pointBorderColor: COLORS.pointHalo,
          fill: false,
          tension: 0.3,
          order: 1,
        },
      ],
    },
    options: (() => {
      const o = baseOptions('days from filing to approval');
      o.plugins.tooltip.callbacks = {
        title: (items) => `Approved week of ${items[0].label}`,
      };
      // Hide the band datasets from the legend (they're visual context, not series).
      o.plugins.legend.labels.filter = (item) => !/^p25|^p75/.test(item.text);
      return o;
    })(),
  });
}

// ---------------------------------------------------------------------------
// Chart 2 — Approval throughput (bars + 4-week moving average line)
// ---------------------------------------------------------------------------

function renderThroughput(ctx, countByWeek, weeks) {
  const id = 'trends-throughput';
  const labels = weeks.slice();
  const counts = labels.map((w) => countByWeek.get(w) || 0);
  if (labels.length < 2) {
    noteUnder(ctx, id, 'Not enough approval-week data yet to chart throughput.');
    return;
  }

  // 4-week trailing moving average (needs >=1 prior point; null until window fills).
  const WIN = 4;
  const movAvg = counts.map((_, i) => {
    if (i < WIN - 1) return null;
    let sum = 0;
    for (let k = i - WIN + 1; k <= i; k++) sum += counts[k];
    return Math.round((sum / WIN) * 10) / 10;
  });

  const canvas = ctx.$('#' + id);
  if (!canvas || !window.Chart) return;

  new window.Chart(canvas, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          type: 'bar',
          label: 'approvals reported',
          data: counts,
          backgroundColor: COLORS.bar,
          borderColor: COLORS.barBorder,
          borderWidth: 1,
          borderRadius: 4,
          order: 2,
        },
        {
          type: 'line',
          label: '4-week moving average',
          data: movAvg,
          borderColor: COLORS.movingAvg,
          backgroundColor: COLORS.movingAvg,
          borderWidth: 2.5,
          pointRadius: 2,
          tension: 0.35,
          spanGaps: true,
          fill: false,
          order: 1,
        },
      ],
    },
    options: (() => {
      const o = baseOptions('approvals per week');
      o.plugins.tooltip.callbacks = {
        title: (items) => `Approved week of ${items[0].label}`,
      };
      return o;
    })(),
  });
}

// ---------------------------------------------------------------------------
// Chart 3 — Premium vs Regular (two median lines, by approval week)
// ---------------------------------------------------------------------------

function renderPremium(ctx, ppByWeek, regByWeek, weeks) {
  const id = 'trends-premium';
  const labels = weeks.slice();
  const ppLine = labels.map((w) => {
    const a = ppByWeek.get(w) || [];
    return a.length >= MIN_GROUP ? median(a, ctx) : null;
  });
  const regLine = labels.map((w) => {
    const a = regByWeek.get(w) || [];
    return a.length >= MIN_GROUP ? median(a, ctx) : null;
  });

  const ppPts  = ppLine.filter((v) => v != null).length;
  const regPts = regLine.filter((v) => v != null).length;
  if (ppPts < 2 && regPts < 2) {
    noteUnder(ctx, id, 'Not enough premium/regular volume per week to compare yet.');
    return;
  }

  const canvas = ctx.$('#' + id);
  if (!canvas || !window.Chart) return;

  new window.Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'premium (median BUSINESS days on the 30-BD clock)',
          data: ppLine,
          yAxisID: 'y1',
          borderColor: COLORS.premium,
          backgroundColor: COLORS.premium,
          borderWidth: 2.5,
          pointRadius: 2.5,
          pointBorderColor: COLORS.pointHalo,
          spanGaps: true,
          tension: 0.3,
          fill: false,
        },
        {
          label: 'regular (median days from filing)',
          data: regLine,
          yAxisID: 'y',
          borderColor: COLORS.regular,
          backgroundColor: COLORS.regular,
          borderWidth: 2.5,
          pointRadius: 2.5,
          pointBorderColor: COLORS.pointHalo,
          spanGaps: true,
          tension: 0.3,
          fill: false,
        },
      ],
    },
    options: (() => {
      const o = baseOptions('regular: days from filing');
      // Premium rides its own right-hand axis in BUSINESS days — its clock
      // starts at biometrics/upgrade and is capped by the 30-BD promise, so it
      // must not share a scale with regular's from-filing calendar days.
      o.scales.y1 = {
        position: 'right',
        beginAtZero: true,
        suggestedMax: 35,
        title: { display: true, text: 'premium: business days on clock', color: COLORS.axis },
        ticks: { color: COLORS.axis },
        grid: { drawOnChartArea: false },
      };
      o.plugins.tooltip.callbacks = {
        title: (items) => `Approved week of ${items[0].label}`,
        label: (item) => item.datasetIndex === 0
          ? `premium: median ${item.parsed.y} business days on the clock`
          : `regular: median ${item.parsed.y} days from filing`,
      };
      return o;
    })(),
  });
}

// ---------------------------------------------------------------------------
// render — MODULE CONTRACT entry point
// ---------------------------------------------------------------------------

/**
 * render — build the three redesigned trend charts inside #trends.
 * @param {object} ctx  orchestrator context (see module contract)
 */
export function render(ctx) {
  // 0) Refresh the palette from CSS vars so charts follow the active light/dark scheme.
  COLORS = readPalette();

  // 1) Destroy any existing charts on our canvases (prevents stacking on re-render).
  for (const { id } of CANVASES) {
    const c = document.getElementById(id);
    if (c) window.Chart?.getChart(c)?.destroy();
  }

  const section = ensureScaffold(ctx);
  if (!section) return;

  // If Chart.js failed to load, leave clear notes rather than throwing.
  if (!window.Chart) {
    for (const { id } of CANVASES) noteUnder(ctx, id, 'Charts unavailable (Chart.js did not load).');
    return;
  }

  const data = ctx?.data;
  const cases = Array.isArray(data?.cases) ? data.cases : [];
  const daysBetween = ctx.dates.daysBetween;

  // Build approval-week aggregates in a single pass.
  const byApprovalWeek = new Map(); // week -> [durations]
  const countByWeek    = new Map(); // week -> approval count
  const ppByWeek       = new Map(); // week -> [durations] (premium)
  const regByWeek      = new Map(); // week -> [durations] (regular)

  for (const c of cases) {
    if (!usable(c)) continue;
    const week = isoWeek(c.date_approved);
    if (!week) continue;

    // Throughput counts every legitimately-approved case in its approval week.
    countByWeek.set(week, (countByWeek.get(week) || 0) + 1);

    // Duration-based series need a sane applied->approved gap.
    const dur = durationOf(c, daysBetween);
    if (dur == null) continue;

    if (!byApprovalWeek.has(week)) byApprovalWeek.set(week, []);
    byApprovalWeek.get(week).push(dur);

    if (c.premium) {
      // Premium is a 30-BUSINESS-DAY promise from the CLOCK START (biometrics
      // or upgrade date — pp_start), not from filing. Measured from filing the
      // same cases read "~70 days" and look broken; on the clock they cluster
      // at ≤30 BD. Chart premium in business days on its own axis.
      const bdb = ctx.dates.businessDaysBetween;
      const bd = bdb && c.pp_start ? bdb(c.pp_start, c.date_approved) : null;
      if (bd != null && bd < MAX_DURATION) {
        if (!ppByWeek.has(week)) ppByWeek.set(week, []);
        ppByWeek.get(week).push(bd);
      }
    } else {
      if (!regByWeek.has(week)) regByWeek.set(week, []);
      regByWeek.get(week).push(dur);
    }
  }

  if (!countByWeek.size) {
    for (const { id } of CANVASES) noteUnder(ctx, id, 'Not enough data yet — no approvals on record.');
    return;
  }

  // Last ~WEEKS_SHOWN approval-weeks, chronological.
  const allWeeks = [...countByWeek.keys()].sort();
  const recentWeeks = allWeeks.slice(-WEEKS_SHOWN);

  try {
    renderMomentum(ctx, byApprovalWeek, recentWeeks);
    renderThroughput(ctx, countByWeek, recentWeeks);
    renderPremium(ctx, ppByWeek, regByWeek, recentWeeks);
  } catch (err) {
    // Never let a Chart.js hiccup take down the page.
    for (const { id } of CANVASES) {
      if (!window.Chart.getChart(document.getElementById(id))) {
        noteUnder(ctx, id, 'Chart could not be rendered.');
      }
    }
    if (ctx.toast) ctx.toast('Trends chart error — showing partial view.', 'warn');
    // eslint-disable-next-line no-console
    console.error('[trends] render error:', err);
  }
}
