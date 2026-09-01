# `lib/draft` — snake-draft recommendation engine (`ri-snake-decision-2026.1`)

Phase 4. Answers **"who should this manager draft NOW, given what we lose by
waiting?"** — not "who has the highest projection" and not "who fits a need".

`SNAKE_ONLY` for 2026: auction drafts are out of scope. An auction draft that
reaches the engine returns `UNSUPPORTED_MODE` / `auction_engine_status:
UNSUPPORTED_2026` — never snake logic on an auction.

## It consumes frozen projections — it never builds one

| Layer | Source | Role here |
| --- | --- | --- |
| 1 — football | `ri-structural-2026.3` (`lib/projections`) | read-only input |
| 2 — league scoring + VOR + tiers | `buildLeagueProjections` | read-only input |
| decision | **this module** | `recommendation_version` is independent of `projection_version` |

`test/draft-recommendation.test.ts` asserts the engine never mutates a
`LeagueProjection`.

## Files

| File | Responsibility |
| --- | --- |
| `schema.ts` | output contract + `RECOMMENDATION_MODEL_VERSION` + readiness / hard-vs-soft gate types |
| `geometry.ts` | snake pick math (wraps `lib/bridge/geometry`), turn state, `is_consecutive_turn`, next-turn pick pair |
| `replacement.ts` | league-derived replacement levels; **FLEX slots attributed by marginal-player value**, not split evenly |
| `tiers.ts` | gap-relative tiers (`TIER_MODEL_VERSION`), quantified cliffs, `tier_drop` per player |
| `scarcity.ts` | scarcity from the *remaining-value curve slope* × imminent demand — not "few left" |
| `market.ts` | Phase 5 — market consensus (`ri-snake-market-2026.1`): robust weighted-median ADP, dispersion, freshness, confidence tiers, from the vendored `data/market-adp-2026.ts` |
| `survival.ts` | Phase 5 — calibrated snake-survival model (`ri-snake-survival-2026.1`): S2 normal-distribution `P(D > k)` + conditional `P(D > k \| D > c)`, `P(tier survives)`, confidence, degraded fallback |
| `runs.ts` | positional-run detection; `run_signal` (what happened) vs `run_effect` (survival only — never player value) |
| `need.ts` | roster need as a **utility adjustment**, not a hard filter; positional advantage |
| `trajectory.ts` | `StarterCompletionRisk` / flex risk / concentration / bench balance; risk delta from a pick |
| `kdst.ts` | **hard** K/DST timing gate — released only in the last 3 rounds or once the core lineup is complete |
| `lookahead.ts` | one-turn expected-value: `E[best available at next pick]` → `WaitProjectionLoss` / `WaitVORLoss`, urgency |
| `utility.ts` | the utility function; every term in league-point units; weights **selected by simulation** |
| `reason.ts` | evidence-backed reason strings + machine-readable `reason_codes` from the real component values |
| `pairs.ts` | §21A snake turn-pair optimisation — `PairUtility(i,j)` incl. `PairWaitLoss` for deferred positions; canonical `Pair(A,B)==Pair(B,A)` |
| `engine.ts` | the pure orchestrator: candidates → ranked → recommendations + turn pair |
| `service.ts` | live-input assembly + `SNAKE_ONLY` gate; HTTP glue for the route |

Route: `GET /api/leagues/:slug/managers/:slug/recommendations`.
The legacy `.../draft` endpoint keeps its lightweight **best-available candidate
list** (now labelled `result_kind: needs_filtered_best_available_candidates`),
which is a different thing from a recommendation (Phase 4 §3).

## Utility function

```
recommendation_score =                       (all terms in this league's points)
    1.00·VOR
  + 0.60·TierDrop                 points to the first player of the next tier
  + 0.30·ScarcityValue           scarcity_index × remaining value-curve slope
  + 0.85·RosterNeed              needWeight(pos) × VOR  (negative when redundant)
  + 0.45·PositionalAdvantage     points beyond the expected later alternative
  + 0.60·Urgency                 (1−P(survive))·(points − E[alt later])·confidence
  − 0.80·ReachCost               picks ahead of market × board pts/pick × P(survive)
  − 0.40·UncertaintyPenalty      (median − floor) × floorWeight(progress, risk)
  − 0.70·ConstructionRisk        max(0, Δ starter-completion-risk) × 60
```

