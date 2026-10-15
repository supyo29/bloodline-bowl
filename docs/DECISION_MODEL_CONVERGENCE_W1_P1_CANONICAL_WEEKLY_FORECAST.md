# Decision Model Convergence — W1.P1: Canonical Weekly Player Forecast

Version: `canonical-weekly-forecast-2026.1` · Baseline: `origin/main` @ `201256b` · Branch: `decision-convergence-w1-p1-canonical-forecast`

W1.P1 is a **substrate phase**. It adds one authoritative, provenance-carrying representation of a player's week
(`CanonicalWeeklyPlayerForecast`) and one construction path for it. It deliberately changes **no** production number.

## 1. Existing-state forensic findings

Production weekly value flows through one pipe, and it is narrower than the program prompt assumed:

1. `SleeperWeeklyProjectionProvider` (`lib/weekly/projections/sleeper-weekly.ts`) scores Sleeper/RotoWire stat lines in league
   scoring → `WeeklyProjectionBatch`. K/DST fall back to Sleeper's `pts_std` (flagged by a per-row warning).
2. `CanonicalProjectionSnapshotProvider` (`canonical-provider.ts`) wraps it with the Supabase snapshot read/write path.
   `registry.ts` is the only place the concrete provider is constructed (already pinned by `projection-architecture-guard.test.ts`).
3. `lib/weekly/context.ts` (`buildWeeklyTeamContext`) applies the **authoritative-schedule bye override** (bye ⇒ `projected_points: 0`,
   `projection_status: "bye"`, `expected_availability: 0`, `is_bye: true`) and converts "no number and not a proven bye" to
   `projection_status: "unavailable"` (null, never 0). The result is `ctx.projections` — **the value every weekly consumer reads.**
4. The FI production gate (`start-sit-fi/production-gate.ts#applyFiToProductionBatch`) is the only sanctioned mutator of
   `projected_points`, and **nothing in production calls it** (a source-scan test pins that). Role Calibration, Game Distribution,
   Injury-Propagation and Matchup Intelligence are SHADOW_ONLY / lineup-level, and are isolated from production by existing tests.
5. `expected_availability` is a fixed heuristic from the injury designation (out/IR 0.03, doubtful 0.3, questionable 0.78, else 1).
   It is **metadata only** today: no engine multiplies a projection by it.

### Findings worth carrying forward (not changed in W1.P1)

| # | Finding | Where | Owner |
|---|---|---|---|
| F1 | `context.ts` rewrites a source `"out"` status to `"unavailable"`, so "source says gp=0" is indistinguishable from "unavailable" by the time any consumer sees it. | `context.ts` (missing-data branch) | W1.P2 |
| F2 | The matchup simulation draw spec turns a null projection into **0** (`wp?.projected_points ?? 0`) — a null→0 substitution that violates "null = unknown". | `lib/weekly/matchup.ts:380` | W1.P2/W1.P4 |
| F3 | Two modules **construct their own `WeeklyProjection` rows** and so independently define a player's value: `trades/ros.ts` (`projected_points: onBye ? 0 : mean`) and `schedule-planning/evaluate.ts#synthBatch` (rescales points/floor/ceiling to a per-week ROS basis). Both are violations of the long-term rule. | `lib/trades/ros.ts:151`, `lib/schedule-planning/evaluate.ts:230` | W2 |
| F4 | Bye ⇒ 0 is encoded in at least five places (`context.ts`, `lineup.ts` `VERIFIED_ZERO`, `matchup-intelligence/build.ts`, `matchup.ts`, `trades/ros.ts`). | various | W1.P3 |
| F5 | `roster-health/inputs.ts` is a second call site of `getWeeklyProjectionProvider`, building its own batch outside `buildWeeklyTeamContext`. It does not see the canonical forecast. | `lib/roster-health/inputs.ts` | W1.P2 |
| F6 | The upstream source observation time is not captured by the provider, so `freshness.source_observed_at` is null. | `sleeper-weekly.ts` | W1.P4 |

## 2. Producer / consumer dependency map

