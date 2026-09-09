# Competitive Trade Intelligence Upgrade

Status: **CHECKPOINT A — AUDIT + CONTRACTS. No behavioral changes yet.**

Branch: `competitive-trade-intelligence` (off `main` @ `5518ecc`, via
`waiver-readiness-contract-fix` which is byte-identical to `main` at this point —
`f420b4a` + a docs-only commit).

---

## Part I — Pre-implementation audit

### 0. Git / concurrency state at start

| | |
|---|---|
| Starting branch | `waiver-readiness-contract-fix` |
| Starting HEAD | `5518ecc82914b983a6b98bd5a3dd1c4a259c9f78` |
| Working tree | clean |
| Feature branch created | `competitive-trade-intelligence` @ `5518ecc` |
| Concurrency incidents | none observed during the audit |

`5518ecc` is `docs: waiver / free-agent readiness contract` on top of `f420b4a`
(phase 9 merge record). The trade-engine source under `lib/trades/**` is
untouched since `bde9bce..d635d0d` (the Phase 1–6 merge, 2026-09-05) plus the
Phase 4/5 discovery+negotiation additions at `242b77e`-era. Twelve
`trade-engine-phase*` branches exist locally and on `origin` — all historical,
none active.

### 1. Where the current trade system lives

| Concern | File(s) |
|---|---|
| Proposal / result schema | `lib/trades/schema.ts` |
| Canonical evaluator (the one source of trade value) | `lib/trades/evaluate.ts` |
| Roster reconstruction before/after | `lib/trades/reconstruct.ts` |
| Snapshot-consistent analysis context (1 provider read) | `lib/trades/context.ts` |
| Thresholds / weights / acceptance bands | `lib/trades/config.ts` |
| Phase 2 contextual valuation (ROS / depth / fragility) | `lib/trades/ros.ts`, `lib/trades/depth.ts` |
| Phase 3 calibration + player intel (SHADOW, weights 0) | `lib/trades/phase3.ts`, `lib/trades/calibration.ts`, `lib/trades/confidence.ts`, `lib/trades/intelligence.ts` |
| Data readiness / calibration gate | `lib/trades/data-readiness.ts`, `lib/trades/activation.ts` |
| Historical trade ingestion (real Sleeper trades) | `lib/trades/historical*.ts`, `lib/trades/r-data-providers.ts`, `scripts/ingest-sleeper-historical-trades.ts` |
| Discovery orchestrator | `lib/trades/discovery/discover.ts` |
| Partner-fit matrix | `lib/trades/discovery/fit.ts` |
| Roster search profiles (needs / surplus / premium / expendable) | `lib/trades/discovery/profiles.ts` |
| Bilateral funnel / package generation / 3-team | `lib/trades/discovery/bilateral.ts`, `packages.ts`, `three-team.ts` |
| Candidate evaluation (calls `evaluateTrade` per candidate) | `lib/trades/discovery/candidate-eval.ts` |
| Discovery ranking + rationale | `lib/trades/discovery/rank.ts` |
| Counteroffers | `lib/trades/discovery/counteroffer.ts` |
| Negotiation engine (ladder / leverage / dependency / walk-away / sweeteners) | `lib/trades/negotiation/*` |
| Pareto frontier + offer-tier selection | `lib/trades/negotiation/pareto.ts`, `offer-ladder.ts` |
| Strategy layer (season stage / standings / playoff odds / archetype / urgency) | `lib/trades/strategy/*` |
| API routes | `app/api/trades/analyze/route.ts`, `discover/route.ts`, `negotiate/route.ts` |
| Orchestrator consumption | `lib/orchestrator/candidates.ts` (`tradeExplorationCandidates`), `gates.ts`, `build.ts` |
| Tests | `test/trade-engine*.test.ts` (13 files), `test/fixtures/trades.ts` |
| Market infra (NOT wired into trades today) | `lib/projections/sleeper.ts` (Sleeper benchmark), `lib/projections/compare.ts` (RI‑vs‑Sleeper disagreement), `lib/draft/market.ts` + `lib/draft/data/market-adp-2026.ts` (preseason ADP consensus) |
| Draft capital source | `CanonicalDraftPick` (`lib/canonical/schema.ts`, `draft_slot` per player); `draft_availability` capability |
| Transaction history | `snapshot.recent_transactions`; `transactions` capability (DEGRADED-aware) |

### 2–14. Findings

**1. What does the current trade engine optimize?**
Per-participant **marginal roster utility in weekly projected fantasy points**:
`roster_utility_delta = 1.0·Δoptimal_starter_points + 0.0·Δstarter_VOR +
0.25·Δbench_VOR + 1.0·Δpositional_need_pressure` (`evaluate.ts:206`,
`config.ts:152`). Every value is our **private RI model** re-run on the
reconstructed before/after roster (`buildOptimalLineup`, `weeklyVOR`,
`computePositionalNeeds`). There is no standalone "player value" and **no
outside-market axis anywhere in `lib/trades/`**.

**2. Where is "mutual benefit" encoded?** Four places:
- `classifyViability` (`evaluate.ts:551`): any participant below
  `reluctant_floor` (−2.0) ⇒ `NON_VIABLE`; `HIGH` requires **every**
  participant ≥ `+0.5`.
- `buildDiscoveryResult` (`rank.ts:72-78`): a candidate is dropped unless
  **every** other participant clears `partnerAcceptanceFloor(mode)` and
  `minimum_partner_utility_delta`.
- `TradeSummary.all_teams_improve` / `rationality.every_participant_rational` /
  `fairness.imbalance_index` — headline framing that rewards symmetric gain.
- Partner-fit `surplus_complementarity` (`fit.ts:33-41`) explicitly scores "my
  surplus fills partner's need" as a **positive**, i.e. helping them is a search
  objective.
- Negotiation Pareto dominance (`pareto.ts:20-27`) keeps `partner_utility` as a
  co-equal maximization axis.

**3. How is partner fit calculated?** `computePartnerFit` (`fit.ts:14`):
`need_complementarity` (partner surplus ↔ my need) + `surplus_complementarity`
(my surplus ↔ partner need), each weighted by need severity. Cheap heuristic,
Stage‑1 prioritization only; never enters final value.

**4. How is player value represented?** As a **delta**, never a level:
`AssetValue` (`discovery/types.ts:73`) carries `starter_vor`,
`projected_points`, `is_current_starter` — all current-week RI. No market rank,
no ROS rank, no cross-manager perception.

**5. Private vs outside-market valuation — distinguished?** **No.** Only private
value exists in the trade path. `lib/projections/compare.ts` computes RI‑vs‑Sleeper
disagreement per player but is consumed only by the **draft** engine's
confidence layer, never by trades.

**6. What market sources already exist in the repo?**
- `lib/projections/sleeper.ts` — Sleeper season + weekly projections
  (RotoWire upstream), normalized, with `ProviderStatus`
  (`OK|DEGRADED_SCHEMA|STALE|UNAVAILABLE`) and `last_modified` staleness. This
  is the usable in-season market benchmark.
- `lib/projections/compare.ts` — `comparePlayer` / `aggregateDisagreement` /
  `foldDisagreementIntoConfidence`: direction (`RI_ABOVE|RI_BELOW|AGREES`),
  normalized disagreement magnitude, `primary_driver`.
- `lib/draft/market.ts` + `market-adp-2026.ts` — preseason **ADP consensus**
  (Underdog + Yahoo + published consensus + Sleeper `search_rank`), Half‑PPR /
  12‑team, with `confidence`, `dispersion`, `freshness`, `market_trend`,
  `pick_range`. Draft-scoped; a fixed 2026 vendored snapshot, not in-season.
- `snapshot.draft_picks` (`draft_slot`) — league draft capital.
- No FantasyPros / ESPN / DraftSharks ROS-ranking pipeline exists.

**7. Manager-specific perceived-value model — exists?** **No.** Nothing models
how a specific manager values a player. The strategy layer models *our own*
season urgency/archetype only.

**8. Acceptance probability modeled?** Only as `classifyAcceptance(delta)`
(`config.ts:273`) — a 6-band classifier **on our private `roster_utility_delta`
for that participant**. It is explicitly labelled "not human psychology"
(`config.ts:53`). No perceived-value input, no probability, no owner tendencies.
`lib/trades/negotiation/behavior.ts` has a `ManagerBehaviorEvidence` /
`BehavioralConfidence` scaffold but it is `INSUFFICIENT`-gated and evidence-free
today.

**9. Opponent improvement penalized anywhere?** **No.** It is treated as neutral
(a floor constraint) or positive (partner fit). There is no competitive-cost term.

**10. Multi-step trade paths?** Partially: `three-team.ts` does **simultaneous**
3-team cycles. There is **no sequential A→B→C path planning** and no
acquire-then-reassess concept.

**11. Future liquidity / appreciation understood?** **No.** No liquidity score,
no appreciation model, no BUY_AND_HOLD strategy. Redraft league ⇒ no future
draft picks as assets (`strategy/archetype.ts` explicitly refuses to fabricate
"future value" framing).

**12. Reusable unchanged:**
- `evaluateTrade` + `reconstructRosters` + `buildTradeAnalysisContext` (the
  1-read snapshot spine) — **the private-value engine, reused verbatim**.
- The whole bilateral funnel (`bilateral.ts`, `packages.ts`, `candidate-eval.ts`)
  as the **candidate generator**.
- `computePartnerFit` / `rankPartners` — kept, **role redefined** (acceptance &
  cost input, not objective).
- Negotiation primitives: `leverage.ts`, `dependency.ts`, `walk-away.ts`,
  `concessions.ts`, `pareto.ts` frontier math.
- `strategy/standings.ts`, `strategy/profile.ts` (playoff odds, archetype) —
  reused to derive the **opponent threat weight**.
- `data-readiness.ts` pattern + `assessFreeAgentPoolReadiness` — the model for
  the new readiness contract.

**13. Needs additive extension:**
- `discovery/rank.ts` — ranking must gain the competitive objective (additively,
  behind a flag / new mode).
- `negotiation/pareto.ts` / `offer-ladder.ts` — tier selection must be able to
  target *our* extraction, not requester/partner symmetry.
- `evaluate.ts` output — gains an optional `competitive` block (like `phase2` /
  `phase3` today: purely additive, byte-identical when the new context is absent).

**14. Readiness / capability gates that exist for trade recommendations:**
- `calibration_status` in every discovery response (real-trade count vs a
  50-trade floor; `review_available` false today).
- `SIGNAL_READINESS` table (`data-readiness.ts`): `role_adjustment` /
  `schedule_adjustment` = `SHADOW_ONLY` / `INSUFFICIENT_DATA`.
- `TRADE_ANALYSIS_DEGRADED` / `PROJECTIONS_PARTIAL` / `ROS_PROJECTIONS_UNAVAILABLE`
  diagnostics — never substitute an optimistic default.
- `CONTEXT_UNAVAILABLE` / `UNKNOWN_MANAGER` / `TARGET_NOT_ROSTERED` — fail-closed
  discovery states.
- Phase 3 weights are server-only (`sanitizePublicTradeConfig` drops any client
  `phase3`).

### Concise answers to the prompt's 14 audit questions

The engine optimizes **our own** marginal roster points already (`rank.ts`
scores by `my_gain`), so the codebase is *closer* to the competitive framing
than the prompt assumes — but "mutual benefit" is still hard-wired as a
**filter** (`classifyViability`, `partnerAcceptanceFloor`) and as **framing**,
opponent gain is never a **cost**, and there is **no market / perceived-value /
liquidity / appreciation axis at all**. That is the gap this phase fills.

---

## Part II — Proposed additive architecture

Everything below is **new files under `lib/trades/competitive/`** plus **optional
additive blocks** on existing outputs. `evaluateTrade`'s Phase 1/2/3 output is
byte-identical when the competitive context is not supplied — same contract the
`phase2` / `phase3` layers already honour.

