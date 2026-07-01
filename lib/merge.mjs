import { daysBetween, parseDate } from './dates.mjs';
import { quantileSorted } from './stats.mjs';

const FIELDS = ['reddit_username', 'reddit_url', 'opt_type', 'premium', 'date_applied',
  'biometrics_date', 'rfe_date', 'pp_upgrade_date', 'date_approved', 'card_produced',
  'card_received', 'service_center', 'nationality'];

function ppStart(c) {
  return c.pp_upgrade_date ?? (c.premium ? c.date_applied : null);
}

function makeKey(username, source, origId) {
  return username ? 'u:' + username.toLowerCase() : `c:${source}:${origId}`;
}

export function normalizeOptPulse(r) {
  // premium_processing is the ONLY premium signal here. opt-pulse fills pp_date
  // on ~86% of rows (vs 51% actually premium) — treating pp_date as premium
  // evidence misclassified ~35% of regular cases and starved regular cohorts.
  const premium = !!r.premium_processing;
  const c = {
    source: 'optpulse',
    reddit_username: r.id || null,
    reddit_url: r.reddit_url || null,
    opt_type: /stem/i.test(r.opt_type || '') ? 'stem' : 'initial',
    premium,
    date_applied: r.date_applied || null,
    biometrics_date: r.biometrics_completed || null,
    rfe_date: r.rfie_date || null,
    pp_upgrade_date: premium && r.pp_date && r.pp_date !== r.date_applied ? r.pp_date : null,
    date_approved: r.date_approved || null,
    card_produced: r.date_card_produced || null,
    card_received: r.date_card_received || null,
    service_center: r.processing_center ? r.processing_center.toLowerCase() : null,
    nationality: r.country_of_citizenship || null,
    flags: [],
  };
  c.key = makeKey(c.reddit_username, 'optpulse', r.comment_id);
  c.pp_start = ppStart(c);
  return c;
}

export function normalizeOptTracker(r) {
  // Same rule as opt-pulse for symmetry (in opt-tracker the two signals agree).
  const premium = !!r.premium_processing;
  const c = {
    source: 'opttracker',
    reddit_username: r.reddit_username || null,
    reddit_url: null,
    opt_type: /stem/i.test(r.type || '') ? 'stem' : 'initial',
    premium,
    date_applied: r.init_date || null,
    biometrics_date: r.biometrics_date || null,
    rfe_date: null,
    pp_upgrade_date: premium && r.pp_date && r.pp_date !== r.init_date ? r.pp_date : null,
    date_approved: r.approve_date || null,
    card_produced: r.card_produce_date || null,
    card_received: r.delivered_date || null,
    service_center: r.service_center ? r.service_center.toLowerCase() : null,
    nationality: r.nationality || null,
    flags: [],
  };
  c.key = makeKey(c.reddit_username, 'opttracker', r.id);
  c.pp_start = ppStart(c);
  return c;
}

// Timeline fields a linked comment can assert; used for the link_partial flag.
const TIMELINE_FIELDS = ['date_applied', 'biometrics_date', 'rfe_date', 'pp_upgrade_date',
  'date_approved', 'card_produced', 'card_received'];

// Merge preference rank: comment-derived values (optpulse, or an already-merged
// 'both' record that carries them) outrank opt-tracker submissions. Without this
// rank, a record that became 'both' would lose priority to the NEXT opt-tracker
// row for the same user — the bug that made 11 rows contradict their linked comment.
const sourceRank = (s) => (s === 'opttracker' ? 1 : 0);

// second's non-null fields fill first's nulls; on conflicts, first (higher rank) wins.
function mergeRecords(a, b, counters) {
  const [first, second] = sourceRank(a.source) <= sourceRank(b.source) ? [a, b] : [b, a];
  const out = { ...first };
  for (const f of FIELDS) {
    if (out[f] == null && second[f] != null) out[f] = second[f];
    else if (out[f] != null && second[f] != null && out[f] !== second[f]) counters.conflictCount++;
  }
  out.source = first.source === second.source ? first.source : 'both';
  out.key = first.reddit_username || second.reddit_username
    ? makeKey(first.reddit_username || second.reddit_username, '', '')
    : first.key;
  out.reddit_url = first.reddit_url ?? second.reddit_url;
  out.pp_start = ppStart(out);
  // link_partial: the linked comment doesn't assert every timeline field we now
  // display (fills came from the other source). UI marks these links honestly.
  if (first.link_partial || second.link_partial) out.link_partial = true;
  const urlOwner = first.reddit_url ? first : (second.reddit_url ? second : null);
  if (urlOwner && TIMELINE_FIELDS.some(f => out[f] != null && urlOwner[f] == null)) {
    out.link_partial = true;
  }
  counters.mergedCount++;
  return out;
}

// Progress score for picking ONE row among a user's multiple same-source
// submissions (opt-tracker keeps a row per comment update). Later pipeline
// stages weigh approval/card facts far above early-stage fields.
function progressScore(c) {
  let s = 0;
  if (c.date_applied) s += 1;
  if (c.biometrics_date) s += 2;
  if (c.pp_upgrade_date) s += 2;
  if (c.rfe_date) s += 1;
  if (c.date_approved) s += 8;
  if (c.card_produced) s += 4;
  if (c.card_received) s += 4;
  if (c.service_center) s += 1;
  if (c.nationality) s += 1;
  return s;
}

function tripleKey(c) {
  return c.date_applied && c.biometrics_date && c.date_approved
    ? `${c.date_applied}|${c.biometrics_date}|${c.date_approved}` : null;
}

