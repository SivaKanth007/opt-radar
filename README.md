# OPT Radar

Community analytics dashboard for **OPT / STEM-OPT EAD processing timelines**. Merges case data from two public community trackers ([opt-pulse](https://opt-pulse.vercel.app) and [opt-tracker](https://opt-tracker.com), both ultimately sourced from the [r/f1visa](https://reddit.com/r/f1visa) timeline megathread and user submissions), deduplicates across sources, and computes both naive and **survival-adjusted (Kaplan-Meier)** timeline estimates.

**Live dashboard:** https://sivakanth007.github.io/opt-radar/ — auto-updates hourly via GitHub Actions.

## Features

- Headline stats: earliest/latest approvals, p10/p50/p90 days (naive *and* survival-adjusted)
- Two calendars: per-application-date approval completion %, and approvals-per-day volume
- **My Timeline calculator** — enter your applied / biometrics / premium-upgrade dates, get best/typical/worst projected approval dates from a matched cohort, plus conditional estimates ("given you've already waited N days")
- Similar-cases table with links to the original Reddit reports
- **Approval wave** — where the regular queue front is right now ("filers who applied ~Mar 19 are getting approved this week"), plus the premium **30-business-day clock**: histogram of business days from clock start (biometrics for premium-from-start, upgrade date for upgrades) to approval
- Weekly trends, stage funnel, RFE impact, service-center comparison, approvals by weekday
- Data-quality panel: censoring rates, anomaly flags, source health

## Run Locally

Requires Node.js 24+. No npm dependencies.

```bash
node fetch-data.mjs   # pull fresh data from both trackers (~35s, idempotent per day)
node serve.mjs        # dashboard at http://localhost:3777
```

The local server adds a **Refresh** button (POST `/api/refresh`) that re-runs the fetch without restarting.

## Data Layout

- `data/snapshots/YYYY-MM-DD/` — raw per-source JSON per day (`optpulse.json`, `opttracker.json`, `opttracker-stats.json`, `reddit-raw.json` when available)
- `data/latest.json` — merged, deduplicated, normalized dataset + metadata
- `data/diff.json` — changes vs the previous run (new cases, newly approved)

`data/` is gitignored — snapshots persist only on the machine that runs the fetch. The hosted copy regenerates data in CI each hour.

## Stats Modes

**Naive** — approved cases only. Optimistically biased: people who get approved fast report fast; slow and pending cases are invisible.

**Survival-adjusted (Kaplan-Meier)** — pending cases enter as right-censored ("at least N days"). **Stale-pending rule:** pending cases older than the p99 of approved durations are likely approved-but-never-updated; they are censored at that cutoff instead of their raw age.

Both numbers are always shown side by side, labeled.

## Optional: Reddit Raw Archive

The fetch also tries to archive the raw megathread JSON as insurance. Reddit requires OAuth for this: create a free **script** app (after [registering for Data API access](https://support.reddithelp.com/hc/en-us/requests/new?ticket_form_id=14868593862164)), then put your credentials in `data/reddit-auth.json`:

```json
{
  "client_id": "YOUR_CLIENT_ID",
  "client_secret": "YOUR_CLIENT_SECRET"
}
```

The file is gitignored. Without it the archive step fails gracefully — all dashboard analytics work regardless.

## Scheduled Fetch (local)

Windows Task Scheduler example (run from the project directory):

```powershell
schtasks /Create /SC DAILY /ST 09:00 /TN "OPT Radar fetch" /TR "node %CD%\fetch-data.mjs"
```

The hosted copy needs no scheduling — `.github/workflows/pages.yml` fetches and redeploys hourly.

## Development

```bash
npm test    # unit tests: stats (KM math), merge/dedup, cohort matching, fetch helpers
```

## Disclaimer

**Community self-reported data, not USCIS data.** The sample is biased toward Reddit-active applicants. Estimates are descriptive, not predictive — do not use them for legal or immigration decisions. Consult an immigration attorney for case-specific advice.
