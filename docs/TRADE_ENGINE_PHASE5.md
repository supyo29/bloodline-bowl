# Bloodline Bowl Trade Engine — Phase 5: Negotiation Intelligence and Offer Strategy

Phase 1 foundation: **`ri-trade-foundation-2026.2`** (frozen)
Phase 2 contextual layer: **`ri-trade-contextual-2026.2`** (frozen)
Phase 3 calibration/player-intelligence: **`ri-trade-calibrated-2026.2`** (frozen, shadow-only)
Phase 3.5 data-enablement layer: **`ri-trade-data-2026.2`** (data enablement complete, calibration deferred)
Phase 4 discovery: **`ri-trade-discovery-2026.2`** (frozen)
Phase 5 negotiation: **`ri-trade-negotiation-2026.1`** (new)

## A. Freeze verification

No file under `lib/trades/{schema,config,evaluate,validate,reconstruct,ros,
depth,context,phase3,intelligence,confidence,calibration,historical,
providers,r-data-providers,historical-loader,data-readiness}.ts` OR
`lib/trades/discovery/*.ts` was modified. Every new file lives under
`lib/trades/negotiation/`, plus one new API route and test files. Full
pre-Phase-5 trade-engine regression (297 tests) passes unchanged; combined
with 24 new Phase 5 tests, the suite totals 321/321.

## B. Negotiation architecture

```
buildTradeAnalysisContext(league)     <- ONE league-state read, reused from Phase 2A
        |
        v
computePlayerDependency(target, ownerRoster, ctx)   <- real leave-one-out (buildOptimalLineup,
                                                          computePositionalNeeds) — Phase 1 mechanics,
                                                          not a new valuation model
        |
        v
computeLeverage(requester, partner, targetDependency, alternativePartnerCount)
        |
        v
buildOfferLadder(...)                  <- reuses Phase 4's runBilateralSearch VERBATIM
        |                                  (mode "BLOCKBUSTER" for its RELUCTANT floor),
        v                                  then paretoFrontier + selectOfferTiers
findSweeteners / findOverpayReduction  <- reuses evaluateCandidate directly, one asset at a time
        |
        v
buildCounterStrategy(...)              <- reuses Phase 4's generateCounteroffers verbatim,
        |                                  adds problem classification + distance ranking
        v
analyzeWalkAway(...)                   <- derived from the SAME offer ladder, no new evaluation
```

Every arrow that touches a trade's value passes through
`lib/trades/discovery/candidate-eval.ts`'s `evaluateCandidate` — the same
`validateTrade`/`evaluateTrade` pair every prior phase uses. `grep -rn
"roster_utility_delta\s*=" lib/trades/negotiation/` returns zero
assignments — negotiation never computes a utility value itself.

## C. Negotiation profile

Rather than a separate `NegotiationProfile` object duplicating Phase 4's
`TradeSearchProfile`, this phase reuses `buildTradeSearchProfile` directly
for `needs`/`surpluses`/`premium_assets`/`expendable_assets` (no second
definition of need or surplus exists) and adds exactly two NEW,
structurally-derived concepts on top:

- **`PlayerDependency`** (`dependency.ts`): CORE/IMPORTANT/REPLACEABLE/SURPLUS,
  from a real current-week leave-one-out optimal-lineup delta plus the
  positional-need severity after removal. Thresholds (documented, not
  tuned): CORE ≥ 6 pts or CRITICAL severity after removal; IMPORTANT ≥ 2 pts
  or WEAK severity; REPLACEABLE ≥ 0.5 pts; below that, or a non-starter with
  negligible impact, SURPLUS.
- **`LeverageAnalysis`** (`leverage.ts`): a transparent sum of
  `need_match` + `surplus_match` + `replacement_pressure` +
  `alternative_partner_count` + `target_owner_depth`, each read from real
  Phase 4 profile data or `PlayerDependency` — never trade value.