```
lib/trades/competitive/
  schema.ts            # all new types (MarketEdge, OwnerPerceivedValue, …)
  config.ts            # all new weights/thresholds (COMPETITIVE_TRADE_CONFIG)
  readiness.ts         # assessCompetitiveTradeReadiness() — capability contract
  market/
    snapshot.ts        # normalized market snapshot (adapter over sleeper.ts + compare.ts + market.ts)
    normalize.ts       # value ↔ positional-rank ↔ z-score normalization
  private-value.ts     # normalized private-value signal (adapter over evaluateTrade internals — model-agnostic)
  market-edge.ts       # STRONG_BUY..STRONG_SELL classifier + confidence gate
  sell-board.ts        # our roster → CORE_HOLD..STRONG_MARKET_SELL
  buy-board.ts         # other rosters → target board
  owner-perception.ts  # OwnerPerceivedValue per (player, manager)
  acceptance.ts        # heuristic acceptance_estimate (labelled, NOT calibrated)
  extraction.ts        # perceived_surplus + extraction_capacity + curve
  opponent-cost.ts     # opponent roster delta × threat weight → competitive_cost
  threat.ts            # rival threat weight (adapter over strategy/standings.ts)
  optimizer.ts         # competitive objective + lexicographic/decomposed ranking
  negotiation.ts       # opening/target/acceptable/walk-away from real valuations
  copy.ts              # internal vs external rationale separation
  graph.ts             # bounded 1-hop/2-hop path search + BUY_AND_HOLD
  index.ts             # buildCompetitiveTradeContext() + top-level entry points
```

### A. The value types (prompt §3)

| Type | Source | Confidence |
|---|---|---|
| `PrivateValue` | `evaluateTrade` marginal utility + `weeklyVOR` level + ROS proration | from projections `status` + RI model version |
| `MarketValue` | `lib/projections/sleeper.ts` weekly+season → positional rank; lineage `{source:"sleeper", source_type:"projection_benchmark", as_of, scoring_format, coverage}` | falls when Sleeper `STALE`/`DEGRADED`, or coverage low |
| `OwnerPerceivedValue` | draft_slot anchor + is_starter-for-them + their depth at pos + their need + recent usage; **confidence band, never certainty** | `HIGH..VERY_LOW` from signal count |
| `AcquisitionCost` | inferred from the negotiation search (what packages clear their floor) | — |
| `LiquidityValue` | # of managers needing the position × market reputation × roster-slot breadth | — |
| `AppreciationPotential` | `private_rank − market_rank` + RI confidence + catalyst/invalidation reason codes; **direction + confidence, never a forecast ADP** | RI confidence + disagreement magnitude |

`MarketValue` is `UNAVAILABLE` (not `0`) when Sleeper has no line for a player.
`UNAVAILABLE !== 0` is an invariant (prompt §26).

### B. `MarketEdge` (prompt §4)

```ts
type MarketEdgeDirection =
  | "STRONG_BUY" | "BUY" | "FAIR" | "SELL" | "STRONG_SELL" | "INSUFFICIENT_DATA";

interface MarketEdge {
  canonical_player_id: string;
  private_value: NormalizedValue;   // z-score within position
  market_value: NormalizedValue | null;
  direction: MarketEdgeDirection;
  edge_score: number | null;        // null when INSUFFICIENT_DATA
  confidence: "HIGH" | "MEDIUM" | "LOW" | "VERY_LOW";
  reasons: string[];                // reason codes
  lineage: MarketLineage;
}
```

Direction is **never** from raw rank gap: `edge_score` folds normalized gap ×
positional scarcity × projection-disagreement magnitude × RI model reliability,
then a **confidence gate** (prompt §20) caps the achievable direction —
`VERY_LOW` confidence can reach at most `BUY`/`SELL`, never `STRONG_*`, and
cannot drive an aggressive acquisition without corroboration.

### C. Competitive objective (prompt §11)

