/**
 * dashboard/modules/fx.mjs — the cinematic layer ("Mission Control").
 *
 * Everything decorative lives here so the data modules stay pure:
 *   · scroll progress bar        (#scroll-progress)
 *   · scroll-driven reveals      (IntersectionObserver on main > section)
 *   · SCROLL ENGINE (one rAF loop, lerped):
 *       – hero parallax (copy / scope / stars shear apart as you scroll)
 *       – ghost titles ([data-ghost]::after drift + scroll-velocity skew)
 *       – journey scrollytelling (#journey pinned rail + stage ignition)
 *   · starfield canvas           (.hero-stars — drifting constellation)
 *   · live approvals ticker      (#ticker-track — built from real data)
 *   · radar scope blips          (.scope-blips — recent approvals plotted:
 *                                 angle = stable hash, radius = days-to-approval)
 *   · 3D card tilt + sheen       (pointer:fine only, ±5°)
 *   · cursor spotlight           (#cursor-glow, desktop only)
 *   · section nav dots           (#section-dots, scrollspy, wide screens)
 *
 * MODULE CONTRACT: export render(ctx). Registered LAST in app.js MODULES so
 * data-dependent pieces (ticker, blips, journey numbers) see the fresh DOM
 * every load(). One-time singletons are guarded; re-renders only rebuild the
 * data-driven bits.
 *
 * HONESTY + ACCESS: prefers-reduced-motion ⇒ no engine, no ticker scroll, no
 * tilt, no spotlight; reveals and the journey render fully visible, static.
 * Every feature is try/catch-isolated — a decorative failure must never take
 * down a data panel.
 */

let _inited = false;
let _dotsSections = [];
let _engine = null; // scroll-engine state (single rAF loop)

const reduced = () => {
  try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
};
const finePointer = () => {
  try { return matchMedia('(pointer: fine)').matches; } catch { return false; }
};

/* ------------------------------------------------------------------------ */
/* render — entry point (called by app.js on every load)                    */
/* ------------------------------------------------------------------------ */

export function render(ctx) {
  try { if (!_inited) { initOnce(ctx); _inited = true; } } catch (e) { console.error('[fx] init', e); }
  try { buildTicker(ctx); } catch (e) { console.error('[fx] ticker', e); }
  try { plotBlips(ctx); } catch (e) { console.error('[fx] blips', e); }
  try { fillJourney(ctx); } catch (e) { console.error('[fx] journey', e); }
  try { refreshDots(); } catch (e) { console.error('[fx] dots', e); }
}

/* ------------------------------------------------------------------------ */
/* One-time singletons                                                      */
/* ------------------------------------------------------------------------ */

function initOnce(ctx) {
  initProgressBar();
  initReveals();
  initHeadlineWords();
  initTilt();
  initSpotlight();
  initDots();
  initEngine();   // hero parallax + ghost titles + journey scrub + starfield
}

/* ---- scroll progress bar ------------------------------------------------ */

function initProgressBar() {
  const bar = document.getElementById('scroll-progress');
  if (!bar) return;
  let ticking = false;
  const update = () => {
    ticking = false;
    const doc = document.documentElement;
    const max = doc.scrollHeight - innerHeight;
    const p = max > 0 ? Math.min(1, Math.max(0, scrollY / max)) : 0;
    bar.style.transform = `scaleX(${p})`;
  };
  addEventListener('scroll', () => {
    if (!ticking) { ticking = true; requestAnimationFrame(update); }
  }, { passive: true });
  update();
}

/* ---- scroll-driven section reveals -------------------------------------- */

function initReveals() {
  const sections = document.querySelectorAll('main > section');
  if (!sections.length) return;
  if (reduced() || !('IntersectionObserver' in window)) return; // instant, honest

  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) {
        e.target.classList.add('in');
        io.unobserve(e.target); // reveal once, never re-hide
      }
    }
  }, { rootMargin: '0px 0px -12% 0px', threshold: 0.05 });

  for (const s of sections) {
    if (s.dataset.nofx != null) continue; // pinned sections (journey) opt out
    // Never hide what the user can already see — only below-fold sections
    // get the reveal treatment (kills any first-paint flash).
    const r = s.getBoundingClientRect();
    if (r.top < innerHeight * 0.92) continue;
    s.classList.add('fx-reveal');
    io.observe(s);
  }
}

