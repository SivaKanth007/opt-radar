import { daysBetween } from './dates.mjs';

const MIN_COHORT = 30;

// PAIRING CONTRACT: matchCohort({dateField:'date_applied'}) pairs with buildObservations({mode:'applied'});
// {dateField:'pp_start'} pairs with {mode:'pp'}. Mixing silently degrades cohorts. refDate must be non-null.
export function matchCohort(cases, { refDate, optType, premium, dateField = 'date_applied' }) {
  const base = cases.filter(c =>
    c[dateField] && c.opt_type === optType && !(c.flags || []).includes('impossible_dates')
    && !(c.flags || []).includes('outlier_duration')); // outliers excluded from percentile cohorts (spec)
  const within = (w, usePremium) => base.filter(c =>
    Math.abs(daysBetween(refDate, c[dateField])) <= w && (!usePremium || c.premium === premium));

  let windowDays = 30;
  let cohort = within(windowDays, true);
  while (cohort.length < MIN_COHORT && windowDays < 90) {
    windowDays += 15;
    cohort = within(windowDays, true);
  }
  let premiumFilterDropped = false;
  if (cohort.length < MIN_COHORT) {
    premiumFilterDropped = true;
    cohort = within(90, false);
    windowDays = 90;
  }
  return { cohort, windowDays, premiumFilterDropped };
}

// mode 'applied': clock starts at date_applied. mode 'pp': clock starts at pp_start.
export function buildObservations(cohort, { today, staleCap, mode = 'applied' }) {
  const obs = [];
  for (const c of cohort) {
    const start = mode === 'pp' ? c.pp_start : c.date_applied;
    if (!start) continue;
    if (c.date_approved) {
      const t = daysBetween(start, c.date_approved);
      if (t >= 0) obs.push({ t, event: 1 });
    } else {
      let t = daysBetween(start, today);
      if (t < 0) continue;
      if (Number.isFinite(staleCap) && t > staleCap) t = staleCap;
      obs.push({ t, event: 0 });
    }
  }
  return obs;
}
