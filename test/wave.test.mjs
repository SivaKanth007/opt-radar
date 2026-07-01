import test from 'node:test';
import assert from 'node:assert/strict';
import { businessDaysBetween } from '../lib/holidays.mjs';
import { waveFront, weeklyCohorts, ppClockDist, bdHistogram, wavePosition, weekOf } from '../lib/wave.mjs';

// ---------------------------------------------------------------------------
// businessDaysBetween
// ---------------------------------------------------------------------------

test('businessDaysBetween: plain week', () => {
  // Mon 2026-06-01 -> Fri 2026-06-05 = 4 business days after Monday
  assert.equal(businessDaysBetween('2026-06-01', '2026-06-05'), 4);
});

test('businessDaysBetween: spans a weekend', () => {
  // Fri 2026-06-05 -> Mon 2026-06-08 = 1 (Sat/Sun skipped)
  assert.equal(businessDaysBetween('2026-06-05', '2026-06-08'), 1);
});

test('businessDaysBetween: skips July 4 observed (2026-07-03 Friday)', () => {
  // Thu 2026-07-02 -> Mon 2026-07-06: Fri Jul 3 = observed holiday, Sat, Sun skipped -> 1
  assert.equal(businessDaysBetween('2026-07-02', '2026-07-06'), 1);
});

test('businessDaysBetween: same day = 0; inverted = null; missing = null', () => {
  assert.equal(businessDaysBetween('2026-06-01', '2026-06-01'), 0);
  assert.equal(businessDaysBetween('2026-06-05', '2026-06-01'), null);
  assert.equal(businessDaysBetween(null, '2026-06-01'), null);
});

test('businessDaysBetween: inverse of addBusinessDays over the premium window', () => {
  // 2026-05-22 + 30 BD = 2026-07-08 (verified earlier, holiday-aware)
  assert.equal(businessDaysBetween('2026-05-22', '2026-07-08'), 30);
});

// ---------------------------------------------------------------------------
// wave analytics
// ---------------------------------------------------------------------------

const mk = (over = {}) => ({
  opt_type: 'initial', premium: false, flags: [],
  date_applied: '2026-03-20', date_approved: null,
  biometrics_date: null, pp_upgrade_date: null, pp_start: null,
  ...over,
});

test('weekOf returns ISO Monday', () => {
  assert.equal(weekOf('2026-03-25'), '2026-03-23'); // Wednesday -> Monday
  assert.equal(weekOf('2026-03-23'), '2026-03-23'); // Monday -> itself
});

test('waveFront: applied-date stats of recent approvals, regular only', () => {
  const cases = [
    mk({ date_applied: '2026-03-17', date_approved: '2026-06-25' }),
    mk({ date_applied: '2026-03-19', date_approved: '2026-06-28' }),
    mk({ date_applied: '2026-03-21', date_approved: '2026-06-30' }),
    mk({ date_applied: '2026-03-01', date_approved: '2026-05-01' }),          // outside window
    mk({ date_applied: '2026-03-18', date_approved: '2026-06-29', premium: true }), // premium excluded
    mk({ date_applied: '2026-03-18', date_approved: '2026-06-29', flags: ['impossible_dates'] }),
  ];
  const f = waveFront(cases, { today: '2026-07-01', windowDays: 14 });
  assert.equal(f.n, 3);
  assert.equal(f.appliedMin, '2026-03-17');
  assert.equal(f.appliedMax, '2026-03-21');
  assert.equal(f.appliedP50, '2026-03-19');
});

test('waveFront: null when no recent approvals', () => {
  assert.equal(waveFront([mk()], { today: '2026-07-01' }), null);
});

test('weeklyCohorts: groups by applied week, drops small weeks', () => {
  const cases = [];
  for (let d = 16; d <= 20; d++) cases.push(mk({ date_applied: `2026-03-${d}`, date_approved: d % 2 ? `2026-06-${d}` : null }));
  cases.push(mk({ date_applied: '2026-03-23' })); // lone case in its week -> dropped (minN 5)
  const rows = weeklyCohorts(cases, { minN: 5 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].week, '2026-03-16');
  assert.equal(rows[0].n, 5);
  assert.equal(rows[0].approved, 2); // days 17 and 19
  assert.equal(rows[0].firstApproval, '2026-06-17');
  assert.equal(rows[0].lastApproval, '2026-06-19');
});

test('ppClockDist: business days from pp_start, split initial vs upgraded', () => {
  const cases = [
    // initial premium: clock at bio 2026-06-01 (Mon), approved Fri 06-05 -> 4 BD
    mk({ premium: true, pp_start: '2026-06-01', biometrics_date: '2026-06-01', date_approved: '2026-06-05' }),
    // upgraded: clock 2026-06-01, approved 06-08 (Mon) -> 5 BD
    mk({ premium: true, pp_start: '2026-06-01', pp_upgrade_date: '2026-06-01', date_approved: '2026-06-08' }),
    mk({ premium: false, date_approved: '2026-06-05' }),      // regular ignored
    mk({ premium: true, pp_start: null, date_approved: '2026-06-05' }), // no clock -> ignored
  ];
  const d = ppClockDist(cases);
  assert.equal(d.n, 2);
  assert.deepEqual(d.values.initial, [4]);
  assert.deepEqual(d.values.upgraded, [5]);
  assert.equal(d.within30, 100);
  assert.equal(d.over30, 0);
});

test('ppClockDist: null on empty', () => {
  assert.equal(ppClockDist([mk()]), null);
});

test('bdHistogram: per-BD bins with overflow bucket', () => {
  const { bins, over, cap } = bdHistogram([1, 1, 30, 36, 40], 35);
  assert.equal(bins[1], 2);
  assert.equal(bins[30], 1);
  assert.equal(over, 2);
  assert.equal(cap, 35);
});

test('wavePosition: ahead / at / behind of the wave front', () => {
  const front = { appliedP50: '2026-03-19' };
  assert.equal(wavePosition(front, '2026-04-15').position, 'ahead');   // applied well after front
  assert.equal(wavePosition(front, '2026-03-25').position, 'at');      // within ±7d
  assert.equal(wavePosition(front, '2026-02-20').position, 'behind');  // front passed them
  assert.equal(wavePosition(front, '2026-03-25').deltaDays, 6);
  assert.equal(wavePosition(null, '2026-03-25'), null);
});