Not one magic sum. Six **normalized, interpretable** sub-scores kept in source
units (mirrors the Orchestrator's dimension design):

```
our_private_gain          (weekly pts, from evaluateTrade — authoritative)
acquired_market_edge       (Σ buy-side MarketEdge on incoming − Σ sell-side on outgoing)
appreciation_value         (horizon-graded, confidence-discounted)
liquidity_delta
extracted_value            (perceived surplus captured)
──────────────────────────
competitive_cost           (opponent_roster_delta × threat_weight)   [SUBTRACTED]
acquisition_cost
transaction_friction       (per extra hop / asset / rejection risk)
uncertainty_penalty        (low-confidence market or perceived value)
```

subject to `acceptance_estimate >= config.min_acceptance_band`.

Ranking is **lexicographic + decomposed** (like `orchestrator/policy.ts`), not a
scalar: hard gates → our_private_gain + acquired_edge → competitive_cost → cost →
friction. Every recommendation ships its full decomposition (prompt §22, §27).
**Raw specialist scores are never cross-compared** — private stays in pts,
market stays in ranks.

### D. Acceptance model (prompt §12)

`loadRealHistoricalTradeRecords()` returns **1** real trade — far below any
calibration floor. Therefore acceptance ships as an explicitly **heuristic**
`acceptance_estimate: "VERY_LOW" | "LOW" | "MODERATE" | "HIGH"` (a *band*, never
a probability), computed from **their perceived-value ledger** (not our private
one): perceived balance, biggest-need-addressed, target-is-their-starter, their
depth behind target, draft anchor, our outgoing market reputation, asset count.
The `SIGNAL_READINESS` table gains an `acceptance_model: HEURISTIC_ONLY` row.

### E. Readiness contract (prompt §21)

`assessCompetitiveTradeReadiness(snapshot, ctx)` → per-capability
`READY | PARTIAL | UNAVAILABLE` for: roster ownership known, manager identity
known, target belongs to named manager, `transactions` capability (for anchors),
market snapshot available + fresh, private projection available, strategy
context available. **Any required capability `UNAVAILABLE` ⇒ that recommendation
fails closed** (no fabricated acquisition cost or acceptance). Partial ⇒
analytical output still returned, explicitly flagged.

### F. New output contract

`CompetitiveTradeRecommendation` — exactly the shape in prompt §27
(`private_value`/`market_value`/`owner_perceived_value` ledgers,
`market_edges`, `our_roster_delta`/`opponent_roster_delta`/`competitive_cost`,
`acceptance_estimate`, `extraction_capacity`, `liquidity_delta`,
`appreciation_potential`, `strategy` enum, `negotiation` {opening, target,
acceptable, walk_away}, `confidence`, `readiness`, `reason_codes`,
`explanation` {internal, external}, `lineage`).

Six separate rankings (prompt §28): immediate improvement, market arbitrage,
sell-high, value-extraction, buy-and-hold, multi-hop.

### G. Reason codes (prompt §32)

`MARKET_DATA_UNAVAILABLE`, `PRIVATE_VALUE_LOW_CONFIDENCE`,
`ACQUISITION_COST_TOO_HIGH`, `ACCEPTANCE_TOO_LOW`, `COMPETITIVE_COST_TOO_HIGH`,
`NO_MEANINGFUL_ARBITRAGE`, `OVERPAY_DESTROYS_EDGE`, `DIRECT_PATH_SUPERIOR`,
`OWNER_DEPTH_TOO_THIN`, `INSUFFICIENT_EXTRACTION_ROOM`, `BUY_AND_HOLD_PREFERRED`,
`SHADOW_ONLY_MARKET_SIGNAL`.

### Integration points (Checkpoint G)

- New API route `app/api/trades/competitive/route.ts` (read-only) OR an
  additive `?competitive=1` block on `discover`. New `SearchMode`s:
  `MARKET_ARBITRAGE`, `SELL_HIGH`, `BUY_AND_HOLD`.
- Orchestrator: `tradeExplorationCandidates` may cite a competitive edge as
  **evidence** for a TRADE_EXPLORATION path — never a new ACTION class,
  never influencing a production recommendation (same bar Phases 4/5 shadow
  cleared).

---

## Part III — Test plan (Checkpoints B–F)

Deterministic synthetic tests A–O and monotonicity invariants from prompt §25–26,
in `test/competitive-trade-*.test.ts`, using synthetic fixtures (no live ranks).
Plus full regression: all `test/trade-engine*.test.ts`, weekly/intelligence,
orchestrator, discovery, `tsc`, `eslint`.

Live Bloodline Bowl smoke (read-only) answering prompt §24's 10 diagnostic
questions — reported, never asserted.

---

---

# Part IV — Checkpoint B: the Market Edge Layer

Status: **CHECKPOINT B CERTIFIED — READY FOR CHECKPOINT C.**
Branch `competitive-trade-intelligence`, built on `145849d`.

## B.1 The discovery boundary

The legacy funnel ran two conceptually distinct stages back-to-back:

| Stage | What it decides | Code |
|---|---|---|
| **A. Structural** | real managers? real ownership? structurally legal? legal roster states? private roster economics computable? | `evaluateCandidate` (`lib/trades/discovery/candidate-eval.ts`) — **unchanged** |
| **B. Legacy mutual-benefit viability** | does *every* participant clear the partner acceptance floor / fairness imbalance? | `buildDiscoveryResult` (`rank.ts`) + `classifyViability` (`evaluate.ts`) — **unchanged** |

Finding: stage A was already isolated in `evaluateCandidate`; the mutual-benefit
gate was already isolated in `buildDiscoveryResult`. So the "refactor" is
minimal and non-destructive:

- `lib/trades/discovery/bilateral.ts` — `allAssetsFor` gets an `export` keyword
  (no behavior change) so the competitive generator reuses the **exact** legacy
  asset pool.
- `lib/trades/discovery/rank.ts` — doc comment only, marking `buildDiscoveryResult`
  as the **legacy-path-only** mutual-benefit gate.
- `lib/trades/competitive/candidates.ts` (new) — `generateStructuralTradeCandidates`
  reuses `buildTradeSearchProfile` + `allAssetsFor` + `generateBilateralPackages`
  + `evaluateCandidate` and stops **before** stage B. It returns every
  structurally-valid, privately-evaluated candidate with **no** acceptance /
  fairness / opponent-gain filter. `legacyMutualBenefitWouldKeep` is a pure
  predicate mirroring stage B, used by the regression.

Regression `B11` (`test/competitive-trade-boundary.test.ts`): a synthetic
`alpha_scrub_wr ↔ bravo_rb_stud` swap — alpha +≈9, bravo −≈9 — is **retained**
by `generateStructuralTradeCandidates` and **rejected** by
`legacyMutualBenefitWouldKeep(…, "BEST_AVAILABLE")`. `B11b` asserts at least one
retained candidate has a **negative** opponent delta. Legacy determinism is
checked in `B10`; the full 13-file `trade-engine*` suite passes with zero
expectation changes.

## B.2 Private value (normalized)

`lib/trades/competitive/private-value.ts` — model-agnostic: reads only the
normalized weekly-projection surface (`projected_points`, `ros`) the trade
context already produces.

- **Preferred basis `ri_ros_weekly_vor`**: RI's own season projection
  (`ros.ri_season_points`) ÷ 17 → a weekly rate → `weeklyVOR` against the league
  replacement frontier. Rest-of-season-oriented (matches the market side) and
  more dispersed than a single noisy current week. RI's absolute season *level*
  has a documented calibration caveat, but **within-position z-scoring removes
  both location and scale** — only ordinal spacing must be right, which is RI's
  asserted strength. (The first live smoke, on current-week VOR, produced a
  systematic QB `STRONG_SELL` artefact from week-1 projection compression; the
  ROS basis fixes it.)
- **Fallback `weekly_vor`**: current-week `projected_points` → VOR, when a player
  has no RI season projection.
- Confidence: `ros.ri_confidence` when present, else inferred from projection
  availability — never optimistic on missing data.
- `private_position_rank` is kept for explanation only, never the math input.

## B.3 Market value (normalized) + lineage

`lib/trades/competitive/market/snapshot.ts` — a **normalized trade-market
abstraction** over sources that already exist. **No network call.**

| `source_type` | Source | Role at Checkpoint B |
|---|---|---|
| `provider_benchmark` | Sleeper/RotoWire ROS projection via `RosSignal` (already in league scoring) | **PRIMARY** normalized value: `ros.points ÷ remaining_weeks` → weekly VOR |
| `draft_market` | `buildMarketConsensus()` — preseason ADP consensus (`lib/draft/market.ts`) | implied positional rank → cross-source **dispersion** only; STALE in-season; never blended into the primary value |
| `league_draft_value` | `snapshot.draft_picks` — the overall pick a player actually cost in *this* league | distinct lineage-bearing signal; implied rank → dispersion |
| `owner_draft_anchor` | `snapshot.draft_picks` — *which* manager drafted them, and where | lineage only; consumed by Checkpoint C |

Every `MarketSourceRecord` carries `source`, `source_type`, `as_of`,
`scoring_format`, `readiness` (`CURRENT|PARTIAL|STALE|UNAVAILABLE`), `raw_value`,
`raw_unit`, `implied_position_rank`, `notes`. `MarketLineage` adds
`usable_source_count`, `dispersion` (MAD of implied ranks), `worst_readiness`,
`scoring_normalization`.

- ADP consensus is Half-PPR/12-team. When the league is not Half-PPR the
  mismatch is **recorded on the source note and the source is used for rank
  only** — never silently treated as exact league value (`B9`).
- Missing provider benchmark ⇒ `primary_basis: "unavailable"`, `primary_raw:
  null`, `readiness: "UNAVAILABLE"` — **never 0** (`B7`).

## B.4 Normalization methodology

`lib/trades/competitive/normalize.ts` — pure. Within each position group:

```
normalized_value = (raw − positionMean) / positionStdDev      (z-score)
percentile       = fraction of the position group ≤ raw
position_rank    = 1-based rank (best = 1)                     EXPLANATION ONLY
```

VOR is the basis (not raw points) so the zero point is the league replacement
frontier and is identical for both sides. The z-score then makes the two sides
comparable as "how many position standard deviations apart", with **no
ensembling of incompatible absolute scales**. Because it is a z-score, equal
positional-rank gaps at different points of the position curve produce
**different** edges (`B5`).

## B.5 The classifier + confidence gate

`lib/trades/competitive/market-edge.ts`:

```
edge_score      = (private_z − market_z) × position_scarcity_weight
actionable_edge = edge_score × confidence_actionability[confidence]     ← rank key
```

`direction` from `|edge_score|` vs `fair_band` (0.35) / `directional_band` (0.6)
/ `strong_band` (1.2), sign ⇒ BUY vs SELL, then a **confidence ceiling**:
`VERY_LOW`/`LOW` can reach at most `BUY`/`SELL` and are labelled
`SPECULATIVE_LOW_CONFIDENCE`; a raw STRONG magnitude that is capped emits
`CONFIDENCE_GATE_APPLIED`.

Confidence = worst of {private confidence, market confidence} where market
confidence is itself capped by `readiness_confidence_ceiling[readiness]`
(`STALE ⇒ LOW`), then: −1 band on high cross-source dispersion or thin position
coverage; +1 band (max HIGH) when an **independent** RI↔Sleeper stat-level
disagreement (`ros.disagreement_pct`) points the same way as the edge
(`RI_SLEEPER_DISAGREEMENT_CORROBORATES`).

`market_value` is `null` (⇒ `INSUFFICIENT_DATA`, `edge_score: null`) whenever
either side is missing. `UNAVAILABLE !== 0` throughout.

### STRONG_BUY / BUY / FAIR / SELL / STRONG_SELL semantics

| direction | meaning |
|---|---|
| `STRONG_BUY` / `BUY` | our model values the player materially **above** outside-market pricing — a candidate market bargain |
| `FAIR` | our valuation and the market's are within `fair_band` |
| `SELL` / `STRONG_SELL` | outside-market prices the player materially **above** our valuation — potential trade **leverage if we own him** |
| `INSUFFICIENT_DATA` | private or market value missing — no number invented |

**`SELL` ≠ drop. `BUY` ≠ "trade for him now".** A `SELL` says market > private
enough to create leverage; it does not say the player is bad, that we must move
him, or that a specific return exists. A `BUY` says we think the market
undervalues him; it does **not** say the owner will sell or name an acquisition
price. Every edge carries `analytical_only: true`.

## B.6 Why market edge is ANALYTICAL, not actionable (the fundamental distinction)

> Market edge tells us **where our beliefs differ from market pricing**.
> It does **not** tell us **what the specific owner will accept**.

Checkpoint B has no owner-perceived-value model, no acquisition-cost inference,
no acceptance estimate, no opponent competitive cost, no liquidity, no
appreciation, no negotiation. `evaluateCompetitiveTrade`'s `competitive` block
contains only `readiness`, `assets`, `market_edge` and `notes` — the later-checkpoint
keys are **absent from the type**, not stubbed (`B12`). This is the trade
analogue of the waiver-readiness lesson: *desirable asset ≠ actionable trade
target*. Nothing here may flow into a finalized trade recommendation.

## B.7 Readiness contract

`lib/trades/competitive/readiness.ts` — `assessCompetitiveTradeReadiness` fails
closed. Required capabilities: `private_projection`, `market_data`,
`player_identity`, `ownership`. Any one `UNAVAILABLE` ⇒ `overall: UNAVAILABLE`
and no fabricated market value / edge (`B` "readiness fails closed" test).
`PARTIAL` ⇒ edges only where both sides exist; gaps `INSUFFICIENT_DATA`.

## B.8 API contract (settled; wired in Checkpoint G)

Dedicated route, matching the existing trade API's POST-body convention
(`/api/trades/analyze|discover|negotiate`):

```
POST /api/trades/competitive
  { "league": "<registry-slug>", "manager": "<slug-or-id>",
    "mode": "MARKET_EDGE" | "SELL_BOARD" | "BUY_BOARD",
    "player_ids"?: string[] }
```

Not `?competitive=1` on `discover` — the semantics and readiness differ
materially. `/api/ai` is **not** updated until the route exists (Checkpoint G).

## B.9 Config

`lib/trades/competitive/config.ts` — all bands/weights/ceilings, deep-frozen,
`resolveCompetitiveTradeConfig(override)` with band-order assertion. No magic
numbers in the layer logic.

## B.10 Bloodline Bowl diagnostic (read-only, `scripts/competitive-trade-smoke.ts`)

`bloodline-bowl`, season 2026 week 1, `PROJECTIONS_PARTIAL`, Half-PPR, 12 teams,
3304-player universe. Readiness `PARTIAL` (private + market both PARTIAL in
week 1). **Nothing reaches HIGH confidence** — correct for preseason data.

| prompt §24 question | current-data answer (diagnostic, not a target) |
|---|---|
| 1. Rhamondre a market sell / chip? | `FAIR`, edge −0.43 (market RB25 vs private RB31) — market leans above us, just under the SELL band today. Owner: supyo29. |
| 2. Rome classified appropriately? | `FAIR`, edge −0.50 (market WR27 vs private WR31) — mild market-over-private, LOW confidence. Owner: supyo29. |
| 3. Chuba a buy? | **Yes — `BUY`, edge +0.74 (private RB15 vs market RB35)**, LOW confidence. Owner: bijimac. Matches the scenario's premise. |
| 4–5. Straight Rhamondre↔Chuba leaves value unextracted? secondary asset? | Cannot answer at Checkpoint B — no extraction/perception model. Deferred to C/D by design. |
| 6. BijiMac roster context? | Ownership resolved (`ownership: READY`); Chuba + De'Von Achane (`BUY` +0.80) on that roster. Perception model deferred to C. |
| 7. Does the trade improve them per our model vs merely look attractive? | Structural stage computes the private opponent delta; "looks attractive to them" needs Checkpoint C. |
| 8. Opponent threat effect? | Not modeled at Checkpoint B (Checkpoint D). |
| 9. Opening/target/acceptable/walk-away? | Not modeled at Checkpoint B (Checkpoint E). |
| 10. Hold-for-appreciation vs flip Chuba? | Not modeled at Checkpoint B (Checkpoint F). |

Largest MEDIUM-confidence discrepancies surfaced league-wide (examples, not
recommendations): Evan Engram `STRONG_BUY` (+1.45, TE15 vs TE42), Jerry Jeudy
`BUY` (+1.14, WR20 vs WR64), Derrick Henry `STRONG_SELL` (−1.28, RB21 vs RB6),
Isaiah Likely `STRONG_SELL` (−1.79). Josh Jacobs shows an extreme `BUY` (+2.73,
RB7 vs RB48) at **LOW** confidence — an apparent Sleeper-ROS anomaly the
confidence gate correctly holds down; see limitations.

## B.11 Known limitations (Checkpoint B)

1. **Everything is MEDIUM/LOW confidence in week 1** — `PROJECTIONS_PARTIAL` +
   broad RI↔Sleeper disagreement. Correct behavior; limits actionability until
   in-season data matures.
2. **Provider-benchmark anomalies pass through** — a bad Sleeper ROS number
   (e.g. an injury-suppressed line) produces a large raw edge; only the
   confidence gate + dispersion check dampen it. A sanity clamp against the ADP
   consensus rank is a candidate follow-up.
3. **Basis mixing within a position group** — players without an RI season
   projection fall back to `weekly_vor` while the rest use `ri_ros_weekly_vor`;
   the two are both weekly-VOR but not identically scaled. Small in practice
   (fallback is rare); documented.
4. **ADP consensus is a fixed 2026 preseason snapshot** — flagged STALE
   in-season and used for dispersion only; there is no live in-season
   consensus-ranking pipeline in the repo.
5. **No owner / acquisition / acceptance / cost / liquidity / appreciation /
   negotiation** — by design; Checkpoints C–F.

## B.12 Files changed (Checkpoint B)

New:
- `lib/trades/competitive/{schema,config,normalize,private-value,market-edge,readiness,boards,candidates,evaluate,index}.ts`
- `lib/trades/competitive/market/snapshot.ts`
- `test/competitive-trade-{market-edge,market-snapshot,boundary}.test.ts`
- `scripts/competitive-trade-smoke.ts`

Modified (non-behavioral):
- `lib/trades/discovery/bilateral.ts` — `export` keyword on `allAssetsFor`
- `lib/trades/discovery/rank.ts` — doc comment on `buildDiscoveryResult`
- `docs/COMPETITIVE_TRADE_INTELLIGENCE.md` — this section

## B.13 Regression

- `tsc --noEmit`: clean.
- `eslint app lib test`: 0 errors, 29 warnings (all pre-existing, none in new files).
- `npm test`: **1676 tests, 1672 pass, 0 fail, 4 skipped** (pre-existing skips).
  25 new competitive tests. Zero existing trade / discovery / weekly /
  orchestrator / waiver expectations changed.
- Performance: full 3304-player league market-edge table builds in ~18–29 ms;
  discovery sweeps reuse one table via `precomputed`.

---

---

# Part V — Checkpoint B.5: Dynamic Market & Evidence Maturation

Status: **CHECKPOINT B.5 CERTIFIED — READY FOR CHECKPOINT C.**
Branch `competitive-trade-intelligence`, built on `0d7f5ef`.

## B5.1 ROS-normalization audit (the reason B.5 exists)

| quantity | what it actually is |
|---|---|
| `ros.points` (market, `lib/weekly/ros.ts:60`) | Sleeper/RotoWire **full-season** projection × `weeksLeftFrac = (17 − (week−1))/17`. A **linear time-proration**, not a games-played-aware remaining-season projection. |
| `ros.ri_season_points` (private, `lib/weekly/projections-ri.ts:33`) | RI's **full-season** projection (`ri-structural-2026.3`, preseason-structural). |
| Checkpoint B private basis | `ros.ri_season_points ÷ 17` → weekly VOR. |
| Checkpoint B market basis | `ros.points ÷ remaining_weeks` = `(external × weeksLeftFrac) ÷ remaining_weeks` = `external ÷ 17`. |

**Finding:** at Checkpoint B both sides are the *same* quantity — a full-season
projection expressed as a **per-game rate** (`fullSeason ÷ 17`). They are
arithmetically comparable at any week, so B's edge is not temporally distorted.
But **neither side updates for games already played** — by midseason both are
stale relative to realized performance, and if RI ever regenerates in-season
while Sleeper's stays frozen (or vice versa) the horizons silently diverge.

**Correction made:** B.5 adds an explicit `TemporalContext` and a fail-closed
horizon-comparability check (`private_horizon` / `market_horizon` ∈
`ROS_WEEKLY_RATE | FULL_SEASON | UNKNOWN`; a genuine mismatch ⇒
`INSUFFICIENT_DATA` + `PRIVATE_MARKET_HORIZON_MISMATCH`, never a fabricated
comparison). The B private basis relabels from `ri_ros_weekly_vor` semantics to
an explicit `ROS_WEEKLY_RATE` horizon.

**Realized 2026 data available live:** essentially none — `player_usage_weekly.csv`
and `player_schedule_strength_weekly.csv` are **2025 only**; 2026 has played 0
games. So the live path resolves every player to `PRESEASON_ONLY` and the
dynamic edge ≈ the Checkpoint-B edge, enriched. The R calibration backtest uses
the real 2025 data.

## B5.2 Time-aware architecture (new files under `lib/trades/competitive/`)

| file | role |
|---|---|
| `calibration.ts` | artifact contract + `DEFAULT_COMPETITIVE_MARKET_CALIBRATION` (documented default priors, `status: DEFAULT_PRIOR`); loads `lib/trades/data/competitive_market_calibration.json` |
| `temporal.ts` | `seasonMaturityWeight(g, curve)` (nonlinear, capped < 1) and `recencyWeight(age, curve)` — **two separate mechanisms**; `buildTemporalContext` |
| `evidence.ts` | 4 evidence families (ROLE / EFFICIENCY / RESULT / CONTEXT), recency-weighted; opponent-adjusted residuals; `BreakoutCredibility`; weak-schedule + touchdown-mirage detection |
| `market-state.ts` | time-indexed `MarketState`: `preseason_market_prior` / `current_public_projection` / `current_performance_signal` / `current_market_proxy` (§7), `market_trajectory`, `proxy_source_tier` (§34) |
| `private-forward.ts` | `PrivateForwardValue` — ROLE-dominant current-season composite blended into the prior by season maturity; **physically separate module** from `market-state.ts` (§41) |
| `dynamic-edge.ts` | compares `PrivateForwardValue` vs `current_market_proxy`; `edge_vs_preseason_market` + `edge_vs_current_market` (§43); `market_correction` (§44); anomaly safeguards → `quality_status` (§31–§33); confidence caps |
| `dynamic.ts` | league-wide orchestrator over the Checkpoint-B table |

`MarketEdge` gains additive optional fields (`temporal`, `quality_status`,
`edge_vs_preseason_market`, `edge_vs_current_market`, `market_correction`,
`market_trajectory`) — a plain Checkpoint-B edge has none of them.

## B5.3 Season maturity vs recency (separate, nonlinear, calibrated)

**Season maturity** `w(g) = min(max_weight, 1 − e^(−λ·g))` — weight on
current-season evidence given `g` **meaningful games observed** (a player in a
real role, NOT the NFL week; falls back to `week − 1` with reduced confidence).
Monotonic, diminishing-returns, capped below 1 so the prior is never fully
erased.

**Recency** `r(age) = 0.5^(age / half_life_games)` — a *different* function with
*different* parameters, weighting older within-season observations less.

Both curves are `[position][metric_family]` — e.g. RB/ROLE stabilizes faster
than WR/EFFICIENCY.

## B5.4 Four distinct value concepts (§7), kept physically separate

- **A preseason_market_prior** — ADP consensus implied rank + this-league draft
  cost, z-scored within position. A *decaying prior*: its influence = `1 − w(g)`.
- **B current_public_projection** — Sleeper/RotoWire ROS (a *source*, carries its
  own readiness).  **current_performance_signal** — realized positional finish /
  recent rank.
- **C current_market_proxy** — `is_estimate: true`. RESULT-dominant current
  composite (fantasy managers react to the scoreboard, §14) blended into the
  prior by season maturity; with no current-season evidence it is simply the
  freshest market source (Sleeper ROS), never a divergent raw ADP rank.
  `proxy_source_tier` records which §34 tier drove it.
- **(private)** **PrivateForwardValue.projected_ros_value** — ROLE-dominant (our
  model reacts to opportunity), touchdown-mirage-guarded, opponent-adjusted.

`market-state.ts` does **not** import `private-forward.ts` — private model
knowledge cannot leak into the estimated public price.

## B5.5 Opponent adjustment + schedule quality (§15–§19)

Per game: `opponent_adjusted_expected = baseline × (1 + 0.6·matchup_score)`
(matchup_score ∈ [−1 hard, +1 easy], from `player_schedule_strength_weekly.csv`).
`residual_vs_opponent_expectation` is the informative signal. **Repeatedly**
beating the matchup-adjusted expectation vs tough defenses raises
`BreakoutCredibility` (→ confidence), **not** raw points (§18). An easy schedule
to date sets `weak_schedule_inflation` and discounts the realized production in
the private forward value (§19).

## B5.6 Market proxy vs private: the arbitrage the layer detects

| situation | B.5 output |
|---|---|
| market rising fast on scoreboard results not matched by opportunity | `SCORING_BREAKOUT_MOVES_MARKET`, private lags → **SELL-HIGH** |
| strong role / opportunity, modest scoring, tough opponents | `USAGE_BREAKOUT_SUPPORTS_PRIVATE`, private rises → **BUY-LOW** |
| current gap ≪ preseason gap | `MARKET_CORRECTED` / `MARKET_PARTIALLY_CORRECTED` — edge shrinks |
| current edge flips sign vs preseason edge | `MARKET_OVERSHOT` — BUY→SELL |
| extreme edge, confidence < MEDIUM | `quality_status: REVIEW_REQUIRED` — **not** promoted to STRONG_* |
| private horizon ≠ market horizon | `INSUFFICIENT_DATA` — fail closed |

## B5.7 R calibration (real backtest)

`analysis/competitive_market_calibration.R` → `lib/trades/data/competitive_market_calibration.json`.

**Method (no leakage):** prior = player's **2024** per-game average; current_N =
weeks 1..N of **2025**; target = weeks (N+1)..17 of **2025**. Grid-search λ
(season maturity) per position, minimizing OOS RMSE of the blend
`w(N)·current_N + (1−w(N))·prior` vs target; **accept only when the blend beats
both the prior-only and current-only baselines**.

**Result — `status: CALIBRATED`** (all 4 positions beat prior-only OOS):

| pos | n | RMSE prior-only | RMSE current-only | RMSE blend | λ | Spearman |
|---|---|---|---|---|---|---|
| QB | 237 | 5.48 | 5.88 | **5.13** | 0.08 | 0.31 |
| RB | 537 | 4.55 | 3.79 | **3.54** | 0.20 | 0.85 |
| WR | 946 | 4.03 | 3.99 | **3.44** | 0.12 | 0.79 |
| TE | 545 | 3.07 | 2.88 | **2.52** | 0.12 | 0.83 |

**λ empirically confirms the spec's qualitative claim**: RB (0.20) matures
fastest, QB (0.08) slowest / most prior-anchored. The recency half-life grid
saturated at its ceiling (10) for every position — within-season recency decay
is **milder than intuition**; documented as a limitation (grid ceiling, and
family-specific recency curves are not separately backtested — the `*` fallback
curves keep the qualitative priors).

The TS layer **never runs R** — `loadCompetitiveMarketCalibration()` reads the
frozen JSON, falling back to `DEFAULT_PRIOR` (labelled) when absent. On
`DEFAULT_PRIOR` **and** on a `WEEK_NUMBER_FALLBACK` games count, the dynamic
edge is capped at MEDIUM confidence (§59).

## B5.8 Bloodline Bowl diagnostics

**Live, week 1** (`scripts/competitive-trade-smoke.ts`): calibration `CALIBRATED`;
every player `PRESEASON_ONLY` (870 with data, 2434 UNAVAILABLE); **20 / 867**
ranked edges flagged `quality_status: REVIEW_REQUIRED` (the anomaly safeguard
catching extreme low-confidence divergences — e.g. the Josh Jacobs RB7-vs-RB48
Sleeper-ROS anomaly the B smoke surfaced). Static B boards unchanged. Watch list:

| player | B edge | B.5 edge_vs_current | B.5 edge_vs_preseason | correction |
|---|---|---|---|---|
| Chuba Hubbard | `BUY` +0.74 | +0.74 | +1.93 | `MARKET_PARTIALLY_CORRECTED` (Sleeper ROS already moved ~60% toward our preseason view; +0.74 residual) |
| Rhamondre Stevenson | `FAIR` −0.43 | −0.43 | +0.62 | `MARKET_OVERSHOT` (we were higher than ADP preseason; Sleeper now above us — sell-lean) |
| Rome Odunze | `FAIR` −0.50 | −0.50 | +0.86 | `MARKET_OVERSHOT` |

**Synthetic week 6** (`--synthetic-only`, deterministic): A sell-high → `STRONG_SELL`
(−1.38); B buy-low (strong role, elite opp) → `BUY` +0.74, `HIGH` conf,
`HIGH_CONFIDENCE` breakout, `MULTI_SOURCE_CORROBORATION`; C market-corrected →
edge shrinks 2.28 → 1.05, `MARKET_PARTIALLY_CORRECTED`; D TD-mirage → `FAIR`,
`TOUCHDOWN_MIRAGE_RISK`, market proxy > private forward; E schedule-suppression →
private favors the tough-schedule player (+0.42), `HIGH_CONFIDENCE` breakout.

## B5.9 Known limitations (B.5)

1. **No 2026 current-season data** — the entire dynamic machinery is exercised
   live only in `PRESEASON_ONLY`; synthetic tests + the week-6 smoke cover the
   rest. It activates automatically as 2026 games are played and the R pipelines
   re-run.
2. **Recency half-life uncalibrated in practice** — the backtest grid saturated
   at its ceiling; the artifact carries per-position half-life 10 and the
   metric-family fallbacks keep documented priors.
3. **Opponent-adjusted term is heuristic** — `k = 0.6`, not fitted; the R script
   explicitly does not calibrate a schedule-strength residual.
4. **`meaningful_games_observed`** falls back to `week − 1` when no per-game
   role series exists (the live case) — flagged, confidence-capped.
5. **Market snapshot history not yet persisted** (§22) — `prior_snapshot_proxy_z`
   is a supported input but nothing writes the per-week artifact yet; trajectory
   is `UNKNOWN` without a second snapshot.
6. **ADP consensus is a fixed 2026 preseason vendored snapshot** — a decaying
   prior by construction; there is no live in-season consensus-ranking feed.
7. No owner perception / acceptance / extraction / opponent cost / negotiation /
   liquidity / multi-hop — Checkpoints C–F.

## B5.10 Regression (B.5)

- `tsc --noEmit` clean; `eslint app lib test` 0 errors, 29 pre-existing warnings.
- `npm test`: **1692 tests, 1688 pass, 0 fail, 4 skipped**. +16 new B.5 tests
  (`test/competitive-trade-dynamic.test.ts`). Zero existing expectations changed
  (trade / discovery / weekly / lineup / start-sit / waiver / Phase-9 /
  orchestrator).
- Performance: full-league dynamic report ~24–37 ms (867 edges) — ~5–10 ms over
  Checkpoint B; one shared league table, no per-candidate recomputation.

## B5.11 Files changed (B.5)

New: `lib/trades/competitive/{calibration,temporal,evidence,market-state,private-forward,dynamic-edge,dynamic}.ts`;
`analysis/competitive_market_calibration.R`; `lib/trades/data/competitive_market_calibration.json`;
`test/competitive-trade-dynamic.test.ts`.
Modified: `lib/trades/competitive/{schema,index}.ts` (additive types + exports),
`lib/trades/competitive/private-value.ts` (basis doc), `scripts/competitive-trade-smoke.ts`,
`docs/COMPETITIVE_TRADE_INTELLIGENCE.md`.

---

---

# Part VI — Checkpoint C: Owner-Perceived Value, Reservation Price, Acceptance

Status: **CHECKPOINT C CERTIFIED — READY FOR CHECKPOINT D.**
Branch `competitive-trade-intelligence`, built on `36ff309`.

## C.1 B.5 calibration metadata correction (§1)

The R backtest fits only **season maturity**. The artifact and the TS loader now
carry per-component honesty:

| component | status | note |
|---|---|---|
| `season_maturity` | `CALIBRATED` | grid-searched λ per position; accepted only where the blend beat prior-only OOS RMSE |
| `recency_decay` | `CALIBRATION_UNRESOLVED` | half-life grid saturated at the tested ceiling |
| `opponent_adjustment` | `HEURISTIC` | k = 0.6 matchup elasticity, never fitted |
| `market_response_weights` | `HEURISTIC` | RESULT-dominant market / ROLE-dominant private split |

Top-level `status` is now **`PARTIALLY_CALIBRATED`** — DERIVED by the loader
(`deriveStatus`): `CALIBRATED` only when **every** component is `CALIBRATED`; a
doctored artifact claiming `CALIBRATED` while a component is `HEURISTIC` is
downgraded. Downstream confidence caps call `isFullyCalibrated(cal)` — which is
`false` for `PARTIALLY_CALIBRATED` — so a partially-fitted model can **never**
unlock the fully-calibrated HIGH-confidence ceiling. Regression: `test/competitive-trade-owner-perception.test.ts` §1 block.

## C.2 Manager-data audit

| signal | availability (bloodline-bowl, live) |
|---|---|
| roster / starters / bench / IR / slots | **READY** |
| optimal lineup / slot matching | **READY** (`buildOptimalLineup`) |
| positional need / surplus | **READY** (`computePositionalNeeds`, `buildTradeSearchProfile`) |
| per-player draft pick / round / slot / **drafting manager** | **READY** — 180 picks |
| preseason ADP at draft (consensus) | **READY** (`buildMarketConsensus`) |
| replacement quality | **READY** (`weeklyVOR` + frontier) |
| standings / team strength | present but 0-0 at week 1 |
| current-season realized performance (2026) | **NONE** — 0 games played |
| transaction history | 7 rows — **too sparse** ⇒ `behavioral_adjustment = null` |
| trade-offer history / rejected offers | **NONE** |
| manager behavioral tendencies | **UNAVAILABLE** (1 real trade, other league) |

## C.3 The four distinct value concepts (§ core principle)

```
our private value        evaluateTrade — what the roster is worth to US
   ≠
global current market    B.5 current_market_proxy — what the market appears to think
   ≠
owner-perceived value    global market + THIS owner's modifiers
   ≠
owner reservation price   owner-perceived + roster-consequence costs of losing him
```

## C.4 Owner-perceived value (`owner-perception.ts`)

```
owner_perceived_value = global_current_market
  + personal_draft_anchor_adjustment   (their pick vs ADP-implied rank, decayed by games)
  + starter_importance_adjustment       (LOCKED_STARTER → +, BENCH_DEPTH → −)
  + recent_performance_salience         (B.5 market_trajectory; ≈ 0 at week 1)
  + name_salience_adjustment            (top-of-position → small +)
  + behavioral_adjustment               (null — insufficient transaction history)
```

Every component is capped (z units) and exposed. For a **prospective** incoming
asset (they'd RECEIVE it, don't own it) there is no draft anchor — the perceived
value is `global market + would-he-start premium`, readiness
`PARTIAL_OWNER_CONTEXT`.

## C.5 Draft anchoring + decay (§6–§8)

`draft_reach_delta` = the player's draft-cost z (within this owner's roster)
minus his ADP-implied z. Positive ⇒ reached (drafted ahead of market) ⇒
`STRONG/MODERATE_ANCHOR`; negative ⇒ bargain ⇒ `MINIMAL_ANCHOR` (§8: less
sunk-cost resistance, a small negative adjustment, never an inflation).