Weights are **not hand-picked** (§16). `scripts/phase4-harness.ts` sweeps a grid
of interpretable weight vectors over a self-play decision-quality proxy
(`phase4_weight_search.csv`). Finding: **VOR + roster-need dominate roster
quality; heavy timing weights reduce it**. The chosen vector keeps *light*
timing — statistically indistinguishable from pure VOR+need on roster VOR, but
retains the snake-timing tie-breaker, the reach classification, and the
evidence. Tier/scarcity **without** need underperforms (B4 in `phase4_ablation.csv`).

## Hard vs soft (§22)

- **Hard** (`recommendation_score = −∞`, never surfaced as a pick): already
  drafted, invalid player, unsupported/undraftable position, **K/DST before the
  release round**, roster-rule impossibility.
- **Soft** (changes score + `warnings`, never vetoes): low confidence, market
  divergence, mild/severe reach, roster redundancy, survival uncertainty, thin
  candidate set. RI-vs-market disagreement is **flagged, not vetoed** (§19).

## Determinism & performance

Pure functions, no RNG. Same draft state + projection version + market snapshot
+ scoring + roster ⇒ identical output. Mean latency ~3 ms over a warm projection
cache (`phase4_latency.csv`) — trivially inside a 120 s pick timer.

## Market / survival (Phase 5 — `ri-snake-survival-2026.1`)

Survival is now a **calibrated ADP-distribution model**, not the search-rank
proxy.

**Market consensus** (`market.ts`, `ri-snake-market-2026.1`): a robust
weighted-median of Underdog ADP + Yahoo ADP + a published ADP consensus (all
Half-PPR / 12-team, vendored in `data/market-adp-2026.ts`), with Sleeper
`search_rank` as a low-weight proxy. NO auction dollar values. Per player:
`expected_pick`, `dispersion` (MAD of the direct feeds), `pick_range`,
`confidence` (HIGH / MEDIUM / LOW / NONE), `freshness`, `market_trend`.

**Survival** (`survival.ts`): `D_i ~ Normal(mu_i, sigma_i)` with
`sigma_i = clamp(3.0 + 0.186·expected_pick + 0.90·dispersion, 3, 22)` (fit on the
completed Devoted-2026 12-team snake draft). `P(survive to k) = Φ((mu−k)/σ)`,
**conditioned on current availability**: `P(D>k | D>c) = [1−Φ((k−mu)/σ)] /
[1−Φ((c−mu)/σ)]` — so a player still on the board past his ADP is correctly
re-based upward.

Held-out (leave-one-draft-slot-out) Brier **0.115 vs 0.185** for the search-rank
proxy — a 37% reduction; well calibrated across all horizons 1–23 and all
probability bins (`analysis/phase5_market_survival.R`, `outputs/.../phase5_*`).

**Degraded mode**: a player with no ADP falls back to a wide search-rank logistic
at `confidence: LOW`. The engine behaves at every confidence level.

**Still deferred**: only ONE completed snake draft was available to calibrate
against (Bloodline is a brand-new league). Manager-specific and fitted
positional-run effects were tested and **not promoted** (n = 1 prior draft).

## Reproduce

```bash
npx tsx scripts/phase4-harness.ts                 # Phase 4: scenarios, ablation, weights, monotonicity
Rscript analysis/phase4_snake_recommendation_engine.R

npx tsx scripts/build-market-consensus.ts         # Phase 5: vendor the ADP snapshot
npx tsx scripts/phase5-export-drafts.ts           # Phase 5: export calibration drafts
Rscript analysis/phase5_market_survival.R         # Phase 5: calibration + plots
npx tsx scripts/phase5-live-check.ts              # Phase 5: live Bloodline + P4↔P5 comparison + latency

node --test --import tsx test/draft-recommendation.test.ts test/draft-market-survival.test.ts
```
