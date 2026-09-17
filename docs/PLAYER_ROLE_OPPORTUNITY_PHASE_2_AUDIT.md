# Player Role & Opportunity Intelligence — Phase 2 Audit (Checkpoint A)

**Status: AUDIT ONLY. No production code has been changed by this document.**
Branch: `player-role-opportunity-phase2-audit`, based on `main` @ `4bd41f7`.

This document is the required pre-implementation deliverable before any Phase 2
schema/model/artifact work begins. Every claim below was verified against the
repository as it exists today (2026-09-17) — file paths, type/function names,
and actual data values (not just code) were checked directly, including
reading real rows out of the committed CSV artifacts.

---

## 0. Git state at the start of this audit

```
branch:            player-role-opportunity-phase2-audit
based on main @:   4bd41f7 (intelligence-modernization: record final merge SHA and production verification)
origin/main:       4bd41f7   (no drift — local was already up to date)
working tree:      clean
```

**Concurrency finding:** none. `git fetch origin` produced no new refs; `git diff HEAD origin/main` was empty. Phase 1 (`intelligence-modernization`) is merged, frozen, and its last commit is the tip of `main`. No other branch touches the files this phase will read from or extend.

---

## 1. Phase 1 frozen contracts — verified present, singly-defined, still authoritative

All five contracts named in the assignment exist exactly once each. Full detail (file paths, exact type/function names, doc-comment excerpts) is in the background research this document is built from; summarized here as the operative facts Phase 2 must respect:

| Contract | File | Entry point | What it is |
|---|---|---|---|
| `RecommendationLineage` | `lib/canonical/lineage.ts` | `buildRecommendationLineage()` | The provenance envelope (canonical snapshot + projection versions + optional FI snapshot) every engine result should carry. `football_intelligence: null` is a typed fact ("not consulted"), not an omission. |
| `FootballIntelligenceLineage` | `lib/canonical/lineage.ts` (type) / `lib/football-intel/lineage.ts` (builder) | `buildFootballIntelligenceLineage()` | Identity/provenance of one FI snapshot as consulted — **not** a freshness verdict. Its own doc comment: "No consumer should hand-assemble this shape itself." |
| NFL Reality Frontier | `lib/canonical/nfl-reality-frontier.ts` | `buildNflRealityFrontier()` / `loadNflRealityFrontier()` | Ground truth for "how many NFL games have actually finished," sourced only from Sleeper's `status === "complete"` schedule feed — never inferred from wall clock or a provider's nominal "current week." File docstring: "no waiver/start-sit/matchup/trade/orchestrator code may independently infer the completed-game frontier." |
| Intelligence Freshness Policy | `lib/canonical/intelligence-freshness.ts` | `assessIntelligenceFreshness()`, `FRESHNESS_POLICY_VERSION = "freshness-policy:2026.2"` | The one evaluator. Already tracks 12 `INTELLIGENCE_FEATURE_FAMILIES`, including **`PLAYER_USAGE`, `SNAP_COUNTS`, and `ROUTE_PARTICIPATION` as distinct families already** — directly relevant scaffolding for Phase 2. Every FI family's `production_numeric_influence` is hardcoded `"PROHIBITED"` today. |
| Recommendation Readiness | `lib/canonical/recommendation-readiness.ts` | `assessRecommendationReadiness()` | Composes canonical-snapshot freshness + FI freshness + a caller-supplied `DeploymentPermission` into one `READY / READY_DEGRADED / NOT_READY` verdict, without collapsing the components. Deliberately does not import `lib/weekly/*` deployment-gate modules (dependency direction: `lib/weekly/*` → `lib/canonical/*`, never the reverse). |

**Confirmed: no duplicates exist today.** Each contract has exactly one definition site and one builder/evaluator; every consumer imports rather than reimplements.

