# Decision Model Convergence — W2.P1 Role & Opportunity Intelligence: offline qualification

**Verdict: CERTIFIED — SHADOW_ONLY (offline).** Role & Opportunity earns **no production numeric influence** in this phase. The architecture, the qualification harness, the pre-registered protocol and a SHADOW challenger spec ship; nothing in production changed. Live/staging gates remain **pending** (§19).

Branch `intelligence-convergence-w2-p1-role-opportunity` (local only; not pushed, merged or deployed; no migration).

## 1. Baseline / git state
- Base `57a6606` (W1.R2) on the Wave 1 lineage 201256b → ab7dce3 → 68fc482 → 89e22ad → 65a04f4 → abe494f → 57a6606. `origin/main` is `faf227b`: bot data refreshes only (football-intel, intelligence-history, role-calibration CSVs) — no code overlap; no rebase.
- **Wave 1 staging was NOT completed** (live validation blocked; no remote DB). W2.P1 was run offline by explicit instruction; every live-dependent item is marked pending.
- Regression baseline at `57a6606`: 3511 tests / 3073 pass / 127 fail / 257 cancelled / 54 skipped; tsc clean; lint 39 warnings / 0 errors; `next build` passes. At this tip: **3537 tests / 3099 pass / same 127 failing names (0 new, 0 fixed)**; tsc clean; lint 39/0; build passes.
- Commits: `d33fb15` pre-registration + harness (before any VAL/FINAL row was scored), `1730851` freeze, `1268584` refreeze (all before FINAL), then the report commit.

## 2. Existing Role architecture (from code)
See `docs/DECISION_MODEL_CONVERGENCE_W2_P1_ROLE_PREREGISTRATION.md` §1 for the pipeline map. Summary: R-built player-game role substrate → as-of profile (EWMA half-life 2, synthetic NA target-week row) → `buildRoleForecast` (opportunity = share × EWMA team volume; teammate-absence redistribution from the frozen propagation model; confidence) → xFP → `shadowCandidate` (κ 0.3, confidence weights 1/0.6/0, cap max(1, 25%)) → `roleSignalFromShadowCandidate` → ledger line `ROLE_CALIBRATION` (SHADOW). Production boundary: `validate.ts` rejects Role PRODUCTION; production must not import `lib/role-calibration`; **nothing in production supplies `shadow.role` today**, so final-pregame records currently carry no Role value.

## 3. Point-in-time audit
| Item | Verdict |
|---|---|
| As-of profile `*_recent` | SAFE: reproduced from strictly-earlier games (median deviation 0.0028 vs 0.0120 if the target game is included; closer for ≥ 80% of players) — test + independent probe |
| Team/QB volumes | SAFE: filtered `week < target`; poison test (target + later weeks set to absurd values) leaves forecasts byte-identical |
| B0p proxy baseline | SAFE: stat rows with week < target |
| Injury designation | MILD, symmetric: nflverse FINAL team-week designation, no timestamp (RECONSTRUCTED_FINAL_DESIGNATION); same for champion and challenger |
| Bye exclusion | SAFE: schedule information only |
| Depth chart | UNAVAILABLE for 2025 (snapshots start 2026-08-25): not used |
| 2026 route participation | unpublished upstream: prior-season evidence only (capped LOW) |
| C1 yield table | MILD leakage favoring C1 (same-season table); C1 is not a gating candidate |
**Finding (pre-existing, not fixed here):** the real-data leakage tests in `test/role-calibration.test.ts` (and `game-distribution`) currently FAIL in the baseline because the committed profile CSV was rolled to target weeks 5–6 — the audits silently stopped executing. This phase replaces them with 2025-data equivalents (`test/w2p1-role-qualification.test.ts`).

