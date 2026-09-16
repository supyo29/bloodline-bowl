# Football Intelligence — Weekly Refresh Automation

Operational reference for `.github/workflows/football-intel-weekly-refresh.yml`.
This document covers the automation layer only. The model itself (priors,
recency, opponent adjustment, shrinkage, predictive-status tagging) is
documented in `docs/TEAM_MANAGEMENT_PHASE_3.md` and is out of scope here —
this workflow never changes model methodology, only when and how a new
snapshot gets built and served.

## What it does

Once a week, and on demand:

1. Refreshes the nflverse raw caches (`fetch_raw.R --refresh`).
2. Builds a **candidate** snapshot into an isolated directory
   (`.fi-candidate/`, never inside `lib/football-intel/data/`).
3. Validates the candidate: manifest shape, season/week monotonicity vs the
   currently published snapshot, per-source lag classification, output
   integrity (schema, duplicate keys, non-finite/all-NA guards), and a
   structural diff against the currently published files (row-count bounds,
   team-set continuity).
4. Runs the two fast, deterministic Football Intelligence gates
   (`tests/run.R`, `adversarial_audit.R`).
5. Compares the candidate's content-hash version against the published one.
   - Same version → **NO_CHANGE**, exit successfully, nothing committed.
   - Different version → promote: copy the six served files over the real
     `lib/football-intel/data/`, commit, push to the branch that triggered
     the run.

The currently served snapshot is **never touched** unless every gate above
passes and there is an actual content change to publish.

## Schedule

```yaml
schedule:
  - cron: "0 13 * * 3"
```

GitHub Actions cron is UTC and does **not** observe daylight saving time.
`13:00 UTC` on a Wednesday lands at:

| US Central clock | UTC offset | Actual fire time (Central) |
|---|---|---|
| CDT (roughly mid-Mar–early-Nov) | UTC-5 | 08:00 |
| CST (roughly early-Nov–mid-Mar) | UTC-6 | 07:00 |

So the job fires at 07:00–08:00 Central depending on the time of year — a
one-hour drift twice a year at the DST boundaries, which is fine for a
Wednesday-morning post-MNF refresh. The exact minute/hour is not load-bearing;
adjust the cron string if a different Wednesday-morning target is preferred.

GitHub does not guarantee the exact minute for scheduled workflows under
load — treat "Wednesday morning" as approximate, not to-the-minute.

## Manual trigger

Actions → **Football Intelligence Weekly Refresh** → **Run workflow**. Inputs:

- `season` / `through_week` — leave blank to let the engine's own
  availability logic resolve the target (recommended). Only set these to
  force a specific historical rebuild.
- `force_refresh` — defaults to `true` (always re-check raw sources for new
  rows). Set to `false` to rebuild from the existing cache without touching
  the network (useful if you only want to re-run validation/build).
- `force_publish` — defaults to `false`. Only set `true` to intentionally
  publish a season/week that is *older* than what's currently served (a
  deliberate historical rebuild). Normal operation should never need this.

## Local manual refresh (outage / recovery)

```bash
Rscript analysis/football_intel/fetch_raw.R --refresh
Rscript analysis/football_intel/build_snapshot.R
Rscript analysis/football_intel/tests/run.R
Rscript analysis/football_intel/adversarial_audit.R
```

This writes directly into `lib/football-intel/data/` (the same behavior the
scripts have always had) — review the diff yourself before committing:

```bash
git status lib/football-intel/data
git add lib/football-intel/data/team_profile.csv \
        lib/football-intel/data/player_usage_profile.csv \
        lib/football-intel/data/unit_coverage_profile.csv \
        lib/football-intel/data/contextual_matchup_feature.csv \
        lib/football-intel/data/ftn_descriptive.csv \
        lib/football-intel/data/football_intelligence_manifest.json
git commit -m "football-intel: manual refresh <season> week <week>"
git push
```

To validate a manually built snapshot against what's currently on `main`
before committing, build into a scratch root first:

```bash
git stash push -- lib/football-intel/data   # keep the currently-served copy clean
bash analysis/football_intel/build_candidate.sh /tmp/fi-candidate
Rscript analysis/football_intel/validate_snapshot.R /tmp/fi-candidate/lib/football-intel/data lib/football-intel/data
git stash pop
```

## Source lag: expected vs broken

Different nflverse sources publish on different schedules — pbp is fastest,
participation/NGS/PFR/FTN can lag by hours to a day or two after a slate.
`build_snapshot.R` already tracks this per-source in `manifest.data_cutoff`
(see `analysis/football_intel/config.R` and `fetch_raw.R`'s
`source_availability.rds`), and every downstream metric already carries the
model's own confidence/shrinkage for how much current-week data it has.

