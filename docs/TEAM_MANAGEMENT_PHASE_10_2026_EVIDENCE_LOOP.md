# Team Management — Phase 10: 2026 Evidence Loop

**Branch:** `team-management-phase10-evidence-loop`  
**Parent baseline:** `main` @ `896e22b`  
**Roadmap:** #18  
**Phase issue:** #19  
**Deployment lane:** DATA / VALIDATION INFRASTRUCTURE ONLY  
**Status:** CHECKPOINTS A–B IMPLEMENTED — NOT MERGED / NOT DEPLOYED

## 1. Why Phase 10 exists

The Team Management and Competitive Trade stacks are already feature-rich. The in-season bottleneck is now evidence freshness, not another scoring formula.

Football Intelligence already has a `{targets}` graph and Player × Scheme already knows how to rebuild its descriptive and shadow artifacts. The missing piece was a single, auditable process that refreshes the nflverse cache after games, rebuilds both systems in dependency order, proves the outputs tell a coherent freshness story, and records exactly what evidence changed.

Before Phase 10, the critical raw refresh remained a manual sequence:

```bash
Rscript analysis/football_intel/fetch_raw.R --refresh
Rscript -e 'targets::tar_make()'
```

Player × Scheme then required separate source-audit and Tier A–D commands. That separation is useful for research, but it is too easy for an in-season operator to refresh one layer and forget another, or to mistake a partially rebuilt artifact set for a coherent current-season snapshot.

Phase 10 makes the refresh atomic from the operator's point of view while preserving every existing model boundary.

## 2. Non-negotiable invariants

Phase 10 MUST NOT:

1. change fantasy scoring;
2. change any production projection formula;
3. change model weights automatically;
4. promote Start/Sit, Matchup, or Player × Scheme shadow findings into production;
5. change the frozen Phase 9 `numeric_fantasy_adjustment == 0` behavior;
6. execute fantasy transactions;
7. change Sleeper/Yahoo provider semantics;
8. treat stale or prior-only evidence as a current-season observation.

A successful data refresh and a successful model promotion are deliberately different events.

## 3. Checkpoint A — orchestration foundation ✅

Checkpoint A adds `scripts/weekly-evidence-refresh.sh` and package commands:

```bash
npm run evidence:refresh
npm run evidence:certify
```

`evidence:refresh` performs the in-season R evidence loop. `evidence:certify` performs the same loop and then runs the full TypeScript repository regression.

### 3.1 Dependency order

The runner executes serially and stops at the first failure:

1. refresh nflverse raw cache;
2. rebuild Football Intelligence through the existing `{targets}` graph;
3. re-run the Player × Scheme source audit;
4. rebuild Player × Scheme Tier A;
5. rebuild Tier B;
6. rebuild Tier C;
7. rebuild Tier D, still shadow-only;
8. prove both served manifests exist;
9. run the Phase 10 freshness gate;
10. run Tier A's R invariant test directly;
11. run Tier D's synthetic R test directly.

With `--full-regression`, it then runs `npm test`, `npm run typecheck`, and `npm run lint`.

### 3.2 Fail-closed R test behavior

The Phase 9 convenience runner invokes child `Rscript` processes with `system2()` but does not inspect/propagate the returned child status. It remains untouched because Phase 9 is frozen.

Phase 10 invokes the child R test files directly. A non-zero child exit is therefore a non-zero evidence-loop exit, and no later stage is permitted to make the run look successful.

### 3.3 Run ledger

An evidence execution writes:

```text
artifacts/evidence-loop/<UTC_RUN_ID>.json
artifacts/evidence-loop/<UTC_RUN_ID>-freshness.json
artifacts/evidence-loop/latest.json
```

The run report contains the UTC run window, git SHA, PASS/FAIL, failed stage, each stage's status, whether full regression was requested, source audit before/after when available, the freshness-gate result, and the resulting FI/PSI manifests.

This is an evidence ledger, not a model-performance ledger. Outcome scoring belongs to the separate Outcome Audit/Calibration phase.

## 4. Checkpoint B — current-season freshness gate ✅

Checkpoint B adds `scripts/evidence-freshness-gate.mjs` and:

