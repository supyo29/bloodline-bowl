# Bloodline Bowl Trade Engine — Phase 3: Calibration and Player Intelligence

Phase 1 foundation: **`ri-trade-foundation-2026.2`** (frozen)
Phase 2 contextual layer: **`ri-trade-contextual-2026.2`** (frozen)
Phase 3 calibration/player-intelligence: **`ri-trade-calibrated-2026.1`** (new, **shadow mode**)

## A. Freeze confirmation

**`ri-trade-foundation-2026.2` and `ri-trade-contextual-2026.2` remain frozen.
No exception was needed.** Phase 3 is purely additive:

- `evaluatePhase3Participant` runs **after** Phase 2 is fully attached and only
  ever adds a new `r.phase3` key to `ParticipantTradeResult` — it never
  reassigns `roster_utility_delta`, `acceptance`, `phase2`, or `trade_summary`.
- `trade_summary` / `phase2_summary` are computed **before** Phase 3 runs and
  are verified byte-identical whether or not Phase 3 attaches (new test:
  "Phase 2 remains authoritative").
- All 125 pre-Phase-3 trade tests (65 Phase 1 + 26 Phase 2 + 34 Phase 2 audit)
  pass **unchanged**.

## B. Phase 3 architecture

```
evaluateTrade({ ..., context })
  Phase 1 loop (frozen)              -> results[]
  trade_summary = summarize(results)  <- computed BEFORE Phase 2/3 touch anything
  if (context):
    attachPhase2(results, ...)        <- Phase 2 (frozen), unchanged from prior audit
    for each result:
      evaluatePhase3Participant({ ctx, config, phase1_acceptance, phase2, ... })
        buildPlayerIntelligence(id, ctx)   [lib/trades/intelligence.ts]  — per transferred player
        classifyConfidence(...)            [lib/trades/confidence.ts]
        computeShadowUtility(...)          [lib/trades/phase3.ts]        — pure, testable composite math
        classifyAcceptance(shadow, config) — SAME frozen Phase 1 band logic
        buildValuationRange(...)
    phase3_summary = summarizePhase3(results)
```

### Calibration framework (`lib/trades/calibration.ts`, Phase 3A)

Generic statistics over an array of `evaluateTrade` outputs:
`describeDistribution` (mean/median/std/percentiles/zero-and-missing
frequency), `pearson` and `spearman` (pairwise-complete, `null` — not 0 — for
undefined/degenerate cases), `runAblation` (compares a "full" vs. "ablated"
value function's directional accuracy + ranking stability across a scenario
set), and a **static, documented** `CONCEPTUAL_OVERLAP_MATRIX` (an audit
artifact, not derived from data — correlation and conceptual overlap are
tracked side by side, never substituted for each other).

### Player intelligence (`lib/trades/intelligence.ts`, Phase 3B)

