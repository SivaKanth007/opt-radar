/**
 * dashboard/modules/util.mjs
 * Shared DOM + animation helpers imported by every feature module and the orchestrator.
 * Pure browser ESM — no Node.js imports.
 *
 * All exports are documented inline. The orchestrator passes these as ctx.{name}
 * so modules never import directly; they just destructure from ctx.
 */

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

/**
 * $ — querySelector shorthand.
 * @param {string} sel  CSS selector
 * @param {ParentNode} [root=document]
 * @returns {Element|null}
 */
/**
 * cssVar — read a CSS custom property off :root, with a fallback.
 * Lets SVG/canvas code (which can't use var() in attributes) follow the active
 * light/dark palette. Reads live at call time, so re-rendering after a
 * color-scheme change picks up the new value.
 * @param {string} name  e.g. '--text'
 * @param {string} [fallback]
 * @returns {string}
 */
export function cssVar(name, fallback = '') {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  } catch {
    return fallback;
  }
}

export const $ = (sel, root = document) => root.querySelector(sel);

/**
 * $$ — querySelectorAll shorthand; returns a real Array.
 * @param {string} sel  CSS selector
 * @param {ParentNode} [root=document]
 * @returns {Element[]}
 */
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/**
 * el — create an element with optional class and text content.
 * @param {string} tag
 * @param {string|null} [cls]   className (null/undefined → skipped)
 * @param {string|null} [text]  textContent (null/undefined → skipped)
 * @returns {HTMLElement}
 */
export function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls)  e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

/**
 * fmt — safe number format: rounds to integer, returns '—' for null/undefined/NaN.
 * @param {number|null|undefined} n
 * @returns {string}
 */
export const fmt = (n) => (n == null || !isFinite(n)) ? '—' : String(Math.round(n));

/**
 * pct — format a fraction (0–1) as a percentage string.
 * @param {number|null|undefined} n  value in [0, 1]
 * @param {number} [d=0]             decimal places
 * @returns {string}
 */
export function pct(n, d = 0) {
  if (n == null || !isFinite(n)) return '—';
  return (n * 100).toFixed(d) + '%';
}

/**
 * wrapTable — wrap a <table> in a .table-wrap div for horizontal scrolling,
 * and auto-upgrade it: every column becomes click-to-sort and a filter row
 * can be toggled per column. Modules opt OUT by setting
 * table.dataset.noEnhance (e.g. paginated tables that sort their full
 * dataset themselves).
 * @param {HTMLTableElement} tableEl
 * @returns {HTMLDivElement}
 */
export function wrapTable(tableEl) {
  const w = el('div', 'table-wrap');
  w.append(tableEl);
  if (tableEl.dataset.noEnhance == null) {
    try { enhanceTable(tableEl, w); } catch (e) { console.error('[util] enhanceTable', e); }
  }
  return w;
}

// ---------------------------------------------------------------------------
// enhanceTable — universal sort + filter for rendered tables
// ---------------------------------------------------------------------------

/** Best-effort typed sort key for a cell's text. */
function sortKey(text) {
  const t = (text || '').trim();
  if (!t || t === '—') return { type: 'empty', v: '' };
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return { type: 'date', v: t };
  // numbers, tolerating suffixes like "93+", "26 BD", "48%", "1,024", "87d"
  const num = t.replace(/[,%+]/g, '').match(/^-?\d+(\.\d+)?/);
  if (num && /^[\d,.\-+%]+([a-z%]{0,3})?$/i.test(t.replace(/\s/g, ''))) {
    return { type: 'num', v: parseFloat(num[0]) };
  }
  return { type: 'str', v: t.toLowerCase() };
}

function compareKeys(a, b) {
  // empties always sink to the bottom regardless of direction? No — keep
  // stable semantics: empty < everything, direction flips it like any value.
  if (a.type === 'empty' && b.type === 'empty') return 0;
  if (a.type === 'empty') return -1;
  if (b.type === 'empty') return 1;
  if (a.type === 'num' && b.type === 'num') return a.v - b.v;
  return a.v < b.v ? -1 : a.v > b.v ? 1 : 0;
}