export function dedupe(cases) {
  const counters = { mergedCount: 0, conflictCount: 0 };
  const byUser = new Map();
  const rest = [];
  for (const c of cases) {
    if (c.reddit_username) {
      const k = c.reddit_username.toLowerCase();
      const existing = byUser.get(k);
      if (!existing) {
        byUser.set(k, c);
      } else if (existing.source === c.source && c.source === 'opttracker') {
        // Same-source duplicates = snapshots of one evolving timeline (opt-tracker
        // keeps a row per comment update). Field-merging them scrambles timelines;
        // keep the most-progressed row WHOLE instead.
        if (progressScore(c) > progressScore(existing)) byUser.set(k, c);
        counters.mergedCount++;
      } else {
        byUser.set(k, mergeRecords(existing, c, counters));
      }
    } else rest.push(c);
  }
  const byTriple = new Map();
  for (const c of byUser.values()) {
    const t = tripleKey(c);
    if (t && !byTriple.has(t)) byTriple.set(t, c);
  }
  const out = [...byUser.values()];
  for (const c of rest) {
    const t = tripleKey(c);
    if (t && byTriple.has(t)) {
      const target = byTriple.get(t);
      const merged = mergeRecords(target, c, counters);
      out[out.indexOf(target)] = merged;
      byTriple.set(t, merged);
    } else {
      out.push(c);
      if (t) byTriple.set(t, c);
    }
  }
  return { cases: out, ...counters };
}

// NOTE: mutates each case in place (assigns .flags). Callers must not hold pre-flag references.
export function computeFlags(cases, today) {
  const todayMs = parseDate(today);
  const approvedDur = [];
  for (const c of cases) {
    if (c.date_applied && c.date_approved) {
      const d = daysBetween(c.date_applied, c.date_approved);
      if (d >= 0) approvedDur.push(d);
    }
  }
  approvedDur.sort((x, y) => x - y);
  const staleCutoff = approvedDur.length ? quantileSorted(approvedDur, 0.99) : null; // null (not Infinity): survives JSON round-trip

  for (const c of cases) {
    const flags = [];
    const dates = [c.date_applied, c.biometrics_date, c.rfe_date, c.pp_upgrade_date,
      c.date_approved, c.card_produced, c.card_received].filter(Boolean);
    const anyFuture = dates.some(d => parseDate(d) > todayMs);
    const badOrder =
      (c.date_applied && c.date_approved && daysBetween(c.date_applied, c.date_approved) < 0) ||
      (c.date_applied && c.biometrics_date && daysBetween(c.date_applied, c.biometrics_date) < 0) ||
      (c.date_approved && c.card_produced && daysBetween(c.date_approved, c.card_produced) < 0) ||
      (c.card_produced && c.card_received && daysBetween(c.card_produced, c.card_received) < 0);
    if (anyFuture || badOrder) flags.push('impossible_dates');
    else if (c.date_applied && c.date_approved && daysBetween(c.date_applied, c.date_approved) > 300) {
      flags.push('outlier_duration');
    } else if (staleCutoff != null && c.date_applied && !c.date_approved && daysBetween(c.date_applied, today) > staleCutoff) {
      flags.push('stale_pending');
    }
    c.flags = flags;
  }
  return { cases, staleCutoff };
}

export function buildLatest({ optpulseRaw, opttrackerRaw, fetchedAt, today, sources }) {
  const optpulse = (optpulseRaw || []).map(normalizeOptPulse);

  // Upstream integrity guard: when opt-pulse attributes ONE comment permalink to
  // MULTIPLE records (e.g. a comment containing two people's timelines), the link
  // is ambiguous — an ambiguous link is worse than no link. Null it on all parties.
  const urlCount = new Map();
  for (const c of optpulse) if (c.reddit_url) urlCount.set(c.reddit_url, (urlCount.get(c.reddit_url) || 0) + 1);
  let urlCollisions = 0;
  for (const [url, n] of urlCount) if (n > 1) urlCollisions++;
  if (urlCollisions) {
    for (const c of optpulse) {
      if (c.reddit_url && urlCount.get(c.reddit_url) > 1) c.reddit_url = null;
    }
  }

  const normalized = [...optpulse, ...(opttrackerRaw || []).map(normalizeOptTracker)];
  const { cases, mergedCount, conflictCount } = dedupe(normalized);
  const { staleCutoff } = computeFlags(cases, today);
  return {
    fetched_at: fetchedAt,
    today,
    stale_cutoff_days: staleCutoff,
    sources: { ...sources, merged: mergedCount, conflicts: conflictCount, url_collisions: urlCollisions },
    cases,
  };
}

export function buildDiff(prevLatest, nextLatest) {
  if (!prevLatest || !Array.isArray(prevLatest.cases)) {
    return { since: null, first_snapshot: true, new_cases: 0, newly_approved: [] };
  }
  const prevByKey = new Map(prevLatest.cases.map(c => [c.key, c]));
  let newCases = 0;
  const newlyApproved = [];
  for (const c of nextLatest.cases) {
    const p = prevByKey.get(c.key);
    if (!p) { newCases++; continue; }
    if (!p.date_approved && c.date_approved) {
      newlyApproved.push({
        key: c.key, reddit_url: c.reddit_url || null,
        date_applied: c.date_applied, date_approved: c.date_approved,
        days: c.date_applied ? daysBetween(c.date_applied, c.date_approved) : null,
      });
    }
  }
  return {
    since: prevLatest.fetched_at || null, first_snapshot: false,
    new_cases: newCases, newly_approved: newlyApproved,
  };
}
