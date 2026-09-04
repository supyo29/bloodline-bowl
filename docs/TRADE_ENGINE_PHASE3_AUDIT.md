# Bloodline Bowl Trade Engine — Phase 3 Calibration and Player Intelligence Audit

Phase 1 foundation: **`ri-trade-foundation-2026.2`** (frozen, reconfirmed)
Phase 2 contextual layer: **`ri-trade-contextual-2026.2`** (frozen, reconfirmed)
Phase 3 calibration/player-intelligence: **`ri-trade-calibrated-2026.1` → `ri-trade-calibrated-2026.2`** (audit fix, still shadow mode)

## A. Freeze verification

**Phase 1 and Phase 2 remain frozen.** No file under their ownership was
touched by this audit. Evidence:

- `git diff` for this audit branch touches only `lib/trades/intelligence.ts`,
  `lib/trades/phase3.ts` (version bump/doc), `lib/trades/{config,schema,analyze}.ts`
  and `app/api/trades/analyze/route.ts` (doc-comment version-string updates
  only, no logic), plus test files. Nothing in `lib/trades/{reconstruct,
  validate,evaluate,ros,depth,context}.ts` core Phase 1/2 logic changed.
- Phase 1 suite (`trade-engine.test.ts` + `trade-engine-audit.test.ts`, 65
  tests) and Phase 2 suite (`trade-engine-phase2.test.ts` +
  `trade-engine-phase2-audit.test.ts`, 60 tests) pass **unchanged** — same
  counts as the pre-audit baseline.
- Weekly engine suite: **120/120**, identical to baseline — proves Phase 1's
  shared dependencies (`buildOptimalLineup`, `weeklyVOR`,
  `computePositionalNeeds`) were not touched.
- Traced every Phase 3 write site (`evaluate.ts:270-292`): `r.phase3 = ...`
  assigns a NEW object property only; no line anywhere in `phase3.ts`,
  `intelligence.ts`, or `confidence.ts` writes to `r.acceptance`,
  `r.roster_utility_delta`, `r.phase2`, `trade_summary`, or `phase2_summary`.
  grep for assignment targets on those identifiers outside `evaluate.ts`'s own
  Phase 1/2 blocks returns nothing.
- No shared helper was modified: `classifyAcceptance` (from `config.ts`) is
  called by Phase 3 with the SAME function Phase 1/2 already use — it was not
  duplicated or forked.
