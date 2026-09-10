# Team Management — Phase 10: 2026 Evidence Loop

**Branch:** `team-management-phase10-evidence-loop`  
**Parent baseline:** `main` @ `896e22b`  
**Roadmap:** #18  
**Phase issue:** #19  
**Deployment lane:** DATA / VALIDATION INFRASTRUCTURE ONLY  
**Status:** CHECKPOINT A IMPLEMENTED — NOT MERGED / NOT DEPLOYED

## 1. Why Phase 10 exists

The Team Management and Competitive Trade stacks are already feature-rich. The in-season bottleneck is now evidence freshness, not another scoring formula.

Football Intelligence already has a `{targets}` graph and the Player × Scheme system already knows how to rebuild its descriptive and shadow artifacts. The missing piece is a single, auditable process that refreshes the nflverse cache after games, rebuilds both systems in dependency order, proves the outputs are internally valid, and records exactly what evidence changed.

Before Phase 10, the critical raw refresh remained a manual command:

```bash
Rscript analysis/football_intel/fetch_raw.R --refresh
Rscript -e 'targets::tar_make()'
```

Player × Scheme then required separate source-audit and Tier A–D build commands. That separation is useful for research, but it is too easy for an in-season operator to refresh one layer and forget another, or to mistake a partially rebuilt artifact set for a coherent current-season snapshot.

Phase 10 makes the refresh atomic from the operator's point of view while preserving every existing model boundary.

## 2. Non-negotiable invariants

Phase 10 MUST NOT:

1. change fantasy scoring;
2. change any production projection formula;
3. change model weights automatically;
4. promote Start/Sit, Matchup, or Player × Scheme shadow findings into production;
5. change `numeric_fantasy_adjustment` from the frozen Phase 9 behavior;
6. execute fantasy transactions;
7. change Sleeper/Yahoo provider semantics;
8. treat stale or prior-only evidence as a current-season observation.

A successful data refresh and a successful model promotion are deliberately different events.

## 3. Checkpoint A — orchestration foundation

Checkpoint A adds `scripts/weekly-evidence-refresh.sh` and two package commands:

```bash
npm run evidence:refresh
npm run evidence:certify
```

`evidence:refresh` performs the in-season R evidence loop. `evidence:certify` performs the same loop and then runs the full TypeScript repository regression.

### 3.1 Dependency order

The runner executes these stages serially and stops at the first failure:

1. `football_intel.fetch_raw` — refresh nflverse raw cache;
2. `football_intel.targets` — rebuild the existing Football Intelligence `{targets}` graph;
3. `player_scheme.source_audit` — re-stamp actual source availability after the fetch;
4. `player_scheme.tierA` — live-capable PBP spatial profiles;
5. `player_scheme.tierB` — charting-dependent profiles, current only if current-season source rows actually exist;
6. `player_scheme.tierC` — team tendencies/archetype vectors/scheme-era context;
7. `player_scheme.tierD_shadow` — interaction research, still shadow-only;
8. `player_scheme.test_tierA` — R invariant suite;
9. `player_scheme.test_tierD_synthetic` — interaction synthetic sanity suite;
10. manifest-presence gates for Football Intelligence and Player × Scheme.

With `--full-regression`, it then runs:

11. `npm test`;
12. `npm run typecheck`;
13. `npm run lint`.

### 3.2 Fail-closed test behavior

The existing Phase 9 convenience runner calls child `Rscript` processes through `system2()` but does not itself inspect/propagate the returned child status. That is acceptable as a human convenience command, but it is not strong enough to be the sole automation gate.

Phase 10 therefore invokes the two child R test files directly. A non-zero child exit is a non-zero evidence-loop exit, subsequent stages do not run, and the report is stamped `FAIL` with the failed stage.

Phase 9 files remain frozen and unchanged.

### 3.3 Run ledger

Every invocation writes:

```text
artifacts/evidence-loop/<UTC_RUN_ID>.json
artifacts/evidence-loop/latest.json
```

The report contains:

- run id and UTC timestamps;
- git SHA;
- overall PASS/FAIL and exit code;
- exact failed stage when applicable;
- every stage's start/end/status/exit code;
- whether full TypeScript regression was requested;
- source audit before the refresh when available;
- source audit after the refresh;
- resulting Football Intelligence manifest;
- resulting Player × Scheme manifest;
- explicit invariant flags showing that the runner itself does not alter scoring, formulas, weights, shadow promotion, or transactions.

This is an evidence ledger, not a model-performance ledger. Outcome scoring belongs to the subsequent Outcome Audit/Calibration phase.

## 4. Current-season semantics

The source audit remains authoritative for whether a feature family is current.

- PBP-backed families may become current once actual 2026 rows are present.
- Participation/FTN-backed families remain prior-only until those sources themselves contain 2026 observations.
- A successful command does not imply every source is current.
- A current Football Intelligence artifact does not automatically make a lagging charting family current.

Checkpoint B will add explicit regression/freshness assertions around these rules rather than merely recording them.

## 5. Checkpoint B — freshness gate (next)

Checkpoint B should add a machine-readable validator that compares the pre-run and post-run source audit and fails closed on impossible or regressive lineage. Required cases:

- current-season PBP cannot be labeled current with zero 2026 rows;
- a source cannot move backward in season/week without an explicit override and audit reason;
- participation/FTN cannot silently inherit PBP freshness;
- generated FI/PSI as-of season/week must be compatible with their source cutoffs;
- a previous current-season artifact cannot be silently replaced by an older prior-only build;
- no source family may be promoted from `PRIOR_ONLY` because another family refreshed.

The gate should distinguish `NO_NEW_DATA` from `ERROR`: a Tuesday refresh before nflverse posts a completed game can validly produce no new evidence without pretending anything changed.

## 6. Checkpoint C — repeatable CI runner

Do not schedule the pipeline yet.

First audit the R package/runtime requirements and run Checkpoints A–B manually against real 2026 data. After one successful clean CI execution, add a `workflow_dispatch` GitHub Action. Only after that is proven should a weekly schedule be enabled.

The scheduled job must not merge or deploy generated artifacts automatically. It should create/retain reviewable output and require the same certification boundaries used elsewhere in the project.

## 7. Checkpoint D — downstream evidence handoff

The evidence loop should eventually emit stable inputs for two separate systems:

1. **Outcome Audit / Calibration** — compare pregame forecasts and recommendations with actual results, measure error/calibration/regret, and decide whether models remain frozen, deserve recalibration, or qualify for a separate promotion audit.
2. **Game / Postgame Intelligence** — transform each completed NFL game into structured offense/defense/player tendency changes suitable for matchup scouting and shareable reports.

Neither system should be folded directly into this refresh script. Phase 10 owns freshness and reproducibility; those systems own interpretation.

## 8. Checkpoint A verdict

**IMPLEMENTED ON BRANCH — REVIEW REQUIRED.**

Checkpoint A is intentionally small: it converts the already-existing manual R pieces into one fail-closed command and adds audit metadata. It does not modify a frozen model or recommendation surface.

Before merge, run the branch locally with the existing R environment and current nflverse access, inspect `artifacts/evidence-loop/latest.json`, and proceed to Checkpoint B only if the 2026 source lineage behaves as expected.
