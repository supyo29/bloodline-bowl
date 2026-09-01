# `lib/projections` — 2026 Roster Intel projection engine

Three strictly separated layers. See the repo README "Projection layers" section for the
high-level contract; this file is the implementation map + the honest calibration state.

## Files

| File | Layer | Responsibility |
| --- | --- | --- |
| `schema.ts` | — | Canonical types + `PROJECTION_MODEL_VERSION` / `PROJECTION_SCHEMA_VERSION` |
| `baselines.ts` | 1 | Position baselines, recency weights, shrinkage constants `K`, age curves, `CalibrationProfile` (v1/v2/v3) |
| `rookie-model.ts` | 1 | Phase 3 draft-capital rookie opportunity prior + vendored 2026 rookie draft crosswalk |
| `actuals.ts` | 1 | Historical box-score actuals from `/v1/stats/nfl/regular/{season}` (+ `TEAM_*` totals) |
| `sleeper.ts` | benchmark | Sleeper/RotoWire projection provider — **BENCHMARK_ONLY**, never a model input |
| `model.ts` | 1 | Team environment → opportunity allocation → efficiency → TD → availability → stat line |
| `uncertainty.ts` | 1 | Analytic floor/median/ceiling (P20/P50/P80), confidence buckets, optional Monte Carlo |
| `reconcile.ts` | 1 | Team-level reconciliation (Σ player volume ≈ team volume) + optional normalization |
| `compare.ts` | benchmark | RI vs Sleeper deltas, deterministic `primary_driver`, per-position aggregates |
| `league.ts` | 2 | Translate the stat line through a league's real scoring via `calculateFantasyPoints` |
| `replacement.ts` | 2 | Replacement level / VOR / tiers / scarcity from the league's real lineup config |
| `manager-value.ts` | 3 | Need-weighted contextual value for one manager's roster (does not mutate Layers 1/2) |
| `backtest.ts` | — | Genuine out-of-sample backtest of the RI core vs naive baselines |
| `build.ts` | all | Orchestrator + module-scope caches + versioning + provider diagnostics |
| `service.ts` | all | HTTP-facing glue for the `/api/projections*` routes |

## Cache keys (enforced in `build.ts`)

```
base    = base:{season}:{projection_version}:{model_version}
league  = league:{season}:{projection_version}:{league_id}:{scoring_hash}
manager = manager:{season}:{projection_version}:{league_id}:{scoring_hash}:{sleeper_user_id}:{draft_id:state:roster_size}
```

`roster_id` is never a key — BijiMac and DarthMarker are both `roster_id 2` in different leagues.

## Sleeper: benchmark, not target

- `RI_STANDALONE` is trained on nothing but historical actuals + baselines. `sleeper.ts` output
  is only ever read by `compare.ts` and surfaced in `vs_sleeper` / the disagreement artifacts.
- Provider degradation is non-fatal: `status` (`OK` / `DEGRADED_SCHEMA` / `STALE` / `UNAVAILABLE`),
  `players_matched/unmatched`, `coverage_by_position`, `missing_expected_keys` are all surfaced. A
  Sleeper failure lowers nothing to zero and never crashes the build — it just drops the
  comparison and emits a warning.

## Calibration state (`model_version: ri-structural-2026.3`)

