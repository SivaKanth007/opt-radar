// US federal holiday engine. Pure, browser-safe (no node: imports).
// Dates parsed as UTC midnight to avoid timezone drift, like lib/dates.mjs.

const DAY = 86400000;

function parseUTC(s) {
  return Date.parse(s + 'T00:00:00Z');
}

function fmt(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

// Date of the nth given weekday in a month. weekday: 0=Sun..6=Sat. n: 1-based.
function nthWeekday(year, month /* 0-based */, weekday, n) {
  const first = new Date(Date.UTC(year, month, 1));
  const firstDow = first.getUTCDay();
  const offset = (weekday - firstDow + 7) % 7;
  const day = 1 + offset + (n - 1) * 7;
  return new Date(Date.UTC(year, month, day));
}

// Date of the last given weekday in a month.
function lastWeekday(year, month, weekday) {
  const last = new Date(Date.UTC(year, month + 1, 0)); // last day of month
  const lastDow = last.getUTCDay();
  const offset = (lastDow - weekday + 7) % 7;
  return new Date(Date.UTC(year, month, last.getUTCDate() - offset));
}

// Weekend-shift rule for FIXED-DATE holidays:
// Saturday -> preceding Friday; Sunday -> following Monday.
function observedFixed(year, month, day) {
  const d = new Date(Date.UTC(year, month, day));
  const dow = d.getUTCDay();
  if (dow === 6) return new Date(d.getTime() - DAY); // Sat -> Fri
  if (dow === 0) return new Date(d.getTime() + DAY); // Sun -> Mon
  return d;
}

const cache = new Map();

export function federalHolidays(year) {
  const cached = cache.get(year);
  if (cached) return cached;

  const set = new Set();
  const add = (d) => set.add(d.toISOString().slice(0, 10));

  // Fixed-date holidays (with weekend shift)
  add(observedFixed(year, 0, 1));   // New Year's Day — Jan 1
  add(observedFixed(year, 5, 19));  // Juneteenth — Jun 19
  add(observedFixed(year, 6, 4));   // Independence Day — Jul 4
  add(observedFixed(year, 10, 11)); // Veterans Day — Nov 11
  add(observedFixed(year, 11, 25)); // Christmas — Dec 25

  // Floating Monday/Thursday holidays (never need shifting)
  add(nthWeekday(year, 0, 1, 3));   // MLK Day — 3rd Mon Jan
  add(nthWeekday(year, 1, 1, 3));   // Presidents Day — 3rd Mon Feb
  add(lastWeekday(year, 4, 1));     // Memorial Day — last Mon May
  add(nthWeekday(year, 8, 1, 1));   // Labor Day — 1st Mon Sep
  add(nthWeekday(year, 9, 1, 2));   // Columbus Day — 2nd Mon Oct
  add(nthWeekday(year, 10, 4, 4));  // Thanksgiving — 4th Thu Nov

  cache.set(year, set);
  return set;
}

export function isFederalHoliday(dateStr) {
  const year = new Date(parseUTC(dateStr)).getUTCFullYear();
  return federalHolidays(year).has(dateStr);
}

export function addBusinessDays(start, n) {
  let t = parseUTC(start);
  let added = 0;
  while (added < n) {
    t += DAY;
    const d = new Date(t);
    const dow = d.getUTCDay();
    if (dow === 0 || dow === 6) continue;
    if (federalHolidays(d.getUTCFullYear()).has(fmt(t))) continue;
    added++;
  }
  return fmt(t);
}

// Business days strictly after `start`, up to and including `end` — the USCIS
// clock convention (day the clock starts is day 0, next business day is 1).
// Returns null when end < start or either date is missing/invalid.
export function businessDaysBetween(start, end) {
  if (!start || !end) return null;
  let t = parseUTC(start);
  const stop = parseUTC(end);
  if (!isFinite(t) || !isFinite(stop) || stop < t) return null;
  let n = 0;
  while (t < stop) {
    t += DAY;
    const d = new Date(t);
    const dow = d.getUTCDay();
    if (dow === 0 || dow === 6) continue;
    if (federalHolidays(d.getUTCFullYear()).has(fmt(t))) continue;
    n++;
  }
  return n;
}
