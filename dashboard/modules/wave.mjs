/**
 * dashboard/modules/wave.mjs
 * "Approval wave" — the two views the raw percentiles hide:
 *
 * 1. REGULAR: approvals are roughly FIFO by applied date, so the applied dates
 *    behind the last 14 days of approvals mark the FRONT of the queue
 *    ("filers who applied around Mar 19 are getting approved now"), plus a
 *    weekly cohort table showing when each applied-week started landing.
 *
 * 2. PREMIUM: the 30-business-day promise runs from the CLOCK START
 *    (biometrics for premium-from-start, upgrade date for upgrades), not the
 *    applied date. Histogram of business days clock→approval; nearly all mass
 *    lands at BD ≤30. The tail beyond 30 = fee refunded, still prioritized.
 *
 * MODULE CONTRACT: export render(ctx); onCaseChange(ctx, myCase) re-renders
 * the personal position line. Renders into #wave (div #wave-out).
 * Defensive: tolerates missing data/sections; never throws.
 */

let _histChart = null;

function destroyHist() {
  try {
    if (_histChart) { _histChart.destroy(); _histChart = null; }
    const cv = document.getElementById('pp-bd-hist');
    if (cv && window.Chart) window.Chart.getChart(cv)?.destroy();
  } catch { /* chart teardown must never break a render */ }
}

function colors() {
  const v = (name, fb) => {
    try { return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fb; }
    catch { return fb; }
  };
  return {
    axis: v('--muted', '#8b97b0'),
    legend: v('--text', '#e8edf7'),
    grid: v('--border', 'rgba(140, 165, 220, 0.14)'),
    accent: v('--accent', '#22d3ee'),
    good: v('--good', '#34d399'),
    warn: v('--warn', '#fbbf24'),
    tooltipBg: v('--tooltip-bg', 'rgba(7, 10, 19, 0.92)'),
  };
}

