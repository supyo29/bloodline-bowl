# Bloodline Bowl Trade Engine — Phase 2: Contextual Roster Valuation

Phase 1 foundation: **`ri-trade-foundation-2026.2`** (frozen)
Phase 2 valuation: **`ri-trade-contextual-2026.2`** (audited — see `TRADE_ENGINE_PHASE2_AUDIT.md`; was `2026.1` at initial build)

Both versions are returned on every `POST /api/trades/analyze` response
(`trade_foundation_version`, `trade_context_version`).

---

## A. Phase 1 freeze confirmation

**`ri-trade-foundation-2026.2` remains frozen. No Phase 1 defect was found or corrected.**

- `evaluateTrade` behaviour is **byte-identical** whether or not a Phase 2
  `TradeAnalysisContext` is supplied. All 65 Phase 1 tests
  (`trade-engine.test.ts` + `trade-engine-audit.test.ts`) pass **unchanged**.
- The Phase 1 result fields (`starter_points_delta`, `starter_vor_delta`,
  `bench_value_delta`, `roster_utility_delta`, `acceptance`,
  `positional_need_changes`, `lineup_displacement`, `trade_summary`, every
  diagnostic) are untouched and remain authoritative.

**One additive change to shared code (Phase 2A), not a Phase 1 correction:**
`lib/weekly/context.ts` gains an optional `snapshotOverride` on
`BuildWeeklyContextOptions`. When set, `buildWeeklyTeamContext` assembles from
that snapshot instead of performing its own `buildCanonicalLeagueState` read.
When unset (every existing caller), behaviour is unchanged — all **120 weekly
tests pass**. This is exactly the Phase 1 audit's recommended Phase 2 opener
("single-read context assembly"); the Phase 1 audit had documented the
two-read `analyzeTrade` as a *deliberate limitation*, not a defect.

`analyzeTrade` now performs **exactly one** provider read (verified by test —
a provider that returns different data on every call is invoked once).

---

## B. Phase 2 architecture summary

```
buildTradeAnalysisContext(leagueSlug, opts)                     [lib/trades/context.ts]
  1 × buildCanonicalLeagueState  ── the ONLY provider read
  buildWeeklyTeamContext({ snapshotOverride })  ── projections + replacement + byes, NO 2nd read
  N × scheduleProvider.getWeekSchedule (rest-of-season weeks; season feed cached after 1st)
  ->  immutable TradeAnalysisContext
        { league, scoring, constraints, players_by_id, projections(+ros),
          replacement, byes, ros:{ weeks, regular/playoff split, bye_weeks_by_team,
          schedule_status }, rosters_by_manager, snapshot, versions, diagnostics }

analyzeTrade(proposal, opts)                                    [lib/trades/analyze.ts]
  resolve participants + players against ctx.snapshot
  validateTrade  (frozen Phase 1)
  evaluateTrade({ ...phase-1 inputs, context })                 [lib/trades/evaluate.ts]
    ── Phase 1 loop (frozen)  -> results[]
    ── if context:  attachPhase2(results, ctx, config)
         per participant:
           evaluateRosParticipant  [lib/trades/ros.ts]    -> RosParticipantResult
           evaluateDepthParticipant[lib/trades/depth.ts]  -> DepthParticipantResult
           components (per-week-equivalent) + contextual_utility_delta + contextual_acceptance
         phase2_summary
```

### ROS valuation (`lib/trades/ros.ts`)

- **Per-player ROS signal**: `ros_points` = the external prorated
  rest-of-season total (`wp.ros.points`, the only absolute source — RI's season
  model is used ordinally elsewhere, never blended). `ros_games_remaining` =
  remaining fantasy weeks minus the player's schedule-verified byes.
  `ros_weekly_mean = ros_points / ros_games_remaining`. No signal ⇒ `covered:
  false`, the player is **excluded** from the ROS lineup (never a 0) and listed
  in the diagnostic.
- **Weekly optimization across the ROS range**: for each remaining fantasy week,
  a per-week projection batch is built (`projected_points = ros_weekly_mean`;
  players on a schedule-verified bye that week are removed from both the
  candidate roster and the batch), and the **same `buildOptimalLineup`** (the
  frozen Hungarian optimizer + shared slot eligibility) is run. Weekly optimal
  totals are summed and split into `regular_season` / `playoff_window`.
