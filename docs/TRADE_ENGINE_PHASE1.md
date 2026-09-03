# Bloodline Bowl Trade Engine — Phase 1: Multi-Team Trade Foundation

`ri-trade-foundation-2026.2`  ·  audit: [`TRADE_ENGINE_PHASE1_AUDIT.md`](TRADE_ENGINE_PHASE1_AUDIT.md)

## A. Implementation summary

### Architecture

A trade is a **generalized N-party transaction** — `participants` + `transfers` —
never a `twoWayTradeEngine` / `threeWayTradeEngine` split. A 2-team trade is a
proposal with two participants; a 3-team trade has three; the same code path runs
both. Transfers carry `from_manager_id` / `to_manager_id` / `asset`
independently, so **arbitrary routing** works (`A→B, B→C, C→A`; `A→B, A→C, B→A,
C→B`; one team receiving multiple assets) with **no bilateral-reciprocity
requirement**.

The engine is a **consumer** of the existing roster intelligence, not a fork of
it. For every participant it reconstructs the before/after `CanonicalRoster` and
re-runs:

| Concern | Reused module |
| --- | --- |
| Optimal legal starting lineup (Hungarian slot assignment, FLEX/SUPERFLEX eligibility, KNOWN/VERIFIED_ZERO/UNKNOWN semantics) | `lib/weekly/lineup.ts` → `buildOptimalLineup` |
| Weekly replacement frontier + VOR | `lib/weekly/replacement.ts` → `computeWeeklyReplacement`, `weeklyVOR` |
| Positional needs (per base position + per flex label + STRUCTURAL) | `lib/weekly/context.ts` → `computePositionalNeeds` |
| Projections, byes, availability, roster constraints | `lib/weekly/context.ts` → `buildWeeklyTeamContext` (built ONCE, shared) |
| Canonical manager resolution (strict, no fallback) | `lib/canonical/manager-context.ts` → `resolveManager` |
| Canonical league state / player identity | `lib/canonical/state.ts`, snapshot `identifiers` crosswalk |
| Structural fieldability of a lineup | `lib/weekly/slots.ts` → `maxSlotMatching` |

### Files added

| File | Role |
| --- | --- |
| `lib/trades/schema.ts` | Proposal / transfer / result types, `TRADE_ENGINE_VERSION`, validation codes, diagnostic codes |
| `lib/trades/config.ts` | **All thresholds** (composite weights, acceptance bands, acceptance floor, viability bands) + `resolveTradeConfig` / `classifyAcceptance`. Nothing is buried in engine code. |
| `lib/trades/reconstruct.ts` | Pure before/after roster reconstruction (immutable `before`) |
| `lib/trades/validate.ts` | Explicit-failure validation (never silent correction) |
| `lib/trades/evaluate.ts` | Marginal-utility core — per-participant before/after deltas, displacement, acceptance, trade-level verdict, fairness |
| `lib/trades/analyze.ts` | Orchestrator: one snapshot + one shared weekly context → validation → evaluation |
| `app/api/trades/analyze/route.ts` | `POST /api/trades/analyze` |
| `test/trade-engine.test.ts` | 19 foundation tests |
| `test/trade-engine-audit.test.ts` + `test/fixtures/trades.ts` | 46 adversarial audit tests + multi-roster fixture harness |

### How N-party transactions are represented

```ts
type TradeTransfer = { from_manager_id: string; to_manager_id: string; asset: { type: "PLAYER"; player_id: string } };
type TradeProposal = { league: string; participants: { manager_id: string }[]; transfers: TradeTransfer[] };
```

After identity resolution this becomes a `NormalizedProposal` where every id is
canonical. `reconstructRosters` walks the transfer list once, building an
`outgoing` and `incoming` set per participant — it never assumes who trades with
whom.

### How lineup recalculation works

The post-trade optimal lineup is **rebuilt from scratch** with
`buildOptimalLineup` on the reconstructed roster — it is not
`current_total − outgoing_value + incoming_value`. `test/trade-engine.test.ts`
includes a fixture (`2-for-1`) where the raw player-value method says
`16 − (12 + 6) = −2` (manager "loses") while the actual roster method returns
**+3** because the incoming star displaces a weak starter and the outgoing
FLEX seat is backfilled by a scrub. The test asserts the two answers diverge by
≥ 2 points.

### How utility and acceptance are calculated

Per participant, four components (each in **weekly projected points**, each also
returned individually in `roster_utility_components`):

