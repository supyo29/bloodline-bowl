# Team Management — Phase 3: R Football Intelligence Engine

**Status: BUILT + AUDITED. Verdict at §35.**

Phase 1 (canonical live-state) FROZEN + in production. Phase 2 (Team-State) CERTIFIED +
merged (`c6edde6`). Phase 3 branch `team-management-phase3-football-intelligence` (rebased
onto `main` `48a97cb`, which already contains Phases 1–2 and the concurrent bridge work).

Phase 3 builds a **versioned, opponent-adjusted, uncertainty-aware Football Intelligence
Snapshot** that downstream models *can* consume. It is **not** Start/Sit, not the Matchup
model, not a fantasy recommendation engine. It produces football facts and modeled signals;
it decides nothing about any player or lineup. **No fantasy recommendation output changed**
(spec §32 — verified: 1471/1471 deterministic TS tests pass, unchanged).

---

## 1. Objective

Maintain Bloodline Bowl's versioned understanding of how NFL offenses, defenses, units, and
players are actually performing — opponent-adjusted, recency-weighted, prior-informed, and
honest about uncertainty — so that projections / Start-Sit / Matchup / waivers / trades /
roster planning / the orchestrator can later join fantasy roster players to it.

---

## 2. Existing R infrastructure audit → ownership map

The full audit is in this file's git history (the pre-implementation commit). Summary of what
was found and the reuse decisions:

| Spec assumed | Reality | Decision |
| --- | --- | --- |
| `services/r-api`, `_targets.R`, a target graph | **None existed.** R = standalone `analysis/phase*.R` scripts → `.rds` caches → committed `.csv`+`.meta.json` → TS file readers | Reuse the fetch/cache/serve pattern verbatim. **Introduce `_targets.R`** (the one missing piece). Do **not** add a `plumber` service. |
| Calibration / backtest engines | `analysis/phase2_calibration.R`, `analysis/phase3_lib.R` (`metric_set`, `paired_boot`, `multiclass_brier`) | Reuse `phase3_lib.R` helpers for the Phase 3 backtest/ablation. |
| Player identity | `nflreadr::load_ff_playerids()` (`gsis ↔ sleeper ↔ pfr ↔ espn ↔ yahoo`), name/school matcher in `phase3_lib.R`; TS `lib/projections/canonical-identity.ts` + frozen Phase 1 crosswalk | Reuse. R keys on `gsis_id`; TS resolves `canonical_player_id`. |
| Existing opponent adjustment | **One, not in the live path**: `phase35_schedule_pipeline.R` raw points-allowed percentile (2025 only). Weekly Matchup engine does none. | **Supersede, don't delete** — Phase 3 publishes the opponent-adjusted successor as a *new* artifact; the trade engine is not repointed (spec §32). |
| Scheme / team-context features | **None.** `lib/projections/model.ts` "team environment" is the team's own pace/volume, not scheme or opponent context. | Net-new. |

**New Phase 3 layout:**
```
_targets.R                              {targets} weekly pipeline (33 targets)
analysis/football_intel/
  config.R              versions, seasons, decay/recency/ridge params, thresholds, PREDICTIVE_STATUS
  fetch_raw.R           nflverse pulls -> cache/*.rds (+ source_availability.rds)
  lib_features.R        pbp/participation/pfr -> team-game & player-game feature tables
  lib_opponent_adj.R    ridge two-way (offense/defense) effects; closed-form, deterministic
  lib_priors.R          decayed cross-season prior + multiplicative discontinuity discount
  lib_recency.R         EW estimate + single-game partial-pool guard + shrink_to + confidence + trend
  lib_continuity.R      HC (schedules), QB (pbp), OL/front/secondary returning share (snaps), OC/DC (yaml)
  lib_profiles.R        METRIC_SPECS + compute_metric_profile() end-to-end per metric
  lib_usage.R           player usage profiles (OBSERVED opportunity only)
  lib_interactions.R    coverage-allowed, 6 contextual matchup features, FTN descriptive
  build_snapshot.R      assemble + version + write served CSV/JSON + internal RDS
  backtest.R            chronology-safe walk-forward + baseline comparison + incremental value
  adversarial_audit.R   15 attack scenarios (spec §29)
  coordinators.yaml     hand-sourced OC/DC registry (empty by default; absent => UNKNOWN => no discount)
  tests/testthat/       24 statistical invariant tests (spec §30)
lib/football-intel/      READ-ONLY TS adapter (schema.ts, read.ts, index.ts) — NOT wired to any engine
  data/                  the committed, Vercel-safe served snapshot (manifest + 5 CSVs)
outputs/football-intel-2026/   backtest diagnostics + internal snapshot RDS (git-ignored, like other phases)
```