- **Marginal usable, not season totals**: a 200-point ROS bench player who can't
  crack the optimal lineup contributes ~0; the model only credits what the
  optimal weekly lineup would start. `stranded_ros_points` = standalone − usable.
- **Bye coverage**: `bye_hole_slot_weeks` = Σ (unfillable starter slot × week)
  across the ROS range; `bye_coverage_delta = before − after` (+ = fewer holes).
- **Marginal player utility**: per transferred player, a leave-one-out on the
  relevant roster (ROS usable value with vs without that player). The sum of the
  per-player deltas need not equal the transaction total — `interaction_residual`
  = `total − Σ(marginals)` exposes the non-additivity; the transaction-level
  `ros_usable_value_delta` is authoritative.
- **Consolidation vs depth**: `usable_concentration` = Herfindahl index of the
  roster's ROS weekly-mean pool (Σ squared shares). `consolidation_effect` =
  after − before; `roster_shape_delta` ∈ `STAR_CONCENTRATION` /
  `DEPTH_DISTRIBUTION` / `NEUTRAL`, gated so it only fires when usable value did
  not collapse (a premium must arise from real lineup value, not asset count).

### Usable depth & fragility (`lib/trades/depth.ts`) — deterministic, structural

- **Per position** (`PositionDepth`): `viable_starters` (slot-eligible, ≥ the
  league replacement line), `usable_backups` (viable beyond the requirement,
  capped in the aggregate), `nominal_backups` (bench bodies below replacement —
  *not* counted as usable), `replacement_cliff` (marginal starter − best backup),
  `understaffed`, `no_cover`.
- **FLEX pool**: viable flex-eligible players beyond base demand; `shallow` when
  a flex slot has no surplus.
- **`usable_depth_score`** (higher = better): Σ `min(usable_backups, 3) ·
  position_weight` + flex surplus. **`fragility_score`** (higher = MORE fragile):
  `understaffed` → heavy; `no_cover` → medium, scaled by a steep cliff; a
  cover-less required position → light; shallow flex → light.
- **`replacement_context_delta`**: for each outgoing player, how much of their
  weekly production a realistic replacement (best post-trade same-position
  backup, or the FA replacement line) recovers; `replaced − out_production`
  (≤ 0 — the net production genuinely lost).

### Composite

`contextual_utility_delta = roster_utility_delta (Phase 1) + Σ weightᵢ·componentᵢ`.
**Every Phase 2 weight defaults to 0** (see Calibration). With defaults:
`contextual_utility_delta === roster_utility_delta` and `contextual_acceptance
=== phase1_acceptance` exactly — Phase 2 is *exposed*, not folded in.
`phase1_acceptance` is always carried alongside; `acceptance_divergence_reason`
is populated (naming the driving components) only when a caller sets nonzero
weights and the classes differ.

`phase2_summary`: `all_teams_improve_ros`, `ros_largest_beneficiary`,
`ros_losers_phase1_missed` (Phase 1 says improve, ROS usable value drops
> 0.5), `fragility_worsened_for` (`fragility_delta < −1`), `contextual_viability`.

Every Phase 2 metric works identically for 2- and 3-team trades — each
participant is evaluated independently; a losing participant is never averaged
away.

---

## C. Metrics specification

`TradeAnalysisContext.ros` and Phase 2 per-participant fields. Sign convention
throughout: **+ = better for that manager**. All composite weights default **0**.

