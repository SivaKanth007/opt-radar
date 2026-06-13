/**
 * dashboard/app.js — orchestrator.
 *
 * Loads data, builds the shared ctx, and renders every feature module against
 * it. Modules are self-contained (dashboard/modules/*.mjs) and follow the
 * MODULE CONTRACT: export render(ctx); optionally onCaseChange(ctx, myCase).
 *
 * Cache-busting: module/import specifiers carry ?v=__BUILD__. On GitHub Pages a
 * CI step replaces __BUILD__ with the run id so browsers refetch on every deploy.
 * Locally, serve.mjs ignores the query string, so the literal token resolves to
 * the real file — harmless.
 */

import {
  $, $$, el, fmt, pct, wrapTable, countUp, ring, toast, confetti, prefersReducedMotion,
} from './modules/util.mjs?v=__BUILD__';

import { daysBetween, addDays, localToday, parseDate } from '../lib/dates.mjs?v=__BUILD__';
import { addBusinessDays } from '../lib/holidays.mjs?v=__BUILD__'; // holiday-aware (weekends + US federal holidays)
import * as stats from '../lib/stats.mjs?v=__BUILD__';
import * as cohort from '../lib/cohort.mjs?v=__BUILD__';

import * as headline   from './modules/headline.mjs?v=__BUILD__';
import * as live       from './modules/cheer.mjs?v=__BUILD__';
import * as timeline   from './modules/timeline.mjs?v=__BUILD__'; // calculator + similar cases
import * as trends     from './modules/trends.mjs?v=__BUILD__';
import * as approvals  from './modules/approvals.mjs?v=__BUILD__';
import * as calendars  from './modules/calendars.mjs?v=__BUILD__';
import * as aggregates from './modules/aggregates.mjs?v=__BUILD__';
import * as panels     from './modules/panels.mjs?v=__BUILD__';

// Render order = visual order down the page. Each entry is one module's render().
const MODULES = [
  ['headline', headline],
  ['live', live],
  ['timeline', timeline],
  ['trends', trends],
  ['approvals', approvals],
  ['calendars', calendars],
  ['aggregates', aggregates],
  ['panels', panels],
];

// Tiny event bus. caseChange → cheer's personal hope panel + projection toasts.
const bus = {
  _m: {},
  on(e, f) { (this._m[e] ||= []).push(f); },
  emit(e, p) { (this._m[e] || []).forEach(f => { try { f(p); } catch (err) { console.error('[bus]', e, err); } }); },
};

const state = { myCase: null };
let ctx = null;

// Wire the bus ONCE (outside load) so re-renders never stack listeners.
// timeline.compute() renders its own "similar" panel directly and emits
// 'caseChange'; cheer reacts with the hope panel + toasts.
bus.on('caseChange', (mc) => { if (ctx) live.onCaseChange(ctx, mc); });

function buildCtx(data, diff) {
  return {
    data, diff,
    today: (data && data.today) || localToday(),
    state, bus,
    // util helpers
    $, $$, el, fmt, pct, wrapTable, countUp, ring, toast, confetti, prefersReducedMotion,
    // lib namespaces (addBusinessDays is the holiday-aware one)
    dates: { daysBetween, addDays, addBusinessDays, localToday, parseDate },
    stats,
    cohort,
  };
}

function updateMeta(data) {
  const meta = $('#meta');
  if (!meta) return;
  meta.replaceChildren();
  const dot = el('span', 'pulse-dot');
  dot.style.marginRight = '8px';
  const stamp = data?.fetched_at ? data.fetched_at.slice(0, 16).replace('T', ' ') + ' UTC' : 'unknown';
  meta.append(dot, document.createTextNode(`live · data as of ${stamp} · ${data?.cases?.length ?? 0} cases`));
}

function updateBanner(data) {
  const banner = $('#stale-banner');
  if (!banner) return;
  const bad = Object.entries(data?.sources || {}).filter(([k, v]) => v && v.ok === false && k !== 'reddit');
  if (bad.length) {
    banner.classList.remove('hidden');
    banner.textContent = '⚠ Source issue: ' + bad.map(([k, v]) =>
      `${k}${v.fallback ? ` (showing snapshot from ${v.fallback_date || 'an earlier day'})` : ''}`).join(', ');
  } else {
    banner.classList.add('hidden');
  }
}

async function load() {
  let data = null, diff = null;
  try {
    const [d, f] = await Promise.all([
      fetch('../data/latest.json?v=' + Date.now()).then(r => r.ok ? r.json() : null),
      fetch('../data/diff.json?v=' + Date.now()).then(r => r.ok ? r.json() : null).catch(() => null),
    ]);
    data = d; diff = f;
  } catch (err) {
    console.error('[load] fetch failed', err);
  }

  if (!data || !Array.isArray(data.cases)) {
    const main = $('main');
    if (main) main.replaceChildren(el('section', null, ''),);
    const sec = $('main section');
    if (sec) {
      sec.append(el('h2', null, 'No data yet'));
      const p = el('p', 'muted');
      p.append(document.createTextNode('Run '), el('code', null, 'node fetch-data.mjs'), document.createTextNode(' to pull the latest cases, then reload.'));
      sec.append(p);
    }
    return;
  }

  ctx = buildCtx(data, diff);
  updateMeta(data);
  updateBanner(data);

  // Render each module independently — one module throwing must not blank the page.
  for (const [name, mod] of MODULES) {
    try {
      if (mod && typeof mod.render === 'function') mod.render(ctx);
    } catch (err) {
      console.error(`[render:${name}]`, err);
    }
  }
}

// Refresh button (local only — the static host has no /api/refresh server).
const refreshBtn = $('#refresh-btn');
if (refreshBtn) {
  if (location.hostname.endsWith('github.io')) {
    refreshBtn.classList.add('hidden');
  } else {
    refreshBtn.addEventListener('click', async () => {
      refreshBtn.disabled = true;
      const label = refreshBtn.textContent;
      refreshBtn.textContent = 'Refreshing…';
      try {
        const r = await fetch('/api/refresh', { method: 'POST' });
        if (!r.ok) {
          const banner = $('#stale-banner');
          if (banner) { banner.classList.remove('hidden'); banner.textContent = `⚠ Refresh failed (HTTP ${r.status}) — showing previous data`; }
        } else {
          await load();
        }
      } catch (e) {
        const banner = $('#stale-banner');
        if (banner) { banner.classList.remove('hidden'); banner.textContent = `⚠ Refresh failed: ${e.message} — showing previous data`; }
      } finally {
        refreshBtn.disabled = false;
        refreshBtn.textContent = label;
      }
    });
  }
}

// Keep long-lived tabs fresh.
setInterval(load, 30 * 60 * 1000);

load();