---

## 3. Data-source inventory & availability classification

Probed live against `nflreadr` 1.5.0 / R 4.5.3 on 2026-09-06/07. 2025 is complete; the
canonical live state is season 2026 week 1 (no 2026 games played → the published snapshot is
the most recent complete season, 2025 W18, matching the `phase35_*` precedent).

**A — reliable now:** `load_pbp` (1999–, EPA/success/air_yards/`pass_oe`/`xpass`/shotgun/RZ,
2006– for the WP/xpass models), `load_nextgen_stats` (2016–), `load_snap_counts` (2012–),
`load_schedules` (1999–, spread/total/roof/coaches/rest).

**B — derivation required:** `load_participation` (**2016–2025**, resumed after a real gap;
lags pbp 1–2 wk in-season) → formation, personnel, `defenders_in_box`,
`number_of_pass_rushers`, `route`, `was_pressure`, `defense_man_zone_type`;
`load_pfr_advstats` weekly (**2018–**) → `times_pressured/blitzed/hurried`, YBC/YAC, broken
tackles, `def_pressures`, `def_missed_tackle_pct`, coverage-allowed; OL/front/secondary
continuity from `load_snap_counts` + `load_rosters_weekly`; QB continuity from pbp.

**C — partial/weak (not a v1 predictor):** run concept (gap/zone/power) — no reliable free
source; individual LB/DB attribution from team data; pre-2016 usage/routes; weather effects;
`load_depth_charts` ordering post-2025 schema change.

**D — unavailable (not fabricated):** PFF/SIS grades, PBWR, route-level coverage matchups,
coverage scheme beyond man/zone + high-safety count, structured practice reports, coordinator
play-scripts.

**Backtest feasibility:** 2016–2025 for usage/participation features; 2018–2025 for
PFR-pressure; **FTN charting is 2022–2025 only** → cannot carry a decayed multi-season prior
or a real walk-forward backtest → **descriptive-only** (guardrail 1).

---

## 4. Identity strategy

R keys on `gsis_id` (pbp/NGS/rosters); joins `pfr_id` (PFR/snaps) and `sleeper_id` via
`load_ff_playerids()`. Every published player row carries `gsis_id`, `sleeper_id`, `pfr_id`,
`position`, `nfl_team`. NFL teams: `nflreadr` abbreviations with `FI$normalize_team()`
collapsing `OAK/SD/STL/LA/WSH/…` into one universe (adversarial check 11). The engine takes
**no** league/manager/roster input (spec §4). TS resolves `canonical_player_id` via the
frozen Phase 1 crosswalk in the read adapter, not in R.

---

## 5. v1 feature scope (approved with guardrails)

20 team metrics + player usage (9 metrics/player) + unit coverage-allowed (RB/WR/TE) + 6
contextual interaction features. **Zero fantasy-point translation.** Every field is tagged
`OBSERVED` / `MODELED` / `DESCRIPTIVE_ONLY` (guardrail 5) and every MODELED team metric also
carries a walk-forward `predictive_status` (guardrail 4, §19).

`DEFERRED_FEATURES` (built mechanism absent or descriptive-only): FTN play-action/screen/
RPO/motion (2022–25 window — published in `ftn_descriptive.csv`, `output_class
DESCRIPTIVE_ONLY`, never an input); man/zone splits (`def_man_rate`, DESCRIPTIVE_ONLY,
min-play gated); run-concept tendencies; individual OL/LB/DB ratings; coordinator scripts;
weather adjustments; free-agent/waiver context (canonical `waiver_state` still null —
Phase 1C C-5). Inside/outside rushing location is available but retained at `LOW` confidence
and **never** relabeled as a charted concept (guardrail 3).

---