```bash
npm run evidence:check
```

The gate consumes the generated source audit plus the served Football Intelligence and Player × Scheme manifests. It is deliberately independent of projection logic.

### 4.1 Source-state invariants

For every source in the source audit:

- `current_season_rows > 0` requires `availability_state == LIVE_CURRENT`;
- zero current-season rows cannot be stamped `LIVE_CURRENT`;
- when current-season rows exist, `last_available` must identify that current season;
- if a pre-refresh source audit exists, a source season/week cutoff may not move backward;
- a source that previously had current-season rows may not silently lose all of them.

A valid refresh with unchanged source cutoffs is classified `NO_NEW_DATA`, not `ERROR`. A first run without a comparable pre-refresh audit is `BASELINE_UNAVAILABLE`.

### 4.2 PBP → FI/PSI alignment

PBP is the live-capable backbone. Therefore:

- if 2026 PBP rows exist, the rebuilt Football Intelligence manifest must target 2026;
- if 2026 PBP rows exist, the Player × Scheme top-level manifest must be 2026 + `LIVE_CURRENT`;
- FI/PSI may never claim a week beyond the audited PBP cutoff;
- if 2026 PBP rows do not exist, Player × Scheme may not claim `LIVE_CURRENT`.

This is the machine-enforced version of the project's rule that “current” must be proved by current data.

### 4.3 Lagging charting isolation

Participation and FTN are checked independently from PBP. If either has zero 2026 rows, the corresponding Tier B families must continue reporting `current_season_observed: false` and may not report `LIVE_CURRENT`.

This prevents the most dangerous freshness error in the architecture: a live PBP refresh accidentally making stale man/zone, route, formation, pressure, box, motion, play-action, or FTN charting look current.

### 4.4 Shadow-promotion invariant

Every evidence refresh reasserts:

```text
fantasy_adjustment_enabled == false
tier_d.lane == SHADOW_ONLY
tier_d.numeric_fantasy_adjustment == 0
```

If a future code change accidentally promotes Player × Scheme while this phase is only trying to refresh evidence, the refresh fails.

### 4.5 Regression fixtures

`test/evidence-freshness-gate.test.ts` covers at least these cases:

- coherent prior-only preseason state → PASS;
- live 2026 PBP + still-stale participation/FTN → PASS;
- fake PSI `LIVE_CURRENT` with zero 2026 PBP → FAIL;
- source cutoff moves backward → FAIL;
- accidental Player × Scheme predictive promotion → FAIL.

These tests are part of the normal `npm test` glob and therefore part of `evidence:certify`.

## 5. Metadata debt — FIXED in Checkpoint C

`analysis/player_scheme_intelligence/source_audit.R` previously emitted an
`as_of_note` sentence hard-coded to say that zero 2026 rows are cached. The
machine fields (`current_season_rows`, `last_available`, `availability_state`)
were already dynamic and are what the Phase 10 gate trusts, but the prose note
would become false once 2026 data arrived.

**Fix (metadata/reporting only — no Phase 9 calculation, feature, weight, lane,
or predictive-eligibility change):** `build_as_of_note(sources, cur)` now derives
the sentence entirely from cached per-source row counts. It reports one of:
zero current rows anywhere (canonical phrase "0 rows of any …"); *N of M*
sources current, naming the current sources (with rows + last week) and the
still-`PRIOR_ONLY` ones; or all sources current. It never consults the calendar
date; a source with no current-season rows is always described as `PRIOR_ONLY`.

**Regression guard:** `scripts/evidence-freshness-gate.mjs` gained three ERROR
checks — `AUDIT_AS_OF_NOTE_PRESENT`, `AUDIT_AS_OF_NOTE_NOT_STALE` (the note may
not claim "0 rows of any" while a source has current rows — the exact regression
of the old bug), `AUDIT_AS_OF_NOTE_ACKNOWLEDGES_PRIOR_ONLY` — plus two
`test/evidence-freshness-gate.test.ts` fixtures.

## 6. Checkpoint C — real 2026 certification + repeatable runner

### 6.1 Ingest window — held at 2025 (blocked by a frozen-FI defect)

