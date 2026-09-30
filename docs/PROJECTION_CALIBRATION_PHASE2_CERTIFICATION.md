# Projection Calibration — Phase 2: Role & Opportunity Intelligence (certification record)

Date: 2026-09-30. Branch `projection-calibration-phase2`. **Verdict: CERTIFIED WITH DOCUMENTED LIMITATIONS. Shadow result: classification C — Descriptive only.** Production projections, Start/Sit decisions, Waiver 2.0, Matchup 2.0 and floors/ceilings are unchanged; the candidate is SHADOW_ONLY.

## What was audited and reused

- **Reused, not rebuilt:** the canonical Role Intelligence substrate and `build_role_profile()` (`analysis/player_role`), the frozen Opportunity Propagation model (`allocateHierarchical` + inheritance priors), the FI player-usage profile, the Phase 1 ledger and its player-level kickoff rule, the Phase 1 scoring path, and the weekly audit.
- **Found stale:** the served Role Intelligence artifact is through Week 1 (manual rebuild). Phase 2 did not touch it (a rebuild overwrites the served product; reverted); it builds its own additive exports from the refreshed git-ignored raw cache.
- **Root cause of the missing FI role families:** `translateFiAdjustment` said a "batch helper" injects usage values via `fiValues`, but no such helper ever existed, so `usage_snap_share` (RB), `usage_route_participation` and `usage_target_share` (TE) were null in 100% of Week 3 captures (52/52 and 12/12). Fixed in `lib/weekly/start-sit-fi/usage-values.ts` (SHADOW path only) with valid-evidence gates: published FI row, id/position agreement, `modeled` value present, confidence passed through, missing stays null.
- **Not available pre-kickoff / postgame-only / missing:** 2026 route participation (nflverse participation unpublished: prior-season evidence only, capped LOW); slot/inline alignment, pass-block vs route split, first-read share, targets-per-route-run (no 2026 source); in-game injury/exit (postgame-only, only inferable). Third-down, two-minute, goal-line and inside-10 usage exist as observed substrate columns but are not forecast (three-game samples too thin).

## Architecture

- **Sources:** `analysis/role_calibration/export_role_inputs.R` exports observed role per player-game (2025–2026), the pre-game role profile per (target week, player), nflverse injury designations, and timestamped depth charts; `export_position_yields.R` exports 2025 league-wide, red-zone-split yield per opportunity. The profile is evaluated at a synthetic NA row for the target week, so it can only see strictly earlier games.
- **Forecast** (`lib/role-calibration/forecast.ts`): EWMA role (half-life 2, prior season blended by recency), team volume EWMA, teammate-absence redistribution via the frozen propagation model (Out 1.0 / Doubtful 0.75 / Questionable 0.25, hand-specified; reductions from renormalization artifacts suppressed), depth-chart state (dt < kickoff), availability, confidence (falls with thin samples and discontinuity; HIGH never issued). Missing stays null.
- **Persistence** (additive, insert-only): `bridge_role_forecasts` (DB-enforced: as_of and data cutoff strictly before kickoff; a LIVE capture at/after kickoff is rejected) and `bridge_role_calibration_analysis` (+ `_current` view): keys + derived numbers joined to Phase 1 cases; no case duplication. Observed role is embedded in the analysis rows (a deterministic function of the versioned committed export).
- **Exact decomposition** (points, per league scoring): actual − baseline = (actual − xFP_actual_opp) [efficiency/TD/randomness] + (xFP_actual_opp − xFP_forecast) [role/opportunity error] + (xFP_forecast − baseline) [non-role baseline disagreement]. The same function prices forecast and actual opportunity, so the identity is exact (tested). Football forecast is scoring-neutral; fantasy scoring is applied per fingerprint.
- **Shadow candidate (pre-registered, unfitted):** candidate = baseline + clamp(0.30 × conf_weight(LOW 0.6, MEDIUM 1.0) × ((1−p_absent)·xFP_forecast − baseline), ±max(1, 25%·baseline)); second candidate isolates teammate-pressure points. Sensitivity over the blend weight is reported as a diagnostic only.
- **Automation:** `/api/cron/role-calibration` (daily, CRON_SECRET; LIVE forecasts for the current and next week, per-player freeze; analysis for completed weeks, bootstrapping missing forecasts with labeled reconstructions), `.github/workflows/role-calibration-refresh.yml` (refreshes the committed inputs; validated as YAML, not yet executed in CI), read-only `/api/role-calibration/report` and `/evaluate`, and a `role_calibration` component in the weekly audit (the existing Analysis Book / Book-Ready `audit.weekly_model` topic).