- `starter_points` — `after.optimal_starter_points − before.optimal_starter_points` (`null`/`UNRESOLVED` if an UNKNOWN player would start — never silently 0)
- `starter_vor` — Δ of `Σ max(0, weeklyVOR)` over the optimal starters (exposed as a scarcity lens; **default composite weight 0** — it is ~collinear with `starter_points`, so summing both double-counts. Audit D2.)
- `bench_value` — Δ of `Σ max(0, weeklyVOR)` over rostered players **not** in the optimal lineup
- `positional_need` — Δ of a bounded severity-pressure score from `computePositionalNeeds` (critical 3 / weak 1.25 / adequate 0 / strong −0.75), clamped to ±4 so it nudges rather than dominates

`roster_utility_delta = Σ weightᵢ · componentᵢ` (default weights
`starter_points 1.0 / starter_vor 0 / bench_value 0.25 / positional_need 1.0` —
`starter_vor` is exposed but not summed, see audit D2). `classifyAcceptance` maps that scalar to
`STRONG_ACCEPT / ACCEPT / NEUTRAL / RELUCTANT / REJECT / HARD_REJECT` against the
configurable bands. `above_acceptance_floor = delta ≥ config.acceptance_floor`.

**Rationality** (does each roster improve vs its own pre-trade state?) and
**fairness / distribution** (`utility_gain_variance`, `utility_gain_spread`,
`fairness.imbalance_index`) are tracked **separately** and never collapsed into
one score. A trade with a clear "winner" (`largest_beneficiary`) can still be
`all_teams_improve: true`.

`trade_viability`: `HIGH` (every participant ≥ `+0.5`), `MODERATE` (every
participant ≥ `−0.5`), `LOW`, `NON_VIABLE` (any participant `REJECT`/`HARD_REJECT`
or a delta below the `reluctant_floor` band).

### Determinism

Given identical league state + projections + proposal + config the analyzer
produces identical output. No randomness, no time-dependent branch in the
evaluation path (only `generated_at` is a timestamp). `evaluateTrade` (the pure core) is unconditionally deterministic. `analyzeTrade`
performs two league-state reads (its own snapshot + the one `buildWeeklyTeamContext`
builds); a consistency guard compares the primary participant's sorted player-id
set across the two and emits `TRADE_ANALYSIS_DEGRADED` on a mismatch. A single-read
refactor is the recommended Phase 2 opener.

### Explicit degradation

`STARTER_PROJECTION_UNAVAILABLE`, `LINEUP_PROVISIONAL`, `VOR_FALLBACK_USED`,
`POSITIONAL_NEED_MODEL_UNAVAILABLE`, `PROJECTIONS_PARTIAL`,
`ROSTER_UNKNOWN_PLAYER`, `TRADE_ANALYSIS_DEGRADED` — surfaced per participant and
at the top level. No optimistic default is ever substituted; an unquantifiable
starter delta is returned `null` with status `UNRESOLVED` and the composite falls
back to the resolvable components.

## B. API

`POST /api/trades/analyze` — read-only, stateless, CORS-open like the rest of the
bridge. HTTP 200 on `status: "OK"`, 422 on `VALIDATION_FAILED`, 503 on
`CONTEXT_UNAVAILABLE`.

### 2-team example

```json
POST /api/trades/analyze
{
  "league": "bloodline-bowl",
  "participants": ["supyo29", "johndoe"],
  "transfers": [
    { "from_manager_id": "supyo29", "to_manager_id": "johndoe", "asset": { "type": "PLAYER", "player_id": "4034" } },
    { "from_manager_id": "johndoe", "to_manager_id": "supyo29", "asset": { "type": "PLAYER", "player_id": "6794" } }
  ]
}
```