Validation against the live nflverse environment (2026-09-10, NFL Week 1 in
progress: 166 PBP plays, ~4 NGS rows, 93 snap rows for 2026; participation / FTN
/ PFR 404) confirmed real 2026 PBP exists. The FI/PSI ingest windows
(`FI$*_SEASONS`, `PSI$*_SEASONS`) are frozen at `…:2025`, so `fetch_raw.R
--refresh` does not request them.

A trial extension to `…:SEASON_CURRENT` was made and **reverted** because it
surfaced that the **frozen Phase 3 Football Intelligence engine is not
week-1-safe**. With `target_week` resolving to `2026-w1` (one game):

* `analysis/football_intel/lib_profiles.R` → `compute_metric_profile` calls
  `%>% select()` on a `NULL` current-season table → *"no applicable method for
  'select' applied to an object of class NULL"*.
* `build_coverage_allowed_profile` → *"Join columns in `x` must be present in the
  data. Problem with `defense_team` and `grp`"* + unexpected many-to-many joins.

These are genuine defects, but in **frozen Phase 3 model code**, and making the
engine robust to a 1-week current season is a dedicated FI change with its own
backtest/audit — explicitly out of scope for a Phase 10 evidence checkpoint
(§2, and the roadmap's "no model-development" rule).

**Consequence:** until that FI change lands, the evidence loop refreshes
2012-2025 and every 2026 source is reported `PRIOR_ONLY` — which is the
**truthful** state (the loop is honest about not having ingested current data),
just not the *live* state issue #19 ultimately wants. Tracked as **P1**.
`fetch_raw.R --refresh` still re-pulls any 2025 revisions nflverse publishes, so
the loop is not inert.

### 6.1a Fail-closed hardening (defect fix, in scope)

The trial run also exposed that `_targets.R`'s `fi_snapshot` target publishes via
`system2("Rscript", build_snapshot.R)` **without checking the child exit code**
(frozen Phase 3), so a `build_snapshot.R` crash leaves a stale served manifest
while `tar_make()` still marks the target complete. Phase 10 already solved the
identical problem for the R tests by invoking children directly (§3.2); the
runner now does the same for the snapshot publish — a new
`football_intel.publish_snapshot` stage runs `build_snapshot.R` directly, so its
exit code is the runner's exit code. (Touches only `scripts/weekly-evidence-refresh.sh`.)

### 6.2 Clean-runner dependency audit

`docs/EVIDENCE_LOOP_RUNTIME.md` lists the exact R packages (derived from source),
Node/npm, and OS requirements. `scripts/bootstrap-r-deps.R` installs the audited
CRAN set idempotently (plain installer — no `renv`). `arrow`/`readr` are
confirmed **not** needed.

### 6.3 Manual CI

`.github/workflows/evidence-2026-manual-certification.yml` — **`workflow_dispatch`
only, no cron**. Sets up R (`r-lib/actions/setup-r`, public RSPM) + Node 22,
runs `scripts/bootstrap-r-deps.R` + `npm ci`, executes `npm run evidence:certify`
(fails the job on any failing stage), records a pre/post served-artifact
checksum diff, and uploads the evidence-loop report + freshness report +
manifests + `source_audit.json` + artifact diff. It never commits, pushes,
merges, deploys, promotes a model, or executes a transaction (`permissions:
contents: read`).

> GitHub only dispatches a `workflow_dispatch` workflow whose file is present on
> the **default branch**. This workflow is inert (dispatch-only, read-only
> perms); enabling it therefore requires landing this one file on `main` first.

A weekly cron is a **separate tiny follow-up**, allowed only after one green real
2026 manual CI run.

### 6.4 Real local certification result

`npm run evidence:certify` executed end to end against the live 2026 R/nflverse
environment (2026-09-13, run `20260913T022421Z`): **all 16 stages PASS, exit 0**
(`artifacts/evidence-loop/latest.json`). Freshness gate: `PASS (NO_NEW_DATA)`.
`fi:2025:w18:6e872c5caa82` / `psi:2025:w18:08123edd58c9` — **identical version
hashes** to the manifests already committed on this branch, proving the refresh
is reproducible. Artifact diff: every served CSV byte-identical except
`player_directory.csv` (29 rows' `team` column updated — real September 2026
roster/free-agency movement, expected); the two manifest JSONs differ only in
`generated_at` / `tier_{b,c,d}.built_at` timestamps. Tier D:
`lane=SHADOW_ONLY`, `numeric_fantasy_adjustment=0`,
`fantasy_adjustment_enabled=false` on every relevant field. TypeScript
regression: 1816/1816 (a pre-existing, frozen Phase 8 live-integration test —
`test/orchestrator-isolation.test.ts`, untouched by this branch — failed once
on an earlier attempt by 0.03 pts due to a live-data timing race between two
Sleeper reads taken seconds apart; it passed 2/2 in isolation and 1816/1816 in
the final full run and is not a Phase 10 defect). `tsc --noEmit` clean;
`eslint` 0 errors / 29 pre-existing warnings (none in Phase 10 files).

### 6.5 Recommended (not yet enabled) weekly cadence

Once the P1 FI week-1-safety fix lands and the ingest window reopens to
`SEASON_CURRENT`, the safe cadence is **once weekly, Tuesday ~14:00 UTC
(~9-10am ET)** — after Monday Night Football has ended (~04:30 UTC Tuesday) and
nflverse's typical next-day PBP ingestion window, and before the
Tuesday-night/Wednesday waiver cycle needs fresh evidence for the coming week.
Do **not** run mid-slate (Sun/Mon) — that only captures a partial week and wastes
a full nflverse+R rebuild for no benefit; the freshness gate would still not
mislabel it, but it would be redundant. Per source: PBP updates within ~24h of
each game; NGS/PFR lag 1-3 days; **participation/FTN historically lag heavily
and 2026 in-season availability is not guaranteed at all** — a Tuesday run
should expect those two to stay `PRIOR_ONLY`/`DESCRIPTIVE_ONLY` most or all of
the season, which is correct, not a fault. **Not enabled in this checkpoint** —
this is a recommendation only, per the mission's cadence rule (§8).

## 7. Checkpoint D — downstream evidence handoff

The evidence loop should eventually emit stable inputs for two separate systems:

1. **Outcome Audit / Calibration** — compare pregame forecasts/recommendations with actual results, measure error/calibration/regret, and decide whether models remain frozen, deserve recalibration, or qualify for a separate promotion audit.
2. **Game / Postgame Intelligence** — transform each completed NFL game into structured offense/defense/player tendency changes suitable for matchup scouting and shareable reports.

Neither system should be folded directly into this refresh script. Phase 10 owns freshness and reproducibility; those systems own interpretation.

## 8. Current verdict

**CHECKPOINTS A–C IMPLEMENTED AND CERTIFIED ON BRANCH — NOT YET MERGED.**

`npm run evidence:certify` ran clean end to end against the real 2026 R/nflverse
environment (§6.4): all 16 stages PASS, freshness gate PASS, reproducible
version hashes, zero unexplained artifact drift, Tier D shadow invariant holds,
full TypeScript regression green. The clean-runner dependency audit
(`docs/EVIDENCE_LOOP_RUNTIME.md`, `scripts/bootstrap-r-deps.R`) is done. A
`workflow_dispatch`-only GitHub Action is authored
(`.github/workflows/evidence-2026-manual-certification.yml`) but **cannot be
dispatched from this branch** — GitHub requires a `workflow_dispatch` workflow
file to exist on the default branch before it can be triggered at all, on any
branch. Landing that one inert (read-only-permissions, dispatch-only, no
cron) file on `main` is the enabling step for Checkpoint C's CI proof and is
recommended as the very next, minimal action — separate from this branch's
merge. No scoring/recommendation surface has been changed, and nothing has
been merged, deployed, scheduled, or promoted. Remaining known limitation:
**P1** — the frozen Phase 3 FI engine is not week-1-current-season-safe, so the
ingest window stays `:2025` and every 2026 source correctly reports
`PRIOR_ONLY` until that is fixed in a dedicated, separately audited FI change.
