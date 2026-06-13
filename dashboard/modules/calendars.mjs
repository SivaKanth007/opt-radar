/**
 * dashboard/modules/calendars.mjs
 * Two heat-map calendars for the #calendars section:
 *   - #cal-cohort : per applied-date cell colored by % of that day's applicants
 *                   approved so far (green scale). Tooltip "YYYY-MM-DD: a/b approved (NN%)".
 *   - #cal-volume : per approval-date cell colored by count intensity (blue scale).
 *                   Tooltip "YYYY-MM-DD: N approvals".
 *
 * Behavior ported 1:1 from the original app.js calendar block:
 *   - CONSISTENCY CUTOFF: only render months from the first month whose application
 *     count >= max(10, 10% of the busiest month's count); earlier stragglers dropped.
 *   - FLOATING TOOLTIP: single #cal-tip appended to <body>, shown on hover (desktop)
 *     and tap (touch), position-fixed above the cell, clamped on-screen, hidden on
 *     mouseout / scroll / tapping empty space; tapped cell gets a .selected outline.
 *   - Sun-first 7-column month grid; empty leading cells get .day.empty.
 *
 * Module contract: export render(ctx). Defensive against null/missing data and
 * empty result sets (renders a clear empty state, never throws).
 */

// A case is usable for the calendars unless its dates are internally impossible.
function usable(c) {
  return c && !(c.flags || []).includes('impossible_dates');
}

// ---------------------------------------------------------------------------
// Month grid (Sun-first, matching the theme's 7-col .month-days layout)
// ---------------------------------------------------------------------------
function monthGrid(el, year, month /* 0-based */) {
  const wrap = el('div', 'month');
  wrap.append(el('div', 'month-title', `${year}-${String(month + 1).padStart(2, '0')}`));
  const grid = el('div', 'month-days');
  const first = new Date(Date.UTC(year, month, 1));
  // Leading blanks so the 1st lands under its weekday column (Sun = column 0).
  for (let i = 0; i < first.getUTCDay(); i++) grid.append(el('div', 'day empty'));
  const days = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  for (let d = 1; d <= days; d++) {
    const iso = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const cell = el('div', 'day');
    cell.dataset.date = iso;
    grid.append(cell);
  }
  wrap.append(grid);
  return wrap;
}

// ---------------------------------------------------------------------------
// Floating tooltip (single #cal-tip on <body>)
// ---------------------------------------------------------------------------
function calTip(el) {
  let tip = document.querySelector('#cal-tip');
  if (!tip) {
    tip = el('div');
    tip.id = 'cal-tip';
    tip.classList.add('hidden');
    document.body.append(tip);
    // A fixed-position tooltip goes stale the moment anything scrolls — just hide it.
    document.addEventListener('scroll', () => tip.classList.add('hidden'), { passive: true, capture: true });
  }
  return tip;
}

function showTip(el, cell) {
  const tip = calTip(el);
  tip.textContent = cell.dataset.tip;
  tip.classList.remove('hidden');
  const r = cell.getBoundingClientRect();
  const half = tip.offsetWidth / 2 + 6;
  // Guard against a 0-width viewport (some headless/embedded contexts report 0).
  const vw = Math.max(document.documentElement.clientWidth || 0, window.innerWidth || 0);
  let left = r.left + r.width / 2;
  if (vw > half * 2) left = Math.min(Math.max(left, half), vw - half); // clamp only with a sane viewport
  tip.style.left = left + 'px';
  tip.style.top = (r.top - 8) + 'px';
}