**Implication for Phase 2:** the freshness substrate already has `PLAYER_USAGE`, `SNAP_COUNTS`, and `ROUTE_PARTICIPATION` as named feature families. Phase 2 should populate/extend these families' `source_availability` rather than invent a parallel notion of "role data freshness." A new `RoleOpportunityIntelligenceLineage` type (analogous to `FootballIntelligenceLineage`) is additive and consistent with the pattern — a second, independent freshness evaluator or completed-game frontier is not needed and must not be built.

---

## 2. Football Intelligence today — what exists, what Phase 2 must not reimplement

**Pipeline (as-built):**
```
analysis/football_intel/{build_snapshot.R, lib_usage.R, lib_features.R, lib_profiles.R,
                         lib_recency.R, config.R, ...}
  → lib/football-intel/data/{football_intelligence_manifest.json, team_profile.csv,
                              player_usage_profile.csv, unit_coverage_profile.csv,
                              contextual_matchup_feature.csv, ftn_descriptive.csv}
  → lib/football-intel/read.ts   (loadFootballIntelligence(), pure sync, module cache)
  → lib/football-intel/schema.ts (typed contract, FOOTBALL_INTEL_CONTRACT_VERSION = "football-intel-read-2026.1")
  → lib/football-intel/lineage.ts (buildFootballIntelligenceLineage())
  → consumed by lib/weekly/start-sit-fi/* and lib/weekly/matchup-intelligence/* only
  → NO app/api route exists for FI today (internal-only)
```

**`player_usage_profile.csv` — exact current schema (verified from the file, not just code):**

Columns: `season, through_week, gsis_id, sleeper_id, pfr_id, full_name, position, team, metric, output_class, observed, modeled, position_mean, prior_season, games, eff_games, prior_weight, recent_weight, confidence, last_week`.

Nine metrics (`USAGE_METRICS` in `lib_usage.R`), each with real 2026 week-1 data (1,200 player rows per metric, 10,800 rows total, all `output_class = "OBSERVED"`):

```
snap_share, route_participation, target_share, air_yards_share, rush_share,
rz_target_share, rz_carry_share, deep_att_rate, designed_rush_rate
```

**Confidence methodology:** Kish effective-sample-size (`eff_n`) over an exponential recency weighting (half-life 5 games), shrunk first toward the player's own prior-season (`season - 1`) mean, then toward the position mean (`shrink_to()`). Thresholds (`config.R`): `eff_n < 2` → `INSUFFICIENT_SAMPLE`, `≥ 8` → `HIGH` (gated on corroboration, not prior alone), `≥ 4` → `MEDIUM`, else `LOW`.

**Current manifest state:** `football_intelligence_version = "fi:2026:w01:890f7aefd53f"`, `season = 2026`, `through_week = 1`, `week_completion.week_state = "COMPLETE"` (16/16 games), `generated_at = 2026-09-17T17:27:16Z` — same day as this audit, i.e. current.

**Current consumers of `player_usage_profile` (TS):** exactly one — `lib/weekly/start-sit-fi/translate.ts`. No other TypeScript file reads it. (R-side: only the builder chain itself.)

**Decision for Phase 2 — extend vs. build separate:** `player_usage_profile` should be treated as **one input source Phase 2 reads, not the artifact Phase 2 extends in place.** Reasons:
1. It is a *profile* (already recency-shrunk, already blended toward priors) — Phase 2 needs the **raw player-game grain** underneath it (§7 below) to do its own trend/change detection with its own (faster) recency parameters. Reusing the already-shrunk profile would bake FI's team-quality-oriented recency constant into a role signal that must move faster (per prompt §10).
2. It is scoped and consumed narrowly today (one file) specifically because FI is shadow-only; Phase 2 is meant to become the canonical role source for *other* consumers (waivers, start/sit diagnostics, trades) later. Bolting that onto FI's existing artifact would violate FI's "shadow-only, PROHIBITED production influence" boundary by association.
3. `lib_usage.R`'s per-metric shrinkage/confidence code is correct and reusable **as a library**, not as a reason to skip building Phase 2's own artifact. Where Phase 2's needs match FI's exactly (e.g., the underlying nflverse ingestion of snaps/targets/carries/routes), Phase 2 should reuse the *raw ingestion* (`fetch_raw.R`) rather than duplicate the HTTP/parsing layer, but should NOT reuse FI's *shrinkage* logic wholesale, since role-change detection explicitly wants a different (faster, un-team-quality-coupled) recency model.