/**
 * Make a rendered table sortable (click a header) and filterable (toggleable
 * per-column filter row). Works on module-built tables where the header row
 * is the first <tr> holding <th>s and body rows follow (no explicit thead).
 * Sorting/filtering operate on the rendered rows — paginated modules that
 * need full-dataset behavior implement their own and opt out.
 */
export function enhanceTable(tableEl, wrapEl) {
  const rows = [...tableEl.querySelectorAll('tr')];
  const headRow = rows.find(r => r.querySelector('th'));
  if (!headRow) return;
  const ths = [...headRow.children];
  const bodyRows = () => [...tableEl.querySelectorAll('tr')].filter(r =>
    r !== headRow && !r.classList.contains('t-filter-row') && !r.querySelector('th'));
  if (!bodyRows().length || ths.length < 2) return;

  // ---- sorting ----
  let sortCol = -1, sortDir = 1;
  ths.forEach((th, i) => {
    th.classList.add('sortable');
    th.tabIndex = 0;
    th.setAttribute('role', 'columnheader');
    th.setAttribute('aria-sort', 'none');
    const ind = el('span', 'sort-ind');
    th.append(ind);
    const activate = () => {
      if (sortCol === i) sortDir = -sortDir; else { sortCol = i; sortDir = 1; }
      ths.forEach((h, j) => {
        h.setAttribute('aria-sort', j === i ? (sortDir === 1 ? 'ascending' : 'descending') : 'none');
        h.classList.toggle('sorted', j === i);
      });
      const rs = bodyRows();
      const keyed = rs.map(r => ({ r, k: sortKey(r.children[i]?.textContent) }));
      keyed.sort((x, y) => compareKeys(x.k, y.k) * sortDir);
      for (const { r } of keyed) r.parentNode.append(r); // re-append in order
    };
    th.addEventListener('click', activate);
    th.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); }
    });
  });

  // ---- filtering (toggleable per-column row) ----
  const filterRow = el('tr', 't-filter-row');
  filterRow.hidden = true;
  ths.forEach((th, i) => {
    const td = el('td');
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.placeholder = 'filter…';
    inp.setAttribute('aria-label', `Filter by ${th.textContent.trim() || 'column ' + (i + 1)}`);
    inp.addEventListener('input', () => {
      const wanted = [...filterRow.querySelectorAll('input')].map(x => x.value.trim().toLowerCase());
      for (const r of bodyRows()) {
        const show = wanted.every((q, j) => !q || (r.children[j]?.textContent || '').toLowerCase().includes(q));
        r.hidden = !show;
      }
    });
    td.append(inp);
    filterRow.append(td);
  });
  headRow.after(filterRow);

  // Toggle button floats on the wrap (≥44px touch target via padding).
  if (wrapEl) {
    const btn = el('button', 'table-filter-btn');
    btn.type = 'button';
    btn.setAttribute('aria-label', 'Toggle column filters');
    btn.setAttribute('aria-pressed', 'false');
    btn.append(icon('filter', 14), el('span', null, 'Filter'));
    btn.addEventListener('click', () => {
      filterRow.hidden = !filterRow.hidden;
      btn.setAttribute('aria-pressed', String(!filterRow.hidden));
      if (filterRow.hidden) { // clearing filters when hiding — no invisible state
        for (const x of filterRow.querySelectorAll('input')) x.value = '';
        for (const r of bodyRows()) r.hidden = false;
      } else {
        filterRow.querySelector('input')?.focus();
      }
    });
    wrapEl.classList.add('has-filter-btn');
    wrapEl.prepend(btn);
  }
}

// ---------------------------------------------------------------------------
// icon — inline SVG icon set (data-related, stroke-consistent, no emoji)
// ---------------------------------------------------------------------------