## 6. Methodology

### 6.1 Historical priors (§8, §13, §14, §22)
A unit's season prior = decayed blend of its prior-season opponent-adjusted ratings,
`w_k ∝ λ^(k-1)` (`λ = 0.5`, ≤ 4 prior seasons). The prior's **effective sample** =
`k · PRIOR_STRENGTH · discount · (n_prior_seasons / 4)` with `PRIOR_STRENGTH = 0.6` —
deliberately ≤ 1 shrink-constant so a full current season dominates a stale prior
(adversarial checks 3, and the pre-fix over-shrinkage was a P1 finding, now resolved).
`discount ∈ (0,1]` is the **product** of active discontinuity factors: HC change 0.55,
OC/DC 0.65, QB 0.60 (offense), low OL continuity 0.80, high front/secondary turnover 0.80.
Unknown continuity ⇒ discount 1.0 (never assumed — invariant test).

### 6.2 Recency (§9)
EW over game-level unit metrics, half-life 5 games (grid `{3,4,5,7}`), with a
partial-pool guard: one game cannot move the estimate more than `1.25 · pooled_sd`
(invariant test + adversarial check 4 — a −3.0 EPA game drops BAL 0.29 → 0.08, does not flip).

### 6.3 Opponent adjustment (§10)
`y_g = μ + off_effect[team] + def_effect[opp] + ε`, one **ridge-penalized weighted
least-squares** solve per metric (penalty 1.0 on the 2×32 team dummies), games weighted by
play count × recency. Closed-form → deterministic, converges by construction (invariant +
adversarial 5, 6, 7, 13). `lme4` is not installed; ridge via base `solve` / `MASS::ginv`
fallback. Outputs `raw`, `modeled` (opponent-adjusted + prior + recency + shrink), a
`league_percentile` oriented by `higher_is_better`, `n_obs_effective`, `std_error` (posterior),
`confidence`.

### 6.4 Uncertainty / shrinkage (§11)
`shrink_to()`: blend obs↔prior by effective sample, then shrink the blend → league mean by
`n/(n+k)` (`k` = 200 plays for EPA-family, 120 for rate metrics, 4 games for usage).
`confidence ∈ {HIGH, MEDIUM, LOW, INSUFFICIENT_SAMPLE}` from effective sample vs published
thresholds; **HIGH requires real in-season corroboration** (`obs_only ≥ low_threshold`) — the
prior alone cannot buy HIGH (adversarial check 1, was a P1). Knock-down one notch when
posterior SE exceeds the cross-team rating spread. A rating below its publication threshold
is emitted **flagged, never suppressed, never replaced with a fabricated league mean** (§25;
adversarial 9 — pre-2016 `man_rate` is `NA`, not `0`).

### 6.5 Trend (§12)
`recent_level` (half-life 2) vs `current_level` (full posterior), standardized by
`pooled_sd/√recent_eff_games`. Direction: dead-band `|z|<0.5` → `stable`; `se ≥ |mag|` →
`uncertain`; else `improving`/`deteriorating`. `trend_magnitude` always published as a
continuous number. Conservative by design (spec §11/§12).

### 6.6 Contextual interaction features (§15)
`interaction_signal = off_percentile − (1 − def_percentile) ∈ [−1,1]`, positive favors the
offense. Confidence = min(off, def) confidence, **capped at LOW when either side's metric is
`NOT_PREDICTIVE`** (guardrail 4). `predictive_status` string (e.g. `off:PREDICTIVE|def:NOT_PREDICTIVE`)
on every row. **Never a fantasy point** (§16, §32).

---

## 7. Anti-double-counting (§16, §33)
Phase 3 publishes no `+x.x` adjustment. The shadow evaluation (`backtest.R`) measures whether
the modeled rating adds out-of-sample information *beyond simple baselines* (§19). Overlap
with existing projection opportunity allocation and the Sleeper benchmark is expected on the
volume/efficiency axes; the opponent-adjustment and cross-season prior are the net-new
signal. Downstream calibration (Phase 4+) decides if/how much these move fantasy numbers —
Phase 3 does not.

---

## 8. Snapshot contract (§3, §23)