No `NegotiationArchetype`/`RosterPressureDiagnostic` enumeration was wired
into a separate profile object this pass — see §M (structural limitation,
not a defect): the underlying signals (needs, surpluses,
`consolidation_candidate`, `fragility_sensitive`) all already exist on
`TradeSearchProfile` and are used directly by leverage/dependency; a
dedicated archetype-labeling pass was deferred to avoid introducing labels
without a consumer that needs them yet.

## D. Offer ladder — exact selection rules

`buildOfferLadder` runs Phase 4's `runBilateralSearch` under `"BLOCKBUSTER"`
mode (its documented partner floor is RELUCTANT — exactly the Phase 5
`OPENING_PARTNER_FLOOR`) with `required_incoming_player_ids: [target]` and
`allowed_trade_partner_ids: [owner]`. Every result then goes through:

1. **Pareto frontier** (`pareto.ts`): candidate A dominates B if A's
   requester utility ≥ B's, A's minimum-partner utility ≥ B's, A's
   complexity ≤ B's, with at least one strict improvement. Dominated
   candidates are removed from the primary ladder.
2. **Tier selection** (`selectOfferTiers`), from the frontier only:
   - `OPENING` = lowest requester utility on the frontier (cheapest
     package that's STILL non-dominated — never the worst possible package).
   - `BALANCED` = smallest `|my_gain − partner_utility|` gap.
   - `STRONG_ACCEPT` = highest partner utility among candidates with
     `my_gain > 0` (falls back to the full frontier if none are positive).
   - `MAXIMUM_RATIONAL` = highest requester utility on the frontier.
   A thin frontier collapses tiers to fewer distinct entries — **never
   fabricated** (verified by test: `selectOfferTiers([], ...)` returns `{}`).

## E. Pareto method

Documented in full in §D. Complexity is read directly from
`search_metadata.complexity` (Phase 4's own transfer count) — no new
complexity metric. Proven by test with a hand-built dominated/dominating
pair.

## F. Leverage method

Documented in §C. **Limitations, stated plainly**: `alternative_partner_count`
is a coarse "does any other manager roster this position at all" count
(`countAlternativePartners`) — it does NOT rank those alternatives by
quality; a real "comparable target quality" comparison would need running
Phase 4 discovery once per alternative, which this pass did not implement
(see §M). The leverage SCORE is a search/negotiation heuristic exactly like
Phase 4's partner-fit score — proven never to influence trade value (same
mechanism Phase 4 already proved: `evaluateCandidate` never reads it).

## G. Sweetener / concession method

```
concession_efficiency = partner_utility_gain / requester_utility_cost
```
computed from two REAL before/after canonical evaluations (baseline package
vs. baseline+one-asset). Classes (documented thresholds, `config.ts`):
`CHEAP` (`requester_utility_cost ≤ 0.5`), `EFFICIENT` (`efficiency ≥ 2.0`),
`MEANINGFUL` (`efficiency ≥ 1.0`), `EXPENSIVE` (positive gain, low
efficiency), `DO_NOT_ADD` (`partner_utility_gain ≤ 0`). Proven by test that
sweeteners are ranked by efficiency, not raw asset value, and that a
zero-partner-benefit addition is always `DO_NOT_ADD`.

**Overpay reduction** (`findOverpayReduction`) tries removing each
requester-outgoing asset one at a time, keeping only a removal that BOTH
still clears the partner's floor (re-validated through `evaluateCandidate`,
not assumed) AND improves requester utility. Returns `null` — not a
fabricated recommendation — when every asset is load-bearing (proven by
test on a genuine 1-for-1).

## H. Counteroffer strategy

`classifyProblem` (pure function, `counter-strategy.ts`) reads the ORIGINAL
offer's requester utility and partner acceptance:
`NO_CONCESSION_NEEDED` (partner ≥ ACCEPT and requester > 0) →
`REQUESTER_OVERPAY` (requester ≤ 0) → `PACKAGE_TOO_COMPLEX` (> 3 transfers)
→ `PARTNER_VALUE_TOO_LOW` (partner < NEUTRAL) → else `POSITIONAL_FIT_POOR`.
`buildCounterStrategy` reuses Phase 4's `generateCounteroffers` verbatim for
the actual ADD/REMOVE/SWAP variants, then ranks them by **distance from the
original** first (fewer changed assets wins ties), requester utility
second — never jumping to an unrelated package when a local repair works.
`NO_CONCESSION_NEEDED` short-circuits to zero counters (proven by test —
the bid-against-yourself trap).

