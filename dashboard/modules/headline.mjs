/**
 * dashboard/modules/headline.mjs
 * Top-of-page headline: animated stat cards + the global applied→approved
 * percentile ruler (naive vs survival-adjusted) + a live freshness line.
 *
 * Renders into section#headline. Pure browser ESM — no Node imports.
 * Follows the MODULE CONTRACT: export render(ctx).
 *
 * Helpers from ctx: el, fmt, countUp (numbers), dates.daysBetween/addDays,
 * stats.naivePercentiles/kmCurve/kmQuantile/quantileSorted, cohort.buildObservations.
 *
 * Defensive: tolerates null/missing fields and empty data — never throws.
 */

const NUM = (n) => (typeof n === 'number' && isFinite(n)) ? n : null;

/** good = no 'impossible_dates' flag (matches the headline data-story contract). */
function isGood(c) {
  return c && !((c.flags || []).includes('impossible_dates'));
}

/** Human-friendly stamp for an ISO timestamp, e.g. "2026-06-12 17:03 UTC". */
function humanStamp(iso) {
  if (!iso || typeof iso !== 'string') return 'unknown';
  // Trust the source ISO; show the date + minute portion without re-parsing risk.
  const m = iso.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/);
  if (m) return `${m[1]} ${m[2]} UTC`;
  const d = iso.match(/^(\d{4}-\d{2}-\d{2})/);
  return d ? d[1] : iso;
}

/** Freshness state from age in hours → pulse-dot modifier + words. */
function freshness(fetchedIso, today) {
  if (!fetchedIso) return { cls: 'stale', word: 'freshness unknown' };
  const t = Date.parse(fetchedIso);
  if (!isFinite(t)) return { cls: 'stale', word: 'freshness unknown' };
  const ageH = (Date.now() - t) / 3.6e6;
  if (!isFinite(ageH) || ageH < 0) return { cls: '', word: 'live' };
  if (ageH <= 26) return { cls: '', word: 'live' };
  if (ageH <= 24 * 3) return { cls: 'warn', word: 'a little behind' };
  return { cls: 'stale', word: 'stale' };
}