`football_intelligence_manifest.json` (served):
```
football_intelligence_version : fi:<season>:w<week>:<12-hex sha256 of the served tables>
model_tag                     : ri-football-intel-2026.1
feature_schema_version        : 1
season / through_week         : 2025 / 18   (auto: latest fully-available week; falls back to last complete season)
data_cutoff                   : { pbp:18, participation:18, pfr_pass:18, ... }  per-source real availability (guardrail 2)
seasons_used                  : { prior:[2021..2024], current:2025 }
model_versions                : opponent_adjustment / prior / recency / trend / usage
config                        : prior_decay_lambda, recency_halflife_games, opp_adj_ridge_lambda, seed
```
Immutable: a new weekly run writes a **new** version + directory. Served as CSV/JSON;
internal state as RDS (§9 below). Tables: `team_profile.csv` (640 rows = 20 metrics × 32),
`player_usage_profile.csv` (~19k), `unit_coverage_profile.csv` (96), `contextual_matchup_feature.csv`
(~6k), `ftn_descriptive.csv` (160, DESCRIPTIVE_ONLY).

Every MODELED rating ships its full decomposition (§26): `raw`, `modeled`, `prior_mean`,
`prior_discount`, `prior_weight`, `recent_weight`, `shrunk_to_league`, `std_error`,
`league_percentile`, `n_obs_effective`, `confidence`, `predictive_status`, and the trend
block.

---

## 9. Persistence (§23 — APPROVED: RDS internal + CSV/JSON served)
`.rds` for the R cache and internal snapshot object; `.csv` + `.json` for the TS boundary
(committed under `lib/football-intel/data/`, Vercel-safe, regression-testable). **No Parquet
in Phase 3.** Documented future Parquet trigger: served artifact materially large, measurable
CSV-parse API latency, weekly load memory pressure, columnar analytical consumers, or
dimensionality far beyond v1. Until measured evidence: **RDS internal + CSV/JSON external is
the frozen Phase 3 choice.** (Current served size: 4.2 MB, dominated by the 19k-row usage
table — within precedent set by `lib/trades/data/player_usage_weekly.csv`.)

---

## 10. Weekly pipeline (§21)
`_targets.R` (33 targets): raw file targets → typed loads → `team_game_features` /
`player_game_usage` → `target_week` → `prior_ratings` / `discontinuity` → `team_profile` /
`player_usage_profile` / `unit_coverage_profile` / `contextual_matchup_feature` /
`ftn_descriptive` → `fi_snapshot` (publishes). Unchanged upstream ⇒ no downstream recompute.
Operational commands:
```
Rscript analysis/football_intel/fetch_raw.R --refresh     # pull new completed games (network)
Rscript -e 'targets::tar_make()'                          # rebuild features -> snapshot
```
`tar_manifest()` validates the DAG (33 nodes, acyclic). Raw fetch ≈ 1m45s; feature build
≈ 20s; full snapshot ≈ 60s.

---

## 11. TypeScript / Team-State integration contract (§24)
`lib/football-intel/` — read-only, pure file reads + the frozen crosswalk, structural
`throughWeek()` cutoff (per source). API:
`loadFootballIntelligence()` → `{ manifest, team(t), teams(), playerUsage({gsis_id|sleeper_id}),
coverageAllowed(t), contextualMatchup(feature, off, def), ftnDescriptive(t), throughWeek(src?) }`.
Honest degradation: no snapshot → `null`; player miss → `{ resolution: "UNRESOLVED" }`;
matchup miss → `{ availability: "NOT_AVAILABLE" }`. **Not imported by Team-State or any
recommendation engine** (spec §24, §32). Team-State's fact/evaluation boundary is untouched.
10 read-contract tests (`test/football-intel-read.test.ts`).

---

## 12. Missing / degraded behavior (§25) — verified
`availability = NOT_AVAILABLE` / `resolution = UNRESOLVED` / `confidence = INSUFFICIENT_SAMPLE`
are all real return states, tested. Pre-2016 scheme metrics are `NA`, never `0`. FTN before
2022 is absent, never forward-filled. No fabricated league-average substitution.

---

