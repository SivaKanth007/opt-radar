import { daysBetween, addDays, addBusinessDays, localToday } from '/lib/dates.mjs';
import { naivePercentiles, kmCurve, kmQuantile, kmConditionalQuantile, kmSurvivalAt, quantileSorted } from '/lib/stats.mjs';
import { matchCohort, buildObservations } from '/lib/cohort.mjs';

const $ = (sel) => document.querySelector(sel);
const fmt = (n) => n == null ? '—' : Math.round(n);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
function card(value, label) { const c = el('div', 'card'); c.append(el('div', 'value', String(value)), el('div', 'label', label)); return c; }

let DATA = null, DIFF = null;
const TODAY = localToday();

async function load() {
  const [latest, diff] = await Promise.all([
    fetch('/data/latest.json').then(r => r.ok ? r.json() : null),
    fetch('/data/diff.json').then(r => r.ok ? r.json() : null).catch(() => null),
  ]);
  if (!latest) {
    document.body.innerHTML = '<main><h1>No data yet</h1><p>Run <code>node fetch-data.mjs</code> first.</p></main>';
    return;
  }
  DATA = latest; DIFF = diff;
  renderAll();
}

function good(c) { return !(c.flags || []).includes('impossible_dates'); }
function approvedCases() {
  return DATA.cases.filter(c => good(c) && c.date_applied && c.date_approved
    && !(c.flags || []).includes('outlier_duration'));
}
function durations(list) {
  return list.map(c => daysBetween(c.date_applied, c.date_approved)).filter(d => d >= 0);
}

function renderMeta() {
  $('#meta').textContent = `data as of ${DATA.fetched_at?.slice(0, 16).replace('T', ' ')} · ${DATA.cases.length} cases`;
  const bad = Object.entries(DATA.sources || {}).filter(([k, v]) => v && v.ok === false && k !== 'reddit');
  const banner = $('#stale-banner');
  if (bad.length) {
    banner.classList.remove('hidden');
    banner.textContent = `⚠ Source failed: ${bad.map(([k, v]) => `${k}${v.fallback ? ' (using older snapshot)' : ''}`).join(', ')}`;
  }
}

function renderHeadline() {
  const appr = approvedCases();
  const durs = durations(appr).sort((a, b) => a - b);
  const naive = naivePercentiles(durs, [0.1, 0.5, 0.9]) || {};
  // survival-adjusted across all good cases
  const obs = buildObservations(DATA.cases.filter(c => good(c)), { today: DATA.today || TODAY, staleCap: DATA.stale_cutoff_days, mode: 'applied' });
  const curve = kmCurve(obs);
  const earliest = appr.slice().sort((a, b) => a.date_approved < b.date_approved ? -1 : 1)[0];
  const pending = DATA.cases.filter(c => good(c) && c.date_applied && !c.date_approved);
  const pendAges = pending.map(c => daysBetween(c.date_applied, DATA.today || TODAY)).sort((a, b) => a - b);

  const cards = $('#headline-cards');
  cards.replaceChildren(
    card(DATA.cases.length, 'total cases'),
    card(appr.length, 'approved'),
    card(pending.length, 'pending'),
    card(earliest ? earliest.date_approved : '—', 'earliest approval on record'),
    card(`${fmt(naive.p10)} / ${fmt(naive.p50)} / ${fmt(naive.p90)}`, 'days p10/p50/p90 (naive, approved only)'),
    card(`${fmt(kmQuantile(curve, 0.1))} / ${fmt(kmQuantile(curve, 0.5))} / ${fmt(kmQuantile(curve, 0.9))}`, 'days p10/p50/p90 (survival-adjusted)'),
    card(fmt(quantileSorted(pendAges, 0.5)), 'median pending age (days)'),
  );

  const recent = appr.slice().sort((a, b) => a.date_approved > b.date_approved ? -1 : 1).slice(0, 10);
  const tbl = el('table');
  tbl.innerHTML = '<tr><th>Approved</th><th>Applied</th><th>Days</th><th>Type</th><th>PP</th><th>Link</th></tr>';
  for (const c of recent) {
    const tr = el('tr');
    tr.innerHTML = `<td>${c.date_approved}</td><td>${c.date_applied}</td><td>${daysBetween(c.date_applied, c.date_approved)}</td><td>${c.opt_type}</td><td>${c.premium ? '⚡' : ''}</td><td>${c.reddit_url ? `<a href="${c.reddit_url}" target="_blank">reddit</a>` : '—'}</td>`;
    tbl.append(tr);
  }
  const wrap = $('#recent-approvals');
  wrap.replaceChildren(el('h3', null, '10 most recent approvals'), tbl);
}

