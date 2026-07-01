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
 * wrapTable — wrap a <table> in a .table-wrap div for horizontal scrolling.
 * @param {HTMLTableElement} tableEl
 * @returns {HTMLDivElement}
 */
export function wrapTable(tableEl) {
  const w = el('div', 'table-wrap');
  w.append(tableEl);
  return w;
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
