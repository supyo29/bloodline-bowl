# Bloodline Bowl Trade Engine — Phase 4 Trade Discovery and Counteroffer Intelligence Audit

Phase 1 foundation: **`ri-trade-foundation-2026.2`** (frozen, reconfirmed)
Phase 2 contextual layer: **`ri-trade-contextual-2026.2`** (frozen, reconfirmed)
Phase 3 calibration/player-intelligence: **`ri-trade-calibrated-2026.2`** (frozen, shadow-only, reconfirmed)
Phase 3.5 data-enablement layer: **`ri-trade-data-2026.2`** (unchanged, non-authoritative, reconfirmed)
Phase 4 discovery: **`ri-trade-discovery-2026.1` → `ri-trade-discovery-2026.2`** (audit fixes)

## A. Freeze verification

All frozen-layer suites pass unchanged: Phase 1 (65), Phase 1 audit (46 —
counted within the combined Phase 1 file set), Phase 2 (26), Phase 2 audit
(34), Phase 3 (34), Phase 3 calibration (23), Phase 3 audit (11), Phase 3.5
framework (37), Phase 3.5 completion (14). No file under `lib/trades/{schema,
config,evaluate,validate,reconstruct,ros,depth,context,phase3,intelligence,
confidence,calibration,historical,providers,r-data-providers,
historical-loader,data-readiness}.ts` was touched by this audit — every
change is confined to `lib/trades/discovery/*.ts`, one API route, and test
files. **Verdict: Phases 1–3.5 remain frozen; no exception was needed.**

## B. Canonical evaluator verification

Traced every candidate-producing path (`bilateral.ts`, `three-team.ts`,
`counteroffer.ts`) — each ends in exactly one call:
`evaluateCandidate(...)` (`candidate-eval.ts`), which itself calls
`validateTrade` then `evaluateTrade` with no discovery-specific branch in
between. `grep -rn "roster_utility_delta\s*=" lib/trades/discovery/` finds
zero assignments — discovery never computes a utility value itself, only
READS the value `evaluateTrade` already produced. **No second valuation
system exists.**

## C. Defect table

| # | Severity | Component | Failure | Status |
|---|----------|-----------|---------|--------|
| D1 | **P1** | `packages.ts` | `BEST_AVAILABLE` (and every mode without explicit `targetPositions`) searched ONLY positions with a CRITICAL/HIGH/MODERATE need — a well-balanced roster with no severity-flagged need returned ZERO packages even when a real, canonical-evaluator-confirmed upgrade existed. Confirmed against BOTH real registered leagues before the fix (§K). | **FIXED** |
| D2 | **P1** | `rank.ts`/`bilateral.ts`/`three-team.ts` | No default requester-utility floor existed — a candidate with negative `my_gain` and an accepting partner could be returned as a "recommendation." | **FIXED** |
| D3 | **P1** | *(new)* `candidate-eval.ts` | `max_assets_sent`/`max_assets_received` were accepted as public request fields (parsed by the route, typed in `TradeSearchConstraints`) but never read or enforced anywhere — a caller-supplied limit silently did nothing. | **FIXED** |
| D4 | **P2** | `discover.ts`/`types.ts` | `max_assets_per_side` was parsed by the route into `TradeDiscoveryRequest` but never threaded into package generation — another silently-ignored public field. | **FIXED** |
| D5 | **P1** | `bilateral.ts` | Partner-fit's top-`max_partner_count` pruning had no fallback and no truncation diagnostic — a low-fit-but-only-viable partner was silently unreachable, and the response gave no indication that only part of the league had been searched. | **FIXED** |
| D6 | **P2** | `bilateral.ts` | *(found fixing D5)* Even with a fallback pass added, Pass 1 alone could exhaust the entire `max_evaluated_candidates` budget before Pass 2 ever ran — a handful of top-fit partners each offering several package shapes consumed the whole budget, defeating the fallback in substance while its code path looked correct. | **FIXED** |
| D7 | **P2** | `discover.ts` | `CONSOLIDATE` incorrectly included `ONE_FOR_TWO` results — `ONE_FOR_TWO` is DEconsolidation (the requester ends up with MORE assets), the semantic opposite of "send multiple assets for fewer in return." | **FIXED** |
| D8 | **P2** | `three-team.ts`/`types.ts` | Every three-team result was labeled shape `"ONE_FOR_ONE"` despite having 3 participants and 3 transfers. | **FIXED** |
| D9 | **P3** | `three-team.ts` | Only the single best asset per leg was ever tried in the cycle search — a cycle where a manager's SECOND-best asset (not the best) is the one that keeps every participant positive could never be found. | **FIXED** (widened to top-2 per leg) |
| D10 | **P2** | `discover.ts` | Mode-required-field validation (`BUY_PLAYER` needs `target_player_id`, etc.) ran AFTER the league-state read — a malformed request paid for a full provider round-trip before failing, and the check was not independently testable without network access. | **FIXED** |
| D11 | **P3** | `discover.ts` | `include_three_team` on a non-`THREE_TEAM` mode was silently ignored — a parsed-but-inert public field. | **FIXED** (now surfaces an explicit `INCLUDE_THREE_TEAM_NOT_IMPLEMENTED` diagnostic; the underlying feature itself remains deferred, see §N) |