// ---------------------------------------------------------------------------
// Render one calendar into a container from a per-date value map
// ---------------------------------------------------------------------------
function renderCalendar(ctx, containerSel, perDate, colorFn, titleFn) {
  const { $, el } = ctx;
  const container = $(containerSel);
  if (!container) return; // section/div missing — nothing to do

  container.replaceChildren();
  const dates = [...perDate.keys()].sort();
  if (!dates.length) {
    container.append(el('p', 'muted', 'No data yet.'));
    return;
  }

  // Lay down a contiguous run of month grids from the first to the last date.
  let [y, m] = dates[0].split('-').map(Number); m -= 1;
  const [ey, em] = dates[dates.length - 1].split('-').map(Number);
  while (y < ey || (y === ey && m <= em - 1)) {
    container.append(monthGrid(el, y, m));
    m++; if (m > 11) { m = 0; y++; }
  }

  // Paint cells that have a value; leave the rest as the empty surface color.
  for (const cell of container.querySelectorAll('.day[data-date]')) {
    const v = perDate.get(cell.dataset.date);
    if (v !== undefined) {
      cell.style.background = colorFn(v);
      cell.dataset.tip = `${cell.dataset.date}: ${titleFn(v)}`;
    }
  }

  // Floating tooltip: hover on desktop, tap on touch. Tapping empty space hides it.
  const tip = calTip(el);
  container.onmouseover = (e) => { const c = e.target.closest('.day[data-tip]'); if (c) showTip(el, c); };
  container.onmouseout  = (e) => { if (e.target.closest('.day')) tip.classList.add('hidden'); };
  container.onclick = (e) => {
    const c = e.target.closest('.day[data-tip]');
    container.querySelector('.day.selected')?.classList.remove('selected');
    if (!c) { tip.classList.add('hidden'); return; }
    c.classList.add('selected');
    showTip(el, c);
  };
}

// ---------------------------------------------------------------------------
// render(ctx) — build both calendars
// ---------------------------------------------------------------------------
export function render(ctx) {
  const { data, $, el } = ctx;
  const cohortSel = '#cal-cohort';
  const volumeSel = '#cal-volume';

  // Defensive: no data at all → clear, friendly empty state in both containers.
  const cases = (data && Array.isArray(data.cases) ? data.cases : []).filter(usable);
  if (!cases.length) {
    for (const sel of [cohortSel, volumeSel]) {
      const c = $(sel);
      if (c) c.replaceChildren(el('p', 'muted', 'No data yet.'));
    }
    return;
  }

  // CONSISTENCY CUTOFF — calendars start where the data gets consistent: the first
  // month with >= max(10, 10% of the busiest month's applications). Lone early
  // stragglers (e.g. a single 2024-11 case before the cohort really begins) are
  // anomalies, not signal. Stats elsewhere still use every case — this trims the
  // CALENDAR DISPLAY only.
  const byMonth = new Map();
  for (const c of cases) if (c.date_applied) {
    const mo = c.date_applied.slice(0, 7);
    byMonth.set(mo, (byMonth.get(mo) || 0) + 1);
  }
  const peak = Math.max(1, ...byMonth.values());
  const startMonth = [...byMonth.keys()].sort()
    .find(mo => byMonth.get(mo) >= Math.max(10, peak * 0.1)) || '';
  const fromStart = (map) => new Map([...map].filter(([d]) => d.slice(0, 7) >= startMonth));

  // Calendar A — cohort completion: per applied date {total, approved}.
  const cohort = new Map();
  for (const c of cases) {
    if (!c.date_applied) continue;
    const v = cohort.get(c.date_applied) || { total: 0, approved: 0 };
    v.total++;
    if (c.date_approved) v.approved++;
    cohort.set(c.date_applied, v);
  }
  renderCalendar(ctx, cohortSel, fromStart(cohort),
    v => `hsl(${Math.round(120 * (v.approved / v.total))} 70% 35%)`,
    v => `${v.approved}/${v.total} approved (${Math.round(100 * v.approved / v.total)}%)`);

  // Calendar B — approval volume: per approval date count.
  const vol = new Map();
  for (const c of cases) if (c.date_approved) {
    vol.set(c.date_approved, (vol.get(c.date_approved) || 0) + 1);
  }
  const max = Math.max(1, ...vol.values());
  renderCalendar(ctx, volumeSel, fromStart(vol),
    v => `hsl(210 80% ${20 + Math.round(45 * v / max)}%)`,
    v => `${v} approvals`);
}