/* ---- kinetic headline (word-by-word rise) ------------------------------- */

function initHeadlineWords() {
  const h = document.querySelector('.hero-display');
  if (!h) return;
  if (!reduced()) h.classList.add('hw-arm');
}

/* ---- 3D card tilt (delegated, pointer:fine only) ------------------------- */

function initTilt() {
  if (reduced() || !finePointer()) return;
  const MAX = 5; // degrees
  let raf = 0;

  const apply = (card, ev) => {
    const r = card.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const px = (ev.clientX - r.left) / r.width;   // 0..1
    const py = (ev.clientY - r.top) / r.height;   // 0..1
    card.style.setProperty('--rx', `${((py - 0.5) * -2 * MAX).toFixed(2)}deg`);
    card.style.setProperty('--ry', `${((px - 0.5) *  2 * MAX).toFixed(2)}deg`);
    card.style.setProperty('--mx', `${(px * 100).toFixed(1)}%`);
    card.style.setProperty('--my', `${(py * 100).toFixed(1)}%`);
  };

  document.addEventListener('pointermove', (ev) => {
    const card = ev.target?.closest?.('.card, .hero-stat');
    if (raf) cancelAnimationFrame(raf);
    if (!card || !card.closest('main, #hero')) return;
    raf = requestAnimationFrame(() => { raf = 0; apply(card, ev); });
  }, { passive: true });

  document.addEventListener('pointerout', (ev) => {
    const card = ev.target?.closest?.('.card, .hero-stat');
    if (card && !card.contains(ev.relatedTarget)) {
      card.style.setProperty('--rx', '0deg');
      card.style.setProperty('--ry', '0deg');
    }
  }, { passive: true });
}

/* ---- cursor spotlight ----------------------------------------------------- */