/* All 24×24 viewBox, 2px stroke, currentColor — Lucide-style geometry. */
const ICON_PATHS = {
  bolt: '<path d="M13 2 4 14h6l-1 8 9-12h-6l1-8z"/>',
  filter: '<path d="M4 5h16l-6 7v5l-4 2v-7L4 5z"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 8h.01M11 12h1v4h1"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.4 3.4-5 6.5-5s5.7 1.6 6.5 5"/><circle cx="17" cy="9" r="2.5"/><path d="M15.5 14.6c2.6.3 4.6 1.7 5.5 4.4"/>',
  wave: '<path d="M2 12c2.5 0 2.5-5 5-5s2.5 8 5 8 2.5-11 5-11 2.5 8 5 8"/>',
  chart: '<path d="M4 20V4M4 20h16"/><path d="M8 16v-5M12 16V8M16 16v-8"/>',
  calendar: '<rect x="4" y="5" width="16" height="16" rx="2"/><path d="M8 3v4M16 3v4M4 11h16"/>',
  funnel: '<path d="M3 4h18l-7 8v6l-4 2v-8L3 4z"/>',
  shield: '<path d="M12 3 5 6v6c0 4.5 3 7.5 7 9 4-1.5 7-4.5 7-9V6l-7-3z"/><path d="M12 8v4M12 15h.01"/>',
  building: '<rect x="5" y="4" width="14" height="17" rx="1"/><path d="M9 8h2M13 8h2M9 12h2M13 12h2M9 16h2M13 16h2"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/>',
  sparkle: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3z"/><path d="M19 16l.9 2.1L22 19l-2.1.9L19 22l-.9-2.1L16 19l2.1-.9L19 16z"/>',
  seal: '<circle cx="12" cy="12" r="8"/><path d="M8.5 12l2.5 2.5 4.5-5"/>',
  pulse: '<path d="M3 12h4l2-6 4 12 2-6h6"/>',
  target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r="0.5"/>',
  sun: '<circle cx="12" cy="12" r="4.5"/><path d="M12 2.5v2.5M12 19v2.5M2.5 12h2.5M19 12h2.5M5 5l1.8 1.8M17.2 17.2 19 19M19 5l-1.8 1.8M6.8 17.2 5 19"/>',
  moon: '<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4 8.5 8.5 0 1 0 20 14.5z"/>',
  system: '<rect x="3" y="5" width="18" height="12" rx="2"/><path d="M9 21h6M12 17v4"/>',
  fingerprint: '<path d="M7 19c-1.5-2.5-2-5-1-8a6.5 6.5 0 0 1 12.5 1c0 2.5-.3 5-1.5 7"/><path d="M12 11c0 3-.5 6-2 8.5"/><path d="M15.5 13.5c0 2-.3 4-1 5.5"/>',
  hourglass: '<path d="M7 3h10M7 21h10M8 3c0 4 3 5.5 4 6.5 1-1 4-2.5 4-6.5M8 21c0-4 3-5.5 4-6.5 1 1 4 2.5 4 6.5"/>',
  file: '<path d="M7 3h7l5 5v13H7V3z"/><path d="M14 3v5h5"/>',
};

/**
 * icon — inline SVG icon (stroke, currentColor). Trusted constant markup only.
 * @param {keyof typeof ICON_PATHS} name
 * @param {number} [size=16]
 * @returns {HTMLElement} span.svg-icon wrapping the svg
 */
