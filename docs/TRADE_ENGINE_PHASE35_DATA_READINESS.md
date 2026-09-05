# Bloodline Bowl Trade Engine — Phase 3.5: Real Data Enablement and Calibration Readiness

Phase 1 foundation: **`ri-trade-foundation-2026.2`** (frozen)
Phase 2 contextual layer: **`ri-trade-contextual-2026.2`** (frozen)
Phase 3 calibration/player-intelligence: **`ri-trade-calibrated-2026.2`** (frozen — value contract unchanged by 3.5)
Phase 3.5 data-enablement layer: **`ri-trade-data-2026.1`** (new)

## A. Freeze verification

All three prior versions remain behaviorally unchanged:

- Phase 1/2: no file under their ownership was touched. Trade suite for
  those layers (125 tests) passes unchanged.
- Phase 3's **value contract** is unchanged: `shadow_utility_delta`'s formula
  in `computeShadowUtility` was not edited, and the zero-weight identity
  (`shadow_utility_delta === contextual_utility_delta`,
  `shadow_acceptance === contextual_acceptance`) is re-proven exactly,
  including under the new provider framework (§G/§J below).
- What DID change under Phase 3: `PlayerIntelligence`'s `usage`/`role`/
  `trend`/`schedule` fields widened from an always-`UnavailableSignal` shape
  to a discriminated union that COULD report `AVAILABLE` if a real provider
  existed (none does — every caller still gets `UNAVAILABLE`, byte-identical
  to before), `AvailabilityStatus` had the unreachable `"RETURNING"` member
  removed, and `Phase3ParticipantResult` gained a `mode` field. These are
  **data-plumbing/schema changes**, not value-contract changes — hence a new
  `ri-trade-data-2026.1` version rather than bumping `ri-trade-calibrated-2026.2`.

## B. P3 cleanup (from the Phase 3 audit)

| Finding | Resolution |
|---|---|
| D2 — unreachable `RETURNING` | **Removed** from `AvailabilityStatus`. No source in this repo can distinguish "recently returned" from any other status, so the honest fix is removal, not a fake derivation. A just-cleared player now correctly reports whatever its real raw injury-status string says. |
| D3 — unused `ros_confidence` | **Wired in.** `classifyConfidence` now takes `low_ros_confidence_count`; when most transferred players have `ros_confidence: "LOW"`, confidence degrades one band, same as an unknown-intelligence signal. Verified independent from an isolated single low-confidence player (does not degrade). |
| D4 — mutable default config | **Deep-frozen.** `DEFAULT_TRADE_CONFIG` and every nested object is `Object.freeze`d; a mutation attempt throws (strict-mode ES modules). `resolveTradeConfig` is unaffected — every override still spreads into a brand-new object. |
| D5 — public weight override surface | **Closed.** `sanitizePublicTradeConfig` allowlists exactly `weights`/`thresholds`/`acceptance_floor`/`viability`/`phase2.weights` from a request body and unconditionally drops `phase3` — the public API route calls this BEFORE `analyzeTrade` ever sees the body. A new `lib/trades/activation.ts` gate additionally ensures `resolvePhase3CalibrationMode()` reads environment configuration ONLY (never a request), defaults to `SHADOW`, and hard-refuses `PRODUCTION` back to `SHADOW` regardless of what the environment requests — no signal has cleared the readiness bar (§F/§I) to justify it yet. |

## C. Data sources

| Candidate | Provider | Signals | Coverage | Historical depth | Freshness | Identifier mapping | Limitations |
|---|---|---|---|---|---|---|---|
| Usage/opportunity (snap/route/target/carry share) | **none integrated** | n/a | n/a | n/a | n/a | n/a | No network access in this environment to evaluate or connect any external usage-stats API. `lib/trades/providers.ts` defines the `UsageProvider` interface and ships only `NULL_USAGE_PROVIDER`. |
| Schedule strength (opponent-adjusted matchup difficulty) | **none integrated** | n/a | n/a | n/a | n/a | n/a | Same — `ScheduleProvider` interface + `NULL_SCHEDULE_PROVIDER` only. |
| Historical completed trades | **none integrated** | n/a | n/a | n/a | n/a | n/a | No network access to pull real Sleeper league transaction history (Bloodline Bowl, Devoted to the Game, or any other connected league). |