export function render(ctx) {
  const { el, fmt, wrapTable, data } = ctx;
  const { waveFront, weeklyCohorts, ppClockDist, bdHistogram } = ctx.wave || {};
  const out = document.getElementById('wave-out');
  if (!out || !waveFront) return;

  destroyHist();
  out.replaceChildren();

  const cases = Array.isArray(data?.cases) ? data.cases : [];
  const today = ctx.today;

  // ---- 1. Regular wave front ------------------------------------------------
  out.append(el('h3', null, 'Regular processing — where the queue front is now'));

  const front = waveFront(cases, { today, windowDays: 14 });
  if (!front) {
    out.append(el('p', 'muted', 'No regular-processing approvals reported in the last 14 days.'));
  } else {
    const callout = el('p');
    const calloutStrong = el('strong', null,
      `Approvals in the last ${front.windowDays} days went to filers who applied ` +
      `${front.appliedP25} – ${front.appliedP75}`);
    callout.append(
      calloutStrong,
      el('span', 'muted', ` (median ${front.appliedP50} · middle 50% of ${front.n} approvals; full range ${front.appliedMin} → ${front.appliedMax})`),
    );
    out.append(callout);

    if (ctx.explain) {
      ctx.explain(calloutStrong, () => ({
        title: 'How the wave front is located',
        lines: [
          ['window', `last ${front.windowDays} days of reported approvals`],
          ['regular-processing approvals in window', String(front.n)],
          ['their applied dates, p25 → p75', `${front.appliedP25} → ${front.appliedP75}`],
          ['median applied date', front.appliedP50],
          ['full range', `${front.appliedMin} → ${front.appliedMax}`],
        ],
        note: 'Regular processing is roughly first-in-first-out by applied date, so the applied dates behind fresh approvals mark where the queue front is right now.',
      }));
    }
  }

  // Personal position line (filled by onCaseChange).
  const youLine = el('p', 'muted');
  youLine.id = 'wave-you';
  out.append(youLine);

  // Weekly cohort table.
  out.append(buildWeeklyTable(ctx, cases));

  // ---- 2. Premium clock -------------------------------------------------------
  out.append(el('h3', null, 'Premium processing — the 30-business-day clock'));
  out.append(el('p', 'muted',
    'Premium is a 30-business-day promise from the CLOCK START — biometrics if you filed premium, ' +
    'the upgrade date if you upgraded later — not from your applied date. Measured on that clock:'));

  const dist = ppClockDist(cases);
  if (!dist) {
    out.append(el('p', 'muted', 'No premium approvals with a known clock start yet.'));
  } else {
    const cards = el('div', 'cards');
    const card = (cls, value, label) => {
      const c = el('div', `card ${cls}`.trim());
      c.append(el('div', 'value', value), el('div', 'label', label));
      return c;
    };
    const cWithin = card('good', `${dist.within30}%`, `approved within 30 business days (n=${dist.n})`);
    const cMedian = card('', `${fmt(dist.p50)} BD`, 'median business days on the clock');
    const cOver = card('warn', `${dist.over30}`, 'ran past BD 30 — fee refunded, still prioritized');
    cards.append(cWithin, cMedian, cOver);
    out.append(cards);

    // Every premium-clock number defends itself on click.
    if (ctx.explain) {
      const le30 = dist.values.all.filter(v => v <= 30).length;
      ctx.explain(cWithin, () => ({
        title: `How ${dist.within30}% was computed`,
        lines: [
          ['approved premium cases with a known clock start', String(dist.n)],
          ['clock start', 'biometrics (filed premium) / upgrade date'],
          ['approved within 30 business days', String(le30)],
          ['share', `${le30} ÷ ${dist.n} = ${dist.within30}%`],
        ],
        note: 'Business days skip weekends and US federal holidays — the same clock USCIS runs.',
      }));
      ctx.explain(cMedian, () => ({
        title: 'Median business days on the clock',
        lines: [
          ['measured cases', String(dist.n)],
          ['premium from start (clock = biometrics)', String(dist.values.initial.length)],
          ['upgraded later (clock = upgrade date)', String(dist.values.upgraded.length)],
          ['median (p50)', `${fmt(dist.p50)} BD`],
          ['p90', `${fmt(dist.p90)} BD`],
        ],
        note: 'Half of premium cases resolved by this business day; 90% by the p90.',
      }));
      ctx.explain(cOver, () => ({
        title: 'Cases past business day 30',
        lines: [
          ['total measured', String(dist.n)],
          ['past BD 30', String(dist.over30)],
          ['longest seen', `${fmt(dist.max)} BD`],
        ],
        note: 'Past BD 30 USCIS refunds the premium fee, but the case keeps priority handling — these still resolve.',
      }));
    }
    buildHistChart(ctx, out, dist, bdHistogram);
    out.append(el('p', 'muted',
      'Past business day 30 USCIS refunds the premium fee but the case keeps priority handling — ' +
      `the small tail above 30 BD (max seen: ${fmt(dist.max)} BD) is exactly those cases.`));
  }

  // Fill personal line if a case is already set (e.g. restored from storage).
  onCaseChange(ctx, ctx.state?.myCase || null);
}

function buildWeeklyTable(ctx, cases) {
  const { el, wrapTable, fmt } = ctx;
  const { weeklyCohorts } = ctx.wave;
  const rows = weeklyCohorts(cases, { minN: 5, maxWeeks: 14 });
  if (!rows.length) return el('p', 'muted', 'Not enough regular cases to build weekly cohorts.');

  const tbl = el('table');
  tbl.innerHTML =
    '<tr><th>Applied week</th><th>Cases</th><th>Approved</th><th>%</th>' +
    '<th>First approval</th><th>Latest approval</th></tr>';
  for (const r of rows) {
    const tr = el('tr');
    // The wave front: weeks that have STARTED getting approvals but are far
    // from done — the most useful rows to watch.
    if (r.approved > 0 && r.pct <= 30) tr.className = 'ok';
    tr.append(
      el('td', null, r.week),
      el('td', null, String(r.n)),
      el('td', null, String(r.approved)),
      el('td', null, `${r.pct}%`),
      el('td', null, r.firstApproval || '—'),
      el('td', null, r.lastApproval || '—'),
    );
    tbl.append(tr);
  }
  const host = el('div');
  host.append(wrapTable(tbl));
  host.append(el('p', 'muted',
    'Highlighted rows = the wave front: weeks whose approvals just started landing. ' +
    'Percentages understate reality — many people never update after approval.'));
  return host;
}