```
Sleeper weekly feed ──► SleeperWeeklyProjectionProvider ──► CanonicalProjectionSnapshotProvider ──► WeeklyProjectionBatch
                          (stat lines → league points,           (Supabase snapshot read / live            │
                           K/DST pts_std fallback)                fallback / best-effort persist)           ▼
                                                                                    buildWeeklyTeamContext (context.ts)
                                                                                      · schedule bye override (0 + is_bye)
                                                                                      · missing ⇒ null/"unavailable"
                                                                                      · assembleRosSignals (ROS, in place)
                                                                                                │
                                              ┌─────────────────────────────────────────────────┴───────────────┐
                                              ▼                                                                 ▼
                                    ctx.projections  (legacy, unchanged)                    ctx.forecasts  (NEW, W1.P1)
                                              │                                              buildCanonicalForecastBatch
                          lineup · replacement/VOR · waivers · waiver2 · matchup ·           (the one construction path)
                          matchup-intelligence · start-sit · trades · roster-health ·
                          schedule-planning · matchup2-capture
```

## 3. Canonical schema

`lib/weekly/forecast/schema.ts`. Key fields (see file for the full contract):

- Identity: `canonical_player_id`, `identifiers` (provider-neutral map), `season`, `week`, `team`, `opponent`, `position`
- `value_state` (why the numbers look as they do — §5)
- `game_status { has_game, is_bye, game_id, kickoff_at }`
- `projection { source_points, conditional_active_points, expected_points, expected_points_basis, floor, median, ceiling }`
- `availability { probability_active, status, injury_status, workload_state, applied_to_expected_points: false, basis }`
- `role | environment | matchup { mode: NOT_APPLIED | INFORMATIONAL | SHADOW | PRODUCTION, signal }`
- `uncertainty { confidence, variance, basis, reasons }`
- `freshness { source_observed_at, snapshot_created_at, age_ms, stale }`
- `provenance { projection_provider, source_version, source_type, snapshot{artifact_id, read_path, durable}, source_ids, production_adjustments_applied, shadow_adjustments_computed, source_warnings }`
- `contributions[] { component, phenomenon, points_delta, mode, reason }`
- `certification { state: PRODUCTION | SHADOW | PARTIAL | UNAVAILABLE, warnings }`

Deviations from the prompt's sketch: `player_id` is dropped (one canonical id; provider ids live in `identifiers`/`source_ids`);
added `value_state`, `expected_points_basis`, `availability.applied_to_expected_points`, contribution `phenomenon`, and
`INFORMATIONAL` as a component mode. Nothing here can be `PRODUCTION` for role/environment/matchup — the input type forbids it
and `validateForecastInvariants` rejects it.

## 4. Semantics of every projection field

| Field | Meaning in W1.P1 |
|---|---|
| `source_points` | The upstream provider's number for this player-week in league scoring. `null` = unknown. For a bye, the stale feed value if one existed, else `null`. For a row with a production FI adjustment baked in, `null` (not recoverable). |
| `conditional_active_points` | Value if healthy and playing. **Defaults to `source_points`.** Never collapses to the bye zero. |
| `expected_points` | **The value production consumes today**, bit-for-bit (`ctx.projections` after the bye override). `expected_points_basis` says how: `SOURCE_PROJECTION`, `BYE_COMPAT_ZERO`, `SOURCE_PLUS_FI_PRODUCTION`, `UNKNOWN`. |
| `floor` / `ceiling` | The source's position-volatility band (heuristic, not a fitted distribution; `uncertainty.reasons` says so). `null` on a bye. |
| `median` | Not modeled by any current source → `null`. |
| `uncertainty.confidence` | Always `null`: no calibrated confidence exists. Confidence is never derived from points or band width. |

## 5. Missing-data semantics (`value_state`)

`null` = unknown; `0` = known zero. Only two states may carry a 0: `KNOWN_ZERO_PROJECTION` and `BYE_VERIFIED`.

| State | When | `expected_points` |
|---|---|---|
| `PROJECTED` | real stat line, non-zero score | number |
| `KNOWN_ZERO_PROJECTION` | real stat line scoring to exactly 0 | `0` |
| `BYE_VERIFIED` | schedule-proven bye | `0` (compat placeholder) |
| `NO_SCHEDULED_GAME` | caller-supplied: no game and not a bye (reserved; no producer supplies this yet) | `null` |
| `PLAYER_OUT_IN_SOURCE` | source row has `gp = 0` (see F1: unreachable through `context.ts` today) | `null` |
| `PLAYER_NOT_FOUND` | no identity, no row | `null` |
| `SOURCE_MISSING_PLAYER` | healthy batch, no entry for the player | `null` |
| `SOURCE_FETCH_FAILURE` | whole batch `PROJECTIONS_UNAVAILABLE` | `null` |
| `UNSUPPORTED_SCORING_DATA` | only precomputed `pts_*` totals; not reconstructable for this league | `null` |
| `PROJECTION_UNAVAILABLE` | row exists, no usable number | `null` |
| `UNKNOWN` | defensive default | `null` |

