import { mkdir, readFile, writeFile, readdir, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildLatest, buildDiff } from './lib/merge.mjs';
import { localToday } from './lib/dates.mjs';

const UA = 'opt-radar/1.0 (personal local analytics)';
const OPTPULSE_URL = 'https://gtbf1alsxzflqqpx.public.blob.vercel-storage.com/data/cases.json';
const OPTTRACKER_CASES = 'https://opt-tracker.com/api/cases';
const OPTTRACKER_STATS = 'https://opt-tracker.com/api/stats';
const MAX_PAGES = 200;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function fetchJson(url, retries = 2) {
  for (let i = 0; ; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA } });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return await res.json();
    } catch (err) {
      if (i >= retries) throw err;
      await sleep(1000 * (i + 1));
    }
  }
}

export function discoverThreadId(optpulseCases) {
  const counts = new Map();
  for (const c of optpulseCases) {
    const m = (c.reddit_url || '').match(/\/comments\/([a-z0-9]+)\//i);
    if (m) counts.set(m[1], (counts.get(m[1]) || 0) + 1);
  }
  let best = null, bestN = 0;
  for (const [id, n] of counts) if (n > bestN) { best = id; bestN = n; }
  return best;
}

// Reddit blocks anonymous JSON since ~2026. With a free "script" app (data/reddit-auth.json:
// { client_id, client_secret }) we use OAuth client_credentials; without credentials we still
// try anonymously so the failure stays visible (and non-fatal) in sources.reddit.
const REDDIT_UA = 'windows:opt-radar:1.0 (personal local analytics)';

async function fetchRedditThread(threadId, dataDir) {
  let auth = null;
  try {
    const raw = JSON.parse(await readFile(path.join(dataDir, 'reddit-auth.json'), 'utf8'));
    if (raw.client_id && raw.client_secret && !String(raw.client_id).startsWith('PASTE_')) auth = raw;
  } catch { /* no credentials file — anonymous attempt below */ }

  if (!auth) return fetchJson(`https://www.reddit.com/comments/${threadId}.json`);

  const tokenRes = await fetch('https://www.reddit.com/api/v1/access_token', {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${auth.client_id}:${auth.client_secret}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': REDDIT_UA,
    },
    body: 'grant_type=client_credentials',
  });
  if (!tokenRes.ok) throw new Error(`reddit token HTTP ${tokenRes.status}`);
  const { access_token } = await tokenRes.json();
  const res = await fetch(`https://oauth.reddit.com/comments/${threadId}.json?limit=500&depth=1`, {
    headers: { Authorization: `Bearer ${access_token}`, 'User-Agent': REDDIT_UA },
  });
  if (!res.ok) throw new Error(`reddit thread HTTP ${res.status}`);
  return res.json();
}

async function crawlOptTracker() {
  const first = await fetchJson(`${OPTTRACKER_CASES}?page=1`);
  if (!first.total_pages) console.warn('opt-tracker: total_pages missing — API shape may have changed, crawling page 1 only');
  // Page count fixed from page 1's response; mid-crawl growth is picked up on the next daily run.
  const pages = Math.min(first.total_pages || 1, MAX_PAGES);
  const all = [...(first.cases || [])];
  for (let p = 2; p <= pages; p++) {
    await sleep(300);
    const r = await fetchJson(`${OPTTRACKER_CASES}?page=${p}`);
    all.push(...(r.cases || []));
  }
  return all;
}

// Most recent prior snapshot file for a source, for fallback when today's fetch fails.
async function latestSnapshotFile(snapshotsDir, filename) {
  if (!existsSync(snapshotsDir)) return null;
  const days = (await readdir(snapshotsDir)).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().reverse();
  for (const d of days) {
    const f = path.join(snapshotsDir, d, filename);
    if (existsSync(f)) {
      try { return { data: JSON.parse(await readFile(f, 'utf8')), date: d }; } catch { /* skip corrupt/partial file */ }
    }
  }
  return null;
}