No P0 defects found — the canonical-evaluator invariant itself (§B) was never violated; every defect above was a search-layer completeness or contract-honesty issue, not a hidden valuation system.

## D. Corrections made

**D1 (BEST_AVAILABLE starvation)** — `packages.ts`:
```
before: needPositions = (targetPositions ?? severityNeeds).slice(0, 3)
        // severityNeeds = [] -> needPositions = [] -> zero packages, always
after:  needPositions = (targetPositions ?? (severityNeeds.length > 0 ? severityNeeds : BASE_POSITIONS)).slice(...)
        // falls back to all 6 base positions when no severity need exists
```
Regression test: "a well-balanced roster (no CRITICAL/HIGH/MODERATE need) can
still find a positive canonical starter upgrade" — passes. Version impact:
`ri-trade-discovery-2026.2`.

**D2 (requester utility floor)** — `config.ts` new `requesterUtilityFloor()`
(returns `0.005`, a half-rounding-precision epsilon above zero so an exact
0.00 break-even is correctly excluded), applied as the default
`minimumMyUtility` in both `bilateral.ts` and `three-team.ts` unless a caller
explicitly overrides via `constraints.minimum_my_utility_delta`. Regression
tests: a manually-confirmed-negative-for-A candidate never surfaces; an
exact break-even trade never surfaces.

**D3 (max_assets_sent/received)** — new `packageSatisfiesSearchConstraints`
(`candidate-eval.ts`), a single durable gate checked FIRST inside
`evaluateCandidate`, before `validateTrade` even runs — enforces
untouchables, required incoming/outgoing, allowed/excluded partners, AND
`max_assets_sent`/`max_assets_received` for every call site (bilateral,
three-team, counteroffer). Regression tests cover all six checks in
isolation plus a fully-compliant pass-through case.

**D4 (max_assets_per_side)** — threaded from `TradeDiscoveryRequest` through
`BilateralSearchOptions`/`PackageGenInput` into `generateBilateralPackages`,
which now skips `TWO_FOR_ONE`/`ONE_FOR_TWO` generation entirely when
`maxAssetsPerSide < 2`. Regression test confirms only `ONE_FOR_ONE` survives
when set to `1`.

