# Intelligence Modernization — Phase 8: FI Live Re-certification & Selective Activation

Branch `intelligence-modernization-phase8-fi-recertification` (from `main` @ `d0c997e`). **Not merged, not deployed, nothing activated.**
**Verdict: CERTIFIED — NO FI FAMILY EARNED PRODUCTION ELIGIBILITY.** (Outcome D, with C behind it: all 30 evaluable family × position candidates are `CERTIFICATION_FAILED`; even a pass could not have exceeded `CERTIFICATION_PASSED` because prospective evidence is 0.) This is a successful Phase 8: the system can now answer, per family × position, whether a signal earned numeric influence — and the answer, with evidence, is no.

## 1. Starting Git / production state
`main` = `origin/main` = production `dpl_EkTLMU9YQWsR6GJWLnTBL4rvc9mY` @ `d0c997e` (Phase 7 closeout). 0 intervening commits, so nothing to audit. `origin/main` re-checked before the final commit: unchanged. Branch created from reconciled main; no merge, no deploy, no `PRODUCTION_ACTIVE`.

## 2. Current FI manifest and live freshness (Checkpoint A)
FI `fi:2026:w02:e1ffe025708b`, model `ri-football-intel-2026.1`, season 2026, **through_week 2, week state PARTIAL (15/16 games)**; all raw-source cutoffs = week 2 (ftn_charting, ngs_*, pbp, pfr_def, pfr_pass, snap_counts); **`participation` absent**. Live NFL frontier (Sleeper schedule): week 2, 15/16 complete — matches FI, so the canonical Phase 1 evaluator returns **`PARTIAL_CURRENT`** (usable, no fallback), *not* `CURRENT`. Provider nominal week = 2 (equal to the frontier only because a week-2 game is complete; the evaluator uses the frontier, not the nominal week). Family status: `PBP_TEAM_EFFICIENCY`, `SNAP_COUNTS`, `PFR_PRESSURE`, `NGS`, `FTN_DESCRIPTIVE`, `COVERAGE_UNIT_PROFILES`, `CONTEXTUAL_MATCHUP` AVAILABLE/AT_CUTOFF; **`PLAYER_USAGE` and `ROUTE_PARTICIPATION` UNAVAILABLE** for 2026. Production baseline snapshot recorded for `bloodline-bowl/supyo29`, `bloodline-bowl/bijimac`, `devoted-to-the-game/darthmarker` (six surfaces hashed; used for §37). Finding: the existing shadow readiness call passes **no** `nfl_reality`, so it never judges FI against the live frontier (`NO_INDEPENDENT_FRONTIER`, INFO). This is harmless while FI is shadow-only and is why the new numeric gate requires a frontier-backed `CURRENT` assessment.

## 3. Feature-family inventory
| Family (FI) | Source / freshness family | Output class / predictive status | Numeric translation today | As-of historical series? | State |
|---|---|---|---|---|---|
| off_pass_epa, off_rush_epa, off_success_rate, off_proe, off_pace_sec_play, off_explosive_pass_rate | pbp → `PBP_TEAM_EFFICIENCY` | MODELED / PREDICTIVE | shadow (QB/RB/WR/TE per model) | yes (decision dataset) | evaluated |
| def_success_allowed | pbp → `PBP_TEAM_EFFICIENCY` | MODELED / PREDICTIVE | shadow | yes | evaluated |
| def_pass_epa_allowed, def_rush_epa_allowed | pbp | MODELED / **NOT_PREDICTIVE** | none (forced 0) | yes but barred | not evaluated, SHADOW_ONLY |
| usage_snap_share / target_share / rush_share / route_participation | snap_counts, participation → `SNAP_COUNTS`/`PLAYER_USAGE`/`ROUTE_PARTICIPATION` | MODELED / PREDICTIVE | shadow (RB/TE) | yes | evaluated |
| interaction_pass_epa_vs_pass_defense, interaction_rush_epa_vs_rush_defense | pbp → `CONTEXTUAL_MATCHUP` | MODELED / WEAKLY_PREDICTIVE | shadow (WR) | yes | evaluated |
| PFR pressure / pass-rush | pfr_pass, pfr_def → `PFR_PRESSURE` | OBSERVED/DESCRIPTIVE | none | **no** | NOT_EVALUABLE, SHADOW_ONLY |
| NGS passing/rushing/receiving | ngs_* → `NGS` | OBSERVED/DESCRIPTIVE | none | **no** | NOT_EVALUABLE |
| coverage-unit profiles (WR/RB/TE) | pbp → `COVERAGE_UNIT_PROFILES` | DESCRIPTIVE_ONLY | none | no | DESCRIPTIVE_ONLY |
| FTN descriptive (play_action_rate, man rate) | ftn_charting → `FTN_DESCRIPTIVE` | DESCRIPTIVE_ONLY | none | no | DESCRIPTIVE_ONLY |
| contextual matchup / receiver progression | pbp | Phase 5: 0 predictive-incremental families | none | — | not re-tested (§24) |
Consumer of every numeric translation: Start/Sit **shadow** only. K / D/ST / IDP: out of scope.

