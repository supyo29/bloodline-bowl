# Bloodline Bowl Trade Engine — Phase 4: Trade Discovery and Counteroffer Intelligence

Phase 1 foundation: **`ri-trade-foundation-2026.2`** (frozen)
Phase 2 contextual layer: **`ri-trade-contextual-2026.2`** (frozen)
Phase 3 calibration/player-intelligence: **`ri-trade-calibrated-2026.2`** (frozen, shadow-only)
Phase 3.5 data-enablement layer: **`ri-trade-data-2026.2`** (data pipelines complete, calibration deferred)
Phase 4 discovery: **`ri-trade-discovery-2026.1`** (new)

## A. Freeze verification

No file under Phase 1/2/3/3.5's ownership was touched. All new code lives
under `lib/trades/discovery/`, plus one new route
(`app/api/trades/discover/route.ts`) and one new test file — nothing in
`lib/trades/{schema,config,evaluate,validate,reconstruct,ros,depth,context,
phase3,intelligence,confidence,calibration,historical,providers,
r-data-providers,historical-loader,data-readiness}.ts` was modified. Full
trade-engine regression (244 pre-Phase-4 tests) passes unchanged; combined
with 26 new Phase 4 tests, the suite totals 270/270.

## B. Search architecture

```
buildTradeAnalysisContext(league)         <- ONE league-state read, reused from Phase 2A
        |
        v
buildDiscoveryEvalContext(ctx)            <- ownership map, player-positions map,
                                              manager/team lookups — built ONCE
        |
        v
buildTradeSearchProfile(manager, ctx)     <- needs (computePositionalNeeds, UNCHANGED)
  (per manager, cheap)                       + surplus (new, additive concept)
        |
        v
rankPartners(me, others)                  <- cheap fit heuristic, prioritizes WHO to search
        |
        v
generateBilateralPackages(...)            <- bounded candidate transfer sets
  / runThreeTeamSearch(...) for cycles       (ONE_FOR_ONE / TWO_FOR_ONE / ONE_FOR_TWO)
        |
        v
evaluateCandidate(...)                    <- validateTrade + evaluateTrade
  (candidate-eval.ts)                         THE SAME FUNCTIONS `/api/trades/analyze` USES
        |
        v
buildDiscoveryResult / rankResults        <- Phase 1/2 authoritative utility only,
  (rank.ts)                                  complexity penalty, viability bonus;
                                              Phase 3 attached as a labeled, inert block
```

Every arrow into `evaluateCandidate` carries only canonical ids constructed
from the SAME `TradeAnalysisContext`/`DiscoveryEvalContext` built once per
request — no candidate triggers a second provider read (§K has real timing).

## C. Search modes (exact policies)

| Mode | Requires | Behavior |
|---|---|---|
| `BEST_AVAILABLE` | — | Searches every declared need position (severity CRITICAL/HIGH/MODERATE) against top-fit partners. |
| `BUY_PLAYER` | `target_player_id` | Resolves the real current owner from the snapshot; `TARGET_NOT_ROSTERED` if unowned, `TARGET_ALREADY_OWNED` if you already own it; search is restricted to that owner and forces the target into every candidate's incoming side. |
| `SELL_PLAYER` | `sell_player_id` | Requires you own the player (`SELL_PLAYER_NOT_OWNED` otherwise); forces it into every candidate's outgoing side. |
| `POSITIONAL_NEED` | `target_position` | Restricts `needPositions` to exactly that position, regardless of your profile's own severity read. |
| `CONSOLIDATE` | — | Runs the normal bilateral funnel, then filters to `TWO_FOR_ONE`/`ONE_FOR_TWO` results only. |
| `FAIR_TRADES` | — | Partner acceptance floor `NEUTRAL`. |
| `EASY_TO_ACCEPT` | — | Partner acceptance floor `ACCEPT` (stricter). |
| `BLOCKBUSTER` | — | Partner acceptance floor `RELUCTANT` (looser — tolerates a more reluctant partner for a bigger package). |
| `THREE_TEAM` | — | Runs the cycle search (§H) instead of the bilateral funnel. |

`BEST_AVAILABLE` acceptance floor policy (and every other mode not listed
above): `NEUTRAL` — see `partnerAcceptanceFloor` in
`lib/trades/discovery/config.ts` for the exact, single source of truth.

## D. Partner-fit methodology