export function icon(name, size = 16) {
  const span = el('span', 'svg-icon');
  const body = ICON_PATHS[name] || ICON_PATHS.info;
  span.innerHTML =
    `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" ` +
    `stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;
  return span;
}

// ---------------------------------------------------------------------------
// explain — provenance popover ("how was this number computed?")
// ---------------------------------------------------------------------------

let _openPop = null;

function closeExplain() {
  if (_openPop) {
    const p = _openPop;
    _openPop = null;
    p.classList.remove('open');
    p.addEventListener('transitionend', () => p.remove(), { once: true });
    setTimeout(() => p.remove(), 300); // fallback if transitions are frozen
  }
}
document.addEventListener('click', (e) => {
  if (_openPop && !_openPop.contains(e.target) && !e.target.closest?.('.explainable')) closeExplain();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeExplain(); });

/**
 * explain — make `anchor` clickable: opens a liquid-glass popover that shows
 * exactly how a number was computed (numerator / denominator / exclusions /
 * formula), anchored at the click point ("box opening" scale animation).
 *
 * @param {HTMLElement} anchor
 * @param {() => {title: string, lines: Array<[string, string]>, note?: string}} build
 */
export function explain(anchor, build) {
  if (!anchor || typeof build !== 'function') return;
  anchor.classList.add('explainable');
  anchor.setAttribute('role', 'button');
  anchor.tabIndex = 0;
  anchor.setAttribute('aria-haspopup', 'dialog');
  if (!anchor.title) anchor.title = 'Click: how is this computed?';

  const open = (x, y) => {
    closeExplain();
    let spec;
    try { spec = build(); } catch (e) { console.error('[explain]', e); return; }
    if (!spec) return;

    const pop = el('div', 'explain-pop');
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label', spec.title || 'How this is computed');

    const head = el('div', 'explain-head');
    head.append(icon('info', 14), el('strong', null, spec.title || 'How this is computed'));
    const closeBtn = el('button', 'explain-close');
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.append(icon('x', 12));
    closeBtn.addEventListener('click', closeExplain);
    head.append(closeBtn);
    pop.append(head);

    for (const [label, value] of spec.lines || []) {
      const row = el('div', 'explain-row');
      row.append(el('span', 'explain-label', label), el('span', 'explain-value', value));
      pop.append(row);
    }
    if (spec.note) pop.append(el('p', 'explain-note', spec.note));

    document.body.append(pop);
    // Anchor at the click point, clamped into the viewport ("box opens" here).
    const W = Math.min(340, innerWidth - 24);
    pop.style.width = W + 'px';
    const px = Math.max(12, Math.min(x - W / 2, innerWidth - W - 12));
    const rect = pop.getBoundingClientRect();
    const above = y + rect.height + 18 > innerHeight && y - rect.height - 18 > 0;
    pop.style.left = px + 'px';
    pop.style.top = (above ? y - rect.height - 14 : y + 14) + 'px';
    pop.style.transformOrigin = `${x - px}px ${above ? rect.height + 'px' : '0px'}`;

    _openPop = pop;
    requestAnimationFrame(() => requestAnimationFrame(() => pop.classList.add('open')));
  };

  anchor.addEventListener('click', (e) => {
    e.stopPropagation();
    if (_openPop) { closeExplain(); return; }
    open(e.clientX, e.clientY);
  });
  anchor.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      const r = anchor.getBoundingClientRect();
      if (_openPop) { closeExplain(); return; }
      open(r.left + r.width / 2, r.bottom);
    }
  });
}

// ---------------------------------------------------------------------------
// Motion preference
// ---------------------------------------------------------------------------

/**
 * prefersReducedMotion — returns true when the user's OS has reduced-motion enabled.
 * All animation helpers check this internally; callers may also check before
 * scheduling their own animations.
 * @returns {boolean}
 */
export function prefersReducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * isCompactViewport — true on narrow (mobile) viewports. Used by ruler/label
 * layout to shorten text and stagger rows so absolutely-positioned labels
 * don't overlap or run off the edge of a ~320-375px track.
 * @returns {boolean}
 */
export function isCompactViewport() {
  try { return window.matchMedia('(max-width: 640px)').matches; }
  catch { return false; }
}

/**
 * edgeAnchor — CSS transform for a label centered at `pct` (0-100) along a
 * track, biased toward the track's start/end near the edges so the label
 * never overflows past 0% or 100% (a label centered exactly at pct=2 would
 * otherwise render half off-screen to the left).
 * @param {number} pct  position along the track, 0-100
 * @returns {string} a CSS transform value
 */
export function edgeAnchor(pct) {
  if (pct <= 12) return 'translateX(0)';
  if (pct >= 88) return 'translateX(-100%)';
  return 'translateX(-50%)';
}

// ---------------------------------------------------------------------------
// countUp — animated number increment
// ---------------------------------------------------------------------------

/**
 * countUp — animate an element's textContent from 0 to `to` using rAF easing.
 * Instantly snaps to final value if reduced motion is preferred or `to` is non-finite.
 *
 * @param {HTMLElement} elm
 * @param {number} to              target value
 * @param {object} [opts]
 * @param {number} [opts.duration=900]  animation duration in ms
 * @param {string} [opts.suffix='']     appended to displayed value (e.g. '%')
 * @param {string} [opts.prefix='']     prepended (e.g. '~')
 * @param {number} [opts.decimals=0]    decimal places
 */
export function countUp(elm, to, { duration = 900, suffix = '', prefix = '', decimals = 0 } = {}) {
  if (!elm) return;
  const render = (val) => {
    elm.textContent = prefix + val.toFixed(decimals) + suffix;
  };

  // Guard: non-finite target or reduced-motion — set immediately.
  if (!isFinite(to) || prefersReducedMotion()) {
    render(isFinite(to) ? to : 0);
    return;
  }

  const start = performance.now();
  function tick(now) {
    const elapsed = now - start;
    const progress = Math.min(elapsed / duration, 1);
    // Ease-out cubic
    const eased = 1 - Math.pow(1 - progress, 3);
    render(eased * to);
    if (progress < 1) requestAnimationFrame(tick);
    else render(to); // snap to exact final value
  }
  requestAnimationFrame(tick);
}

// ---------------------------------------------------------------------------
// ring — circular SVG progress indicator
// ---------------------------------------------------------------------------

/**
 * ring — build (or update) an SVG circular progress ring.
 * Returns a fresh SVG element each call; the caller should replace its previous node.
 *
 * @param {object} opts
 * @param {number}      opts.percent    0–100 fill amount
 * @param {number}      [opts.size=120] diameter in px
 * @param {string}      [opts.label]    large text inside (defaults to percent string)
 * @param {string}      [opts.sublabel] small text below label
 * @returns {SVGSVGElement}
 */
export function ring({ percent, size = 120, label, sublabel } = {}) {
  const STROKE = Math.max(6, size * 0.08);
  const R       = (size - STROKE) / 2;
  const CX      = size / 2;
  const CIRC    = 2 * Math.PI * R;
  const clampedPct = Math.max(0, Math.min(100, percent ?? 0));
  const targetOffset = CIRC * (1 - clampedPct / 100);

  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
  svg.setAttribute('width',  size);
  svg.setAttribute('height', size);
  svg.setAttribute('role',   'img');
  svg.setAttribute('aria-label', `${Math.round(clampedPct)}% progress`);

  // Gradient definition (cyan → violet)
  const defs  = document.createElementNS(NS, 'defs');
  const gradId = `ring-grad-${Math.random().toString(36).slice(2, 7)}`;
  const grad  = document.createElementNS(NS, 'linearGradient');
  grad.id = gradId;
  grad.setAttribute('x1', '0%'); grad.setAttribute('y1', '0%');
  grad.setAttribute('x2', '100%'); grad.setAttribute('y2', '100%');

  const stop1 = document.createElementNS(NS, 'stop');
  stop1.setAttribute('offset', '0%');
  stop1.setAttribute('stop-color', '#06b6d4'); // cyan-500

  const stop2 = document.createElementNS(NS, 'stop');
  stop2.setAttribute('offset', '100%');
  stop2.setAttribute('stop-color', '#7c3aed'); // violet-700

  grad.append(stop1, stop2);
  defs.append(grad);
  svg.append(defs);

  // Track circle (dim background ring)
  const track = document.createElementNS(NS, 'circle');
  track.setAttribute('cx', CX); track.setAttribute('cy', CX);
  track.setAttribute('r',  R);
  track.setAttribute('fill', 'none');
  track.setAttribute('stroke', cssVar('--ring-track', 'rgba(140,165,220,0.2)'));
  track.setAttribute('stroke-width', STROKE);
  svg.append(track);

  // Progress arc — starts at top (rotate -90deg)
  const arc = document.createElementNS(NS, 'circle');
  arc.setAttribute('cx', CX); arc.setAttribute('cy', CX);
  arc.setAttribute('r',  R);
  arc.setAttribute('fill', 'none');
  arc.setAttribute('stroke', `url(#${gradId})`);
  arc.setAttribute('stroke-width', STROKE);
  arc.setAttribute('stroke-linecap', 'round');
  arc.setAttribute('stroke-dasharray',  CIRC);
  arc.setAttribute('transform', `rotate(-90 ${CX} ${CX})`);

  if (prefersReducedMotion()) {
    // Snap immediately
    arc.setAttribute('stroke-dashoffset', targetOffset);
  } else {
    // Start at full offset (empty), animate to target
    arc.setAttribute('stroke-dashoffset', CIRC);
    arc.style.transition = 'stroke-dashoffset 1s cubic-bezier(.4,0,.2,1)';
    // Trigger transition after paint
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        arc.setAttribute('stroke-dashoffset', targetOffset);
      });
    });
  }
  svg.append(arc);

  // Center label (big percent or custom)
  const centerLabel = document.createElementNS(NS, 'text');
  centerLabel.setAttribute('x', CX);
  centerLabel.setAttribute('y', sublabel ? CX - size * 0.07 : CX + size * 0.06);
  centerLabel.setAttribute('text-anchor', 'middle');
  centerLabel.setAttribute('dominant-baseline', 'middle');
  centerLabel.setAttribute('fill', cssVar('--text', '#f1f5f9'));
  centerLabel.setAttribute('font-size', size * 0.22);
  centerLabel.setAttribute('font-weight', '700');
  centerLabel.setAttribute('font-family', 'inherit');
  centerLabel.textContent = label ?? `${Math.round(clampedPct)}%`;
  svg.append(centerLabel);

  if (sublabel) {
    const sub = document.createElementNS(NS, 'text');
    sub.setAttribute('x', CX);
    sub.setAttribute('y', CX + size * 0.18);
    sub.setAttribute('text-anchor', 'middle');
    sub.setAttribute('dominant-baseline', 'middle');
    sub.setAttribute('fill', cssVar('--muted', '#94a3b8'));
    sub.setAttribute('font-size', size * 0.12);
    sub.setAttribute('font-family', 'inherit');
    sub.textContent = sublabel;
    svg.append(sub);
  }

  return svg;
}

