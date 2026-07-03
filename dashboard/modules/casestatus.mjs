/**
 * dashboard/modules/casestatus.mjs — personal USCIS status watch.
 *
 * Renders into #case-status-mount (static div inside #calculator). The user
 * saves their receipt number ONCE; after that every page load re-checks the
 * status automatically — no more typing it into uscis.gov by hand.
 *
 * PRIVACY MODEL (the whole point):
 *  - The receipt number lives in THIS browser's localStorage. It is never
 *    sent to any server we run — we don't run any.
 *  - Auto-check works when the dashboard is served locally (serve.mjs relays
 *    the single request to uscis.gov because browsers can't cross-origin
 *    fetch it). On the public site we never send the number anywhere; the
 *    "Open on USCIS" button deep-links to their own result page instead.
 *
 * MODULE CONTRACT: export render(ctx). Renders are idempotent — app.js
 * re-runs every module on theme flips and 30-min refreshes, so a re-render
 * must repaint from stored state without re-hitting USCIS (30-min throttle).
 */

import {
  isValidReceipt, normalizeReceipt, maskReceipt, uscisStatusUrl,
} from '../../lib/casestatus.mjs?v=__BUILD__';

const STORE_KEY = 'opt-radar-case-watch';
const AUTO_THROTTLE_MS = 30 * 60 * 1000; // auto-check at most every 30 min
const MANUAL_THROTTLE_MS = 60 * 1000;    // "Check now" at most every 60 s

let _inFlight = false;

// ---------------------------------------------------------------------------
// Local state (localStorage only — see privacy model above)
// ---------------------------------------------------------------------------

function loadState() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    return s && typeof s.receipt === 'string' ? s : null;
  } catch { return null; }
}

function saveState(s) {
  try {
    if (s) localStorage.setItem(STORE_KEY, JSON.stringify(s));
    else localStorage.removeItem(STORE_KEY);
  } catch { /* storage off — feature degrades to per-session */ }
}

function isLocalHost() {
  return ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
}

