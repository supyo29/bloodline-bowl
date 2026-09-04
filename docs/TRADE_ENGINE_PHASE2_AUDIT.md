# Trade Engine — Phase 2 Contextual Valuation Audit

Phase 1 foundation: `ri-trade-foundation-2026.2` (**frozen, unchanged**)
Phase 2 valuation, before this audit: `ri-trade-contextual-2026.1`
Phase 2 valuation, after this audit: **`ri-trade-contextual-2026.2`**

Method: every claim was re-verified by tracing the calculation by hand against
worked numeric examples, then locked in with a new deterministic suite
(`test/trade-engine-phase2-audit.test.ts`, 34 tests) alongside the existing
`test/trade-engine-phase2.test.ts` (26 tests).

---

## A. Freeze verification

**Phase 1 (`ri-trade-foundation-2026.2`) remains behaviorally frozen. No Phase 1
defect was found.**

- All 65 Phase 1 tests pass **unchanged**.
- `evaluateTrade` called without a `context` produces the exact same Phase 1
  output as before this audit — verified explicitly: `noCtx.participants.X`
  equals `withCtx.participants.X` with only the additive `phase2` key removed,
  for a fixture that materially worsens Phase 2 fragility (audit §21 test).
- `attachPhase2` runs strictly **after** `trade_summary = summarize(results, …)`
  is computed from the Phase 1 `results` array, and only ever adds a new
  `r.phase2 = {...}` property — traced line-by-line, it never reassigns
  `roster_utility_delta`, `acceptance`, `starter_points_delta`, or any other
  Phase 1 field.
- Phase 1 acceptance thresholds (`lib/trades/config.ts` `thresholds`) and
  viability bands are untouched by this audit.
- `buildWeeklyTeamContext`'s additive `snapshotOverride` has zero behavior
  change when unset — **all 120 weekly-engine tests pass**, and it is not
  consulted at all unless a caller explicitly passes it.
- No shared helper used by lineup optimization, VOR, positional needs, or
  roster reconstruction was modified by this audit (only `lib/trades/{context,
  ros,depth,evaluate}.ts`, none of which are imported by Phase 1's own tests
  except through the optional `context` parameter).

---

## B. Phase 2 architecture verified

Traced end to end:

```
analyzeTrade
  -> buildTradeAnalysisContext         ONE buildCanonicalLeagueState read
     -> buildWeeklyTeamContext({ snapshotOverride: <that snapshot> })  NO 2nd read
     -> resolveRosWeekPlan(week, championshipWeek, playoffStartWeekRaw)  [pure, now shared]
     -> scheduleProvider.getWeekSchedule × remaining weeks   [separate, cached, documented]
  -> validateTrade                     (frozen Phase 1)
  -> evaluateTrade({ ...phase1 inputs, context })
     -> Phase 1 loop (frozen) -> results[]
     -> trade_summary = summarize(results)      <- computed BEFORE Phase 2 touches anything
     -> if (context) attachPhase2(results, ...)  <- purely additive `r.phase2 = {...}`
```

**Snapshot-consistency (2A):** confirmed with an adversarial fake provider whose
`getLeagueState` returns a **different roster bundle on every call**
(`countingProvider()`); `analyzeTrade` invokes it exactly once, and repeated
`analyzeTrade` calls (each a fresh single read) are deterministic. A second
test directly shows `buildWeeklyTeamContext` with `snapshotOverride` performs
**no** provider read even when the injected `providerOverride.getLeagueState`
throws.

**Inputs snapshot-frozen vs. independently fetched (documented, per audit
request):**

| Input | Source |
| --- | --- |
| League identity, scoring, roster settings, managers, teams, rosters, players, ownership | the ONE `buildCanonicalLeagueState` snapshot |
| Current-week projections, replacement frontier, byes, roster constraints | derived from that same snapshot via `buildWeeklyTeamContext({ snapshotOverride })` — no 2nd read |
| ROS bye-weeks-by-team map | `scheduleProvider.getWeekSchedule` — **a separate, deliberately independent feed** (the NFL schedule is provider-independent league data, not part of canonical ownership/roster state) — see §28 below |

**Immutability across participants/trades:** `reconstructRosters` (Phase 1,
frozen) builds `before`/`after` per manager from the *original* rosters map, not
from a running mutation. A new test evaluates **two different trades against
the same `TradeAnalysisContext`** and proves neither leaks into the other, and
that the underlying roster map is never mutated (byte-identical
`JSON.stringify` before and after both analyses).

