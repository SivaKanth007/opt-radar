import test from 'node:test';
import assert from 'node:assert/strict';
import { matchCohort, buildObservations } from '../lib/cohort.mjs';

function mkCase(over) {
  return {
    key: 'u:' + Math.random(), opt_type: 'initial', premium: true,
    date_applied: '2026-03-01', pp_upgrade_date: null, pp_start: '2026-03-01',
    date_approved: null, flags: [], ...over,
  };
}

test('matchCohort: tight window when enough cases', () => {
  const cases = [];
  for (let i = 0; i < 40; i++) cases.push(mkCase({ date_applied: '2026-03-0' + (1 + (i % 9)) }));
  const r = matchCohort(cases, { refDate: '2026-03-05', optType: 'initial', premium: true });
  assert.equal(r.windowDays, 30);
  assert.equal(r.premiumFilterDropped, false);
  assert.equal(r.cohort.length, 40);
});

test('matchCohort widens then drops premium filter', () => {
  const cases = [];
  for (let i = 0; i < 40; i++) cases.push(mkCase({ premium: false }));
  const r = matchCohort(cases, { refDate: '2026-03-05', optType: 'initial', premium: true });
  assert.equal(r.windowDays, 90);
  assert.equal(r.premiumFilterDropped, true);
  assert.equal(r.cohort.length, 40);
});

test('matchCohort excludes impossible-flagged and wrong type', () => {
  const cases = [
    mkCase({ flags: ['impossible_dates'] }),
    mkCase({ opt_type: 'stem' }),
    mkCase({}),
  ];
  const r = matchCohort(cases, { refDate: '2026-03-01', optType: 'initial', premium: true });
  assert.equal(r.cohort.length, 1);
});

test('buildObservations: events, censoring, stale cap', () => {
  const cohort = [
    mkCase({ date_approved: '2026-04-01' }),                       // event t=31
    mkCase({}),                                                    // censored t=40 (today 2026-04-10)
    mkCase({ date_applied: '2025-06-01' }),                        // pending age 313 -> capped at 100
    mkCase({ date_applied: '2026-05-01' }),                        // applied after today -> skipped (t<0)
  ];
  const obs = buildObservations(cohort, { today: '2026-04-10', staleCap: 100, mode: 'applied' });
  assert.deepEqual(obs, [
    { t: 31, event: 1 },
    { t: 40, event: 0 },
    { t: 100, event: 0 },
  ]);
});

test('buildObservations pp mode uses pp_start, skips non-premium', () => {
  const cohort = [
    mkCase({ pp_start: '2026-03-10', date_approved: '2026-04-09' }),  // event t=30
    mkCase({ premium: false, pp_start: null }),                        // skipped
  ];
  const obs = buildObservations(cohort, { today: '2026-06-01', staleCap: Infinity, mode: 'pp' });
  assert.deepEqual(obs, [{ t: 30, event: 1 }]);
});