## Evidence status

Week 3 forecasts are **AS_OF_RECONSTRUCTION** (the system did not exist before Week 3): 656 Week 3 + 640 Week 2 forecasts, every one with as_of and data cutoff strictly before its kickoff, stamped 60 minutes before kickoff, using the final official injury designation for the team-week (assumption: no timestamp is published). No LIVE-captured role forecast exists yet; all numbers below are reconstruction-based and labeled so. Week 2 (37 certified Start/Sit-sourced rows) is a spot check only.

## Week 3 coverage (eligible RB/WR/TE analysis rows, Sleeper-deduped)

| Position | Cases | With pregame role forecast | snap share | route participation | target share |
|---|---|---|---|---|---|
| RB | 216 | 210 (97.2%) | 97.2% | 85.2% (100% prior-season only) | 97.2% |
| WR | 330 | 322 (97.6%) | 97.0% | 85.5% (100% prior-season only) | 97.6% |
| TE | 198 | 190 (96.0%) | 96.0% | 81.8% (100% prior-season only) | 96.0% |
| ALL | 744 | 722 (97.0%) | 96.8% | 84.4% (100% prior-season only) | 97.0% |

Before: FI usage families in Week 3 Start/Sit captures were 0% valid (52/52 and 12/12 null). Current-season evidence exists for snap/target but not routes.

## Role forecast accuracy (played, not expected-out, not injury-contaminated)

| Position | Metric | n | Forecast MAE | Naive last-game MAE | Naive season-mean MAE | Bias |
|---|---|---|---|---|---|---|
| QB | rush_share | 61 | 0.0354 | 0.0473 | 0.042 | -0.0004 |
| QB | rz_carry_share | 59 | 0.1007 | 0.1273 | 0.101 | 0.0076 |
| QB | snap_share | 61 | 0.0977 | 0.1004 | 0.1104 | 0.0722 |
| RB | position_group_rush_share | 166 | 0.1303 | 0.1388 | 0.1168 | 0.0095 |
| RB | rush_share | 166 | 0.1147 | 0.1236 | 0.1062 | 0.0162 |
| RB | rz_carry_share | 160 | 0.1813 | 0.1987 | 0.1977 | -0.0035 |
| RB | rz_target_share | 160 | 0.0548 | 0.0624 | 0.0596 | -0.0015 |
| RB | snap_share | 166 | 0.1067 | 0.1301 | 0.11 | 0.0125 |
| RB | target_share | 166 | 0.0321 | 0.0375 | 0.0364 | 0.0001 |
| TE | air_yards_share | 166 | 0.0458 | 0.0575 | 0.0464 | -0.0009 |
| TE | position_group_target_share | 166 | 0.1553 | 0.2062 | 0.1689 | 0.002 |
| TE | rz_target_share | 164 | 0.0747 | 0.0777 | 0.0814 | -0.0179 |
| TE | snap_share | 168 | 0.1124 | 0.1289 | 0.1097 | 0.0248 |
| TE | target_share | 168 | 0.0342 | 0.044 | 0.039 | 0.0026 |
| WR | air_yards_share | 274 | 0.098 | 0.12 | 0.104 | -0.0023 |
| WR | position_group_target_share | 274 | 0.0888 | 0.1151 | 0.0956 | 0.0009 |
| WR | rz_target_share | 266 | 0.077 | 0.1073 | 0.0894 | 0.0103 |
| WR | snap_share | 274 | 0.1348 | 0.1363 | 0.1209 | 0.0033 |
| WR | target_share | 274 | 0.0455 | 0.0583 | 0.049 | 0.0041 |

The forecast beats the last-game predictor on every metric. It does **not** uniformly beat the season-to-date mean (RB rush share, RB/WR/TE snap share, RB position-group rush share: the season mean is slightly better over two games).

