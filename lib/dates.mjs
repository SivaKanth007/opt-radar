export const DAY = 86400000;

export function parseDate(s) {
  return s ? Date.parse(s + 'T00:00:00Z') : NaN;
}

export function daysBetween(a, b) {
  return Math.round((parseDate(b) - parseDate(a)) / DAY);
}

export function addDays(s, n) {
  return new Date(parseDate(s) + n * DAY).toISOString().slice(0, 10);
}

export function addBusinessDays(s, n) {
  let t = parseDate(s), added = 0;
  while (added < n) {
    t += DAY;
    const dow = new Date(t).getUTCDay();
    if (dow !== 0 && dow !== 6) added++;
  }
  return new Date(t).toISOString().slice(0, 10);
}

// Returns local calendar date, not UTC — intentional.
export function localToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