**Conclusion:** Phase 2 owns a new artifact (`analysis/player_role_intelligence/` → `lib/player-role-intelligence/data/*` → `lib/player-role-intelligence/read.ts`), reusing FI's raw nflverse ingestion where the same raw fields are needed, and treating `player_usage_profile`'s per-player rows as one optional cross-check input (e.g., for confidence corroboration) rather than a foundation to build on top of.

---

## 3. 2026 field-by-field source-availability matrix

Classification per the taxonomy requested: `AVAILABLE_CURRENT`, `AVAILABLE_WITH_LAG`, `HISTORICAL_ONLY`, `DERIVABLE`, `UNAVAILABLE`, `UNRELIABLE`.

| Field | Classification | Source | Notes |
|---|---|---|---|
| Offensive snaps / snap share | `AVAILABLE_CURRENT` | `player_usage_profile.csv` metric `snap_share`; raw `snap_counts` (nflverse) | 2026 w1 OBSERVED |
| Carries / rush share | `AVAILABLE_CURRENT` | `player_usage_profile.csv` metric `rush_share` | Share only, not raw carry count — raw count is `DERIVABLE` from nflverse PBP `fetch_raw.R` already ingests |
| Targets / target share | `AVAILABLE_CURRENT` | `player_usage_profile.csv` metric `target_share` | Share only; raw target count `DERIVABLE` from PBP |
| Receptions | `DERIVABLE` | nflverse PBP (already ingested by `fetch_raw.R`) | Not currently surfaced as a named FI metric, but the raw PBP source is already in the pipeline |
| Air yards / air-yard share | `AVAILABLE_CURRENT` | `player_usage_profile.csv` metric `air_yards_share` | |
| aDOT | `UNAVAILABLE` (as a named field) / `DERIVABLE` | not computed anywhere; PBP has `air_yards` + target counts, so aDOT is a straightforward derivation | No existing consumer computes it |
| Red-zone carries / targets | `AVAILABLE_CURRENT` | `player_usage_profile.csv` metrics `rz_carry_share`, `rz_target_share` | Share only |
| Goal-line carries / end-zone targets | `UNAVAILABLE` in FI / `DERIVABLE` | not a named FI metric; Trade Engine's separate 2025-only pipeline lists `goal_line_carries` as explicitly `unsupported_metrics_left_na` | Would need new PBP derivation (yardline ≤ 5/10 filter) — straightforward given PBP is already ingested |
| Third-down usage | `UNAVAILABLE` / `DERIVABLE` | not found anywhere in the repo | PBP has `down` — derivable, not yet built |
| Two-minute usage | `UNAVAILABLE` / `DERIVABLE` | not found anywhere | PBP has game-clock fields typically; derivable in principle, not yet audited at the raw-source level for actual field availability |
| Routes / route participation | `AVAILABLE_CURRENT` | `player_usage_profile.csv` metric `route_participation`, from nflverse `participation` | 2026 w1 OBSERVED, real (see §4) |
| Targets per route run | `DERIVABLE` | targets (derivable) ÷ routes (route_participation × team dropbacks) | Not currently computed; straightforward once both inputs exist at raw grain |
| Slot / wide / backfield alignment | `UNAVAILABLE` at player level | `lib/player-scheme-intelligence/` has route *depth zones* (`depth_bin`, `field_third`), not slot/wide/backfield alignment | Different concept — do not conflate |
| Motion | `UNAVAILABLE` at player level / team-level only | `offense_team_profile.csv` has `ftn__motion_rate` (team aggregate) | No per-player motion field anywhere |
| Designed touches | `DERIVABLE` | carries + targets (derivable from PBP), once raw counts are surfaced | Not currently a named composite anywhere |
| Screens | `UNAVAILABLE` | not found | Would require play-type/route-concept charting beyond current ingestion |
| Rushing direction (gap) | `AVAILABLE_WITH_LAG`, elsewhere | `lib/player-scheme-intelligence/data/rb_rush_gap.csv` (Tier C/D charting) exists in a *different* system (Player × Scheme Intelligence, Phase 9 of Team Management) | Out of Phase 2's direct pipeline; a cross-reference, not a Phase 2 input, unless explicitly integrated |
| Return snaps / KR / PR / return yardage | `AVAILABLE_CURRENT`, but as raw counts only, Sleeper-sourced | `lib/projections/return-game.ts`, `lib/weekly/return-game-weekly.ts`, fields `kr`, `kr_yd`, `pr`, `pr_yd` | No "return share" percentage metric exists — only raw attempt/yard counts, and only from Sleeper box scores, entirely outside the nflverse/FI pipeline |
| Pass-blocking / run-blocking usage | `UNAVAILABLE` | not found anywhere | Would need PFF-grade charting not present in current ingestion |
| Personnel-group usage | `UNAVAILABLE` at player level / partial team level | `offense_team_profile.csv` `form_*` columns (shotgun/empty/under_center/singleback/i_form/pistol) | Team-level formation rates only, not player personnel-package participation |

