# OPT Radar — Design Spec

**Date:** 2026-06-10
**Status:** Approved by user
**Location:** `D:\Job_Hunt\opt-radar` (standalone project, isolated from career-ops)

## Purpose

Local, private analytics dashboard for OPT/STEM-OPT EAD processing timelines. Aggregates community-reported cases from two public tracker sites (which themselves parse the r/f1visa Reddit megathread), keeps daily snapshots, and answers: how fast are approvals moving, where does my case stand, and when should I realistically expect approval (best / average / worst), accounting for reporting anomalies.

User context: currently waiting on own OPT approval. Personal use only; runs entirely on localhost; no deployment, no accounts, no cost.

## Data Sources (all free, verified working 2026-06-10)

| Source | Endpoint | Contents |
|--------|----------|----------|
| opt-pulse | `https://gtbf1alsxzflqqpx.public.blob.vercel-storage.com/data/cases.json` | Single JSON dump, 1,308 cases. Fields: `id` (reddit username), `comment_id`, `reddit_url`, `opt_type`, `premium_processing`, `date_applied`, `rfie_date`, `biometrics_requested(_date)`, `biometrics_completed`, `noid(_date)`, `date_approved`, `date_card_produced`, `date_card_received`, `days_to_approval`, `pp_date`, `country_of_citizenship`, `processing_center`, `parse_status` |
| opt-tracker | `https://opt-tracker.com/api/cases?page=N` | Paginated, 15/page, ~1,000 cases, ~67 pages. Fields: `init_date`, `biometrics_date`, `pp_date`, `approve_date`, `card_produce_date`, `delivered_date`, `nationality`, `service_center`, `type`, `source` (registered/reddit), `reddit_username`, `user_hint` |
| opt-tracker | `https://opt-tracker.com/api/stats` | Precomputed histograms (reference/cross-check only) |
| Reddit | `https://www.reddit.com/r/f1visa/comments/{thread_id}.json` | Raw megathread comments. Insurance archive only — not parsed in v1. No auth required; send a custom User-Agent; tolerate rate limits |

Megathread `thread_id` is auto-discovered as the most common thread id appearing in opt-pulse `reddit_url` values. This survives the quarterly megathread rotation with no config change.

Baseline stats measured from live data (2026-06-10), used to sanity-check our own pipeline output:
- Applied dates 2024-11-19 → 2026-06-06; approvals 2026-01-02 → 2026-06-10
- 534/1308 approved (41%); 772 pending, pending median age 91 days (heavy right-censoring)
- Applied→approved days: min 4, p10 25, median 71, p90 103, max 232
- Premium median 49d vs regular 79d; PP-upgrade→approval median 29d, p90 61d
- 51% premium; 1,064 Initial OPT / 244 STEM extension; 5% RFE rate

## Architecture

Static dashboard + fetch script. Node 24+, **zero npm dependencies** (built-in `fetch`, `node:http`, `node:test`). Chart.js loaded from CDN in the browser. Vanilla JS dashboard.

```
opt-radar/
├── fetch-data.mjs        # pull all sources → snapshot → merge → latest.json
├── lib/
│   ├── merge.mjs         # normalize + dedup logic (pure functions)
│   └── stats.mjs         # Kaplan-Meier, percentiles, cohort math (pure functions)
├── serve.mjs             # static server + POST /api/refresh (runs fetch in-process)
├── dashboard/
│   ├── index.html
│   ├── app.js            # rendering, calculator, calendars
│   └── style.css
├── data/
│   ├── snapshots/YYYY-MM-DD/   # raw per-source JSON per day (optpulse.json, opttracker.json, reddit-raw.json)
│   └── latest.json             # merged, normalized, deduped dataset + metadata
├── test/                 # node --test fixtures for merge + stats
├── docs/superpowers/specs/
└── README.md             # usage + optional Task Scheduler one-liner
```

### fetch-data.mjs

1. GET opt-pulse blob (1 request).
2. Crawl opt-tracker pages with ~300ms delay between requests; stop at `total_pages`.
3. GET opt-tracker `/api/stats`.
4. Discover megathread id from opt-pulse data; GET raw Reddit thread JSON. Failure is non-fatal (log and continue).
5. Write all raw responses to `data/snapshots/{today}/`.
6. Run merge → write `data/latest.json` with `{ fetched_at, sources: {...counts/status}, cases: [...] }`.

Re-running on the same day overwrites that day's snapshot (idempotent).

### Unified case schema (latest.json)

```json
{
  "key": "stable dedup key",
  "source": "optpulse | opttracker | both",
  "reddit_username": "string|null",
  "reddit_url": "string|null",
  "opt_type": "initial | stem",
  "premium": true,
  "date_applied": "YYYY-MM-DD|null",
  "biometrics_date": "YYYY-MM-DD|null",
  "rfe_date": "YYYY-MM-DD|null",
  "pp_upgrade_date": "YYYY-MM-DD|null",
  "date_approved": "YYYY-MM-DD|null",
  "card_produced": "YYYY-MM-DD|null",
  "card_received": "YYYY-MM-DD|null",
  "service_center": "string|null",
  "nationality": "string|null",
  "flags": ["stale_pending", "outlier_duration", "impossible_dates"]
}
```

