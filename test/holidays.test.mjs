import { test } from 'node:test';
import assert from 'node:assert/strict';
import { federalHolidays, isFederalHoliday, addBusinessDays } from '../lib/holidays.mjs';

test('Monday/Thursday-rule holidays 2026', () => {
  const h = federalHolidays(2026);
  assert.ok(h.has('2026-01-19'), 'MLK Day 2026');   // 3rd Mon Jan
  assert.ok(h.has('2026-02-16'), 'Presidents Day 2026'); // 3rd Mon Feb
  assert.ok(h.has('2026-05-25'), 'Memorial Day 2026'); // last Mon May
  assert.ok(h.has('2026-09-07'), 'Labor Day 2026');   // 1st Mon Sep
  assert.ok(h.has('2026-11-26'), 'Thanksgiving 2026'); // 4th Thu Nov
});

test('Juneteenth 2026 stays on Friday Jun 19', () => {
  const h = federalHolidays(2026);
  assert.ok(h.has('2026-06-19'));
});

test('Independence Day 2026 (Sat Jul 4) observed Fri Jul 3', () => {
  const h = federalHolidays(2026);
  assert.ok(h.has('2026-07-03'));
  assert.ok(!h.has('2026-07-04'));
});

test('Christmas 2026 stays on Friday Dec 25', () => {
  const h = federalHolidays(2026);
  assert.ok(h.has('2026-12-25'));
});

test('New Year 2027 is Friday Jan 1', () => {
  const h = federalHolidays(2027);
  assert.ok(h.has('2027-01-01'));
});

test('federalHolidays(2026) has 11 holidays', () => {
  assert.equal(federalHolidays(2026).size, 11);
});

test('isFederalHoliday', () => {
  assert.equal(isFederalHoliday('2026-05-25'), true);  // Memorial Day
  assert.equal(isFederalHoliday('2026-07-03'), true);  // observed Independence
  assert.equal(isFederalHoliday('2026-07-04'), false); // actual date, not observed
  assert.equal(isFederalHoliday('2026-06-12'), false); // ordinary Friday
});

test('addBusinessDays skips Memorial Day weekend', () => {
  // Fri 5/22 -> skip Sat/Sun -> Mon 5/25 is Memorial Day -> skip -> Tue 5/26
  assert.equal(addBusinessDays('2026-05-22', 1), '2026-05-26');
});

test('addBusinessDays skips observed Independence Day', () => {
  // Thu 7/2 -> Fri 7/3 observed Independence -> skip -> Sat/Sun skip -> Mon 7/6
  assert.equal(addBusinessDays('2026-07-02', 1), '2026-07-06');
});

test('addBusinessDays weekend-only span', () => {
  // Fri 6/5 + 5 business days, no holiday in span -> 6/12
  assert.equal(addBusinessDays('2026-06-05', 5), '2026-06-12');
});