## Role error vs fantasy projection error

| Position | n | corr(role error, total error) | share of squared error: role / efficiency-TD / baseline gap |
|---|---|---|---|
| ALL | 669 | 0.5612 | 0.4026 / 0.4309 / 0.1665 |
| QB | 61 | 0.4964 | 0.2598 / 0.4967 / 0.2435 |
| RB | 166 | 0.4801 | 0.3926 / 0.439 / 0.1684 |
| WR | 274 | 0.5534 | 0.4454 / 0.4117 / 0.1429 |
| TE | 168 | 0.6996 | 0.5004 / 0.381 / 0.1187 |

TE misses are the most role-driven (corr 0.75, ~51% of squared error); QB the least (~26%). Among large misses, efficiency/TD is dominant slightly more often than role: ≥5: n=200, role 36% / efficiency 54% / baseline gap 11%; ≥8: n=89, role 39% / efficiency 52% / baseline gap 9%; ≥10: n=50, role 42% / efficiency 56% / baseline gap 2%.

## Shadow experiment: baseline vs Role candidate (Week 3, Sleeper fingerprints, n after excluding injury-contaminated)

- **Overall (role candidate):** n=769, baseline MAE 3.6372 / RMSE 5.0628 / bias 0.3417; candidate MAE 3.6428 / RMSE 5.0578 / bias 0.353; ΔMAE -0.0057; helped 41.3%, hurt 42.5%, neutral 16.1%
- **Teammate-pressure-only candidate:** n=769, baseline MAE 3.6372 / RMSE 5.0628 / bias 0.3417; candidate MAE 3.6427 / RMSE 5.0534 / bias 0.2739; ΔMAE -0.0055; helped 11.6%, hurt 17.4%, neutral 71.0%

**by_position**

- QB: n=63, baseline MAE 6.4833 / RMSE 7.4715 / bias 1.3256; candidate MAE 6.4518 / RMSE 7.567 / bias 2.03; ΔMAE 0.0315; helped 42.9%, hurt 55.6%, neutral 1.6%
- RB: n=208, baseline MAE 3.188 / RMSE 4.3342 / bias -0.7168; candidate MAE 3.2067 / RMSE 4.3283 / bias -0.7524; ΔMAE -0.0186; helped 37.5%, hurt 44.7%, neutral 17.8%
- TE: n=186, baseline MAE 3.3468 / RMSE 5.1497 / bias 0.8177; candidate MAE 3.3422 / RMSE 5.1321 / bias 0.7491; ΔMAE 0.0047; helped 43.5%, hurt 37.6%, neutral 18.8%
- WR: n=312, baseline MAE 3.5349 / RMSE 4.8551 / bias 0.565; candidate MAE 3.5457 / RMSE 4.8269 / bias 0.5151; ΔMAE -0.0108; helped 42.3%, hurt 41.3%, neutral 16.4%

**by_projection_magnitude**

- 10-15: n=124, baseline MAE 5.7586 / RMSE 6.8292 / bias -0.0651; candidate MAE 5.7468 / RMSE 6.849 / bias 0.189; ΔMAE 0.0118; helped 47.6%, hurt 43.5%, neutral 8.9%
- 5-10: n=173, baseline MAE 4.6024 / RMSE 5.6323 / bias -0.0395; candidate MAE 4.5705 / RMSE 5.6119 / bias -0.0434; ΔMAE 0.032; helped 46.8%, hurt 42.8%, neutral 10.4%
- <5: n=411, baseline MAE 2.3045 / RMSE 3.6395 / bias 0.4916; candidate MAE 2.3142 / RMSE 3.576 / bias 0.3751; ΔMAE -0.0096; helped 39.2%, hurt 39.7%, neutral 21.2%
- >=15: n=61, baseline MAE 5.5657 / RMSE 7.0081 / bias 1.2405; candidate MAE 5.6873 / RMSE 7.1878 / bias 1.6612; ΔMAE -0.1215; helped 27.9%, hurt 59.0%, neutral 13.1%

**by_teammate_absence**