The weekly automation does **not** require every source to reach the same
week. `validate_snapshot.R` classifies each source as:

- **EXPECTED_SOURCE_LAG** — the source is behind `through_week`, but this is
  the first time we've seen this season/week (i.e. the source simply hasn't
  caught up yet). Non-blocking, reported for visibility only.
- **BROKEN_OR_MISSING_DATA** — the source's cutoff went *backward* for the
  same season, or the source disappeared entirely from `data_cutoff` after
  previously having a value. That is never just "hasn't published yet" — it
  means something regressed — and it **fails the run**.

No source's missing week is ever forward-filled, guessed, or silently
relabeled as available.

## Publication mechanism

Served files (`lib/football-intel/data/*`) are committed to git and read
directly off disk at runtime by `lib/football-intel/read.ts` — this is the
existing architecture (same boundary decision as `lib/trades/r-data-providers.ts`),
not something this automation introduced. So "publish" = "commit the six
served files to the branch and push."

Candidate build and validation happen entirely outside
`lib/football-intel/data/` (`analysis/football_intel/build_candidate.sh`
builds into an isolated root via a symlinked `analysis/football_intel/`, so
the build code reads the real cache but writes its output elsewhere). Only
after every gate passes are the six files copied over the real served
directory, explicitly `git add`-ed by name (never `git add .`), and
committed. If any stage fails, nothing under `lib/football-intel/data/` is
ever touched — the last known-good snapshot keeps serving.

Repository check: `main` currently has no branch-protection rules or
rulesets (`gh api repos/supyo29/bloodline-bowl/branches/main/protection` →
404 "Branch not protected"; `.../rulesets` → `[]`), so the workflow's default
`GITHUB_TOKEN` with `contents: write` can push directly. If branch protection
is added later, re-audit this before relying on the same push path.

Vercel's GitHub integration deploys on push to whatever branch the project
has configured as production (`main`, confirmed via the linked project) —
a bot-authored push is not treated differently from a human one. This was
verified by inspecting the project's deployment history, not assumed.

## No-change behavior

If the candidate's `football_intelligence_version` (a content hash of the
served tables, per `build_snapshot.R`) matches the currently published one,
the run reports **NO_CHANGE** and exits successfully with no commit. This
happens whenever nflverse hasn't published anything new since the last run,
or the newest available data resolves to the same week already served.

## Validation gates (weekly production run)

**REQUIRED WEEKLY GATES** (run every time, block publish on failure):
- `validate_snapshot.R` — manifest shape, monotonicity, source-lag
  classification, output integrity, structural diff vs published.
- `tests/run.R` (testthat invariants) — ~1s, cache-only.
- `adversarial_audit.R` — ~30s, cache-only, deterministic (verified: 15/15
  checks pass on the same cache twice in a row with identical output).

**NOT run weekly** — `backtest.R` (chronology-safe walk-forward across
2021-2025, used to calibrate/certify model hyperparameters such as
`PRIOR_DECAY_LAMBDA` and `RECENCY_HALFLIFE_GAMES`). It's a development and
certification tool, not a per-week gate — it re-fits ridge regressions across
five seasons × eighteen weeks and is neither designed nor needed to run
before every weekly publish.

## Failure behavior

Any of `FAILED_FETCH`, `FAILED_BUILD`, `FAILED_VALIDATION`, or
`CONCURRENCY_ABORT` stops the workflow before the publish step ever runs.
The job summary reports which stage failed and why. Nothing is committed;
the currently served snapshot is unaffected. Investigate the failing step's
logs, fix the underlying issue (usually a genuinely broken upstream source,
per the lag-vs-broken distinction above), and re-run manually via
`workflow_dispatch`.

## Concurrency

All refreshes (scheduled or manual) share the concurrency group
`football-intel-weekly-refresh` with `cancel-in-progress: false` — a second
trigger while one is running queues behind it rather than racing it or
cancelling it mid-publish.

The publish step also re-fetches `origin/main` immediately before pushing and
aborts with `CONCURRENCY_ABORT` if `main` moved since checkout, rather than
force-pushing or overwriting concurrent human work.

## Inspecting the result

```bash
jq . lib/football-intel/data/football_intelligence_manifest.json
```

Key fields: `football_intelligence_version` (content-hash id),
`season` / `through_week`, `data_cutoff` (per-source), `generated_at`.

Each workflow run's **Summary** tab shows season, through_week, previous vs
new version, generated_at, source cutoffs, and every validation gate's
PASS/FAIL/WARN line in one place.