| Metric | Definition | Units | Inputs | Sign | Weight | Fallback |
| --- | --- | --- | --- | --- | --- | --- |
| `ros.ros_points` (per player) | external prorated rest-of-season total | league points | `wp.ros.points` → `wp.rest_of_season_points` | — | — | `null` → player excluded from ROS lineup, `ROS_PARTIAL_PLAYER_COVERAGE` |
| `ros.ros_games_remaining` | remaining fantasy weeks minus schedule-verified byes | weeks | ROS week range + `bye_weeks_by_team` | — | — | no schedule → full week count (no byes asserted), `BYE_DATA_UNAVAILABLE` |
| `ros.ros_weekly_mean` | `ros_points / ros_games_remaining` | league points/week | above | — | — | `null` when `ros_points` null |
| `before/after.usable_ros_points` | Σ weekly `buildOptimalLineup` optimal total over the ROS range | league points | per-week ROS batches + frozen optimizer | higher = better | — | UNKNOWN starter in a week → that week uses `known_optimal_subtotal` |
| `regular_season_usable` / `playoff_window_usable` | same, split by `playoff_start_week` | league points | league playoff settings | — | — | no playoff settings → all weeks regular, `PLAYOFF_WINDOW_UNAVAILABLE` |
| `stranded_ros_points` | `standalone_ros_points − usable_ros_points` (≥ 0) | league points | above | lower = better (less waste) | — | — |
| **`ros_usable_value_delta`** | `after.usable_ros_points − before.usable_ros_points` | league points (whole ROS) | above | + = better | `component = /remaining weeks`, **weight 0** | 0 when no ROS signal for anyone (`ROS_PROJECTIONS_UNAVAILABLE`) |
| `regular_season_ros_delta` | regular-window slice of the above | league points | — | + | exposed | — |
| **`playoff_window_delta`** | playoff-window slice | league points | playoff settings | + | `component = /playoff weeks`, **weight 0** | `null` + `PLAYOFF_WINDOW_UNAVAILABLE` |
| **`bye_coverage_delta`** | `before.bye_hole_slot_weeks − after.bye_hole_slot_weeks` | (slot × week) count | ROS lineups | + = fewer holes | **weight 0** | 0 when schedule unavailable |
| `standalone_ros_swing` | `Σ incoming ros_points − Σ outgoing ros_points` (the naive number, for contrast) | league points | player signals | — | never weighted | — |
| `marginal_player_utility[].marginal_ros_delta` | leave-one-out ROS usable delta for that player on the relevant roster | league points | ROS lineups | attribution only | never weighted | `null` if signal missing |
| `marginal_player_utility[].marginal_starter_delta` | current-week leave-one-out optimal-lineup delta (Phase 1 unit) | league points | frozen optimizer | attribution only | never weighted | `null` if an UNKNOWN starter blocks it |
| `interaction_residual` | `ros_usable_value_delta − Σ marginal_ros_delta` | league points | above | — | never weighted | 0 |
| `usable_concentration_before/after` | Herfindahl index of the ROS weekly-mean pool | 0–1 | player signals | — | never weighted | 0 when pool empty |
| `consolidation_effect` | `concentration_after − concentration_before` | 0–1 delta | above | descriptive | never weighted | 0 |
| `roster_shape_delta` | `STAR_CONCENTRATION` / `DEPTH_DISTRIBUTION` / `NEUTRAL` | enum | `consolidation_effect`, player-count delta, `usable_delta` | descriptive | — | `NEUTRAL` |
| `depth.by_position[].viable_starters` | slot-eligible active players ≥ replacement line | count | current projections + replacement | higher = better | — | no replacement level → raw count, `REPLACEMENT_POOL_DEGRADED` |
| `depth.by_position[].usable_backups` | `max(0, viable_starters − requirement)` | count | above | higher = better | — | — |
| `depth.by_position[].replacement_cliff` | `marginal_starter_points − best_backup_points` (≥ 0) | league points | above | lower = better | — | `null` if a term missing |
| **`depth.usable_depth_delta`** | `after.usable_depth_score − before.usable_depth_score` | score | Σ capped usable backups × position weight + flex surplus | + = better | **weight 0** | falls back to raw counts under `REPLACEMENT_POOL_DEGRADED` |
| **`depth.fragility_delta`** | `before.fragility_score − after.fragility_score` | score | understaffed/no-cover/cliff/shallow-flex penalties | + = LESS fragile | **weight 0** | — |
| **`depth.replacement_context_delta`** | `Σ replaced − Σ outgoing_production` (≤ 0) | league points/week | replacement line + post-trade backups | + (closer to 0) = better | **weight 0** | 0 when no outgoing player has a projection |
| `contextual_utility_delta` | `roster_utility_delta + Σ weightᵢ·componentᵢ` | league points | Phase 1 + components above | + = better | — | == Phase 1 with default weights |
| `contextual_acceptance` | `classifyAcceptance(contextual_utility_delta)` | enum | frozen Phase 1 bands | — | — | == `phase1_acceptance` with default weights |