function initSpotlight() {
  const glow = document.getElementById('cursor-glow');
  if (!glow) return;
  if (reduced() || !finePointer()) { glow.remove(); return; }
  let raf = 0, x = -9999, y = -9999;
  document.addEventListener('pointermove', (ev) => {
    x = ev.clientX; y = ev.clientY;
    if (!raf) {
      raf = requestAnimationFrame(() => {
        raf = 0;
        glow.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%)`;
      });
    }
  }, { passive: true });
  document.addEventListener('pointerleave', () => {
    glow.style.transform = 'translate(-9999px, -9999px)';
  });
}

/* ---- section nav dots (scrollspy) ---------------------------------------- */

const DOT_LABELS = {
  hero: 'Top', headline: 'Pulse', live: 'Live', journey: 'The journey',
  calculator: 'My timeline', similar: 'Similar cases', wave: 'Approval wave',
  trends: 'Trends', approvals: 'All approvals', calendars: 'Calendars',
  funnel: 'Funnel', rfe: 'RFE', centers: 'Centers', weekday: 'Weekdays',
  diff: 'Fresh intel', quality: 'Data quality',
};

function initDots() {
  const host = document.getElementById('section-dots');
  if (!host) return;
  _dotsSections = [...document.querySelectorAll('#hero, main > section[id]')];
  host.replaceChildren();
  for (const s of _dotsSections) {
    const a = document.createElement('a');
    a.href = `#${s.id}`;
    a.className = 'dot';
    a.dataset.for = s.id;
    a.setAttribute('aria-label', DOT_LABELS[s.id] || s.id);
    const tip = document.createElement('span');
    tip.className = 'dot-tip';
    tip.textContent = DOT_LABELS[s.id] || s.id;
    a.append(tip);
    host.append(a);
  }
  addEventListener('scroll', () => requestAnimationFrame(refreshDots), { passive: true });
  refreshDots();
}

function refreshDots() {
  const host = document.getElementById('section-dots');
  if (!host || !_dotsSections.length) return;
  const mid = innerHeight * 0.4;
  let current = _dotsSections[0];
  for (const s of _dotsSections) {
    if (s.getBoundingClientRect().top <= mid) current = s;
  }
  for (const d of host.children) {
    d.classList.toggle('active', d.dataset.for === current.id);
  }
}

/* ------------------------------------------------------------------------ */
/* SCROLL ENGINE — one rAF loop drives hero parallax, ghost titles,          */
/* journey scrub, and the starfield. Lerped for that "expensive" feel.       */
/* ------------------------------------------------------------------------ */

function initEngine() {
  if (reduced()) {
    // Honest fallback: journey fully lit, no motion anywhere.
    document.getElementById('journey')?.classList.remove('j-armed');
    return;
  }

  const hero = document.getElementById('hero');
  const copy = hero?.querySelector('.hero-copy');
  const scopeWrap = hero?.querySelector('.hero-scope-wrap');
  const journey = document.getElementById('journey');
  const ghosts = [...document.querySelectorAll('main > section[data-ghost]')];
  journey?.classList.add('j-armed');

  const stars = initStars(hero);

  const st = {
    y: scrollY, smoothY: scrollY, vel: 0,
    running: true, idleFrames: 0,
  };
  _engine = st;

  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  const frame = () => {
    const target = scrollY;
    const dy = target - st.smoothY;
    st.smoothY += dy * 0.14;                       // lerp
    st.vel += ((target - st.y) - st.vel) * 0.12;   // smoothed velocity
    st.y = target;

    // Sleep the loop when settled + tab visible work is done.
    const busy = Math.abs(dy) > 0.1 || Math.abs(st.vel) > 0.1;
    st.idleFrames = busy ? 0 : st.idleFrames + 1;

    // ---- hero parallax (only while the hero is on screen) ----
    let heroVisible = false;
    if (hero) {
      const h = hero.offsetHeight || 1;
      heroVisible = st.smoothY < h * 1.2;
      if (heroVisible) {
        const p = clamp(st.smoothY / h, 0, 1.2);
        if (copy) copy.style.transform = `translateY(${(p * 90).toFixed(1)}px)`;
        if (scopeWrap) {
          scopeWrap.style.transform =
            `translateY(${(p * -46).toFixed(1)}px) rotate(${(p * 7).toFixed(2)}deg) scale(${(1 + p * 0.06).toFixed(3)})`;
        }
        hero.style.setProperty('--hero-fade', (1 - clamp(p * 0.85, 0, 0.7)).toFixed(3));
      }
    }

    // ---- ghost titles: drift with section position, shear with velocity ----
    const skew = clamp(st.vel * 0.02, -1.6, 1.6).toFixed(2);
    for (const s of ghosts) {
      const r = s.getBoundingClientRect();
      if (r.bottom < -80 || r.top > innerHeight + 80) continue; // offscreen
      // Section center's distance from viewport center → horizontal drift.
      const d = (r.top + r.height / 2 - innerHeight / 2) / innerHeight; // ~-1..1
      s.style.setProperty('--gx', `${(d * 90).toFixed(1)}px`);
      s.style.setProperty('--gsk', `${skew}deg`);
    }

    // ---- journey scrub ----
    if (journey) scrubJourney(journey);

    // ---- starfield ----
    if (stars) stars.draw(st.smoothY, busy);

    // Stay alive while scrolling settles, or while the drifting starfield is
    // actually on screen — otherwise sleep until the next scroll.
    if (st.idleFrames < 30 || (stars && heroVisible && !document.hidden)) {
      requestAnimationFrame(frame);
    } else {
      st.running = false; // resume on next scroll
    }
  };

  addEventListener('scroll', () => {
    if (!st.running) { st.running = true; requestAnimationFrame(frame); }
  }, { passive: true });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && !st.running) { st.running = true; requestAnimationFrame(frame); }
  });

  requestAnimationFrame(frame);
}