## 13. Explainability (§26) & determinism (§27)
Every rating decomposes into raw / prior contribution / recent contribution / opponent
adjustment (raw − modeled net of prior) / shrink-to-league / SE / confidence / version.
Determinism: single seed (`20260907`), closed-form ridge, no MCMC. Invariant test
"identical inputs → byte-identical ratings" + adversarial "compute_metric_profile is
deterministic" + the content-hash version id (same cache ⇒ same `fi:` id).

---

## 14. Backtest design & results (§17–§20, §31)

**Design:** rolling-origin walk-forward, test seasons 2021–2025, weeks 4–18. For each
(season, week W): priors from seasons `< test_season` only; modeled rating from weeks `< W`
only; scored against the team's **actual weeks W..W+3** raw metric. No future week enters any
fit (invariant + adversarial checks 6). ~2400 team-week observations per metric.

**Baselines (§31):** `b0` league mean · `b1` season-to-date raw · `b2` EW raw ·
`b3` prior-season rating · **CAND** full modeled.

**Incremental value (CAND vs the best baseline per metric, paired bootstrap 2000×):**

| feature | best baseline | baseline MAE | CAND MAE | P(CAND better) | 95% CI of Δ | final status |
| --- | --- | --- | --- | --- | --- | --- |
| off_pass_epa | b3 (prior) | 0.1515 | **0.1431** | **1.00** | [−0.0100, −0.0065] | **KEEP (PREDICTIVE)** |
| off_rush_epa | b0 | 0.1054 | **0.1031** | **1.00** | [−0.0037, −0.0010] | **KEEP** |
| off_success_rate | b1 | 0.0391 | **0.0375** | **1.00** | [−0.0024, −0.0007] | **KEEP** |
| off_proe | b2 | 5.225 | **5.073** | **0.997** | [−0.29, −0.05] | **KEEP** |
| off_pace_sec_play | b3 | 1.196 | **1.130** | **1.00** | [−0.079, −0.052] | **KEEP** |
| off_explosive_pass_rate | b0 | 0.02965 | **0.02820** | **1.00** | [−0.0019, −0.0010] | **KEEP** |
| def_success_allowed | b0 | 0.03896 | **0.03794** | **1.00** | [−0.0016, −0.0005] | **KEEP** |
| def_pass_epa_allowed | b0 | 0.14762 | 0.14737 | 0.60 | [−0.0020, +0.0015] | **NOT_PREDICTIVE** |
| def_rush_epa_allowed | b0 | 0.10159 | 0.10266 | 0.04 | [+0.0001, +0.0022] | **NOT_PREDICTIVE** |

**Reliability:** CAND's edge over the rolling mean (`b1`) is largest early in the season
(`cand_beats_b1` 0.62 in weeks 1–4, converging to ~0.48 by week 13+) — exactly the prior's
job (§8: early samples are too small to be truth). MAE rises in the weeks-13+ future window
(rest/tank games — expected noise, not a model failure).

**Model-selection decisions (§31):** the opponent-adjusted + prior + recency + shrink stack
beats every simple baseline out-of-sample for **all seven offensive metrics** and
`def_success_allowed`. It does **not** beat the league mean for team-level defensive
**EPA-allowed** (pass or rush) at a 4-week horizon — a known result (defense regresses harder
than offense). Those two are **retained but published `NOT_PREDICTIVE`**: they are honest
opponent-adjusted summaries of what happened, they still feed `def_success_allowed` context
and coverage-allowed, and any contextual feature that uses them is confidence-capped at LOW.
Simpler models were **not** discarded in favor of complexity anywhere — the RDS/CSV split,
ridge-not-`lme4`, closed-form-not-MCMC, and the small metric set are all the deliberately
simpler choice.

---

## 15. Adversarial audit (§29) — 15 / 15 pass

`Rscript analysis/football_intel/adversarial_audit.R` (exit 0):