```json
{
  "status": "OK",
  "trade_version": "ri-trade-foundation-2026.2",
  "league_slug": "bloodline-bowl",
  "week": 1,
  "config": { "weights": { "starter_points": 1, "starter_vor": 0, "bench_value": 0.25, "positional_need": 1 },
              "thresholds": { "strong_accept": 3, "accept": 1, "neutral_floor": -1, "reluctant_floor": -2, "hard_reject": -4 },
              "acceptance_floor": -0.5, "viability": { "high_min_participant_delta": 0.5, "moderate_min_participant_delta": -0.5 } },
  "validation": { "ok": true, "failures": [] },
  "normalized": { "league_slug": "bloodline-bowl", "participant_manager_ids": ["manager:…:supyo29", "manager:…:johndoe"],
                  "transfers": [ /* canonical */ ] },
  "participants": {
    "supyo29": {
      "manager_slug": "supyo29",
      "before": { "optimal_starters": ["…"], "optimal_starter_points": 121.4, "starter_vor": 38.1, "bench_value": 9.2, "roster_size": 15, "fieldable": true, "incoming_player_ids": [], "outgoing_player_ids": [] },
      "after":  { "optimal_starters": ["…"], "optimal_starter_points": 124.9, "starter_vor": 41.0, "bench_value": 7.1, "roster_size": 15, "fieldable": true, "incoming_player_ids": ["player:…:6794"], "outgoing_player_ids": ["player:…:4034"] },
      "starter_points_delta": 3.5,
      "starter_points_delta_status": "RESOLVED",
      "starter_vor_delta": 2.9,
      "bench_value_delta": -2.1,
      "roster_utility_delta": 4.0,
      "roster_utility_components": { "starter_points": 3.5, "starter_vor": 2.9, "bench_value": -2.1, "positional_need": 1.25 },  // composite = 1·3.5 + 0·2.9 + 0.25·-2.1 + 1·1.25
      "positional_need_changes": [ { "position": "WR", "before_severity": "weak", "after_severity": "adequate", "kind": "IMPROVES_NEED" } ],
      "lineup_displacement": { "entered_starting_lineup": ["player:…:6794"], "left_starting_lineup": ["player:…:wr2"], "moved_to_bench": ["player:…:wr2"], "bench_promotions": [] },
      "acceptance": "STRONG_ACCEPT",
      "above_acceptance_floor": true,
      "diagnostics": []
    },
    "johndoe": { "…": "…", "roster_utility_delta": -0.4, "acceptance": "NEUTRAL", "above_acceptance_floor": false }
  },
  "trade_summary": {
    "all_teams_improve": false,
    "all_teams_above_acceptance_floor": false,
    "largest_beneficiary": "supyo29",
    "largest_negative": "johndoe",
    "utility_gain_variance": 4.84,
    "utility_gain_spread": 4.4,
    "trade_viability": "MODERATE",
    "rationality": { "every_participant_rational": false, "rational_count": 1, "participant_count": 2 },
    "fairness": { "imbalance_index": 1.0, "note": "Gains are highly concentrated — check whether every participant clears their acceptance floor." }
  },
  "diagnostics": []
}
```

### 3-team example (circular, no A↔C exchange)

```json
POST /api/trades/analyze
{
  "league": "bloodline-bowl",
  "participants": ["supyo29", "johndoe", "bijoy"],
  "transfers": [
    { "from_manager_id": "supyo29", "to_manager_id": "johndoe", "asset": { "type": "PLAYER", "player_id": "11584" } },
    { "from_manager_id": "johndoe", "to_manager_id": "bijoy",   "asset": { "type": "PLAYER", "player_id": "6786"  } },
    { "from_manager_id": "bijoy",   "to_manager_id": "supyo29", "asset": { "type": "PLAYER", "player_id": "12517" } }
  ]
}
```

Response has the same shape: a `participants` entry for each of the three
managers, each roster independently recalculated, plus a `trade_summary` whose
`utility_gain_variance` / `fairness.imbalance_index` distinguish
`+10 / +8 / +6` from `+15 / +0.2 / −8`.

### Invalid-trade example

```json
POST /api/trades/analyze
{ "league": "bloodline-bowl", "participants": ["supyo29", "johndoe"],
  "transfers": [ { "from_manager_id": "supyo29", "to_manager_id": "johndoe", "asset": { "type": "PLAYER", "player_id": "6794" } } ] }
```

If `6794` is on johndoe's roster, not supyo29's → HTTP 422:

```json
{
  "status": "VALIDATION_FAILED",
  "trade_version": "ri-trade-foundation-2026.2",
  "validation": {
    "ok": false,
    "failures": [
      { "code": "PLAYER_NOT_OWNED_BY_SENDER",
        "message": "Player \"6794\" is not on supyo29's roster before the trade (owned by team …).",
        "subject": "6794" }
    ]
  },
  "normalized": null,
  "participants": {},
  "trade_summary": null
}
```

