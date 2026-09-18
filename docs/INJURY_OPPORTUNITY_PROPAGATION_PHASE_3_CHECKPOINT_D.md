# Injury → Opportunity Propagation Intelligence — Phase 3 — CHECKPOINT D

## Served Opportunity Propagation Intelligence, Scenario Contract, Lineage/Freshness Integration

Answers exactly: **IF a specified RB/WR/TE is unavailable for the full game, how is opportunity expected to redistribute among teammates?** Never: probability of missing the game, medical diagnosis, fantasy points, a waiver/start-sit/trade recommendation. Phase 3 remains non-production.

## 0. Git

| Item | Value |
|---|---|
| Branch | `injury-opportunity-propagation-phase3` |
| Pre-Checkpoint-D HEAD | `c723613` (Checkpoint C) |
| `origin/main` at start | `6c00d00` — **drift found and classified**: one automated commit, `football-intel: refresh 2026 week 2 (PARTIAL, 1/16 games)`, touching only `lib/football-intel/data/*.csv` and its manifest. Confirmed disjoint from every frozen contract and from all Phase 3 code (`git show --stat 6c00d00`). Merged into the branch (`d866ae3`) as safe — it is a routine automated data refresh, not a code change. |
| Post-merge drift check | `git diff origin/main -- lib/canonical/ lib/player-role-intelligence/ analysis/player_role/ analysis/opportunity_propagation/{config.R,lib_absence_detection.R,lib_fast_baselines.R,lib_redistribution_observed.R,build_absence_events.R,lib_episodes.R,lib_propagation_model.R,backtest.R}` → 0 lines. Phase 1/2 frozen contracts and every Checkpoint B/C file are byte-identical to what was certified previously. |
| `origin/main` after this checkpoint's work | unchanged at `6c00d00` (re-verified via `git fetch` immediately before writing this report) |
| Working tree | clean before this checkpoint's changes |
| Role Intelligence dependency observed | `roi:2026:w01:819dc3166607` (season 2026, through_week 1) — unchanged by the FI refresh, since that refresh never touches `lib/player-role-intelligence/`; Role Intelligence itself was not rebuilt to week 2 |

