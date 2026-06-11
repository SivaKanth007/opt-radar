import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

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

  if (p === '/') p = '/dashboard/index.html';
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
