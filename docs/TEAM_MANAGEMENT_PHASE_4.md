# Team Management — Phase 4: Start/Sit Decision Engine

**Status: BUILT + AUDITED. Verdict at §17.**

Branch `team-management-phase4-start-sit` (off the Phase 3 branch). Phase 3 (`lib/football-intel/`,
`analysis/football_intel/`) is a **frozen read-only upstream** — not modified.

The central question: **when the existing lineup system and Football Intelligence disagree,
does historical evidence show FI is worth listening to?**
**Answer (evidence below): No — not against the projection production actually uses.** FI
marginally helps RB coin-flip decisions against a naive trailing-mean control, but that value
disappears against the RotoWire-backed weekly projection, and FI *hurts* TE decisions. The
matchup / pace / efficiency information FI carries is already priced into the production
weekly projection (double-counting, spec §11). The engine is therefore delivered **SHADOW_ONLY**:
the comparison infrastructure + Phase-3 semantic enforcement are frozen and Phase-5-consumable;
**no production start/sit or lineup behavior changes.**

---

## 1. What was built

```
lib/weekly/start-sit-fi/            NEW — deterministic FI -> decision translation (SHADOW_ONLY)
  schema.ts     StartSitFiAdjustment, reason codes, lineage
  translate.ts  loadStartSitModel + translateFiAdjustment — routing enforcement, confidence
                weighting, per-player bound, reason codes that match the scoring path
  shadow.ts     buildStartSitShadow(ctx) — BASELINE vs FI-CANDIDATE lineup + start/sit diff
  index.ts
lib/weekly/data/                    served, committed, versioned
  start_sit_model.json    per-position families + betas + tau + max-adj cap + statuses
  start_sit_feature_status.csv      per (position, family) incremental value + KEEP/EXPLAIN/REMOVE
  start_sit_validation.csv          out-of-sample projection MAE/RMSE per position
  start_sit_manifest.json
analysis/football_intel_startsit/   NEW R training + evaluation (own model version)
  config.R                seasons/positions/grids/routing map
  fetch_sleeper_history.R Sleeper historical weekly projections + actual stats
  fi_asof_features.R      Phase-3 modeled ratings AS OF week W-1 (participation-lagged)
  build_decision_dataset.R chronology-safe (season,week,player,pos,archetype,baseline x2,FI,actual)
  train.R                 per-position nested walk-forward ridge; residual vs full; ablation
  backtest.R              pairwise start/sit decision quality + reversal analysis + tau/cap tuning
  finalize_model.R        stamps honest per-position production status from the backtest
  adversarial_audit.R     12 attack scenarios (spec §31)
outputs/startsit-2026/    backtest diagnostics + decision dataset (git-ignored, like other phases)
```

Integration: `buildWeeklyIntelligence` now attaches `start_sit_shadow` (non-fatal try/catch).
`lineup`, `start_sit`, `matchup`, `waivers` are **untouched**. `buildOptimalLineup` /
`maxSlotMatching` are **unchanged** — FI only rewrites the numeric projections fed to a
*separate* optimizer invocation inside the shadow path.

**Model identity:** `start_sit_model_version = ri-startsit-2026.1`, distinct from
`football_intelligence_version` (`fi:2025:w18:...`) and `baseline_projection_version`.

---

## 2. Phase 3 semantic enforcement (spec §2, §30) — proven

`test/start-sit-fi.test.ts` (13 invariants) + `test/start-sit-fi-isolation.test.ts` (4):

| Guarantee | Test |
| --- | --- |
| `NOT_PREDICTIVE` FI → numeric contribution 0 | `def_pass_epa_allowed` / `def_rush_epa_allowed` never enter any position's model; contribution 0 if forced |
| `DESCRIPTIVE_ONLY` / `DESCRIPTIVE_TENDENCY` → 0 | `def_man_rate`, `ftn_*` can never be a model family |
| `UNVALIDATED` → deferred | `unit_coverage_profile` not in v1 |
| lower confidence never increases influence | HIGH ≥ MEDIUM ≥ LOW magnitude, all else equal |
| `INSUFFICIENT_SAMPLE` → 0 contribution | ✓ |
| missing FI snapshot / model → baseline-equivalent | `expected_adjustment = 0`, `FI_UNAVAILABLE` |
| neutral signal (pct 0.5) → ~0 directional adjustment | \|adj\| < 0.05 |
| monotonicity: stronger validated positive signal → not-smaller influence | ✓ |
| bound: \|adj\| ≤ `max_total_adjustment_fraction · \|baseline\|` (0.25) | across pct 0.01–0.99 |
| determinism: identical inputs → identical output | `deepEqual` |
| prior-season FI (2025 for 2026) flagged + haircut, not "observed" | `FI_PRIOR_SEASON_ONLY` + warning + `PRIOR_DOMINATED_HAIRCUT` |
| explanation reason codes agree in sign with the net adjustment | ✓ |
| Phase 3 never imports weekly/trade/draft code | structural grep |
| trade engine never imports `start-sit-fi` / `football-intel` | structural grep |
| shadow wired only into `buildWeeklyIntelligence`, not `lineup.ts` / `trades/evaluate.ts` | structural grep |
| R FI engine has no fantasy-roster awareness | no `buildOptimalLineup` / `LeagueManagementContext` in `analysis/football_intel*` |