/* ---- journey scrollytelling ------------------------------------------------ */

function scrubJourney(journey) {
  const track = journey.querySelector('.j-track');
  const rail = journey.querySelector('.j-rail-fill');
  const stages = journey.querySelectorAll('.j-stage');
  if (!track || !rail || !stages.length) return;

  const r = track.getBoundingClientRect();
  const scrollable = r.height - innerHeight;
  if (scrollable <= 0) return;
  const p = Math.min(1, Math.max(0, -r.top / scrollable));

  rail.style.transform = `scaleX(${p.toFixed(4)})`;
  const n = stages.length;
  stages.forEach((s, i) => {
    // Stage i ignites at p just before its share of the rail completes.
    const lit = p >= (i + 0.55) / n;
    if (lit && !s.classList.contains('lit')) {
      s.classList.add('lit');
      const num = s.querySelector('.j-num');
      if (num && num.dataset.target != null && !num.dataset.counted) {
        num.dataset.counted = '1';
        countTo(num, Number(num.dataset.target), num.dataset.suffix || '');
      }
    } else if (!lit && s.classList.contains('lit') && p < (i + 0.35) / n) {
      s.classList.remove('lit'); // scrub back — let the story rewind
      const num = s.querySelector('.j-num');
      if (num) { delete num.dataset.counted; num.textContent = '—'; }
    }
  });
}

