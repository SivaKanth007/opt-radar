import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { isValidReceipt, normalizeReceipt, maskReceipt, parseCaseStatus, parseTorchResponse, uscisStatusUrl } from './lib/casestatus.mjs';

// ---------------------------------------------------------------------------
// USCIS case-status relay (local-only, privacy-first)
//
// Preferred path: the OFFICIAL USCIS developer API (developer.uscis.gov).
// The user drops their app credentials into data/uscis-auth.json (gitignored,
// like reddit-auth.json):
//   { "client_id": "...", "client_secret": "...", "environment": "production" }
// Fallback path: fetch the public status page — USCIS fronts it with
// Cloudflare bot protection, so this usually reports 'blocked'; we surface
// that honestly instead of pretending.
// ---------------------------------------------------------------------------

const TORCH = {
  production: { token: 'https://api.uscis.gov/oauth/accesstoken', base: 'https://api.uscis.gov' },
  sandbox:    { token: 'https://api-int.uscis.gov/oauth/accesstoken', base: 'https://api-int.uscis.gov' },
};
let _torchToken = null; // { token, exp, env } — memory only, never written to disk

async function loadUscisAuth() {
  try {
    const raw = await readFile(path.join(ROOT, 'data', 'uscis-auth.json'), 'utf8');
    const a = JSON.parse(raw);
    if (a && a.client_id && a.client_secret) return a;
  } catch { /* no auth file — fallback path */ }
  return null;
}

async function torchAccessToken(auth) {
  const env = auth.environment === 'sandbox' ? 'sandbox' : 'production';
  if (_torchToken && _torchToken.env === env && Date.now() < _torchToken.exp - 60_000) {
    return _torchToken.token;
  }
  const r = await fetch(auth.token_url || TORCH[env].token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: auth.client_id,
      client_secret: auth.client_secret,
    }),
    signal: AbortSignal.timeout(12000),
  });
  if (!r.ok) throw new Error(`token endpoint HTTP ${r.status}`);
  const j = await r.json();
  if (!j.access_token) throw new Error('token endpoint returned no access_token');
  const ttl = Number(j.expires_in || 1800) * 1000;
  _torchToken = { token: j.access_token, exp: Date.now() + ttl, env };
  return j.access_token;
}

async function checkViaTorch(auth, receipt) {
  const env = auth.environment === 'sandbox' ? 'sandbox' : 'production';
  const token = await torchAccessToken(auth);
  const r = await fetch(`${auth.case_url || TORCH[env].base + '/case-status'}/${receipt}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(12000),
  });
  if (r.status === 404) return { ok: false, error: 'validation', status: null, detail: null, kind: null };
  if (!r.ok) throw new Error(`case-status endpoint HTTP ${r.status}`);
  return parseTorchResponse(await r.json());
}

async function checkViaPage(receipt) {
  const r = await fetch(uscisStatusUrl(receipt), {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    signal: AbortSignal.timeout(12000),
  });
  return parseCaseStatus(await r.text());
}

const ROOT = import.meta.dirname;
const PORT = 3777;
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml',
};
// Whitelist: only these path prefixes are servable.
const ALLOWED = ['/dashboard/', '/lib/', '/data/latest.json', '/data/diff.json'];

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let p = decodeURIComponent(url.pathname);

  if (req.method === 'POST' && p === '/api/refresh') {
    try {
      const { run } = await import('./fetch-data.mjs');
      const summary = await run();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(summary));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(err) }));
    }
    return;
  }

  // Local-only USCIS case-status relay. The browser can't hit uscis.gov
  // directly (CORS), and routing a receipt number through a third-party
  // proxy would leak it — so the local server does the one fetch itself.
  // PRIVACY: the receipt is used for this single request and never stored;
  // logs only ever show the masked form.
  if (req.method === 'GET' && p === '/api/case-status') {
    const receipt = normalizeReceipt(url.searchParams.get('receipt'));
    const json = (code, body) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (!isValidReceipt(receipt)) {
      json(400, { error: 'invalid receipt format (expect 3 letters + 10 digits, e.g. IOE1234567890)' });
      return;
    }
    try {
      const auth = await loadUscisAuth();
      const parsed = auth ? await checkViaTorch(auth, receipt) : await checkViaPage(receipt);
      const source = auth ? 'uscis-api' : 'page';
      console.log(`[case-status] ${maskReceipt(receipt)} via ${source} → ${parsed.ok ? parsed.status : 'error: ' + parsed.error}`);
      json(200, { ...parsed, source, checkedAt: new Date().toISOString() });
    } catch (err) {
      console.log(`[case-status] ${maskReceipt(receipt)} → failed: ${err?.name || ''} ${String(err?.message || err).slice(0, 120)}`);
      json(502, { ok: false, error: 'uscis-unreachable', detail: String(err?.message || err) });
    }
    return;
  }

  // Redirect / to /dashboard/ so the page's relative asset URLs (app.js, style.css) resolve inside the whitelist.
  if (p === '/') {
    res.writeHead(302, { Location: '/dashboard/' });
    res.end();
    return;
  }
  if (p === '/dashboard/') p = '/dashboard/index.html';
  if (!ALLOWED.some(a => a.endsWith('/') ? p.startsWith(a) : p === a)) {
    res.writeHead(404); res.end('not found'); return;
  }
  const file = path.normalize(path.join(ROOT, p));
  if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404); res.end('not found');
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`OPT Radar → http://localhost:${PORT}`);
});
