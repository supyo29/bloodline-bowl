# Decision Model Convergence — W1.R2 Final-Pregame Clock Repair & Canonical Asset Value

Base: `abe494f` (W1.R1). Branch: `decision-convergence-w1-r2-asset-value-clock`. Local only — not pushed, merged or deployed. No migration (none needed: the new
forecast fields live inside existing JSONB records). No remote database touched.

## 1. Second Opus audit summary
Verdict **B — READY AFTER TARGETED REMEDIATION**: 0 P0, 4 P1.
- **P1-A:** final-pregame capture rejected every forecast built from a live fetch. `composed_at` was the request start; `source_observed_at` was stamped on arrival, so it was always later.
- **P1-B:** an injured star could be the recommended HIGH-priority drop.
- **P1-C:** a verified-bye star whose feed row read 0 had that 0 used as his "pre-bye" value.
- **P1-D:** the trade horizon multiplied the whole ROS rate by this week's availability.

P1-B, P1-C and P1-D are one missing abstraction: there was no canonical asset (hold) value.

## 2. Git baseline
- `abe494f` on top of 65a04f4 / 89e22ad / 68fc482 / ab7dce3 / 201256b.
- `origin/main` is at `974737e`: three bot data commits (football-intel CSVs, intelligence-history snapshots, role-calibration inputs). None touch the forecast, waiver, trade, final-pregame or calibration code, so I branched from `abe494f` with no rebase.
- Baseline at `abe494f`: **3436 tests / 2998 pass / 127 fail / 257 cancelled / 54 skipped**. That is 506 failing names, all pre-existing. tsc is clean, lint is 39 warnings / 0 errors, `next build` passes.

## 3. P1-A reproduction (before)
`scripts/w1r2-repros/p1-a-live-fetch-final-pregame.ts` runs the real `buildWeeklyTeamContext` and the real `CanonicalProjectionSnapshotProvider` (no injected composition clock). The live provider stamps `observed_at` on arrival, as `lib/sleeper/client.ts` does.
```
network/refresh  fetch_started 02:26:03.820  observed 02:26:03.846  composed 02:26:03.820  -> REJECTED_INCONSISTENT_TIMES 24, recorded 0
network/prefer   (same shape)                                                                -> REJECTED_INCONSISTENT_TIMES 24, recorded 0
cache/*          observed 1 min earlier                                                      -> RECORDED 24
```
The rejection was swallowed by `catch {}`.