Repo-wide TypeScript regression: **2065 pass / 0 fail / 4 skipped** (2069 total) — Checkpoint C's 2036/0/4 baseline plus this checkpoint's 33 new tests (16 reader + 11 R/TS-parity + 6 isolation, net of 4 pre-existing isolation tests updated in place rather than added), zero regressions. `tsc --noEmit`: clean. `eslint`: 0 new errors/warnings in any file this checkpoint touched or created (the repo's pre-existing 10 errors/42 warnings, all in files this checkpoint never touched, are unchanged).

## 1. Frozen from Checkpoint C — not retuned

- **Model**: `CANDIDATE_4_HIERARCHICAL` (hierarchical role-vector allocator: pre-event Phase 2 share × trend multiplier × same-position affinity multiplier, normalized, scaled by a team→position→league shrunk empirical inheritance rate). The served artifact is fit **once more on the identical population** Checkpoint C used (2019–2025 onset, single-major-absence, DEFAULT threshold, 252 events) — this is a re-derivation from Checkpoint B's substrate for self-contained provenance, not a retune; the resulting priors are numerically what Checkpoint C already validated.
- **Windows**: training/calibration = 2019–2025; robustness = 2012–2018 (diagnostic only); 2026 = forward diagnostic only. **2026 never appears in the training window** — enforced as an executable invariant (`validateOpportunityPropagationModel` throws if `training_window.end_season >= 2026`).
- **Episode semantics**: calibrated against `EPISODE_ONSET` only; the manifest's `episode_semantics` field states this explicitly, and a live scenario is always evaluated as-if-onset (no continuation-adjustment model exists to apply instead).

## 2. Product identity

| Field | Value |
|---|---|
| `model_tag` | `opportunity-propagation-2026.1` |
| `opportunity_propagation_version` | `opi:2026:w01:bef17990fe91` (content-addressed; `generated_at` excluded from the hash — verified identical across two builds seconds apart) |
| `schema_version` | `opportunity-propagation-served:v1` |
| `deployment_state` | `SHADOW_ONLY` |
| `eligible_to_influence_production` | `false` |
| `production_numeric_influence` | `PROHIBITED` |

Distinct from and never overloading `football_intelligence_version` or `role_opportunity_version` (spec §4). `football_intelligence_dependency` is explicitly recorded as `null` in the manifest — Phase 3 shares raw nflverse caches with FI at the analysis layer but has **no real analytical dependency** on FI's own product, and the manifest says so rather than claiming one that doesn't exist (spec §5).

## 3. Role Intelligence dependency — first-class

`role_opportunity_dependency.role_opportunity_version = roi:2026:w01:819dc3166607` is a required manifest field (validated: `loadOpportunityPropagationModel()` throws if absent) and is embedded directly in `OpportunityPropagationIntelligenceLineage.role_opportunity_version` — every served prediction carries the exact Role Intelligence snapshot it was computed against, never inferred from whichever snapshot happens to be current at read time.

## 4. Scenario support contract (spec §9, §19-20)

| Trigger position | Support |
|---|---|
| RB | `CALIBRATED` (single-absence) |
| WR | `CALIBRATED` (single-absence) |
| TE | `CALIBRATED` (single-absence) |
| QB | `UNSUPPORTED_SCENARIO` — returns a typed result (`vacated_role: null`, `beneficiaries: null`), never routed through the propagation model, never a thrown error |
| 2+ unavailable players (any combination of RB/WR/TE) | `EXPERIMENTAL_MULTI_ABSENCE` — evaluated with the **same selected model**, never silently switched to next-man-up, never silently reduced to independent single-absence summation; each absent player's vacated share is allocated independently against the shared candidate pool (the same architecture Checkpoint C backtested and reported degraded metrics for) |

`support_level` is a field on every scenario result, not prose alone (spec §7). Verified live: a real QB (Aaron Rodgers, PIT) evaluated end-to-end returns `UNSUPPORTED_SCENARIO`; a real unknown id (`00-9999999`) returns `UNSUPPORTED_SCENARIO` with an explicit "unknown player" note, never `null` and never a thrown error.

## 5. Architecture — R/TS ownership decision (spec §39)

**Option A: R owns fitting/calibration; TS owns deterministic prediction from served parameters.** Chosen because interactive hypothetical scenarios (spec §52, "IF this RB is unavailable") need sub-millisecond evaluation against live Role Intelligence data, which a multi-minute R rebuild per hypothetical cannot provide (spec §58's explicit "if the model requires a multi-minute R rebuild for each hypothetical: architecture is wrong").

- **R** (`analysis/opportunity_propagation/serve_opportunity_propagation.R`): fits the frozen hierarchical priors + position-relationship weights once, writes a small served artifact (48KB total: 4 CSVs + 1 manifest JSON).
- **TS** (`lib/opportunity-propagation-intelligence/model.ts`): a direct, line-by-line port of the R allocator's formula (`allocateHierarchical`, `lookupInheritanceRate`, `trendMultiplier`, the same mutually-exhaustive-domain renormalization) — **not** a duplicated, independently-derived model. Proven numerically identical to the R implementation (§8 below), not merely "intended to match."

No divergent hidden model definitions: both sides are documented as mirroring each other, with an explicit warning in `model.ts`'s header that the shared constants (mutually-exhaustive dimension set, trend thresholds/multipliers, unbounded-dimension exemption) must always equal the R side's, and a permanent parity test (§8) that would fail the moment they drift.

## 6. Output schema (spec §14-18)

Every supported scenario exposes, per `(absent_player_id, domain, dimension)`:
- `vacated_role[]` — `vacated_opportunity` (the absent player's own current `recent` Phase 2 value, read via `loadRoleOpportunitySnapshot()`, never recalculated)
- `beneficiaries[]` — `observed_pre_scenario_role` (Phase 2's own value, **never overwritten**), `expected_scenario_role` (Phase 3's contingent prediction, a **different concept**, spec §15's hard invariant, held apart in the type system: two distinct fields, never one field silently repurposed), `expected_delta` (= `expected_scenario_role - observed_pre_scenario_role`, exactly — verified as an executable test on live data, spec §16), `confidence`, `evidence` (source tier + count + the actual rate used), and `trace` (pre-event-share weight, trend multiplier, position-affinity multiplier, normalized weight — spec §22's required decomposition, never an opaque final number)
- `residual[]` — `structural_residual` per domain, **never forced to zero** (verified: real live examples above show residuals ranging from −16.0pp to +76.8pp)

## 7. Distribution accounting (spec §18)

`clip_predicted_shares`'s TS port (`allocateHierarchical`) enforces, identically to the R side:
1. Individual bound: every `predicted_role` clipped to `[0,1]` except `air_yards_share` (not bounded by construction — real, valid negative shares exist).
2. Group bound: for mutually-exhaustive domains only (`target_share`, `position_group_target_share`, `rush_share`, `position_group_rush_share`, `rz_target_share`, `rz_carry_share`, `kick_return_role`, `punt_return_role` — **not** `snap_share`, since eleven players share the field), if the naive sum exceeds 1, every candidate in that group is proportionally rescaled to sum to exactly 1. Verified live (reader test #15) and via a dedicated bound check across a real scenario's full candidate pool.

## 8. R/TS numeric parity (spec §40, §51) — actual measured differences

`test/opportunity-propagation-r-ts-parity.test.ts` runs 5 fixture scenarios (RB absence/rushing, WR absence/cross-position receiving, TE absence, return-role, sparse-hierarchy-fallback), each computed twice: once by the **real** R function `allocate_candidate4_hierarchical()` (via `analysis/opportunity_propagation/generate_parity_fixtures.R`, committed as `analysis/opportunity_propagation/tests/fixtures/r_ts_parity_fixture.json`), once by the TS port. **Measured maximum difference: 0** (compared at `1e-9` tolerance; every value matched to at least 9 decimal places — effectively bit-identical, not merely "within tolerance"). The R-side test `test-nse-regression-and-parity.R` independently re-verifies the same fixture against the live R functions, so the fixture itself cannot silently drift from what R actually produces.

## 9. Permanent NSE regression test (spec §24/§50) — mandatory, delivered

Both Checkpoints B and C found real bugs where a function parameter named identically to a `data.table` column caused a silent self-reference (an always-TRUE comparison) instead of a scalar lookup. This checkpoint adds the required fixture: team `AAA`/position `WR`/`target_share` has a known historical rate of **1.20**; team `BBB`/same position/dimension has a known rate of **0.65** — `X ≠ Y`, and neither equals the 0.5 global default. Both the R-side (`inheritance_rate_lookup`, `attach_inheritance_rate` — the actual vectorized path the live model uses) and the TS-side (`lookupInheritanceRate`) are exercised directly against this fixture, on both sides of the R/TS boundary, and both correctly return `1.20`/`0.65` respectively — never silently collapsing to `0.5`. Fallback visibility is also tested: an unseen team falls to the position prior (`0.85`, tagged `POSITION_PRIOR`, never disguised as `TEAM_POSITION_HISTORY`); an unseen team **and** position falls to the league prior (`0.80`, tagged `LEAGUE_PRIOR`); a genuinely unknown dimension falls to the global default (`0.5`, tagged `GLOBAL_DEFAULT`) — this is the one case where `0.5` is correct, and the test confirms it is reached only there.

## 10. Confidence / support semantics (spec §26-27) — nothing invented

Manifest `confidence_semantics.tiers_supported = ["LOW", "INSUFFICIENT_EVIDENCE"]`, `tiers_not_supported = ["MEDIUM", "HIGH"]`. `uncertainty_ranges_supported: false`. Both facts are enforced as executable invariants (`validateOpportunityPropagationModel` throws if any other tier is served, or if ranges are marked supported). No decorative `HIGH` was introduced anywhere in this checkpoint, exactly as instructed — this serves precisely what Checkpoint C validated, nothing more.

## 11. Red zone, routes, returns (spec §28-30)

- **Red zone**: `HIGH_VALUE` domain rows carry the same `evidence`/`confidence` fields as every other domain — real live examples above show `rz_target_share` predictions tagged `INSUFFICIENT_EVIDENCE` with `evidence_count` as low as 2–3, never a confident goal-line claim manufactured from a tiny sample.
- **Routes**: `model_requires_routes: false` in the manifest, and no route-based feature exists anywhere in `model.ts`/`scenario.ts` — not a fallback path, a genuine absence, matching Checkpoint C's own finding.
- **Returns**: kept as their own domain end-to-end; verified as an executable test (reader test #9, and parity test's orthogonality check) that a return-domain prediction never touches an offensive-domain prediction for the same player and vice versa.

## 12. Phase 3 lineage (spec §31-32)

`OpportunityPropagationIntelligenceLineage` (`lib/canonical/lineage.ts`) — `version`, `model_tag`, `schema_version`, `season`, `through_week`, `generated_at`, `role_opportunity_version`, `scenario_support`. No predictions embedded (spec §31's explicit prohibition). `RecommendationLineage.opportunity_propagation_intelligence?: OpportunityPropagationIntelligenceLineage | null` is a **purely additive** optional field; `buildRecommendationLineage()`'s new 6th parameter defaults to `null`, so every pre-existing call site in the codebase keeps typechecking and keeps producing `null` unmodified (verified: `tsc --noEmit` clean across the whole repo, and an executable isolation test asserts the default-null behavior directly from source).

## 13. Phase 1 freshness integration (spec §33-36)

`assessOpportunityPropagationFreshness()` (`lib/canonical/intelligence-freshness.ts`) reuses `FRESHNESS_POLICY_VERSION`, `OverallFreshnessStatus`, `ConfidenceCap`, `NflRealityFrontier`, and `compareThroughWeekToReality()` verbatim — no `propagation-freshness-v1` parallel system. Critically, it **composes** an already-computed `RoleOpportunityFreshnessAssessment` rather than re-deriving Role Intelligence's own freshness logic: if the Role Intelligence dependency assessment is not `CURRENT`, the propagation assessment's `overall_status` can never read better (verified as an executable test, reader test #18, on a real assessment). This directly satisfies spec §34: a current-looking propagation artifact whose role dependency is stale is never reported as fully current.

`availability_scenario_source` defaults to `"CONSUMER_SUPPLIED"` and is recorded on every scenario result and every freshness assessment — Phase 3 never claims to know a player is currently `OUT` (spec §35); a future source-backed feed would set `"SOURCE_BACKED_CURRENT_AVAILABILITY"` explicitly rather than being silently conflated with the default.

The frozen Phase 1 NFL Reality Frontier is reused as-is (`NflRealityFrontier`, `compareThroughWeekToReality`) — no new reality-frontier implementation (spec §36).

## 14. Served model data (spec §37) — measured size

| Artifact | Size |
|---|---|
| `inheritance_priors_league.csv` | 0.4 KB |
| `inheritance_priors_position.csv` | 1.0 KB |
| `inheritance_priors_team.csv` | 23.1 KB |
| `position_relationship_weights.csv` | 0.4 KB |
| `supported_dimensions.csv` | 0.4 KB |
| `opportunity_propagation_manifest.json` | 4.9 KB |
| **Total served artifact** | **48 KB** |

No Checkpoint B beneficiary-observation rows (2.26M rows) are served — only the fitted parameters, exactly as instructed.

## 15. TS reader / model adapter (spec §38, §47)

`lib/opportunity-propagation-intelligence/{schema.ts, read.ts, model.ts, scenario.ts, lineage.ts, format.ts, index.ts}`. `read.ts`'s `loadOpportunityPropagationModel()` runs `validateOpportunityPropagationModel()` on every load (not just in tests), which checks — among the full spec §47 list — manifest schema completeness, exact model/schema versions, supported positions (exactly RB/WR/TE, QB absent), supported scenario type, Role dependency version present, non-empty model tables, bounded/finite inheritance rates, no duplicate model keys, no unsupported confidence tiers, `single_absence_support == "CALIBRATED"` and `multi_absence_support == "EXPERIMENTAL_MULTI_ABSENCE"` exactly, `training_window.end_season < 2026`, `historical_training_semantics.cause == "UNKNOWN"`, `deployment_state == "SHADOW_ONLY"`, and `eligible_to_influence_production == false`.

## 16. Scenario lookup API (spec §41-43)

`evaluateOpportunityPropagationScenario(request)` — library-access only, no HTTP endpoint (matching Phase 2's own precedent). `formatOpportunityPropagationScenario(result)` — deterministic (verified: byte-identical output across repeated calls on live data), does no new analysis, and is verified by an executable test to contain none of the forbidden fantasy-actionability vocabulary (`pick up`, `bench`, `waiver`, `FAAB`, `trade for`, `must-add`, `handcuff`, and `start` as a standalone recommendation word).

## 17. Live 2026 analytical scenarios (spec §52) — conditional only, no injury claims

Three real, current (2026 week 1) scenarios were generated end-to-end using players selected by querying the current Role Intelligence snapshot (never hard-coded before querying): **Kyle Juszczyk (SF, RB)**, **Keenan Allen (IND, WR)**, **Travis Kelce (KC, TE)**. Full formatted output for Kelce's scenario (excerpted; see repository test output for the complete run including Juszczyk and Allen):

```
Scenario: IF 00-0030506 unavailable for the full game (KC, season 2026 week 1)
Support: CALIBRATED -- single-absence: Checkpoint C's primary calibrated use case

Vacated PARTICIPATION/snap_share: 87.4%
  00-0036637 (TE): observed 49.9%, expected 68.6%, delta +18.7pp [INSUFFICIENT_EVIDENCE, evidence=TEAM_POSITION_HISTORY:3]
  00-0039894 (WR): observed 78.9%, expected 95.4%, delta +16.5pp [INSUFFICIENT_EVIDENCE, evidence=TEAM_POSITION_HISTORY:3]
  ...
  Structural residual: -7.1pp

Vacated RECEIVING/target_share: 16.6%
  00-0039067 (WR): observed 22.3%, expected 30.4%, delta +8.1pp [LOW, evidence=POSITION_PRIOR:184]
  ...
  Structural residual: -6.9pp
...
opportunity_propagation_version: opi:2026:w01:bef17990fe91
role_opportunity_version: roi:2026:w01:819dc3166607
```

No claim is made that any of these three players is actually injured, questionable, or out — this is a purely conditional "if unavailable" exercise against real current role data, exactly as scoped. No fantasy advice appears anywhere in the output.

## 18. Current real availability (spec §53) — not attempted

Optional and explicitly not pursued this checkpoint: no trustworthy current-availability source was audited or integrated. Hypothetical conditional scenarios (§17) are sufficient for Checkpoint D, per the instructions' own allowance.

## 19. Performance (spec §58)

| Measurement | Result |
|---|---|
| R served-artifact build (`serve_opportunity_propagation.R`, includes loading Checkpoint B/Phase 2 caches + fitting) | 4.6s |
| TS model load (cold, first call) | 2.1 ms |
| TS scenario evaluation (warm, avg over 100 calls, real RB scenario against live data) | **0.085 ms** |
| Served artifact size | 48 KB |

Scenario evaluation is sub-millisecond — fitting is the only expensive step, and it happens once in R, not per hypothetical. This is the architecture spec §58 requires ("fitting may be expensive; prediction should be cheap").

## 20. Production isolation (spec §54-56) — exact proof

- `git diff origin/main -- lib/weekly/ lib/trades/ lib/orchestrator/ lib/projections/ app/api/` → 0 lines.
- Structural grep test (`test/injury-opportunity-propagation-isolation.test.ts`, 6 tests): zero references to the propagation substrate or served product anywhere under `lib/weekly/`, `lib/trades/`, `lib/orchestrator/`, `lib/projections/`, `app/api/`, including explicit per-engine checks (`lib/weekly/waivers`, `lib/weekly/start-sit`, `lib/weekly/matchup`, `lib/weekly/lineup`, `lib/trades`, `lib/projections`).
- `lib/canonical/lineage.ts`'s addition verified purely additive from source (the new field is optional, the new constructor parameter defaults to `null`).
- Full TypeScript regression: 2065/0/4 — every pre-existing production test (waivers, Start/Sit, matchup, trades, projections, lineup) passes with **unchanged** expected values; this checkpoint's additions are new test files and additive type/lineage fields only.
- `lib/player-role-intelligence` (Phase 2, frozen) verified untouched by grep.

## 21. Tests — exact counts

| Suite | Count | Result |
|---|---|---|
| `test-nse-regression-and-parity.R` (R) | 4 `test_that` blocks (multiple assertions each) | 0 failures |
| `test-opi-version-determinism.R` (R) | 9 `test_that` blocks | 0 failures |
| Full R suite (`analysis/opportunity_propagation/tests/run.R` — fast-baselines, absence-events-invariants, checkpoint-c-invariants, nse-regression-and-parity, opi-version-determinism) | all files | 0 failures |
| `test/opportunity-propagation-r-ts-parity.test.ts` | 11 tests | 0 failures |
| `test/opportunity-propagation-reader.test.ts` | 16 tests | 0 failures |
| `test/injury-opportunity-propagation-isolation.test.ts` | 6 tests | 0 failures |
| Full repo `npm test` | 2069 total (2065 pass, 4 skipped) | 0 failures |
| `tsc --noEmit` | — | clean |
| `eslint` | — | 0 new issues |

## 22. Known limitations (complete list)

1. **Historical training cause is UNKNOWN for 100% of events** — no source in this repository distinguishes injury from any other cause of nonparticipation; the served manifest states this explicitly (`historical_training_semantics.cause: "UNKNOWN"`).
2. **v1 supports `FULL_GAME_NONPARTICIPATION` only** — no `LIMITED`/`QUESTIONABLE` scenario exists or is calibrated.
3. **RB/WR/TE only** as absent-player trigger positions.
4. **QB is explicitly unsupported** — returns a typed `UNSUPPORTED_SCENARIO` result, never routed through skill-position propagation.
5. **Multi-absence is `EXPERIMENTAL_MULTI_ABSENCE`, not calibrated** — Checkpoint C found materially weaker performance, and a simple next-man-up baseline beat the selected model specifically on multi-absence top-beneficiary accuracy; this checkpoint preserves the selected model (no invisible switching) but marks every multi-absence result as experimental, machine-readably.
6. **Coaching continuity (OC/DC) is unavailable** and not used anywhere — only season/team/player-team-change discontinuities are modeled (inherited from Checkpoint A/B/C).
7. **Route participation is not used and not required** — `model_requires_routes: false`, verified.
8. **No player-availability probability is modeled or estimated anywhere** — the scenario interface is strictly conditional ("IF unavailable"), never "P(unavailable) = X%".
9. **No fantasy-points, PPR, or scoring translation exists anywhere in this product** — enforced by an executable formatter test and by the complete absence of any such field in the type contract.
10. **No calibrated uncertainty range exists** — only `evidence_count`/`confidence` are served; a descriptive range was prototyped in Checkpoint C and found not to calibrate reliably at the current sample size, so it is not served here either.
11. **Confidence is limited to `LOW`/`INSUFFICIENT_EVIDENCE`** — no `MEDIUM`/`HIGH` tier has ever been validated.
12. **HIGH_VALUE (red zone) predictions are frequently `INSUFFICIENT_EVIDENCE`** given the domain's genuine sparsity — this is surfaced per-prediction, not glossed over.
13. **No continuation-adjustment model** — every scenario is evaluated as-if-onset; prolonged-absence adaptation is not modeled.
14. **No current real-availability source is integrated** (spec §53, optional, deliberately deferred).

---

**CHECKPOINT D COMPLETE — READY FOR REVIEW**

Do not begin Checkpoint E until this checkpoint is reviewed.