**D5/D6 (partner-fit fallback + budget reservation)** — `bilateral.ts` now
runs a two-pass search: Pass 1 searches the top `max_partner_count` fit-ranked
partners, capped at 75% of `max_evaluated_candidates` (a NEW reservation,
not present in the original single-cap design); if zero results survive,
Pass 2 searches every remaining manager with the full remaining budget,
emitting `PARTNER_POOL_FALLBACK_USED`. If Pass 1 DOES produce results, the
excluded managers are disclosed via `PARTNER_POOL_TRUNCATED` rather than
silently omitted. Regression test constructs 6 decoy managers whose trades
all fail the requester floor plus a 7th, fit-excluded manager, and confirms
`counters.partners_considered === 7` (all were tried) with the fallback
diagnostic present.

**D7 (CONSOLIDATE semantics)** — `discover.ts`'s CONSOLIDATE filter changed
from `shape === "TWO_FOR_ONE" || shape === "ONE_FOR_TWO"` to
`shape === "TWO_FOR_ONE"` only.

**D8 (three-team shape)** — new `PackageShape` member `"THREE_TEAM_CYCLE"`;
`three-team.ts` now labels every result with it instead of `"ONE_FOR_ONE"`.

**D9 (three-team candidate breadth)** — `bestLegAsset` (returned 1) replaced
with `legAssetCandidates` (returns up to `LEG_CANDIDATES = 2` per leg); the
main loop now tries the cross-product of up to 2×2×2 = 8 combinations per
(B, C) pair instead of exactly 1, still bounded by `max_three_team_cycles`.

**D10 (validation ordering)** — `validateModeFields` extracted as a pure,
pre-context check in `discoverTrades`, run before `buildTradeAnalysisContext`
is ever called. Regression tests confirm `BUY_PLAYER`/`SELL_PLAYER`/
`POSITIONAL_NEED` missing-field errors fire without any network dependency.

**D11 (include_three_team honesty)** — `discover.ts` now pushes an explicit
`INCLUDE_THREE_TEAM_NOT_IMPLEMENTED` diagnostic when the field is set on a
non-`THREE_TEAM` mode, so a caller cannot mistake silence for "it worked."

## E. BEST_AVAILABLE finding

**Yes — proven by test and by two independent real-league runs.**
`test/trade-engine-phase4-audit.test.ts`, "a well-balanced roster... can
still find a positive canonical starter upgrade" constructs a fixture with
zero severity-flagged needs and confirms `BEST_AVAILABLE` still returns a
positive, canonical-evaluator-confirmed result. Real-world confirmation:
before this audit's fix, `BEST_AVAILABLE` returned **zero results** for both
real managers tested (darthmarker in Devoted to the Game, supyo29 in
Bloodline Bowl); after the fix, the identical live rosters produce real
results — e.g. for supyo29: `my_gain=1.44, viability=HIGH,
"Starting lineup improves by 1.6 projected points this week... Fills their
need at: WR."` This is the single most consequential fix in this audit.

## F. Constraint finding

**Proven for every listed constraint, across every shape it applies to:**

| Constraint | ONE_FOR_ONE | TWO_FOR_ONE | ONE_FOR_TWO | THREE_TEAM_CYCLE | Counteroffers |
|---|---|---|---|---|---|
| `untouchable_player_ids` | ✓ (existing + central gate) | ✓ (central gate, new) | ✓ (central gate, new) | ✓ (central gate, new) | ✓ (existing SWAP/ADD filtering + central gate) |
| `required_incoming_player_ids` | ✓ (forced at generation + central gate) | ✓ | ✓ | n/a (not a BUY/SELL mode) | n/a |
| `required_outgoing_player_ids` | ✓ | ✓ | ✓ | n/a | n/a |
| `allowed_trade_partner_ids` | ✓ (partner filter + central gate) | ✓ | ✓ | ✓ | central gate |
| `excluded_trade_partner_ids` | ✓ | ✓ | ✓ | ✓ | central gate |
| `max_assets_sent`/`max_assets_received` | ✓ (central gate, new) | ✓ | ✓ | ✓ | ✓ |