`2026.3` is `2026.2` **plus** the Phase 3 draft-capital rookie opportunity prior. Every Phase 2
lever (haircut 1.50, floor 0.35, age curves, opportunity shade, efficiency `K`, recency weights,
TD model, team-environment, reconciliation) is **frozen and byte-identical** — Phase 3 did not
recalibrate anything and `test/projection-r-parity.test.ts` still passes against the same Phase 2
fixture. See [Phase 3 — rookie opportunity](#phase-3--rookie-opportunity-model_version-ri-structural-20263) below.

## Calibration state (`model_version: ri-structural-2026.2`)

Calibrated in Phase 2 with a reproducible R harness (`analysis/phase2_calibration.R`, sourcing
`analysis/lib_ri_projection.R`). Rerun end to end:

```bash
npx tsx scripts/export-backtest-dataset.ts   # raw historical dataset -> outputs/projections-2026/
Rscript analysis/phase2_calibration.R        # metrics, bootstrap, candidates -> phase2_*.csv + plots
```

Rolling season-aware validation (target Y uses seasons < Y only). The expected-games haircut is
selected by a **deterministic rule on 2023-2024 only** (below); every other lever is an a-priori
football value. 2025 is evaluated **once**, after the value is frozen. 1000-resample bootstrap
(seed 20260901), candidate-vs-baseline **paired** on identical player-seasons. R port parity-checked
against the production TypeScript (`test/projection-r-parity.test.ts`, |R−TS| ≤ 1.0 pt).

**`ri-structural-2026.2` change:**

| lever | v1 | v2 | football rationale |
| --- | --- | --- | --- |
| `GAMES_ATTRITION_HAIRCUT` | 0 | **1.50** games off `17·availability` | preseason can't see a mid-season injury / benching / scratch; component analysis showed expected-games biased +1.7-2.2 |
| `AVAILABILITY_FLOOR` | 0.45 | **0.35** | ~6 games is the real minimum for a projectable player who loses his role |
| RB/WR age curve | plateau to 26/28 | **steepened** (peak 25/27, faster decline) | residual-by-age: WR 29-32 over-projected ~-36, RB 26-29 ~-24 |
| `opportunityAgeShade` (30+) | — | opp ×`(0.5 + 0.5·age_mult)` | aging shows up in usage, not only efficiency |

**Haircut selection rule** (dev 2023-2024 only; 2025 not consulted): over grid H = {0, 0.25, …, 2.5},
the *stable region* S = { h : bias bootstrap 95% CI contains 0 ∧ MAE(h) ≤ min_H MAE + 0.50 ∧
RMSE(h) ≤ min_H RMSE + 0.75 ∧ Spearman(h) ≥ max_H Spearman − 0.005 }. h\* = grid value nearest
median(S), ties → smaller. Development result: **S = {1.25, 1.50, 1.75, 2.00}, median 1.625 → h\* = 1.50**
(dev calibration slope 0.998). Sanity gate dev-slope ∈ [0.96, 1.04]: OK.
(`phase2_expected_games_haircut_dev.csv`, `phase2_frozen_haircut_eval.csv`.)

Efficiency shrinkage `K` was swept 0.5×–3× and **left unchanged** — held-out MAE moved < 0.1 and
the paired CI spanned 0, so the current K is neither over- nor under-shrinking.

**Out-of-sample results (2025 holdout, RI core, PPR-neutral):**

| metric | v1 | v2 (h\*=1.50) |
| --- | --- | --- |
| bias | +12.2 | **+1.1** |
| MAE | 41.6 | **39.8** |
| RMSE | 60.2 | **57.7** |
| Spearman | 0.729 | 0.734 |
| calibration slope | 0.89 | **1.02** |
| paired MAE Δ vs v1 | — | **−1.75 [−3.00, −0.43]** |

- **Team reconciliation:** 32/32 teams, **0 HARD / 0 SOFT residual** after normalization.
- **vs baselines (backtest):** v2 beats prev-year points / prev-year PPG×17 / 3-yr-weighted on MAE,
  RMSE, Spearman, and bias.

## Phase 3 — rookie opportunity (`model_version: ri-structural-2026.3`)

Research harness: `analysis/phase3_rookie_role_model.R` (sourcing `analysis/phase3_lib.R`,
`analysis/phase3_fetch_data.R`). Rerun:

```bash
Rscript analysis/phase3_fetch_data.R          # cache nflverse + cfbfastR data -> analysis/phase3_cache/
Rscript analysis/phase3_rookie_role_model.R   # cohort, models M0-M6, holdout, 2026 crosswalk, parity fixture
npx tsx scripts/audit-phase3-rookie.ts        # v2 -> v3 production impact -> phase3_*.csv
```

Cohort: 874 drafted skill rookies 2015-2025. Deterministic college→NFL identity resolution
(`phase3_rookie_identity_crosswalk.csv`, 76% matched; AMBIGUOUS/UNMATCHED never enter training).
Rolling out-of-sample (train classes < Y); **2025 reserved as an untouched final holdout**.

**Central question — does college production add signal beyond NFL draft capital? No.**

| candidate | baseline | paired MAE Δ | 95% CI | verdict |
| --- | --- | --- | --- | --- |
| M1 draft capital (`log(1+pick)` + round) | M0 frozen role prior | **−10.1** | [−13.7, −6.7] | draft capital massively beats the generic prior |
| M4 draft + college production | M1 draft capital | +1.3 | [−0.05, +2.9] | **no incremental value (CI spans 0)** |
| M5 draft + college + destination | M1 draft capital | +3.5 | [+0.6, +6.8] | college *hurts* |
| veteran role-transition context | frozen | −0.06 | — | real but ~1 opp/season → **not promoted** |

Final holdout (2025, n=85): MAE 47.5 → **39.5**, Spearman 0.49 → **0.61**, bias −19.5 → **−7.2**.

**What shipped (`ri-structural-2026.3`):** a quasi-Poisson (log-link) rookie opportunity prior,
one fit per position, features `log(1+overall_pick)` and draft `round` only — no college data.
Predicts rookie-year `target_pg` / `carry_pg`, clamped to the observed rookie ceiling
(WR ≤ 9 tgt/g, TE ≤ 8.5, RB ≤ 16 car/g + ≤ 6 tgt/g). QB rookies are unchanged (no edge found).
UDFA / unmatched rookies fall back to a pick-261 / round-8 sentinel. Coefficients are frozen in
`lib/projections/rookie-model.ts`; the 2026 class is vendored in `data/rookie-draft-2026.ts` from
`load_draft_picks(2026)` × `load_ff_playerids()`. R↔TS parity: `test/fixtures/phase3-parity.json`
(|R−TS| ≤ 0.01), `test/projection-rookie-model.test.ts`.

**Wiring.** `CalibrationProfile.rookieDraftFor` gates it: only `CALIBRATION_V3` returns the real
lookup; `V1`/`V2` return `null`, so the v1↔v2 Phase 2 audit is unaffected. In `model.ts` the prior
feeds the *opportunity* stage (targets / carries / snap share) for a rookie with a known pick;
everything downstream (efficiency, TD, availability, reconciliation) is the frozen pipeline.

**Role-aware redistribution (§26).** Two guards, both in `model.ts`:
1. *Share cap* — a rookie's normalised target/carry share is capped at the historical rookie-year
   ceiling (WR/TE 0.28, RB 0.62); the excess is redistributed to non-capped teammates by open-weight.
2. *Keep-window widening (the "Isaiah Likely" guard)* — the receiver-group top-N cutoff (below which
   a player is treated as filler at 0.12 weight) is widened by one slot per drafted rookie that lands
   inside it. Without this, a rookie edging past the cutoff evicts the displaced incumbent to filler
   weight — an ~33-target TE2 collapsing to ~2 purely because a 3rd-round rookie joined the room.
   With it the incumbent keeps starter-tier weight and only gives up a proportional share.

Team volume is conserved either way (`test/projection-calibration-invariants.test.ts`,
`test/projection-rookie-model.test.ts` build-level cases; `phase3_opportunity_redistribution_audit.csv`).
Teams with no drafted skill rookie in their top 6 are byte-identical to `2026.2`.

**Production impact (v2 → v3, identical 2026 universe):** 290 players materially changed (63
rookies repriced, 227 redistributed teammates), per-team opportunity conserved within 3%. The
largest rookie increase (Jordyn Tyson, WR pick 8, +130 pts) is the frozen-prior bug this fixes —
`2026.2` buried every rookie without a clean `depth_chart_order` near zero opportunity.

### Known limitations

1. **The backtest covers the RI *core*, not the full `model.ts`.** The core projects each player from
   his own history; the production model adds team volume pools, opportunity concentration and a QB
   starter-share rank. The v2 constants are implemented identically in both, but the *quantified*
   holdout gain applies to the core. Residual QB core bias (+27 after v2) is a core-only artifact —
   the core has no depth chart, so it treats every QB with history as a starter; production
   `model.ts` does not.
2. **Rookie modeling is draft-capital only (Phase 3).** Drafted skill rookies (WR/RB/TE) now get a
   held-out-validated opportunity prior from `log(1+pick)` + round. It does **not** use college
   production (proven to add no incremental signal), college target data (unreliable — `~40%`
   populated), athletic testing, or landing-spot depth beyond the team's own reconciled volume.
   Rookie QBs are unchanged. Interval coverage for rookies runs slightly narrow (P20–P80 ≈ 0.57 vs
   0.60 target, worst at TE); role uncertainty is folded into the band width, not a full mixture.
   Uncertain *veteran* role transitions still fall back to the coarse `depth_chart_order` prior —
   the role-context signal there was statistically real but operationally trivial.
3. **No historical Sleeper backtest.** Sleeper's stored past-season projections are end-of-season
   timestamped, not preseason (verified). A fair RI-vs-Sleeper-*preseason* head-to-head for past
   years is impossible and is reported as `SLEEPER PROJECTION BENCHMARK UNAVAILABLE (historical)` —
   not faked.
4. **DEF / K** pass through league scoring correctly (tier/bucket expansion) but their football
   projections are shallow (recent-average based, no matchup/environment model).
5. **Component reconciliation vs consensus.** The v2 model is now level-calibrated against *actual
   outcomes*; against Sleeper's (hotter-than-reality) preseason numbers it still reads lower on
   skill positions. That gap is now understood — Sleeper preseason totals sum above realized
   production — and RI is deliberately not trained toward it.
