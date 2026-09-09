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

## Checkpoint status

- [x] **A — Audit + contracts**
- [x] **B — Market edge layer** — CERTIFIED
- [x] **B.5 — Dynamic market & evidence maturation** — CERTIFIED
- [ ] C — Owner perception + acceptance
- [ ] D — Competitive optimizer
- [ ] E — Negotiation engine
- [ ] F — Multi-hop + hold-for-appreciation
- [ ] G — Integration / live smoke

**Freeze verdict: NOT READY TO FREEZE** (Checkpoints C–G outstanding; do not
merge/tag/deploy). Checkpoint B.5 gate: **CERTIFIED — READY FOR CHECKPOINT C.**
