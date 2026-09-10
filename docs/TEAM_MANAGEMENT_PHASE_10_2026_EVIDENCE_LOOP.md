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

## 5. Metadata debt discovered during Checkpoint B

`analysis/player_scheme_intelligence/source_audit.R` currently emits an `as_of_note` sentence hard-coded to say that zero 2026 rows are cached. The machine fields (`current_season_rows`, `last_available`, `availability_state`) are dynamic and are what the Phase 10 gate trusts, but the prose note will become stale once 2026 data arrives.

This is a metadata correctness issue, not a model issue. It should be repaired as a narrow follow-up without changing any Phase 9 calculation or deployment lane.

## 6. Checkpoint C — repeatable CI runner (next)

Do not enable a cron schedule yet.

First run Checkpoints A–B manually against the real current nflverse cache and inspect:

```text
artifacts/evidence-loop/latest.json
```

Then audit the exact R package/runtime requirements needed on a clean runner. After a successful clean execution, add a `workflow_dispatch` GitHub Action. Only after that manual CI path is proven should a weekly schedule be enabled.

The scheduled job must not merge or deploy generated artifacts automatically. It should retain reviewable output and preserve the same certification boundaries used elsewhere in Bloodline Bowl.

## 7. Checkpoint D — downstream evidence handoff

The evidence loop should eventually emit stable inputs for two separate systems:

1. **Outcome Audit / Calibration** — compare pregame forecasts/recommendations with actual results, measure error/calibration/regret, and decide whether models remain frozen, deserve recalibration, or qualify for a separate promotion audit.
2. **Game / Postgame Intelligence** — transform each completed NFL game into structured offense/defense/player tendency changes suitable for matchup scouting and shareable reports.

Neither system should be folded directly into this refresh script. Phase 10 owns freshness and reproducibility; those systems own interpretation.

## 8. Current verdict

**CHECKPOINTS A–B IMPLEMENTED ON BRANCH — LOCAL CURRENT-SEASON RUN STILL REQUIRED BEFORE MERGE.**

The branch now has a fail-closed orchestration command, a machine freshness gate, a run ledger, and regression fixtures. No scoring/recommendation surface has been changed, and nothing has been merged or deployed.