## 4. Feature inventory / family findings
(QB, RB, WR, TE; K/DST NOT_APPLICABLE; `scripts/w2p1/ablation.ts`, DEV-fit → VAL-scored, non-binding)
| Family | Predictive of OPPORTUNITY? | Incremental to fantasy points over the Role-free control (VAL) | Notes |
|---|---|---|---|
| Snap participation | yes (stable) | ≈ 0 each position | overlaps target/carry volume |
| Target opportunity | yes: beats last-game by 22%, ≈ season mean | WR/RB ≈ 0 individually | main signal is already in the baseline's history |
| Carry opportunity | yes | RB ≈ 0 | |
| Red-zone opportunity | yes | **RB +0.067** (largest family); WR/TE ≈ 0 | only family with clear marginal value |
| Air-yards depth | yes | TE **−0.04** (hurts), WR ≈ 0 | |
| Route participation | 2025 yes; 2026 unpublished | not used (prior-season only in 2026) | |
| Third-down / two-minute / goal-line | observed only, not forecast (thin samples) | n/a | |
| QB volume (dropbacks/rushes) | yes | QB negative | |
| Depth-chart/starter | unavailable in 2025 | n/a | |
| Recent trend / structural breaks | flagged only (discontinuity flag set for 47–55% of profiles; no separate adjustment) | n/a | |

## 5. Leakage audit
Structural (`assertPointInTime`, 0 violations over all DEV+VAL+FINAL rows), statistical (EWMA reproduction), adversarial (poison test), and a **sensitivity control**: an ORACLE model fitted on the target game's actual opportunity beats the honest model by +0.2 to +0.4 MAE on VAL, proving the harness would see a leak. M1/M10/M13/M14 mutations are killed (§17). Independent review (§16) found no leak path into features, baseline, eligibility, the fit or the designation.

## 6. Injury / Role decomposition
Role features are classified: *availability* (designation, p_absent, depth starter flag → **excluded**, belongs to the Wave 1 injury model), *workload-if-active / opportunity share* (snap share, target/carry share → **used**), *efficiency/TD* (not in the substrate → **excluded by construction**), *game environment/matchup* (**excluded**, other layers).
- The EXISTING shadow (C1) multiplies xFP by `(1 − p_absent)` and is applied on an injury-adjusted baseline, so a Doubtful player is discounted twice (test: `shadowCandidate` gives −0.75·… for the same agreement). The challenger (C2) is fitted on **played, conditional-on-active** residuals and applied to `B0p + Δ` **before** the production injury model: availability is applied exactly once (test) and OUT players receive exactly 0 (test).

## 7. Source-projection double count
**Not measurable offline** — there is no history of the real Sleeper/RotoWire projection. The baseline is the W1.P2 proxy (mean of previous ≤ 4 games), so all Role gains are an **upper bound** on the gain over the real Wave 1 canonical forecast (a real source already encodes starter status, targets, snaps, injuries). The only real-source datapoint (2026 week 3, n = 769; `PROJECTION_CALIBRATION_PHASE2_CERTIFICATION.md`): C1 ΔMAE −0.006, helped 41.3% / hurt 42.5%, no κ helps.

## 8. Splits / development / validation / holdout
2025 REG: **DEV** weeks 3–9 (fit), **VAL** 10–13 (ridge λ from a 4-point grid; inspected repeatedly), **FINAL** 14–17 (scored once). Weeks 1–2/18, playoffs and all 2026 weeks excluded (2026 has no stat lines and no as-of profiles with outcomes in the repo — a true 2026 out-of-time test is impossible offline). Amendments after DEV/VAL inspection but **before FINAL**, disclosed in `prereg.json`: added the Role-free control C0 (DEV showed the baseline term carried a large negative coefficient = regression to the mean), excluded BYE-week players (schedule known pre-game) and fixed a model-key bug, refit the oracle control. No threshold changed. FINAL was scored exactly once (`final-run-log.jsonl`, hashes match `FROZEN.json`).

## 9. Coverage (2025 DEV+VAL profiles; `scripts/w2p1/coverage.ts`)
Applicable Role evidence 100% for QB/RB/WR/TE (confidence: MEDIUM 21–37%, LOW 63–79%, INSUFFICIENT 0%); 37–60% of profiles are early-season (< 3 games); 47–55% carry a team/position discontinuity flag; WR/TE route participation 98% available in 2025 (unpublished in 2026); depth snapshots 0% for 2025. Eligible FINAL rows (b0 ≥ 3, not BYE): QB 182, RB 295, WR 433, TE 185.