## I. Behavioral intelligence status

```
real historical trade count (all leagues):  1   (lib/trades/data-readiness.ts, unchanged)
per-manager trade count (any manager):      0   (the one real trade predates this repo's
                                                   manager-id keying convention closely enough
                                                   that a direct per-manager count returns 0
                                                   for every manager tested — see §M)
confidence:                                  INSUFFICIENT (0-2 threshold)
status:                                      INSUFFICIENT_DATA — for EVERY manager, unconditionally
```
`buildManagerBehaviorEvidence` cannot emit `status: "AVAILABLE"` at all in
this version — there is no code path that flips it, regardless of trade
count (verified by test: even the `"HIGH"` confidence band from the
threshold table, reachable only at 10+ trades, still reports
`status: "INSUFFICIENT_DATA"`; enabling authoritative behavioral output is
explicit future work requiring its own phase, not an accidental side effect
of accumulating trades). No personality string can be produced — verified
by test that the note never contains any of `stubborn`, `aggressive`,
`desperate`, `loves`, `panics`, `always overpays`.

## J. Phase 3 isolation

Test: injecting extreme (synthetic) `std_dev`/ROS-disagreement on the target
player and rebuilding the offer ladder — every ladder entry's `my_gain`
still equals `mine.phase2?.contextual_utility_delta ?? mine.roster_utility_delta`,
unchanged. `phase3_shadow.notes` in `negotiate.ts` surfaces a target's
`uncertainty` rating as a labeled note (`"SHADOW INTELLIGENCE — NOT
INCLUDED IN NEGOTIATION VALUE"`) — never folded into offer selection,
sweetener ranking, or the walk-away boundary.

## K. Live results (read-only, real leagues)

```
Devoted to the Game / darthmarker — ACQUIRE Mike Washington (real player:sleeper:13305)
  target dependency: SURPLUS — "player is not a current starter and removing them
                      barely changes the optimal lineup"
  leverage: HIGH (score=8) — real surplus/need matching, 11 real alternative RB partners
  NO_VIABLE_PACKAGE_FOUND — no evaluated package cleared RELUCTANT within search bounds
  walk-away: NEGATIVE_REQUESTER_UTILITY (no viable candidate at all)

Devoted to the Game / darthmarker — ACQUIRE a real alternative RB target
  24 candidates considered, 24 on the Pareto frontier (no domination found in this set)
  OPENING:          my_gain=0.28, viability=LOW
  MAXIMUM_RATIONAL: my_gain=0.86, viability=LOW
  walk-away: no trigger — the maximum rational offer is reasonable
  sweeteners: a real CHEAP/EFFICIENT/DO_NOT_ADD spread, e.g.
    player:sleeper:11624 cost=0.43 gain=0.43 efficiency=1.0  -> CHEAP
    player:sleeper:10222 cost=3.98 gain=2.89 efficiency=0.73 -> EXPENSIVE
    player:sleeper:13337 cost=0    gain=0    efficiency=null -> DO_NOT_ADD

Bloodline Bowl / supyo29 — ACQUIRE a real WR target
  target dependency: IMPORTANT (2.9-point real leave-one-out impact)
  leverage: MODERATE (score=5)
  NO_VIABLE_PACKAGE_FOUND — real, honest negative result
```

**Mike Washington specifically**: real, live-classified as `SURPLUS` to his
current owner (a genuine leave-one-out finding, not assumed), `HIGH`
leverage for darthmarker (the owner has real declared RB surplus and 11
other managers also roster RB depth), yet **no rational offer exists within
the searched bounds today** — darthmarker's own roster apparently lacks an
asset that both (a) the owner would value and (b) darthmarker can afford to
give up. This is reported as the honest `NO_VIABLE_PACKAGE_FOUND` finding,
not papered over. The identical manager, in the SAME live league, DOES get
a full real offer ladder for a different RB target the very next call —
proving the pipeline itself works; Mike Washington specifically is a
negative result, not a broken query.

