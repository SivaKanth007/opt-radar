/**
 * dashboard/modules/cardtrack.mjs — community card logistics block.
 *
 * Renders into #cardtrack-out (inside the merged "My journey" section): the
 * post-approval stage distributions (approved → card produced, produced →
 * delivered) as stat cards + day-by-day histograms. The PERSONAL countdown
 * lives in timeline.mjs now — the journey form's approved/produced/received
 * dates drive it; this block is the community data behind those projections.
 *
 * Data honesty: reporting drops after approval, so every stat carries its n
 * and the caveat is spelled out.
 *
 * MODULE CONTRACT: export render(ctx). Idempotent — charts are destroyed
 * and rebuilt, children replaced, on every render.
 */

const CANVASES = ['card-hist-prod', 'card-hist-recv'];

export function render(ctx) {
  const { el, fmt } = ctx;
  const out = document.getElementById('cardtrack-out');
  if (!out || typeof el !== 'function') return;

  for (const id of CANVASES) {
    const c = document.getElementById(id);
    if (c) window.Chart?.getChart(c)?.destroy();
  }
  out.replaceChildren();

  const stats = ctx.cards?.cardStats?.(ctx.data?.cases || []);
  if (!stats || (!stats.a2p && !stats.a2r)) {
    out.append(el('p', 'muted', 'No card-production reports in the dataset yet.'));
    return;
  }
  const { a2p, p2r, a2r } = stats;

  // ---- headline stat cards ------------------------------------------------
  const cards = el('div', 'cards');
  const stat = (cls, value, label) => {
    const c = el('div', cls ? `card ${cls}` : 'card');
    c.append(el('div', 'value', value), el('div', 'label', label));
    cards.append(c);
    return c;
  };

  if (a2p) {
    const c = stat('good', `${fmt(a2p.p50)} d`, `approved → card produced (median, n=${a2p.n})`);
    ctx.explain?.(c, () => ({
      title: 'Approved → card produced',
      lines: [
        ['cases reporting both dates', String(a2p.n)],
        ['p25 → p75', `${a2p.p25} → ${a2p.p75} days`],
        ['median', `${a2p.p50} days`],
        ['p90', `${a2p.p90} days`],
      ],
      note: 'Card production is mechanical — the spread is tiny compared to adjudication.',
    }));
  }
  if (p2r) {
    const c = stat('', `${fmt(p2r.p50)} d`, `produced → in your mailbox (median, n=${p2r.n})`);
    ctx.explain?.(c, () => ({
      title: 'Produced → delivered',
      lines: [
        ['cases reporting both dates', String(p2r.n)],
        ['p25 → p75', `${p2r.p25} → ${p2r.p75} days`],
        ['median', `${p2r.p50} days`],
        ['p90', `${p2r.p90} days`],
      ],
      note: 'This stage is USPS. Weekends and remote addresses stretch the tail.',
    }));
  }
  if (a2r) {
    const c = stat('', `${fmt(a2r.p90)} d`, `9 in 10 hold the card within (after approval, n=${a2r.n})`);
    ctx.explain?.(c, () => ({
      title: 'Approval → card in hand, end to end',
      lines: [
        ['cases reporting both dates', String(a2r.n)],
        ['median', `${a2r.p50} days`],
        ['p90', `${a2r.p90} days`],
      ],
      note: 'If you are past the p90 with no card, check your USCIS address and consider an e-request.',
    }));
  }
  out.append(cards);

  // ---- two histograms side by side ----------------------------------------
  const grid = el('div', 'ct-grid');
  if (a2p) grid.append(histBlock(ctx, 'card-hist-prod', 'Approved → produced — day by day', a2p, '--accent'));
  if (p2r) grid.append(histBlock(ctx, 'card-hist-recv', 'Produced → delivered — day by day', p2r, '--accent-2'));
  if (grid.childElementCount) out.append(grid);

  out.append(el('p', 'muted',
    `Reporting drops after approval — ${a2p ? a2p.n : 0} of the approved cases report a production date, ` +
    `${a2r ? a2r.n : 0} a delivery date. The stages are mechanical (card printer, then USPS), so even this ` +
    'sample gives stable medians.'));
}

// ---------------------------------------------------------------------------
// histograms
// ---------------------------------------------------------------------------

function histBlock(ctx, canvasId, title, distObj, colorVar) {
  const { el } = ctx;
  const wrap = el('div', 'ct-hist');
  wrap.append(el('h3', null, title));
  const box = el('div', 'chart-box ct-box');
  const canvas = el('canvas');
  canvas.id = canvasId;
  box.append(canvas);
  wrap.append(box);

  if (!window.Chart) { box.replaceChildren(el('p', 'muted', 'Charts unavailable.')); return wrap; }

  const bins = ctx.cards.cardHistogram(distObj.values, 15);
  const cv = (name, fb) => {
    try { return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fb; } catch { return fb; }
  };
  const axis = cv('--muted', '#94a3b8');
  const grid = cv('--border', 'rgba(140,165,220,0.10)');
  const bar = cv(colorVar, '#22d3ee');
  const median = distObj.p50;

  new window.Chart(canvas, {
    type: 'bar',
    data: {
      labels: bins.map(b => b.overflow ? `${b.day}+` : String(b.day)),
      datasets: [{
        data: bins.map(b => b.count),
        backgroundColor: bins.map(b => (b.day === median && !b.overflow) ? cv('--good', '#34d399') : bar),
        borderRadius: 3,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: ctx.prefersReducedMotion?.() ? false : undefined,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: cv('--tooltip-bg', 'rgba(7,10,19,0.92)'),
          titleColor: cv('--text', '#e8edf7'),
          bodyColor: axis,
          callbacks: {
            title: (items) => `day ${items[0]?.label}`,
            label: (item) => ` ${item.raw} case${item.raw === 1 ? '' : 's'}${String(item.label) === String(median) ? ' · median' : ''}`,
          },
        },
      },
      scales: {
        x: { ticks: { color: axis, maxRotation: 0, autoSkip: true, maxTicksLimit: 9 }, grid: { display: false } },
        y: { ticks: { color: axis, precision: 0 }, grid: { color: grid }, beginAtZero: true },
      },
    },
  });
  return wrap;
}
