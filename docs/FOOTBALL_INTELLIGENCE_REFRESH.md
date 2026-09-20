# Football Intelligence — Daily Refresh Automation

Operational reference for `.github/workflows/football-intel-daily-refresh.yml`.
This document covers the automation layer only. The model itself (priors,
recency, opponent adjustment, shrinkage, predictive-status tagging) is
documented in `docs/TEAM_MANAGEMENT_PHASE_3.md` and is out of scope here —
this workflow never changes model methodology, only when and how a new
snapshot gets built and served.

## What it does

Every morning, and on demand:

1. Refreshes the nflverse raw caches (`fetch_raw.R --refresh`).
2. Builds a **candidate** snapshot into an isolated directory
   (`.fi-candidate/`, never inside `lib/football-intel/data/`), honoring
   whatever NFL games have actually been completed — including a partially
   played current week.
3. Validates the candidate: manifest shape (including the new
   `week_completion` block), season/week monotonicity vs the currently
   published snapshot, completed-game-count monotonicity within the same
   week, per-source lag classification, output integrity (schema, duplicate
   keys, non-finite/all-NA guards), and a structural diff against the
   currently published files (row-count bounds, team-set continuity).
4. Runs the two fast, deterministic Football Intelligence gates
   (`tests/run.R`, `adversarial_audit.R`).
5. Compares the candidate's content-hash version against the published one.
   - Same version → **NO_CHANGE**, exit successfully, nothing committed.
   - Different version → stage the six served data files (`SERVED_FILES` in the workflow; the manifest is staged with them), run the Node
     read-contract test against the staged (not yet committed) files, and
     only then commit + push to the branch that triggered the run.

The currently served snapshot is **never touched** unless every gate above
passes and there is an actual content change to publish.

## Schedule

```yaml
schedule:
  - cron: "0 13 * * *"
```

Every day, `13:00 UTC`. GitHub Actions cron is UTC and does **not** observe
daylight saving time:

```text
13:00 UTC
= 08:00 Central during CDT
= 07:00 Central during CST
```

So the job fires at 07:00–08:00 Central depending on the time of year — a
one-hour drift twice a year at the DST boundaries, which is a property of
fixed-UTC cron, not a bug. The exact minute/hour is not load-bearing.

GitHub does not guarantee the exact minute for scheduled workflows under
load — treat "every morning" as approximate, not to-the-minute.

### Why daily instead of weekly

The goal is for a completed game to reach Football Intelligence as soon as
practical, not to wait for the following Wednesday. A daily cadence means:
Thursday Night Football's result is available the next morning, each
Sunday/Monday slate compounds day over day instead of arriving as one lump on
Wednesday, and a day with genuinely nothing new (bye-heavy stretches,
off-week) is a normal, successful `NO_CHANGE` — never an error.

## Partial-week semantics

`build_snapshot.R`'s target resolution was already partial-week-safe before
this change: `through_week` is the max week present in the `pbp` cache for
the current season, and `pbp` only ever contains rows for games that have
actually been played — so the moment Thursday Night Football's plays land in
the nflverse release, `through_week` advances to that week on its own, with
or without the rest of the week's slate. `current_rating_for_metric()`
already filters `week <= through_week`, so a completed Thursday game already
flows into recency, opponent adjustment, and every other metric immediately
— no model code changed to get this behavior.

What was missing was **honesty about completeness**. The manifest now carries:

```json
"week_completion": {
  "latest_week": 2,
  "week_state": "PARTIAL",
  "games_completed_in_latest_week": 1,
  "games_scheduled_in_latest_week": 15,
  "latest_completed_game_date": "2026-09-17"
}
```

Computed by `FI$compute_week_completion()` (`analysis/football_intel/config.R`)
directly from `schedules.rds`'s authoritative `result` column — **never**
from calendar date or day-of-week. `week_state` is `COMPLETE` only when every
scheduled REG game for `latest_week` has a final result; any other state,
including zero completed games, is `PARTIAL`. A `PARTIAL` week is valid
production data, exactly like any other week — the model's existing
priors/shrinkage/confidence machinery is what protects a 1-game sample from
being overweighted, not a gate in this automation.

### Version identity — what's in the hash, and what deliberately isn't

`FI$compute_version()` hashes every served analytical/descriptive table —
`team_profile`, `player_usage_profile`, `unit_coverage_profile`,
`contextual_matchup_feature`, **and `ftn_descriptive`** — plus all five
`week_completion` semantic fields (`latest_week`, `week_state`,
`games_completed_in_latest_week`, `games_scheduled_in_latest_week`,
`latest_completed_game_date`), not just the completed-game count. That
guarantees a week going from 1 completed game to 15 gets a new
`football_intelligence_version` even in the (rare) case none of the tables
happened to visibly change, and that new FTN charting data alone — with the
other four tables unchanged — is never silently swallowed into `NO_CHANGE`
(a real gap in an earlier revision of this automation: `ftn_descriptive` was
omitted from the digest entirely). `season == season && through_week ==
through_week` is never treated as sufficient for `NO_CHANGE`.