function agoLabel(iso) {
  if (!iso) return null;
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return null;
  const min = Math.round(ms / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

// ---------------------------------------------------------------------------
// The one network call (local relay only)
// ---------------------------------------------------------------------------

async function checkNow(ctx, state, { manual = false } = {}) {
  if (_inFlight) return;
  const lastAt = state.last?.checkedAt ? Date.parse(state.last.checkedAt) : 0;
  const throttle = manual ? MANUAL_THROTTLE_MS : AUTO_THROTTLE_MS;
  if (Date.now() - lastAt < throttle) return;

  _inFlight = true;
  paint(ctx); // show "checking…"
  try {
    const r = await fetch('/api/case-status?receipt=' + encodeURIComponent(state.receipt));
    const body = await r.json().catch(() => null);
    const prev = state.last?.status || null;

    if (body && body.ok) {
      state.last = {
        status: body.status, detail: body.detail, kind: body.kind,
        source: body.source || null,
        checkedAt: body.checkedAt || new Date().toISOString(), error: null,
      };
      if (prev && prev !== body.status) {
        if (body.kind === 'approved') {
          ctx.toast?.(`🎉 Status changed: ${body.status}`, 'good');
          ctx.confetti?.();
        } else if (body.kind === 'warn' || body.kind === 'bad') {
          ctx.toast?.(`Status changed: ${body.status}`, 'warn');
        } else {
          ctx.toast?.(`Status changed: ${body.status}`, 'info');
        }
      }
    } else {
      // Keep the previous good reading; record the failure alongside it.
      const msg =
        body?.error === 'validation'
          ? 'USCIS does not recognize this receipt number.'
          : body?.error === 'blocked'
            ? 'USCIS blocks scripted checks of its status page. Use “Open on USCIS” below (one click, number pre-filled) — or connect the free official USCIS API for hands-free auto-checks (see README → Case status watch).'
            : 'USCIS did not answer — try again later or use the button below.';
      state.last = {
        ...(state.last || {}),
        checkedAt: new Date().toISOString(),
        error: msg,
      };
    }
    saveState(state);
  } catch {
    state.last = {
      ...(state.last || {}),
      checkedAt: new Date().toISOString(),
      error: 'Could not reach the local server.',
    };
    saveState(state);
  } finally {
    _inFlight = false;
    paint(ctx);
  }
}

// ---------------------------------------------------------------------------
// Paint (idempotent — rebuilds the mount's children from stored state)
// ---------------------------------------------------------------------------

function paint(ctx) {
  const { el, icon } = ctx;
  const mount = document.getElementById('case-status-mount');
  if (!mount) return;

  const state = loadState();
  mount.replaceChildren();

  const card = el('div', 'case-watch');
  const h = el('h3', 'cs-title');
  if (icon) h.append(icon('shield', 15));
  h.append(document.createTextNode(' USCIS status watch'));
  card.append(h);

  if (!state) {
    // ---- setup form -------------------------------------------------------
    card.append(el('p', 'muted cs-note',
      'Save your receipt number once: one-click status checks with the number pre-filled — ' +
      'and hands-free auto-checks on every visit once the free official USCIS API is connected.'));

    const form = el('form', 'cs-form');
    const input = el('input');
    input.type = 'text';
    input.placeholder = 'IOE1234567890';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.setAttribute('aria-label', 'USCIS receipt number');
    const btn = el('button', null, 'Watch my case');
    btn.type = 'submit';
    form.append(input, btn);

    const err = el('p', 'cs-err hidden');
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const receipt = normalizeReceipt(input.value);
      if (!isValidReceipt(receipt)) {
        err.textContent = 'That doesn’t look like a receipt number — expected 3 letters + 10 digits (e.g. IOE1234567890).';
        err.classList.remove('hidden');
        return;
      }
      const fresh = { receipt, last: null, savedAt: new Date().toISOString() };
      saveState(fresh);
      paint(ctx);
      if (isLocalHost()) checkNow(ctx, fresh, { manual: true });
    });

    card.append(form, err);
    card.append(el('p', 'muted cs-privacy',
      '🔒 Stays in this browser (localStorage). Never sent to our servers — there are none. ' +
      'Auto-check talks only to uscis.gov, via your own machine.'));
    mount.append(card);
    return;
  }

  // ---- watching -----------------------------------------------------------
  const row = el('div', 'cs-row');
  row.append(el('code', 'cs-receipt', maskReceipt(state.receipt)));
  const rowBtns = el('div', 'cs-row-btns');
  const copy = el('button', 'cs-forget', 'Copy');
  copy.type = 'button';
  copy.title = 'Copy the full receipt number (for pasting on uscis.gov)';
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(state.receipt);
      ctx.toast?.('Receipt number copied.', 'info');
    } catch { ctx.toast?.('Could not copy — clipboard blocked.', 'warn'); }
  });
  const forget = el('button', 'cs-forget', 'Forget');
  forget.type = 'button';
  forget.title = 'Delete the saved receipt number from this browser';
  forget.addEventListener('click', () => { saveState(null); paint(ctx); });
  rowBtns.append(copy, forget);
  row.append(rowBtns);
  card.append(row);

  const last = state.last;
  if (_inFlight) {
    card.append(el('p', 'muted cs-note', 'Checking uscis.gov…'));
  } else if (last?.status) {
    const pill = el('div', `cs-pill cs-${last.kind || 'pending'}`, last.status);
    card.append(pill);
    if (last.detail) card.append(el('p', 'cs-detail', last.detail));
    const meta = [];
    if (last.checkedAt) meta.push(`checked ${agoLabel(last.checkedAt) || last.checkedAt}`);
    if (last.source === 'uscis-api') meta.push('via the official USCIS API');
    meta.push(isLocalHost() ? 'auto-checks each time you open this page' : 'auto-check runs in the local app');
    card.append(el('p', 'muted cs-note', meta.join(' · ')));
    if (ctx.explain) {
      ctx.explain(pill, () => ({
        title: 'Where this status comes from',
        lines: [
          ['source', last.source === 'uscis-api' ? 'official USCIS developer API' : 'uscis.gov case status page'],
          ['checked', last.checkedAt ? last.checkedAt.replace('T', ' ').slice(0, 16) + ' UTC' : '—'],
          ['route', 'this machine → uscis.gov (no third party)'],
          ['stored in', 'this browser only'],
        ],
        note: 'The receipt number never leaves your machine except to uscis.gov itself.',
      }));
    }
    if (last.error) card.append(el('p', 'cs-err', last.error));
  } else if (last?.error) {
    card.append(el('p', 'cs-err', last.error));
  } else if (!isLocalHost()) {
    card.append(el('p', 'muted cs-note',
      'Saved. This public page never transmits your number — check with the button below, ' +
      'or run OPT Radar locally for hands-free auto-checks.'));
  }

  const actions = el('div', 'cs-actions');
  if (isLocalHost()) {
    const check = el('button', null, 'Check now');
    check.type = 'button';
    check.disabled = _inFlight;
    check.addEventListener('click', () => checkNow(ctx, state, { manual: true }));
    actions.append(check);
  }
  const open = el('a', 'btn-ghost cs-open', 'Open on USCIS ↗');
  open.href = uscisStatusUrl(state.receipt);
  open.target = '_blank';
  open.rel = 'noopener noreferrer';
  actions.append(open);
  card.append(actions);

  card.append(el('p', 'muted cs-privacy', '🔒 Stored only in this browser.'));
  mount.append(card);
}

// ---------------------------------------------------------------------------
// MODULE CONTRACT
// ---------------------------------------------------------------------------

export function render(ctx) {
  if (!ctx || typeof ctx.el !== 'function') return;
  paint(ctx);

  // Hands-free re-check on load — local only, 30-min throttled so theme
  // flips and interval refreshes don't hammer USCIS.
  const state = loadState();
  if (state && isLocalHost()) checkNow(ctx, state);
}