`draftAnchorWeight(state, g) = base_weight(state) · e^(−λ_anchor·g)` with
**`λ_anchor = 0.09` — deliberately slower than every season-maturity λ
(0.08–0.5)** (§7: a manager stays attached longer than the market re-prices).
`calibration_status: "HEURISTIC"` always at Checkpoint C.

## C.6 Starter importance (§9)

From the owner's **actual optimal lineup** (not roster order):
`LOCKED_STARTER` (in the optimal lineup, no bench player within 3 pts VOR) /
`REGULAR_STARTER` / `FLEX_STARTER` / `ROTATIONAL` (startable-VOR bench) /
`BENCH_DEPTH` / `IR`.

## C.7 Reservation price (`reservation.ts`)

```
reservation_price(bundle) = Σ owner_perceived_value
  + replacement_cost           OUR estimate of the owner's optimal-lineup loss
                               (leave-all-out `buildOptimalLineup`) ÷ 6 → z.
                               A behavioral proxy for resistance — NOT their perceived value.
  + positional_scarcity_cost   z per startable-option gap at the position after the loss
  + surplus_discount           ≤ 0 — z per extra startable option beyond need+1
  + bundle_nonadditivity       ≥ 0 — combined leave-all-out loss BEYOND the sum of
                               individual losses (§28: losing RB3+RB4 together hurts
                               more than either alone)
```