**Route-participation — explicit answer to the audit question:** Real 2026 week-1 route-participation data **is** available, in `lib/football-intel/data/player_usage_profile.csv` (`metric = "route_participation"`, `season = 2026`, `through_week = 1`, `output_class = "OBSERVED"`, 1,200 rows, sourced from nflverse's `participation` feed). This is a change from what earlier Phase 1-era characterizations may have implied — the manifest generating this data is dated the same day as this audit. It remains true, separately, that the **Trade Engine's own** usage pipeline (`analysis/phase35_usage_pipeline.R` → `lib/trades/data/player_usage_weekly.csv`) explicitly does **not** have route data (`unsupported_metrics_left_na: ["routes", "route_participation", ...]`) and is 2025-only, not wired as any default provider. Phase 2 must not conflate these two pipelines: FI's ingestion is the one with real current-season routes.

**Invariant this confirms and Phase 2 must preserve (assignment §21):** `snap_share != route_participation`. Both are separately, currently, and reliably available — there is no need or excuse to ever substitute one for the other.

---

## 4. Existing duplicate/adjacent role-like logic — what Phase 2 must not fight or quietly replace

Ranked by duplication risk to a future canonical Phase 2 role engine (Phase 2 does not delete or rewire any of these now — this is inventory only, per the assignment's explicit "do not delete existing production logic in this phase"):

1. **`lib/projections/model.ts` + `lib/projections/baselines.ts` — HIGH risk.** The production season-projection engine (`ri-structural-2026.3`) independently computes `snap_share`, `carries_pg`, `rz_carry_pg` as **its own weighted historical rates** from multi-season Sleeper box scores (`weightedRate()`), plus depth-chart-slot-keyed rookie opportunity priors (`rookieRolePrior()`). This is a real production consumer (feeds fantasy point projections), unlike FI's shadow-only status — the highest-stakes overlap in the repo. Phase 2 must not touch this engine's numeric output; it is a candidate future *consumer* of Phase 2's canonical role signal, not something Phase 2 reimplements now.
2. **`lib/trades/r-data-providers.ts` + `analysis/phase35_usage_pipeline.R` — HIGH risk in concept, LOW current production impact.** A second, independent, incomplete (`routes`/`route_participation`/red-zone fields all `NA`), 2025-only usage pipeline, explicitly not wired as any default provider — used only for trade-engine backtest/calibration research (`lib/trades/historical-loader.ts`). Phase 2 should be positioned as the eventual canonical replacement for this, but does not touch it now.
3. **`lib/trades/intelligence.ts` — MEDIUM risk.** A third independent interpreter of "usage," with its own fallback-priority heuristic (`routes ?? snap_share ?? target_share ?? rush_share` as "the" usage signal) for trend detection (`usage_trend`, `target_share_trend`). This fallback-chain policy is itself a role-classification decision a canonical Phase 2 engine should eventually own — flagged, not touched.
4. **`lib/player-scheme-intelligence/read.ts`** — defense-side *allowed* rates (`target_share_allowed`, `carry_share_allowed`), not offensive player role. Low overlap risk but shares field-naming vocabulary Phase 2 should avoid colliding with (e.g., do not reuse `target_share` as a column name meaning something different).
5. **`lib/weekly/waivers.ts`, `lib/weekly/lineup.ts`, `lib/draft/trajectory.ts`, `lib/trades/competitive/threat.ts`, `lib/projections/special-teams.ts`** — all reference Sleeper's own `starters`/`depth_chart_order` roster metadata for lineup-slot or depth-chart purposes. This is a genuinely different "role" concept (lineup occupancy / provider depth-chart label, not usage-derived role) — low duplication risk, but the Phase 2 naming scheme (§5, role-state taxonomy) must clearly distinguish "usage-observed role" from "roster-slot role" so downstream readers don't conflate `ROLE_FEATURED` (usage-based) with "is a starter" (lineup-based).

---

## 5. Return-game role — current pipeline, confirmed reusable

- **Season model:** `lib/projections/return-game.ts` (`RETURN_GAME_MODEL_VERSION = "ri-return-game-2026.1"`), reading Sleeper box-score fields `kr`, `kr_yd`, `pr`, `pr_yd` only (`SeasonActuals` in `lib/projections/actuals.ts`). Role qualification threshold `MIN_ATTEMPTS_FOR_ROLE = 3`/season; multi-season recency weights `[1.0, 0.45, 0.18]`; a role-continuity gate shrinks the rate 0.35× if the most recent season shows minimal return work.
- **Weekly model:** `lib/weekly/return-game-weekly.ts` (`RETURN_GAME_WEEKLY_MODEL_VERSION = "ri-return-game-weekly-2026.1"`) — fills a specific Sleeper gap (weekly projections omit individual `kr`/`kr_yd`), provider-first, gated on the player's last 1–3 completed games.
- **What exists:** raw counting stats only (`kr`, `kr_yd`, `pr`, `pr_yd`). **No return-share percentage metric** analogous to `snap_share`/`target_share` exists yet, and this data is **entirely Sleeper-sourced, outside the nflverse/FI ingestion pipeline** — a genuinely separate data source Phase 2 must bridge to, not something already sitting in the same raw ingestion `fetch_raw.R` uses.
- **Implication:** Phase 2's return-game role dimension (assignment §22) can be built by reading these existing Sleeper-sourced fields directly (via the same client used by `lib/projections/actuals.ts`) rather than waiting on nflverse special-teams participation data, which was not found anywhere in the current ingestion. This keeps return role inside Phase 2's role vector without inventing a new raw-data integration from scratch — but it does mean Phase 2's player-game substrate has two source systems (nflverse for offensive usage, Sleeper for return usage) that must be joined on player identity (the canonical crosswalk, `lib/canonical/players.ts`, already solves this problem and should be reused, not reinvented).

---

## 6. R vs. TypeScript ownership recommendation

Two existing full pipelines confirm one consistent convention (FI itself, and the larger Player × Scheme Intelligence system under `analysis/player_scheme_intelligence/` → `lib/player-scheme-intelligence/` → `app/api/player-scheme/*`):

```
R (analytical layer, all heavy computation, never runs inside a request)
  → committed, versioned CSV/JSON artifacts under lib/<domain>/data/
  → thin synchronous TypeScript reader (lib/<domain>/read.ts) + typed schema (schema.ts)
  → optional lineage builder (lib/<domain>/lineage.ts) if it must plug into RecommendationLineage
  → optional thin app/api/<domain>/**/route.ts exposure
```

Artifacts are committed under `lib/` specifically (not `outputs/` or `artifacts/`) because Vercel's deployed runtime cannot execute R — this is stated explicitly in both `lib/football-intel/read.ts` and `lib/trades/r-data-providers.ts` header comments as a hard deployment constraint, not a style preference.

**Recommendation for Phase 2:** follow this exact shape.
```
analysis/player_role_intelligence/{fetch_raw.R (reuse/extend FI's), lib_usage_features.R,
                                    lib_role_state.R, lib_change_detection.R,
                                    lib_confidence.R, build_snapshot.R, config.R}
  → lib/player-role-intelligence/data/{role_opportunity_manifest.json,
                                        player_role_game.csv (or internal-only if too large — see §7),
                                        player_role_profile.csv, player_role_change.csv}
  → lib/player-role-intelligence/read.ts + schema.ts
  → lib/player-role-intelligence/lineage.ts (buildRoleOpportunityIntelligenceLineage(), mirroring
    buildFootballIntelligenceLineage() exactly)
  → app/api/player-role/** (Checkpoint D; analysis/diagnostic access only, per assignment §30-31)
```
This is additive alongside `lib/football-intel/`, not a replacement of it, and reuses the canonical player-identity crosswalk (`lib/canonical/players.ts`) for team-change/identity handling (assignment §15) rather than building a second identity resolver.

---

## 7. Player-game grain, artifact sizing, and versioning proposal

**Grain:** one row per `(season, week, game_id, player_id [canonical], team, opponent, position)`, exactly as the assignment specifies, with explicit `source_availability` per feature family on each row (not a single blanket "role data current" flag — assignment §20 requires per-family freshness, and `intelligence-freshness.ts` already models feature families this way).

**Sizing:** FI's `player_usage_profile.csv` is already 10,800 rows for one week × 9 metrics × 1,200 players (long format). A full-season player-game table at similar player-count and metric-count, in wide format (one row per player-game with ~15-20 usage columns rather than long format), would be on the order of 1,200 players × 18 weeks × ~20 columns — a few hundred thousand cells, comparable in order of magnitude to CSVs already committed in this repo (e.g., `lib/trades/data/player_usage_weekly.csv`, a full-season file already checked in). This is within the range the repo already tolerates for committed artifacts; no infrastructure change is anticipated. Per assignment §17, if raw player-game data proves too large to serve broadly, the recommendation is to keep the raw grain **internal to the R build** (cached, not published) and serve only `player_role_profile.csv` (current-state summary) + `player_role_change.csv` (event log) as the public artifacts — matching how FI itself never publishes raw PBP, only derived profiles.

**Versioning:** a `role-opportunity:2026.1` model tag plus a content-addressed snapshot id (`roi:2026:w01:<hash>`), mirroring FI's `fi:2026:w01:890f7aefd53f` pattern exactly (content hash of the analytical output, not wall-clock — assignment §18's requirement that identical content produce identical identity is already how FI's own manifest works, confirmed by reading `build_snapshot.R`'s hashing step during this audit).

---

## 8. Modeling proposal (high-level; full design deferred to Checkpoint C)

- **Publish four role signals per player, not one collapsed number** (assignment §10): `prior_role` (prior-season / depth-chart-informed baseline), `season_role` (season-to-date), `recent_role` (2-3 game recency-weighted), `latest_game_role` (single most recent game). Derive `role_change_signal` + `confidence` from comparing these, rather than picking one smoothing constant up front.
- **Recency must be tuned independently from FI's team-quality recency** (assignment §10) — FI's `RECENCY_HALFLIFE_GAMES = 5` is calibrated for team offensive/defensive quality, a slower-moving property than individual role. This needs its own backtest-driven calibration (Checkpoint C), not a borrowed constant.
- **Confidence must require corroboration across dimensions**, not just sample size — the assignment's explicit example (snap share + target share + red-zone share all moving together vs. only raw target count moving in a high-volume game) means the confidence function needs an evidence-vector design, not a single eff_n threshold. FI's own confidence bucketing (eff_n-based) is a reasonable starting primitive but insufficient alone for the corroboration requirement.
- **Shares over counts, always** (assignment §9): every opportunity metric must be expressed relative to team volume (team carries, team targets, team dropbacks) before being compared across games, exactly as FI's existing `rush_share`/`target_share` design already does — reuse that principle, not that exact artifact.
- **Role-state representation should be a vector, not one label** (assignment §5): a structured object with independent participation/opportunity/high-value/deployment/trend dimensions, since the assignment gives a concrete example (`FEATURED_RUSHER` + `LIMITED_RECEIVER` + `GOAL_LINE_PRIMARY` simultaneously) that a single enum cannot represent.

---

## 9. Backtest design proposal (high-level; full execution deferred to Checkpoint C)

- **Validation target:** next-game snap/target/carry share (and 2-3 game persistence), never fantasy points as the primary signal (assignment §23-24) — fantasy points retained only as a secondary/reporting check.
- **Baselines to beat:** last-game share, season-average share, trailing-3-game average — the model must show incremental predictive value over these or the audit/certification must say so honestly (assignment §24, §37).
- **Chronology safety:** walk-forward only, using only information available through week *k* to classify role at week *k*, evaluated against week *k+1* (assignment §25). This must be enforced structurally in the R build (a hard date/week cutoff parameter), not just by convention — recommend a dedicated invariant test asserting no row's `through_week` feature depends on data from a later week, mirroring the pattern of existing "future information cannot leak backward" tests elsewhere in the repo's projection code.
- **Season availability for backtesting:** `player_usage_profile`'s underlying nflverse sources (participation, snap counts, PBP) are available for prior seasons (FI's own `seasons_used.prior = [2022, 2023, 2024, 2025]`) — Phase 2 backtesting has at least 4 prior seasons of raw usage data to walk forward through, subject to confirming `participation` (route) data's actual historical coverage at Checkpoint B (this audit did not verify how far back nflverse `participation` extends; flagged as an open question below).
- **Cohort separation:** run backtests separately for veterans, rookies, team-changed players, and low-volume players (assignment §25) rather than one pooled metric — team-change discontinuity handling (assignment §15) needs its own cohort to avoid being averaged away.