**No source evaluation table beyond this is possible in this environment** —
evaluating a real candidate (coverage, cadence, licensing, cost, reliability)
requires actually reaching it, which this session cannot do. This is reported
honestly rather than filled in with placeholder claims, per the Phase 3.5
guiding principle ("prefer NO SIGNAL over BAD SIGNAL" extends to prefer NO
SOURCE EVALUATION over a fabricated one).

## D. Usage layer (framework built, not populated)

- **Schema**: `PlayerUsageSnapshot` (`lib/trades/providers.ts`) — snaps/
  snap_share, routes/route_participation, targets/target_share, carries/
  rush_share, red-zone/goal-line splits, `source`/`updated_at`/`freshness`.
  Adaptable to whatever fields a real provider actually returns; unsupported
  metrics stay `null`, never estimated.
- **Trend method**: `classifyUsageTrend` — a pure, generic classifier over a
  caller-supplied share series (oldest first). Requires `MIN_WEEKS_FOR_TREND
  = 3` usable weeks (each with `sample_size >= MIN_USAGE_SAMPLE_SIZE = 10`)
  before calling ANY direction; a recent-window standard deviation above
  `0.15` reports `VOLATILE` instead of a direction; otherwise compares a
  3-week recent mean against the baseline mean with an `0.08`-share shift
  threshold. Verified against the named adversarial fixtures: a single huge
  week inside a high-variance short window does not assert `IMPROVING`
  (hot-hand trap); three consecutive modest increases correctly reads
  `IMPROVING` (quiet breakout); a lone 2-sample garbage-time week is excluded
  entirely from the calculation, not counted as a real week (blowout anomaly).
- **Sample rules**: any single-week snapshot below `MIN_USAGE_SAMPLE_SIZE` is
  still reported (never suppressed) but flagged `USAGE_SAMPLE_TOO_SMALL`.
- **Freshness**: `UsageFreshness = CURRENT | STALE | PARTIAL | UNKNOWN` on
  every snapshot; a `STALE` snapshot pushes `USAGE_DATA_STALE`.
- **Fallback**: `NULL_USAGE_PROVIDER` — `getCurrentUsage`/
  `getHistoricalUsage`/`getRecentUsageSeries` all return null/empty, which
  `buildPlayerIntelligence` correctly reports as `UNAVAILABLE`, not a
  synthetic zero.

**Historical usage retrieval** (`getHistoricalUsage(playerId, season, week)`)
is defined in the interface for future no-look-ahead reconstruction, but has
no implementation to test against real data.

## E. Schedule layer (framework built, not populated)

- **Schema**: `PlayerScheduleContext` — `matchup_score`/`matchup_percentile`
  (caller-defined scale, to be documented by whatever real provider is
  eventually wired), `source`/`updated_at`/`freshness`.
- **Aggregation**: not built — there is no real per-week matchup score to
  aggregate into a remaining-schedule-quality figure yet. When one exists,
  it should reuse `ctx.ros.weeks`/`playoff_weeks` (the Phase 2 week-geometry
  fields), per the Phase 3.5 mandate not to reinvent the week window.
- **Caps**: `capScheduleAdjustment(rawAdjustment, weeklyProjection)` bounds
  any future schedule effect to `15%` of the player's own weekly projection
  — verified with an extreme (`1000`) raw input, a null projection (returns
  `0`, never invents a baseline), and non-finite input (`NaN`/`Infinity` ->
  `0`).
- **Limitations**: `capScheduleAdjustment` is not called from anywhere in
  the evaluation path today — it exists as a tested, ready mechanism for
  whenever a real schedule signal and a real weight are both justified.

## F. Historical dataset

```
real trades collected:                0
leagues:                               0
seasons:                               0
2-team trades:                         0
3-team trades:                         0
records with complete pre-trade snapshots:  0
records with historical projections:        0
```

**No real historical trade was ingested.** This environment has no network
access to pull Bloodline Bowl's (or any other connected league's) actual
Sleeper transaction history. `lib/trades/historical.ts` (built in Phase 3)
already defines the record shape and the `assertNoLookahead` guard; nothing
new was needed there structurally, and nothing new was populated.

## G. Counterfactual dataset