// ---------------------------------------------------------------------------
// toast — futuristic slide-in notification popup
// ---------------------------------------------------------------------------

const TOAST_COLORS = {
  good: { bg: 'rgba(16,185,129,0.15)', border: '#10b981', text: '#6ee7b7' },
  info: { bg: 'rgba(96,165,250,0.15)', border: '#60a5fa', text: '#93c5fd' },
  warn: { bg: 'rgba(245,158,11,0.15)', border: '#f59e0b', text: '#fcd34d' },
};

/**
 * toast — show a slide-in notification (bottom-right stack).
 * Creates #toast-stack if not present. Auto-dismisses after timeout; also dismisses on click.
 * Respects reduced motion (skips slide animation).
 *
 * @param {string} message
 * @param {'good'|'info'|'warn'} [type='info']
 * @param {object} [opts]
 * @param {number} [opts.timeout=6000]  ms before auto-dismiss
 */
export function toast(message, type = 'info', { timeout = 6000 } = {}) {
  // Ensure the stack container exists
  let stack = document.getElementById('toast-stack');
  if (!stack) {
    stack = el('div', null);
    stack.id = 'toast-stack';
    Object.assign(stack.style, {
      position:      'fixed',
      bottom:        '24px',
      right:         '24px',
      zIndex:        '9999',
      display:       'flex',
      flexDirection: 'column',
      gap:           '10px',
      alignItems:    'flex-end',
      pointerEvents: 'none',   // container is pass-through; items re-enable pointer events
    });
    document.body.append(stack);
  }

  const colors = TOAST_COLORS[type] ?? TOAST_COLORS.info;
  const item = el('div', null, message);
  Object.assign(item.style, {
    background:     colors.bg,
    border:         `1px solid ${colors.border}`,
    borderLeft:     `3px solid ${colors.border}`,
    color:          cssVar('--text', colors.text), // adapt to light/dark; keep colored accent border
    padding:        '12px 18px',
    borderRadius:   '10px',
    fontSize:       '13px',
    fontFamily:     'inherit',
    lineHeight:     '1.45',
    maxWidth:       '340px',
    pointerEvents:  'auto',
    cursor:         'pointer',
    backdropFilter: 'blur(12px)',
    boxShadow:      `0 4px 24px rgba(0,0,0,0.4), 0 0 0 1px ${colors.border}22`,
    willChange:     'transform, opacity',
    opacity:        '0',
  });

  const reduced = prefersReducedMotion();
  if (!reduced) {
    item.style.transform  = 'translateX(120%)';
    item.style.transition = 'transform 0.35s cubic-bezier(.22,1,.36,1), opacity 0.35s ease';
  }

  stack.append(item);

  function dismiss() {
    if (!item.isConnected) return;
    if (!reduced) {
      item.style.opacity   = '0';
      item.style.transform = 'translateX(120%)';
      item.addEventListener('transitionend', () => item.remove(), { once: true });
    } else {
      item.remove();
    }
  }

  // Trigger slide-in on next frame
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      item.style.opacity   = '1';
      if (!reduced) item.style.transform = 'translateX(0)';
    });
  });

  // Auto-dismiss
  const timer = setTimeout(dismiss, timeout);
  item.addEventListener('click', () => { clearTimeout(timer); dismiss(); });
}