## 4. Existing shadow model audit (`ri-startsit-2026.1`, frozen, sha `85d2ddd5…`)
Residual ridge per position; `target = actual − trailing PPG` (defect D7); global `tau_tie_break = 3`, cap `0.25·|baseline|`; conf weights HIGH 1/MED .5/LOW .2/INSUF 0; prior-dominated haircut 0.6; per-position β fitted (not heuristic) but **families cannot be isolated** in the served artifact and **per-position verdicts were computed partly in-sample** (D8) and against the trailing control (D10). Adjustments are additive, bounded by the cap, and missing FI ⇒ 0. Prior evidence: FI beat the *naive* control slightly (acc Δ +0.0007) but was a **net loser against the production-like (Sleeper) baseline** (47.4% reversal win rate, −0.48 pts/reversal). It was treated as a research artifact, not a candidate; nothing was reused as evidence.

## 5. Deployment-contract audit
Lifecycle `SHADOW_ONLY → RESEARCH_ELIGIBLE → CERTIFICATION_PASSED → PRODUCTION_ELIGIBLE → PRODUCTION_ACTIVE` (+ `CERTIFICATION_FAILED`) with `isValidTransition` (no skips). State granularity was **whole-model + per-position** only: activating a position would have activated *every* family at that position — including uncertified ones. That is the Step 5 gap. Only `PRODUCTION_ACTIVE` may influence production; served contract: `deployment: SHADOW_ONLY`, `positions: {}`, empty activation log.

## 6. Feature-family gating design (additive)
`deployment_contract.family_positions[position][family]` (optional; absent on every existing contract) + `certified_translations`. **Unconfigured ⇒ `SHADOW_ONLY`; nothing inherits from the whole-model or position state.** `fiMayInfluenceProduction(model, position)` is unchanged (existing readers/tests untouched) and is now *necessary but not sufficient*. New `lib/weekly/start-sit-fi/family-gate.ts::evaluateFamilyGate` requires **all** of: position ACTIVE, **family ACTIVE**, certification evidence at `PRODUCTION_ELIGIBLE`/`ACTIVE`, a certified translation whose coefficient equals the evaluated one, START_SIT consumer, a canonical freshness assessment that is `CURRENT`/usable/no-fallback with **the family's own freshness sources usable**, compatible scoring fingerprint, resolved Phase 7 temporal identity, and an FI vintage `through_week ≤ decision_week − 1`. Fail-closed on any missing input. `applyFiToProductionBatch` was tightened to this gate (no-caller function; source-scan pinned).

## 7. Baseline definition (frozen before evaluation)
**Primary: `baseline_sleeper` = Sleeper weekly projection history (RotoWire-backed)** — the production baseline projection is `sleeper-weekly-rotowire`, so the history is a **RECONSTRUCTED_PRODUCTION_LIKE** baseline (2021 no timestamp, 2022 bulk-backfilled, 2023–25 revision-possible). It is never called "historical production". **Naive control: `baseline_trailing`** (EW trailing PPG) — context only. Baseline integrity (dev seasons 2023–24, 16,522 rows): **MAE 4.305 (Sleeper) vs 4.692 (trailing)** — the primary baseline is 0.39 pts better; the best FI effect below is ~50× smaller.

## 8. Chronology rules
Training seasons strictly < test season; 2021/2022 rows are training-only (weakest baseline vintage); weeks 4–17; no random splits; FI features rebuilt as-of `W−1` (AS_OF discontinuity mode; participation lag 2); actuals never predictors; team/opponent are the dataset's as-of values (Phase 7 as-of identity is the authority for any live use; no `latest_team`, no current Role label). **Future-mutation invariance** (`analysis/football_intel_phase8/tests/future_mutation.R`): scrambling every 2025 column leaves the development results byte-identical; scrambling 2024+2025 leaves every 2023-fold result identical while the 2024 fold (the control) changes.

## 9. Historical snapshot / vintage limitations
No immutable per-week FI snapshots exist for 2021–2025; the served FI is a single current snapshot. Lanes: `TRUE_AS_OF` (immutable pre-kickoff FI + captured pre-kickoff baseline) exists only for 2026 live captures (currently none qualifying); **`RECONSTRUCTED_CHRONOLOGY_SAFE`** is the only historical lane used; `CURRENT_REBUILD_NOT_HISTORICAL` is never used as evidence. Consequence, pre-registered: historical evidence alone can never justify `PRODUCTION_ELIGIBLE`.