`need_relief` is deliberately **not** a per-asset reservation discount — it is a
trade-level acceptance factor (§11, §29). The literal §5 formula is adapted, not
copied.

## C.8 Acceptance model (`acceptance.ts`) — counterparty economics, heuristic

```
their perceived ledger:
  perceived_incoming_value  = Σ owner_perceived_value of what they RECEIVE
  perceived_outgoing_reserv. = bundle reservation of what they GIVE
  perceived_surplus         = incoming − outgoing_reservation

internal_score = 1.0·perceived_surplus + 0.7·need_relief
              − 1.0·roster_slot_pressure + 0.4·structure_fit
              + 0.2·market_trajectory_adjustment

likelihood band:  internal_score ≥ 0.5 → HIGH ; ≥ 0.0 → MODERATE ; ≥ −0.6 → LOW ; else VERY_LOW
```

- **Does NOT consume our private edge.** **Does NOT require opponent actual gain
  > 0** — a trade where our private model says they lose can still be
  `MODERATE`/`HIGH` acceptance if their *perceived* ledger is positive (§42, tested).
- `roster_slot_pressure` (§22, §44): a net asset gain at a full roster forces
  drops → penalty scaled by how many would be startable-quality.
- `structure_fit` (§21, §45): consolidation favorable for a deep owner,
  fragmentation favorable for a fragility-sensitive owner — **not** a universal
  preference.
- `likelihood` is a **band, never a %**. `internal_score` is internal,
  decomposed, deterministic, monotone — never presented as a probability.
- `calibration_status: "INSUFFICIENT_TRADE_HISTORY"` always.
- **Acceptance confidence is distinct from likelihood** (§33): "signals suggest
  they should accept, but we have no behavioral history" ⇒ `HIGH` likelihood /
  `LOW` confidence is a valid pairing.

## C.9 Readiness (§30–§31)

`FULL_OWNER_CONTEXT` (roster + draft + market) → confidence ceiling **MEDIUM**
(never HIGH — heuristic acceptance, thin trade history) ·
`PARTIAL_OWNER_CONTEXT` (roster, no anchor / prospective asset) → LOW ·
`GLOBAL_MARKET_ONLY` (no roster/owner context at all) → LOW, values explicitly
**not owner-specific** · `UNAVAILABLE` → VERY_LOW. Missing owner data can only
lower confidence, never raise it (tested).

## C.10 Output contract

`evaluateCompetitiveTrade({ …, counterparty_manager_id })` attaches, additively:

```
competitive.owner_perception : { counterparty_id, readiness, perceived_asset_values[],
                                 reservation[], perceived_incoming_value,
                                 perceived_outgoing_reservation, perceived_surplus,
                                 confidence, reasons }
competitive.acceptance       : { owner_manager_id, perceived_ledger, likelihood,
                                 internal_score, components, confidence, readiness,
                                 calibration_status, reasons }
```

Both **absent** when no counterparty is supplied (tested). `extraction` /
`competitive_cost` / `negotiation` remain absent from the type.

## C.11 Bloodline Bowl diagnostics (read-only, week 1)

**BijiMac / Chuba Hubbard:** Chuba = `FLEX_STARTER` for BijiMac, drafted R8
(overall 85, ~ADP RB35 → `WEAK_ANCHOR`, bargain), BijiMac has **5 startable RB**
(RB need `LOW`, surplus 2). Owner-perceived value ≈ **1.23 z** (global 1.11 +
flex-starter 0.15 − bargain 0.03). Reservation ≈ **1.09 z** (perceived 1.23 +
replacement 0.14 + scarcity 0 − **surplus discount 0.28**) — *below* perceived
value because his RB room is deep. This is exactly the §4 "expendable ⇒
reservation < perceived value" case.

**Hypothetical Rhamondre Stevenson → Chuba Hubbard** (we send Rhamondre):
| | |
|---|---|
| readiness | `PARTIAL_OWNER_CONTEXT` (Rhamondre is prospective for BijiMac — no anchor) |
| BijiMac perceives receiving Rhamondre | ≈ **1.46 z** (global + would-start premium) |
| BijiMac reservation for Chuba | ≈ **1.09 z** |
| **BijiMac perceived surplus** | **≈ +0.37 z** |
| **acceptance likelihood** | **MODERATE** (internal 0.37) |
| acceptance confidence | **MEDIUM** — heuristic, no behavioral history |
| our private ledger | from `evaluateTrade`, **not shown / not overwritten**; extraction **not** recommended (Checkpoint C boundary) |

**Rome Odunze as outgoing currency:** every sampled counterparty currently has
WR need `LOW` — his owner-specific need-relief value is similar across managers
right now (week 1, preseason). The mechanism produces differentiation when
roster context differs; it does not fabricate it.

**RB roster context across the league** (drives reservation differences):
`bijoy2theworld` RB need **CRITICAL** (4 rostered), `hammy535` **HIGH** (3), vs
`supyo29`/`shitalkers`/`nightfallfox` need **NONE** (6 rostered). A mid-value RB
owned by a 6-RB manager reserves lower than the same RB owned by
`bijoy2theworld` — the §54 live validation.

## C.12 Known limitations (C)

1. **No 2026 realized data** — `recent_performance_salience` and `meaningful_games`
   are 0 live; owner perception is materially draft-anchored, as the spec expects
   at week 1.
2. **Acceptance is heuristic, uncalibrated** — 1 real trade exists (different
   league, unmapped managers). `INSUFFICIENT_TRADE_HISTORY` everywhere.
