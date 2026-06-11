import test from 'node:test';
import assert from 'node:assert/strict';
import { daysBetween, addDays, addBusinessDays } from '../lib/dates.mjs';
import { quantileSorted, naivePercentiles, kmCurve, kmSurvivalAt, kmQuantile, kmConditionalQuantile } from '../lib/stats.mjs';

test('daysBetween and addDays', () => {
  assert.equal(daysBetween('2026-01-01', '2026-01-31'), 30);
  assert.equal(daysBetween('2026-01-31', '2026-01-01'), -30);
  assert.equal(addDays('2026-01-01', 30), '2026-01-31');
});

test('addBusinessDays skips weekends', () => {
  // 2026-06-05 is a Friday; +1 business day = Monday 2026-06-08
  assert.equal(addBusinessDays('2026-06-05', 1), '2026-06-08');
  assert.equal(addBusinessDays('2026-06-05', 5), '2026-06-12');
});

test('quantileSorted', () => {
  const a = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  assert.equal(quantileSorted(a, 0.5), 6);   // floor(0.5*10)=5 -> a[5]
  assert.equal(quantileSorted(a, 0.9), 10);  // floor(9)=9 -> a[9]
  assert.equal(quantileSorted(a, 1), 10);    // clamped
  assert.equal(quantileSorted([7], 0.5), 7);
});

test('naivePercentiles sorts and maps', () => {
  const r = naivePercentiles([30, 10, 20], [0.1, 0.5, 0.9]);
  assert.deepEqual(r, { p10: 10, p50: 20, p90: 30 });
  assert.equal(naivePercentiles([], [0.5]), null);
});

// Hand-computed Kaplan-Meier example:
// obs: (5,event)(8,cens)(12,event)(16,event)(20,cens)(25,event)
// t=5:  atRisk 6, d=1, S=5/6=0.83333
// t=12: atRisk 4, d=1, S=0.83333*3/4=0.625
// t=16: atRisk 3, d=1, S=0.625*2/3=0.41667
// t=25: atRisk 1, d=1, S=0
const OBS = [
  { t: 5, event: 1 }, { t: 8, event: 0 }, { t: 12, event: 1 },
  { t: 16, event: 1 }, { t: 20, event: 0 }, { t: 25, event: 1 },
];

test('kmCurve matches hand computation', () => {
  const c = kmCurve(OBS);
  assert.deepEqual(c.map(p => p.t), [5, 12, 16, 25]);
  assert.deepEqual(c.map(p => p.atRisk), [6, 4, 3, 1]);
  const s = c.map(p => +p.S.toFixed(5));
  assert.deepEqual(s, [0.83333, 0.625, 0.41667, 0]);
});

test('kmSurvivalAt steps correctly', () => {
  const c = kmCurve(OBS);
  assert.equal(kmSurvivalAt(c, 4), 1);
  assert.equal(+kmSurvivalAt(c, 10).toFixed(5), 0.83333);
  assert.equal(+kmSurvivalAt(c, 16).toFixed(5), 0.41667);
});

test('kmQuantile = smallest t with S <= 1-p', () => {
  const c = kmCurve(OBS);
  assert.equal(kmQuantile(c, 0.25), 12); // S(12)=0.625 <= 0.75
  assert.equal(kmQuantile(c, 0.5), 16);  // S(16)=0.41667 <= 0.5
  assert.equal(kmQuantile(c, 0.99), 25);
});

test('kmQuantile null under heavy censoring', () => {
  const c = kmCurve([{ t: 10, event: 1 }, { t: 50, event: 0 }, { t: 60, event: 0 }, { t: 70, event: 0 }]);
  // S only drops to 0.75 -> median never reached
  assert.equal(kmQuantile(c, 0.5), null);
});

test('kmConditionalQuantile', () => {
  const c = kmCurve(OBS);
  // elapsed=10: S=0.83333; target S(t) <= 0.83333*0.5 = 0.41667 -> t=16
  assert.equal(kmConditionalQuantile(c, 10, 0.5), 16);
  // elapsed past last event with S=0 -> null
  assert.equal(kmConditionalQuantile(c, 25, 0.5), null);
});