---

## C. Defects found

| Severity | Component | Failure |
|---|---|---|
| **P2** | `lib/trades/context.ts` — remaining-week/playoff partition | A trade evaluated **at or after** the league's configured `playoff_start_week` (mid-playoff-push, or the whole remaining horizon is the playoffs) had its entire remaining window mislabeled `regular_season_ros_delta` with `playoff_window_delta: null`, and the diagnostic falsely claimed "playoff settings did not resolve" even though they had. |
| **P2** | `lib/trades/depth.ts` — `rosterResilience` | `usable_depth_score` / `fragility_score` (which **sum** across `BASE_POSITIONS`) double-counted a player eligible at more than one base position (a real Sleeper case — `fantasy_positions` can list e.g. a QB/TE-flagged player), crediting the same body as a "usable backup" at both positions. |
| P3 | `lib/trades/depth.ts` | Dead/unused `nominalBackups` local (computed, then `void`'d) and an unused `starters` Set — cleanup only, no behavioral effect. |
| P3 | `lib/trades/ros.ts` / `depth.ts` / `evaluate.ts` | `round2` could return `-0` for an exact-zero leave-one-out delta (`-(withP - withoutP)` where the difference is `0`), which is behaviorally harmless (`-0 === 0`) but fails `Object.is`-based strict test assertions and could display confusingly. |

### D1 — playoff-window mislabeling (P2), full detail

```
Component:  lib/trades/context.ts, buildTradeAnalysisContext (week-range logic)
Failure:    `playoffStartWeek = ps.playoff_start_week > week ? ps.playoff_start_week : null`
            — at week === playoff_start_week (or later), the condition is false,
            so the ENTIRE remaining window fell through to "regular season" with
            no playoff split, and PLAYOFF_WINDOW_UNAVAILABLE was emitted with a
            message implying the settings never resolved.
Why it matters: a manager evaluating a trade DURING their playoff push would see
            100% of the analyzed window reported as "regular season" value with
            no playoff-window figure at all — exactly backwards.
Reproduction: `resolveRosWeekPlan(15, 17, 15)` (week 15 = playoff_start_week 15)
            returned `regular_season_weeks: [15,16,17]`, `playoff_weeks: []`
            before the fix.
Root cause: the comparison `playoff_start_week > week` (strict) rather than
            clamping the effective start to `max(playoff_start_week, week)`.
Fix:        extracted `resolveRosWeekPlan(week, championshipWeek,
            playoffStartWeekRaw)` as a pure, exported, directly-tested function.
            It clamps `effectiveStart = max(raw, week)`; if that's within the
            horizon the ENTIRE remainder from there is the playoff window (even
            if that's 100% of the analyzed range); otherwise it reports
            `playoff_unresolved_reason: "outside_range"` (distinct from
            "unresolved", i.e. settings never configured) so the diagnostic is
            accurate.
Regression: `test/trade-engine-phase2-audit.test.ts` §"remaining-week geometry"
            — 7 tests covering future/at-now/past/outside-range/unresolved, plus
            a gapless-partition sweep across preseason → mid-playoffs fixtures.
            The test-fixture's OWN synthetic context builder was ALSO found to
            re-implement (and share) the identical buggy logic independently —
            fixed by making it call the same shared `resolveRosWeekPlan`, so a
            future regression here cannot hide behind a diverged test harness.
Version impact: `ri-trade-contextual-2026.1` -> `2026.2` (playoff-window and
            regular/playoff split values for at/past-playoff-start trades change).
```

### D2 — cross-position depth double-count (P2), full detail

```
Component:  lib/trades/depth.ts, rosterResilience
Failure:    `atPos = players.filter(p => p.position === pos || p.eligible_positions.includes(pos))`
            — a player eligible at TWO base positions (e.g. Sleeper's
            `fantasy_positions: ["QB","TE"]` for some real players) appeared in
            BOTH positions' `atPos` buckets, so `usable_backups`/`viable_starters`
            — which the aggregate SUMS across positions — credited that single
            roster spot twice.
Why it matters: `usable_depth_score` and `fragility_score` are the Phase 2C
            headline numbers; double-crediting a dual-eligible player inflates
            usable depth and understates fragility for any roster holding one.
Reproduction: a QB/TE dual-eligible bench player showed `usable_backups: 1` at
            BOTH the QB bucket and the TE bucket simultaneously.
Root cause: base-position bucketing used `eligible_positions`, appropriate for
            Phase 1's `computePositionalNeeds` (which reports per-position FACTS
            without summing them) but wrong for a SUMMED aggregate.
Fix:        base-position bucketing now uses `p.position === pos` (primary
            position) ONLY. A player's extra FLEX-qualifying eligibility is
            still captured, exactly once, by the separate (non-summed-per-base-
            position) FLEX-pool count — a genuinely different structural
            question ("can this body fill the flex slot") from "is this a QB
            depth body", so crediting both is intentional, not a double count.
Regression: two tests — the dual-eligible player is credited identically to a
            single-eligible equivalent at its OWN base position, and does not
            ALSO appear as a backup/viable-starter at any other base position
            (compared against a roster with no such player, not a naive zero,
            since FLEX-eligible starters can legitimately create bench surplus
            at other positions independent of the dual-eligible player).
Version impact: `ri-trade-contextual-2026.1` -> `2026.2` (usable_depth_score /
            fragility_score change for any roster holding a multi-base-eligible
            player).
```

No P0 or P1 defects were found. The central invariant — usable ROS effect via
roster displacement, without double-counting Phase 1 value — holds.

---

## D. Corrections made

| File | Change | Driven by |
| --- | --- | --- |
| `lib/trades/context.ts` | Extracted pure, exported `resolveRosWeekPlan`; fixed the at/past-playoff-start mislabeling; distinguishes `playoff_unresolved_reason: "unresolved"` vs `"outside_range"` | D1 |
| `lib/trades/depth.ts` | Base-position bucketing uses primary `position` only (not `eligible_positions`); removed dead `nominalBackups`/`starters` locals | D2, P3 cleanup |
| `lib/trades/ros.ts`, `depth.ts`, `evaluate.ts` | `round2` normalizes `-0` → `0` | P3 |
| `test/fixtures/trades.ts` | Synthetic `context()` now calls the SAME `resolveRosWeekPlan` instead of an independent (buggy) reimplementation | D1 test-harness drift |
| `lib/trades/context.ts` | `TRADE_CONTEXT_VERSION` → `ri-trade-contextual-2026.2` + changelog | version policy |
| `test/trade-engine-phase2-audit.test.ts` | New — 34 audit tests | audit |

---

## E. Audit test matrix

| Section | Result | Notes |
| --- | --- | --- |
| §1 Phase 1 freeze | **PASS** | 65/65 unchanged; no-context byte-identical proof; no shared-helper regression (120/120 weekly) |
| §2 Snapshot consistency (one read) | **PASS** | adversarial provider returning different data every call → invoked once |
| §3 Snapshot immutability | **PASS** | two distinct trades against one context don't cross-contaminate; roster map never mutated |
| §4 ROS input units/denominators | **PASS** | `ros_weekly_mean` traced exactly; zero-games-remaining → `null` mean, never divide-by-zero or fabricated 0; missing team info falls back to the full window, not a crash |
| §5 Bye-week handling A–E | **PASS** | clean replacement / no replacement / trade solves it / trade creates exposure / shared-bye does NOT falsely solve it |
| §6 Remaining-week geometry | **PASS (D1 fixed)** | preseason through mid-playoffs sweep, gapless partition proven algebraically |
| §7 Weekly ROS optimization (not naive sum) | **PASS** | reused from `trade-engine-phase2.test.ts`; re-verified via the composite matrix |
| §8 Flat per-game sanity | **PASS (documented limitation)** | behaves consistently; no false matchup-intelligence claim; see Phase 2 doc "Limitations" |
| §9 Regular/playoff split | **PASS (D1 fixed)** | no gaps, no overlaps, degrades explicitly when unresolved |
| §10 ROS replacement-level reuse | **PASS** | reuses `computeWeeklyReplacement`/`ctx.replacement` unchanged; no second/incompatible VOR definition |
| §11 Usable depth categories | **PASS (D2 fixed)** | nominal-vs-viable, FLEX coverage, redundant-depth all traced |
| §12 Replacement cliff | **PASS** | sign/magnitude correct; never treats a starter as its own backup; `null` (not 0) when no backup exists |
| §13 Fragility model | **PASS** | sign convention confirmed system-wide (`fragility_delta`: + = less fragile); lose-only-backup worsens, gain-backup improves, starter-gain + fragility-loss surfaced separately |
| §14 Position/FLEX interaction | **PASS** | reuses `slotEligiblePositions`/`isFlexSlot` (frozen); no local position matcher |
| §15 Marginal player utility | **PASS** | leave-one-out traced; order-invariant (proven) |
| §16/§17 Interaction residual | **PASS — see finding F below** | identity verified exactly; documented adversarial `-48` reproduced and explained |
| §18 Consolidation (HHI) | **PASS** | 3-for-1 / 1-for-3 / 1-for-1-barely-moves all confirmed |
| §19 Roster shape | **PASS** | purely descriptive; grep-confirmed no other code path reads it |
| §20 Composite safety | **PASS — see finding G below** | exact equality across a 2-team/3-team/fragility/consolidation matrix, including trade-level `contextual_viability` |
| §21 Hidden weight audit | **PASS** | grep-traced every consumer of every Phase 2 delta; all weight-gated or purely informational |
| §22 Contextual acceptance | **PASS** | equals `phase1_acceptance` exactly at weight 0 |
| §23 Divergence explanation | **PASS** | reused from `trade-engine-phase2.test.ts`; names the specific driving components |
| §24 Weight/scale safety | **PASS** | `resolveTradeConfig` rejects non-monotonic thresholds; nonzero synthetic weights tested without NaN/Infinity |
| §25 Correlation-risk matrix | **DOCUMENTED** | see §H below — audit artifact, no weights assigned |
| §26 Missing ROS coverage | **PASS** | `ROS_PARTIAL_PLAYER_COVERAGE` fires, excluded not zeroed, Phase 1 unaffected |
| §27 Degradation isolation | **PASS** | ROS-unavailable / replacement-pool-degraded / schedule-unavailable each tested independently; Phase 1 survives every case |
| §28 Schedule feed | **DOCUMENTED, not redesigned** | per-season cache (one fetch/season, reused across all remaining-week calls); a failed week degrades that week only (`PARTIAL`), never the whole ROS evaluation; documented as an intentionally separate feed from canonical ownership |
| §29 Determinism | **PASS** | 5× repeated 3-team evaluation byte-identical |
| §30 Participant/transfer ordering | **PASS** | marginal attribution and interaction residual proven order-invariant |
| §31 Same player, different roster | **PASS** | ROS usable value, usable-depth delta all differ for needy vs. stacked roster |
| §32 Three-team Phase 2 | **PASS** | circular routing, independent per-participant evaluation, `phase2_summary` populated |
| §33 Nonparticipant isolation | **PASS** | inherited from Phase 1 audit + re-verified via §3 |
| §34 API compatibility | **PASS** | additive fields only; existing Phase 1 request shape unaffected |
| §35 Adversarial matrix | **PASS** | 20-item list substantially covered across both Phase 2 test files (ROS/current-week divergence, standalone-vs-usable, bye scenarios, consolidation both directions, redundant/scarce depth, FLEX competition, replacement environments, three-team hidden loser, ordering, partial coverage, schedule degradation) |
| §36 Real Bloodline smoke test | **NOT TESTED — ENVIRONMENT** | no provider network here; fake-provider integration coverage (§2) passes |
| §37 Regression suite | **PASS** | see §I |

**34 new deterministic audit tests**, all passing, on top of the existing 26
Phase 2 + 65 Phase 1 tests (125 trade tests total).

---

## F. Interaction-residual finding

**The formula is mathematically valid.** Identity:

```
interaction_residual = ros_usable_value_delta − Σ(marginal_ros_delta over all transferred players)
```

verified exactly (to the rounding unit) by direct computation in
`test/trade-engine-phase2-audit.test.ts`. The two per-direction leave-one-out
baselines are, by design, **not the same roster state**:

- an **OUTGOING** player's marginal is `−(before.usable − (before minus that
  player).usable)` — a single-player deviation from the ORIGINAL roster (every
  other outgoing/incoming change has NOT yet happened in this counterfactual);
- an **INCOMING** player's marginal is `after.usable − (after minus that
  player).usable` — a single-player deviation from the FINAL roster (every
  other change HAS already happened).

When two outgoing players are mutual backstops for the same slot (e.g. a
benched WR who would fill FLEX if the starting FLEX player left), the outgoing
player's leave-one-out baseline still has its backstop present, so its
individual marginal understates the cost of losing them TOGETHER; the incoming
player's leave-one-out baseline already lacks both, so it claims the full value
of filling the resulting void alone. Summed, these do not equal the true
before→after delta — the gap is exactly what `interaction_residual` reports.

**The documented `−48` example is expected, not a bug.** Traced fully in the
audit test ("two incoming players competing for ONE FLEX slot"): `ELITE`
(incoming) marginal = **+132** (its full standalone value, since the after-state
leave-one-out already lacks both outgoing players and nothing else fills FLEX);
`HOTNOW` (outgoing) marginal = **0** (its before-state leave-one-out still has
`RB3` as a backstop, so losing HOTNOW alone costs nothing); `RB3` (outgoing)
marginal = **−18** (losing RB3 alone costs a little, backstopped by HOTNOW in
that counterfactual). Sum = 114; actual total = 66; residual = **−66 − ...** —
reproduced exactly as `114 − 66 = 48`, i.e. `interaction_residual = 66 − 114 =
−48`. No double subtraction, no incoming/outgoing sign mixing: each of the three
numbers independently checks out against its own defined counterfactual. The
transaction-level `ros_usable_value_delta` (66) is unaffected by any of this —
it comes from one direct `after − before` comparison, not from summing
marginals. **No fix required**; the code comment and this doc now explain the
asymmetric-baseline mechanism so a future reader does not mistake a large
residual for an error.

---

## G. Composite safety finding

**Proven: with all Phase 2 weights at their default of 0,
`contextual_utility_delta === roster_utility_delta` and `contextual_acceptance
=== phase1_acceptance`, exactly, with no floating-point drift.**

Verified across a matrix of 2-team (current-week winner, high-fragility-change,
high-consolidation-change) and 3-team (circular routing) fixtures — every
participant's `phase2.contextual_utility_delta` is bit-for-bit equal to
`roster_utility_delta` (`assert.equal`, not an epsilon comparison), and
`phase2.acceptance_divergence_reason` is `null` in every case. Additionally
proven at the **trade level**: `phase2_summary.contextual_viability ===
trade_summary.trade_viability`, since `classifyViabilityFromDeltas` consumes
the same (weight-0-identical) deltas and acceptances through the identical
threshold logic as Phase 1's own `classifyViability`.

Mechanically this holds because `weightedAdd` is a literal sum of
`0 * component` terms (one `null`-guarded), so `contextualUtilityDelta =
round2(r.roster_utility_delta + 0)`; since `r.roster_utility_delta` is already
`round2`-normalized JavaScript float rounding is idempotent for it.

---

## H. Correlation-risk matrix (audit artifact — no weights assigned)

| Pair | Risk | Why |
| --- | --- | --- |
| `ros_usable_value` × Phase 1 `starter_points` | **HIGH** | the current fantasy week is included in `regular_season_ros_delta` by design (ROS reasonably starts "now"); a starter-points win this week is partially re-counted in the ROS regular-season delta |
| `usable_depth` × Phase 1 `bench_value` | **HIGH** | both are non-starter value proxies (Σ positive VOR vs. capped usable-backup counts) over largely the same bench population |
| `usable_depth` × `roster_fragility` | **MODERATE** | share the same per-position inputs (`viable_starters`, `usable_backups`); constructed to move in opposite directions by design, but are not statistically independent |
| `replacement_context` × Phase 1 `starter_points`/`bench_value` | **MODERATE** | "how much of the outgoing production is replaceable" overlaps what the Phase 1 optimizer already re-prices when it reshuffles the lineup |
| `bye_coverage` × `ros_usable_value` | **MODERATE** | a solved bye hole mechanically raises the same weekly optimal totals that feed `ros_usable_value_delta` in that week |
| `playoff_window` × `ros_usable_value` | **LOW–MODERATE** | disjoint week sets by construction (no week appears in both), but under the current flat per-game model the two windows are numerically similar in shape, not independent evidence |
| `usable_depth` (Phase 2C, own internal FLEX-pool term) × per-position `usable_backups` | **MODERATE (internal)** | a flex-eligible bench player legitimately contributes to BOTH its base-position backup count and the flex-pool surplus (two different structural questions — "injury cover" vs "flex-slot cover") — not a bug (see D2), but the two terms are correlated for any FLEX-eligible bench player and should be inspected together before either gets a nonzero weight |
| `consolidation_effect` × any component | **LOW** | purely descriptive (`roster_shape_delta`), never weighted, mathematically independent of the composite by construction |
| `replacement_cliff` × `roster_fragility` | **HIGH (internal)** | `fragility_score`'s `no_cover` term is directly built FROM `replacement_cliff` — these are not two independent signals, one is a component of the other |

None of these were assigned a production weight. Phase 3 calibration should
start by regressing each HIGH-risk pair against real historical trade outcomes
before considering either for a nonzero weight.

---

## I. Regression results

```
Phase 2 audit suite  (trade-engine-phase2-audit.test.ts, NEW)   34 / 34  pass
Phase 2 suite        (trade-engine-phase2.test.ts)              26 / 26  pass
Phase 1 suite        (trade-engine + trade-engine-audit)        65 / 65  pass   (unchanged)
Trade total                                                    125 / 125 pass
Weekly engine suite                                            120 / 120 pass
Full repository suite                                          1003 tests, 993 pass, 10 fail
tsc --noEmit                                                   clean
eslint                                                         0 errors (18 pre-existing warnings, none in lib/trades)
```

The 10 failures are the same pre-existing network `live:` tests as every prior
baseline in this project (`live: standings/managers/snapshot`,
`LIVE — real recommendation endpoint`, `LIVE — real raw K/DEF fallback board`,
`live draft snapshot`, `live draft: pre-draft state`).
`grep '^not ok' | grep -v -i live` → **0**. Baseline before this audit was
`959 pass / 10 fail`; **+34 tests, zero non-`live` regressions.**

---

## J. Remaining limitations

**Phase 2 defects:** none outstanding — D1 and D2 are fixed with regression
coverage; the round2 `-0` normalization (P3) is applied.

**Deliberate Phase 2 limitations (unchanged from the build deliverable):**
flat per-game ROS mean (no week-by-week projections or schedule strength); all
composite weights held at 0 pending calibration; structural (non-probabilistic)
fragility; `analyzeTrade` still fetches the NFL schedule per remaining week
(cached per season, a deliberately separate feed from canonical roster state —
see §28); real deployed-Bloodline smoke test not run (no provider network in
this environment).

**Future calibration work (Phase 3, not started):** use the correlation-risk
matrix (§H) as the starting checklist — regress each HIGH-risk pair against
real historical trades before enabling any composite weight; only then consider
whether `playoff_window` becomes numerically distinct from `regular_season`
once real per-week/schedule-strength inputs exist.

**Future trade-discovery work:** unchanged — out of scope until calibration
lands. Not started in this audit.

---

## Phase 2 Contextual Valuation Freeze Gate

- Phase 1 remains behaviorally frozen ✓ (65/65 unchanged, no-context byte-identical, no hidden coupling)
- One canonical roster snapshot drives each analysis ✓ (verified with a provider returning different data per call)
- Pre/post evaluations share that snapshot ✓
- ROS units and week geometry are correct ✓ (after D1 fix; gapless partition proven algebraically across the season)
- Bye handling is correct ✓ (A–E fixtures, including the shared-bye trap)
- Weekly optimization captures displacement ✓ (reuses the frozen `buildOptimalLineup`)
- High standalone ROS ≠ high roster utility automatically ✓ (buried-bench-player fixture)
- Depth metrics reflect actual lineup eligibility ✓ (after D2 fix; reuses frozen slot logic)
- Replacement cliffs are correct ✓ (sign, magnitude, no self-reference, no fabricated 0)
- Fragility is interpretable and sign-consistent ✓ (`+` = less fragile, verified system-wide)
- Consolidation metric is mathematically coherent ✓ (HHI, 1-for-1 stability proven)
- Interaction residual is valid and order-invariant ✓ (§F; identity verified; marginal attribution order-invariant)
- Three-team Phase 2 behavior is correct ✓
- Participant/transfer ordering does not change results ✓
- Degradation does not corrupt Phase 1 ✓ (each subsystem fails independently, verified)
- Zero Phase 2 weights produce exactly Phase 1 utility ✓ (§G, exact equality, participant AND trade level)
- No hidden contextual penalties exist ✓ (§21, every consumer of every Phase 2 delta traced)
- No correlated component given an uncalibrated production weight ✓ (all weights 0; §H documents the risk matrix for Phase 3)
- API remains Phase 1 compatible ✓ (additive fields only)
- Results are deterministic ✓ (5× repeated 3-team evaluation byte-identical)
- No non-`live` regressions exist ✓ (993/10, identical failure set to baseline)

```
PHASE 2 CONTEXTUAL VALUATION AUDIT:
READY TO FREEZE
```

### Recommended next step

Calibration (Phase 3), per §H and §J: collect real historical trades, compute
every Phase 2 component, inspect the correlation matrix starting with the
HIGH-risk pairs, and only then consider enabling specific composite weights.
**Do not implement automated trade discovery, target search, or counteroffers
until calibration is complete and reviewed.**