3. **`behavioral_adjustment` is always `null`** — no usable transaction history.
4. **z-scale skew** — the RB VOR distribution is right-skewed (many bench players
   at VOR ≈ 0), so a mid-rank RB's z can look higher than a rank-based intuition.
   Affects B/B.5/C equally; the *comparative* ledger logic is unaffected.
5. **Prospective incoming value** is a rough "would-he-start premium", not a full
   hypothetical-roster re-optimization.
6. No extraction / opponent competitive cost / negotiation / liquidity /
   multi-hop — Checkpoints D–F.

## C.13 Regression (C)

- `tsc --noEmit` clean; `eslint app lib test` 0 errors, 29 pre-existing warnings.
- `npm test`: **1707 tests, 1703 pass, 0 fail, 4 skipped**. +16 new C tests
  (`test/competitive-trade-owner-perception.test.ts`). Zero existing expectations
  changed (legacy trade / discovery / weekly / lineup / start-sit / waiver /
  Phase-9 / orchestrator).
- Performance: ~1–3 ms per counterparty owner-perception eval after the shared
  market table is built; per-manager context memoized.

## C.14 Files changed (C)

New: `lib/trades/competitive/{owner-context,owner-perception,reservation,acceptance,owner-perception-eval}.ts`;
`test/competitive-trade-owner-perception.test.ts`.
Modified: `lib/trades/competitive/{schema,config,calibration,dynamic-edge,evaluate,index}.ts`;
`analysis/competitive_market_calibration.R` + its artifact (component metadata);
`scripts/competitive-trade-smoke.ts`; the doc.

---

---

# Part VII — Checkpoint D: Opponent Impact, Rival Threat, Competitive Externality

Status: **CHECKPOINT D CERTIFIED — READY FOR CHECKPOINT E.**
Branch `competitive-trade-intelligence`, built on `b26eb89`.

## D.1 Reservation sanity-bound audit (§36)

C's `reservation_price = Σ owner_perceived + replacement_cost + scarcity_cost +
surplus_discount(≤0) + bundle_nonadditivity`. Stacked surplus discounts (e.g. a
6-startable-RB owner: `extra = 3`, discount `−0.84`) could drive a valuable
player's reservation to a meaningless / large-negative z. Added
`config.reservation_sanity`:

| bound | default | effect |
|---|---|---|
| `max_surplus_discount` | 0.6 | the summed surplus discount magnitude is capped |
| `floor_fraction_of_perceived` | 0.5 | a positively-perceived bundle's reservation stays ≥ 50 % of Σ perceived |
| `absolute_floor_z` | −0.75 | reservation never falls below this regardless of perceived value |

`ReservationPrice.sanity_floor_applied` flags a clamp;
`RESERVATION_SANITY_FLOOR_APPLIED` reason. Regression added. C math otherwise
unchanged.

## D.2 The seven distinct concepts (§1) — none collapsed

```
OUR PRIVATE GAIN          evaluateTrade — our participant's utility delta
THEIR ACTUAL PRIVATE GAIN evaluateTrade — the counterparty's participant delta   (opponent_impact)
THEIR PERCEIVED GAIN      Checkpoint C perceived ledger
THEIR ACCEPTANCE          Checkpoint C likelihood band
THEIR THREAT LEVEL        forward-looking roster strength                         (opponent_threat)
COMPETITIVE EXTERNALITY   opponent gain × threat × weakness-repair                (competitive_externality)
FINAL COMPETITIVE DESIRABILITY  our gain net of the externality, acceptance-gated (competitive_result)
```

`opponent_impact` is read from `evaluateTrade`, **not** from owner perception (§1).

## D.3 Opponent actual impact (`opponent-impact.ts`)

Reads the counterparty's `ParticipantTradeResult` off the canonical
`evaluateTrade` output — `private_delta` (= `contextual_utility_delta`),
`starter_delta` (`starter_points_delta`), `bench_delta` (`bench_value_delta`),
`ros_delta`, `fragility_delta`, needs improved / worsened. No second football
model.

**Starter vs bench (§4):** kept separate — the externality weights
`starter_gain_weight = 1.0` vs `depth_gain_weight = 0.35`.

**Weakness repair (§5, §6, §45):** our OUTGOING asset lands at a position where
the counterparty's `positional_need_changes` shows `IMPROVES_NEED` from a
`critical`/`weak` before-severity → `CRITICAL_WEAKNESS_REPAIRED` /
`HIGH_NEED_REPAIRED`; entering their starting lineup at a needed spot →
`STARTER_HOLE_FILLED`; landing on a deep position → `SURPLUS_REINFORCED`.

## D.4 Threat model (`threat.ts`) — forward-looking, not standings

```
projected_strength_z = z( optimal_total + 0.35·Σ starter_VOR + 0.15·Σ bench_VOR )
results_strength_z    = z( 2·win% + points_for_z )          — null before any games
results_weight        = min(0.6, 1 − e^(−0.16·weeks_played))  — saturating, capped
blended_strength_z    = (1 − results_weight)·projected_z + results_weight·results_z − balance_penalty
band                  = LOW / MODERATE / HIGH / ELITE
```

- **Week 1 (§23, §41):** `weeks_played = 0` ⇒ `results_weight = 0`,
  `results_strength_z = null` ⇒ threat is **projected roster strength only**.
  A 1-0 record never makes a team ELITE.
- **Season maturity (§8):** `results_weight` grows on a saturating curve,
  **capped at 0.6** (§43 — a hot record never fully overrides the roster).
- **Fluky record (§43):** a 5-1 team with a weak roster + low points-for stays
  below the real contender (tested).
- **Underperforming contender (§44):** a 2-4 team with an elite roster keeps a
  meaningful threat (tested).
- **Balance / bottleneck (§25):** a position with no startable option → threat
  penalty (a catastrophic hole makes a team less threatening).

**Relative strength (§10, §16):** `league_strength_percentile`, `relative_to_us`
(their blended z − ours), `contender_band` (`BOTTOM_TIER` … `TOP_CONTENDER`).
`calibration_status: "HEURISTIC"` — no trade-to-title outcome data; no fabricated
championship probabilities (§17, §22).

## D.5 Competitive externality (`externality.ts`)

```
FAVORABLE  (opponent private_delta < −0.25):
  score = private_delta · 0.5 · threat_band_multiplier          ≤ 0  (a competitive BENEFIT)

COST  (opponent improves):
  score = ( starter_gain_weight·max(0, starter_delta)
          + depth_gain_weight·max(0, bench_delta + 0.5·ros_delta) )
          × threat_band_multiplier          LOW 0.35 → ELITE 1.6
          × weakness_repair_multiplier       SURPLUS 0.55 → CRITICAL 1.7
          × relative_strength_multiplier     1 + 0.4·max(0, their_z − our_z)
```

`≥ 0` ⇒ we helped a rival (a cost); `< 0` ⇒ we weakened them (favorable, driven
directly by a negative opponent delta — §14, §46). Decomposed, not the literal
§11 formula, scaling tested.

## D.6 Competitive result (`competitive-result.ts`) — staged flow (§18)

```
1. readiness            → UNAVAILABLE ⇒ REJECT
2. our_private_gain ≥ min_our_gain (0.25)   → else REJECT (OUR_GAIN_INSUFFICIENT)
3. acceptance ≥ min_acceptance (LOW)        → sets `actionable`; a fail caps the
                                              classification at MARGINAL (§19, §33)
4. score = our_private_gain
         + market_edge_bonus  (≤ 1.5)
         − capped_externality
         − uncertainty_penalty  (0.35 per confidence band below HIGH)
5. classification from score bands + gates
```

**Our gain dominates (§2, §15, §30):** a POSITIVE externality is capped at
`0.7·|our_gain| + threat_extra` (`threat_extra` = 1.5 ELITE / 0.8 HIGH / 0) so a
modest elite-rival improvement can't swamp an overwhelming our-gain, while a
weak our-gain + large rival improvement still gets rejected (§31, both tested).
A NEGATIVE externality is never capped by our gain — it can only help (§14).
`EXTERNALITY_TOO_HIGH` + low score ⇒ `AVOID_COMPETITIVE_COST`.

Classifications: `STRONG_COMPETITIVE_BUY` / `COMPETITIVE_BUY` / `ACCEPTABLE` /
`MARGINAL` / `AVOID_COMPETITIVE_COST` / `REJECT`. `confidence` is separate from
the classification (§35). `gate_trace` exposes every stage.

## D.7 Output contract

`evaluateCompetitiveTrade({ …, counterparty_manager_id })` attaches, additively:
`competitive.opponent_impact`, `.opponent_threat`, `.competitive_externality`,
`.competitive_result`. All absent without a counterparty (tested).

## D.8 Bloodline Bowl live diagnostics (week 1)

**League threat bands** — every `results_weight = 0` (0-0 records contribute
nothing, §41). Projected-roster-driven: `rsamuel1013` / `zzzerena` ELITE,
`bijoy2theworld` / `hammy535` LOW.

**Rhamondre Stevenson → Chuba Hubbard** (perspective: `supyo29`, who owns
Rhamondre):
| | |
|---|---|
| our private delta (supyo29) | **−4.28 pts/wk** — the swap *loses* value for the Rhamondre owner |
| BijiMac ACTUAL impact | **+5.01** (`STARTER_HOLE_FILLED`) |
| BijiMac perceived surplus (C) | +0.37 · acceptance **MODERATE** |
| BijiMac threat | **MODERATE**, `relative_to_us −0.46` (weaker than supyo29) |
| competitive externality | **+3.58** (`OPPONENT_STARTER_GAIN`) |
| **competitive_result** | **REJECT**, score −7.68, `actionable = false` — stage-2 `our_gain` gate fails |

An honest negative: this specific swap is bad for the Rhamondre owner *and*
helps a rival. Not forced favorable (§39).

**§40 — `hammy535` (RB need) acquires an RB, same bench asset offered, different
counterparties:** because hammy535 gives a scrub, every counterparty is
*weakened* (`opp_impact` negative) so externalities are favorable. Illustrative
rows:
| counterparty | our_gain | threat | opp_impact | externality | result | actionable |
|---|---|---|---|---|---|---|
| supyo29 | +4.59 | HIGH | −1.39 | −0.80 | `STRONG_COMPETITIVE_BUY` | yes |
| rsamuel1013 | +1.66 | **ELITE** | −1.15 | −0.92 | `COMPETITIVE_BUY` | yes |
| bijimac | +1.49 | MODERATE | −0.23 | 0.00 | `ACCEPTABLE` | yes |
| **msamuel4 (David Montgomery)** | **+7.50** | LOW | −4.55 | −0.80 | **`MARGINAL`** | **no** |

The msamuel4 row is the §33 case: high score (7.26) but capped at `MARGINAL` /
`actionable=false` because msamuel4 would never accept a real RB for a scrub —
acceptance is a **feasibility gate**, not a reward.

Week-8 threat behavior (fluky record, underperforming contender, results-weight
cap) is covered by `test/competitive-trade-competitive-cost.test.ts` §42–§44.

## D.9 Known limitations (D)

1. **Threat is HEURISTIC** — no trade→title outcome data; bands and multipliers
   are reasoned defaults, not fitted.
2. **No 2026 results data** — `results_weight = 0` live; threat is 100 %
   projected roster strength (correct for week 1).
3. **Projected strength uses the current optimal lineup**, not an ROS-projected
   one — a bye-week or injury dip could momentarily distort a team's threat.
4. **Balance penalty is coarse** — counts unfilled startable slots, not
   severity-weighted.
5. No extraction / negotiation / liquidity / multi-hop (E–F).

## D.10 Regression (D)

- `tsc --noEmit` clean; `eslint app lib test` 0 errors, 29 pre-existing warnings.
- `npm test`: **1728 tests, 1724 pass, 0 fail, 4 skipped**. +21 new D tests
  (`test/competitive-trade-competitive-cost.test.ts`). Zero existing
  expectations changed.
- Performance: league threat (14 teams) ~7 ms; full competitive eval with a
  counterparty ~10 ms (threat + owner perception + externality + result);
  per-manager owner context memoized.

## D.11 Files changed (D)

New: `lib/trades/competitive/{opponent-impact,threat,externality,competitive-result,competitive-d-eval}.ts`;
`test/competitive-trade-competitive-cost.test.ts`.
Modified: `lib/trades/competitive/{schema,config,reservation,evaluate,index}.ts`;
`scripts/competitive-trade-smoke.ts`; the doc.

---

---

# Part VIII — Checkpoint D.5: Horizon-Aware Permanent-Trade Utility

Status: **CHECKPOINT D.5 CERTIFIED — READY FOR CHECKPOINT E.**
Branch `competitive-trade-intelligence`, built on `73822e8`.

## D5.1 Root-cause trace of the −4.28 (the reconciliation ledger)

`supyo29` gives Rhamondre, receives Chuba. Traced through `evaluateTrade`:

| quantity | Chuba | Rhamondre |
|---|---|---|
| current-week projection (RotoWire) | **9.63** | **13.89** |
| external ROS `ros.points` (Sleeper season) | 136.52 | **154.76** |
| `ros.ri_season_points` (RI model) | **121.23** | 85.05 |
| `ros.ri_vor` / `ri_position_rank` | 52.87 / **RB15** | 16.69 / RB31 |
| `ros.disagreement_pct` | −0.11 (`AGREE`) | **−0.45 (`RI_BELOW`)** |
| `expected_availability` | **0.78** | 1.0 |

`roster_utility_delta = 1.0·Δoptimal_starter_points + 0.25·Δbench_VOR + 1.0·Δpositional_need`.
For supyo29: `Δstarter = −4.21` (week-1 optimal lineup 117.38 → 113.17 because
Chuba enters the FLEX at 9.63 where Rhamondre was at 13.89), `Δbench 2.74`,
`Δneed −0.75` ⇒ **−4.28**. Phase 2's ROS layer *is* computed
(`ros_usable_value_delta = −18.24` season) but **every Phase 2 weight is 0** so
`contextual_utility_delta = −4.28` — pure current-week.

**Answer (§5): Case A AND Case B.**
- **Case B (real horizon defect):** the canonical delta the competitive path
  consumes is 100 % the next game.
- **Case A (legitimate roster/model context):** correcting to ROS does **not**
  flip the sign — the external (Sleeper) ROS projection *also* favors Rhamondre
  (154.76 > 136.52 season), and Chuba carries injury risk (0.78). Only RI's
  ordinal season model prefers Chuba, and it disagrees with the external
  projection by **45 %** on Rhamondre.

Post-fix: supyo29 permanent utility = **−3.39/wk** (immediate −4.28 · ROS −3.24 ·
0.85 ROS / 0.15 immediate blend), classified **`REVIEW_REQUIRED`** (RI↔external
sign conflict), confidence **VERY_LOW**. An honest "we can't call this a good
trade — our two projections disagree" (§16, §47).

## D5.2 Horizon-aware evaluator (`horizon.ts`) — additive, `evaluateTrade` untouched

```
evaluateTrade()  →  immediate canonical roster economics  (LEGACY, unchanged)
     +