**Phase 2 diagnostics** (a partial Phase 2 result never removes Phase 1
analysis): `ROS_PROJECTIONS_UNAVAILABLE`, `ROS_PARTIAL_PLAYER_COVERAGE`,
`BYE_DATA_UNAVAILABLE`, `PLAYOFF_WINDOW_UNAVAILABLE`, `REPLACEMENT_POOL_DEGRADED`,
`DEPTH_MODEL_DEGRADED`, `TRADE_CONTEXT_SNAPSHOT_INCOMPLETE`, `PHASE2_UNAVAILABLE`.

---

## D. Calibration

Per the Phase 1 audit (which found `starter_points`/`starter_vor` double-counted
at weights 1.0 + 0.35), **no Phase 2 component receives a nonzero composite
weight** until its correlation and conceptual overlap with the Phase 1 terms are
established against real league data. Conceptual-overlap analysis:

| Component | Overlap with Phase 1 `roster_utility_delta`? | Held at weight 0 because |
| --- | --- | --- |
| `ros_usable_value` | **Partial** — `regular_season_ros_delta` includes the current week, so it correlates with `starter_points_delta` for trades that also help now | The independent signal (weeks 2..N) is not yet separated out; folding the whole delta in would re-count the current week |
| `playoff_window` | Low overlap with Phase 1 (different weeks entirely) | Depends on `playoff_start_week` resolving; the per-game ROS model has no schedule-strength input yet, so playoff-week value ≈ regular-week value — not yet a distinct signal |
| `bye_coverage` | Low | A count, not points; needs a points-equivalent calibration before it can be summed |
| `usable_depth` | Moderate — overlaps the Phase 1 `bench_value` term | Both are non-starter value proxies; summing risks the same double-count class |
| `roster_fragility` | Low direct overlap, but anti-correlated with `usable_depth` by construction | The two Phase 2C scores share inputs; only one should be weighted, TBD by calibration |
| `replacement_context` | Moderate — related to what Phase 1's optimizer already reshuffles to cover | Risk of re-charging a cost the optimizer already priced |

**Recommended calibration (Phase 3):** collect ~50–100 real historical Bloodline
Bowl / Devoted trades, compute all components, inspect the correlation matrix and
component distributions, and enable weights only for components that are (a)
independent of the Phase 1 terms and (b) monotonic in the intended direction.
Until then the components are the product — a manager reads
`ros_usable_value_delta`, `fragility_delta` and `roster_shape_delta` directly.

---

## E. Test results

```
Phase 2 suite  (test/trade-engine-phase2.test.ts)        26 / 26  pass
Phase 1 suite  (trade-engine.test.ts + -audit.test.ts)   65 / 65  pass   (unchanged)
Trade total                                              91 / 91  pass
Weekly engine (context.ts snapshotOverride regression)  120 / 120 pass
Full repository suite                                   969 tests, 959 pass, 10 fail
tsc --noEmit                                            clean
eslint                                                  0 errors (18 pre-existing warnings, none in lib/trades)
```

The 10 failures are **all pre-existing network `live:` tests** (`live: standings
/ managers / snapshot`, `LIVE — real recommendation endpoint`, `LIVE — real raw
K/DEF fallback board`, `live draft snapshot`, `live draft: pre-draft state`) —
`grep '^not ok' | grep -v -i live` returns **0**. Identical to a clean `main`.

### Phase 2 coverage

- **2A snapshot consistency** — `analyzeTrade` reads league state exactly once
  though the provider returns different data on every call · repeated analyses
  deterministic · `buildWeeklyTeamContext` with `snapshotOverride` performs no
  provider read (verified with a throwing provider) · versions exposed.
- **2B ROS** — huge-standalone/no-room bench player barely moves usable value ·
  startable ROS asset raises it · shared bye leaves a ROS hole, an unaffected
  starter covers it · ROS impact diverges from current-week impact · regular vs
  playoff windows separate · same player different ROS utility on different
  rosters.
- **2B consolidation** — 3-for-1 reads `STAR_CONCENTRATION`, 1-for-3
  `DEPTH_DISTRIBUTION` · asset count alone does not set the sign of
  `ros_usable_value_delta`.
- **2C depth/fragility** — nominal bench not counted as usable · trading away the
  only usable backup increases fragility · acquiring a backup reduces it ·
  starter-points gain + fragility loss surfaced as separate facts.