- NO_HARD_ABSENCE: n=465, baseline MAE 3.646 / RMSE 5.0351 / bias 0.2242; candidate MAE 3.658 / RMSE 5.0582 / bias 0.3283; ΔMAE -0.012; helped 39.8%, hurt 42.8%, neutral 17.4%
- TEAMMATE_ABSENT: n=304, baseline MAE 3.6236 / RMSE 5.105 / bias 0.5216; candidate MAE 3.6196 / RMSE 5.0573 / bias 0.3907; ΔMAE 0.004; helped 43.8%, hurt 42.1%, neutral 14.1%

**by_starter_vs_committee**

- DEPTH_STARTER: n=215, baseline MAE 5.2409 / RMSE 6.5584 / bias 0.3714; candidate MAE 5.2629 / RMSE 6.6136 / bias 0.5856; ΔMAE -0.0221; helped 40.9%, hurt 49.8%, neutral 9.3%
- NOT_DEPTH_STARTER: n=506, baseline MAE 2.9913 / RMSE 4.2013 / bias 0.1938; candidate MAE 2.9876 / RMSE 4.1727 / bias 0.1363; ΔMAE 0.0037; helped 42.5%, hurt 39.1%, neutral 18.4%
- UNKNOWN: n=48, baseline MAE 3.2623 / RMSE 5.6499 / bias 1.7681; candidate MAE 3.2941 / RMSE 5.5114 / bias 1.5949; ΔMAE -0.0318; helped 31.2%, hurt 45.8%, neutral 22.9%

**Tail misses (baseline |error| ≥ threshold):**

- ≥5: 207 cases; baseline MAE 8.4806 → candidate 8.4206; reduced 52%; still ≥ threshold 95%; new tail misses created 10
- ≥8: 93 cases; baseline MAE 11.0787 → candidate 11.0567; reduced 48%; still ≥ threshold 90%; new tail misses created 5
- ≥10: 51 cases; baseline MAE 12.8527 → candidate 12.9754; reduced 35%; still ≥ threshold 98%; new tail misses created 2

**Blend-weight sensitivity (diagnostic only, not used to choose the weight):** κ=0: MAE 3.6372, κ=0.1: MAE 3.6374, κ=0.2: MAE 3.641, κ=0.3: MAE 3.6428, κ=0.5: MAE 3.6506, κ=0.75: MAE 3.6697, κ=1: MAE 3.6864. No blend weight produces a meaningful improvement; larger weights degrade.

**By scoring fingerprint:** sleeper|scoring:v1:29acc6bcd911df090b5b9b9c: ΔMAE 0.0064 (n=385); sleeper|scoring:v1:d4795fa723cdd12d9ba3bfb1: ΔMAE -0.0179 (n=384); yahoo|scoring:v1:6bacbebb57be0b8f934e6cbd: ΔMAE -0.0027 (n=384). Improvement is not consistent across fingerprints (Bloodline slightly positive, Devoted slightly negative); Yahoo is reported, not pooled.

## Manual audit of Week 3 cases (Bloodline Bowl)