"Player inactive" and "player on IR" are **availability**, not value states: they appear in `availability.status`
(`OUT`, `INJURED_RESERVE`, …) and never alter `value_state` or `expected_points` in W1.P1.

## 6. BYE semantics

A bye is `game_status.is_bye = true`, `value_state = BYE_VERIFIED`, `availability.status = BYE`, `availability.probability_active = null`
(a bye is not an injury). Production compatibility keeps `expected_points = 0` with `expected_points_basis = BYE_COMPAT_ZERO` and a
certification warning `BYE_EXPECTED_POINTS_IS_COMPAT_ZERO_NOT_UNDERLYING_VALUE`. The ledger shows the zero as its own `BYE_COMPAT_ZERO`
entry (phenomenon `BYE`), separate from `BASE_PROJECTION`. `conditional_active_points` keeps the underlying value (or `null`); it is
never `0` for a bye. `getLegacyExpectedAvailability` reproduces the legacy `0` for a bye. The real asset-preservation fix is W1.P3.

## 7. Injury metadata semantics

`availability.probability_active` is the existing injury-designation heuristic, `status` its normalised designation. Both are carried
as metadata; `applied_to_expected_points` is the literal `false`. An `AVAILABILITY_METADATA` ledger entry with delta `0` and mode
`INFORMATIONAL` records that a designation exists and was not applied. W1.P2 owns flipping this.

## 8. Provenance model

Every forecast answers "where did this come from?": `projection_provider` (e.g. `sleeper_weekly`), `source_version`
(`sleeper-weekly-rotowire`), `source_type` (`WEEKLY_STAT_LINE_SCORED` | `K_DST_STANDARD_FALLBACK` | `BYE_SCHEDULE` | `NONE`),
the snapshot (`artifact_id`, `read_path`, `durable`), provider ids (`source_ids`), the production adjustments inside `expected_points`,
the shadow adjustments computed but not applied, and the provider's per-row warnings verbatim. `model_version` is the forecast
architecture version and is also stamped into `ctx.lineage.engine_versions.canonical_weekly_forecast`.

## 9. Contribution model

The ledger reconstructs `expected_points`: **the sum of `PRODUCTION` deltas equals `expected_points`** (null expected ⇒ no PRODUCTION
entries). `SHADOW`/`INFORMATIONAL` entries never enter the sum. Each entry names a `phenomenon`
(`BASE | BYE | ROLE | ENVIRONMENT | MATCHUP | AVAILABILITY | FOOTBALL_INTELLIGENCE`) and at most one PRODUCTION entry may exist per
phenomenon, so two components cannot silently adjust the same thing. In W1.P1 the only PRODUCTION phenomena are `BASE` (and `BYE` for the
compat zero). `validateForecastInvariants` enforces all of this; it is run in the tests over every forecast.

## 10. Migration status by consumer

No consumer's numerical read was rewritten in W1.P1 — that is the point: zero drift. `ctx.forecasts` now exists beside `ctx.projections`,
the adapters exist, and a ratchet test freezes the legacy direct-reader set so it can only shrink.

| Consumer | File(s) | Status | Notes |
|---|---|---|---|
| Canonical producer | `lib/weekly/context.ts` | **Migrated** (builds `forecasts`) | one `buildCanonicalForecastBatch` call, after bye handling |
| Lineup optimizer | `lib/weekly/lineup.ts` | **Adapter** | `getLegacyProjectedPoints`; bye handled as `VERIFIED_ZERO` today (W1.P3) |
| Replacement / VOR | `lib/weekly/replacement.ts` | **Adapter** | built after forecasts exist in `context.ts`, so it can switch without reordering |
| Waiver engine 2026.1 | `lib/weekly/waivers.ts` | **Adapter**; behavior **Deferred** | availability discount / bye-aware drop = W1.P2/W1.P3 |
| Waiver Intelligence 2.0 | `lib/waiver2/context.ts` | **Adapter** | consumes `ctx.projections` |
| Matchup engine | `lib/weekly/matchup.ts` | **Adapter**; F2 **Deferred** | null→0 in draw spec |
| Matchup Intelligence | `lib/weekly/matchup-intelligence/build.ts` | **Adapter**; **Deferred** (bye/availability logic) | |
| Start/Sit + FI | `lib/weekly/start-sit.ts`, `start-sit-fi/*` | **Deferred** | FI production gate is the only sanctioned projection mutator and is unwired; availability risk is W1.P2 |
| Trade engine | `lib/trades/*` | **Adapter** (reads) / **Deferred** (F3: `trades/ros.ts` builds its own rows) | |
| ROS utilities | `lib/weekly/ros.ts`, `lib/trades/ros.ts` | **Deferred** | ROS asset value ≠ current-week utility; `assembleRosSignals` mutates the batch in place |
| Schedule planning | `lib/schedule-planning/evaluate.ts` | **Deferred** (F3) | `synthBatch` rescales to a ROS basis |
| Roster health | `lib/roster-health/*` | **Adapter** | F5: separate provider call site |
| matchup2 capture | `lib/persistence/supabase/matchup2-capture.ts` | **Adapter** | baseline capture |
| Weekly book / report output | `lib/analysis-book`, `lib/weekly-audit` | **Deferred** (version stamp only) | `lineage.engine_versions` carries the forecast version; no per-player forecast surfaced on an HTTP route yet |