Full suite **1488 pass / 0 fail / 4 skipped** (+17 new; 0 existing tests changed). `tsc` clean.
`eslint` 0 errors, 29 warnings (0 new). Weekly + trade regression suites: 122/122.

---

## 3. Dual historical baseline (spec §3) — with a hard caveat on Sleeper history

`fetch_sleeper_history.R` pulled Sleeper `/projections/nfl/{season}/{week}` + `/stats/...`
for 2021–2025, weeks 4–18. **The `last_modified` audit is damning for older seasons:**

| Season | Projection `last_modified` | Verdict |
| --- | --- | --- |
| 2021 | **entirely NULL** | no provenance — unusable as a pre-game artifact |
| 2022 | all ≈ `2022-11-04` (one bulk timestamp) | **bulk backfill** — early-week rows post-date their games |
| 2023–2025 | early-Oct … early-Jan, ~per-week | plausibly in-season, but may still update *through* each week |

**Consequence (exactly as the brief anticipated):** the Sleeper historical projection is a
**research-only** baseline, restricted to 2023–2025, **never the certification baseline**.
The **clean chronology-safe control** — an exponentially-weighted (half-life 4) mean of each
player's **prior completed weeks that season** — is the certification baseline. Results are
reported against **both, separately, never merged.**

Decision dataset: **56,680 rows** (2021–2025, wk 4–17, QB/RB/WR/TE, 3 archetypes: 0 / 0.5 /
1 PPR). gsis resolved 100%, FI available 97.4%, clean trailing baseline present 73.5%
(missing = players with < 2 prior games — correctly excluded, not imputed).

---

## 4. Chronology / leakage (spec §4) — clean

- FI features as-of week W use **only weeks < W** (Phase 3 `compute_metric_profile(…, W-1, …)`);
  participation-derived usage (route participation) is lagged a further **2 weeks** (`PART_LAG`,
  Phase 3 P3-A4) — a Week-W decision uses route data through week W-3.
- Priors rebuilt from **seasons < the test season** only.
- Baseline trailing mean uses only prior completed weeks.
- Actual Week-W points are **target-only**.
- Nested walk-forward: outer test seasons {2023, 2024, 2025}; inner ridge-λ tuning on the
  latest inner season `< s`; **nothing from season ≥ s touches any coefficient or
  hyper-parameter**. `tau` + `max_adj_fraction` tuned on 2023–2024, frozen, evaluated on 2025.