| Player | Baseline | Actual | Role forecast → actual (snap / target share) | Forecast vs actual opportunity | Decomposition: role / efficiency-TD / baseline gap | Label |
|---|---|---|---|---|---|---|
| Jahmyr Gibbs | 21.1 | 37.9 | 0.764→0.714 / 0.146→0.216 | 18.3 car, 6.3 tgt → 20 car, 8 tgt (7 RZ carries) | +6.7 / +12.2 / −2.0 | role expansion + big TD/efficiency game |
| George Kittle | 10.1 | 23.2 | 0.582→0.868 / 0.153→0.226 | 3.1 tgt → 7 tgt | +6.5 / +12.2 / −5.5 | role expansion + efficiency (teammate out) |
| Brock Bowers | 10.3 | 22.6 | 0.948→0.809 / 0.189→0.302 | 6.3 tgt → 13 tgt | +9.9 / +3.0 / −0.6 | role-driven (returning, Questionable) |
| Kenyon Sadiq | 5.5 | 20.0 | 0.398→0.576 / 0.080→0.163 | 3.2 tgt → 8 tgt | +5.9 / +10.3 / −1.6 | role expansion + efficiency |
| Harold Fannin | 7.4 | 20.6 | 0.776→0.882 / 0.152→0.205 | 5.3 tgt → 9 tgt | +6.6 / +7.1 / −0.5 | role + efficiency |
| Juwan Johnson | 8.3 | 19.3 | 0.685→0.622 / 0.114→0.170 | 4.6 tgt → 8 tgt | +5.7 / +7.0 / −1.7 | target-volume spike |
| Tyler Higbee | 1.3 | 16.2 | 0.299→0.726 / 0.045→0.180 | 2.4 tgt → 11 tgt | +12.6 / +0.3 / +2.0 | near-pure role expansion (snap share 0.30→0.73) |
| De'Von Achane | 14.4 | 1.7 | 0.763→0.055 / 0.144→0.021 | 18 car → 3 car | −15.5 / −0.9 / +3.7 | POSSIBLE_IN_GAME_INJURY (auto-labeled, excluded) |
| TreVeyon Henderson | 11.9 | 3.4 | 0.429→0.365 / 0.025→0.025 | 11.4 car → 8 car | −1.4 / −2.3 / −4.8 | mostly baseline over-projection + efficiency, not role collapse |
| Jadarian Price | 11.5 | 0.7 | 0.404→0.284 / 0.070→0.060 | 12 car → 5 car | −3.3 / −5.0 / −2.5 | modest role shrink + efficiency |
| Justin Jefferson | 13.8 | 4.2 | 0.949→0.119 / 0.253→0.054 | 7.7 tgt → 2 tgt | −9.2 / +1.6 / −2.1 | POSSIBLE_IN_GAME_INJURY (auto-labeled, excluded) |

The diagnostics make football sense: the TE upside cases are dominated by target-share jumps that the pregame forecast (0.05–0.19) did not anticipate; Henderson and Price were mostly over-projected by the baseline rather than role collapses; Achane and Jefferson are in-game-injury outliers that would otherwise have been mistaken for role forecast failures.

## Injury contamination (§16)

Automated rule (outcome-side only; never a forecast input): the player played, forecast snap share ≥ 0.30, actual snap share < 60% of forecast, **and** Sleeper carries a current post-game injury designation → `POSSIBLE_IN_GAME_INJURY`. Week 3 Bloodline list (8): Colby Parkinson, De'Von Achane, Jack Bech, Jalen Coker, Jalen McMillan, Justin Jefferson, Mike Evans, Terrance Ferguson. These rows are excluded from role-accuracy and shadow evaluation; the manual exclusion file (`lib/role-calibration/data/role_eval_exclusions.json`) exists for operator overrides and is empty. Reliable partial-exit detection (a snap-level or play-level injury signal) remains a **Phase 3 dependency**: the current rule is a post-hoc inference and labels "possible", not certain.

## Leakage certification

- DB-enforced on all 1,296 persisted forecasts: as_of < kickoff, data cutoff < kickoff, cutoff week < target week (0 violations each); 0 duplicate (player, week, kind); all carry a kickoff.
- Tests: the committed role profiles reproduce from strictly-earlier games only (median deviation 5e-5) and would deviate ~20× more if Week 3 leaked; poisoning every Week 3 outcome leaves all 656 Week 3 forecasts byte-identical; team/QB volumes ignore the target week; post-kickoff forecasts are rejected by selection.
- Residual assumptions (documented): the official injury designation is the final team-week designation (no timestamp published); rosters_weekly team for the target week; depth charts are timestamped and selected strictly before kickoff.

## Limits and what is still missing

- All Week 3 role evidence is reconstruction; accumulate LIVE captures before any promotion discussion. Confidence is LOW for every Week 3 forecast (two current-season games); the confidence and starter/committee segments therefore carry little information yet.
- Route participation cannot be evaluated in 2026 (no observed routes). Slot/inline, pass-block, first-read, targets-per-route not available.
- Yahoo leagues are reported (one fingerprint) but not pooled or used for any fitting; K/DST are out of scope.
- xFP omits threshold bonuses, 2-pt conversions, WR/TE rushing and return yards on both sides; TD yields are league averages (an efficient or high-variance player's TD component sits in the efficiency residual).
- Canonical id forms (Sleeper-form / GSIS-form) are handled by joining through provider ids; the forecast key is GSIS with Sleeper id as provenance.