- **Composite** — default config: `contextual_utility_delta` EXACTLY equals the
  Phase 1 `roster_utility_delta` (double-count protection) · components present
  at weight 0 · an explicit nonzero weight moves the composite with a stated
  divergence reason · `resolveTradeConfig` rejects non-monotonic thresholds.
- **3-team** — all three evaluated independently · `phase2_summary` populated.
- **Interaction** — two incoming players competing for one slot → non-zero
  `interaction_residual`, transaction-level total authoritative.
- **Determinism** — byte-identical Phase 2 output across repeated runs.
- **Degradation** — `ROS_PARTIAL_PLAYER_COVERAGE` (excluded not zeroed, Phase 1
  intact) · `BYE_DATA_UNAVAILABLE` (no fabricated byes) ·
  `PLAYOFF_WINDOW_UNAVAILABLE` (component null).
- **Phase 1 freeze** — `evaluateTrade` without context yields no `phase2` field
  and no `phase2_summary`.

---

## F. Adversarial examples

### 1. Phase 1 likes it, Phase 2 downgrades it (fragility)

X trades a hot-now WR (16/wk, 48 ROS) **+ its only RB3 backup** (11/wk) for an
elite ROS WR (20/wk, 132 ROS).

```
phase1:  starter_points_delta +4    roster_utility_delta +1.75   ACCEPT
phase2:
  ros_usable_value_delta          +66  (regular +44, playoff +22)
  fragility_delta                  -5   (X shipped RB2's only cover)
  usable_depth_delta               -2.6
  roster_shape_delta               STAR_CONCENTRATION
  interaction_residual             -48  (ELITE's 132 standalone marginal overstates —
                                         the roster can't use all of it after also losing RB3/HOTNOW)
  contextual_utility_delta         +1.75  (== Phase 1; weights 0)
phase2_summary.fragility_worsened_for = ["X"]
phase2_summary.contextual_viability   = "LOW"
```

Phase 1 says ACCEPT (current lineup up +4). Phase 2 shows the trade *concentrates*
the roster and *guts RB depth* — both facts are surfaced, neither hidden.

### 2. Consolidation

3 bench pieces (9/wk each) → 1 star (24/wk). `roster_shape_delta` =
`STAR_CONCENTRATION` for the consolidating side, `DEPTH_DISTRIBUTION` for the
other. The premium is only reported because the star actually cracks the
consolidating roster's lineup — asset count alone does not move it.

### 3. Depth-building