## 10. Pre-registered certification gates
Committed in `90a06a8` (`analysis/football_intel_phase8/certification_criteria.json`, `fi-recert-criteria-2026.1`) **before any evaluation**, and the script in `01579ea` before it was run. Gates: G1 chronology; G2 sample (≥12 weeks/fold, ≥300 dev reversals, ≥100 holdout); G3 dev MAE improvement ≥ **+0.03 fantasy pts**, 90% cluster-bootstrap CI lower > 0, BH q ≤ 0.10 over 30 tests; G4 sign stability (both folds + each archetype); G5 close-call decision (regret CI lower > 0, win rate ≥ 0.52, severe-miss ≤ large-win); G6 holdout; G7 calibration (slope 0.5–1.5, CI lower > 0, monotone quintiles); G8 no subgroup with CI upper < −0.03; G9 redundancy; G10–15 implementation gates by test. **Amendment A1** (`2a2868d`, conservative, recorded after dev results were visible and before final states): a candidate whose CI *upper* bound is < +0.03 cannot meet G3 at any supportable sample, so it is `CERTIFICATION_FAILED` rather than "inconclusive". It only converts INCONCLUSIVE → FAILED, changes no threshold, promotes nothing, and affected 10 candidates with near-zero adjustments.

## 11. Evaluation dataset
`outputs/startsit-2026/decision_dataset.rds`: 53,446 rows after filters (finite baseline+actual, weeks 4–17), 2021–2025, QB/RB/WR/TE × std/half/ppr (`arch` fitted separately). Read-only.

## 12. Walk-forward design
Development folds: train 2021–22 → test 2023; train 2021–23 → test 2024. **Holdout: train 2021–24 → test 2025**, touched only for candidates passing all development gates (none did) — `results_holdout.json`: `opened: false`. Per candidate: single-family ridge on the sum scale, λ ∈ {0,100,1000,10000} chosen on the latest prior season only, standardisation on train only, served confidence weighting, cap 0.25, close-call τ ∈ {0.5,1,1.5,2,3} selected on development folds (≥100 reversals). Cluster bootstrap over (season, week), B = 2000, seed 20260921, 90% intervals; BH across 30 tests. Deterministic (rerun byte-identical). Note: season 2025 was the evaluation season of the earlier v1 backtest, so "sealed" is relative to Phase 8.