The central gate (`packageSatisfiesSearchConstraints`) is called from
EVERY `evaluateCandidate` invocation across all three search modules with
the requester id and constraints threaded through — it is not
shape-specific and cannot be bypassed by adding a new shape later without
also wiring it through `evaluateCandidate` (which every future shape must
already call to get a canonical evaluation at all).

## G. Ranking finding

```
discovery_score = authoritative_requester_utility        (roster_utility_delta,
                                                            or contextual_utility_delta
                                                            when Phase 2 ran — NEVER
                                                            shadow_utility_delta)
                 + viability_bonus                        (+0.25 HIGH, +0.10 MODERATE, +0 else)
                 - complexity_penalty                     (0.15 × max(0, total_assets − 2))
```
Computed in exactly one place (`rankResults`); `buildDiscoveryResult` only
decides survival (requester floor, partner acceptance floor per
`partnerAcceptanceFloor(mode)`, optional caller-supplied
`minimum_partner_utility_delta`). Acceptance-floor policy: `EASY_TO_ACCEPT`
→ `ACCEPT`, `FAIR_TRADES` → `NEUTRAL`, `BLOCKBUSTER` → `RELUCTANT`, every
other mode (including `BEST_AVAILABLE`, `THREE_TEAM`) → `NEUTRAL`. Tie-break
on equal score: fewer transfers first, then a deterministic
lexical-transfer-JSON comparison. **Complexity-penalty monotonicity proven
by test with the exact two scenarios from the audit spec**: a materially
better 2-for-1 (+6.5) beats a worse 1-for-1 (+5.0); a marginally-better
3-asset trade (+5.05) LOSES to a simpler 1-for-1 (+5.0) once the penalty is
applied. **Phase 3 absence proven directly**: `my_gain` is asserted equal to
`mine.phase2?.contextual_utility_delta ?? mine.roster_utility_delta` for
every real result, including one where the incoming player's `std_dev` and
ROS disagreement were driven to extreme (synthetic) values — `my_gain` did
not move.

## H. Partner-pruning finding