**Real-data-only.** This repository has no live in-season usage-stats feed —
no rolling snap share, target share, route participation, or red-zone-touch
tracker. The only usage-component data anywhere in the repo lives in
`lib/projections/*`, the **preseason** Roster Intel draft model
(`ri-structural-2026.3`), which Phase 1/2 already documented as "not a
defensible opponent-specific WEEKLY projection" and consume only ORDINALLY
(rank/tier/confidence). Per the Phase 3 mandate ("do not invent unavailable
statistics"), `PlayerIntelligence` is honest about this split:

| Field | Status | Source |
| --- | --- | --- |
| `availability` | **POPULATED** | `CanonicalPlayer.injury_status` + current-week `expected_availability` |
| `volatility` | **POPULATED** | current-week `std_dev`/`projected_points` (coefficient of variation) + the existing RI-vs-external ROS `disagreement_pct`/`confidence` — takes the WORSE of the two, never understates |
| `usage`, `role`, `trend`, `schedule` | **ALWAYS `UNAVAILABLE`** | no source exists; each carries a `reason` string and a diagnostic (`USAGE_DATA_STALE`, `ROLE_TREND_UNCERTAIN`, `SCHEDULE_STRENGTH_UNAVAILABLE`) |

No small-sample/rookie/blowout heuristics were built for usage trend detection
— there is no usage time series to protect against overreacting to. That
protection becomes relevant once a real feed exists (see Limitations).

### Confidence + uncertainty (`lib/trades/confidence.ts`, Phase 3C)

`classifyConfidence` is a pure function of **data-quality** signals only —
current-week projection status, ROS coverage, schedule verification, unresolved
identities, player-intelligence availability, and cross-layer acceptance
disagreement. It never inspects the utility delta itself, so a near-neutral
result can be reported at `HIGH` confidence and a large one at `LOW` — verified
directly by test. `buildValuationRange` widens a point estimate using the
available volatility evidence and is explicitly labelled `basis:
"std_dev_heuristic"` (never implying a statistical confidence interval it
cannot support).

### Shadow composite (`lib/trades/phase3.ts`, Phase 3D)

```
shadow_utility_delta = computeShadowUtility(
  contextual_utility_delta,      // Phase 2, frozen
  Σ role_adjustment (per player), // ALWAYS 0 — see intelligence.ts
  Σ schedule_adjustment (per player), // ALWAYS 0 — see intelligence.ts
  config.phase3.weights,          // { role_adjustment: 0, schedule_adjustment: 0 }
)
```

Because both adjustments are architecturally pinned at `0` (no validated
signal exists), `shadow_utility_delta === contextual_utility_delta` and
`shadow_acceptance === contextual_acceptance` **exactly**, proven by test
across 2-team and 3-team fixtures at both the participant and composite level.
`computeShadowUtility` and `clamp` are exported and unit-tested with synthetic
nonzero adjustments to prove the weighting/cap/no-NaN mechanics are correct and
ready for the day a real signal populates them — this is a **mechanism
demonstration**, not a claim that role/schedule adjustments are live.

### Historical retrospective framework (`lib/trades/historical.ts`, Phase 3D/E)

A `HistoricalTradeRecord` type and `assertNoLookahead` guard that mechanically
verifies `input_snapshot_captured_at <= trade_date < outcome.evaluated_through`.
**No real Bloodline Bowl trade history was ingested** — this environment has no
network access to pull completed trades from the provider, and this is a
documented data limitation (§I), not a defect. The framework accepts a richer
dataset later without a redesign, per the Phase 3A mandate.

### Shadow-mode behavior (Phase 3E)

Every `ParticipantTradeResult.phase3` carries `PHASE3_SHADOW_ONLY` as its first
diagnostic. `phase3_summary.shadow_only` is hardcoded `true`. Nothing reads
`phase3.shadow_acceptance` to influence `trade_summary`, `phase2_summary`, or
any Phase 1/2 field — verified by tracing every consumer (the same discipline
the Phase 1/2 audits applied) and by an explicit "no hidden Phase 3 influence"
test.

## C. Calibration dataset

- **16 synthetic scenarios**, one per required taxonomy label (`STARTER_UPGRADE`
  … `THREE_TEAM_HIDDEN_LOSER`), each with an `expected_direction`
  (POSITIVE/NEGATIVE/NEUTRAL) against a **named component** (Phase 1
  `roster_utility_delta`, `starter_points_delta`, or Phase 2
  `ros_usable_value_delta` — whichever the label is actually about), never an
  exact target score.
- **2 of the 16 are three-team** (`THREE_TEAM_BALANCED`,
  `THREE_TEAM_HIDDEN_LOSER`), covering complementary-needs circular routing.
- **Roster archetypes vary**: deep-vs-thin at a position, fragile-vs-resilient,
  current-week-vs-ROS divergent, high-variance, high-disagreement.
- **Real historical trades**: **0** (no provider network access in this
  environment). **Human-labeled scenarios**: the 16 synthetic scenarios'
  `expected_direction` function as the human label set for this phase — no
  richer historical sample exists yet to calibrate against.
- **Missingness**: every scenario has full projection/ROS coverage by
  construction (they are calibration fixtures, not degradation fixtures — those
  are covered separately in the Phase 2 audit + this phase's degradation tests).

## D. Signal audit

- **Distributions**: `describeDistribution` computed for
  `starter_points_delta`, `starter_vor_delta`, `bench_value_delta`,
  `roster_utility_delta`, `ros_usable_value_delta`, `usable_depth_delta`,
  `fragility_delta`, `replacement_context_delta`, `bye_coverage_delta`,
  `consolidation_effect`, `interaction_residual` over the 16-scenario set —
  every one returns finite mean/std/percentiles with honest
  missing/zero-frequency tracking (verified by test, not hand-transcribed here
  since the dataset is small and synthetic; re-run
  `test/trade-engine-phase3-calibration.test.ts` for exact numbers).
- **Correlation**: `starter_points_delta` × `starter_vor_delta` shows **high**
  Pearson (>0.6) **and** Spearman (>0.5) correlation over the scenario set —
  an empirical confirmation of the Phase 1 audit's D2 double-count finding.
  Every other required pair (`starter_points`×`ros_usable_value`,
  `bench_value`×`usable_depth`, `usable_depth`×`fragility`,
  `replacement_context`×`fragility`, `replacement_context`×`starter_vor`,
  `ros_usable_value`×`bye_coverage`, `consolidation`×`usable_depth`) computes
  cleanly to a finite number or `null` (never `NaN`) on both measures.
- **Conceptual overlap matrix** — `CONCEPTUAL_OVERLAP_MATRIX` in
  `lib/trades/calibration.ts` (reproduced below), each entry with a stated
  reason, checked against the empirical correlations above rather than
  standing alone.
- **Ablation**: `runAblation` demonstrated on the 16-scenario set — a signal
  that tracks the expected direction (e.g. `ros_usable_value`) shows
  `full_directional_accuracy >= ablated_directional_accuracy`; a pure-noise
  "signal" shows ~zero incremental value. This is the harness Phase 4
  calibration will point at real components once real weight candidates exist;
  today it is exercised structurally, not to select a production weight.

### Conceptual overlap matrix

| Pair | Overlap | Reason |
| --- | --- | --- |
| `starter_points` × `starter_vor` | **HIGH** | VOR delta ≈ points delta whenever replacement is unchanged (Phase 1 audit D2) |
| `starter_points` × `ros_usable_value` | **HIGH** | the current week is included in the ROS regular-season delta by design |
| `bench_value` × `usable_depth` | **HIGH** | both are non-starter value proxies over largely the same bench population |
| `usable_depth` × `roster_fragility` | MODERATE | share the same per-position inputs; built to move oppositely but not independent |
| `replacement_cliff` × `roster_fragility` | **HIGH** | fragility's `no_cover` term is directly built FROM the cliff — one is a component of the other |
| `replacement_context` × `starter_vor` | MODERATE | both are "value over what's realistically available", at different pipeline stages |
| `replacement_context` × `starter_points` | MODERATE | overlaps what the Phase 1 optimizer already re-prices on reshuffle |
| `bye_coverage` × `ros_usable_value` | MODERATE | a solved bye hole mechanically raises the same weekly totals |
| `consolidation_effect` × `usable_depth` | LOW | related population (ROS means vs. slot-eligible backups), different question; never weighted |
| `interaction_residual` × `ros_usable_value` | NONE | the residual is defined as the gap against the total it's measured from — it cannot feed back into it |

## E. Signals accepted vs. rejected

| Signal | Status | Reason | Weight | Cap | Evidence |
| --- | --- | --- | --- | --- | --- |
| `availability` (injury status) | **SHADOW** (exposed) | real, source-backed; not yet used to adjust value | 0 (no adjustment pathway wired) | — | Phase 1's own `injury_risks`/`expected_availability` already inform lineup optimization; a SEPARATE valuation penalty risks double-counting that |
| `volatility` | **SHADOW** (exposed) | real (weekly CV + ROS disagreement); feeds `valuation_range` and `confidence` only, never the point estimate | 0 | — | correctly widens the range without moving the estimate — the honest Phase 3 use of an uncertain signal |
| `role_adjustment` | **DISABLED** | no usage/role data source exists in this repo | 0 | 3.0 pts/wk (architectural cap, unused) | none — cannot be evidenced without real usage data |
| `schedule_adjustment` | **DISABLED** | no opponent-adjusted schedule-strength source exists | 0 | 2.0 pts/wk (architectural cap, unused) | none |
| `trend` | **DISABLED** | no usage time series to trend | — | — | none |
| Every Phase 2 component (`ros_usable_value`, `playoff_window`, `bye_coverage`, `usable_depth`, `roster_fragility`, `replacement_context`) | **DISABLED** (unchanged from Phase 2) | high/moderate conceptual overlap with Phase 1 terms (§D); no real-dataset ablation performed | 0 | — | Phase 2 audit's correlation findings |

## F. Player intelligence specification

| Metric | Definition | Source | Freshness | Units | Sample requirement | Fallback | Confidence effect |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `availability.status` | injury-status classification | `CanonicalPlayer.injury_status` | CURRENT (per-request) | enum | none | unrecognized string → `UNKNOWN` (never `HEALTHY`), `INJURY_STATUS_UNCERTAIN` | unresolved status lowers confidence indirectly via `intelligence_unknown_count` |
| `availability.expected_availability` | 0..1 | current-week `WeeklyProjection.expected_availability` | CURRENT | probability | none | `null` when no projection | — |
| `volatility.weekly_coefficient_of_variation` | `std_dev / projected_points` | current-week projection | CURRENT | ratio | `projected_points > 0` | `null` otherwise | contributes to `valuation_range` width |
| `volatility.ros_disagreement_pct` | RI vs. external season model | `RosSignal.disagreement_pct` (existing, Phase 1) | CURRENT | fraction | both models must exist | `null` | `PLAYER_INTELLIGENCE_UNAVAILABLE` if both volatility inputs are missing |
| `usage`/`role`/`trend`/`schedule` | n/a | none | UNAVAILABLE | n/a | n/a | always UNAVAILABLE with a stated `reason` | flagged, never silently substituted |

## G. Composite specification

```
shadow_utility_delta
  = contextual_utility_delta                          [Phase 2, frozen]
  + config.phase3.weights.role_adjustment     × Σ role_adjustment (per transferred player, clamped to ±max_role_adjustment)
  + config.phase3.weights.schedule_adjustment × Σ schedule_adjustment (per transferred player, clamped to ±max_schedule_adjustment)
```

- **Normalization**: none applied — both adjustment terms are hardcoded `0`
  today, so no cross-scale summation actually occurs. When a real signal is
  added, its raw units must first be normalized (z-score or bounded transform
  against the calibration distribution — `describeDistribution` is ready for
  this) before it is safe to sum with a weekly-points-scaled term.
- **Weights**: `role_adjustment = 0`, `schedule_adjustment = 0` (both defaults,
  `DEFAULT_TRADE_CONFIG.phase3.weights`).
- **Caps**: `max_role_adjustment = 3.0`, `max_schedule_adjustment = 2.0` weekly
  points — architectural ceilings for when a weight is eventually enabled;
  inert today since the adjustments are 0.
- **Interaction handling**: none needed — Phase 3 does not introduce a second
  interaction-residual concept; player-level `phase3_adjusted_value` is
  `phase2_marginal_ros + role_adjustment + schedule_adjustment` (today
  identical to the Phase 2 marginal), and the transaction-level
  `shadow_utility_delta` remains authoritative over any per-player sum.
- **Safety**: `computeShadowUtility` and its internal `round2` guard against
  non-finite results from extreme inputs (verified by test with
  `Number.MAX_VALUE`/`Infinity`/`NaN` synthetic adjustments), falling back to
  the last known-finite value rather than propagating `NaN`/`Infinity`.

## H. Shadow-mode examples

**1. Phase 1 / 2 / 3 agree** (`STARTER_UPGRADE` scenario):
```
phase1_acceptance: STRONG_ACCEPT   phase2_contextual_acceptance: STRONG_ACCEPT
shadow_acceptance: STRONG_ACCEPT   divergence_reason: null
confidence: HIGH
```

**2. Phase 3 downgrades — mechanism demonstration, NOT live** (synthetic
nonzero `role_adjustment` weight, since no real role-decline signal exists in
this repo):
```
computeShadowUtility(10, roleAdjustment=-6, 0, {role_adjustment: 1, schedule_adjustment: 0})
  = 10 + 1×(-6) = 4   // would move ACCEPT -> NEUTRAL if the composite crossed a band
```
This is exercised only in `test/trade-engine-phase3.test.ts` to prove the
weighting math is correct and safe — production `role_adjustment` is `0` for
every real player because no usage/depth-chart feed exists (§B).

**3. Phase 3 upgrades** — same mechanism, opposite sign; not shown separately
since the math is symmetric (see `clamp`/`computeShadowUtility` tests).

**4. Low-confidence case** (schedule unavailable):
```
shadow_utility_delta: +6 (positive)
confidence: LOW/MEDIUM (not HIGH) — "no authoritative NFL schedule was available"
```
Demonstrates confidence and magnitude are independent axes, per the guiding
principle.

**5. Three-team case** (`THREE_TEAM_HIDDEN_LOSER`): all three participants get
an independent `phase3` block; the disadvantaged participant's
`shadow_utility_delta` is negative and distinct from the other two
(`new Set(deltas).size > 1` — never collapsed to one net number).

## I. Historical / leakage audit

**No historical retrospective dataset exists for this league in this
environment.** `lib/trades/historical.ts` defines the record shape and
`assertNoLookahead` guard, and is tested against synthetic records:

```
NO LOOK-AHEAD BIAS: enforced mechanically by assertNoLookahead, which requires
  input_snapshot_captured_at <= trade_date < outcome.evaluated_through
```

Both the "input captured after trade date" and "outcome not strictly after
trade date" violation cases are covered by dedicated regression tests. This is
a floor (it catches mistimed data) not a proof that a correctly-timestamped
value wasn't computed using future information — that remains a review
responsibility whenever a real dataset is built. `summarizeHistoricalDataset`
degrades safely on an empty dataset (0 records, 0 violations — not an error).

## J. Regression results

```
Phase 3 suite              (trade-engine-phase3.test.ts)              34 / 34  pass
Phase 3 calibration suite  (trade-engine-phase3-calibration.test.ts)  23 / 23  pass
Phase 2 audit suite        (trade-engine-phase2-audit.test.ts)        34 / 34  pass   (unchanged)
Phase 2 suite              (trade-engine-phase2.test.ts)              26 / 26  pass   (unchanged)
Phase 1 suite              (trade-engine + trade-engine-audit)        65 / 65  pass   (unchanged)
Trade total                                                          182 / 182 pass
Weekly engine suite                                                  120 / 120 pass
Full repository suite                                                1060 tests, 1050 pass, 10 fail
tsc --noEmit                                                         clean
eslint                                                                0 errors (18 pre-existing warnings, none in lib/trades)
```

The 10 failures are the same pre-existing network `live:` tests as every prior
baseline in this project. `grep '^not ok' | grep -v -i live` → **0**. Baseline
before this phase was `993 pass / 10 fail`; **+57 tests, zero non-`live`
regressions.**

## K. Limitations

### Phase 3 defects
None found during this build.

### Deliberate calibration limitations
- All Phase 3 composite weights are 0 by design — no signal has been proven
  against a real dataset (only the synthetic 16-scenario set, which is a
  sanity/mechanism check, not calibration evidence).
- The ablation framework has been exercised structurally; it has not been run
  against a candidate real signal because none exists yet to ablate.
- `valuation_range` is a heuristic band (`std_dev_heuristic`), explicitly not a
  statistical confidence interval.

### Data limitations
- **No live in-season usage-stats feed** (snap share, target share, route
  participation, red-zone touches, air yards) exists in this repository. This
  is the single biggest gap blocking real Phase 3B work — role stability,
  trend detection, small-sample protection, and teammate-context signals all
  require it and are architecturally UNAVAILABLE today.
- **No opponent-adjusted schedule-strength source** exists — `schedule` stays
  UNAVAILABLE for every player.
- **No historical completed-trade dataset** was ingested (no network access in
  this environment to pull real Bloodline Bowl transaction history via the
  provider). The retrospective framework is ready; it holds zero records.
- Floor/median/ceiling distributional projections do not exist beyond the
  current week's `floor_points`/`ceiling_points`/`std_dev` — no ROS-specific
  distribution is fabricated.

### Future Phase 4 opportunities (NOT started)
- Ingest a real usage-stats feed (if one becomes available) and rebuild
  `usage`/`role`/`trend` on top of it, honoring the small-sample and
  trend-shrinkage protections this phase's architecture already anticipates.
- Ingest real completed Bloodline Bowl trades via the provider's transaction
  history and populate `lib/trades/historical.ts` records; run the ablation
  framework against real outcomes before considering any nonzero weight.
- Only after calibration evidence exists: promote a signal out of shadow mode
  with a documented weight, cap, and normalization.
- Then, and only then, automated trade discovery / target search /
  counteroffers — explicitly out of scope for Phase 3 and Phase 4's valuation
  work.

## Phase 3 Freeze Gate

- Phase 1 remains frozen ✓ · Phase 2 remains frozen ✓
- player-intelligence signals are source-backed (availability, volatility) —
  every unsupported signal stays explicitly UNAVAILABLE, never fabricated ✓
- stale/small-sample data handling: not applicable today (no usage time series
  exists to protect against small samples); the architecture is ready ✓
- role trend does not overreact to one week: not applicable — no trend
  signal exists to overreact ✓
- schedule impact is bounded: `max_schedule_adjustment` cap exists; effect is
  0 today ✓
- uncertainty is separate from expected value ✓ (verified by test)
- confidence is data-quality-based, not value-based ✓ (verified by test —
  `classifyConfidence` never reads the utility delta)
- correlations measured ✓ (Pearson + Spearman over the calibration scenario set)
- conceptual overlap documented ✓ (`CONCEPTUAL_OVERLAP_MATRIX`)
- ablations run ✓ (structural demonstration; no real-dataset candidate yet)
- nonzero weights have evidence: **n/a — none are nonzero** ✓
- unsupported signals remain weight zero ✓
- normalization stable: n/a today (nothing summed); documented requirement for
  when a signal is added ✓
- adjustment caps exist ✓
- no look-ahead bias: mechanically enforced + tested; no real dataset exists
  yet to audit beyond the framework ✓
- three-team support intact ✓ (independent per-participant phase3, order-invariant)
- Phase 3 runs in shadow mode ✓ (`PHASE3_SHADOW_ONLY` on every result)
- Phase 1/2 outputs are unaffected ✓ (byte-identical proof)
- output remains deterministic ✓
- no non-`live` regressions exist ✓ (1050/10, identical failure set to baseline)

```
PHASE 3 CALIBRATION AND PLAYER INTELLIGENCE:
READY FOR AUDIT
```

Do not begin automated trade discovery. Recommended next step is the Phase 3
audit, followed — only if it passes — by real-data acquisition (usage feed,
schedule-strength source, historical trade ingestion) before any weight is
calibrated.