// ---------------------------------------------------------------------------
// confetti — lightweight canvas burst
// ---------------------------------------------------------------------------

/**
 * confetti — fire a canvas-based particle burst.
 * Creates a full-screen pointer-events:none canvas, animates particles with
 * gravity, then removes the canvas when done. No-op if reduced motion is preferred.
 *
 * @param {object} [opts]
 * @param {number}  [opts.count=120]  number of particles
 * @param {{x:number,y:number}} [opts.origin]  origin in viewport px; defaults to center
 */
export function confetti({ count = 120, origin } = {}) {
  if (prefersReducedMotion()) return;

  const canvas = document.createElement('canvas');
  canvas.width  = window.innerWidth;
  canvas.height = window.innerHeight;
  Object.assign(canvas.style, {
    position:      'fixed',
    inset:         '0',
    pointerEvents: 'none',
    zIndex:        '99999',
  });
  document.body.append(canvas);

  const ctx = canvas.getContext('2d');
  const ox = origin?.x ?? canvas.width  / 2;
  const oy = origin?.y ?? canvas.height / 2;

  // Particle palette: electric blue, cyan, violet, gold, mint
  const COLORS = ['#06b6d4','#7c3aed','#60a5fa','#34d399','#f59e0b','#f472b6','#a78bfa'];

  const particles = Array.from({ length: count }, () => {
    const angle  = (Math.random() * Math.PI * 2);
    const speed  = 3 + Math.random() * 9;
    return {
      x:     ox,
      y:     oy,
      vx:    Math.cos(angle) * speed,
      vy:    Math.sin(angle) * speed - 4, // slight upward bias
      size:  4 + Math.random() * 6,
      color: COLORS[Math.floor(Math.random() * COLORS.length)],
      alpha: 1,
      rot:   Math.random() * Math.PI * 2,
      rotV:  (Math.random() - 0.5) * 0.3,
      shape: Math.random() < 0.5 ? 'rect' : 'circle',
    };
  });

  const GRAVITY   = 0.25;
  const DRAG      = 0.99;
  const FADE_RATE = 0.018;
  let alive = true;

  function frame() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    let anyVisible = false;

    for (const p of particles) {
      if (p.alpha <= 0) continue;
      anyVisible = true;
      p.vx *= DRAG;
      p.vy  = p.vy * DRAG + GRAVITY;
      p.x  += p.vx;
      p.y  += p.vy;
      p.rot += p.rotV;
      p.alpha -= FADE_RATE;

      ctx.save();
      ctx.globalAlpha = Math.max(0, p.alpha);
      ctx.fillStyle   = p.color;
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);

      if (p.shape === 'rect') {
        ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
      } else {
        ctx.beginPath();
        ctx.arc(0, 0, p.size / 2, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.restore();
    }

    if (anyVisible && alive) {
      requestAnimationFrame(frame);
    } else {
      canvas.remove();
    }
  }

  requestAnimationFrame(frame);

  // Safety cleanup in case the tab goes to background and rAF stalls
  setTimeout(() => { alive = false; canvas.remove(); }, 8000);
}