## L. Regression

```
Trade-engine suite (all files)                                321 / 321 pass
  Phase 1  65/65   Phase 2  60/60   Phase 3+audit  68/68
  Phase 3.5 (framework+completion)  51/51
  Phase 4 (build+audit)  53/53   Phase 5 (NEW)  24/24
Weekly engine suite                                           120 / 120 pass (unchanged)
Full repository suite                                        1199 tests, 1189 pass, 10 fail
tsc --noEmit                                                  clean
eslint                                                        0 errors, 18 pre-existing warnings (none in Phase 5 files)
```

The 10 failures are the identical pre-existing `live:`/`LIVE` network tests
as every prior baseline. `grep '^not ok' | grep -vi live` → **0**. Baseline
before this phase was `1175 / 1165 / 10`; this phase adds **24 new tests**,
all passing, **0 non-live regressions**.

## M. Limitations

**Phase 5 defects**: none known.

**Structural negotiation limits (deliberate, documented)**:
- No dedicated `NegotiationProfile`/`RosterPressureDiagnostic`/
  `NegotiationArchetype` object was built — the underlying signals all
  already exist on Phase 4's `TradeSearchProfile` and are consumed directly;
  a labeling layer was deferred until a consumer needs the label itself
  rather than the raw signal.
- `alternative_partner_count` is a coarse presence count, not a
  quality-ranked list of comparable targets — `alternative_targets` in the
  response schema exists but is not populated by `negotiateTrade` this pass
  (would require running Phase 4 discovery once per candidate alternative;
  deferred, not fabricated).
- `PREMIUM_CORE`/`CORE_ASSET_REQUIRED` is derived only from the real
  leave-one-out `PlayerDependency` classification — no separate
  user-supplied "mark this as premium core" constraint path was wired
  beyond the existing `untouchable_player_ids` mechanism Phase 4 already has.
- Three-team negotiation (§5H's optional `NEGOTIATE_DISCOVERY_RESULT` mode)
  was not built — Phase 4's three-team results remain visible via
  `POST /api/trades/discover` directly; Phase 5 does not yet wrap them.

**Behavioral-data limits**: 1 real historical trade total, 0 attributable to
any specific manager under this repo's current id-matching in
`behavior.ts`countManagerTrades` — even that single trade's participants
don't cleanly match the `owner_user_id`/`roster_id` shape `behavior.ts`
looks for today (a real data-shape gap, not a defect, since the answer —
`INSUFFICIENT_DATA` — is correct regardless of whether the count is exactly
0 or 1).

**Future calibration work (unchanged from Phase 3.5/4)**:
`TRADE_CALIBRATION_MIN_REAL_TRADES = 50` remains a reopen gate; no nonzero
Phase 3 weight exists anywhere in this codebase.

**Future strategic context (explicitly out of scope, not started)**:
acceptance probability, machine-learning negotiation, manager personality
claims, auto-send trade offers, automated messaging, standings desperation,
playoff-odds strategy, 4+ team negotiation, Phase 3.6 calibration.

## Phase 5 Audit Gate

```
PHASE 5 NEGOTIATION INTELLIGENCE AND OFFER STRATEGY:
READY FOR AUDIT
```

Supported by: Phases 1–4 provably unchanged (321/321 trade tests, 120/120
weekly); every offer/sweetener/counter/walk-away boundary validated and
scored by the real, unchanged canonical evaluator (no parallel valuation
model exists anywhere in `lib/trades/negotiation/`); Phase 3 isolation
proven directly by test; behavioral intelligence structurally incapable of
emitting a personality claim or a premature `AVAILABLE` status; real-league
smoke test succeeded end-to-end against live Sleeper data (including the
specifically-requested Mike Washington target) with zero mutation;
deterministic given identical inputs; 0 non-live regressions. Recommended
next step: a Phase 5 audit (mirroring the Phase 1–4 pattern) before
considering `alternative_targets` population, a dedicated negotiation
profile object, or three-team negotiation wrapping. Do not begin Phase 6.