export async function run({ dataDir = path.join(import.meta.dirname, 'data'), today = localToday() } = {}) {
  const snapshotsDir = path.join(dataDir, 'snapshots');
  const dayDir = path.join(snapshotsDir, today);
  await mkdir(dayDir, { recursive: true });
  const sources = {};

  let optpulse = null;
  try {
    optpulse = await fetchJson(OPTPULSE_URL);
    await writeFile(path.join(dayDir, 'optpulse.json'), JSON.stringify(optpulse));
    sources.optpulse = { ok: true, count: optpulse.length };
  } catch (err) {
    const fb = await latestSnapshotFile(snapshotsDir, 'optpulse.json');
    optpulse = fb?.data ?? null;
    sources.optpulse = { ok: false, error: String(err), fallback: !!fb, fallback_date: fb?.date ?? null, count: optpulse?.length ?? 0 };
  }

  let opttracker = null;
  try {
    opttracker = await crawlOptTracker();
    await writeFile(path.join(dayDir, 'opttracker.json'), JSON.stringify(opttracker));
    sources.opttracker = { ok: true, count: opttracker.length };
  } catch (err) {
    const fb = await latestSnapshotFile(snapshotsDir, 'opttracker.json');
    opttracker = fb?.data ?? null;
    sources.opttracker = { ok: false, error: String(err), fallback: !!fb, fallback_date: fb?.date ?? null, count: opttracker?.length ?? 0 };
  }

  try {
    const stats = await fetchJson(OPTTRACKER_STATS);
    await writeFile(path.join(dayDir, 'opttracker-stats.json'), JSON.stringify(stats));
  } catch { /* reference only, ignore */ }

  try {
    const threadId = discoverThreadId(optpulse || []);
    if (threadId) {
      const raw = await fetchRedditThread(threadId, dataDir);
      await writeFile(path.join(dayDir, 'reddit-raw.json'), JSON.stringify(raw));
      sources.reddit = { ok: true, threadId };
    } else sources.reddit = { ok: false, error: 'no thread id discovered' };
  } catch (err) {
    sources.reddit = { ok: false, error: String(err) };
  }

  if (!optpulse && !opttracker) {
    throw new Error('All sources failed and no prior snapshots exist.');
  }

  const latestPath = path.join(dataDir, 'latest.json');
  let prev = null;
  if (existsSync(latestPath)) {
    try { prev = JSON.parse(await readFile(latestPath, 'utf8')); } catch { prev = null; }
  }

  const latest = buildLatest({
    optpulseRaw: optpulse || [], opttrackerRaw: opttracker || [],
    fetchedAt: new Date().toISOString(), today, sources,
  });
  // Schema drift check (spec): warn if a key field is null in >=20% of a source's raw records
  const drift = [];
  const checkDrift = (rows, name, fields) => {
    if (!rows || !rows.length) return;
    for (const f of fields) {
      const nulls = rows.filter(r => r[f] == null).length / rows.length;
      if (nulls >= 0.2) drift.push(`${name}.${f} null in ${Math.round(nulls * 100)}%`);
    }
  };
  checkDrift(optpulse, 'optpulse', ['date_applied', 'opt_type']);
  checkDrift(opttracker, 'opttracker', ['init_date', 'type']);
  if (drift.length) console.warn('schema drift:', drift.join('; '));
  latest.warnings = drift;

  const diff = buildDiff(prev, latest);
  // Atomic writes (tmp + rename) so the dashboard never reads a truncated JSON mid-refresh.
  const writeJsonAtomic = async (dest, obj, spaces) => {
    const tmp = dest + '.tmp';
    await writeFile(tmp, JSON.stringify(obj, null, spaces));
    await rename(tmp, dest);
  };
  await writeJsonAtomic(path.join(dataDir, 'diff.json'), diff, 1);
  await writeJsonAtomic(latestPath, latest);

  const summary = {
    cases: latest.cases.length, sources,
    new_cases: diff.new_cases, newly_approved: diff.newly_approved.length,
  };
  console.log(JSON.stringify(summary, null, 2));
  return summary;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch(err => { console.error(err); process.exit(1); });
}