Other codes: `UNKNOWN_MANAGER`, `DUPLICATE_PARTICIPANT`, `MANAGER_HAS_NO_TEAM`,
`UNKNOWN_PLAYER`, `INVALID_PARTICIPANT`, `SELF_TRANSFER`, `DUPLICATE_TRANSFER`,
`PLAYER_ON_MULTIPLE_POST_TRADE_ROSTERS`, `POST_TRADE_ROSTER_OVER_SIZE_LIMIT`,
`POST_TRADE_ROSTER_ILLEGAL`.

## C. Test results

### New trade-engine tests — `test/trade-engine.test.ts`

```
# tests 65   (19 foundation + 46 audit)
# pass 65
# fail 0
```

Coverage:
- **Validation** — unknown manager, unknown player, player-not-owned, duplicate
  transfer, self-transfer, endpoint-outside-participant-set, post-trade illegal
  roster, and the clean-accept path returning a normalized proposal.
- **Reconstruction** — outgoing removed from every list, incoming added,
  `before` proven immutable.
- **2-team** — roster-specific results, starter delta materially diverges from
  the naive swap value (lineup displacement fixture), acceptance is
  roster-specific (same trade helps A, hurts B), trade-level verdict distinct
  from per-team results, determinism, configurable thresholds.
- **3-team** — circular routing with **no bilateral pair**, all three rosters
  independently recalculated, incoming/outgoing tracked per the routing (not
  reciprocity), rationality vs fairness separated, determinism across repeats.

### Existing regression suite

```
# tests 943
# pass 933
# fail 10
```

`npx tsc --noEmit` clean. `npm run lint` — 0 errors (18 pre-existing warnings,
none in `lib/trades/**` or the new route/test).

The 10 failures are **all pre-existing network `live:` tests** (`live: standings`,
`live: managers`, `live: snapshot`, `LIVE — real recommendation endpoint`,
`LIVE — real raw K/DEF fallback board`, `live draft snapshot`, `live draft:
pre-draft state`) — a clean checkout without this change reports the identical
`pass 933 / fail 10`. No non-live test regressed. Waiver analysis, roster
recommendations, matchup logic, lineup optimization, positional-needs, draft
endpoints, league routing and existing bridge endpoints all still pass.

### Known warnings / degraded dependencies

- `analyzeTrade` builds one canonical snapshot **and** one weekly context
  (which internally builds its own snapshot). A consistency guard emits
  `TRADE_ANALYSIS_DEGRADED` when the two reads disagree; a future refactor could
  split an `assembleWeeklyContextFromSnapshot` helper to make this a single read.
- The player-identity crosswalk in `analyze.ts` resolves canonical id / Sleeper
  id / Yahoo id / name-key from the snapshot's `identifiers`. A dedicated
  multi-provider crosswalk pass is deferred; unresolved ids fail closed as
  `UNKNOWN_PLAYER`.
- Bench-value uses `max(0, weeklyVOR)` — no injury/bye-week depth modeling yet
  (explicitly out of Phase 1 scope).

## D. Audit

| Requirement | Status |
| --- | --- |
| Two-team trade works | ✅ `test/trade-engine.test.ts` "2-team trade" suite |
| Three-team trade works | ✅ "3-team trade — circular routing" suite |
| Arbitrary transfer routing (no bilateral reciprocity) | ✅ circular `A→B→C→A` evaluated; incoming/outgoing tracked per routing |
| Every team's roster independently recalculated | ✅ `evaluateTrade` loops participants, `buildOptimalLineup` per roster before+after |
| No standalone trade-chart shortcut driving the result | ✅ value is `after − before` optimal lineup + VOR + needs; divergence-from-naive-swap test asserts it |
| Pre/post lineups optimized independently | ✅ two separate `buildOptimalLineup` calls per participant |
| Acceptance is roster-specific | ✅ "same trade helps A and hurts B" test |
| Thresholds configurable | ✅ all in `lib/trades/config.ts`; `resolveTradeConfig(override)`; "acceptance thresholds are configurable" test |
| Output is deterministic | ✅ determinism tests in both suites; no RNG/time in eval path |
| Existing Bloodline functionality intact | ✅ `pass 933 / fail 10` identical to baseline; tsc + lint clean |

## E. Freeze verdict

```
PHASE 1 TRADE FOUNDATION VERDICT:
READY FOR PHASE 2
```

Audited 2026-09-03 (see `TRADE_ENGINE_PHASE1_AUDIT.md`): 9 defects found (0×P0, 1×P1, 4×P2, 4×P3), all fixed; engine version bumped to `ri-trade-foundation-2026.2`.

```
PHASE 1 TRADE FOUNDATION AUDIT:
READY TO FREEZE
```