Two things are deliberately **excluded**:

- **`generated_at`** — a wall-clock timestamp must never by itself create a
  new version, or every run would be `UPDATED` regardless of content.
  `compute_version()` doesn't even take it as a parameter.
- **`data_cutoff`** — a source reporting a newer cutoff is provenance/freshness
  metadata, not served content. Any cutoff change that actually adds
  information will, by construction, already show up in one of the hashed
  tables (a new play changes `team_game_features` → `team_profile`/usage/etc.;
  new FTN rows change `ftn_descriptive`). A cutoff bump that moves none of
  them is a no-op for every consumer of the served data, and the correct
  outcome for that is `NO_CHANGE`, not a forced republish of otherwise
  byte-identical tables.

Verified directly in `analysis/football_intel/tests/testthat/test-week-completion.R`:
identical inputs → identical version; a different completed-game count with
otherwise-identical tables → different version; different `ftn_descriptive`
content with everything else identical → different version (the specific bug
this fixes); every other `week_completion` field individually changes the
version too; and a `generated_at`-only difference cannot change it because
the function has no such parameter to leak through.

### Typical valid state

```text
pbp:            Week 2 (partial — Thursday only so far)
ngs, pfr:       Week 1
snap_counts:    Week 1
participation:  Week 1 (or entirely absent early in the week)
```

This is a normal, publishable state, not a degraded one. See "Source lag"
below for how each source's own lag is classified.

## Manual trigger

Actions → **Football Intelligence Daily Refresh** → **Run workflow**. Inputs:

- `season` / `through_week` — leave blank to let the engine's own
  availability logic resolve the target (recommended). Only set these to
  force a specific historical rebuild.
- `force_refresh` — defaults to `true` (always re-check raw sources for new
  rows). Set to `false` to rebuild from the existing cache without touching
  the network (useful if you only want to re-run validation/build).
- `force_publish` — defaults to `false`. Only set `true` to intentionally
  publish a season/week/completion state that is a *regression* vs what's
  currently served (a deliberate historical rebuild). Normal operation
  should never need this.

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
        lib/football-intel/data/receiver_progression.csv \
        lib/football-intel/data/football_intelligence_manifest.json