- **Generation method**: `generateCounterfactualTrades` (`lib/trades/
  historical-counterfactual.ts`) — legal, same-position, cross-roster 1-for-1
  bench swaps, deterministically shuffled by a seeded LCG (no external
  dependency), capped at `maxTrades` to avoid combinatorial explosion.
- **Sample count**: bounded by the caller (`maxTrades`, default 20 in tests);
  not run against any real league roster — no real roster data with real
  bench compositions was available to generate FROM in this environment
  (a synthetic test-fixture roster was used to prove the mechanism only).
- **Seed**: any integer; identical seed -> byte-identical output (proven by
  test), enabling reproducible research once real rosters are available.
- **Validity checks**: `validateCounterfactualBatch` confirms no self-trades,
  no duplicate-asset reuse across the batch, and distinct managers per trade
  — all proven by test.

This is a **mechanism**, not a dataset — it has never been run against a real
Bloodline Bowl (or any other) roster snapshot in this environment.

## H. Data quality

No coverage matrix by source/position/league/season can be reported —
there is no integrated external source to measure coverage FOR (§C). The
only "coverage" that exists today is the same Phase 1/2/3 coverage already
reported: `ros_uncovered_count`/`roster_size` (ROS signal coverage),
`ros.schedule_status` (bye/schedule verification, NOT opponent-strength),
and `ctx.snapshot.unresolved_players` (identity resolution). These are
unchanged by Phase 3.5.

**Feed-failure isolation** was verified for the two new provider interfaces:
a provider returning `null`/`[]` for every method (the `NULL_*_PROVIDER`
case, which is every real request today) degrades to `UNAVAILABLE` cleanly
with no exception, no Phase 1/2 effect, and no Phase 3 utility effect —
proven by the full existing Phase 1/2/3 regression suite passing unchanged
with the new provider wiring in place.

**Caching / reproducibility**: not applicable — there is no external call to
cache. `classifyUsageTrend` and `capScheduleAdjustment` are pure and
deterministic by construction; `generateCounterfactualTrades` is
seed-reproducible (§G).

## I. Signal readiness

(`lib/trades/data-readiness.ts`, `SIGNAL_READINESS` — reproduced here; see
that file for the authoritative, versioned source.)

| Signal | Status | Sample size | Historical support | Leakage risk | Redundancy risk | Recommendation |
|---|---|---|---|---|---|---|
| `availability` | SHADOW_ONLY | 0 historical trades | NONE | LOW | MODERATE | Keep diagnostic-only until a historical-outcome dataset exists to test a value adjustment against. |
| `volatility` | SHADOW_ONLY | 0 historical trades | NONE | LOW | MODERATE | Keep diagnostic-only; re-run `runAblation` once real outcomes exist (overlaps `roster_fragility` conceptually — unresolved empirically). |
| `usage_trend` | INSUFFICIENT_DATA | 0 player-weeks | NONE | LOW | LOW | Do NOT calibrate. No real usage source integrated. |
| `role_stability` | INSUFFICIENT_DATA | 0 player-weeks | NONE | LOW | MODERATE | Same as `usage_trend` (derived from the same series). |
| `schedule_strength` | INSUFFICIENT_DATA | 0 player-weeks | NONE | LOW | LOW | Do NOT calibrate. No real schedule source integrated. |
| `historical_trade_outcome` | INSUFFICIENT_DATA | 0 historical trades, 0 leagues, 0 seasons | NONE | LOW | NONE | **This is the hard blocker every other signal's readiness ultimately depends on.** |

`MINIMUM_SAMPLE_REQUIREMENTS` (documented floors, not a guarantee of
readiness on their own): 50 historical trades, 500 player-weeks, 100
players, 3 leagues, 2 seasons. **All six signals are at `0` against every
applicable dimension.**

No holdout-split framework was built beyond what the requirement asks for
conceptually (`TRAIN`/`VALIDATION`/`HOLDOUT` or time-based) — building a
holdout mechanism with zero real records to split would be pure scaffolding
with nothing to validate; it is deferred to the phase that actually ingests
real records, so the split logic can be designed against the real data's
actual shape (are leagues the right stratification unit? seasons? both?)
rather than guessed at now.

## J. Shadow invariant