Field mapping notes: opt-pulse `pp_date` ≈ premium filing/upgrade date → `pp_upgrade_date` (when equal to `date_applied`, treat as filed-with-premium, not an upgrade). opt-tracker `init_date` → `date_applied`, `delivered_date` → `card_received`, `type: initial_opt|stem_*` → `initial|stem`.

### Dedup rules (in order)

1. Same non-null `reddit_username` (case-insensitive) across sources → merge, prefer non-null field values; if both non-null and unequal, prefer opt-pulse (richer parse) and record conflict count in metadata.
2. Else same (`date_applied`, `biometrics_date`, `date_approved`) with all three non-null → merge as above.
3. Everything else: keep as distinct case.

### serve.mjs

- Serves `dashboard/` and `data/latest.json` on `http://localhost:3777`.
- `POST /api/refresh` → imports and runs the fetch pipeline in-process, returns new metadata. Dashboard Refresh button calls this (avoids browser CORS entirely).
- No other endpoints. Binds 127.0.0.1 only.

## Dashboard features

1. **Headline cards** — earliest approval on record; 10 most recent approvals (clickable Reddit links); total cases; approved/pending counts; naive and survival-adjusted median/p10/p90; data-as-of timestamp.
2. **Calendar A — cohort completion**: month-grid calendar over applied dates; each day cell colored by % of that day's applicants approved so far (tooltip: n applied, n approved, n pending).
3. **Calendar B — approval volume**: calendar over approval dates; cell intensity = number of approvals that day.
4. **My Timeline calculator** — inputs: applied date (required), biometrics date, PP-upgrade date, opt type, premium-from-start toggle. Outputs:
   - Best (p10) / average (p50) / worst (p90) projected approval dates from the matched cohort (same type + premium status, applied within ±30 days; if cohort < 30 cases, window widens in ±15-day steps up to ±90 days, then drops the premium-status filter as a last resort; effective window and filters shown in UI).
   - **Survival-adjusted percentiles** via Kaplan-Meier: pending cases enter as right-censored at current age. Both naive and KM numbers shown, labeled.
   - **Conditional projection**: given already waited X days, percentiles of remaining wait from P(T ≤ t | T > X) on the KM curve.
   - If PP-upgrade date set: projection switches to the pp_upgrade→approval distribution; overlay marker for the USCIS 30-business-day premium clock.
   - Inputs persisted to `localStorage`.
5. **Similar cases table** — same type + premium status, `date_applied` within ±14 days of user's; columns: all stage dates, days elapsed/total, status, Reddit link; sorted by |Δ applied date|.
6. **Trend lines** — weekly application-cohort median processing time (computed only for cohorts ≥ 70% resolved, to avoid censoring distortion); approvals per week; premium-vs-regular median gap over time.
7. **Stage funnel** — median days for applied→biometrics, biometrics→approval, approval→card produced, produced→received.
8. **RFE/NOID panel** — rates and median timeline penalty (approved-with-RFE vs approved-without).
9. **Service center comparison** — any case with service-center data (both sources normalize to `service_center`; coverage is sparse, mostly opt-tracker).
10. **Day-of-week heat** — approvals by weekday.
11. **Snapshot diff** — vs previous snapshot day: newly appeared cases, newly approved, field changes. Surfaces late reporters (case pending for months suddenly shows approval).
12. **Data quality panel** — per-field null rates, censoring rate, stale-pending count, dedup merges, source conflicts, fetch errors.

## Censoring & anomaly rules

- **Impossible dates** (approval < applied, negative stage durations): flagged `impossible_dates`, excluded from all stats, listed in data quality panel.
- **Outliers** (> 300 days applied→approved): flagged, excluded from percentile charts, visible in tables.
- **Stale pending** (pending age > p99 of approved durations): flagged `stale_pending` = likely approved-but-never-updated or abandoned. Excluded from naive averages. In KM they would bias the curve downward, so KM censors them at the p99 cutoff rather than current age (documented in UI tooltip).
- Every aggregate shown in the UI states whether it is naive (approved-only) or survival-adjusted.

## Error handling

- Any source fetch failure → keep last good snapshot and `latest.json`; dashboard shows stale-data banner with last successful fetch date and which source failed.
- Schema drift (expected field missing in ≥ 20% of a source's records) → warning in fetch output + data quality panel; pipeline continues with nulls.
- Reddit archive failure → non-fatal, logged.
- Dashboard with no `latest.json` → instructive empty state ("run `node fetch-data.mjs`").

## Testing

`node --test` against fixture data (no framework):
- merge: field mapping per source, dedup by username, dedup by date-triple, conflict preference, idempotence
- stats: percentiles, KM estimator against hand-computed small example, conditional percentiles, stale-pending cutoff
- No network in tests; fixtures are trimmed real-shape JSON.

## Non-goals (v1)

- No parsing of raw Reddit comments (archive only; build parser only if source sites die).
- No public deployment, auth, or multi-user anything.
- No database — JSON snapshots are the storage.
- No automatic scheduled fetch by default (README documents an optional Windows Task Scheduler one-liner; user opts in).
- No submission of user's case to the upstream sites.

## Usage

```
node fetch-data.mjs    # pull fresh data (run any time; idempotent per day)
node serve.mjs         # → http://localhost:3777
```