git commit -m "football-intel: manual refresh <season> week <week>"
git push
```

To validate a manually built snapshot against what's currently on `main`
before committing, build into a scratch root first:

```bash
bash analysis/football_intel/build_candidate.sh /tmp/fi-candidate
Rscript analysis/football_intel/validate_snapshot.R /tmp/fi-candidate/lib/football-intel/data lib/football-intel/data
node --import tsx --test test/football-intel-read.test.ts   # after copying the candidate over, before committing
```

## Source lag: expected vs broken

Different nflverse sources publish on different schedules — pbp is fastest,
participation/NGS/PFR/FTN can lag by hours to a day or two after a slate, and
some sources may have **zero** rows at all for the current season this early
in the week. `build_snapshot.R` already tracks this per-source in
`manifest.data_cutoff` (see `analysis/football_intel/config.R` and
`fetch_raw.R`'s `source_availability.rds`), and every downstream metric
already carries the model's own confidence/shrinkage for how much
current-week data it has.

The automation does **not** require every source to reach the same week.
`validate_snapshot.R` classifies every source in `FI$EXPECTED_SOURCES`
(`config.R` — the same list `fetch_raw.R` tracks availability for) into
exactly one of:

- **AT_CUTOFF** — the source has reached `through_week`.
- **EXPECTED_SOURCE_LAG** — the source is behind `through_week`, **or is
  completely absent from `data_cutoff` for the target season** (a source can
  have genuinely zero rows yet and that is still just lag, not breakage), and
  this is not a regression from a previously-achieved cutoff. Non-blocking,
  reported for visibility only.
- **BROKEN_OR_MISSING_DATA** — the source's cutoff went *backward* for the
  same season, or it disappeared entirely from `data_cutoff` after
  previously having a value. That is never just "hasn't published yet" — it
  means something regressed — and it **fails the run**.

No source's missing week is ever forward-filled, guessed, or silently
relabeled as available. The full per-source classification is written to
`validation_result.json`'s `source_classification` field and rendered in
every workflow run's Summary.

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
after every gate passes — including, as of this revision, the **Node
read-contract test running against the staged files before any commit or
push** — are the six files committed, explicitly `git add`-ed by name (never
`git add .`), and pushed. If any stage fails, the git-committed served
snapshot is never touched — the last known-good snapshot keeps serving. This
is proven on every run, not just asserted: the workflow fingerprints the six
served files' combined SHA-256 before doing anything, and a final step
(`if: always()`) fails loudly if that fingerprint changed on disk without the
run having actually reached `PUBLISHED`.

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

If the candidate's `football_intelligence_version` matches the currently
published one, the run reports **NO_CHANGE** and exits successfully with no
commit. This happens whenever nflverse hasn't published anything new since
the last run, or the newest available data resolves to a state identical to
what's already served — including the completed-game count within the
current week, which is an explicit input to the version hash (see "Partial-week
semantics" above), so this can never be a false NO_CHANGE triggered merely by
`season`/`through_week` staying the same across a partial-week's games.

## Validation gates (daily production run)

**REQUIRED DAILY GATES** (run every time, block publish on failure):
- `validate_snapshot.R` — manifest shape (incl. `week_completion`),
  season/week monotonicity, partial-week completion monotonicity (see
  below), source-lag classification, output integrity, structural diff vs
  published.
- `tests/run.R` (testthat invariants, including
  `test-week-completion.R`) — ~1s, cache-only / synthetic fixtures.
- `adversarial_audit.R` — ~30s, cache-only, deterministic (verified: 15/15
  checks pass on the same cache twice in a row with identical output).
- Node `test/football-intel-read.test.ts` — runs against the staged
  candidate **before** the commit/push step, so a TypeScript-side read
  regression blocks publication just like any R-side gate.

Partial-week-specific gates inside `validate_snapshot.R`:
1. `games_completed_in_latest_week` never decreases within the same
   (season, latest_week) in an unattended run.
2. `week_state == "COMPLETE"` never silently regresses to `"PARTIAL"` for
   the same (season, latest_week).
3. `games_completed_in_latest_week` never exceeds
   `games_scheduled_in_latest_week` (candidate-only structural check).
4. `week_state == "COMPLETE"` requires
   `games_completed_in_latest_week == games_scheduled_in_latest_week`.
5. Any week that isn't fully complete is labeled `"PARTIAL"` — never
   `"COMPLETE"` by omission.
6. The last-known-good snapshot survives a failed partial-week
   build/validate — proven by the pre/post SHA-256 fingerprint check
   described under "Publication mechanism."

All six are exercised by `test-week-completion.R` (1–5, using synthetic
schedule fixtures so they don't depend on what's actually been played when
the suite runs) and by the workflow's fingerprint step (6).

**NOT run daily** — `backtest.R` (chronology-safe walk-forward across
2021-2025, used to calibrate/certify model hyperparameters such as
`PRIOR_DECAY_LAMBDA` and `RECENCY_HALFLIFE_GAMES`). It's a development and
certification tool, not a per-run gate — it re-fits ridge regressions across
five seasons × eighteen weeks and is neither designed nor needed to run
before every daily publish.

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
`football-intel-daily-refresh` with `cancel-in-progress: false` — a second
trigger while one is running queues behind it rather than racing it or
cancelling it mid-publish.

The workflow also re-fetches `origin/main` immediately before touching any
served file (before staging, not just before pushing) and aborts with
`CONCURRENCY_ABORT` if `main` moved since checkout, rather than force-pushing
or overwriting concurrent human work.

## Inspecting the result

```bash
jq . lib/football-intel/data/football_intelligence_manifest.json
```

Key fields: `football_intelligence_version` (content-hash id),
`season` / `through_week`, `week_completion` (latest week's completeness),
`data_cutoff` (per-source), `generated_at`.

Each workflow run's **Summary** tab shows season, through_week, week
completion state and game counts, previous vs new version, generated_at,
source cutoffs, every validation gate's PASS/FAIL/WARN line, and the full
per-source `EXPECTED_SOURCE_LAG` / `BROKEN_OR_MISSING_DATA` / `AT_CUTOFF`
classification, all in one place.


---

## Phase 3.5B correction notes (current contract)

* The manual `git add` example above previously omitted `receiver_progression.csv`, the sixth served data
  file. Someone following it verbatim would have left that artifact stale while refreshing the others. The
  workflow (`SERVED_FILES`) and `validate_snapshot.R` were always correct; only this example drifted.
* `player_usage_profile.csv` `output_class`: a row whose `observed` value is absent publishes only the shrunk
  `modeled` number and is therefore `MODELED`, never `OBSERVED` (fixed in `lib_usage.R`, enforced by
  `validate_snapshot.R`, and applied by the reader until the next daily refresh republishes the artifact).
  Before this, the entire `route_participation` family (source unpublished for 2026) was labelled `OBSERVED`.