## 10. Position metrics (FINAL, HALF scoring, non-OUT rows; ΔMAE > 0 = challenger better)
| Pos | N | B1p MAE / RMSE / bias | C2 MAE / RMSE / bias | ΔMAE vs B1p [95% CI] | C0 (Role-free) vs B1p | **Role increment C2 vs C0** [CI] |
|---|---|---|---|---|---|---|
| QB | 182 | 8.361 / 10.267 / −2.58 | 8.472 / 10.287 / −3.05 | −0.111 [−0.355, 0.156] | −0.282 | +0.171 [0.060, 0.294] (see §16: drift artifact) |
| RB | 295 | 5.871 / 7.360 / −1.49 | 5.601 / 7.121 / −1.07 | **+0.269 [0.080, 0.481]** | −0.016 | **+0.285 [0.128, 0.459]** |
| WR | 433 | 5.104 / 6.356 / −1.42 | 4.739 / 6.083 / −0.79 | **+0.364 [0.244, 0.483]** | +0.217 | **+0.147 [0.061, 0.231]** |
| TE | 185 | 5.062 / 6.887 / −0.99 | 4.782 / 6.452 / −0.68 | **+0.280 [0.095, 0.471]** | +0.220 | +0.060 [−0.102, 0.229] |
By week (ΔMAE): RB +.086/+.263/+.455/+.241, WR +.239/+.324/+.346/+.524, TE +.242/+.319/+.262/+.291, QB +.044/+.253/−.364/−.310. Robustness (STD/PPR): RB, WR, TE positive vs B1p and C0 (TE vs C0 small); QB negative. By tier (ΔMAE): RB STARTER +0.673, FLEX +0.234, FRINGE −0.066; WR +0.884/+0.26/+0.26; TE +1.443/+0.16/+0.136; QB +0.014/−0.33/−0.43.

**Opportunity forecast (gate G1, FINAL):** Role beats last-game MAE by 16–21% for RB carries (3.84 vs 4.84), RB targets (1.44 vs 1.72), WR targets (2.16 vs 2.69), QB dropbacks (8.47 vs 9.60) — PASS — but only **ties** a season-to-date mean (3.91 / 1.46 / 2.30 / 8.59) and last-3 mean (≈ +4–6%): the profile's EWMA is a good, not a special, usage estimate. TE targets: n = 160 < 200 minimum and 1.97 vs season mean 1.92 → not passed.

## 11. Decision metrics (FINAL, disagreements between B1p and C2)
Same-team/position pairs; "decided" = |actual difference| ≥ 1 point. QB 6 decided (5–1), RB 13 (9–4), WR 42 (28–14, p = 0.022), TE 7 (7–0, p = 0.008). Direction favors the challenger everywhere, but 68 decided pairs in total over four weeks is far below the pre-declared 100 per position — **decision-level evidence is insufficient**, not negative. Role changes decisions rarely (disagreements 6–47 of 70–629 pairs).

## 12. Champion vs challenger
Champion B1p (production Wave 1 injury model on the proxy baseline) vs challenger C2 and the Role-free control C0 (§10). C1 (existing shadow, as written) vs B1p on FINAL: QB +0.07, RB +0.148 [0.072, 0.238], WR +0.235 [0.177, 0.295], TE +0.189 [0.10, 0.277] — C1 also "beats" the proxy, which mostly reflects the proxy's over-prediction, and it double-discounts availability.

## 13. Promotion criteria (declared before FINAL — `prereg.json`)
T1 coverage/N; T2 ΔMAE ≥ 0.05 with CI > 0; **T2b Role-specific increment over C0 ≥ 0.03 with CI > 0**; T3 RMSE; T4 bias (|bias| ≤ 0.5 and not worse than champion + 0.15); T5 3 of 4 weeks + VAL positive; T6 ≥ 100 decided pairs with challenger ≥ champion, p < 0.10; T7 no tier regression; T8 Q/D ≥ −0.05, OUT == 0, cap-hit ≤ 10%; T9 leakage controls; T10 robustness under STD/PPR.

## 14. Final promotion result
**No position passes all gates → SHADOW_ONLY.** Failures (numbers in §10/§11):
| Pos | Failed gates |
|---|---|
| QB | T2, T4, T5, T6, T8, T10 |
| RB | T1 (295 < 300), T4, T6, T8 (cap-hit 33.9%) — passes T2, T2b, T3, T5, T7, T9, T10 |
| WR | T4, T6 (42 < 100), T8 (29.6%), T9 (permutation 0.023 vs 0.02 — a spurious intercept effect, see below) — passes T1, T2, T2b, T3, T5, T7, T10 |
| TE | T1 (185 < 300), T2b (increment CI includes 0), T4, T6, T8 |
Honest reading: T4 (absolute bias) and T8 (cap-hit) fail for **the champion and the Role-free control too** — they measure the proxy baseline's over-prediction on non-designated absences (16–20% of QB/RB rows are non-OUT DNPs; played-only bias ≈ 0), which no Role feature can fix; T6 is unattainable in a four-week window. They were declared before FINAL and are **not** relaxed. They make SHADOW_ONLY nearly independent of Role quality in this proxy setting. **What the evidence does say:** Role features add statistically significant incremental value over a Role-free control for **RB** and **WR** (and not TE, not reliably QB), small in size (≈ 0.15–0.29 MAE points), concentrated in RB red-zone opportunity, and all of it is measured against a proxy baseline.

