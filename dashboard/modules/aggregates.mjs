/**
 * dashboard/modules/aggregates.mjs
 * Renders funnel stage durations, RFE stats, service-center table, and weekday bar chart.
 *
 * Sections: #funnel, #rfe, #centers, #weekday
 * Follows the MODULE CONTRACT: export render(ctx).
 */

// Module-level handle so we can destroy the chart on re-render.
let _weekdayChart = null;

/**
 * Inline median helper — avoids importing stats just for this.
 * Uses ctx.stats.quantileSorted on a sorted copy.
 */
function median(arr, quantileSorted) {
  if (!arr || arr.length === 0) return null;
  const s = [...arr].sort((a, b) => a - b);
  return quantileSorted(s, 0.5);
}

/** Filter out impossible-date cases. */
function isGood(c) {
  return !(c.flags || []).includes('impossible_dates');
}

export function render(ctx) {
  const { data, $, el, fmt, wrapTable, countUp, prefersReducedMotion, dates, stats } = ctx;
  const { daysBetween } = dates;
  const { quantileSorted } = stats;

  if (!data || !data.cases) return;

  const cases = data.cases.filter(isGood);

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /**
   * Build a stat card with an animated countUp value.
   * value: number|string (string values skip countUp).
   */
  function statCard(value, label, modifier) {
    const c = el('div', modifier ? `card ${modifier}` : 'card');
    const vEl = el('div', 'value');
    const lEl = el('div', 'label', label);
    c.append(vEl, lEl);

    if (typeof value === 'number' && isFinite(value)) {
      vEl.textContent = fmt(value);
      if (!prefersReducedMotion()) {
        countUp(vEl, value, { duration: 800, decimals: 0 });
      }
    } else {
      vEl.textContent = (value == null || value === '') ? '—' : String(value);
    }
    return c;
  }

  /**
   * Stage median: median of daysBetween(fromField, toField) across valid cases.
   */
  function stageMedian(fromField, toField) {
    const ds = cases
      .filter(c => c[fromField] && c[toField])
      .map(c => daysBetween(c[fromField], c[toField]))
      .filter(d => d >= 0);
    return median(ds, quantileSorted);
  }

  // -------------------------------------------------------------------------
  // #funnel — stage duration cards
  // -------------------------------------------------------------------------
  (function renderFunnel() {
    const sec = document.getElementById('funnel');
    if (!sec) return;

    // Clear previous content except any existing h2
    const h2 = sec.querySelector('h2');
    sec.replaceChildren();
    if (h2) sec.append(h2);

    const stages = [
      { from: 'date_applied',   to: 'biometrics_date', label: 'Applied → Biometrics (median days)' },
      { from: 'biometrics_date', to: 'date_approved',  label: 'Biometrics → Approved (median days)' },
      { from: 'date_approved',  to: 'card_produced',   label: 'Approved → Card Produced (median days)' },
      { from: 'card_produced',  to: 'card_received',   label: 'Produced → Received (median days)' },
    ];

    const grid = el('div', 'stat-grid');
    let anyData = false;

    for (const { from, to, label } of stages) {
      const m = stageMedian(from, to);
      if (m != null) anyData = true;
      grid.append(statCard(m != null ? Math.round(m) : null, label));
    }

    if (!anyData) {
      sec.append(el('p', 'muted', 'No stage-duration data available yet.'));
    } else {
      sec.append(grid);
    }
  })();

  // -------------------------------------------------------------------------
  // #rfe — RFE impact cards
  // -------------------------------------------------------------------------
  (function renderRfe() {
    const sec = document.getElementById('rfe');
    if (!sec) return;

    const h2 = sec.querySelector('h2');
    sec.replaceChildren();
    if (h2) sec.append(h2);

    // "Good" cases with a valid applied date (mirrors the original logic)
    const goodCases = cases.filter(c => c.date_applied);
    if (!goodCases.length) {
      sec.append(el('p', 'muted', 'No case data available.'));
      return;
    }

    const withRfe    = goodCases.filter(c => c.rfe_date);
    const rfeRate    = withRfe.length / goodCases.length;

    const apprRfe    = withRfe
      .filter(c => c.date_approved)
      .map(c => daysBetween(c.date_applied, c.date_approved))
      .filter(d => d >= 0);

    const apprNoRfe  = goodCases
      .filter(c => !c.rfe_date && c.date_approved)
      .map(c => daysBetween(c.date_applied, c.date_approved))
      .filter(d => d >= 0);

    const medRfe     = median(apprRfe, quantileSorted);
    const medNoRfe   = median(apprNoRfe, quantileSorted);
    const penalty    = (medRfe != null && medNoRfe != null)
      ? Math.round(medRfe - medNoRfe)
      : null;

    const grid = el('div', 'stat-grid');

    // RFE rate card — warn tint if > 10%
    const rateCard = el('div', rfeRate > 0.1 ? 'card warn' : 'card');
    const rateVal  = el('div', 'value');
    const rateLbl  = el('div', 'label', 'RFE Rate');
    rateVal.textContent = (rfeRate * 100).toFixed(1) + '%';
    rateCard.append(rateVal, rateLbl);
    grid.append(rateCard);

    grid.append(
      statCard(medRfe   != null ? Math.round(medRfe)   : null, 'Median Days with RFE'),
      statCard(medNoRfe != null ? Math.round(medNoRfe) : null, 'Median Days without RFE'),
    );

    // Penalty card
    const penCard = el('div', penalty != null && penalty > 0 ? 'card warn' : 'card');
    const penVal  = el('div', 'value');
    const penLbl  = el('div', 'label', 'RFE Penalty (days)');
    penVal.textContent = penalty != null
      ? (penalty >= 0 ? '+' : '') + penalty
      : '—';
    penCard.append(penVal, penLbl);
    grid.append(penCard);

    sec.append(grid);
  })();

  // -------------------------------------------------------------------------
  // #centers — service center table
  // -------------------------------------------------------------------------
  (function renderCenters() {
    const sec = document.getElementById('centers');
    if (!sec) return;

    const h2 = sec.querySelector('h2');
    sec.replaceChildren();
    if (h2) sec.append(h2);

    // Collect approved durations per service center
    const byCenter = new Map();
    for (const c of cases) {
      if (!c.service_center || !c.date_approved || !c.date_applied) continue;
      const d = daysBetween(c.date_applied, c.date_approved);
      if (d < 0) continue;
      if (!byCenter.has(c.service_center)) byCenter.set(c.service_center, []);
      byCenter.get(c.service_center).push(d);
    }

    if (!byCenter.size) {
      sec.append(el('p', 'muted', 'No service-center data available.'));
      return;
    }

    const tbl = el('table');
    const thead = el('tr');
    thead.innerHTML = '<th>Center</th><th>n Approved</th><th>Median Days</th>';
    tbl.append(thead);

    // Sort by count descending
    const sorted = [...byCenter.entries()].sort((a, b) => b[1].length - a[1].length);
    for (const [name, ds] of sorted) {
      const m = median(ds, quantileSorted);
      const tr = el('tr');
      tr.innerHTML = `<td>${name}</td><td>${ds.length}</td><td>${fmt(m != null ? Math.round(m) : null)}</td>`;
      tbl.append(tr);
    }

    sec.append(wrapTable(tbl));
  })();

  // -------------------------------------------------------------------------
  // #weekday — approvals by weekday bar chart
  // -------------------------------------------------------------------------
  (function renderWeekday() {
    const sec = document.getElementById('weekday');
    if (!sec) return;

    const h2 = sec.querySelector('h2');
    sec.replaceChildren();
    if (h2) sec.append(h2);

    // Destroy previous chart if it exists
    if (_weekdayChart) {
      _weekdayChart.destroy();
      _weekdayChart = null;
    }

    // Tally approvals by UTC day-of-week
    const counts = [0, 0, 0, 0, 0, 0, 0]; // index = getUTCDay() (0=Sun)
    for (const c of cases) {
      if (!c.date_approved) continue;
      const dow = new Date(c.date_approved + 'T00:00:00Z').getUTCDay();
      counts[dow]++;
    }

    const labels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const total  = counts.reduce((a, b) => a + b, 0);

    if (total === 0) {
      sec.append(el('p', 'muted', 'No approval data available.'));
      return;
    }

    const box    = el('div', 'chart-box');
    const canvas = el('canvas');
    canvas.id = 'weekday-chart';
    box.append(canvas);
    sec.append(box);

    if (!window.Chart) {
      sec.append(el('p', 'muted', 'Chart.js not loaded — cannot render weekday chart.'));
      return;
    }

    // Follow the active light/dark palette (Chart.js needs literal colors).
    const cv = (name, fb) => {
      try { return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fb; }
      catch { return fb; }
    };
    const axis = cv('--muted', '#94a3b8');
    const legend = cv('--text', '#cbd5e1');
    const grid = cv('--border', 'rgba(140,165,220,0.10)');
    const barColor = cv('--accent-2', '#a78bfa');

    const CHART_OPTS = {
      responsive: true,
      maintainAspectRatio: false,
      animation: prefersReducedMotion() ? false : undefined,
      plugins: {
        legend: { labels: { color: legend } },
        tooltip: {
          backgroundColor: cv('--tooltip-bg', 'rgba(7,10,19,0.92)'),
          titleColor: legend,
          bodyColor: axis,
          callbacks: {
            label: (item) => ` ${item.raw} approvals`,
          },
        },
      },
      scales: {
        x: { ticks: { color: axis }, grid: { color: grid } },
        y: { ticks: { color: axis }, grid: { color: grid }, beginAtZero: true },
      },
    };

    _weekdayChart = new window.Chart(canvas, {
      type: 'bar',
      options: CHART_OPTS,
      data: {
        labels,
        datasets: [{
          label: 'Approvals by weekday',
          data: counts,
          backgroundColor: barColor,
          borderColor: barColor,
          borderWidth: 1,
          borderRadius: 4,
        }],
      },
    });
  })();
}