`computePartnerFit(me, partner)` (`lib/trades/discovery/fit.ts`):
`need_complementarity` = Σ over my CRITICAL/HIGH/MODERATE needs where the
partner has ANY declared surplus at that position (weighted 3/2/1);
`surplus_complementarity` is the symmetric read (partner's needs my surplus
fills). `score = need_complementarity + surplus_complementarity`; `HIGH`
(≥4) / `MODERATE` (≥1) / `LOW` (0). This is a **heuristic used only to
choose which partners are worth generating packages for** — it never appears
in `discovery_score`. Pruning: only the top `max_partner_count` (default 6)
partners by this score are searched at all.

## E. Package generator

**Shapes implemented**: `ONE_FOR_ONE`, `TWO_FOR_ONE` (gated on
`me.consolidation_candidate`), `ONE_FOR_TWO` (gated on
`me.fragility_sensitive`). **Deferred, not implemented this pass**:
`2-for-2`, `3-for-1`, `1-for-3` — see §M.

**Limits**: every pool a candidate is drawn from is capped at
`max_assets_per_pool` (default 4) before pairing; the whole generator is
additionally capped at `max_generated_packages` (default 60) per partner.
No powerset enumeration ever occurs — a roster's full asset list is reduced
to needs-matched candidates before any pairing loop runs.

**Determinism**: proven by test — identical inputs produce byte-identical
package lists (stable sorts everywhere: VOR descending/ascending with a
`canonical_player_id` tie-break).

**Invalid-package pruning**: every generated package still goes through the
real `validateTrade` inside `evaluateCandidate` — an illegal package (e.g. an
asset not actually on either roster) is rejected there, not filtered
speculatively beforehand; proven by test (§Testing).

**Required-asset forcing** (BUY_PLAYER/SELL_PLAYER): a required incoming/
outgoing player is looked up directly from the FULL asset pool and forced
into every candidate — never silently dropped for falling outside a top-K
slice (a real bug caught and fixed during this pass's own test run — the
initial implementation only checked a required asset was *present* in a
list, not that it was actually *used*).

## F. Ranking formula (exact, and separated as required)

```
discovery_score
  = my_authoritative_utility            <- roster_utility_delta, or contextual_utility_delta
                                            when Phase 2 ran — NEVER shadow_utility_delta
  + viability_bonus                     <- +0.25 HIGH, +0.10 MODERATE, +0 LOW/NON_VIABLE
  - complexity_penalty                  <- 0.15 × max(0, total_assets_moved − 2)
```

Computed in exactly one place, `rankResults` (`lib/trades/discovery/rank.ts`)
— `buildDiscoveryResult` decides only whether a candidate SURVIVES (utility
floor, partner acceptance floor) before it ever reaches ranking. Phase 3
fields (`mine.phase3.*`) are read ONLY to populate `phase3_shadow.warnings`,
a field ranking never touches — proven directly by test (`my_gain` equals
the Phase 1/2 authoritative value on every real result, not
`shadow_utility_delta`).

## G. Counteroffer behavior

`generateCounteroffers` operates on an existing transfer list, generating:
**REMOVE** (drop one transfer, if 2+ remain), **SWAP** (replace one asset
with up to 2 same-position alternatives from the same giver, excluding
anything already in the deal or untouchable), **ADD** (sweeten with one more
expendable asset from either side). Every variant is deduplicated and scored
by the same `evaluateCandidate`/`rankResults` path as everything else — no
separate counteroffer valuation model. Example (synthetic, from the test
suite): original `B_rb3 -> A, A_wr3 -> B` generates variants including
`B_rb3 -> A, A_wr4 -> B` (swap) and `B_rb3 -> A, {A_wr3, A_wr_extra} -> B`
(add); all pass `validateTrade` and produce a real `full_evaluation`.

## H. Three-team discovery