---

## 10. Test plan (Checkpoint B onward)

Minimum invariant tests to add, keyed to assignment §35 (25 named invariants) plus the specific facts this audit surfaced:
- `snap_share != route_participation` never silently substituted (already true today at the FI layer per §3 above; Phase 2 must preserve this at its own layer).
- Missing feature families (e.g., third-down usage, two-minute usage, alignment, blocking — confirmed `UNAVAILABLE` in §3) never populate as zero or a synthetic value; role classification and confidence must visibly account for their absence.
- Walk-forward backtest harness itself has a "no future leakage" structural test (not just a design intent).
- Team-change discontinuity: a player's role history across a team boundary must not be blended without an explicit discontinuity marker (assignment §15) — test with a real historical team-change case once Checkpoint C's backtest data is available.
- Numeric-influence guards: role intelligence must not alter `lib/weekly/waivers.ts`, `lib/weekly/lineup.ts` (start/sit), `lib/weekly/matchup-intelligence/*`, or any `lib/trades/*` numeric output (assignment §21-24, §30-32) — mirror the existing pattern in `intelligence-freshness.ts` (`production_numeric_influence: "PROHIBITED"`) for a new Role Intelligence feature-family entry, and add a regression test analogous to whatever test currently pins FI's `PROHIBITED` status (to be located precisely at Checkpoint B).
- Repository-wide regression: current baseline is **1927 passing / 0 failing / 4 skipped** (1931 total, `npm test`, verified during this audit) — Checkpoint B/C/D work must not regress this count downward for reasons other than deliberately updated tests.