## 13. Per-position results (all 30 tests; development folds 2023–24; + = baseline improved)
| Pos | Family | MAE Δ (fantasy pts) [90% CI] | Δ 2023 / Δ 2024 | Close-call decisions | Calib. slope | BH q | State |
|---|---|---|---|---|---|---|---|
| QB | `off_pass_epa` | -0.0001 [-0.0004, +0.0002] | -0.0003 / +0.0001 | <100 reversals | 18.35 | 1.00 | CERTIFICATION_FAILED (EFFECTIVELY_ZERO_OR_HARMFUL) |
| QB | `off_success_rate` | +0.0001 [-0.0002, +0.0004] | -0.0000 / +0.0002 | <100 reversals | 66.06 | 1.00 | CERTIFICATION_FAILED (EFFECTIVELY_ZERO_OR_HARMFUL) |
| QB | `off_proe` | -0.0044 [-0.0195, +0.0096] | +0.0014 / -0.0102 | 1089 rev, win 0.443, Δregret/pair -0.0281 [-0.0901] | -0.19 | 1.00 | CERTIFICATION_FAILED (FAILED_DEV_GATES) |
| QB | `off_pace_sec_play` | -0.0000 [-0.0002, +0.0001] | -0.0001 / +0.0000 | <100 reversals | -108.93 | 1.00 | CERTIFICATION_FAILED (EFFECTIVELY_ZERO_OR_HARMFUL) |
| QB | `off_explosive_pass_rate` | -0.0014 [-0.0086, +0.0061] | -0.0027 / +0.0000 | 208 rev, win 0.548, Δregret/pair +0.0382 [-0.1122] | -1.71 | 1.00 | CERTIFICATION_FAILED (EFFECTIVELY_ZERO_OR_HARMFUL) |
| QB | `def_success_allowed` | -0.0168 [-0.0386, +0.0034] | -0.0332 / -0.0003 | 838 rev, win 0.464, Δregret/pair -0.0244 [-0.0972] | -0.64 | 1.00 | CERTIFICATION_FAILED (FAILED_DEV_GATES) |
| QB | `interaction_pass_epa_vs_pass_defense` | -0.0001 [-0.0004, +0.0001] | -0.0002 / -0.0001 | <100 reversals | -66.54 | 1.00 | CERTIFICATION_FAILED (EFFECTIVELY_ZERO_OR_HARMFUL) |
| RB | `off_rush_epa` | +0.0020 [-0.0010, +0.0051] | +0.0008 / +0.0032 | 1547 rev, win 0.515, Δregret/pair +0.0499 [-0.0023] | 1.80 | 1.00 | CERTIFICATION_FAILED (FAILED_DEV_GATES) |
| RB | `off_success_rate` | -0.0012 [-0.0019, -0.0005] | -0.0008 / -0.0017 | 283 rev, win 0.491, Δregret/pair +0.0001 [-0.0185] | -3.84 | 1.00 | CERTIFICATION_FAILED (EFFECTIVELY_ZERO_OR_HARMFUL) |
| RB | `off_pace_sec_play` | -0.0057 [-0.0091, -0.0024] | -0.0113 / -0.0000 | 1083 rev, win 0.437, Δregret/pair -0.0141 [-0.0251] | -3.41 | 1.00 | CERTIFICATION_FAILED (FAILED_DEV_GATES) |
| RB | `def_success_allowed` | -0.0002 [-0.0004, -0.0000] | -0.0004 / -0.0000 | <100 reversals | -19.46 | 1.00 | CERTIFICATION_FAILED (EFFECTIVELY_ZERO_OR_HARMFUL) |
| RB | `usage_snap_share` | +0.0007 [-0.0014, +0.0028] | +0.0012 / +0.0002 | 518 rev, win 0.487, Δregret/pair +0.0012 [-0.0279] | 0.66 | 1.00 | CERTIFICATION_FAILED (FAILED_DEV_GATES) |
| RB | `usage_rush_share` | +0.0009 [-0.0005, +0.0023] | +0.0006 / +0.0012 | 293 rev, win 0.450, Δregret/pair -0.0049 [-0.0084] | 1.42 | 1.00 | CERTIFICATION_FAILED (EFFECTIVELY_ZERO_OR_HARMFUL) |
| RB | `usage_target_share` | -0.0004 [-0.0038, +0.0029] | +0.0013 / -0.0021 | 814 rev, win 0.506, Δregret/pair +0.0056 [-0.0353] | 2.45 | 1.00 | CERTIFICATION_FAILED (FAILED_DEV_GATES) |
| RB | `interaction_rush_epa_vs_rush_defense` | +0.0001 [-0.0004, +0.0006] | -0.0000 / +0.0002 | 253 rev, win 0.552, Δregret/pair +0.0114 [-0.0055] | 0.19 | 1.00 | CERTIFICATION_FAILED (EFFECTIVELY_ZERO_OR_HARMFUL) |
| WR | `off_pass_epa` | -0.0005 [-0.0031, +0.0021] | +0.0010 / -0.0020 | 2517 rev, win 0.506, Δregret/pair -0.0006 [-0.0063] | -1.05 | 1.00 | CERTIFICATION_FAILED (FAILED_DEV_GATES) |
| WR | `off_success_rate` | -0.0005 [-0.0012, +0.0003] | -0.0006 / -0.0003 | 721 rev, win 0.498, Δregret/pair +0.0019 [-0.0104] | -2.56 | 1.00 | CERTIFICATION_FAILED (FAILED_DEV_GATES) |
| WR | `off_proe` | -0.0001 [-0.0036, +0.0035] | +0.0026 / -0.0028 | 4075 rev, win 0.504, Δregret/pair -0.0050 [-0.0137] | -0.34 | 1.00 | CERTIFICATION_FAILED (FAILED_DEV_GATES) |
| WR | `off_pace_sec_play` | +0.0000 [-0.0015, +0.0013] | +0.0014 / -0.0014 | 1878 rev, win 0.460, Δregret/pair -0.0033 [-0.0100] | 1.44 | 1.00 | CERTIFICATION_FAILED (FAILED_DEV_GATES) |
| WR | `off_explosive_pass_rate` | -0.0002 [-0.0004, +0.0001] | -0.0003 / -0.0000 | 236 rev, win 0.549, Δregret/pair +0.0041 [-0.0023] | -7.15 | 1.00 | CERTIFICATION_FAILED (EFFECTIVELY_ZERO_OR_HARMFUL) |
| WR | `def_success_allowed` | +0.0007 [-0.0002, +0.0015] | +0.0002 / +0.0012 | 663 rev, win 0.570, Δregret/pair +0.0152 [+0.0005] | 7.18 | 1.00 | CERTIFICATION_FAILED (FAILED_DEV_GATES) |
| WR | `usage_target_share` | -0.0079 [-0.0242, +0.0076] | -0.0206 / +0.0055 | 7414 rev, win 0.455, Δregret/pair -0.0256 [-0.0442] | 0.06 | 1.00 | CERTIFICATION_FAILED (FAILED_DEV_GATES) |
| WR | `usage_route_participation` | +0.0062 [-0.0039, +0.0166] | +0.0066 / +0.0057 | 7635 rev, win 0.465, Δregret/pair -0.0176 [-0.0402] | -0.16 | 1.00 | CERTIFICATION_FAILED (FAILED_DEV_GATES) |
| WR | `interaction_pass_epa_vs_pass_defense` | +0.0009 [+0.0003, +0.0015] | +0.0000 / +0.0018 | 407 rev, win 0.565, Δregret/pair +0.0143 [+0.0030] | 12.62 | 0.25 | CERTIFICATION_FAILED (FAILED_DEV_GATES) |
| TE | `off_pass_epa` | -0.0015 [-0.0048, +0.0020] | +0.0012 / -0.0041 | 667 rev, win 0.502, Δregret/pair +0.0116 [-0.0260] | -0.51 | 1.00 | CERTIFICATION_FAILED (FAILED_DEV_GATES) |
| TE | `off_success_rate` | -0.0019 [-0.0089, +0.0047] | +0.0054 / -0.0091 | 1610 rev, win 0.529, Δregret/pair +0.0499 [-0.0260] | 0.38 | 1.00 | CERTIFICATION_FAILED (FAILED_DEV_GATES) |
| TE | `off_pace_sec_play` | -0.0008 [-0.0027, +0.0010] | +0.0001 / -0.0017 | 387 rev, win 0.475, Δregret/pair +0.0147 [-0.0016] | 2.57 | 1.00 | CERTIFICATION_FAILED (FAILED_DEV_GATES) |
| TE | `def_success_allowed` | -0.0028 [-0.0088, +0.0028] | -0.0060 / +0.0004 | 914 rev, win 0.498, Δregret/pair +0.0039 [-0.0448] | -0.97 | 1.00 | CERTIFICATION_FAILED (FAILED_DEV_GATES) |
| TE | `usage_target_share` | +0.0084 [-0.0150, +0.0328] | +0.0182 / -0.0013 | 2362 rev, win 0.470, Δregret/pair -0.0214 [-0.0492] | -0.13 | 1.00 | CERTIFICATION_FAILED (FAILED_DEV_GATES) |
| TE | `usage_route_participation` | +0.0066 [-0.0123, +0.0254] | +0.0122 / +0.0011 | 1889 rev, win 0.498, Δregret/pair +0.0068 [-0.0755] | -0.40 | 1.00 | CERTIFICATION_FAILED (FAILED_DEV_GATES) |

