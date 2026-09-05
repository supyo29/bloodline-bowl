# Bloodline Bowl Trade Engine — Phase 6: Strategic Context and Season-State Intelligence

Frozen prior layers (all reconfirmed, untouched in valuation logic):
Phase 1 `ri-trade-foundation-2026.2` · Phase 2 `ri-trade-contextual-2026.2` · Phase 3
`ri-trade-calibrated-2026.2` (shadow) · Phase 3.5 `ri-trade-data-2026.2` (calibration
still deferred, 1 real trade vs. 50-trade floor) · Phase 4 `ri-trade-discovery-2026.2`
(frozen, audited PR [#10](https://github.com/supyo29/bloodline-bowl/pull/10)+[#11](https://github.com/supyo29/bloodline-bowl/pull/11)) · Phase 5
`ri-trade-negotiation-2026.2` (frozen, audited PR [#12](https://github.com/supyo29/bloodline-bowl/pull/12)+[#13](https://github.com/supyo29/bloodline-bowl/pull/13)).

New this phase: **`ri-trade-strategy-2026.1`**.

## A. Freeze verification

No file under `lib/trades/{schema,config,evaluate,validate,reconstruct,ros,depth,context,
phase3,intelligence,confidence,calibration,historical,providers,r-data-providers,
historical-loader,data-readiness}.ts` was modified. All new logic lives under
`lib/trades/strategy/*.ts` (new directory). Two existing files received strictly
ADDITIVE, opt-in changes, verified by full regression (Section M) showing zero
behavior change when the new fields are omitted:

- `lib/trades/discovery/types.ts` — added optional `include_strategic` (request),
  `strategic` (per-result), `manager_strategic_profile`/`strategy_version` (response).
- `lib/trades/discovery/discover.ts` — appends the strategic block only when
  `include_strategic: true`; `results`, `rank`, `my_gain`, ranking order, and every
  other existing field are byte-identical to pre-Phase-6 output otherwise (proven by
  the "strategic ranking never changes the underlying base results array" test).
- `lib/trades/negotiation/types.ts` / `negotiate.ts` — same pattern: optional
  `include_strategic` request field, optional `manager_strategic_profile` /
  `strategic_offer_guidance` response fields, populated only for `ACQUIRE_TARGET`
  (the mode that produces an offer ladder) and only when requested.

Phase 5's `pareto.ts`/`dependency.ts`/`concessions.ts` (its own audit's fix targets)
were not touched at all this phase.

## B. Season-state model

`lib/trades/strategy/season.ts::buildLeagueSeasonContext` reuses `resolveRosWeekPlan`
(Phase 2's own audited playoff-window partition) verbatim — no second interpretation of
playoff weeks. `season_stage` is derived from league geometry (elapsed fraction of the
regular season, weeks remaining before the playoff cutover), not hardcoded NFL week
numbers: `MIDSEASON_FRACTION = 0.4`, `PLAYOFF_PUSH_WEEKS_REMAINING = 3`.

**Trade deadline**: the canonical snapshot pipeline `buildTradeAnalysisContext` reads
from does not surface a resolvable trade-deadline field today (Sleeper's raw
`settings.trade_deadline` is normalized elsewhere in `lib/sleeper/normalize.ts` for a
different, non-trade-engine code path, and wiring it into the trade context would add a
second provider read this phase's performance requirement — "snapshot once" — argues
against). Per spec §3 ("do not invent a deadline if none exists"), `trade_deadline_week`
is always `null` and `trade_deadline_status` is always `"UNKNOWN"` — honestly reported,
not fabricated. This is a real, documented limitation (Section N), not a defect.

Week geometry: `regular_season_start_week` is a fixed `1` (this pipeline's snapshot
does not expose a distinct in-season "regular season start" separate from week 1);
`regular_season_end_week`/`playoff_start_week`/`championship_week`/
`weeks_remaining_{regular,total}` are all derived from `ctx.snapshot.league.playoff_settings`
and the shared ROS plan.

## C. Standings model

`lib/trades/strategy/standings.ts::buildManagerStandings` reads `ctx.snapshot.standings`
(already computed by the provider layer: `wins desc, then points_for` —
`lib/providers/sleeper/canonical.ts::toCanonicalStandings`) and
`ctx.snapshot.teams[].record`. `playoff_seed` is always `null` (never populated
upstream) — reported honestly, never fabricated. No division/reseeding/exact-tiebreak
data exists upstream; `games_back` is a coarse win-percentage-driven distance metric
from the same ranking convention the provider already applies, not a second ranking
system.

**Playoff status** (`classifyPlayoffStatus`) is categorical
(`CLINCHED`/`STRONG_POSITION`/`BUBBLE`/`LONG_SHOT`/`ELIMINATED`/`UNKNOWN`), gated by:

1. Standings availability (`STANDINGS_UNAVAILABLE` otherwise).
2. A resolvable `playoff_team_count` (`PLAYOFF_CONTEXT_UNAVAILABLE` otherwise).
3. **A minimum games-played floor** (`MIN_GAMES_PLAYED_FOR_STATUS = 2`,
   `INSUFFICIENT_GAMES_PLAYED` otherwise) — added after the real-league smoke test
   (Section L) showed every 0-0 week-1 team confidently labeled `STRONG_POSITION`/
   `CONTENDER` from a single (zero-game) points-for tiebreak. This is a real defect
   the smoke test caught and this phase fixed, not a hypothetical.

`ELIMINATED` requires a real checkable condition: games-back exceeds weeks remaining
(cannot close the gap even winning out), never "rank alone."

**Playoff odds**: always `null` with an explicit `PLAYOFF_ODDS_UNAVAILABLE` diagnostic.
This repository has no deterministic season-simulation infrastructure (a real
remaining-schedule × real scoring-distribution Monte Carlo with a fixed seed) —
building one is out of this phase's scope. A categorical band
(`VERY_HIGH`/`HIGH`/`MEDIUM`/`LOW`/`VERY_LOW`), itself derived from games-back (not
fitted to any outcome data), is offered instead of a fabricated percentage, per spec
§8's explicit preference for bands over unsupported precision.

## D. Strategic archetypes

| Archetype | Definition | Inputs | Preference changes | Limits |
|---|---|---|---|---|
| `FRONT_RUNNER` | `CLINCHED` playoff status | standings, playoff status, weeks remaining | heaviest weight on `FANTASY_PLAYOFFS` horizon (0.5); tolerant of a modest current-week cost for playoff-window gain | requires BOTH a comfortable games-clear AND few weeks remaining — never rank alone |
| `CONTENDER` | `STRONG_POSITION` (in the playoff line, not yet clinched) | same | balanced across playoffs/ROS/next-3-weeks | — |
| `BUBBLE` | `BUBBLE` playoff status (within `BUBBLE_GAMES_BACK_MAX = 1.5` games) | same | heaviest weight on `CURRENT_WEEK`/`NEXT_3_WEEKS` (0.3/0.35); playoff-schedule weight reduced to 0.3× (bubble guard, spec §28) | — |
| `MUST_WIN` | `LONG_SHOT` status AND ≤2 weeks left AND games-back ≤ weeks remaining (a real, still-mathematically-alive do-or-die case) | standings + season timing | heaviest weight on `CURRENT_WEEK`/`NEXT_3_WEEKS` (0.4/0.4); near-zero playoff weight | — |
| `LONG_SHOT` | `LONG_SHOT` status, more than 2 weeks left | same | moderate weight on `NEXT_3_WEEKS`/`REST_OF_REGULAR_SEASON` | never treated as "permission for irrational trades" — see Section G rationality floor |
| `ELIMINATED` | `ELIMINATED` playoff status | same | no fabricated "future dynasty value" (redraft-only, spec §17); playoff-schedule weight is 0 | if trade activity is permitted at all, no collusive/standings-distorting logic is ever generated (none exists to generate) |
| `UNKNOWN` | standings/playoff context unavailable, insufficient games played, or season stage is `PRESEASON`/`SEASON_COMPLETE` | — | horizon weights default to an even 0.2 each | explicit, not a silent default masquerading as a real classification |

No archetype is set from rank alone — every branch reads playoff status (itself
gated on standings + season timing + the games-played floor) plus, for `MUST_WIN`,
season timing directly (spec §11: "do not let one weak metric determine the
classification").

## E. Urgency model

`lib/trades/strategy/urgency.ts::computeUrgency`, bounded `[0, 1]`:

```
score = clamp(0.5 · playoff_status_component + 0.3 · time_pressure_component + 0.2 · record_component, 0, 1)
```

- `playoff_status_component`: a fixed table (`BUBBLE: 0.75`, `LONG_SHOT: 0.55`,
  `STRONG_POSITION: 0.25`, `ELIMINATED: 0.1`, `CLINCHED: 0.05`, `UNKNOWN: 0.4`).
- `time_pressure_component`: linear in weeks remaining before the playoff cutover
  (`0` at ≥8 weeks left, `1` at 0 weeks left); `0.3` (a mild, non-fabricated default)
  when no playoff cutover is resolvable at all.
- `record_component`: `1 − win_percentage` (a losing record raises urgency modestly).

Every urgency score decomposes into these three named, individually-inspectable
components with a plain-language reason string per component — never opaque.
Urgency NEVER touches base roster utility (verified: `assessStrategicTrade` reads
`participant.roster_utility_delta`/`contextual_utility_delta` directly from the
canonical evaluation, never a value urgency has touched).

## F. Horizon model

`HORIZON_WEIGHTS_BY_ARCHETYPE` (each row sums to 1.0):

| Archetype | CURRENT_WEEK | NEXT_3_WEEKS | REST_OF_REGULAR_SEASON | FANTASY_PLAYOFFS | FULL_REMAINING_SEASON |
|---|---|---|---|---|---|
| FRONT_RUNNER | 0.10 | 0.15 | 0.15 | 0.50 | 0.10 |
| CONTENDER | 0.15 | 0.20 | 0.20 | 0.35 | 0.10 |
| BUBBLE | 0.30 | 0.35 | 0.20 | 0.10 | 0.05 |
| MUST_WIN | 0.40 | 0.40 | 0.15 | 0.03 | 0.02 |
| LONG_SHOT | 0.20 | 0.30 | 0.30 | 0.10 | 0.10 |
| ELIMINATED | 0.20 | 0.20 | 0.30 | 0.10 | 0.20 |
| UNKNOWN | 0.20 | 0.20 | 0.20 | 0.20 | 0.20 |

`preferred_horizons` reports the top-2 weighted horizons per archetype. These weights
are hand-set and documented, not fitted to any outcome data (there is no outcome data
to fit to — trade-level calibration remains deferred).

## G. Strategic adjustment

`lib/trades/strategy/adjustment.ts::assessStrategicTrade` builds `StrategicTradeAssessment`
for ONE participant of an already canonically-evaluated trade. Every component reuses an
existing, already-audited signal — nothing here recomputes roster value:

| Component | Signal reused | Weight |
|---|---|---|
| `immediate_need_adjustment` | Phase 1 `starter_points_delta` | `0.5 × delta × horizon_weights.CURRENT_WEEK × (0.5 + 0.5·urgency)` |
| `short_horizon_adjustment` | Phase 2 `ros_usable_value` | `0.35 × delta × horizon_weights.NEXT_3_WEEKS` |
| `playoff_window_adjustment` | Phase 2 `playoff_window` (Phase 2's own audited resolution, reused verbatim — spec §24) | gated by playoff-qualification status (spec §27), weighted `1.0/0.7/0.3` for `CLINCHED/STRONG_POSITION/BUBBLE`, `0` otherwise (bubble guard, spec §28), capped at `±1.0` regardless (spec §26/§29) |
| `depth_resilience_adjustment` | Phase 2 `roster_fragility` + `usable_depth` | weighted toward `REST_OF_REGULAR_SEASON + FULL_REMAINING_SEASON` |
| `ceiling_preference_adjustment` / `floor_preference_adjustment` | — | **structurally `0`** — Phase 3's only volatility-adjacent signals are shadow-only and zero-weighted; there is no other non-Phase-3 evidence (spec §35, Calibration Deferral section: "if insufficient evidence, weight = 0") |
| `bye_urgency_adjustment` | Phase 2 `bye_coverage` | weighted toward `CURRENT_WEEK + NEXT_3_WEEKS` |

Every component is individually capped to `±0.6` (`COMPONENT_CAP`) BEFORE summing.
The summed `strategic_adjustment` is capped AGAIN, relative to the trade's own
`|base_utility_delta|`:

```
cap = max(0.75, |base_utility_delta| × 0.5)
strategic_adjustment = clamp(raw_sum, -cap, +cap)
```

**Rationality floor** (spec §32), the Core Phase 6 Invariant's enforcement point:

```
HARD_REJECT → never promoted (always stays HARD_REJECT)
REJECT       → at most RELUCTANT
RELUCTANT    → at most NEUTRAL
NEUTRAL      → at most ACCEPT
```

Promotion additionally requires `strategic_adjustment ≥ PROMOTION_MIN_ADJUSTMENT (0.25)`
— a small negative-noise adjustment cannot trigger a promotion. `strategic_acceptance`
is a SEPARATE field from `base_acceptance`; the base field is never overwritten.
`strategic_recommendation` (`STRONGLY_PRIORITIZE`/`PRIORITIZE`/`CONSIDER`/`LOW_PRIORITY`/
`AVOID`) is derived from `strategic_acceptance` and `strategic_trade_score`, and any
`HARD_REJECT`/`REJECT` base trade is always `AVOID` regardless of urgency.

**Desperation-trap proof** (adversarial fixture, Section K): a 2-7 team offered a trade
that gives away its two best bench WRs for a redundant RB it already has — a deeply
negative base trade — was directly tested: if `base_acceptance` is `HARD_REJECT`,
`strategic_acceptance` stays `HARD_REJECT`; and whenever `base_utility_delta < -2`, the
test asserts `strategic_trade_score` stays negative. Desperation alone cannot flip the
sign.

## H. Playoff schedule

- **Source**: Phase 2's `playoff_window` component (`ri-trade-contextual-2026.2`,
  `resolveRosWeekPlan`) — no duplicate logic (spec §24).
- **Window**: whatever Phase 2 already resolved as `ctx.ros.playoff_weeks`; Phase 6
  never re-derives it.
- **Qualification gating**: only applied for `CLINCHED`/`STRONG_POSITION`/`BUBBLE`
  (`PLAYOFF_SCHEDULE_ELIGIBLE_STATUSES`) — `LONG_SHOT`/`ELIMINATED`/`UNKNOWN` get zero
  playoff-schedule weight (spec §27's qualification gate, using categorical status
  since real playoff odds are unavailable — spec §27's fallback path).
- **Caps**: `PLAYOFF_SCHEDULE_ADJUSTMENT_CAP = 1.0` regardless of how favorable the
  window looks, and the bubble-team weight is reduced to `0.3×` vs. `1.0×` for a
  clinched team (spec §28 bubble guard / §29 clinched-team bound).

## I. Discovery integration

`discoverTrades({ ..., include_strategic: true })` computes
`buildManagerStrategicProfile` ONCE (spec's Performance requirement — "season context
once, manager strategic profiles once, then reuse"), attaches a `strategic` block to
every `TradeDiscoveryResult`, and returns `manager_strategic_profile` on the response.
`results`, `rank`, `my_gain`, `trade_viability`, and ranking order are UNCHANGED —
verified by an explicit test asserting the base result object is never mutated
(`JSON.stringify` before/after strategic assessment is identical).

`lib/trades/strategy/assess.ts::strategicDiscoveryRank` implements the spec's
`discovery_rank = base_trade_quality + strategic_fit + partner_viability − complexity`
formula as a SECONDARY, additive re-ranking function (`rankResultsStrategically`) —
base quality (`my_gain`) remains dominant since `strategic_fit` (the already-capped
`strategic_adjustment`) can only ever be a bounded fraction of it.

## J. Negotiation integration

`negotiateTrade({ ..., include_strategic: true })` on `ACQUIRE_TARGET` attaches
`strategic_offer_guidance` via `recommendOfferTier(ladder, profile)`. This function's
signature makes exceeding Phase 5's ladder STRUCTURALLY IMPOSSIBLE: it filters to keys
already present in the ladder Phase 5 built (`Object.keys(ladder).filter(...)`) and
returns one of THOSE keys or `null` — there is no code path by which it can return a
tier that was not already on the ladder, and `exceeded_maximum_rational` is hardcoded
`false` by construction (never computed, since the function cannot produce a violation
in the first place). Proven by test ("`recommendOfferTier` only ever returns a tier
that is present on the ladder — never fabricates or exceeds it") and by live smoke
output (Section L) showing `recommended_tier` always drawn from the same
`OPENING`/`BALANCED`/`STRONG_ACCEPT`/`MAXIMUM_RATIONAL` set Phase 5 already produces.

## K. Adversarial results

| Fixture | Result |
|---|---|
| Desperation trap | A 2-7 team's deeply-negative-utility trade (giving away two good bench WRs for a redundant RB) never promotes past `HARD_REJECT`; `strategic_trade_score` stays negative when `base_utility_delta < -2` regardless of urgency. |
| Rationality-floor promotion cap | `promotionCeiling` unit-tested exhaustively: `HARD_REJECT→HARD_REJECT`, every other band promotes by at most one step, `ACCEPT`/`STRONG_ACCEPT` unchanged. |
| Clinched optimization | A clinched front-runner's strategic adjustment on a real evaluated trade stays within the documented cap (`max(0.75, |base|·0.5)`) — proven directly against the formula, not just asserted informally. |
| Same trade, different manager state | An IDENTICAL structural trade (same transfers) run through a contender-state league and a long-shot-state league produces the SAME `base_utility_delta` (proving valuation is untouched) but DIFFERENT archetypes — proving strategy changes preference, not value. |
| Strategic decomposability | Every component of `strategic_adjustment` is individually inspectable and sums to the reported total (unless the cap fired). |
| MAXIMUM_RATIONAL boundary | `recommendOfferTier` structurally cannot exceed the ladder (Section J) — tested on both a populated and an empty ladder. |
| Discovery base-result immutability | Strategic ranking never mutates or reorders the base `results` array — proven via before/after `JSON.stringify` equality. |

The remaining named fixtures from the spec (playoff mirage, depth-collapse contender,
must-win depth sacrifice, bye-week emergency, false ceiling, eliminated redraft team,
schedule domination trap, partner mismatch) are covered by the underlying component
tests (playoff-schedule qualification gating/caps in Section H, the structurally-zero
ceiling/floor preference in Section G, the redraft-only archetype table in Section D)
rather than by a dedicated named test for each — see Section N for what a follow-up
pass would add explicitly.

## L. Real league smoke

`scripts/phase6-real-league-smoke-test.ts`, read-only, run against both real leagues
(week 1, 2026 season, every team 0-0):

- **Standings**: real 12-team standings pulled correctly for both leagues (rank,
  record, points_for).
- **Archetype/playoff status**: initially (before the games-played-floor fix) every
  0-0 team was labeled `STRONG_POSITION`/`CONTENDER` off a zero-game points-for
  tiebreak — a real, live-caught defect (Section C). After the fix, every manager
  correctly reports `UNKNOWN` with `INSUFFICIENT_GAMES_PLAYED`, honestly reflecting
  that week 1 has no real standings signal yet.
- **Strategy-aware discovery**: `BEST_AVAILABLE` with `include_strategic: true`
  returned real candidates with `strategic_trade_score`/`strategic_recommendation`
  attached for real managers in both leagues (e.g., `my_gain=0.79 → strategic_score=
  1.54 → PRIORITIZE`).
- **Strategy-aware negotiation**: `ACQUIRE_TARGET` with `include_strategic: true`
  returned `strategic_offer_guidance` naming a real tier from the real offer ladder
  (`recommended_tier: "OPENING"`, drawn from `["OPENING", "BALANCED"]` actually on the
  ladder) for both leagues.

No mutation, no write to Sleeper — read-only throughout, matching the established
pattern from every prior phase's smoke test.

## M. Regression

| Suite | Result |
|---|---|
| `test/trade-engine-phase6.test.ts` (new) | 30 / 30 |
| `test/trade-engine-phase4*.test.ts` + Phase 6 together | 82 / 82 |
| All `test/trade-engine*.test.ts` + `test/weekly*.test.ts` | 478 / 478 |
| Full repository (`test/*.test.ts`) | 1227 / 1237 pass, 10 fail |
| `npx tsc --noEmit` | clean |
| `npm run lint` | 0 errors, 18 pre-existing warnings (unrelated files) |

The 10 failures are the same pre-existing, network-dependent `live:` tests from every
prior phase's baseline (standings/managers/snapshot/recommendation/draft-snapshot/
pre-draft-state live endpoints) — **0 non-live regressions**, consistent with the
`321/321 trade, 120/120 weekly, 10 pre-existing live failures, 0 non-live regressions`
baseline this phase was measured against (absolute totals are higher now due to the new
Phase 6 tests added on top).

## N. Remaining limitations

**Phase 6 defects**: none known at time of writing (the one real defect found —
week-1 zero-game overconfidence — was caught by this phase's OWN smoke test and fixed
before delivery, not left open).

**Strategic-model limitations** (documented, not defects):
1. Trade deadline is always `null`/`UNKNOWN` — no resolvable field exists upstream
   (Section B).
2. Playoff odds are always `null` with a categorical band, never a simulated
   percentage — no deterministic season-simulation infrastructure exists in this
   repository (Section C).
3. `short_horizon_adjustment` reuses Phase 2's rest-of-season usable-value signal as
   the nearest available "next 3 weeks" proxy rather than a purpose-built 3-week
   lineup projection — an honest reuse of an existing audited signal, not a new model.
4. `CLINCHED` classification is a crude "games-clear-of-cutline AND few-weeks-remaining"
   proxy, not a real clinching-scenario solver (which would need to enumerate every
   remaining game's outcomes) — conservative by design (requires BOTH conditions).
5. `POST /api/trades/analyze` was deliberately NOT extended with `include_strategic`
   this phase — it is the most foundational, most heavily-tested file in the entire
   stack (Phase 1/1-audit/2/2-audit's frozen surface) and lacks a natural
   single-manager perspective the way discovery/negotiation already have (`manager`
   field, per-manager orchestration); the regression risk of touching it did not seem
   worth the incremental value versus the two integrations already shipped.
6. `alternative_targets` (Phase 5's own pre-existing, already-documented limitation)
   remains unpopulated — Phase 6 did not add BUY_PLAYER-style strategic fit-scoring
   (spec §41) as a dedicated named feature; the underlying machinery
   (`assessDiscoveryResult`) already works for any discovery result, including
   `BUY_PLAYER`'s, when `include_strategic: true` is set — a dedicated narrative
   ("great player, poor strategic target because...") is not separately generated.
7. Three-team strategic negotiation is out of scope, consistent with Phase 5's own
   D6 audit fix (three-team proposals are explicitly rejected at the negotiation
   layer, never silently strategy-annotated).

**Calibration limitations**: unchanged — `TRADE_CALIBRATION_MIN_REAL_TRADES = 50`,
1 real historical trade on file. Phase 6's weights are conservative, bounded,
structurally justified, and explicitly documented per the spec's Calibration
Deferral section — none is learned or tuned against outcomes, since none exist yet.

**Future optional refinements** (not blockers): a real deterministic playoff-odds
simulator (remaining schedule × scoring distribution, fixed seed) if this project
ever wants numeric odds instead of bands; a purpose-built next-3-weeks lineup
projection instead of reusing the ROS signal; explicit named test fixtures for the
remaining adversarial scenarios not yet given a dedicated test (playoff mirage,
depth-collapse contender, bye-week emergency, false ceiling, schedule domination
trap, partner mismatch) — their underlying mechanisms are tested via component
tests today, but a dedicated end-to-end fixture per scenario would strengthen the
audit trail further.

---

PHASE 6 STRATEGIC CONTEXT AND SEASON-STATE INTELLIGENCE:
READY FOR AUDIT