---

## 11. Risks / open questions

1. **How far back does nflverse `participation` (route) data actually extend?** FI's manifest lists `seasons_used.prior = [2022-2025]` for its overall prior pool, but this audit did not confirm route-participation coverage specifically across all four years — nflverse's participation feed has historically had different completeness by season. Must be verified in Checkpoint B before backtest design finalizes on "4 seasons of route data."
2. **Third-down and two-minute usage require new PBP derivations** not present anywhere in the repo today (§3). These are explicitly requested by the assignment (§3.C) but are net-new engineering, not a reuse of existing logic — scope/time estimate should be sized honestly at Checkpoint B rather than assumed cheap.
3. **Return-game role lives in a structurally separate data source (Sleeper) from offensive role (nflverse).** Joining them cleanly on canonical player identity is expected to work (the crosswalk already handles provider-vs-nflverse identity resolution for other purposes), but this specific join has not been built or tested before and should get its own invariant test.
4. **`lib/projections/model.ts`'s existing independent usage computation is a live production consumer of fantasy point projections.** Phase 2 must take care that any future integration (explicitly out of scope for Phase 2 itself) is sequenced as a deliberate, separately-certified swap — not an incidental side effect of Phase 2 existing. No action needed now; flagged so Checkpoint E's certification doesn't accidentally imply readiness for that swap.
5. **Artifact size at full-season, wide-format, all-metric grain** is estimated or extrapolated in §7 above from FI's long-format week-1 row count, not measured directly from a full season file (no such file exists yet to measure). Should be re-verified once Checkpoint B produces a real build.