Summary: **11 of 30 point estimates are positive, 19 negative; range −0.0168 … +0.0084; none reaches +0.03; minimum BH q = 0.255 (nothing significant after multiplicity control).** Detectably harmful (CI upper < 0): RB `off_success_rate`, `off_pace_sec_play`, `def_success_allowed`. Detectably positive MAE (CI lower > 0): only WR `interaction_pass_epa_vs_pass_defense`, at +0.0009 — real but ~33× below the minimum meaningful effect (Step 11's "statistically detectable is not enough").

## 14. Feature-family ablations
Every family was tested individually (baseline vs baseline + family X) — that is the table above. The **served-structure bundles** (non-gating comparator, dev folds only, holdout never opened for bundles): QB −0.0075 [−0.0175, +0.0027], RB −0.0092 [−0.0167, −0.0016], WR +0.0007 [−0.0029, +0.0040], TE +0.0094 [−0.0092, +0.0316]. No bundle beats its best individual family and none reaches the bar, so no family could ride in on a bundle.

## 15. Redundancy analysis
Features correlate weakly with fantasy points (median |r| = 0.073, max 0.545) and more with the baseline (median 0.109, **max 0.863** — usage/pace signals largely restate what the baseline already prices), but their correlation with the **residual** (actual − baseline) is ≈ 0 (median |r| = 0.030, max 0.074). Correlation with fantasy points is therefore not incremental value: the baseline already contains it.

## 16. Close-call analysis
The prior τ = 3 gate was re-selected per candidate on development folds (τ chosen ∈ {0.5,…,3}). Only **two** candidates show a statistically positive close-call regret improvement: WR `def_success_allowed` (663 reversals, win 0.570, +0.0152 pts/close pair, CI lower +0.0005) and WR `interaction_pass_epa_vs_pass_defense` (407 reversals, win 0.565, +0.0143, CI lower +0.0030). Both are tiny (≈ 0.015 pts per close call), both fail the MAE effect gate (+0.0007 / +0.0009 vs 0.03), calibration (slope 7.2 / 12.6 vs 0.5–1.5) and BH (q ≥ 0.255). No family shows benefit outside the close-call region: no evidence supports overriding a baseline edge ≥ τ.

## 17. Decision regret
Reported per candidate in the results artifact (`results_dev.json` / Book-Ready `certification.decision_regret`): reversals, win rate, mean/median regret delta per reversal, % improved/worsened, severe-miss rate (regret increase ≥ 8 pts) vs large-win rate. Several candidates lose decisions on average: WR `usage_target_share` (7,414 reversals, win 0.455, −0.0256 regret/pair, CI lower −0.0442), WR `usage_route_participation` (win 0.465, −0.0176), TE `usage_target_share` (win 0.470, −0.0214), RB `off_pace_sec_play` (win 0.437, −0.0141, CI lower −0.0251). Small wins are not paired with catastrophic misses in any candidate that would otherwise qualify — moot, none qualifies.

## 18. Calibration
Slope of realised residual on predicted adjustment: for most candidates the slope is negative or wildly outside [0.5, 1.5] (e.g. QB `def_success_allowed` −0.64, RB `off_pace_sec_play` −3.4, WR `def_success_allowed` 7.2) or undefined because the adjustment barely varies (p95 |adj| ≈ 0.01). No candidate passes G7. **FI confidence labels (HIGH/MEDIUM/LOW) have not been shown to correspond to increasing reliability for numeric adjustments**; none may be treated as a validated probability.

## 19. Freshness gating
Implemented as `evaluateFamilyGate`, which **consults** `assessIntelligenceFreshness` output (never recomputes freshness; the Phase 1 evaluator is unmodified). Numeric use is stricter than the evaluator's own START_SIT policy (which is low-materiality because FI had no numeric influence when written): only overall `CURRENT` passes; `PARTIAL_CURRENT`, `DEGRADED`, `STALE`, `INCOMPATIBLE`, FI-ahead-of-reality, schedule conflict and season mismatch all block. Tests use the **real** evaluator for: CURRENT (control: allowed), PARTIAL_CURRENT, confirmed STALE, FI ahead of reality, season/schedule mismatch, missing assessment, missing source, expected publication lag.

## 20. Family-specific freshness
`FI_FAMILY_FRESHNESS_DEPENDENCIES` maps each model family to the freshness families it needs (`off_*`/`def_*` → PBP_TEAM_EFFICIENCY; `usage_snap_share` → SNAP_COUNTS + PLAYER_USAGE; `usage_route_participation` → ROUTE_PARTICIPATION + PLAYER_USAGE; interactions → PBP + CONTEXTUAL_MATCHUP; unknown family ⇒ blocked). Tested: with `participation` absent, `usage_route_participation` is blocked while a PBP-derived family stays allowed — one lagging source does not switch off unrelated families.

## 21. Live 2026 re-certification (`scripts/fi-recert-live.ts`, read-only)
See §2. Of the 12 served-model family × position gates, **0 are allowed**; source usability is family-specific — 9 of 12 have all sources usable (PBP-based), 3 do not (`RB usage_snap_share`, `TE usage_route_participation`, `TE usage_target_share`: `PLAYER_USAGE`/`ROUTE_PARTICIPATION` unavailable). Every gate is additionally blocked by: not certified, not active, no certified translation, `FRESHNESS_NOT_CURRENT` (PARTIAL_CURRENT) and `SOURCE_VINTAGE_AFTER_DECISION` (FI through week 2 vs a week-2 decision).

## 22. Shadow results (observational; not activation evidence)
Live shadow output for the three pairs at week 2 (`fi:2026:w02:e1ffe025708b`): 16 adjustments per roster, **14 nonzero** per roster; WR |adj| up to 0.79–0.98 pts (mean 0.43–0.62), QB up to 0.48, RB ≤ 0.05, TE ≈ 0.06; **0 lineup changes** in all three; 0–1 Start/Sit deltas; confidence MEDIUM 8 / LOW 6 / INSUFFICIENT 2 per roster; reason codes dominated by `FI_OPPONENT_DEFENSE_*`, `FI_LOW_CONFIDENCE`, `FI_SHADOW_ONLY`. One week says nothing about value; the historical result in §13 is the evidence.

## 23. Prospective evidence status
Durable `bridge_startsit_shadow_captures`: **25 captures, all week 2; 3 `LIVE_CAPTURED` (pre-lock) + 22 `LIVE_POST_LOCK`; 0 outcomes.** Re-evaluation manifest: 0 qualifying 2026 weeks (need ≥ 4); FI as-of features are unbuildable before week 3; no pre-kickoff production-baseline captures. Post-lock rows are not treated as prospective recommendations. **Prospective evidence is insufficient.**

## 24. Prospective gate (derived, documented before outcomes exist)
Existing gate `evidence-gate-2026.2` retained (≥ 4 qualifying weeks). Added for FI activation: **≥ 150 live-captured reversal-eligible decisions per candidate family × position across ≥ 3 distinct weeks, prospective mean regret improvement ≥ 0.** Derivation: historical close-call reversals occur in ~3% of pairs with per-reversal outcome SD ≈ 3–4 fantasy pts, so n = 150 gives SE ≈ 0.3 pts — the smallest effect worth acting on. Not copied from Phase 5. Current: 0 weeks, 3 pre-lock captures, 0 outcomes ⇒ highest reachable state from any evidence is `CERTIFICATION_PASSED`.

## 25. Scoring integration
Evaluated in league-style fantasy points per archetype (std / half / ppr fitted separately, `pts_*` from the dataset), not generic points; the gate requires `scoring_fingerprint ∈ translation.certified_scoring_fingerprints`. Phase 6 code is untouched (0 diff), including the return-yard fix and position premiums. FI is not used to patch K/D-ST provider limitations; K, D/ST and IDP are excluded.

## 26. Matchup 2.0 boundary
Phase 5 (13 interaction families, 0 predictive-incremental, no numeric adjustment) stands. FI's `interaction_*` families were tested here **as FI families** under the same chronology-safe rules and failed; contextual-matchup features were not promoted. FI is not a loophole around Phase 5.

## 27. Player-Scheme boundary
Player-Scheme evidence stays DESCRIPTIVE; no Player-Scheme-derived family was evaluated or promoted (no chronology-safe series; the window semantics are Phase 7's `scheme_window_vintage`). It would have to pass the same evaluation.

## 28. Temporal identity boundary
Phase 7 is the authority for as-of team/opponent: the gate requires `temporal_membership_resolved`; unresolved membership blocks. **P7-F2 (crosswalk pagination / GSIS migration) was not touched**: no pagination, no id migration, no `playerId()` change (0 diff in `lib/canonical`, `lib/temporal-identity`).

## 29. Translation / caps
No family earned a translation, so **no certified translation exists**. The seam defines the shape a future one must take: `kind: TIE_BREAK_ONLY | RESIDUAL_ADJUSTMENT`, unit fantasy points, β (must equal the evaluated coefficient), cap fraction (≤ 0.25 of |baseline|, evidence-bounded), τ (tie-break region), certified scoring fingerprints, missing-data = zero adjustment. `boundedAdjustment` never returns NaN/∞; `startSitPick` cannot overturn a baseline edge ≥ τ regardless of signal size; TIE_BREAK_ONLY adjustments are **never** added to `projected_points`.

## 30. Failed-family inventory (retained; never deleted)
All 30 evaluated candidates (table in §13) are `CERTIFICATION_FAILED`: 20 by failed development gates, 10 by amendment A1 (near-zero adjustments). Full metrics live in `analysis/football_intel_phase8/results/results_dev.json` and `lib/weekly/data/fi_certification_2026.1.json`. **Watch-list (no state change):** WR `def_success_allowed` and WR `interaction_pass_epa_vs_pass_defense` — the only two with a positive close-call signal — should be re-examined only with new (prospective) evidence, not re-tuned on this data.

## 31. Multiple-testing controls
30 development tests, Benjamini–Hochberg (q ≤ 0.10): minimum q = 0.255, so nothing survives. Holdout Bonferroni was pre-specified but never needed (no survivors). No cherry-picking: every test is reported.

## 32. Holdout
2025 sealed: `opened: false`; no parameter was tuned on it; τ/β/λ are selected on development folds only. Limitation: 2025 fed the earlier v1 backtest, so it is "untouched by Phase 8", not "never seen".

## 33. Reversibility
Tested: family ON → adjusted output; family OFF (config-only) → the **same batch object** (exact baseline); any single failing gate (stale FI, wrong fingerprint, vintage, unresolved identity) → baseline values; no gate context → fail closed. Rollback = remove the family from `family_positions` (or set `SHADOW_ONLY`); no data migration; baseline path unchanged.

## 34. Lineage
`ContributionLedger` (single owner `START_SIT`) records per (player, family): FI version, through-week, scoring fingerprint, baseline projection version, translation/certification version, deployment state, freshness status, expected adjustment, baseline and final projection, applied flag and block reasons. A second contribution for the same (player, family), or from another owner, is refused and recorded as a violation (no double counting).

## 35. Production seam
`applyFiToProductionBatch` remains the one sanctioned point and remains **uncalled** (source-scan pins that no production code imports the gate, ledger or production gate; waivers/trades/matchup/orchestrator/waiver2/market-state never reference numeric FI application). No caller was wired because no family reached `PRODUCTION_ELIGIBLE` (Step 37).

## 36. Consumer scope
Certification applies to **START_SIT only**. Waivers, Trades, Matchup, FAAB and roster valuation are `CONSUMER_SCOPE_NOT_START_SIT`-blocked by the gate and would each need independent validation.

## 37. Production isolation
Base `d0c997e` vs this branch, 3 pairs (`bloodline-bowl/supyo29`, `bloodline-bowl/bijimac`, `devoted-to-the-game/darthmarker`) × 2 interleaved rounds: **all six surfaces (lineup, start_sit, waivers, matchup, matchup_leverage, positional_needs) identical, 0 differing sections.** Zero diff in Phase 5/6/7 paths, `lib/canonical`, and the served `start_sit_model.json` (sha `85d2ddd5…`, pinned by test). Phase 5 captures: 291 rows, original-population digest `e0816ec3a3b9edf2a0b6cd7639fb05c0` unchanged.

## 38. Performance
Freshness assessment 8 µs; one-player translation 4 µs; 16-player roster shadow adjustment 35 µs; one family gate 0.7 µs; all 12 served family gates 5.6 µs; certification artifact load (cached) 0.02 µs; Book-Ready `fi.certification` 0.9 ms (default) / 0.2 ms (detail). Freshness is assessed once per request and shared; nothing re-parses FI per player.

## 39. Tests
Full suite **2,667 total / 2,663 passed / 0 failed / 4 skipped**; `tsc --noEmit` clean; eslint 0 errors/0 warnings on changed files; `test/fi-recertification.test.ts` **51** (A certification evidence 8, B no-inheritance 5, C freshness gate matrix 17, D reversibility/ledger/bounds 11, E scope/isolation 4, F Book-Ready & Analysis Book 6); R future-mutation invariance PASS; existing Start/Sit FI, freshness, capture-integrity, system-trust and registry suites pass unchanged.

## 40. Limitations
Historical lane is reconstructed, not true as-of; the primary baseline is production-*like* (Sleeper history), not the captured historical production output; no historical evidence for PFR/NGS/coverage/FTN families (NOT_EVALUABLE); prospective evidence ≈ 0; 2025 holdout was seen by v1; participation-derived usage families are unavailable for 2026; the shadow readiness path passes no live frontier; effect sizes are measured on fantasy-point MAE and pairwise close-call regret, not full lineup optimisation; the +0.03 minimum effect and severe-miss threshold are pre-registered judgment calls. K/D-ST/IDP unaddressed by design.

## 41. Certification verdict
**CERTIFIED — NO FI FAMILY EARNED PRODUCTION ELIGIBILITY.** Gates: chronology ✔; baseline integrity ✔ (strongest trustworthy baseline used and labelled); incremental value ✘ for all 30; decision value ✘; stability ✘; calibration ✘; sample adequate for 20, near-zero effect for 10; freshness/source/temporal/scoring/isolation/consumer-scope/reversibility/lineage gates **implemented and tested** ✔; production numerically unchanged ✔.

## 42. Proposed deployment-state transitions
| Family × position | Start | Evaluable | Evaluated | Production |
|---|---|---|---|---|
| all 30 candidates (§13) | SHADOW_ONLY | RESEARCH_ELIGIBLE | **CERTIFICATION_FAILED** | SHADOW_ONLY |
| 9 not-evaluated families (§3) | SHADOW_ONLY | — | SHADOW_ONLY | SHADOW_ONLY |
No `PRODUCTION_ELIGIBLE`, no `PRODUCTION_ACTIVE`, no activation-log entry. Each transition above is versioned in git (`3f525da`), explained (`verdict_reason`, failed gates) and reversible (`CERTIFICATION_FAILED → SHADOW_ONLY | RESEARCH_ELIGIBLE` is a legal transition for a future re-test). Recommended next step is **not** activation: accumulate prospective captures (≥ 4 qualifying weeks, ≥ 150 decisions per candidate), and consider re-testing only the two WR watch-list families on that new evidence.

---
Phase 8: CERTIFIED — NO FI FAMILY EARNED PRODUCTION ELIGIBILITY
Phase 9: NOT STARTED