- Adversarial check: nulling future weeks leaves the through-W FI rating byte-identical
  (inherited from Phase 3's own invariant, re-exercised).

---

## 5. Model form (spec §5, §6)

`adjusted_projection = baseline + Σ_family  β(position,family) · confidence_weight · standardized_FI_signal`,
capped at `0.25 · |baseline|`. **Residual formulation preferred** (`resid = actual − baseline_trailing`,
`resid ~ FI`) — it matched or beat the full formulation (`actual ~ baseline + FI`) for every
position out of sample, and avoids accidentally rebuilding the projection (§6). Ridge
regularization (λ ∈ {0.5…25}, selected inner-fold). FI signals confidence-weighted
(`HIGH 1.0 / MEDIUM 0.5 / LOW 0.2 / INSUFFICIENT 0`, × 0.6 when prior-dominated) **before**
the fit, so the learned β is on confidence-weighted signal and the identical weighting is
applied at serve. `WEAKLY_PREDICTIVE` β capped at the median |`PREDICTIVE` β|.

---

## 6. Projection validation — out of sample, vs the clean trailing baseline (§13)

| Position | n | MAE baseline | MAE +FI (residual) | RMSE baseline | RMSE +FI |
| --- | ---: | ---: | ---: | ---: | ---: |
| QB | 3,171 | 6.3905 | **6.3901** (−0.0004) | 8.2079 | 8.1915 |
| RB | 7,016 | 4.8182 | 4.8650 (**+0.047**) | 6.5253 | 6.5084 |
| WR | 9,970 | 4.6929 | 4.7045 (**+0.012**) | 6.3244 | 6.3052 |
| TE | 4,835 | 3.7254 | 3.7416 (**+0.016**) | 5.1774 | 5.1668 |

FI shaves RMSE by ~0.02 (marginal tail help) but does **not** improve MAE. The `full`
formulation was worse everywhere. **Projection error alone: FI adds nothing at the
player-week level.**

---

## 7. Decision quality — the primary evidence (spec §9, §13, §19)

880,375 pairwise same-position start/sit decisions across the dataset. Baseline picks the
higher-baseline player; the FI candidate re-picks but may only flip inside the tie-break gate
(tuned `tau = 3.0`, cap `0.25`).

### 7.1 Overall (clean trailing baseline)

| | reversal rate | base acc | FI acc | acc Δ | Δ pts/reversal | reversal win rate | large-loss / large-win |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| all | 3.5% | 0.6693 | 0.6701 | +0.0007 | +0.22 | **0.511** | 0.227 / 0.242 |
| **2025 held-out** | 3.2% | 0.6639 | 0.6643 | +0.0004 | +0.39 | **0.506** | 0.227 / 0.255 |

Reversals are **barely a coin flip** (51%). Aggregate accuracy improvement is negligible.

### 7.2 By position × baseline-edge bucket (clean trailing baseline — coin_flip only)

| Position | coin-flip n | acc Δ | Δ pts/decision | total Δ pts |
| --- | ---: | ---: | ---: | ---: |
| **RB** | 32,443 | **+0.0420** (0.561 vs 0.519) | **+0.41** | **+13,419** |
| QB | 7,544 | +0.0106 | +0.15 | +1,120 |
| WR | 42,561 | −0.0009 | −0.06 | −2,547 |
| **TE** | 32,256 | **−0.0294** (0.493 vs 0.522) | **−0.22** | **−7,252** |

`moderate` / `obvious` buckets: **0 reversals** — the tie-break gate holds (no obvious start
was ever overturned; adversarial checks 10/11/15 confirm structurally).

### 7.3 The decisive test — vs the RotoWire-backed Sleeper baseline (2023–2025)

| Position | reversal win rate | Δ pts/reversal | acc Δ | total Δ pts |
| --- | ---: | ---: | ---: | ---: |
| QB | 0.472 | −0.57 | −0.0019 | −1,078 |
| RB | 0.505 | −0.14 | +0.00008 | −258 |
| TE | 0.484 | −0.35 | −0.0005 | −856 |
| WR | 0.488 | −0.20 | −0.0005 | −875 |

**Against the projection production actually uses, FI is neutral-to-negative for every
position.** The RB coin-flip signal that looked real against a naive trailing mean does not
survive — confirming the double-counting hypothesis empirically.

---

## 8. Reversal analysis (spec §19) — `backtest_reversals_trailing.csv`

| Position | reversals | win rate | mean Δ pts | median Δ pts | large-loss (≤ −5) | large-win (≥ +5) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| RB | 8,727 | **0.606** | **+2.09** | +1.70 | 0.187 | 0.340 |
| QB | 1,935 | 0.519 | +0.52 | +0.74 | 0.321 | 0.346 |
| WR | 13,600 | 0.492 | −0.33 | −0.10 | 0.237 | 0.214 |
| TE | 6,249 | **0.416** | **−1.28** | −0.80 | 0.230 | 0.133 |

RB is the only position where a reversal is worth listening to (against the naive baseline).
TE reversals are actively destructive. WR is a coin flip.

---

## 9. Feature-family status (spec §15, §37) — `start_sit_feature_status.csv`

Drop-one ablation, incremental out-of-sample MAE. **Every gain is ≤ 0.003 pts** — noise-level.

| Position | family | routing | incremental MAE gain | status |
| --- | --- | --- | ---: | --- |
| QB | def_success_allowed | PREDICTIVE | +0.0030 | KEEP_WEAK |
| QB | off_explosive_pass_rate | PREDICTIVE | +0.0029 | KEEP_WEAK |
| QB | off_proe | PREDICTIVE | −0.0258 | **REMOVE** |
| RB | usage_snap_share | PREDICTIVE | +0.0020 | KEEP_WEAK |
| RB | off_pace_sec_play | PREDICTIVE | +0.0010 | KEEP_WEAK |
| RB | usage_target_share | PREDICTIVE | −0.0288 | **REMOVE** |
| WR | off_pass_epa / def_success_allowed / off_explosive_pass_rate / off_proe / interaction | PREDICTIVE/WEAKLY | +0.0008…+0.0032 | KEEP_WEAK |
| WR | usage_target_share | PREDICTIVE | −0.0095 | EXPLAIN |
| TE | usage_target_share / off_pace / route_participation | PREDICTIVE | +0.0003…+0.0023 | KEEP_WEAK |
| TE | off_pass_epa / def_success_allowed / off_success_rate | PREDICTIVE | −0.003…−0.007 | EXPLAIN |

No family reaches a defensible `KEEP`. The `KEEP_WEAK` families are retained in the shadow
model for transparency, not because they add value.

### Per-position production status (`finalize_model.R`)

| Position | production status | reversal win (trailing / sleeper) | Δ pts (trailing / sleeper) |
| --- | --- | --- | --- |
| QB | `SHADOW_ONLY_NO_VALUE` | 0.519 / 0.472 | +0.013 / −0.020 |
| RB | `TIE_BREAK_SHADOW_ONLY` | 0.606 / 0.505 | +0.061 / −0.001 |
| WR | `SHADOW_ONLY_NO_VALUE` | 0.491 / 0.488 | −0.014 / −0.004 |
| TE | `SHADOW_ONLY_NO_VALUE` | 0.416 / 0.484 | −0.044 / −0.005 |

**No position clears the production bar** (beat BOTH baselines). `deployment: SHADOW_ONLY`.

---

## 10. Adversarial audit (spec §31) — 12 / 12 pass

`Rscript analysis/football_intel_startsit/adversarial_audit.R` (exit 0):
elite player \|adj\| within cap (max 0.191 of 0.25); replacement player median \|adj\| 0.35
(bounded); one-game-sample usage attenuated; `def_pass/rush_epa_allowed` absent from model;
FTN / man-zone absent; participation usage always carries a confidence label; unresolved FI
→ 0 adjustment; **outside the tie-break gate the FI adjustment is smaller than the baseline
edge in 100% of cases (cannot flip)**; adjustment is a bounded points delta never an
availability override; extreme-outlier player not amplified past the cap; conflicting families
net-bounded; deterministic.

---

## 11. Legal lineup (spec §7) — unchanged

`buildOptimalLineup` + `maxSlotMatching` are byte-identical. The shadow path runs the **same**
optimizer on a cloned, FI-adjusted `WeeklyProjectionBatch`. `test/weekly-lineup.test.ts`
(FLEX/SUPERFLEX optimal assignment, RB/WR/FLEX chain pairing, permutation → 0 changes) passes
unchanged. Live smoke on `bloodline-bowl/supyo29` week 1: shadow present, `deployment:
SHADOW_ONLY`, production `start_sit` + `lineup` identical to pre-Phase-4.

---

## 12. Trade-engine isolation (spec §14, §32) — proven

`buildOptimalLineup` unchanged; `lib/trades/**` imports neither `start-sit-fi` nor
`football-intel` (structural test); the shadow path exists only in `buildWeeklyIntelligence`;
trade suites (`trade-engine-phase4/5`, evaluate/ros) pass unchanged. FI-adjusted projections
never reach trade valuation.

---

## 13. Data freshness & preseason handling (spec §11, §23)

Every `StartSitFiAdjustment` carries `fi_prior_season_only`; every shadow comparison carries
`lineage` with `football_intelligence_version`, `football_intel_data_cutoff` (per source),
`baseline_projection_version`, `start_sit_model_version`, `decision_generated_at`,
`deployment`. The live snapshot is `fi:2025:w18` — a 2025-derived prior for 2026 — flagged
`FI_PRIOR_SEASON_ONLY` with a `× 0.6` prior-dominated haircut and a warning; never presented
as observed 2026 performance.

---

## 14. Findings

| ID | Sev | Finding | Status |
| --- | --- | --- | --- |
| P4-1 | **P1** | Certified FI adds **no** incremental start/sit decision value over the production (RotoWire-backed) weekly projection for any position (§7.3, §9). The matchup/efficiency signal is already priced in — double-counting (§11). | **RESOLVED (honest)** — `deployment: SHADOW_ONLY`; no production behavior change; contract frozen + Phase-5-consumable. |
| P4-2 | **P1** | FI *hurts* TE start/sit decisions (reversal win rate 0.416, −1.28 pts/reversal). | **RESOLVED** — TE `SHADOW_ONLY_NO_VALUE`; excluded from any production path; families `EXPLAIN`/`REMOVE`. |
| P4-3 | **P1** | Sleeper historical weekly projections are unreliable as a pre-game artifact for 2021 (no timestamp) and 2022 (bulk backfill). | **RESOLVED** — Sleeper baseline is research-only, 2023–2025 only; clean trailing-PPG control is the certification baseline (§3). |
| P4-4 | P2 | RB shows a real coin-flip edge (+0.42 acc, +2.09 pts/reversal) vs the naive control that vanishes vs the production baseline. | Documented `TIE_BREAK_SHADOW_ONLY`. Re-evaluate if/when Roster Intel weekly projections become the production baseline. |
| P4-5 | P2 | Replacement-tier players get a median \|adj\| ≈ 0.35 pts — small absolutely, larger proportionally. | Bounded by the 0.25·\|baseline\| cap; irrelevant while SHADOW_ONLY. A promotion-time remediation. |
| P4-6 | P3 | `MAX_WIN_PROBABILITY` / `HIGH_CEILING` / `HIGH_FLOOR` / `LATE_SWAP_SAFE` not implemented. | Per approved scope — v1 is MAX_EXPECTED only. Floor/ceiling FI adjustments did not validate → `floor_adjustment = ceiling_adjustment = 0`. |
| P4-7 | P3 | Explanation fidelity: reason codes are filtered to the net-adjustment sign but a mixed-signal player still under-narrates the headwind families. | Acceptable for SHADOW_ONLY; a promotion-time remediation. |
| P4-8 | P3 | No Phase 3 contract defect surfaced. | — |

**No P0s.** All P1s are resolved by the honest `SHADOW_ONLY` disposition + documentation.

---

## 15. Deferred (`DEFERRED_FEATURES`)
Production FI start/sit integration (pending a stronger baseline or accumulated live-2026 FI);
`unit_coverage_profile`; `MAX_WIN_PROBABILITY` with a real covariance model; `HIGH_CEILING` /
`HIGH_FLOOR` / `LATE_SWAP_SAFE` objectives; TE/K/DST FI integration; custom-scoring-bonus
validation beyond the 3 archetypes; RB tie-break integration if Roster Intel weekly
projections become the production baseline.

---

## 16. Definition-of-done check (spec §44)

1 baseline frozen ✓ · 2 Phase-3 semantics enforced downstream ✓ (17 tests) · 3 FI translation
separate from raw FI ✓ (`lib/weekly/start-sit-fi/`) · 4 league scoring correct ✓ (3 archetypes) ·
5 legal whole-lineup optimization unchanged ✓ · 6 missing/unresolved FI → baseline ✓ ·
7 confidence controls influence ✓ · 8 double counting audited ✓ (**it is the headline finding**) ·
9 chronology-safe historical evaluation ✓ · 10 decision quality measured ✓ · 11 reversals
analyzed ✓ · 12 feature-family ablation complete ✓ · 13 position-specific results documented ✓ ·
14 no descriptive/nonpredictive leak ✓ (tested) · 15 shadow mode works ✓ (live-verified) ·
16 invariants pass ✓ · 17 adversarial audit passes ✓ · 18 full regression passes ✓ ·
19 certification based on decision evidence ✓ · 20 Phase 5 can consume the frozen contract ✓.

**Criterion 6 of the §38 certification standard — "decision-level value improves over the
stricter clean baseline for at least the positions entering production" — is NOT met: no
position enters production.**

---

## 17. VERDICT

Every safety, enforcement, chronology, isolation, legality, determinism, and regression
criterion passes. The FI→Start/Sit translation layer is deterministic, versioned, bounded,
confidence-aware, ablatable, and programmatically respects the Phase 3
`OBSERVED / MODELED / DESCRIPTIVE_ONLY` + `predictive_status` contract (proven by 17 tests).
The shadow path is live-verified to change **nothing** in production, and the trade engine is
provably untouched.

But the phase's own central question is answered in the negative: **certified Football
Intelligence does not improve start/sit decisions over the projection production actually
uses.** The information is already priced in (double-counting), it actively hurts TE, and the
one real signal (RB coin-flips vs a naive baseline) does not survive the stricter comparison.
Per §38, a phase certifies only with "evidence that the candidate decision layer … adds
useful out-of-sample value." It does not.

The blocker is not a defect and not remediable by more modeling — redundant information stays
redundant. The remediation is a **scope decision** for review:
(a) accept `SHADOW_ONLY` as the permanent Phase-4 end-state and re-run certification with that
as the explicit target (the contract is already frozen and Phase-5-consumable); or
(b) obtain the true production baseline (Roster Intel weekly projections, when they exist) and
re-test RB; or
(c) accumulate live-2026 FI and re-evaluate once FI is current-season rather than a prior.

# CONDITIONAL — REMEDIATION REQUIRED

The remediation is the scope decision above, not code. Production start/sit behavior is
unchanged and safe as-is. Do not begin Phase 5.