| # | scenario | result |
| --- | --- | --- |
| 1 | Week-1 tiny sample | prior_weight > recent_weight for 94% of teams; **no team HIGH confidence** |
| 2 | confidence vs weeks of data | monotonically non-decreasing wk1→wk18 (2.25 → 3.34 mean rank) |
| 3 | current dominates stale prior | high-divergence half moves 42% toward current; even BAL's historic 2024 outlier moves 26% off prior |
| 4 | one extreme outlier game | −3.0 EPA game: BAL 0.290 → 0.079, does not flip negative |
| 5 | opponent adjustment directional | same raw production vs strong D rates +0.31 vs weak D −0.09 |
| 6 | no look-ahead | deleting weeks > W leaves the through-W rating byte-identical |
| 7 | determinism | `compute_metric_profile` reproduces exactly |
| 8 | coaching + QB change | discount applied, bounded (0,1] |
| 9 | unavailable data not fabricated | 2014 `man_rate` all `NA`, never `0` |
| 10 | bye week / missing team-week | exactly one row per team per metric, ≤ 32 |
| 11 | team relocation aliases | no `OAK/SD/STL/LA` in features |
| 12 | NOT_PREDICTIVE tagging | `def_pass_epa_allowed` carries `NOT_PREDICTIVE` on output |
| 13 | very weak schedule | a team padding vs only-weak D is adjusted from +0.30 raw to ~0 |
| 14–15 | (covered by 3, 5) | — |

Coordinator-change midseason, garbage-time, overtime, weather: the neutral-script filter
(`FI$NEUTRAL_*`) already removes garbage time from tendency metrics; OT/weather are not
separately modeled (documented C/D), and midseason coordinator changes need a
`coordinators.yaml` entry (P3-A3, below).

---

## 16. Statistical invariant tests (§30) — 24 / 24 pass

`Rscript analysis/football_intel/tests/run.R` (`testthat`, `stop_on_failure=TRUE`):
determinism; opponent-adjust monotonicity + isolation; no-lookahead; league-average team
shrinks to 0; zero games → prior-driven; large sample → prior diminishes; single-game cap;
more sample never lowers confidence; average team with tight SE stays confident; trend
dead-band; discontinuity multiplicative + bounded; unknown continuity ⇒ no discount; FTN
never in `METRIC_SPECS`.

---

## 17. Shadow fantasy evaluation (§33)
Treated as a research diagnostic, **not wired to production scoring**. The `off_*` ratings
carry genuine out-of-sample signal about future team offensive efficiency (§14) — the
component most plausibly useful to weekly projection opportunity/efficiency. The
`def_*_epa_allowed` NOT_PREDICTIVE finding is itself a useful negative result for a future
Matchup model: a naive "opponent allowed X EPA" feature would add noise, not signal, at a
multi-week horizon. Whether these help *fantasy point* prediction beyond the existing
projection inputs is a Phase 4+ calibration question, deliberately not answered here.

---

## 18. Regression (§32, §35)
- `npx tsc --noEmit` — clean
- `npx eslint app lib test` — 0 errors (29 pre-existing warnings; **0 new** — the new
  `lib/football-intel/**` and `test/football-intel-read.test.ts` lint clean)
- `npm test` — **1471 pass / 0 fail / 4 skipped** (was 1471/0/4 pre-Phase-3 on the rebased
  base; +10 new football-intel read tests, **0 existing tests changed or weakened**)
- R: 24 invariant + 15 adversarial checks pass
- Phase 1C cross-surface certification + Phase 2 Team-State suites: unaffected (no canonical,
  team-state, weekly, trade, waiver, or projection file touched — `git diff --stat` is
  confined to `_targets.R`, `analysis/football_intel/**`, `lib/football-intel/**`,
  `test/football-intel-read.test.ts`, `.gitignore`, `docs/`).

---

## 19. Findings