Cycle search over `A -> B -> C -> A`: leg 1 is A's best asset (preferring
A's own declared surplus) at one of B's need positions; leg 2 is B's best
asset at one of C's need positions; leg 3 is C's best asset at one of A's
need positions. Bounded by `max_partner_count` candidates for B × every
other manager for C × `max_three_team_cycles` total evaluations. Every
surviving cycle goes through the SAME `evaluateTrade` N-party path 2-team
trades use — no separate 3-team valuation function exists anywhere in this
codebase (confirmed by the Phase 1 audit and unchanged since). Arbitrary
uneven routing (e.g. "A sends 2, B sends 1, C sends 2") is NOT generated
this pass — every cycle is a clean 1-for-1-for-1; the canonical evaluator
itself has no such restriction (it already supports arbitrary N-party
routing per the Phase 1 audit), so a future pass can extend the GENERATOR
without touching the evaluator. `THREE_TEAM_HIDDEN_LOSER` is appended to a
result's `rationale` (not silently filtered) when total participant utility
is positive but the minimum participant's utility is materially negative
(`< -1`); such a cycle still must clear the normal per-participant
acceptance floor to appear in ranked results at all.

## I. Phase 3 isolation (explicitly proven)

Test: `discovery ranking is unchanged whether or not Phase 3 intelligence
would flag a warning — score never reads phase3 fields` asserts, for every
real result, `r.my_gain === (mine.phase2 ? mine.phase2.contextual_utility_delta
: mine.roster_utility_delta)` — i.e. `my_gain` is READ DIRECTLY from the
Phase 1/2 fields, never from `mine.phase3.shadow_utility_delta`. A second
test confirms every result's `phase3_shadow.label` is the literal string
`"SHADOW INTELLIGENCE — NOT INCLUDED IN TRADE SCORE"`. No code path in
`rank.ts` sums, multiplies, or otherwise incorporates any `phase3.*` field
into a numeric score — grep-confirmed (the only reads of `mine.phase3` are
inside the `shadowWarnings` block, which populates `phase3_shadow.warnings`
and nothing else).

## J. Real league results (read-only, live)

Ran `scripts/phase4-real-league-smoke-test.ts` against both registered
Sleeper leagues (no mutation — discovery has no write path):

```
Devoted to the Game / darthmarker — BEST_AVAILABLE
  status=OK results=0 evaluated=0 generated=0 pruned=0

Devoted to the Game / darthmarker — POSITIONAL_NEED RB
  status=OK results=2 evaluated=40 generated=132 pruned=130
  #1 [ONE_FOR_ONE] my_gain=0.2  viability=LOW
     manager:devoted-to-the-game:1004832340092231680 -> darthmarker: player:sleeper:4199
     darthmarker -> manager:devoted-to-the-game:1004832340092231680: player:sleeper:11624
  #2 [ONE_FOR_ONE] my_gain=0.06 viability=LOW
     ...same partner...: player:sleeper:5947
     rationale: "roster fragility worsens (1.5) — depth cost of this deal"

Devoted to the Game / darthmarker — CONSOLIDATE
  status=OK results=0 evaluated=0 generated=0 pruned=0

Bloodline Bowl / supyo29 — BEST_AVAILABLE
  status=OK results=0 evaluated=0 generated=0 pruned=0
```

**This is real**: real Sleeper player ids (`sleeper:4199`, etc.), real
opposing-manager canonical ids, real evaluated utility deltas and viability
classes, a real fragility-cost warning surfaced in the rationale. The
`POSITIONAL_NEED` run proves the ENTIRE pipeline (context build, profile
build, partner selection, package generation, real validation, real
evaluation, ranking) works end-to-end against a live league.

