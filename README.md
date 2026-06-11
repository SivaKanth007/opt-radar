# OPT Radar

Personal local OPT/EAD analytics dashboard. Pulls data from two community trackers (opt-pulse and opt-tracker, both sourced from the [r/f1visa Reddit megathread](https://reddit.com/r/f1visa) + user submissions). Computes survival-adjusted timelines and generates daily snapshots.

## Quick Start

```bash
# Fetch fresh data from opt-pulse and opt-tracker APIs
node fetch-data.mjs

# Start the dashboard server
node serve.mjs
```

Open http://localhost:3777 in your browser.

The server includes a **Refresh** button that runs `node fetch-data.mjs` via POST `/api/refresh` without stopping the server.

## Data Layout

- **`data/snapshots/YYYY-MM-DD/`** — Raw per-source JSON files from each daily run:
  - `optpulse.json` — Snapshot from opt-pulse
  - `opttracker.json` — Snapshot from opt-tracker (paginated)
  - `opttracker-stats.json` — Reference histograms (archived as-is)
  - `reddit-raw.json` — Raw megathread JSON (if discoverable; failures non-fatal)

- **`data/latest.json`** — Merged + deduplicated cases from both sources with normalized schema, computed flags, and metadata

- **`data/diff.json`** — Change summary: new cases, newly approved (vs previous snapshot), source health

*`data/` directory is gitignored; only snapshots persist locally.*

## Stats Modes

The dashboard displays two timeline estimates:

### Naive (Optimistic Bias)
Based on approved cases only. People who get approved fast report quickly; slow or pending cases stay invisible.

### Survival-Adjusted (Kaplan-Meier)
Accounts for censoring: pending cases count as "at least N days elapsed."

**Stale-Pending Rule:** Pending cases older than the p99 of approved durations are assumed approved-but-never-updated. They're censored at the p99 cutoff, effectively treating them as if they crossed that threshold.

## Automation: Windows Task Scheduler

To auto-fetch daily at 9 AM:

```powershell
schtasks /Create /SC DAILY /ST 09:00 /TN "OPT Radar fetch" /TR "node D:\Job_Hunt\opt-radar\fetch-data.mjs"
```

To remove:

```powershell
schtasks /Delete /TN "OPT Radar fetch" /F
```

## Development

- **`npm test`** — Run all unit tests (stats, merge, cohort, fetch helpers)
- **`npm run fetch`** — Alias for `node fetch-data.mjs`
- **`npm run serve`** — Alias for `node serve.mjs`

## Disclaimer

**This is community self-reported data, not USCIS official data.** The sample is biased toward Reddit-active users. Estimates are descriptive, not predictive—do not use them for legal or immigration strategy decisions. Baseline durations vary widely by nationality, service center, and FY. Always consult with an immigration attorney for case-specific advice.

Data sources:
- [opt-pulse](https://opt-pulse.com) — Community tracker
- [opt-tracker](https://opt-tracker.com) — Community tracker with approval workflow stages