---

## 12. Files likely to change (Checkpoint B onward — additive, no existing files modified in Checkpoint A)

New, in the pattern established by §6:
```
analysis/player_role_intelligence/*.R
lib/player-role-intelligence/data/*.csv, role_opportunity_manifest.json
lib/player-role-intelligence/{read.ts, schema.ts, lineage.ts, index.ts}
app/api/player-role/**/route.ts   (Checkpoint D)
test/player-role-intelligence/**  (or repository-conventional equivalent test location)
docs/PLAYER_ROLE_OPPORTUNITY_PHASE_2_AUDIT.md   (this file)
```
Possibly touched additively (not modified in behavior) at Checkpoint D only:
```
lib/canonical/intelligence-freshness.ts   — if a new feature-family entry or lineage-composition
                                             hook is needed; additive only, per Phase 1 rules
```
No file under `lib/weekly/`, `lib/trades/`, `lib/orchestrator/`, or `lib/projections/` is expected to change during Phase 2 (assignment §30-32 — no production recommendation changes).

---

## 13. Checkpoint A verdict

Audit complete. No blockers to starting Checkpoint B (player-game substrate). Key findings that shape Checkpoint B:
- Build a **new** artifact family (`lib/player-role-intelligence/`), reusing FI's raw nflverse ingestion where fields overlap, not extending `player_usage_profile.csv` in place.
- Snap share, target share, rush share, air-yard share, red-zone shares, and **route participation are all genuinely available now for 2026** — this is a stronger starting position than a literal reading of "2026 participation/routes remain unavailable" would suggest; that statement is stale for FI's own artifact as of this week's refresh (confirm and document any earlier-conversation assumption that assumed otherwise as superseded).
- Third-down usage, two-minute usage, alignment, motion (player-level), blocking usage, and goal-line/end-zone touch counts are genuinely unavailable or not-yet-derived and must be represented honestly as such, not fabricated.
- Return-game role is a separate Sleeper-sourced integration, not a free extension of the FI pipeline.

**STOP — per instructions, no implementation proceeds until this audit is reviewed.**