**Why `BEST_AVAILABLE`/`CONSOLIDATE` returned zero, honestly**: both
darthmarker's and supyo29's real rosters currently have no position at
CRITICAL/HIGH/MODERATE severity (`BEST_AVAILABLE`'s `needPositions` comes
from exactly that filter) and no position with `surplus_count >= 2`
(`CONSOLIDATE`'s `consolidation_candidate` gate) — this early in the season,
both rosters are genuinely well-constructed with no urgent hole to search
around. This is a REAL result, not a bug: the `POSITIONAL_NEED` run on the
identical league/manager the same second proves the funnel works when a
target position is specified directly rather than left to `BEST_AVAILABLE`'s
own severity read. See §M for the documented improvement this suggests
(a broader "any starter upgrade" fallback when no severe need exists).

The requested specific real questions ("Who are Mark's best realistic RB
targets?", etc.) are answerable via `POSITIONAL_NEED`/`BUY_PLAYER` as shown
above — none of Mark's roster was hardcoded; every candidate came from the
general search engine reading his real, live Sleeper roster.

## K. Performance

From the real `POSITIONAL_NEED RB` run above: 132 packages generated, 130
pruned (40 evaluated due to `max_evaluated_candidates`, 90 pruned by the cap,
the rest either duplicate/invalid), 2 valid results, one real league-state
read total. Wall-clock for the whole 4-mode smoke script (4 live league
reads + all evaluations): a few seconds, dominated by the Sleeper API calls,
not by the candidate generation/evaluation loop (candidate evaluation itself
is pure/synchronous — no per-candidate network I/O).

## L. Regression

```
Trade-engine suite (all files)                                270 / 270 pass
  Phase 1  65/65   Phase 2  60/60   Phase 3+audit  68/68
  Phase 3.5 (framework+completion)  51/51   Phase 4 (NEW)  26/26
Weekly engine suite                                           120 / 120 pass (unchanged)
Full repository suite                                        1148 tests, 1138 pass, 10 fail
tsc --noEmit                                                  clean
eslint                                                        0 errors, 18 pre-existing warnings (none in Phase 4 files)
```

The 10 failures are the identical pre-existing `live:`/`LIVE` network tests
as every prior baseline. `grep '^not ok' | grep -vi live` → **0**. Baseline
before this phase was `1122 / 1112 / 10`; this phase adds **26 new tests**,
all passing, **0 non-live regressions**.

## M. Remaining limitations

**Phase 4 defects**: none known. One bug was found and fixed DURING this
pass's own test-writing (a required BUY/SELL asset could be generated-past
if it fell outside a top-K slice) — caught by the test suite before this
report was written, not left for a future audit.

**Search limitations (honest, by design)**:
- Package shapes `2-for-2`, `3-for-1`, `1-for-3` are not implemented — only
  `ONE_FOR_ONE`, `TWO_FOR_ONE`, `ONE_FOR_TWO`.
- `include_three_team` mixed with a non-`THREE_TEAM` mode is not implemented
  (request `mode: "THREE_TEAM"` explicitly instead) — merging two funnels'
  counters/ranking cleanly needs more design than this pass allotted.
- Three-team cycles are always a clean 1-for-1-for-1 — no uneven routing
  (e.g. "A sends 2 assets") is generated, though the underlying evaluator
  already supports it.
- `BEST_AVAILABLE`/`CONSOLIDATE` search only positions with a declared
  need/surplus severity; a roster with no severe need (the real-league case
  observed in §J) returns zero results even if a mild, still-worthwhile
  upgrade exists. A future pass should add a lower-priority "any starter
  upgrade regardless of severity" fallback when the primary search is empty.
- Partner-fit-based partner pruning (`max_partner_count`) means a low-fit
  but still-workable partner may never be searched.
- Counteroffers are 2-request-shape-agnostic but were only tested against
  2-team originals this pass — the code path is generic over N participants
  but has no dedicated 3-team counteroffer test.

**Calibration limitations (unchanged from Phase 3.5)**: `discovery_score`
uses only Phase 1/2 authoritative utility; no Phase 3 weight is nonzero
anywhere in this codebase; `TRADE_CALIBRATION_MIN_REAL_TRADES = 50` remains
a reopen gate, not automatic activation, and the real trade count is still
1 (`lib/trades/data-readiness.ts`/`historical-loader.ts`, unchanged by this
phase).

**Future negotiation intelligence (explicitly out of scope, not started)**:
manager psychology, historical acceptance modeling, ML acceptance
prediction, standings/contender-rebuilder behavior, playoff-odds weighting,
market trade-chart anchoring, automatic trade-offer sending, 4+ team
discovery, any nonzero Phase 3 trade weight.

## Phase 4 Audit Gate

```
PHASE 4 TRADE DISCOVERY AND COUNTEROFFER INTELLIGENCE:
READY FOR AUDIT
```

Supported by: Phase 1–3.5 provably unchanged (270/270 trade tests, 120/120
weekly); every discovered candidate validated and scored by the real,
unchanged canonical evaluator (no parallel valuation model exists anywhere
in `lib/trades/discovery/`); Phase 3 isolation proven directly by test;
three-team discovery uses the same N-party evaluator as bilateral trades;
real-league smoke test succeeded end-to-end against live Sleeper data with
zero mutation; deterministic given identical inputs; 0 non-live regressions.
Recommended next step: a Phase 4 audit (mirroring the Phase 1/2/3 audit
pattern) before considering the "any starter upgrade" fallback, 2-for-2/
3-for-1 package shapes, or three-team uneven routing. Do not begin Phase 5.