/** Small local count-up (fx must not depend on ctx.countUp mid-scroll). */
function countTo(el, target, suffix) {
  if (!isFinite(target)) { el.textContent = '—'; return; }
  const t0 = performance.now(), dur = 900;
  const step = (t) => {
    const p = Math.min(1, (t - t0) / dur);
    const eased = 1 - Math.pow(1 - p, 3);
    el.textContent = Math.round(target * eased).toLocaleString() + suffix;
    if (p < 1 && el.dataset.counted) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/* Fill journey stage numbers from real data (idempotent per load). */
function fillJourney(ctx) {
  const journey = document.getElementById('journey');
  if (!journey) return;
  const cases = Array.isArray(ctx?.data?.cases) ? ctx.data.cases : [];
  const { daysBetween } = ctx.dates || {};
  const { quantileSorted } = ctx.stats || {};
  if (!cases.length || !daysBetween || !quantileSorted) return;

  const good = cases.filter(goodCase);
  const med = (arr) => arr.length ? Math.round(quantileSorted([...arr].sort((a, b) => a - b), 0.5)) : null;

  const bioDays = good
    .filter(c => c.date_applied && c.biometrics_date)
    .map(c => daysBetween(c.date_applied, c.biometrics_date))
    .filter(d => d >= 0 && d < 120);
  const regDays = good
    .filter(c => !c.premium && c.date_applied && c.date_approved && !(c.flags || []).includes('outlier_duration'))
    .map(c => daysBetween(c.date_applied, c.date_approved))
    .filter(d => d >= 0);
  const cardDays = good
    .filter(c => c.date_approved && (c.card_received || c.card_produced))
    .map(c => daysBetween(c.date_approved, c.card_received || c.card_produced))
    .filter(d => d >= 0 && d < 90);
  const ppDist = ctx.wave?.ppClockDist ? ctx.wave.ppClockDist(cases) : null;

  const set = (sel, val, suffix = '') => {
    const el = journey.querySelector(sel);
    if (!el) return;
    el.dataset.target = val == null ? '' : String(val);
    el.dataset.suffix = suffix;
    // If already lit (or reduced motion shows everything), show immediately.
    if (val != null && (el.dataset.counted || !journey.classList.contains('j-armed'))) {
      el.textContent = val.toLocaleString() + suffix;
    }
  };
  set('#j-num-filed', good.length);
  set('#j-num-bio', med(bioDays), 'd');
  set('#j-num-wait', med(regDays), 'd');
  set('#j-num-approved', good.filter(c => c.date_approved).length);

  const wait2 = journey.querySelector('#j-cap-wait');
  if (wait2 && ppDist) {
    wait2.textContent = `median days filed → approved (regular) · premium clock runs ~${Math.round(ppDist.p50)} business days`;
  }
  const cardCap = journey.querySelector('#j-cap-approved');
  if (cardCap && med(cardDays) != null) {
    cardCap.textContent = `approved so far · card typically ~${med(cardDays)}d behind`;
  }
  const liveLine = journey.querySelector('#j-live-line');
  const front = ctx.wave?.waveFront ? ctx.wave.waveFront(cases, { today: ctx.today, windowDays: 14 }) : null;
  if (liveLine && front) {
    liveLine.textContent = `→ right now the approval wave is reaching filers from ${front.appliedP50}`;
  }
}

/* ---- starfield canvas -------------------------------------------------------- */

function initStars(hero) {
  const canvas = hero?.querySelector('.hero-stars');
  if (!canvas || !canvas.getContext) return null;
  const ctx2d = canvas.getContext('2d');
  const N = 70;
  let w = 0, h = 0, dpr = 1;
  let pts = [];
  let mx = 0.5, my = 0.5;

  const size = () => {
    const r = hero.getBoundingClientRect();
    dpr = Math.min(2, devicePixelRatio || 1);
    w = Math.max(1, Math.floor(r.width));
    h = Math.max(1, Math.floor(r.height));
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (!pts.length) {
      pts = Array.from({ length: N }, (_, i) => ({
        x: hash01(`x${i}`) * w, y: hash01(`y${i}`) * h,
        vx: (hash01(`vx${i}`) - 0.5) * 0.16, vy: (hash01(`vy${i}`) - 0.5) * 0.16,
        z: 0.4 + hash01(`z${i}`) * 0.6, // depth → parallax + size
      }));
    }
  };
  size();
  addEventListener('resize', size, { passive: true });
  hero.addEventListener('pointermove', (e) => {
    const r = hero.getBoundingClientRect();
    mx = (e.clientX - r.left) / Math.max(1, r.width);
    my = (e.clientY - r.top) / Math.max(1, r.height);
  }, { passive: true });

  const color = () => {
    const dark = document.documentElement.dataset.theme !== 'light';
    return dark ? '148, 190, 255' : '30, 58, 110';
  };

  const draw = (smoothY) => {
    if (document.hidden) return;
    // Stop painting once the hero has scrolled well past.
    if (smoothY > h * 1.25) { ctx2d.clearRect(0, 0, w, h); return; }
    const rgb = color();
    ctx2d.clearRect(0, 0, w, h);
    const ox = (mx - 0.5), oy = (my - 0.5);
    for (const p of pts) {
      p.x += p.vx; p.y += p.vy;
      if (p.x < -8) p.x = w + 8; else if (p.x > w + 8) p.x = -8;
      if (p.y < -8) p.y = h + 8; else if (p.y > h + 8) p.y = -8;
      const px = p.x + ox * 26 * p.z - smoothY * 0.04 * p.z;
      const py = p.y + oy * 26 * p.z + smoothY * 0.06 * p.z;
      ctx2d.beginPath();
      ctx2d.arc(px, py, 0.8 + p.z * 1.1, 0, Math.PI * 2);
      ctx2d.fillStyle = `rgba(${rgb}, ${0.16 + p.z * 0.3})`;
      ctx2d.fill();
      p._px = px; p._py = py;
    }
    // Constellation links (near pairs only; N is small so O(N²) is fine).
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        const a = pts[i], b = pts[j];
        const dx = a._px - b._px, dy = a._py - b._py;
        const d2 = dx * dx + dy * dy;
        if (d2 < 110 * 110) {
          ctx2d.beginPath();
          ctx2d.moveTo(a._px, a._py);
          ctx2d.lineTo(b._px, b._py);
          ctx2d.strokeStyle = `rgba(${rgb}, ${(0.10 * (1 - Math.sqrt(d2) / 110)).toFixed(3)})`;
          ctx2d.lineWidth = 1;
          ctx2d.stroke();
        }
      }
    }
  };

  return { draw };
}