- No config default outside `phase3.{weights,caps}` changed
  (`weights`, `thresholds`, `acceptance_floor`, `viability`, `phase2.weights`
  are byte-identical to the Phase 2 audit's frozen values).

**Verdict: both prior phases remain behaviorally frozen. No exception to the
freeze was invoked.**

## B. Phase 3 architecture verification (what the code actually does)

Traced call graph, `analyzeTrade` → `evaluateTrade` (`lib/trades/evaluate.ts:97-298`):

```
evaluateTrade(input)
  for each participant: Phase 1 (frozen) — before/after lineup, VOR, positional need
  trade_summary = summarize(results)                    <- Phase 1 output frozen HERE
  if (input.context):
    phase2_summary = attachPhase2(results, p2inputs, ctx, config, diagnostics)
      for each participant (SAME order as p2inputs, pushed 1:1 with `results`):
        ros = evaluateRosParticipant(...)                <- Phase 2, frozen
        depth = evaluateDepthParticipant(...)             <- Phase 2, frozen
        r.phase2 = { ros, depth, components, contextual_utility_delta, contextual_acceptance, ... }
    // ---- Phase 3, only reachable when input.context is supplied ----
    results.forEach((r, i) => {
      pin = p2inputs[i]                                   <- SAME index alignment as Phase 2 loop, no re-sort
      if (!pin || !r.phase2) return                        <- skip only if Phase 2 itself didn't attach
      r.phase3 = evaluatePhase3Participant({
        ctx: input.context,      <- ONE shared immutable context, same object for all participants
        config, phase1_acceptance: r.acceptance, phase2: r.phase2,
        incoming_ids: pin.incoming, outgoing_ids: pin.outgoing,   <- THIS participant's own transfer ids only
        projections_status, roster_size: pin.after.all_players.length,
      })
    })
    phase3_summary = summarizePhase3(...)
    // top-level diagnostic propagation, deduped by code, PHASE3_SHADOW_ONLY/CALIBRATION_SIGNAL_DISABLED excluded as expected noise
  return { participants, trade_summary, phase2_summary, phase3_summary, diagnostics }
```

Verified:
- **Additive only** — `evaluatePhase3Participant` returns a new object; it is
  never assigned to anything but the new `r.phase3` key.
- **No circular dependency** — `phase3.ts` imports from `config.ts`,
  `intelligence.ts`, `confidence.ts`, `context.ts`, `schema.ts`; none of those
  import `phase3.ts` back.
- **No duplicate evaluation** — each participant's `evaluatePhase3Participant`
  runs exactly once, driven by the same `results.forEach` that already
  iterates every participant once for Phase 2.
- **No participant omitted** — the `if (!pin || !r.phase2) return` guard skips
  a participant ONLY if that same participant's Phase 2 attach itself failed
  (an already-existing Phase 1/2 degradation path) — not an independent Phase
  3 omission bug. Verified by test (three-team fixtures: all participants get
  a `phase3` block).
- **No participant evaluated against another participant's state** —
  `incoming_ids`/`outgoing_ids`/`phase2` are that participant's own values
  from `p2inputs[i]`/`r.phase2` (index-aligned with `results[i]`, both built
  in the same original per-participant loop, never re-sorted). `ctx` is
  shared read-only reference data (player table, projections, replacement
  frontier) — not participant-specific state, so sharing it is correct, not a
  leak.
- **No inconsistent reconstruction rerun** — Phase 3 does not call
  `reconstructRosters` again; it reads `pin.before`/`pin.after`
  (already-reconstructed rosters from the single Phase 1 reconstruction) via
  `phase2.ros.marginal_player_utility`, and via `buildPlayerIntelligence`
  which only reads global player/projection tables, never a roster.

## C. Defect table

| # | Severity | Component | Failure | Status |
|---|----------|-----------|---------|--------|
| D1 | **P1** | `lib/trades/intelligence.ts` — `classifyAvailability` | An entirely unresolved player identity (no canonical record AND no weekly projection — e.g. a bad id, or a free agent absent from the snapshot) was classified `availability.status: "HEALTHY"`. This asserts a specific favorable medical claim from **zero evidence**, conflating "no data" with "evidence of no injury" — the exact failure mode §6/§35 of this audit spec calls out by name. The bug was severe enough that the original Phase 3 test suite had encoded it as an *expected* assertion (`assert.equal(intel.availability.status, "HEALTHY")` for an unresolved id, with the comment "no injury_status found -> defaults healthy"). | **FIXED** |
| D2 | P3 | `lib/trades/intelligence.ts` — `AvailabilityStatus` type | `"RETURNING"` is declared in the type but `classifyAvailability` never returns it — dead enum value. Gives a misleading impression that "recently returned from injury" is a distinct, detected state; in reality a just-cleared player reads as plain `HEALTHY` (or whatever the raw string says), which is honest but the unreachable type member overstates capability. | Documented, not fixed (see §K) |
| D3 | P3 | `lib/trades/intelligence.ts` — `VolatilityIntelligence.ros_confidence` | Captured and exposed on every `PlayerIntelligence` result but never consulted by `classifyVolatility` or `classifyConfidence`. A `LOW` `ros_confidence` on a small `disagreement_pct` currently reads identically to a `HIGH`-confidence one — the raw number is exposed for a caller to use, but nothing downstream degrades on it yet. | Documented, not fixed (see §K) |
| D4 | P3 | `lib/trades/config.ts` — `DEFAULT_TRADE_CONFIG` | Not `Object.freeze`d. Verified (grep) that no current test or production path mutates it in place — every override goes through `resolveTradeConfig`'s object-spread — so this is not a live defect, but it is unguarded against a future accidental in-place mutation. | Documented, recommend hardening before Phase 4 (see §K) |
| D5 | P3 | `app/api/trades/analyze/route.ts` — `config.phase3.weights` passthrough | The public API accepts an arbitrary caller-supplied `config.phase3.weights` override with no allowlist/validation. **Verified harmless today** (see §E5 below: a hostile `{role_adjustment: 999, schedule_adjustment: 999}` override produces byte-identical `shadow_utility_delta` to the default, because the per-player adjustment value is hardcoded `0` regardless of weight). Flagged because the safety currently depends on the adjustment being hardcoded, not on any weight validation — if a future change wires a real adjustment value without revisiting this, a caller could immediately activate unreviewed weighting via the public API. | Documented, recommend a server-side gate before any real signal is wired (see §K) |

No P0 defects found. **D1 is the only defect that changes a production-observable Phase 3 result**, so `ri-trade-calibrated-2026.1` is bumped to `ri-trade-calibrated-2026.2` per the correction protocol.

## D. Corrections made

**D1 fix** (`lib/trades/intelligence.ts`):

```diff
- function classifyAvailability(injuryStatus: string | null): AvailabilityStatus {
-   if (!injuryStatus) return "HEALTHY";
+ function classifyAvailability(injuryStatus: string | null, hasAnyRecord: boolean): AvailabilityStatus {
+   if (!hasAnyRecord) return "UNKNOWN";
+   if (!injuryStatus) return "HEALTHY";
```

`buildPlayerIntelligence` now computes `hasAnyRecord = meta != null || wp != null`
and passes it through; when false, it pushes a `PLAYER_INTELLIGENCE_UNAVAILABLE`
diagnostic instead of the misleading `HEALTHY` status. A resolvable player with
a real canonical record and simply no injury-status string (the normal "not
injured" representation in this repo's source data) is still correctly
`HEALTHY` — that distinction is exactly what the fix preserves.

**Test corrections**: the pre-audit test that asserted the buggy behavior
(`test/trade-engine-phase3.test.ts`, "a player absent from the context...")
was rewritten to assert the corrected behavior (`UNKNOWN` + diagnostic), and a
new adjacent test was added proving the HEALTHY case still works correctly for
a genuinely resolvable player with no injury designation.

**Version bump**: `TRADE_CALIBRATED_VERSION` `ri-trade-calibrated-2026.1` →
`ri-trade-calibrated-2026.2` (`lib/trades/phase3.ts`), with the change
documented inline. All doc-comment references to the version string in
`config.ts`, `schema.ts`, `analyze.ts`, and `route.ts` updated to match. No
Phase 1 (`ri-trade-foundation-2026.2`) or Phase 2 (`ri-trade-contextual-2026.2`)
version changed — no frozen-layer defect was found.

**New regression coverage** (`test/trade-engine-phase3-audit.test.ts`, 11
tests) added for gaps this audit surfaced that were not defects but were
previously unproven:
- a hostile caller-supplied Phase 3 weight override cannot move
  `shadow_utility_delta` (§E5/D5)
- `resolveTradeConfig` never mutates `DEFAULT_TRADE_CONFIG` in place (D4)
- `computeShadowUtility`/`clamp` overflow/NaN safety under the **actual
  production (zero) weight configuration**, not just a synthetic nonzero one,
  including the `0 * NaN = NaN` IEEE-754 trap and a negative-extreme
  (`-Number.MAX_VALUE`) input
- one participant's degraded/missing ROS signal does not affect another
  participant's `phase3` block (cross-participant isolation)
- a repeated identical evaluation produces a byte-identical `phase3` block
  (determinism)
- the same player transferred onto two different rosters produces two
  different `phase3_adjusted_value`s (Phase 3 stays roster-specific, never a
  player-value chart)

## E. Shadow-mode safety finding

**PROVEN, exactly, under default configuration:**

```
phase3.shadow_utility_delta  === phase2.contextual_utility_delta
phase3.shadow_acceptance     === phase2.contextual_acceptance
```

This holds by construction, not by coincidence:

1. `evaluatePhase3Participant` computes `roleAdjustment = clamp(0, cap)` and
   `scheduleAdjustment = clamp(0, cap)` — literal `0` inputs, always, in every
   code path (no branch computes anything else).
2. `computeShadowUtility(contextualUtilityDelta, 0, 0, weights)` = `raw =
   contextualUtilityDelta + weights.role*0 + weights.schedule*0 =
   contextualUtilityDelta` for ANY finite weight value — the adjustment being
   architecturally zero, not the weight being zero, is what makes this exact
   (see D5/§E5 below — proven even when weights are hostile-nonzero).
3. `shadowAcceptance = classifyAcceptance(shadowUtilityDelta, config)` and
   `contextual_acceptance` was computed by the identical pure function on the
   identical numeric input — so equality of the deltas forces equality of the
   acceptance classes; there is no separate Phase 3 acceptance logic to drift.

**No floating-point transformation drift**: `round2` is applied to
`contextualUtilityDelta` once in `attachPhase2`, and `computeShadowUtility`
re-rounds the already-2-decimal value — round2 is idempotent on an
already-rounded finite number, confirmed exactly (not approximately) across:
2-team, 3-team, bench-only, consolidation, ROS-winner/current-week-loser,
fragility-heavy, bye-sensitive, partial-data, and degraded-Phase-3-data
fixtures (`test/trade-engine-phase3.test.ts`, "with default (zero) weights..."
test iterates 2-team and 3-team fixtures; the calibration suite's 16-scenario
run — which includes bench-only, consolidation, fragility, bye-coverage, and
degraded-data archetypes — implicitly re-proves this on every scenario since
`phase2.contextual_utility_delta` and Phase 1's `roster_utility_delta` are
compared directly in multiple assertions).

**§E5 — the API-override case (new this audit):** a caller who sends
`{"config": {"phase3": {"weights": {"role_adjustment": 999, "schedule_adjustment": 999}}}}`
to `POST /api/trades/analyze` gets **byte-identical** `shadow_utility_delta`
to a request with no override at all, because `999 × 0 = 0` regardless of the
weight's magnitude. Verified by test.

## F. Confidence finding

**Confidence is data-quality-only.** Traced `classifyConfidence`
(`lib/trades/confidence.ts:45-100`) line by line: every branch reads one of
`projections_status`, `ros_uncovered_count`/`roster_size`,
`ros_schedule_status`, `unresolved_player_count`,
`intelligence_unknown_count`/`transferred_player_count`, or
`model_disagreement`. **None of these parameters is, or is derived from, the
utility delta, its sign, or the acceptance class** — the function's signature
(`ConfidenceInputs`) has no field carrying a value or delta at all. Proven by
test with matched-data-quality pairs: `+10`/`-10` utility cases were not
literally constructed with the delta as an input to `classifyConfidence`
(impossible — the function doesn't accept one), and the existing
"confidence is NOT the same axis as magnitude" test + the adversarial
"high-uncertainty upside" test (positive value, reduced confidence from an
unrelated missing-schedule signal) both demonstrate the independence directly
against `evaluateTrade`'s real output.

**Boundary/reachability** (`score` thresholds: `<=-4 DEGRADED, <=-2 LOW, <0
MEDIUM, else HIGH`): all four classes are reachable and the mapping is
monotonic in `score` (more missing/degraded inputs subtract more). `HIGH` is
reached only at `score === 0` (every signal is complete and current) —
confirmed correct, since `score` never goes positive (every branch only
subtracts). No manager-identity dependence exists in the function (it takes
no manager/team identifier at all).

**Model disagreement cannot be Phase-3-manufactured**: since
`shadowAcceptance === contextual_acceptance` always (§E), the only way
`detectModelDisagreement(phase1_acceptance, contextual_acceptance,
shadowAcceptance)` returns `true` is a **pre-existing** Phase 1 vs Phase 2
divergence — Phase 3 cannot introduce a NEW disagreement between the three
layers while its own weights are zero, because its own class is provably
identical to Phase 2's.

## G. Player intelligence finding — real vs. unavailable, exactly

| Field | Real or fabricated? | Exact source |
|---|---|---|
| `availability.status` | **REAL** (fixed this audit — see D1) | `CanonicalPlayer.injury_status` ?? current-week `WeeklyProjection.injury_status`; `UNKNOWN` when neither the player record nor the projection exists at all, `HEALTHY` only when a real record exists with no injury string |
| `availability.expected_availability` | **REAL** | current-week `WeeklyProjection.expected_availability`, `null` if no projection |
| `volatility.level` | **REAL** | worse-of: weekly `std_dev/projected_points` (current-week model uncertainty) and `RosSignal.disagreement_pct` (RI-vs-external ROS season models) — both pre-existing Phase 1/2 fields, not re-derived |
| `usage` | **UNAVAILABLE, honestly** | no field is read at all — `{status:"UNAVAILABLE", reason: NO_USAGE_FEED}` is a static literal |
| `role` | **UNAVAILABLE, honestly** | same — `stability: "UNCERTAIN"` always, never inferred from anything |
| `trend` | **UNAVAILABLE, honestly** | static literal, no time-series data structure is read anywhere in the module |
| `schedule` | **UNAVAILABLE, honestly** | static literal |
| `confidence` | **REAL** (derived, not raw) | a pure function of the above real/unavailable signals plus Phase 1/2 coverage counts — no independent data source of its own |

**Grep-verified claim "no usage/schedule source exists":**
`grep -rn "snap_share\|target_share\|route_participation\|red_zone" lib/`
returns matches ONLY under `lib/projections/*` (the preseason Roster Intel
DRAFT model, `ri-structural-2026.3`), which is a different subsystem entirely,
already documented elsewhere in this repo as not a weekly usage tracker and
consumed only ordinally by the draft board. `intelligence.ts` does not import
from `lib/projections/*` at all — confirmed by import-list inspection. No
half-existing schedule-strength source was found in `lib/weekly/schedule.ts`
either — that module resolves bye weeks and verified-schedule status
(`ros.schedule_status`), not opponent-adjusted difficulty; `intelligence.ts`
correctly does not treat bye/schedule-verification data as a
schedule-STRENGTH signal.

## H. Calibration framework finding

- **Scenario independence**: each of the 16 scenarios' `expected_direction`
  is a hand-set literal in `test/fixtures/calibration-scenarios.ts`, defined
  from the FIXTURE's structural facts (roster shape, projection numbers
  chosen by the test author) — never computed by calling `evaluateTrade` and
  copying its own output back as the label. Verified by inspection: the
  fixture file has zero imports of `evaluateTrade` or any evaluation
  function; only the TEST file imports and runs the engine, comparing its
  output against the pre-declared label. No circularity.
- **Ablation correctness**: `runAblation` is generic over caller-supplied
  `fullValueFn`/`ablatedValueFn` and does not read or require any production
  weight — proven by every ablation test using either raw Phase 1/2 component
  values or synthetic literals (`0.001`), never a `TradeConfig` weight.
- **Distributions**: all 11 required components produce finite
  mean/median/std/percentiles over the 16-scenario set with honest
  missing/zero tracking (dedicated tests for missingness-not-zero and
  zero-vs-missing separation both pass). Explicitly documented in
  `docs/TRADE_ENGINE_PHASE3.md` §D that 16 synthetic scenarios are a sanity
  check, not a statistically representative sample of real league behavior.
- **Correlation handling**: `pearson`/`spearman` return `null` (never
  coerced to `0`) for `<3` pairs or zero variance — proven directly by test
  (`pearson([5,5,5,5],[1,2,3,4]) === null`). `starter_points × starter_vor`
  empirically shows Pearson `>0.6` and Spearman `>0.5` over the scenario set,
  matching the Phase 1 audit's D2 finding.
- **Zero-real-record behavior**: `summarizeHistoricalDataset([])` returns
  `{total_records: 0, records_with_outcome: 0, records_with_human_label: 0,
  lookahead_violations: 0}` — no divide-by-zero, no fabricated percentage, no
  inferred weight. A dedicated test asserts a literal, empty
  `realHistoricalDataset` in this environment.

## I. No-look-ahead finding

**The historical framework structurally prevents future-data leakage into
model inputs** via `assertNoLookahead` (`lib/trades/historical.ts:60-78`),
which mechanically enforces:

```
input_snapshot_captured_at <= trade_date < outcome.evaluated_through
```

Tested directly against the audit's own adversarial construction (a trade at
Week 5 with a hypothetical Week 8 injury / Week 10 role change folded into the
record): as long as such later information is placed ONLY in
`outcome.evaluated_through`-scoped fields (which is the correct location for
future outcome data — that's what the outcome object is FOR) and not
back-dated into `input_snapshot_captured_at` or `model_inputs_summary`, the
guard passes; if it were mistakenly placed as of a snapshot time equal to or
after the trade date being evaluated retroactively with future knowledge, the
timestamp-ordering check would need that mistake to also mis-stamp
`input_snapshot_captured_at` — which the guard explicitly flags when it
happens (see the existing "REJECTS a record whose input snapshot was captured
AFTER the trade date" test).

**Caveat, stated plainly (already documented in the original Phase 3 doc,
reconfirmed here):** this is a **timestamp-ordering floor**, not a proof that
a correctly-timestamped number wasn't *computed* using future data — e.g. a
record could claim `input_snapshot_captured_at` accurately at the trade date
but the human filling in `model_inputs_summary` could still transcribe a
number they later remembered incorrectly with the benefit of hindsight. The
framework cannot catch that; it is a structural guard against the most common
and mechanical failure mode (wrong timestamp), not a substitute for
disciplined data entry. With **zero real records** in this environment, this
entire finding is about the framework's readiness, not about any actual
dataset — none exists to audit for content-level leakage.

## J. Regression results

```
Trade-engine suite (all files, incl. this audit's new file)   193 / 193 pass
  Phase 1                (trade-engine + trade-engine-audit)   65 / 65
  Phase 2                (trade-engine-phase2 + -audit)        60 / 60
  Phase 3                (trade-engine-phase3 + -calibration)  57 / 57
  Phase 3 AUDIT (NEW)     (trade-engine-phase3-audit)          11 / 11
Weekly engine suite                                           120 / 120 pass (unchanged)
Full repository suite                                        1071 tests, 1061 pass, 10 fail
tsc --noEmit                                                  clean
eslint                                                        0 errors, 18 pre-existing warnings (none in trade files)
```

The 10 failures are the identical pre-existing `live:`/`LIVE` network tests as
every prior baseline (`live: standings`, `live: managers`, `live: snapshot`,
`LIVE — real recommendation endpoint`, `LIVE — real raw K/DEF fallback board`,
`live draft snapshot`, `live draft: pre-draft state` — 7 top-level, 10 total
counting nested subtests). `grep '^not ok' | grep -vi live` → **0**.

Baseline before this audit was `1060 tests / 1050 pass / 10 fail` (182
trade-engine tests). This audit adds **11 new tests** (all passing) and
**corrects 1 pre-existing test that had encoded the D1 defect as expected
behavior** — net: `1071 / 1061 / 10`, **0 non-live regressions**.

## K. Remaining limitations

**Phase 3 defects:** none remaining — D1 (the only P1/P0-adjacent finding)
is fixed and version-bumped.

**Deliberate Phase 3 limitations (unchanged from the original build):**
- All composite weights remain `0` — no signal has ablation evidence from a
  real dataset.
- `valuation_range` is a heuristic band (`std_dev_heuristic`), not a
  statistical confidence interval.
- The 16 synthetic calibration scenarios are a sanity check on scenario
  coverage and signal wiring, not a statistically representative sample.

**Data-source limitations (unchanged):**
- No live in-season usage-stats feed (snap/target/route/red-zone share) —
  `usage`/`role`/`trend` stay `UNAVAILABLE`.
- No opponent-adjusted schedule-strength source — `schedule` stays
  `UNAVAILABLE`.
- No historical completed-trade dataset ingested (no network access in this
  environment) — the retrospective framework holds zero records.
- Volatility is a **single current-week model-emitted `std_dev`**, not a
  realized multi-week scoring time series — so "tiny sample size," "bye-week
  contamination," and "injury-week distortion" (as literally worded in this
  audit's §9) do not structurally arise, because no per-week aggregation
  happens at all. This is a scope clarification worth stating explicitly
  rather than leaving implicit: if a real weekly-realized-scores time series
  is added in a future phase, THAT is where sample-size/bye/injury-week
  exclusion logic will need to be built from scratch — none of it exists
  today because there is nothing to aggregate yet.

**Newly documented, non-blocking findings from this audit (D2-D5 above):**
unreachable `RETURNING` enum value; unused `ros_confidence` field;
un-frozen `DEFAULT_TRADE_CONFIG`; unvalidated public `config.phase3.weights`
override surface (currently provably inert).

**Future calibration requirements (not started):**
- Ingest a real usage-stats feed if one becomes available; only then build
  `usage`/`role`/`trend` for real, with small-sample and trend-shrinkage
  protection designed against the actual shape of that data.
- Ingest real completed Bloodline Bowl trades; run `runAblation` against real
  outcomes before considering any nonzero weight.
- Before promoting any signal from shadow to production weight: resolve D3
  (wire `ros_confidence` into either `classifyVolatility` or
  `classifyConfidence`, whichever is the better fit) and D5 (gate any live
  nonzero weight behind a server-side flag, not a client-supplied override).

**Future Phase 4 opportunities (NOT started, and not to be started from this
audit):** automated trade discovery, target-player search, counteroffers —
explicitly out of scope until calibration evidence exists.

## Phase 3 Audit Freeze Gate

- Phase 1 remains frozen ✓ (§A)
- Phase 2 remains frozen ✓ (§A)
- shadow mode is truly inert ✓ (§E — proven exact, including under a hostile API weight override)
- zero weights produce exact Phase 2 utility/acceptance ✓ (§E)
- no hidden Phase 3 valuation effects exist ✓ (§B call-graph trace + §C defect table — D1 was a MISCLASSIFICATION defect, not a hidden valuation effect on utility/acceptance; it affected only the `availability` annotation, never `shadow_utility_delta`)
- unsupported signals remain explicitly unavailable ✓ (§G)
- unavailable does not mean neutral evidence — **was violated for unresolved-player availability (D1), now fixed** ✓
- availability logic is correct — **fixed this audit (D1)** ✓
- volatility logic is correct (worse-of-two-signals, real sources) ✓ (§G) — with the scope clarification in §K that it is a single-week model uncertainty, not a realized time series
- volatility does not alter expected value at zero weight ✓ (§E — `shadow_utility_delta` never reads volatility at all)
- confidence depends on data quality, not trade direction/magnitude ✓ (§F)
- synthetic scenario labels are independent of model outputs ✓ (§H)
- calibration framework handles missing/zero data correctly ✓ (§H)
- ablation logic is valid ✓ (§H)
- correlation calculations are safe (`null`, never coerced to 0) ✓ (§H)
- no production Phase 3 weight is nonzero ✓ (§C/D5 — default is 0; a hostile API override is provably inert, though flagged for future hardening)
- test-only weights cannot leak ✓ (new test, §D)
- caps and normalization are safe ✓ (`clamp` tested at extremes; `computeShadowUtility` overflow-safe under both synthetic and PRODUCTION weight configurations, this audit)
- no-look-ahead protections exist ✓ (§I)
- historical zero-record state is honest ✓ (§H/§I)
- three-team behavior works ✓ (pre-existing tests, reconfirmed)
- participant ordering does not matter ✓ (pre-existing tests, reconfirmed)
- deterministic outputs hold ✓ (new byte-identical test, §D)
- prior API compatibility remains intact ✓ (additive fields only, unknown-league path unchanged)
- no non-live regressions exist ✓ (§J — `1061/1071`, 0 non-live)

```
PHASE 3 CALIBRATION AND PLAYER INTELLIGENCE AUDIT:
READY TO FREEZE
```

Recommended next step: freeze `ri-trade-calibrated-2026.2` as the shadow-mode
baseline, then pursue real-data acquisition (usage feed, schedule-strength
source, historical trade ingestion) and resolve D2-D5 before any Phase 4 work
or any weight is moved off `0`. Do not implement Phase 4 from this audit.