Phase 2 ros.ts   →  ROS optimal-lineup delta  (already computed, weight-0)
     ↓
evaluateTradeHorizons()  →  { immediate, ros, ri_ordinal, permanent_trade_utility }
     ↓
evaluateCompetitiveDimension()  →  consumes permanent_trade_utility for BOTH sides
```

`TradeHorizonEvaluation`:
- **`immediate`** — `starter_delta` / `depth_delta` / `positional_need_delta` /
  `total_delta` (= `roster_utility_delta`), current week.
- **`ros`** (weekly-equivalent):
  - `starter_delta` = `phase2.ros.ros_usable_value_delta ÷ remaining_weeks`
    (external Sleeper prorated, `ros.ts`'s documented basis).
  - `depth_delta` = stranded (bench) ROS production delta ÷ weeks.
  - `availability_delta` = `Σ (expected_availability − 1)·ros_weekly_rate` over
    incoming − outgoing (§9 — `ros.ts` only prorates for *byes*, not injury).
  - `playoff_window_delta`, `bye_coverage_delta`.
  - `total_delta` = weighted blend.
  - `standalone_ros_swing` + `usable_ros_value_delta_season` — the §36 naive-vs-
    roster-context contrast.
- **`ri_ordinal`** — `ri_vor_delta`, incoming/outgoing RI ranks (explanatory),
  `max_disagreement_pct`, **`sign_conflict`** (RI VOR direction contradicts
  external ROS AND worst season disagreement ≥ 30 %).
- **`permanent_trade_utility`** = `ros_weight·ros.total + immediate_weight·immediate.total`.
  `immediate_weight = min(0.4, 0.15 + 0.25·season_progress)` — grows through the
  season (fewer ROS weeks left) but **capped at 0.4** (a permanent trade is
  never mostly a start/sit call). HEURISTIC, centralized in `HorizonConfig`.

## D5.3 Horizon classification (§6, §32–§36)

`CONSISTENT_POSITIVE` / `CONSISTENT_NEGATIVE` /
`SHORT_TERM_GAIN_LONG_TERM_LOSS` / `SHORT_TERM_LOSS_LONG_TERM_GAIN` / `MIXED` /
**`REVIEW_REQUIRED`** (RI↔external sign conflict — overrides everything). A flat
immediate + a clear ROS sign resolves to the ROS sign (ROS dominates for a
permanent trade).

## D5.4 Weakness-repair semantic split (§17–§21, §39–§40)

The D live diagnostic mislabelled a generic RB starter upgrade (adequate→strong)
as `STARTER_HOLE_FILLED`. New distinct codes:

| code | requires |
|---|---|
| `CRITICAL_WEAKNESS_REPAIRED` | pre-trade need severity **critical** at a received position + `IMPROVES_NEED` |
| `HIGH_NEED_REPAIRED` | pre-trade **weak** + `IMPROVES_NEED` |
| `PREEXISTING_STARTER_HOLE_FILLED` | our asset entered the lineup AND *some* slot's need was weak/critical before |
| `STARTER_UPGRADED` | entered the lineup but every relevant position was already adequate/strong — **not a repaired hole** |
| `DEPTH_IMPROVED` / `SURPLUS_REINFORCED` | value went to the bench / a deep position |

Externality multipliers: `STARTER_UPGRADED` = **1.0** (a generic upgrade is not
extra-costly, §21); `PREEXISTING_STARTER_HOLE_FILLED` 1.2; `CRITICAL` 1.7.

The Rhamondre→Chuba BijiMac impact is now `PREEXISTING_STARTER_HOLE_FILLED` (the
FLEX was `weak` before) — a real but mild hole fill, not `CRITICAL`.

## D5.5 Threat ROS baseline (§22–§26, §41–§43)

D's projected strength used the **current-week** optimal lineup — too
schedule-sensitive for season-long threat. Now:

```
projected_strength = Σ (ros_weekly_rate of the current optimal starters)
                   + 0.15·(ROS bench VOR)
                   + 0.05·(current-week optimal total)   ← small secondary signal only