## 11. Tests

- `test/canonical-weekly-forecast.test.ts` (24): contract semantics (healthy, questionable, injured, bye ±stale feed value, missing ×4,
  known zero vs unknown, shadow Role, K, DST, FI-adjusted row, staleness, uncertainty, determinism, no-mutation), Yahoo neutrality,
  **golden production compatibility over the real `buildWeeklyTeamContext`**, shadow-signal isolation, snapshot-hit parity,
  diagnostics, invariant-validator negative tests, version stamping.
- `test/canonical-weekly-forecast-architecture.test.ts` (4): single construction path, single batch-builder call in `context.ts`,
  legacy-reader **ratchet**, forecast modules pure and provider-neutral.
- Fixtures: `test/fixtures/canonical-forecast-golden.ts`, `…production-before.json` (captured from clean `origin/main` @ `201256b`).
- Mutation checks performed: injecting injury discounting into the builder fails 5 tests; adding a rogue direct reader fails the ratchet.

## 12. Known limitations

- Role Calibration / Game Distribution / Matchup signals have **no per-request producer** in the weekly context (they are offline /
  shadow stores). The contract and `roleSignalFromShadowCandidate` adapter exist and are tested; in production contexts those components
  are `NOT_APPLIED`. Wiring a shadow-signal source is a later phase.
- The role adapter is structural (no import of `lib/role-calibration`) because the existing production-isolation test forbids it.
- `has_game` is inferred (bye ⇒ false; team in `teams_with_games` or opponent present ⇒ true; else `null`). `game_id` / `kickoff_at` are
  `null` — the weekly context holds no per-player schedule row.
- `source_observed_at` is `null` (F6). `stale` is computed from snapshot age only.
- `PLAYER_OUT_IN_SOURCE` and `NO_SCHEDULED_GAME` are defined but unreachable through `buildWeeklyTeamContext` today (F1; no producer).
- No HTTP route exposes the full forecast or `explainForecast`; they are available to code and tests.

## 13. Deferred work

- **W1.P2 — Injury-aware expected value:** flip `applied_to_expected_points`, define `conditional_active_points` vs `expected_points`; fix F1, F2, F5.
- **W1.P3 — Bye-aware asset preservation:** retire `BYE_COMPAT_ZERO`; fix F4; waiver drop model.
- **W1.P4 — Projection freshness:** capture upstream observation time (F6); staleness policy beyond snapshot age.
- Retire F3 (own-row construction in trades/schedule-planning) and shrink the ratchet list as consumers migrate.

## 14. Production compatibility result

Same 12-player scenario (all offensive positions, K, DST, healthy, questionable, injured, bye ×2, known zero, missing, totals-only,
source-out, Yahoo-identified) run through the real `buildWeeklyTeamContext` on clean `origin/main` @ `201256b` and on this branch:
`projected_points`, `projection_status`, `expected_availability`, `is_bye` are **identical for every player** (0 changed values). Persistence
code (`canonical-provider.ts`, `canonical-snapshot.ts`, `lib/persistence/supabase/projection-snapshot.ts`) is **untouched**: the forecast is
constructed at read time from the existing snapshot (option C), so there are no new records, no schema change, and the pagination/dedupe and
>1000-row protections are unaffected. User-facing recommendations should not have changed.

Full suite: baseline `origin/main` 3085 tests / 2647 pass / 127 fail / 257 cancelled / 54 skipped → branch 3113 / 2675 / 127 / 257 / 54.
The failing set is **identical** to baseline (diffed by name); those failures are environmental (Sleeper `403` through the sandbox proxy,
wall-clock-dependent tests) and predate this branch. Typecheck, lint (39 warnings, 0 errors, same as baseline) and `next build` pass.