function renderDiffPanel() {
  const out = $('#diff-out');
  if (!DIFF || DIFF.first_snapshot) { out.textContent = 'First snapshot — diffs appear after the next refresh.'; return; }
  const bits = [el('p', null, `Since ${DIFF.since?.slice(0, 10)}: ${DIFF.new_cases} new cases, ${DIFF.newly_approved.length} newly approved.`)];
  if (DIFF.newly_approved.length) {
    const tbl = el('table');
    tbl.innerHTML = '<tr><th>Applied</th><th>Approved</th><th>Days</th><th>Link</th></tr>';
    for (const a of DIFF.newly_approved.slice(0, 30)) {
      const tr = el('tr');
      tr.innerHTML = `<td>${a.date_applied ?? '—'}</td><td>${a.date_approved}</td><td>${a.days ?? '—'}</td><td>${a.reddit_url ? `<a href="${a.reddit_url}" target="_blank">reddit</a>` : '—'}</td>`;
      tbl.append(tr);
    }
    bits.push(tbl);
  }
  out.replaceChildren(...bits);
}

function renderQuality() {
  const n = DATA.cases.length;
  const nullPct = (f) => (100 * DATA.cases.filter(c => c[f] == null).length / n).toFixed(0) + '%';
  const flagCount = (f) => DATA.cases.filter(c => (c.flags || []).includes(f)).length;
  const s = DATA.sources || {};
  $('#quality-out').innerHTML = `
    <table>
      <tr><th>Metric</th><th>Value</th></tr>
      <tr><td>Sources</td><td>optpulse ${s.optpulse?.count ?? '—'} · opttracker ${s.opttracker?.count ?? '—'} · merged ${s.merged ?? 0} · conflicts ${s.conflicts ?? 0}</td></tr>
      <tr><td>Censoring (pending share)</td><td>${(100 * DATA.cases.filter(c => !c.date_approved).length / n).toFixed(0)}%</td></tr>
      <tr><td>Stale-pending cutoff</td><td>${DATA.stale_cutoff_days} days (p99 of approved)</td></tr>
      <tr><td>Flags</td><td>impossible ${flagCount('impossible_dates')} · outliers ${flagCount('outlier_duration')} · stale ${flagCount('stale_pending')}</td></tr>
      <tr><td>Missing fields</td><td>biometrics ${nullPct('biometrics_date')} · service center ${nullPct('service_center')} · nationality ${nullPct('nationality')} · card received ${nullPct('card_received')}</td></tr>
      <tr><td>Schema warnings</td><td>${(DATA.warnings || []).join('; ') || 'none'}</td></tr>
    </table>
    <p class="muted">Naive stats use approved cases only (biased fast). Survival-adjusted stats count pending cases as "at least N days" (Kaplan-Meier); stale pending cases are censored at the cutoff.</p>`;
}

function renderAll() {
  renderMeta();
  renderHeadline();
  renderDiffPanel();
  renderQuality();
  if (window.renderCalendars) window.renderCalendars();
  if (window.renderCalculator) window.renderCalculator();
  if (window.renderTrendsAll) window.renderTrendsAll();
}

$('#refresh-btn').addEventListener('click', async () => {
  $('#refresh-btn').disabled = true; $('#refresh-btn').textContent = 'Refreshing…';
  try { await fetch('/api/refresh', { method: 'POST' }); await load(); }
  finally { $('#refresh-btn').disabled = false; $('#refresh-btn').textContent = 'Refresh data'; }
});

export { $, el, card, fmt, good, approvedCases, durations, DATA, TODAY };
window.getData = () => DATA;
load();