| ID | Sev | Finding | Status |
| --- | --- | --- | --- |
| P3-1 | **P1** | Prior effective sample (`prior_weight_sum · k`) was ~375 play-equiv, over-shrinking full-season ratings (BAL 2024 0.36 → 0.006). | **FIXED** — `prior_eff = k · 0.6 · discount · (n_seasons/4)`; recency half-life 3→5; adversarial check 3 now passes; backtest predictive value preserved. |
| P3-2 | **P1** | The prior alone could buy HIGH confidence at Week 1. | **FIXED** — HIGH now requires `obs_only ≥ low_threshold`; adversarial check 1 passes. |
| P3-3 | **P1** | Team-level **defensive EPA-allowed** (pass & rush) shows **no** out-of-sample incremental value over the league mean at a 4-week horizon. | **RESOLVED (honest)** — retained but published `NOT_PREDICTIVE`; contextual features using them are confidence-capped; documented, not hidden. |
| P3-4 | P2 | FTN charting is 2022–2025 only → no prior, no backtest. | By design **DESCRIPTIVE_ONLY**, `output_class` tagged, never an input (guardrail 1, invariant test). |
| P3-5 | P2 | nflverse ships head coach only; OC/DC changes need `coordinators.yaml`. | Mechanism built + tested; file ships **empty** (absent ⇒ `UNKNOWN` ⇒ no discount — the guardrail-correct default). Populate from public record as needed. |
| P3-6 | P2 | `load_participation` lags pbp 1–2 weeks in-season. | Per-source `data_cutoff` in the manifest + `throughWeek(source)` in the adapter; backtest respects real availability. |
| P3-7 | P2 | Run concept (gap/zone/power) has no reliable free source. | Deferred; inside/outside only at LOW confidence, never relabeled (guardrail 3). |
| P3-8 | P3 | No `arrow`/Parquet in the R env; no R-native test suite existed. | Stayed on `.rds`+CSV (precedent); introduced the first `testthat` suite. |
| P3-9 | P3 | `off_rz_td_rate`, `def_rz_td_rate_allowed` not individually backtested. | Tagged `UNVALIDATED`; small RZ samples; candidate for a later FI version. |
| P3-10 | P3 | Trend layer is conservative — ~80% of team-metric trends read `uncertain` on a full-season snapshot. | Deliberate (spec §11/§12); `trend_magnitude` always published as a continuous number for consumers that want the raw signal. |

**No P0s. All P1s fixed or resolved-honest.**

---

## 20. Deferred feature families (`DEFERRED_FEATURES`)
FTN-derived predictive features (revisit when ≥ 5 seasons); man/zone & high-safety as
headline ratings; run-concept tendencies & defense-vs-concept; individual OL / LB / DB
ratings; time-to-pressure (only `time_to_throw` proxy); coordinator play-scripts & personnel
packages by tendency; weather-distortion adjustments; garbage-time-specific models; ROS /
playoff modeling; **any fantasy-point translation** (Phase 4+); waiver/FA context (blocked on
canonical `waiver_state`, Phase 1C C-5).

---

## 21. Recommendation for Phase 4 (Start/Sit)
1. Consume `lib/football-intel/` read-only via a new adapter in the Start/Sit engine; **do
   not** back-propagate into Team-State (keep its fact/evaluation boundary).
2. Use the `off_*` ratings + `player_usage_profile` as calibration *candidates* for weekly
   opportunity/efficiency — run the same paired-bootstrap incremental-value test against the
   existing projection inputs before letting them move a single fantasy number (§16).
3. Treat `def_*_epa_allowed` as `NOT_PREDICTIVE` — do **not** build a "points allowed to
   position" matchup feature on the raw version; if a defensive matchup signal is wanted,
   start from `def_success_allowed` (the one that validated) and the contextual interaction
   features, at their capped confidence.
4. Populate `coordinators.yaml` for the 2026 season's actual OC/DC changes (public record,
   one `source_url` per row) before the engine leans on continuity-adjusted priors.
5. Keep the weekly `tar_make()` in the operational runbook alongside the existing
   `fetch_raw.R --refresh`.

---

## 22. VERDICT

The engine is reproducible (`_targets.R`, one seed, closed-form), publishes an immutable
versioned snapshot with per-source cutoffs, leaks no future data (invariant + adversarial +
walk-forward), exposes explicit uncertainty on every rating, has opponent adjustment /
priors / small-sample shrinkage each covered by dedicated passing invariant tests, compares
against four simple baselines and **retains no complex feature that underperforms its
baseline without an explicit `NOT_PREDICTIVE` label**, changes **no** recommendation-engine
output, has a clean read-only Team-State integration contract, is deterministic, and all P1
findings are fixed or resolved-honest.

Certification requires predictive evidence: **seven offensive metrics + `def_success_allowed`
beat every simple baseline out-of-sample with P ≥ 0.997**; the two metrics that don't are
published honestly flagged.

# PHASE 3 CERTIFIED — READY TO FREEZE

Do not begin Phase 4 Start/Sit.