## 15. Production integration
**None.** No contribution is wired; no Wave 1 champion behavior changed. The SHADOW challenger spec `scripts/w2p1/candidate/role-opportunity-challenger-2026.0.json` (status SHADOW_ONLY — NOT CERTIFIED) records the centered Role-only coefficients (intercept and the baseline term deliberately dropped), cap, confidence weights and the application order for a future prospective capture. Production must not import research code (pinned by test); any future production artifact must be a reviewed, versioned config.

## 16. Independent review
A separate reviewer re-derived the leakage, bootstrap (independent reimplementation, CIs within ±0.005), binomial test and threshold fidelity. **No P0/P1.** P2: T6 and parts of T1/T4/T8 are structurally unattainable here; the T9 permutation control is mis-specified (it shuffles the baseline and ignores the intercept-only gain: WR VAL intercept-only control +0.251 vs C2 +0.287); the QB "increment" is a drifting-control artifact (QB mean residual −0.02 on DEV, −1.43 on VAL) and must not be cited as Role evidence. P3: tautological pit/OUT checks; no player-level clustering; weak Role-free control (1 parameter).

## 17. Mutation results (`scripts/w2p1-mutation-suite.py`)
15 mutants, **14 killed**, files restored byte-for-byte: target-game features as honest input (M1), availability applied twice (M2), Sleeper-id keying (M4), no shrinkage (M5), missing → zero (M6), freeze no longer pins the pre-registration (M7), production imports the harness (M8), Role on OUT (M9), target week in pre-game volume (M10), no cap (M11), baseline term removed (M12), bye players eligible (M13), oracle not a leak (M14), do-nothing model (M15). **M3** (K/DST filter removed) survives as **equivalent**: the role substrate contains only QB/RB/WR/TE; the population test pins that no K/DEF appears. Mutations that need production wiring (matchup double-apply, trade ROS, final-pregame signature, DST) are **not applicable**: no Role contribution exists in production.

## 18. Full-suite comparison
3537 / 3099 pass / 127 fail (identical names to `57a6606`) / 257 cancelled / 54 skipped; tsc clean; lint 39 warnings / 0 errors; build passes. 26 new tests (`test/w2p1-role-qualification.test.ts`).

## 19. Known limitations and PENDING gates
Pending: Wave 1 staging certification; prospective final-pregame Role challenger capture over completed real weeks (requires production wiring of a shadow Role signal, which does not exist); **G3** incremental value over the REAL Wave 1 canonical forecast; five-league live validation. Not done / not measurable offline: real-source residual analysis; 2026 out-of-time; depth-chart features for 2025; rookie/returning cohorts (no flags in the data); known calibration cases (Gibbs, Kittle, Bowers, Achane, Jefferson are 2026 week-3 ledger cases needing the Supabase ledger — their documented results stand in `PROJECTION_CALIBRATION_PHASE2_CERTIFICATION.md`; the Kittle stale-roster regression and the Achane/Jefferson injury-contamination labeling remain covered by passing tests in `role-calibration.test.ts`). The ROS/forward use of Role, asset/hold value, matchup, waivers, trades, roster health and schedule planning were **not touched**; Wave 1 debt (§67 of the brief) is unchanged.

## 20. Recommendation
Do **not** wire a Role numeric contribution. Next: (1) run Wave 1 staging; (2) ship **prospective shadow capture** of the Role challenger (centered spec) into final-pregame records so G3 can be measured against the real source; (3) rerun this exact pre-registered protocol on ≥ 6 real completed weeks with the real source baseline, with T4/T6/T9 re-specified **before** looking (relative bias, adequate pair counts, an intercept-only permutation control).
