import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
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

async function crawlOptTracker() {
  const first = await fetchJson(`${OPTTRACKER_CASES}?page=1`);
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
    if (existsSync(f)) return JSON.parse(await readFile(f, 'utf8'));
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
    optpulse = await latestSnapshotFile(snapshotsDir, 'optpulse.json');
    sources.optpulse = { ok: false, error: String(err), fallback: !!optpulse, count: optpulse?.length ?? 0 };
  }

  let opttracker = null;
  try {
    opttracker = await crawlOptTracker();
    await writeFile(path.join(dayDir, 'opttracker.json'), JSON.stringify(opttracker));
    sources.opttracker = { ok: true, count: opttracker.length };
  } catch (err) {
    opttracker = await latestSnapshotFile(snapshotsDir, 'opttracker.json');
    sources.opttracker = { ok: false, error: String(err), fallback: !!opttracker, count: opttracker?.length ?? 0 };
  }

  try {
    const stats = await fetchJson(OPTTRACKER_STATS);
    await writeFile(path.join(dayDir, 'opttracker-stats.json'), JSON.stringify(stats));
  } catch { /* reference only, ignore */ }

  try {
    const threadId = discoverThreadId(optpulse || []);
    if (threadId) {
      const raw = await fetchJson(`https://www.reddit.com/comments/${threadId}.json`);
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
  await writeFile(path.join(dataDir, 'diff.json'), JSON.stringify(diff, null, 1));
  await writeFile(latestPath, JSON.stringify(latest));

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
