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