1 elite WR (22/wk) → 3 useful pieces. `ros_usable_value_delta < 0` for the side
receiving the three (they can't all start), `usable_depth_delta > 0`,
`fragility_delta > 0`. The engine does **not** favour consolidation by default —
it reports the shape and lets the components speak.

### 4. Bye-week consequence

X's only startable TE plays for a team on bye in weeks 3 & 4 →
`before.bye_hole_slot_weeks = 2`. Acquiring a TE on a team with no remaining bye
→ `bye_coverage_delta = +2` (both holes covered).

### 5. Three-team contextual

A (RB-deep, WR hole) → C, C (spare TE) → B, B (WR-deep, TE hole) → A. Each
participant gets an independent `phase2` block; `phase2_summary` reports
`ros_largest_beneficiary` and any `ros_losers_phase1_missed` — a participant
Phase 1 rated as improving whose rest-of-season usable value actually falls.

---

## G. Limitations

### Actual defects
None outstanding. (Phase 2 did not surface any Phase 1 defect.)

### Deliberate Phase 2 limitations

1. **Per-game ROS model, not week-by-week projections.** The repo has a
   current-week projection and a season total, not 14 distinct weekly forecasts.
   The model uses `ros_points / games_remaining` as a flat per-playing-week mean
   (0 on byes). This captures bye displacement and roster-hole effects but not
   week-to-week variance, matchup strength, or a player trending up/down.
2. **No schedule-strength / playoff-matchup input.** `playoff_window_delta` is a
   real week-range split but, with a flat per-game mean, playoff-week value
   ≈ regular-week value. It becomes a distinct signal only once weekly
   projections or an opponent-adjustment model exists.
3. **All Phase 2 composite weights are 0** (see Calibration). The components are
   the deliverable; the scalar `contextual_utility_delta` equals Phase 1 until a
   data-driven calibration justifies weights.
4. **`fragility` is structural, not probabilistic.** No injury probabilities, no
   Monte Carlo. `understaffed` / `no_cover` / cliff / shallow-flex penalties
   only.
5. **`marginal_player_utility` is leave-one-out attribution.** For a strong
   incoming player it can report close to their full standalone ROS;
   `interaction_residual` exposes the non-additivity and the transaction-level
   `ros_usable_value_delta` is authoritative — but per-player attribution in a
   multi-player trade is inherently approximate and labelled as such.
6. **`replacement_context` uses only bench + FA-line replacement**, not a full
   waiver-acquisition search (that is a later phase's concern).
7. **`analyzeTrade` reads the schedule feed once per season (cached) but calls
   `getWeekSchedule` per remaining week** — bounded and fast, but it is I/O in
   the context builder. `evaluateTrade` itself stays pure/synchronous.
8. **Real-data smoke test still pending** — this environment has no network path
   to the Sleeper provider (`live:` suite fails identically on clean `main`). The
   full `analyzeTrade` path IS exercised by an integration test with a fake
   provider (2A). Run one real `POST /api/trades/analyze` against the deployed
   bridge before the Phase 2 audit.

### Phase 3 opportunities (NOT built)

- Empirical weight calibration against historical trades → enable the composite.
- Week-by-week projection inputs (replace the flat per-game ROS mean).
- Schedule-strength / playoff-matchup adjustment → make `playoff_window` distinct.
- `contextual_acceptance` tuned bands (separate from Phase 1's).
- Then, and only then: automated trade discovery / target search / counteroffers.

---

## Phase 2 Freeze Gate

- N-party representation preserved (Phase 1 frozen) ✓
- One provider read per analysis; BEFORE and AFTER from the same snapshot ✓
  (verified: provider changing state mid-request cannot contaminate a result)
- ROS valuation is marginal-usable, respects displacement, splits regular/playoff ✓
- Bye weeks modeled from the authoritative schedule, never fabricated ✓
- Positional scarcity / replacement league-specific (reuses `computeWeeklyReplacement`) ✓
- Usable depth distinguishes real cover from nominal bodies ✓
- Fragility is a separate component, deterministic, not buried in one score ✓
- Post-trade `fragility_delta` surfaced alongside `starter_points_delta` ✓
- Consolidation/dilution arises from usable lineup value, not asset count ✓
- Every metric works for 3-team trades; no participant averaged away ✓
- Interaction effects: non-additive attribution + `interaction_residual` ✓
- Composite double-count protection: default weights 0 → `contextual_utility_delta
  === roster_utility_delta` exactly ✓
- Deterministic given identical snapshot + projections + config + proposal ✓
- Explicit Phase 2 degradation diagnostics; Phase 1 output survives a Phase 2
  failure ✓
- API extends `POST /api/trades/analyze`, no Phase 1 request-compatibility break ✓
- Both versions exposed ✓
- Full regression clean (0 non-`live` failures) ✓

```
PHASE 2 CONTEXTUAL VALUATION:
READY FOR AUDIT
```

Audited 2026-09-04 (`TRADE_ENGINE_PHASE2_AUDIT.md`): 2 defects found (0xP0, 0xP1, 2xP2, 2xP3), all fixed; version bumped to `ri-trade-contextual-2026.2`.

```
PHASE 2 CONTEXTUAL VALUATION AUDIT:
READY TO FREEZE
```

### Recommended Phase 2 audit focus

1. **ROS model honesty** — trace `usable_ros_points` for a hand-computable
   fixture; confirm bye-week exclusion vs the frozen optimizer's VERIFIED_ZERO
   semantics; confirm `interaction_residual` sign and magnitude on multi-player
   trades.
2. **Double-count re-audit** — the exact same discipline the Phase 1 audit
   applied to `starter_vor`: correlation of every Phase 2 component with the
   Phase 1 terms and with each other, on synthetic and (once available) real
   trades, before any weight is raised.
3. **Single-read guarantee** — adversarial: provider mutation between the
   snapshot read and every downstream use; confirm no path re-reads.
4. **Fragility model** — adversarial rosters (only-2-RB, only-1-TE, shallow
   flex) vs resilient ones; confirm `fragility_delta` direction and that it is
   never silently folded into a headline number.