/* ------------------------------------------------------------------------ */
/* Data-dependent pieces (rebuilt every load)                               */
/* ------------------------------------------------------------------------ */

function goodCase(c) {
  return c && !((c.flags || []).includes('impossible_dates'));
}

/** Latest approvals, newest first, capped. */
function recentApprovals(ctx, cap) {
  const cases = Array.isArray(ctx?.data?.cases) ? ctx.data.cases : [];
  return cases
    .filter(c => goodCase(c) && c.date_approved && c.date_applied)
    .sort((a, b) => (a.date_approved < b.date_approved ? 1 : -1))
    .slice(0, cap);
}

/* ---- live approvals ticker ------------------------------------------------ */

function buildTicker(ctx) {
  const track = document.getElementById('ticker-track');
  if (!track) return;
  const { daysBetween } = ctx.dates || {};
  const items = daysBetween ? recentApprovals(ctx, 24) : [];
  const ok = items.length > 0;
  // Two-way toggle: a degraded snapshot must not hide the ticker forever
  // (render re-runs every 30min / theme flip / manual refresh).
  track.closest('.ticker')?.classList.toggle('hidden', !ok);
  if (!ok) { track.replaceChildren(); return; }

  const frag = document.createDocumentFragment();
  for (const c of items) {
    const span = document.createElement('span');
    span.className = 'tick-item';
    const days = daysBetween(c.date_applied, c.date_approved);
    const center = c.service_center || null;
    const dot = document.createElement('span');
    dot.className = 'tick-dot';
    span.append(dot, document.createTextNode(`approved ${c.date_approved} · ${days}d`));
    if (c.premium) {
      span.append(document.createTextNode(' · '));
      if (ctx.icon) { const b = ctx.icon('bolt', 11); b.style.color = 'var(--warn)'; span.append(b); }
      span.append(document.createTextNode(' premium'));
    }
    if (center) span.append(document.createTextNode(' · ' + center));
    frag.append(span);
  }

  track.replaceChildren(frag);
  track.classList.remove('scrolling');
  if (!reduced()) {
    // Seamless loop: duplicate content once; CSS animates -50%.
    track.append(...[...track.children].map(n => n.cloneNode(true)));
    track.style.animationDuration = `${items.length * 4.5}s`;
    track.classList.add('scrolling');
  }
}

/* ---- radar scope blips ----------------------------------------------------- */

/** Tiny stable string hash → [0, 1). */
function hash01(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 10000) / 10000;
}

function plotBlips(ctx) {
  const host = document.querySelector('.scope-blips');
  if (!host) return;
  const { daysBetween } = ctx.dates || {};
  if (!daysBetween) return;

  const items = recentApprovals(ctx, 26);
  if (!items.length) { host.replaceChildren(); return; }

  const days = items.map(c => daysBetween(c.date_applied, c.date_approved)).filter(d => d >= 0);
  if (!days.length) { host.replaceChildren(); return; }
  const lo = Math.min(...days), hi = Math.max(...days);
  const span = Math.max(1, hi - lo);

  const frag = document.createDocumentFragment();
  items.forEach((c, i) => {
    const d = daysBetween(c.date_applied, c.date_approved);
    if (d < 0) return;
    // Radius: faster approvals sit nearer the scope center. Angle: stable hash
    // so blips don't jump around between refreshes.
    const radius = 0.18 + 0.72 * ((d - lo) / span);          // 0.18..0.90 of scope R
    const angle = hash01(c.key || String(i)) * Math.PI * 2;
    const x = 50 + Math.cos(angle) * radius * 50;             // % of scope box
    const y = 50 + Math.sin(angle) * radius * 50;
    const b = document.createElement('span');
    b.className = 'blip';
    b.style.left = `${x.toFixed(2)}%`;
    b.style.top = `${y.toFixed(2)}%`;
    b.style.animationDelay = `${(hash01((c.key || '') + 'd') * 4).toFixed(2)}s`;
    b.title = `approved in ${d}d`;
    frag.append(b);
  });
  host.replaceChildren(frag);
}