// ---------- Calendars ----------
function monthGrid(year, month /* 0-based */) {
  const wrap = el('div', 'month');
  wrap.append(el('div', 'month-title', `${year}-${String(month + 1).padStart(2, '0')}`));
  const grid = el('div', 'month-days');
  const first = new Date(Date.UTC(year, month, 1));
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

function renderCalendar(containerSel, perDate, colorFn, titleFn) {
  const container = $(containerSel);
  container.replaceChildren();
  const dates = [...perDate.keys()].sort();
  if (!dates.length) { container.textContent = 'no data'; return; }
  let [y, m] = dates[0].split('-').map(Number); m -= 1;
  const [ey, em] = dates[dates.length - 1].split('-').map(Number);
  while (y < ey || (y === ey && m <= em - 1)) {
    container.append(monthGrid(y, m));
    m++; if (m > 11) { m = 0; y++; }
  }
  for (const cell of container.querySelectorAll('.day[data-date]')) {
    const v = perDate.get(cell.dataset.date);
    if (v !== undefined) {
      cell.style.background = colorFn(v);
      cell.title = `${cell.dataset.date}: ${titleFn(v)}`;
    }
  }
}

window.renderCalendars = function renderCalendars() {
  const cases = DATA.cases.filter(c => good(c));
  // Cohort: per applied date {total, approved}
  const cohort = new Map();
  for (const c of cases) {
    if (!c.date_applied) continue;
    const v = cohort.get(c.date_applied) || { total: 0, approved: 0 };
    v.total++; if (c.date_approved) v.approved++;
    cohort.set(c.date_applied, v);
  }
  renderCalendar('#cal-cohort', cohort,
    v => `hsl(${Math.round(120 * (v.approved / v.total))} 70% 35%)`,
    v => `${v.approved}/${v.total} approved (${Math.round(100 * v.approved / v.total)}%)`);

  // Volume: per approval date count
  const vol = new Map();
  for (const c of cases) if (c.date_approved) vol.set(c.date_approved, (vol.get(c.date_approved) || 0) + 1);
  const max = Math.max(1, ...vol.values());
  renderCalendar('#cal-volume', vol,
    v => `hsl(210 80% ${20 + Math.round(45 * v / max)}%)`,
    v => `${v} approvals`);
};

// ---------- Calculator ----------
const LS_KEY = 'opt-radar-mycase';

window.renderCalculator = function renderCalculator() {
  const form = $('#calc-form');
  if (!form.dataset.built) {
    form.dataset.built = '1';
    form.innerHTML = `
      <label>Applied <input type="date" name="applied" required></label>
      <label>Biometrics <input type="date" name="biometrics"></label>
      <label>PP upgrade <input type="date" name="pp"></label>
      <label>Type <select name="type"><option value="initial">Initial OPT</option><option value="stem">STEM ext.</option></select></label>
      <label><input type="checkbox" name="ppstart"> premium from start</label>
      <button type="submit">Project</button>`;
    const saved = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
    if (saved) for (const [k, v] of Object.entries(saved)) {
      const f = form.elements[k];
      if (f) f.type === 'checkbox' ? (f.checked = v) : (f.value = v);
    }
    form.addEventListener('submit', (e) => { e.preventDefault(); compute(); });
  }
  if (form.elements.applied.value) compute();

  function compute() {
    const v = Object.fromEntries(new FormData(form));
    const state = { applied: v.applied, biometrics: v.biometrics, pp: v.pp, type: v.type, ppstart: !!form.elements.ppstart.checked };
    localStorage.setItem(LS_KEY, JSON.stringify(state));
    if (!state.applied) return;

    const today = DATA.today || TODAY;
    const premium = state.ppstart || !!state.pp;
    const ppMode = premium;
    const ppStart = state.pp || state.applied;
    const start = ppMode ? ppStart : state.applied;

    const { cohort, windowDays, premiumFilterDropped } = matchCohort(DATA.cases, {
      refDate: start, optType: state.type, premium,
      dateField: ppMode ? 'pp_start' : 'date_applied',
    });
    const obs = buildObservations(cohort, { today, staleCap: DATA.stale_cutoff_days, mode: ppMode ? 'pp' : 'applied' });

    // Empty-cohort guard (contract warning 2)
    if (cohort.length === 0) {
      const out = $('#calc-out');
      out.replaceChildren(el('p', 'muted',
        'No comparable cases found in data — try different dates/type.'));
      renderSimilar(state, today);
      return;
    }

    const events = obs.filter(o => o.event).map(o => o.t);
    const naive = naivePercentiles(events, [0.1, 0.5, 0.9]);
    const curve = kmCurve(obs);
    const elapsed = daysBetween(start, today);
    const censShare = obs.length ? (obs.length - events.length) / obs.length : 0;

    const dateOf = (d) => d == null ? 'not reached in data' : `${addDays(start, d)} (day ${d})`;
    const condOf = (p) => {
      const t = kmConditionalQuantile(curve, elapsed, p);
      return t == null ? 'not reached in data' : `${addDays(start, t)} (${t - elapsed} more days)`;
    };

    const rows = [
      ['Best case (p10)', dateOf(naive?.p10), dateOf(kmQuantile(curve, 0.1))],
      ['Typical (median)', dateOf(naive?.p50), dateOf(kmQuantile(curve, 0.5))],
      ['Worst case (p90)', dateOf(naive?.p90), dateOf(kmQuantile(curve, 0.9))],
      [`Given you've waited ${elapsed}d — median`, '', condOf(0.5)],
      [`Given you've waited ${elapsed}d — p90`, '', condOf(0.9)],
    ];
    const out = $('#calc-out');
    out.replaceChildren();
    out.append(el('p', 'muted',
      `${ppMode ? 'Premium clock from ' + ppStart : 'Regular clock from ' + state.applied}` +
      ` · cohort n=${cohort.length} (±${windowDays}d${premiumFilterDropped ? ', premium filter dropped' : ''})` +
      ` · ${Math.round(censShare * 100)}% still pending (censored)`));
    if (ppMode) out.append(el('p', null,
      `USCIS premium 30-business-day deadline: ${addBusinessDays(ppStart, 30)} (weekends skipped, federal holidays not)`));
    const tbl = el('table');
    tbl.innerHTML = '<tr><th></th><th>Naive (approved only)</th><th>Survival-adjusted</th></tr>';
    for (const [label, a, b] of rows) {
      const tr = el('tr');
      tr.innerHTML = `<td>${label}</td><td>${a}</td><td>${b}</td>`;
      tbl.append(tr);
    }
    out.append(tbl);
    renderSimilar(state, today);
  }
};

function renderSimilar(state, today) {
  const premium = state.ppstart || !!state.pp;
  const sims = DATA.cases
    .filter(c => good(c) && c.date_applied && c.opt_type === state.type && c.premium === premium
      && Math.abs(daysBetween(state.applied, c.date_applied)) <= 14)
    .sort((a, b) => Math.abs(daysBetween(state.applied, a.date_applied)) - Math.abs(daysBetween(state.applied, b.date_applied)))
    .slice(0, 50);
  const out = $('#similar-out');
  if (!sims.length) { out.textContent = 'No cases within ±14 days with same type/premium.'; return; }
  const tbl = el('table');
  tbl.innerHTML = '<tr><th>Applied</th><th>Biometrics</th><th>PP upgrade</th><th>Approved</th><th>Card</th><th>Days</th><th>Status</th><th>Link</th></tr>';
  for (const c of sims) {
    const days = c.date_approved ? daysBetween(c.date_applied, c.date_approved) : daysBetween(c.date_applied, today);
    const status = c.date_approved ? 'approved' : ((c.flags || []).includes('stale_pending') ? 'stale' : 'pending');
    const tr = el('tr');
    if (status === 'approved') tr.className = 'ok';
    tr.innerHTML = `<td>${c.date_applied}</td><td>${c.biometrics_date ?? '—'}</td><td>${c.pp_upgrade_date ?? '—'}</td>` +
      `<td>${c.date_approved ?? '—'}</td><td>${c.card_received ?? c.card_produced ?? '—'}</td>` +
      `<td>${days}${c.date_approved ? '' : '+'}</td><td>${status}</td>` +
      `<td>${c.reddit_url ? `<a href="${c.reddit_url}" target="_blank">reddit</a>` : '—'}</td>`;
    tbl.append(tr);
  }
  out.replaceChildren(tbl);
}

// ---------- Trends & aggregates ----------
function isoWeek(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day + 3);
  const firstThu = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const fday = (firstThu.getUTCDay() + 6) % 7;
  firstThu.setUTCDate(firstThu.getUTCDate() - fday + 3);
  const week = 1 + Math.round((d - firstThu) / (7 * 86400000));
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function median(arr) { const s = [...arr].sort((a, b) => a - b); return s.length ? quantileSorted(s, 0.5) : null; }

const CHART_OPTS = { plugins: { legend: { labels: { color: '#cbd5e1' } } }, scales: { x: { ticks: { color: '#94a3b8' } }, y: { ticks: { color: '#94a3b8' } } } };

window.renderTrendsAll = function renderTrendsAll() {
  // Destroy existing charts before re-creating (prevents stacking on Refresh)
  if (window.Chart) [...document.querySelectorAll('canvas')].forEach(c => Chart.getChart(c)?.destroy());

  const cases = DATA.cases.filter(c => good(c) && c.date_applied);
  const today = DATA.today || TODAY;

  // 1. Weekly application-cohort median (only cohorts >= 70% resolved)
  const byWeek = new Map();
  for (const c of cases) {
    const w = isoWeek(c.date_applied);
    if (!byWeek.has(w)) byWeek.set(w, []);
    byWeek.get(w).push(c);
  }
  const weeks = [...byWeek.keys()].sort();
  const cohortMedians = weeks.map(w => {
    const list = byWeek.get(w);
    const resolved = list.filter(c => c.date_approved);
    if (list.length < 5 || resolved.length / list.length < 0.7) return null;
    return median(resolved.map(c => daysBetween(c.date_applied, c.date_approved)).filter(d => d >= 0));
  });
  new Chart($('#trend-cohort'), { type: 'line', options: CHART_OPTS,
    data: { labels: weeks, datasets: [{ label: 'median days to approval by application week (≥70% resolved)', data: cohortMedians, borderColor: '#34d399', spanGaps: true }] } });

  // 2. Approvals per week
  const apprWeeks = new Map();
  for (const c of cases) if (c.date_approved) {
    const w = isoWeek(c.date_approved);
    apprWeeks.set(w, (apprWeeks.get(w) || 0) + 1);
  }
  const aw = [...apprWeeks.keys()].sort();
  new Chart($('#trend-volume'), { type: 'bar', options: CHART_OPTS,
    data: { labels: aw, datasets: [{ label: 'approvals per week', data: aw.map(w => apprWeeks.get(w)), backgroundColor: '#60a5fa' }] } });

  // 3. Premium vs regular median gap per week (weeks with >=5 of each)
  const gap = weeks.map(w => {
    const list = byWeek.get(w).filter(c => c.date_approved);
    const pp = list.filter(c => c.premium).map(c => daysBetween(c.date_applied, c.date_approved));
    const reg = list.filter(c => !c.premium).map(c => daysBetween(c.date_applied, c.date_approved));
    return pp.length >= 5 && reg.length >= 5 ? median(reg) - median(pp) : null;
  });
  new Chart($('#trend-gap'), { type: 'line', options: CHART_OPTS,
    data: { labels: weeks, datasets: [{ label: 'regular minus premium median days (per application week)', data: gap, borderColor: '#f59e0b', spanGaps: true }] } });

  // Funnel
  const stage = (from, to) => median(DATA.cases
    .filter(c => good(c) && c[from] && c[to] && daysBetween(c[from], c[to]) >= 0)
    .map(c => daysBetween(c[from], c[to])));
  $('#funnel-out').replaceChildren(
    card(fmt(stage('date_applied', 'biometrics_date')), 'applied → biometrics (median d)'),
    card(fmt(stage('biometrics_date', 'date_approved')), 'biometrics → approved'),
    card(fmt(stage('date_approved', 'card_produced')), 'approved → card produced'),
    card(fmt(stage('card_produced', 'card_received')), 'produced → received'),
  );

  // RFE / NOID
  const withRfe = cases.filter(c => c.rfe_date);
  const apprRfe = withRfe.filter(c => c.date_approved).map(c => daysBetween(c.date_applied, c.date_approved));
  const apprNoRfe = cases.filter(c => !c.rfe_date && c.date_approved).map(c => daysBetween(c.date_applied, c.date_approved));
  $('#rfe-out').replaceChildren(
    card(`${(100 * withRfe.length / cases.length).toFixed(1)}%`, 'RFE rate'),
    card(fmt(median(apprRfe)), 'median days with RFE'),
    card(fmt(median(apprNoRfe)), 'median days without RFE'),
    card(apprRfe.length && apprNoRfe.length ? `+${fmt(median(apprRfe) - median(apprNoRfe))}` : '—', 'RFE penalty (days)'),
  );

  // Service centers
  const byCenter = new Map();
  for (const c of cases) if (c.service_center && c.date_approved) {
    if (!byCenter.has(c.service_center)) byCenter.set(c.service_center, []);
    byCenter.get(c.service_center).push(daysBetween(c.date_applied, c.date_approved));
  }
  const ct = el('table');
  ct.innerHTML = '<tr><th>Center</th><th>n approved</th><th>Median days</th></tr>';
  for (const [name, ds] of [...byCenter.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const tr = el('tr');
    tr.innerHTML = `<td>${name}</td><td>${ds.length}</td><td>${fmt(median(ds))}</td>`;
    ct.append(tr);
  }
  $('#centers-out').replaceChildren(byCenter.size ? ct : el('p', 'muted', 'No service-center data.'));

  // Weekday
  const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const wd = [0, 0, 0, 0, 0, 0, 0];
  for (const c of cases) if (c.date_approved) wd[new Date(c.date_approved + 'T00:00:00Z').getUTCDay()]++;
  new Chart($('#weekday-chart'), { type: 'bar', options: CHART_OPTS,
    data: { labels: names, datasets: [{ label: 'approvals by weekday', data: wd, backgroundColor: '#a78bfa' }] } });
};