```

`ros_weekly_rate = (ros.points ÷ remaining_weeks) · expected_availability`.
`ThreatComponents.projected_strength_horizon` ∈ `ROS` / `CURRENT_WEEK` / `MIXED`
(§26 — no hidden temporal basis). The season-maturity `results_weight` logic
from D is **unchanged**. Regression: quadrupling every current-week projection
moves a team's threat score by < 0.25 z (§41, tested).

## D5.6 Competitive-result integration (§30, §46)

`evaluateCompetitiveDimension` now feeds `our_private_gain` = our
`permanent_trade_utility` and `opponent_impact.private_delta` = the
counterparty's `permanent_trade_utility`. `opponent_impact.starter_delta` is
blended 75 % ROS / 25 % immediate. Owner perception, acceptance, market edge, D's
threat season-maturity and staged ranking are **unchanged**.
`competitive.our_trade_horizons` / `.opponent_trade_horizons` expose the full
breakdown.

## D5.7 Bloodline Bowl reconciliation (week 1)

**Rhamondre → Chuba** (perspective `supyo29`):
| | our side (supyo29) | BijiMac side |
|---|---|---|
| immediate | −4.28 | +5.01 |
| ROS (weekly-eq) | −3.24 (starter −1.07, avail −1.77, playoff −1.14) | +3.20 |
| **permanent utility** | **−3.39** | **+3.47** |
| horizon class | **`REVIEW_REQUIRED`** (RI RB15 vs external, 45 % conflict) | `REVIEW_REQUIRED` |
| confidence | VERY_LOW | — |
| BijiMac perceived surplus (C) | — | +0.37 · acceptance MODERATE |
| BijiMac threat | LOW (−0.61, horizon `ROS`) | — |
| weakness repair | — | `PREEXISTING_STARTER_HOLE_FILLED` |
| competitive externality | +1.11 | — |
| **competitive_result** | **`REJECT`** (our-gain gate fails: −3.39 < 0.25), not actionable | — |

Not forced to a BUY (§39, §47). The horizon fix reduced the magnitude (−4.28 →
−3.39) and correctly flagged the model disagreement.

**§48 — three RB targets for `supyo29` (Rhamondre out):**
| target | RI rank | immediate | ROS | permanent | class |
|---|---|---|---|---|---|
| James Cook | RB1 | +1.96 | +7.23 | **+6.44** | `CONSISTENT_POSITIVE` |
| Kyle Monangai | RB29 | −4.96 | −2.77 | −3.10 | `CONSISTENT_NEGATIVE` |
| Kaleb Johnson | RB132 | −5.37 | −3.83 | −4.06 | `CONSISTENT_NEGATIVE` |

Chuba is **not** a special case — permanent utility scales monotonically with
the target's ROS quality. James Cook (an unambiguous ROS upgrade where RI and
the external projection agree) is `CONSISTENT_POSITIVE` +6.44.

**§40 — `hammy535` acquires an RB, horizon-aware** (the D live diagnostic
inflated several by `immediate`): `vs supyo29` immediate +4.59 → **permanent
−0.32 `REJECT`** (a false positive the horizon fix caught); `vs theberserkfury`
permanent +1.02, weakens them, `ACCEPTABLE / actionable`; `vs msamuel4` permanent
+5.51 but `MARGINAL / not actionable` (acceptance gate).

## D5.8 Known limitations (D.5)

1. **ROS absolute value is the external (Sleeper) preseason projection prorated**
   — `ros.ts`'s documented basis. It does not yet re-weight for realized 2026
   games (none played). RI's independent season model is a disagreement signal,
   not blended.
2. **`ri_external_disagreement_threshold` and the blend weights are HEURISTIC.**
3. **Threat's ROS starter set = the *current* optimal starters valued by ROS
   rate** — not a full ROS re-optimization; a currently-injured starter could
   skew one team.
4. **`availability_delta` uses `expected_availability`** which is itself a
   projection-provider heuristic; missing ⇒ treated as 1.0 (explicit).
5. Legacy `evaluateTrade` / legacy discovery keep the immediate value — only the
   competitive path uses `permanent_trade_utility` (§31).

## D5.9 Regression (D.5)

- `tsc --noEmit` clean; `eslint app lib test` 0 errors, 29 pre-existing warnings.
- `npm test`: **1745 tests, 1741 pass, 0 fail, 4 skipped**. +17 new D.5 tests
  (`test/competitive-trade-horizon.test.ts`). Zero existing expectations changed
  (legacy trade, discovery, weekly, lineup, start-sit, waiver, Phase-9,
  orchestrator).
- Performance: full competitive eval (B+B.5+C+D+D.5) ~32 ms; two
  `evaluateTradeHorizons` calls read cached Phase-2 data; `buildLeagueThreat`
  reuses the memoized owner context.

## D5.10 Files changed (D.5)

New: `lib/trades/competitive/horizon.ts`; `test/competitive-trade-horizon.test.ts`.
Modified: `lib/trades/competitive/{schema,config,opponent-impact,threat,competitive-d-eval,evaluate}.ts`;
`scripts/competitive-trade-smoke.ts`; the doc. `evaluateTrade` NOT touched.

---

---

# Part IX — Checkpoint E: Value Extraction & Negotiation Envelope

Status: **CHECKPOINT E CERTIFIED — READY FOR CHECKPOINT F.**
Branch `competitive-trade-intelligence`, built on `6c44757`.

## E.1 The information advantage (§3)

We **negotiate** using the counterparty's *perceived* economics (owner-perceived
value received vs their reservation price) and **decide** using our private
horizon-aware permanent rest-of-season utility. A trade the counterparty already
perceives as favourable may contain unclaimed negotiation surplus. We do **not**
try to make "our private value received = our private value surrendered" — that
would destroy the point of having better information.

## E.2 Base-trade gate (`extraction.ts::baseTradeCertified`, §14)

Extraction never runs on top of a bad base transaction. The base trade must
clear: `our_permanent_utility ≥ minimum_private_gain (0.25)` · horizon
classification ≠ `REVIEW_REQUIRED` · confidence ≠ `VERY_LOW` · competitive
classification ≠ `REJECT` / `AVOID_COMPETITIVE_COST` · acceptance ≥ `LOW`. A fail
⇒ `EXTRACTION_GATED`, frontier = just the base.

**Rhamondre → Chuba stays gated (§15):** base permanent utility −3.39,
`REVIEW_REQUIRED`, competitive `REJECT` ⇒ `EXTRACTION_GATED`, `certified = false`,
no add-on search. (Verified live.)

## E.3 Value extraction (`extraction.ts::buildValueExtraction`)

```
base_perceived_surplus          the counterparty's perceived surplus in a straight swap
maximum_theoretical_extraction  = base_perceived_surplus (their whole surplus)
recommended_extraction          = base_perceived_surplus · (1 − surplus_left_with_counterparty[aggressiveness])
remaining_counterparty_surplus  = base_perceived_surplus − recommended_extraction
```

`surplus_left_with_counterparty`: `AGGRESSIVE_BUT_CREDIBLE` 0.12 / `BALANCED`
0.22 / `CONSERVATIVE` 0.35 — even aggressive mode leaves the counterparty a
positive perceived reason to accept (§27).

**Extraction bands** (§29 — not from raw surplus alone; includes the acceptance
curve and confidence): `EXTRACTION_GATED` · `NO_EXTRACTION_ROOM` (no extractable
assets, or surplus ≤ 0) · `LIMITED_EXTRACTION` (thin surplus or acceptance only
LOW — protect the base, don't squeeze) · `MODERATE_EXTRACTION` ·
`HIGH_EXTRACTION` (large surplus + HIGH acceptance + confidence ≥ MEDIUM —
`STRAIGHT_SWAP_LEAVES_VALUE_UNCAPTURED`). VERY_LOW / LOW confidence caps the
band below `HIGH_EXTRACTION` (§53).

**Secondary-asset ranking (§9–§11):** for each counterparty asset NOT in the
base and expendable (bench / rotational, or a positional surplus): their **owner
reservation price** (Checkpoint C, roster-context — NOT market value, §31) and
our private value (Checkpoint B.5). `efficiency = (our_value + 1.5) ÷
max(0.2, their_reservation + 1.0)` — favours assets **valuable to us + cheap to
them** (§10). Reason codes: `SECONDARY_ASSET_EXPENDABLE_TO_THEM`,
`SECONDARY_ASSET_HIGH_VALUE_TO_US`, `SECONDARY_ASSET_WEAKENS_RIVAL` (a starter
for a HIGH/ELITE-threat counterparty), `SECONDARY_ASSET_POOR_ROSTER_FIT` (we are
already deep at the position).

## E.4 Negotiation frontier (`negotiation.ts::buildNegotiationFrontier`)

Bounded additive search: base → base + one secondary asset (efficiency order) →
one bounded two-asset bundle probe. **Every point is a full re-evaluation** via
`evaluateCompetitiveTrade` (§33–§35): permanent utility, perceived surplus,
acceptance, opponent actual impact, competitive externality — the base ledger is
never reused. The search stops when acceptance falls below `LOW`
(`ACCEPTANCE_COLLAPSES_BEYOND_HERE`) or the next add-on's efficiency is below the
minimum. `BUNDLE_RESERVATION_RISES_SHARPLY` is flagged when their bundle
reservation jumps (§32, non-additive from Checkpoint C).

**Dominance pruning (§44):** proposal A dominates B when A is ≥ on
`our_permanent_utility`, `acceptance`, `−externality` and `confidence`, strictly
better on one. Dominated points do not survive.

## E.5 The four-level envelope (§17, §46–§49)

| level | selection |
|---|---|
| **opening_offer** | highest `our_permanent_utility` non-dominated point still clearing the aggressiveness's opening-acceptance floor (`LOW` for AGGRESSIVE_BUT_CREDIBLE). Aggressive but credible — never an unserious demand (§18). If no add-on clears it ⇒ opening = base + `DO_NOT_BID_AGAINST_SELF` (§50). |
| **target_settlement** | maximizes `our_permanent_utility − max(0, externality) − uncertainty_cost` subject to acceptance ≥ `MODERATE`. A +6 / MODERATE deal beats a +3 / HIGH deal (§25, §66 — acceptance is a feasibility gate, not a reward). |
| **acceptable_deal** | the least-favourable non-dominated point still clearing `minimum_private_gain` and not `REJECT`. Usually the base. |
| **walk_away** | explicit: `min_permanent_utility = minimum_private_gain`, plus a human-readable "walk away if we must add [asset]" / "walk away below +N weekly-equivalent, or if the competitive result turns to REJECT". |

`OVERPAY_DESTROYS_MARKET_EDGE` (§22, config `overpay_edge_retention_floor 0.4`):
if reshaping our side drops the aggregate market edge below 40 % of the base,
stop — an undervalued player is not worth any price.

## E.6 Counteroffer evaluation (`negotiation.ts::classifyCounteroffer`, §23–§24)

Same permanent-utility + competitive logic (no separate value system). The
countered proposal's `our_permanent_utility` vs the envelope: ≥ target ⇒
`ACCEPT`; between target and walk-away ⇒ `COUNTER`; below the floor or
`REJECT`-class ⇒ `WALK_AWAY`.

## E.7 Readiness / confidence (§70, §71)

`FULL_EXTRACTION_CONTEXT` / `PARTIAL_EXTRACTION_CONTEXT` / `BASE_TRADE_ONLY` /
`EXTRACTION_GATED` / `UNAVAILABLE`. Extraction being unavailable never fails the
whole trade analysis — the base trade stands. Confidence is separate from the
extraction band.

## E.8 Output contract (§72)

`evaluateCompetitiveTrade({ …, counterparty_manager_id, include_negotiation: true })`
attaches `competitive.negotiation` — `{ readiness, confidence, aggressiveness,
base_proposal, base_trade_certified, extraction, frontier[], opening_offer,
target_settlement, acceptable_deal, walk_away, reason_codes, reasons,
internal_explanation }`. Opt-in (~8–12 extra evaluations). `internal_explanation`
(why the base is worth pursuing / why they may accept / why more can be requested
/ why the frontier stops) is **internal** — no manager-facing pitch copy is
generated (§42, §56).

## E.9 Bloodline Bowl live diagnostics (week 1)

**Rhamondre → Chuba:** `EXTRACTION_GATED`, `certified = false`, frontier = base
only, opening = target = base. Reported honestly — no aggressive extraction (§74).

**§75 — "they think they won, we won more, they actually lose":** the search
found several. Example #3 — **`ezs4415` gives Patrick Mahomes → `nightfallfox`
for Jadarian Price**:
| | straight swap | extracted (base + Jonah Coleman) |
|---|---|---|
| our permanent utility | +1.91 | **+2.81** |
| their perceived surplus | +0.11 (they think they won) | −0.04 (still ~neutral) |
| acceptance | MODERATE | **MODERATE** (unchanged) |
| their ACTUAL roster impact | −2.74 (they lose) | **−3.95** (they lose more) |

Jonah Coleman's reservation to `nightfallfox` is **−0.41** (a scrub they would
dump for nothing), so requesting him barely dents their perceived surplus while
adding +0.90 to our permanent utility **and** weakening them further (§36 — a
secondary asset improves us twice). This is the entire Checkpoint E thesis on
live data.

**§76 straight-swap vs extracted package:** shown above — the extracted package
is strictly better for us on permanent utility and opponent impact at the same
acceptance likelihood.

Two `LIMITED_EXTRACTION` examples (`bijimac`/Jakobi Meyers, `theberserkfury`/
Wan'Dale Robinson, both for MarShawn Lloyd): base perceived surplus only ~+0.2 ⇒
**target settlement stays at the base** — the engine declines to risk a strong
base trade for a small squeeze (§52), while the *opening* still probes for Woody
Marks.

## E.10 Known limitations (E)

1. **~700 ms per negotiation envelope** (~8–12 full competitive re-evaluations,
   each rebuilding the 3304-player dynamic-market table + the 14-team threat
   model). Opt-in only — **not** enabled per candidate in a discovery sweep.
2. **Acceptance and reservation are heuristic** (inherited from Checkpoints C/D)
   — the frontier shape is only as good as those models; `INSUFFICIENT_TRADE_HISTORY`.
3. **Additive extraction only** — base + counterparty add-ons + one bundle probe.
   Broad our-side reshaping and multi-step manager chains are out of scope (F).
4. **Secondary-asset ranking is a pre-filter heuristic**; the full re-evaluation
   is authoritative, so a mis-ranked asset only wastes a slot, never mis-recommends.
5. No manager-facing negotiation copy (§42, deferred).

## E.11 Regression (E)

- `tsc --noEmit` clean; `eslint app lib test` 0 errors, 29 pre-existing warnings.
- `npm test`: full suite green (see final report), +13 new E tests
  (`test/competitive-trade-negotiation.test.ts`). Zero existing expectations
  changed.

## E.12 Files changed (E)

New: `lib/trades/competitive/{extraction,negotiation,negotiation-eval}.ts`;
`test/competitive-trade-negotiation.test.ts`.
Modified: `lib/trades/competitive/{schema,config,evaluate,index}.ts` (additive
+ a shared owner-context cache threaded through `evaluateCompetitiveTrade`);
`scripts/competitive-trade-smoke.ts`; the doc. `evaluateTrade` NOT touched.

---

## Checkpoint status

- [x] **A — Audit + contracts**
- [x] **B — Market edge layer** — CERTIFIED
- [x] **B.5 — Dynamic market & evidence maturation** — CERTIFIED
- [x] **C — Owner perception + reservation + acceptance** — CERTIFIED
- [x] **D — Opponent impact + threat + competitive externality + result** — CERTIFIED
- [x] **D.5 — Horizon-aware permanent-trade utility** — CERTIFIED
- [x] **E — Value extraction & negotiation envelope** — CERTIFIED
- [ ] F — Multi-hop + hold-for-appreciation + liquidity
- [ ] G — Integration / live smoke

**Freeze verdict: NOT READY TO FREEZE** (Checkpoints F–G outstanding; do not
merge/tag/deploy). Checkpoint E gate: **CERTIFIED — READY FOR CHECKPOINT F.**