export function render(ctx) {
  const {
    data, today,
    el, fmt, countUp, prefersReducedMotion,
    dates, stats, cohort,
  } = ctx;

  const root = document.getElementById('headline');
  if (!root) return; // section missing — nothing to do

  root.replaceChildren();
  const eyebrow = el('span', 'eyebrow', 'The big picture');
  root.append(eyebrow, el('h2', null, 'OPT approval pulse'));

  const cases = Array.isArray(data?.cases) ? data.cases : [];
  const refToday = today || data?.today || (dates.localToday && dates.localToday()) || null;

  // ---- Hero stat fill (launch-portal hero in index.html; ids optional) ----
  // Defensive: skip silently when the hero isn't present (e.g. older html).
  {
    const heroCases = document.getElementById('hero-stat-cases');
    const heroApproved = document.getElementById('hero-stat-approved');
    const heroWeek = document.getElementById('hero-stat-week');
    const goodAll = cases.filter(isGood);
    if (heroCases) countUp(heroCases, goodAll.length);
    if (heroApproved) countUp(heroApproved, goodAll.filter(c => c.date_approved).length);
    if (heroWeek && refToday) {
      // Approvals dated within the last 7 days INCLUSIVE of today: [today-6, today].
      const weekAgo = dates.addDays ? dates.addDays(refToday, -6) : null;
      const n = weekAgo
        ? goodAll.filter(c => c.date_approved && c.date_approved >= weekAgo && c.date_approved <= refToday).length
        : 0;
      countUp(heroWeek, n);
    }
  }

  // ---- Derived sets ------------------------------------------------------
  // Approved + "good" + non-outlier → the percentile cohort.
  const approvedForPct = cases.filter(c =>
    isGood(c) && c.date_applied && c.date_approved
    && !((c.flags || []).includes('outlier_duration')));

  const durations = approvedForPct
    .map(c => dates.daysBetween(c.date_applied, c.date_approved))
    .filter(d => Number.isFinite(d) && d >= 0);

  // "approved" headline count: all good approved (outliers still count as approved).
  const approvedAll = cases.filter(c => isGood(c) && c.date_approved);
  const pending = cases.filter(c => isGood(c) && c.date_applied && !c.date_approved);

  // Earliest approval THIS CYCLE. Same consistency rule as the calendars: the
  // cycle starts at the first month holding >= max(10, 10% of the busiest
  // month's) applications. Keeps a lone prior-year straggler (real data, kept
  // in the stats) from squatting on this display card.
  const byMonth = new Map();
  for (const c of cases) {
    if (isGood(c) && c.date_applied) {
      const m = c.date_applied.slice(0, 7);
      byMonth.set(m, (byMonth.get(m) || 0) + 1);
    }
  }
  const peak = Math.max(1, ...byMonth.values());
  const cycleStart = [...byMonth.keys()].sort()
    .find(m => byMonth.get(m) >= Math.max(10, peak * 0.1)) || '';
  // Two-month grace before the ramp: early filers (Nov/Dec for a Jan ramp) are
  // this cycle too; a prior-YEAR straggler stays excluded.
  const graceStart = (() => {
    if (!cycleStart) return '';
    const [y, m] = cycleStart.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1 - 2, 1)).toISOString().slice(0, 7);
  })();
  let earliest = null;
  for (const c of approvedAll) {
    if (!c.date_approved) continue;
    if (c.date_applied && c.date_applied.slice(0, 7) < graceStart) continue; // prior-cycle straggler
    if (earliest === null || c.date_approved < earliest) earliest = c.date_approved;
  }

  // Median pending wait so far: days from applied → today for still-pending good cases.
  const pendAges = pending
    .map(c => dates.daysBetween(c.date_applied, refToday))
    .filter(d => Number.isFinite(d) && d >= 0)
    .sort((a, b) => a - b);
  const medianPendWait = pendAges.length ? stats.quantileSorted(pendAges, 0.5) : null;

  // ---- Stat cards --------------------------------------------------------
  const grid = el('div', 'stat-grid');

  const statCard = (cls, label) => {
    const c = el('div', cls);
    const v = el('div', 'value', '—');
    c.append(v, el('div', 'label', label));
    return { card: c, value: v };
  };

  const cTotal   = statCard('card', 'total cases');
  const cApproved = statCard('card good', 'approved');
  const cPending = statCard('card', 'pending');
  const cEarliest = statCard('card', 'earliest approval (this cycle)');
  const cWait    = statCard('card warn', 'median pending wait so far (days)');

  grid.append(cTotal.card, cApproved.card, cPending.card, cEarliest.card, cWait.card);
  root.append(grid);

  // Numeric count-ups (earliest is a date string, set directly).
  // Count only good cases — matches the hero and every other panel's filter.
  countUp(cTotal.value, cases.filter(isGood).length);
  countUp(cApproved.value, approvedAll.length);
  countUp(cPending.value, pending.length);
  cEarliest.value.textContent = earliest || '—';
  if (medianPendWait == null) cWait.value.textContent = '—';
  else countUp(cWait.value, medianPendWait, { suffix: 'd' });

  // ---- Percentile ruler --------------------------------------------------
  const rulerSection = el('div', null);
  rulerSection.append(el('h3', null, 'How long applied → approved takes (all approved cases)'));

  const naive = durations.length
    ? (stats.naivePercentiles(durations, [0.1, 0.5, 0.9]) || {})
    : {};
  const p10 = NUM(naive.p10), p50 = NUM(naive.p50), p90 = NUM(naive.p90);

  // Survival-adjusted p50 over ALL good cases (mode 'applied', staleCap from data).
  const allGood = cases.filter(isGood);
  let survivalP50 = null;
  if (allGood.length) {
    const obs = cohort.buildObservations(allGood, {
      today: refToday,
      staleCap: data?.stale_cutoff_days,
      mode: 'applied',
    });
    const curve = stats.kmCurve(obs);
    survivalP50 = NUM(stats.kmQuantile(curve, 0.5));
  }

  if (p50 == null && survivalP50 == null) {
    rulerSection.append(el('p', 'muted', 'Not enough approved cases yet to chart timing — check back after the next refresh.'));
    root.append(rulerSection);
  } else {
    // Track domain: 0 → max(p90, survival p50) with ~12% headroom so the
    // rightmost marker never sits flush on the edge.
    const maxDay = Math.max(p90 ?? 0, survivalP50 ?? 0, p50 ?? 0, 1);
    const domain = maxDay * 1.12;
    const xPct = (day) => Math.max(0, Math.min(100, (day / domain) * 100));

    const ruler = el('div', 'ruler');
    const track = el('div', 'ruler-track');

    // Fill spans up to the typical (naive p50) — the "you'll likely be here" zone.
    if (p50 != null) {
      const fill = el('div', 'ruler-fill');
      fill.style.width = prefersReducedMotion && prefersReducedMotion() ? `${xPct(p50)}%` : '0%';
      track.append(fill);
      if (!(prefersReducedMotion && prefersReducedMotion())) {
        requestAnimationFrame(() => requestAnimationFrame(() => { fill.style.width = `${xPct(p50)}%`; }));
      }
    }

    // Ticks: best / typical / worst (naive percentiles), each with day + projected calendar date.
    const projDate = (day) => {
      if (!refToday || day == null) return '';
      const d = dates.addDays(refToday, Math.round(day));
      return d ? `≈ ${d}` : '';
    };
    const addTick = (day, name) => {
      if (day == null) return;
      const left = `${xPct(day)}%`;
      const tick = el('div', 'ruler-tick');
      tick.style.left = left;
      track.append(tick);
      const lbl = el('div', 'ruler-tick-label');
      lbl.style.left = left;
      const proj = projDate(day);
      lbl.textContent = `${name}: ${fmt(day)}d${proj ? '  ' + proj : ''}`;
      track.append(lbl);
    };
    addTick(p10, 'best (p10)');
    addTick(p50, 'typical (p50)');
    addTick(p90, 'worst (p90)');

    // Markers: naive p50 (above the bar) and survival-adjusted p50 (clearly labeled).
    const addMarker = (day, label) => {
      if (day == null) return;
      const left = `${xPct(day)}%`;
      const mk = el('div', 'ruler-marker');
      mk.style.left = left;
      track.append(mk);
      const ml = el('div', 'ruler-marker-label');
      ml.style.left = left;
      ml.textContent = label;
      track.append(ml);
    };
    addMarker(p50, `naive p50 · ${fmt(p50)}d`);
    addMarker(survivalP50, `survival-adj · ${fmt(survivalP50)}d`);

    ruler.append(track);
    rulerSection.append(ruler);

    // Honest explainer — naive is optimistic; survival-adjusted counts those still waiting.
    const note = el('p', 'muted');
    note.append(
      el('strong', null, 'Naive'),
      document.createTextNode(' uses only cases already approved, so it runs optimistic. '),
      el('strong', null, 'Survival-adjusted'),
      document.createTextNode(' also counts everyone still waiting (Kaplan-Meier), so it is the more honest estimate of how long the line really is.'),
    );
    if (p50 != null && survivalP50 != null && survivalP50 > p50) {
      note.append(document.createTextNode(
        ` Right now the survival-adjusted median (${fmt(survivalP50)}d) sits past the naive one (${fmt(p50)}d) — waits are running longer than approved-only stats suggest.`));
    }
    rulerSection.append(note);
    root.append(rulerSection);
  }

  // ---- Live freshness line ----------------------------------------------
  const fresh = freshness(data?.fetched_at, refToday);
  const line = el('p', 'muted');
  line.style.display = 'flex';
  line.style.alignItems = 'center';
  line.style.gap = '8px';
  const dot = el('span', fresh.cls ? `pulse-dot ${fresh.cls}` : 'pulse-dot');
  const txt = el('span', null, `data as of ${humanStamp(data?.fetched_at)} · ${fresh.word}`);
  line.append(dot, txt);
  root.append(line);
}