## 4. P1-A fix
- `ProjectionProvider` gains an optional `now()` (the provider's clock). `CanonicalProjectionSnapshotProvider` implements it.
- `lib/weekly/context.ts` reads that clock **at composition**, after the league state, the projection batch and any live fetch are in hand. Ordering is now request start → fetch → observation stamped → composition stamped. Nothing is clamped or adjusted.
- `freshness_context.now_ms` is documented as the request start, with an explicit `request_started_ms` alias. Freshness age is measured at composition.
- After the fix (same script): `network/refresh observed …09.020 composed …09.021 -> RECORDED 24`, and the same for every mode.

## 5. Canonical asset-value design
One substrate: `lib/weekly/forecast/asset.ts`.
- `canonicalAssetValue(row, week, pre_bye_source_points?)` returns `{ current_week, forward_value, asset_value }`.
- `holdWeeklyValue` is now a `{points, basis}` view over it. It moved out of `bye.ts`, so there is one implementation.
- `forwardWeeksOut` is the shared forward-availability rule.
- Every canonical forecast now carries `asset_value`.

**Rule:** the hold value rests on the **freshest evidence that this week's condition has not suppressed**.

| Condition (normalized injury state / bye) | Hold value (per week) |
|---|---|
| none: healthy, probable, unrecognised | the current source projection (`CURRENT_WEEK_NOT_BYE`), the legacy value, so healthy decisions are byte-identical to `abe494f` |
| Questionable | the current source projection (`QUESTIONABLE_SOURCE`). Questionable players usually play, so the number is valid. A Q tag never moves the hold value |
| verified bye | a **positive** pre-bye projection (unless Doubtful/Out, which suppresses it), else ROS ÷ remaining weeks (`ROS_PER_WEEK_PROXY` / `RI_ROS_BENCHMARK`), else unknown |
| Doubtful / Out / official inactive | the forward ROS rate, else unknown. The current number is suppressed by the condition itself |
| long-term: IR / PUP / NFI / suspended | the same hierarchy, × (1 − 4/horizon). 4 is the NFL minimum stint, a rule, not a fitted weight |

- **Properties:**
  - A Questionable tag never changes the value.
  - Doubtful and Out share one basis.
  - A long-term condition never raises the value.
  - A bye never falls below forward evidence.
  - A static ROS never overrides a healthy player's fresh projection.
- **Unknown:** `null`, never 0. `temporary_current_week_penalty_applied` is always false.
- **Explanation:** every value carries its `basis` and a plain-language `explanation`.
- **Design history:** a first draft used "healthy = this week, injured = ROS, Questionable = max", which the focused re-audit found non-monotone (B-1, P1). A second draft used a uniform max(projection, ROS) for everyone. The verifier showed it let a static preseason ROS override fresh in-season evidence for healthy players, suppressing breakout adds (20/20 → 1/20) and double-counting ROS. The final rule above resolves both.

## 6. Current-week vs asset vs forward

| View | Question it answers | Used by |
|---|---|---|
| current week (`projection.expected_points`) | what he scores this week | lineup, matchup, close calls, waiver add benefit and counterfactual |
| forward (`asset_value.forward_value`) | ROS points, weekly rate and weeks out | trade horizon availability |
| asset (`asset_value.asset_value.hold_points_per_week`) | what keeping him is worth | waiver drop cost, trade private value |

The final-pregame calibration still grades current-week expected points. The asset view is not in the content signature and is never graded as a forecast.

## 7. P1-B (injured star)
`scripts/w1r2-repros/p1-bc-asset-drops.ts` uses the real context and the real waiver engine. The subject is a WR with ROS 230; the bench is fringe (9 pts, ROS 110); the free agent projects 11.

| Case | Drop before | Drop after |
|---|---|---|
| Out, source 0 | **A** (the star) | B (fringe bench) |
| Doubtful, source 1.2 | **A** | B |
| IR on an active slot, source 0 | **A** | B |
| Questionable star, source 15 (repro case before the re-audit: depressed source 4) | **A** | B |
| control: Questionable but the provider projects only 4 | A | A (same as a healthy player projected 4: the Q tag changes nothing) |
| healthy control (18) | B | B |
| Out, ROS 20 (season-ending shape) | A | **A** (correctly still droppable) |

## 8. P1-C (bye source zero)
- **Cause:** `build.ts` used any non-null source value on a bye as `SOURCE_PROJECTION_PRE_BYE`, including 0.
- **Fix:** only a positive source counts, in both `build.ts` and `asset.ts`.
- **Repro, verified bye with a 0 row and ROS 230:** drop was A at HIGH, now B. The underlying value moves from 0 (`SOURCE_PROJECTION_PRE_BYE`) to 17.69 (`ROS_PER_WEEK_PROXY`).
- **Repro, 0 row with only RI 300:** drop was A, now B.

## 9. P1-D (trade horizon)
- **Fix:** `horizon.ts availabilityAdjustment` now computes per-week drag as `−rate × (current-week missing fraction + forward weeks out beyond this one) ÷ remainingWeeks`. A verified bye adds 0, because `ros.ts` already prorates the bye week.
- **Repro:** `scripts/w1r2-repros/p1-d-trade-horizon.ts`, real `evaluateTradeHorizons`. Give away star S (18/wk) for equal healthy H, over a 12-week horizon.

| S's state | availability_delta before | after |
|---|---|---|
| healthy | 0 | 0 |
| Questionable (0.78) | +3.96/wk | +0.33/wk (one week) |
| Out | +18/wk | +1.5/wk (one week) |
| verified bye | **+18/wk** | 0 |
| IR | +18/wk | +6/wk (4-game minimum) |
| IR, ROS 0 (season-ending) | 0 | 0 (ROS already 0) |

## 10. Waiver integration
- **Drop cost:** `keep = keepFor(hold.points)` for every player, where hold is the canonical asset value. There is no bye-only gate.
- **Drop eligibility:** `weeklyKnown` applies one rule. Both the current week (for the counterfactual lineup gain; a verified bye is a known 0) and the asset value must be known. Unknown is never read as low.
- **`rec.asset_review_notes`:** asset-value notes are never silent.
  - `UNKNOWN_ASSET_VALUE`: a player held back as a drop.
  - `LONG_TERM_FORWARD_EVIDENCE_UNVERIFIED`: an IR-type player on an active slot valued from ROS that may not reflect his injury.
  - `INJURED_DROP_VALUED_FROM_ROS`: the recommended drop is injured this week and valued from ROS (season-average) evidence, so a breakout may be lost.
  - IR and taxi slots are excluded, and nothing is emitted on healthy rosters.
- **Unchanged:** the add side, the counterfactual lineup and the ROS edge.
- **Still open:** the known add-side triple bye credit (P2).

## 11. Trade integration
- **Private value:** a player with no temporary condition keeps his current-week VOR, unchanged. A bye or injured player uses the forward hold value (`ros_weekly_vor`, LOW confidence) or stays unavailable.
- **Horizon:** availability goes through `forwardWeeksOut`.
- **Not migrated:** discovery and owner-context VOR remain P2.

## 12. Provider neutrality
- The asset value reads only the canonical row: no Sleeper or Yahoo id.
- A Yahoo-only bye player finds the RI benchmark by **canonical** id. The fixture gained `subjectSleeperId: null`, and this case is a test.
- A DST is valued under `defense:nfl:<team>`.

## 13. Multi-league behavior
- **Registry:** discovered dynamically: 3 Sleeper + 2 Yahoo.
- **Same player across leagues:** the same NFL WR and DST across all five leagues give a current week of 0 everywhere, five distinct league-scored asset values, and need no provider id.
- **Existing suites:** the W1.P4 multi-league suite and the W1.R1 five-league certification still pass.

## 14. Final-pregame clock semantics
- **Validity:** evidence must be observed strictly before kickoff, and the belief must be composed before kickoff. The store now rejects `observed >= kickoff`, whenever the request started.
- **Capture outcome:** `ctx.final_pregame_capture = {status: CAPTURED | NOTHING_TO_CAPTURE | NO_COMPOSITION_CLOCK | FAILED, candidates, counts, error}`.
- **Failures:** produce a `final_pregame_capture_failed` warning plus a structured `console.warn` (method/table/status only, no credentials).
- **Rejections:** produce `final_pregame_capture_rejected` with counts.
- **Tests** (`test/w1r2-final-pregame-clock.test.ts`, a fake clock that advances during the fetch):
  - live fetch before kickoff: recorded
  - slow 4-minute fetch: recorded
  - cache hit: recorded
  - fetch starting before kickoff and completing after: not recorded
  - request after kickoff: rejected
  - a frozen revision cannot be mutated by a post-kickoff request
  - observation exactly at kickoff: rejected
  - the production-shaped wall-clock path
  - store failure: visible, and the analysis is intact
  - rejection counts are reported

## 15. Pointer / signature tests (`test/w1r2-mutation-gaps.test.ts`)
- **J2:** the close-call edge equals the canonical expected-points difference.
- **G2 / G1:** a stale-read race where a later composition sits on an older observation, and one where an older composition sits on the same observation. The database guard holds in both, and each axis is tested separately.
- **E5:** the in-memory rule.
- **Calibration selection:** the ledger grades the revision named by the store's DB-guarded final **pointer**, which carries confirmations. The pointed revision is re-validated with `decideCandidate`. Only a player with no pointer, or an invalid one, falls back to `selectFinalRevision`.
  - An intermediate draft retained older-evidence revisions instead. The verifier showed it let the ledger grade a belief a newer confirmation had superseded (S1), so it was reverted.
  - The test covers the S1 stale-read race end to end.
- **D3 / D5:** model version, shadow value and shadow version are each a different belief.
- **Opponent:** now signed.
- **Stability:** the same belief composed later after the source turned STALE has the same signature. The signature uses `certification.state_before_freshness`.
- **L3:** K/DST with `pts_std: null` was a **real defect**: `Number(null) === 0` produced a "known" 0. It is fixed in `sleeper-weekly.ts`. No stats or null `pts_std` is unknown; a genuine 0 is a known 0.
- **B2:** in the asset test file.

## 16. Mutation results (`scripts/w1r2-mutation-suite.py`, final run)
- **Result:** **32 mutants, 30 killed, 2 equivalent.** Files were restored byte-for-byte.
- **Killed:**
  - M1–M14 as specified.
  - Calibration: M15 (latest-composition rule), M23 (ledger ignores the pointer), M28 (pointer not re-validated).
  - Signature: M16 (STALE state signed), M17 (opponent unsigned).
  - M18: close calls read source rows.
  - Capture visibility: M19 (silent capture failure), M24 (no-op reported as CAPTURED), M25 (silent asset notes).
  - Asset rule: M20 (IR treated as temporary), M21 (Q tag moves the value), M21b (static ROS overrides a healthy projection), M21c (bye + IR not impaired).
  - M22: IR on a bye week carries no drag.
  - M27: an injured ROS-valued drop carries no note.
- **Equivalent survivors:**
  - **M2b** removes the context-side "observed before kickoff" filter. With `observed ≤ composed` by construction, the "composed before kickoff" filter excludes the same records, and the store's `o >= k` rule (M2) is the authority.
  - **M26** makes `weeklyKnown` ignore an unknown current week. Upstream, any rostered player with an unknown current week leaves the baseline lineup unresolved, so no add/drop is recommended at all. A test pins that gate, with a control.

## 17. Focused independent re-audit
There were three independent passes, each a separate agent that made no repo changes.

**1. Boundaries A and B** (the clock, and the asset value):
- Boundary A: no P1. Production always has the provider clock, and request-memo hits compose honestly. The signature is stable across a FRESH→STALE flip, and the new log line carries no secrets.
- Boundary B: **two P1s in my first draft**.
  - B-1: non-monotone asset rule.
  - B-2: a season-ending player can't become a cheap drop, and the doc's claim otherwise was false.
- Plus B-3 (P2: IR on a bye week had no trade drag), A-1 (P2: pointer and ledger rules disagree) and A-2 (P3: a no-op store reported CAPTURED).

**2. Verification of the fixes:** no P1. It found that the uniform-max fix suppressed breakout adds and double-counted ROS (P2, introduced by the fix), and that retaining older revisions let the ledger grade a superseded belief (P2). Both were reworked as described in §5 and §15.

**3. Final narrow check:** **no P1**.
- Healthy decisions are byte-identical to `abe494f` (600 random rosters plus the breakout set).
- P1-A through P1-D remain fixed.
- The ledger handles legacy, missing and invalid pointers.
- The notes are not noisy.
- Remaining: one P2-high, pre-existing and unchanged from `abe494f`. An Out or Doubtful breakout player can be the suggested drop because Sleeper's ROS tracks his season average, not his current role. There is no unsuppressed current number for an Out player. It is now flagged on the recommendation (`INJURED_DROP_VALUED_FROM_ROS`). A fuller fix, valuing him from his last frozen final-pregame projection, belongs to the ROS / Market State work.
- Also P2: the cross-state case "healthy A at 8/wk (ROS 120) is dropped, but Out A is kept" is conservative and definitional.

**Season-ending players (B-2):** Bloodline has no injury-timeline evidence. Sleeper turns a zeroed season row into null, not 0, and the RI benchmark is static. So a season-ending player on an **active** slot is protected rather than dropped. This is the conservative failure, and it is now **visible** (`LONG_TERM_FORWARD_EVIDENCE_UNVERIFIED` / `UNKNOWN_ASSET_VALUE` notes). Documented limitation, P2.

## 18. Full-suite comparison
- At HEAD: **3511 tests / 3073 pass / 127 fail / 257 cancelled / 54 skipped**. That is 75 new tests, and the failing set is identical by name to the `abe494f` baseline (0 new, 0 fixed).
- One pre-existing test file changed only its import path (`bye-asset-preservation.test.ts`: `holdWeeklyValue` moved to `asset.ts`). `feed-absent-bye.test.ts` likewise. The feed-absent fixture gained a `subjectSleeperId` option.
- tsc is clean; lint is 39 warnings / 0 errors, the same as baseline; `next build` passes.
- The live smoke (`scripts/projection-freshness-smoke.ts`) gives **LIVE_VALIDATION_BLOCKED** for all 5 leagues: Sleeper returns 403 through the egress proxy.

## 19. Remaining P2/P3 debt (not done here)
- Request memo ignoring a tighter max age.
- Process-local invalidation ledger.
- Batch invalidation overbreadth and the missing 2-minute floor.
- No near-kickoff capture scheduler.
- Cron refetch per league.
- Yahoo numeric-id route connection.
- Writes for anonymous unregistered leagues.
- Market State / replacement pool convergence, and Yahoo Market State.
- Waiver add-side triple bye credit.
- Waiver 2.0 anchoring on this week's value.
- Roster health / schedule planning raw provider reads.
- Close-call floor/ceiling still on the source basis.
- Trade discovery and owner-context current-week VOR.
- `FROZEN_PREGAME` ignoring age, events and refresh state.
- Legacy-writer source time.
- First-insert pointer race (the pointer can lag; calibration now ignores the pointer and uses the single selection rule).
- Fabricated zero actual for players with no Sleeper id.
- DST double-grading in the id go-live week.
- Weak regex ratchets.
- The ROS-proxy asset value is uncalibrated: a crude spread of ROS over the remaining weeks.
- An Out/Doubtful breakout player can be the suggested drop because ROS tracks a season average (P2-high, pre-existing, flagged on the recommendation).
- Season-ending players on active slots are protected rather than dropped: no injury-timeline evidence (P2, notes emitted).
- The IR minimum stint ignores that bye weeks do not count toward it (P3).
- `normalizeInjuryStatus` does not map dashed statuses (`IR-R`, `PUP-R`) or `SUSP` (P3, pre-existing).
- Roster-level notes repeat on every recommendation, and a bye + IR player gets no long-term note (P3).
- A failed pointer read silently falls back to `selectFinalRevision` (P3).

## 20. Staging readiness
- **Steps:**
  1. Apply the P4 and R1 migrations to staging and reload the PostgREST schema cache.
  2. Run the read-only smoke from a network that can reach Sleeper: all five leagues must PASS.
  3. Through one real pre-kickoff window, confirm `final_pregame_capture.status = CAPTURED` with RECORDED > 0 for live fetches, and that a post-kickoff request leaves the frozen revision unchanged.
  4. Spot-check waiver drops and trade valuation against a real injured star and a real bye star.
- **Wave 1:** READY FOR STAGING CERTIFICATION.