function buildHistChart(ctx, out, dist, bdHistogram) {
  const { el, prefersReducedMotion } = ctx;
  if (!window.Chart) return;

  const cap = 35;
  const hi = bdHistogram(dist.values.initial, cap);
  const hu = bdHistogram(dist.values.upgraded, cap);
  const labels = [];
  for (let i = 0; i <= cap; i++) labels.push(String(i));
  labels.push(`>${cap}`);
  const seriesOf = (h) => [...h.bins, h.over];

  const box = el('div', 'chart-box');
  const canvas = document.createElement('canvas');
  canvas.id = 'pp-bd-hist';
  box.append(canvas);
  out.append(box);

  const C = colors();
  try {
    _histChart = new window.Chart(canvas, {
      type: 'bar',
      data: {
        labels,
        datasets: [
          { label: 'premium from start (clock = biometrics)', data: seriesOf(hi), backgroundColor: C.accent, stack: 's' },
          { label: 'upgraded later (clock = upgrade date)', data: seriesOf(hu), backgroundColor: C.warn, stack: 's' },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: prefersReducedMotion() ? false : { duration: 600 },
        plugins: {
          legend: { labels: { color: C.legend, boxWidth: 12, usePointStyle: true } },
          tooltip: {
            backgroundColor: C.tooltipBg,
            callbacks: {
              title: (items) => items.length ? `business day ${items[0].label}` : '',
            },
          },
        },
        scales: {
          x: {
            stacked: true,
            title: { display: true, text: 'business days from premium clock start to approval', color: C.axis },
            ticks: {
              color: (c) => (labels[c.index] === '30' ? C.good : C.axis),
              maxRotation: 0,
              autoSkip: true,
              maxTicksLimit: 13,
            },
            grid: { display: false },
          },
          y: {
            stacked: true,
            title: { display: true, text: 'approvals', color: C.axis },
            ticks: { color: C.axis, precision: 0 },
            grid: { color: C.grid },
          },
        },
      },
    });
  } catch (err) {
    _histChart = null;
    box.replaceChildren(el('p', 'muted', 'Chart could not be rendered — the numbers above still stand.'));
    console.error('[wave] histogram error:', err);
  }
}

export function onCaseChange(ctx, myCase) {
  const line = document.getElementById('wave-you');
  if (!line) return;
  line.textContent = '';
  if (!myCase || !myCase.applied) return;

  // Past the approval? The queue is no longer their story — say so instead of
  // suggesting case inquiries to someone already holding a decision.
  if (myCase.journeyStage && myCase.journeyStage !== 'pending') {
    line.className = 'muted';
    line.textContent = myCase.received
      ? 'You: card in hand — your journey is done. This chart is for the folks still in the queue. 💙'
      : `You: approved${myCase.approved ? ` on ${myCase.approved}` : ''} — the wave is behind you now; your card countdown lives in "My journey".`;
    return;
  }

  const { data, fmt } = ctx;
  const cases = Array.isArray(data?.cases) ? data.cases : [];
  const { waveFront, wavePosition, ppClockDist } = ctx.wave;
  const { businessDaysBetween } = ctx.dates;

  if (myCase.premium) {
    // Premium: where they are on the 30-BD clock.
    const bd = businessDaysBetween && myCase.ppStart
      ? businessDaysBetween(myCase.ppStart, ctx.today) : null;
    const dist = ppClockDist(cases);
    if (bd != null && dist) {
      line.textContent =
        `You: business day ${bd} of 30 on your premium clock (started ${myCase.ppStart}). ` +
        `${dist.within30}% of premium cases were approved by BD 30; median BD ${fmt(dist.p50)}.`;
      line.className = bd > 30 ? 'muted warn-text' : 'muted';
    }
    return;
  }

  const front = waveFront(cases, { today: ctx.today, windowDays: 14 });
  const pos = wavePosition(front, myCase.applied);
  if (!pos) return;
  const d = Math.abs(pos.deltaDays);
  if (pos.position === 'ahead') {
    line.textContent =
      `You applied ${myCase.applied} — about ${d} day${d === 1 ? '' : 's'} of queue ahead of you before the wave front (${front.appliedP50}) reaches your date.`;
  } else if (pos.position === 'at') {
    line.textContent =
      `You applied ${myCase.applied} — the approval wave is AT your date right now (front ≈ ${front.appliedP50}). Approvals for your cohort are landing this week.`;
  } else {
    line.textContent =
      `You applied ${myCase.applied} — the wave front (≈ ${front.appliedP50}) has moved past your date by ~${d} days. If you're still pending, consider a case inquiry or premium upgrade.`;
  }
}