**Proven, exactly, unchanged from the Phase 3 audit:**

```
phase3.shadow_utility_delta  === phase2.contextual_utility_delta
phase3.shadow_acceptance     === phase2.contextual_acceptance
production Phase 3 weights   === 0 (role_adjustment, schedule_adjustment)
```

New for Phase 3.5, and the single most important test in this phase: even
when a STUB provider populates `usage`/`role`/`trend`/`schedule` with
rich, real-shaped data (a 5-week rising usage series and a favorable
matchup), `evaluatePhase3Participant`'s `role_adjustment`/
`schedule_adjustment` remain hardcoded `clamp(0, cap)` — **the new
intelligence data is diagnostic-only and was never wired into the value
computation.** `shadow_utility_delta` and `shadow_acceptance` stayed exactly
equal to their Phase 2 counterparts in that test, with real-shaped
`AVAILABLE` intelligence sitting right next to them. `mode` is `"SHADOW"` for
every request (no environment override reaches a test or a real request; a
hostile environment `PRODUCTION` value is downgraded to `SHADOW` by
`resolvePhase3CalibrationMode`).

## K. Regression

```
Trade-engine suite (all files)                                230 / 230 pass
  Phase 1 (trade-engine + trade-engine-audit)                  65 / 65
  Phase 2 (trade-engine-phase2 + -audit)                       60 / 60
  Phase 3 (trade-engine-phase3 + -calibration + -audit)        68 / 68
  Phase 3.5 (trade-engine-phase35, NEW)                        37 / 37
Weekly engine suite                                           120 / 120 pass (unchanged)
Full repository suite                                        1108 tests, 1098 pass, 10 fail
tsc --noEmit                                                  clean
eslint                                                        0 errors, 18 pre-existing warnings (none in trade files)
```

The 10 failures are the identical pre-existing `live:`/`LIVE` network tests
as every prior baseline. `grep '^not ok' | grep -vi live` → **0**.

Baseline before this phase was `1071 / 1061 / 10`. Phase 3.5 adds **37 new
tests** (all passing), **0 non-live regressions**.

## L. Calibration readiness verdict

Every safety/architecture item in this phase is genuinely done: the P3
cleanup is resolved, the provider framework is real and tested, the
counterfactual generator works, the readiness classification is honest, and
the shadow invariant is proven to hold even against populated (stub) real
data. But the actual **data enablement** this phase exists to check is not
there — this environment has no network access, so zero real usage records,
zero real schedule records, and zero real historical trades were acquired.

```
PHASE 3.5 REAL DATA ENABLEMENT:
NOT READY FOR CALIBRATION
```

**Blockers, by severity:**

- **P0 (blocks any calibration)**: zero real historical trade records exist.
  Every signal's readiness ultimately depends on having real outcomes to
  validate against (§I) — this is the load-bearing blocker.
- **P1**: no real usage-stats source is integrated (blocks `usage_trend`/
  `role_stability`).
- **P1**: no real schedule-strength source is integrated (blocks
  `schedule_strength`).
- **P2**: even `availability`/`volatility` (already source-backed for
  diagnostics) cannot be promoted to a value adjustment without the P0
  historical dataset to ablate against.

None of these are defects in the work done this phase — they are the honest
result of running Phase 3.5 in an environment with no external network
access. The correct next step is NOT to fabricate a source or a historical
dataset to manufacture a "ready" verdict; per the guiding principle, `WEIGHT
= 0` over `UNJUSTIFIED CALIBRATION` and `NO SIGNAL` over `BAD SIGNAL` — this
verdict IS that principle applied honestly.

**Recommended next step** (not implemented here): in an environment with
real network/API access, (1) evaluate and integrate one real usage-stats
source and one real schedule-strength source behind the `UsageProvider`/
`ScheduleProvider` interfaces already built; (2) pull real Bloodline Bowl
(and any other connected league's) completed-trade transaction history into
`lib/trades/historical.ts`'s record shape; (3) generate a counterfactual
batch from real rosters using `generateCounterfactualTrades`; (4) re-run
`runAblation` from `lib/trades/calibration.ts` against the resulting real
outcome data; only then reclassify signals in `SIGNAL_READINESS` and
consider a nonzero weight for whichever signal (if any) shows genuine
incremental directional value.