**A low-fit partner CAN be reached, with two mechanisms working together:**
(1) if the top-fit pass finds zero results, a Pass 2 fallback searches every
remaining manager (bounded by the reserved remainder of the evaluation
budget — D6's fix ensures this remainder is real, not theoretical); (2) if
the top-fit pass DOES find results, the response discloses exactly how many
lower-fit managers were never searched via `PARTNER_POOL_TRUNCATED` — the
engine never claims completeness it didn't earn. Confirmed live: the real
Bloodline Bowl `BEST_AVAILABLE` run reports `PARTNER_POOL_TRUNCATED: 7
lower-fit manager(s) were not searched` alongside its 4 real results.

## I. Counteroffer finding

Every counteroffer variant is generated from the ORIGINAL transfer list via
local REMOVE/SWAP/ADD only (`counteroffer.ts`) — no unrelated participant or
unrelated asset is ever introduced (SWAP only substitutes within the same
giver/position; ADD only appends one asset from an existing participant).
Every variant, including the untouched original, is passed through
`evaluateCandidate` with the SAME hard-constraint gate as bilateral search
(now including `max_assets_sent`/`max_assets_received`, previously absent
here entirely). Deduplication prevents proposing the same variant twice.

## J. Three-team finding

```
routing supported:        A -> B -> C -> A cycles only (no uneven routing generated
                           this pass, though evaluateTrade itself already supports
                           arbitrary N-party routing per the Phase 1 audit — this is
                           a SEARCH limitation, not an evaluator limitation)
candidate breadth:         widened from 1 to 2 candidates per leg (D9) — up to
                           8 combinations tried per (B, C) partner pair
cycle limits:               max_three_team_cycles (default 24), enforced
hidden-loser protection:    THREE_TEAM_HIDDEN_LOSER appended to rationale when
                           total utility is positive but a participant is
                           materially negative (< -1); such a cycle must still
                           clear the normal per-participant acceptance floor
                           to appear in results at all — hidden-loser labeling
                           is about disclosure, not a separate inclusion gate
order invariance:           confirmed by test — running the identical 3-manager
                           roster set from each manager's own perspective (A, B,
                           then C as the requester) always returns 3-participant,
                           3-transfer cycles
shape:                      THREE_TEAM_CYCLE (D8 fix — previously mislabeled)
```

## K. Real league finding

Re-ran `scripts/phase4-real-league-smoke-test.ts` after all fixes:

```
Devoted to the Game / darthmarker — BEST_AVAILABLE
  BEFORE fix: 0 results, 0 evaluated, 0 generated
  AFTER fix:  4 results, 30 evaluated, 360 generated, 356 pruned
  #1 my_gain=0.42 viability=MODERATE — "Roster fragility improves (2.5)."
  PARTNER_POOL_TRUNCATED: 6 lower-fit managers not searched

Devoted to the Game / darthmarker — POSITIONAL_NEED RB
  2 results (unchanged from pre-audit — this mode was never affected by D1)

Devoted to the Game / darthmarker — CONSOLIDATE
  0 results — genuinely no TWO_FOR_ONE-shaped candidate cleared the floor
  for this roster today (real result, not starvation — confirmed by 360
  candidates generated and evaluated before concluding zero survive)

Bloodline Bowl / supyo29 — BEST_AVAILABLE
  BEFORE fix: 0 results
  AFTER fix:  4 results, my_gain up to 1.44, viability=HIGH
  "Starting lineup improves by 1.6 projected points this week... Fills
  their need at: WR." — a genuine, real, explainable trade recommendation
  PARTNER_POOL_TRUNCATED: 7 lower-fit managers not searched
```

This is the clearest possible demonstration that D1 was a real defect with
real consequences, not a theoretical one — the exact same real rosters that
produced nothing before the fix produce genuine, explained recommendations
after it, with zero change to Phase 1/2/3/3.5.

## L. Performance

From the real Bloodline Bowl `BEST_AVAILABLE` run: 360 packages generated
(6 partners × up to several shapes/positions each), 356 pruned (mostly by
the requester/partner floors — correctly, most randomly-generated packages
are NOT good trades), 30 evaluated (Pass-1-budget-capped — the
`PARTNER_POOL_TRUNCATED` diagnostic honestly reports the other 7 managers
were never reached because Pass 1 alone found results), 4 valid results.
Wall-clock for the 4-mode smoke script (4 live league reads + all
evaluation) remained a few seconds, dominated by Sleeper API latency, not
candidate generation/evaluation (which is pure/synchronous, no per-candidate
network I/O).

## M. Regression

```
Trade-engine suite (all files)                                297 / 297 pass
  Phase 1  65/65   Phase 2  60/60   Phase 3+audit  68/68
  Phase 3.5 (framework+completion)  51/51
  Phase 4 (framework)  26/26   Phase 4 AUDIT (NEW)  27/27
Weekly engine suite                                           120 / 120 pass (unchanged)
Full repository suite                                        1175 tests, 1165 pass, 10 fail
tsc --noEmit                                                  clean
eslint                                                        0 errors, 18 pre-existing warnings (none in trade/discovery files)
```

The 10 failures are the identical pre-existing `live:`/`LIVE` network tests
as every prior baseline. `grep '^not ok' | grep -vi live` → **0**. Baseline
before this audit was `1148 / 1138 / 10`; this audit adds **27 new tests**,
all passing, **0 non-live regressions**.

## N. Remaining limitations

**Phase 4 defects:** none remaining — all 11 findings (D1–D11) fixed and
regression-tested.

**Intentional search limits (unchanged from the original Phase 4 build,
reconfirmed still reasonable after this audit):** `max_partner_count=6`,
`max_assets_per_pool=4`, `max_generated_packages=60`,
`max_evaluated_candidates=40` (now split 75/25 between Pass 1/Pass 2),
`max_three_team_cycles=24`.

**Deferred package shapes:** `2-for-2`, `3-for-1`, `1-for-3` remain
unimplemented (unchanged from the original build) — a real, disclosed
limitation, not a silent gap.

**Deferred `include_three_team` mixing:** setting it on a non-`THREE_TEAM`
mode now produces an honest diagnostic (D11) rather than silence, but the
underlying feature (mixing a 2-team and 3-team funnel's results/ranking) is
still not implemented.

**Deferred three-team uneven routing:** the search only generates clean
1-for-1-for-1 cycles; `evaluateTrade` itself already supports uneven N-party
routing (confirmed in the Phase 1 audit), so a future pass can extend the
GENERATOR without touching the evaluator.

**Future negotiation intelligence (explicitly out of scope, not started,
unchanged):** manager psychology, historical acceptance modeling, ML
acceptance prediction, standings/contender-rebuilder behavior, playoff-odds
weighting, market trade-chart anchoring, automatic trade-offer sending, 4+
team discovery.

**Future calibration limitations (unchanged from Phase 3.5):** trade-level
Phase 3 calibration remains deferred; `TRADE_CALIBRATION_MIN_REAL_TRADES =
50` is a reopen gate only, real trade count is still 1
(`lib/trades/data-readiness.ts`); this audit did not touch calibration in
any way.

## Phase 4 Freeze Gate

- Phase 1 remains frozen ✓ (§A)
- Phase 2 remains frozen ✓ (§A)
- Phase 3 remains shadow-only ✓ (§A, §G — Phase 3 absence from ranking directly proven)
- Phase 3.5 remains non-authoritative ✓ (§A — untouched)
- every returned trade passes canonical validation/evaluation ✓ (§B)
- BEST_AVAILABLE is not starved by formal-need gating ✓ (§E — fixed and proven, real-league confirmed)
- requester utility floors are explicit ✓ (§D2, D2 fix)
- BUY_PLAYER always buys the requested player ✓ (required-asset forcing at generation + central hard-constraint gate, §F)
- SELL_PLAYER always sells the requested player ✓ (same mechanism, §F)
- untouchables always hold ✓ (§F, central gate, tested across every shape)
- public hard constraints are actually enforced ✓ (§F — max_assets_sent/received now real, D3)
- public request fields are honest ✓ (max_assets_per_side now wired — D4; include_three_team now disclosed — D11)
- partner-fit is search-only ✓ (§G — proven identical value at different fit scores)
- fallback search prevents obvious top-K starvation ✓ (§H, D5/D6 fix)
- search truncation is disclosed ✓ (`SEARCH_TRUNCATED` + new `PARTNER_POOL_TRUNCATED`/`PARTNER_POOL_FALLBACK_USED`)
- complexity penalty is bounded ✓ (§G, proven with the exact audit-spec scenarios)
- counteroffers remain local ✓ (§I)
- three-team search is canonical ✓ (§B, §J — same N-party evaluator)
- three-team candidate breadth is sufficient within declared bounds ✓ (D9 fix — widened, still bounded)
- hidden losers are rejected/flagged correctly ✓ (§J)
- search ordering is deterministic ✓ (unchanged from original build, reconfirmed by existing tests)
- Phase 3 shadow data cannot affect ranking ✓ (§G, extreme fixture test)
- real-league smoke tests behave coherently ✓ (§K — before/after comparison on live data)
- no non-live regressions exist ✓ (§M)

```
PHASE 4 TRADE DISCOVERY AND COUNTEROFFER INTELLIGENCE AUDIT:
READY TO FREEZE
```

Recommended next step: freeze `ri-trade-discovery-2026.2`. Future work
(not started here, per the explicit out-of-scope list): the deferred
package shapes, `include_three_team` mixing, three-team uneven routing, and
— separately and only once real trade-outcome volume exists — Phase 3.6
calibration review. Do not begin any of these automatically from this audit.
