/**
 * dashboard/modules/cardtrack.mjs — "After approval" card tracker.
 *
 * Renders into #cardtrack (div #cardtrack-out): the two post-approval stage
 * distributions (approved → card produced, produced → delivered) plus a
 * personal countdown — enter your approval date (or let the USCIS status
 * watch prefill it) and get projected produced/delivered dates.
 *
 * Data honesty: reporting drops after approval, so every stat carries its n
 * and the caveat is spelled out. Personal anchor date is localStorage-only,
 * consistent with the status watch's privacy model.
 *
 * MODULE CONTRACT: export render(ctx). Idempotent — charts are destroyed
 * and rebuilt, children replaced, on every render.
 */

const ANCHOR_KEY = 'opt-radar-card-anchor';
const CANVASES = ['card-hist-prod', 'card-hist-recv'];

// ---------------------------------------------------------------------------
// Local anchor state (localStorage only)
// ---------------------------------------------------------------------------

function loadAnchor() {
  try {
    const a = JSON.parse(localStorage.getItem(ANCHOR_KEY) || 'null');
    return a && /^\d{4}-\d{2}-\d{2}$/.test(a.date) ? a : null;
  } catch { return null; }
}

function saveAnchor(a) {
  try {
    if (a) localStorage.setItem(ANCHOR_KEY, JSON.stringify(a));
    else localStorage.removeItem(ANCHOR_KEY);
  } catch { /* storage off */ }
}

/**
 * Prefill from the USCIS status watch: if the last status is an approval or
 * card-production notice, pull the date USCIS mentions ("On July 1, 2026, …").
 */
function anchorFromStatusWatch() {
  try {
    const w = JSON.parse(localStorage.getItem('opt-radar-case-watch') || 'null');
    const last = w?.last;
    if (!last?.status || last.kind !== 'approved') return null;
    const m = String(last.detail || '').match(/on ([A-Z][a-z]+ \d{1,2}, \d{4})/i);
    if (!m) return null;
    const t = new Date(m[1] + ' 12:00:00'); // noon dodges timezone day-shift
    if (isNaN(t)) return null;
    const iso = t.toISOString().slice(0, 10);
    const kind = /card .*(being )?produced|card was mailed/i.test(last.status) ? 'produced' : 'approved';
    return { date: iso, kind, from: 'status-watch' };
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// render
// ---------------------------------------------------------------------------

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

  // ---- three-column body: countdown + two histograms ----------------------
  const grid = el('div', 'ct-grid');
  grid.append(buildCountdown(ctx, stats));
  if (a2p) grid.append(histBlock(ctx, 'card-hist-prod', 'Approved → produced — day by day', a2p, '--accent'));
  if (p2r) grid.append(histBlock(ctx, 'card-hist-recv', 'Produced → delivered — day by day', p2r, '--accent-2'));
  out.append(grid);

  out.append(el('p', 'muted',
    `Reporting drops after approval — ${a2p ? a2p.n : 0} of the approved cases report a production date, ` +
    `${a2r ? a2r.n : 0} a delivery date. The stages are mechanical (card printer, then USPS), so even this ` +
    'sample gives stable medians.'));
}

// ---------------------------------------------------------------------------
// personal countdown
// ---------------------------------------------------------------------------

function fmtDate(iso) {
  if (!iso) return '—';
  const t = new Date(iso + 'T12:00:00');
  return isNaN(t) ? iso : t.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function buildCountdown(ctx, stats) {
  const { el } = ctx;
  const box = el('div', 'ct-countdown');
  box.append(el('h3', 'ct-title', 'My card countdown'));

  const stored = loadAnchor();
  const suggested = stored || anchorFromStatusWatch();

  const controls = el('div', 'ct-controls');
  const kindSel = el('select');
  kindSel.setAttribute('aria-label', 'Countdown anchor');
  for (const [v, label] of [['approved', 'I was approved on'], ['produced', '“Card produced” said on']]) {
    const o = el('option', null, label);
    o.value = v;
    kindSel.append(o);
  }
  const dateIn = el('input');
  dateIn.type = 'date';
  dateIn.setAttribute('aria-label', 'Anchor date');
  if (suggested) { kindSel.value = suggested.kind; dateIn.value = suggested.date; }
  controls.append(kindSel, dateIn);
  box.append(controls);

  const outArea = el('div', 'ct-out');
  box.append(outArea);

  const paint = () => {
    outArea.replaceChildren();
    const date = dateIn.value;
    if (!date) {
      outArea.append(el('p', 'muted cs-note',
        'Pick your approval date — or save your receipt in the status watch and it lands here by itself.'));
      return;
    }
    const from = suggested?.from === 'status-watch' && date === suggested.date ? 'status-watch' : 'manual';
    saveAnchor({ date, kind: kindSel.value, from });
    const proj = ctx.cards?.cardProjection?.(stats, date, kindSel.value);
    if (!proj) { outArea.append(el('p', 'muted cs-note', 'Not enough community data to project from that anchor.')); return; }

    const line = (label, p50, p90) => {
      const p = el('p', 'ct-line');
      p.append(document.createTextNode(label + ' '));
      const strong = el('strong', 'ct-date', `~${fmtDate(p50)}`);
      p.append(strong);
      if (p90) p.append(el('span', 'muted', ` · almost certainly by ${fmtDate(p90)}`));
      return p;
    };
    if (proj.producedP50) outArea.append(line('Card produced', proj.producedP50, proj.producedP90));
    if (proj.deliveredP50) outArea.append(line('In your mailbox', proj.deliveredP50, proj.deliveredP90));

    const basis = proj.anchorKind === 'produced'
      ? `based on ${proj.basis.p2r} delivered cards`
      : `based on ${proj.basis.a2p} produced / ${proj.basis.a2r} delivered reports`;
    const src = suggested?.from === 'status-watch' && !stored ? ' · date from your status watch' : '';
    outArea.append(el('p', 'muted cs-note', `${basis}${src} · stored in this browser only`));
  };

  kindSel.addEventListener('change', paint);
  dateIn.addEventListener('change', paint);
  paint();
  return box;
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
