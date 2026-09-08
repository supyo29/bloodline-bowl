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

## Checkpoint status

- [x] **A — Audit + contracts** (this document)
- [ ] B — Market edge layer
- [ ] C — Owner perception + acceptance
- [ ] D — Competitive optimizer
- [ ] E — Negotiation engine
- [ ] F — Multi-hop + hold-for-appreciation
- [ ] G — Integration / live smoke

**Freeze verdict: NOT READY TO FREEZE** (audit only; no implementation yet).
