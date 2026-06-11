import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeOptPulse, normalizeOptTracker, dedupe, computeFlags, buildLatest, buildDiff } from '../lib/merge.mjs';

const PULSE = {
  id: 'UserA', comment_id: 'c1', reddit_url: 'https://reddit.com/x/c1',
  opt_type: 'Initial OPT', premium_processing: true,
  date_applied: '2026-01-10', rfie_date: null,
  biometrics_completed: '2026-01-20', noid: false, noid_date: null,
  date_approved: '2026-03-01', date_card_produced: null, date_card_received: null,
  pp_date: '2026-02-01', country_of_citizenship: 'India', processing_center: 'Potomac',
};

const TRACKER = {
  id: 'uuid-1', reddit_username: 'usera', init_date: '2026-01-10',
  biometrics_date: '2026-01-20', pp_date: '2026-01-10', approve_date: '2026-03-01',
  card_produce_date: '2026-03-05', delivered_date: '2026-03-10',
  nationality: null, service_center: 'potomac', type: 'initial_opt',
  premium_processing: true, source: 'reddit',
};

test('normalizeOptPulse maps fields; pp_date != applied -> upgrade', () => {
  const c = normalizeOptPulse(PULSE);
  assert.equal(c.key, 'u:usera');
  assert.equal(c.source, 'optpulse');
  assert.equal(c.opt_type, 'initial');
  assert.equal(c.premium, true);
  assert.equal(c.pp_upgrade_date, '2026-02-01'); // differs from applied -> upgrade
  assert.equal(c.pp_start, '2026-02-01');
  assert.equal(c.biometrics_date, '2026-01-20');
  assert.equal(c.service_center, 'potomac');
  assert.equal(c.nationality, 'India');
});

test('normalizeOptPulse: pp_date == applied -> premium from start, no upgrade', () => {
  const c = normalizeOptPulse({ ...PULSE, pp_date: '2026-01-10' });
  assert.equal(c.pp_upgrade_date, null);
  assert.equal(c.premium, true);
  assert.equal(c.pp_start, '2026-01-10');
});

test('normalizeOptPulse: no username -> source-id key', () => {
  const c = normalizeOptPulse({ ...PULSE, id: null });
  assert.equal(c.key, 'c:optpulse:c1');
});

test('normalizeOptTracker maps fields', () => {
  const c = normalizeOptTracker(TRACKER);
  assert.equal(c.key, 'u:usera');
  assert.equal(c.opt_type, 'initial');
  assert.equal(c.card_received, '2026-03-10');
  assert.equal(c.pp_upgrade_date, null); // pp_date == init_date
  assert.equal(c.pp_start, '2026-01-10');
});

test('normalizeOptTracker stem type', () => {
  assert.equal(normalizeOptTracker({ ...TRACKER, type: 'stem_extension' }).opt_type, 'stem');
});

test('dedupe merges by username, prefers optpulse on conflict, fills nulls', () => {
  const a = normalizeOptPulse(PULSE);            // no card dates
  const b = normalizeOptTracker(TRACKER);         // has card dates, pp_start differs
  const { cases, mergedCount, conflictCount } = dedupe([a, b]);
  assert.equal(cases.length, 1);
  assert.equal(mergedCount, 1);
  const m = cases[0];
  assert.equal(m.source, 'both');
  assert.equal(m.card_produced, '2026-03-05');     // filled from tracker
  assert.equal(m.pp_upgrade_date, '2026-02-01');   // optpulse wins conflict
  assert.ok(conflictCount >= 1);
});

test('dedupe merges keyless records by date triple', () => {
  const a = normalizeOptPulse(PULSE);
  const b = normalizeOptTracker({ ...TRACKER, reddit_username: null });
  const { cases } = dedupe([a, b]);
  assert.equal(cases.length, 1);
});

test('dedupe keeps distinct cases distinct', () => {
  const a = normalizeOptPulse(PULSE);
  const b = normalizeOptTracker({ ...TRACKER, reddit_username: 'other', init_date: '2026-02-01' });
  assert.equal(dedupe([a, b]).cases.length, 2);
});

test('computeFlags: impossible, outlier, stale', () => {
  const mk = (over) => ({ ...normalizeOptPulse(PULSE), ...over });
  const approvedFast = []; // 100 approved cases at 60 days -> p99 = 60
  for (let i = 0; i < 100; i++) approvedFast.push(mk({ key: 'u:x' + i, date_applied: '2026-01-01', date_approved: '2026-03-02', pp_upgrade_date: null }));
  const impossible = mk({ key: 'u:imp', date_applied: '2026-03-01', date_approved: '2026-01-01' });
  const outlier = mk({ key: 'u:out', date_applied: '2025-01-01', date_approved: '2026-01-01' }); // 365d
  const stale = mk({ key: 'u:stale', date_applied: '2026-01-01', date_approved: null });        // age 161d > 60
  const fresh = mk({ key: 'u:fresh', date_applied: '2026-05-20', date_approved: null, biometrics_date: null, pp_upgrade_date: null }); // age 21d
  const { cases, staleCutoff } = computeFlags([...approvedFast, impossible, outlier, stale, fresh], '2026-06-10');
  const f = (k) => cases.find(c => c.key === k).flags;
  assert.deepEqual(f('u:imp'), ['impossible_dates']);
  assert.deepEqual(f('u:out'), ['outlier_duration']);
  assert.deepEqual(f('u:stale'), ['stale_pending']);
  assert.deepEqual(f('u:fresh'), []);
  assert.equal(staleCutoff, 60);
});

test('computeFlags: future date is impossible', () => {
  const c = { ...normalizeOptPulse(PULSE), date_approved: '2027-01-01' };
  const { cases } = computeFlags([c], '2026-06-10');
  assert.ok(cases[0].flags.includes('impossible_dates'));
});

test('buildDiff reports new and newly-approved', () => {
  const prev = { cases: [
    { key: 'u:a', date_approved: null, date_applied: '2026-01-01' },
    { key: 'u:b', date_approved: '2026-02-01', date_applied: '2026-01-01' },
  ] };
  const next = { fetched_at: '2026-06-10T00:00:00Z', cases: [
    { key: 'u:a', date_approved: '2026-06-01', date_applied: '2026-01-01', reddit_url: 'r' },
    { key: 'u:b', date_approved: '2026-02-01', date_applied: '2026-01-01' },
    { key: 'u:c', date_approved: null, date_applied: '2026-06-01' },
  ] };
  const d = buildDiff(prev, next);
  assert.equal(d.new_cases, 1);
  assert.equal(d.newly_approved.length, 1);
  assert.equal(d.newly_approved[0].key, 'u:a');
  assert.equal(d.newly_approved[0].days, 151);
  const empty = buildDiff(null, next);
  assert.equal(empty.first_snapshot, true);
});
