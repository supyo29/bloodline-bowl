# Decision Model Convergence — W1.R1 Audit Remediation & Wiring Closure

Audited tip: `65a04f4` (W1.P4). Branch: `decision-convergence-w1-r1-audit-remediation`. Local only — not pushed, merged or deployed. No production migration applied.

**Verdict: CERTIFIED WITH DOCUMENTED LIMITATIONS** (live validation blocked; see §17).

## 1. Scope
Four audit P1s, two surviving `is_bye` mutations, and Wave-2 gates G1 (calibration-grade final-pregame record), G2 (hindsight hole), G3 (calibration wiring). Nothing else. Role Calibration, injury λ/priors, waivers, ROS, Market State, K/DST scoring, trade shadow weights and matchup simulation were not touched.

## 2. Baseline
Captured before edits on 65a04f4 (worktree `/tmp/wt-r1base`): full suite 3334 tests, 127 failing, 257 cancelled (all pre-existing, role-calibration family and environment-dependent suites); lint 39 warnings; tsc clean. Re-measured on the same extraction at the end: **0 new failures, 0 fixed**; HEAD has 3436 tests (+102 new), 127 failing (same set).

## 3. P1-1 PostgREST legacy-schema fallback
Reproduced: the regex `isMissingColumn` never matched the wrapper's message (no body), so on a legacy schema every write failed and the durable pointer path was dead (0 pointer rows; 2 live calls). Fix: `SupabaseRestError` carries `status/code/table/method`; `classifySchemaMismatch` maps 42703/PGRST204 → MISSING_COLUMN and 42P01/PGRST205 → MISSING_TABLE; `isPointerSchemaLegacy` requires the structured verdict AND the pointer table. Legacy verdict is re-probed every 5 minutes. Legacy rows hydrate with warning `projection_snapshot_source_time_unknown` (degraded, never silently fresh). Fake REST now raises PostgREST-shaped errors. After: durable HIT, 1 live call. Tests: `test/postgrest-schema-compat.test.ts`.

## 4. P1-2 `/api/lineup` bypassed canonical forecasts
Reproduced: the route started Out/IR players because it read raw weekly rows. Fix: route runs `lineupEndpointView(ctx)` (shared with the weekly-intelligence builder); `buildCloseCalls` reads `decisionProjectionRows`. Route and intelligence now agree by construction. Test: `test/api-lineup-parity.test.ts` (real handler via `mock.module`, non-vacuous close-call check). One source-grep guard (`startsit-capture-integrity` 17b) was updated to follow the call into `lineupEndpointView`; it still asserts capture runs after production output.

## 5. P1-3 Yahoo team-defense identity
Reproduced: Yahoo defense `player:yahoo:100022` vs Sleeper `player:sleeper:bal`; both Yahoo leagues' defenses had no projections. Fix: `lib/canonical/team-defense.ts` — identity `defense:nfl:<team>` from team evidence only, using the single repo normalizer (`lib/canonical/team-codes.ts`); resolution is RESOLVED / AMBIGUOUS / UNRESOLVED (ambiguous labels such as "New York", "Los Angeles" never guess; they keep a provider-scoped id with low confidence). Provider ids stay as attributes. Consumers that needed a Sleeper id use `sleeperIdFromCanonicalId`. Snapshot request fingerprint includes `identity_scheme: team-defense-v1` so old snapshots are not reused. After: both Yahoo leagues get `defense:nfl:bal`, projections 8 and 6. Tests: `test/team-defense-identity.test.ts`.

## 6. P1-4 feed-absent verified-bye player falsely droppable
Reproduced: a valuable bye-week player missing from the weekly feed had no hold value and was the preferred drop. Evidence ladder: pre-bye source value → ROS (including the RI season-signal benchmark via `rosFromSeasonPoints`) → unknown. **Unknown is not low**: `weeklyKnown` returns false for a verified bye with no hold value, so he is excluded from drop candidates with a diagnostic rather than ranked as zero. Narrowest rule: only verified-bye players. Tests: `test/feed-absent-bye.test.ts`.

## 7. Stale `is_bye` closure
`deriveForwardRow` (lib/weekly/forecast/bye.ts) is the single normalization for rows moved to another week: `is_bye` false, status projected/unavailable, opponent null, availability 1 if the source was a bye, `bye_*` warnings dropped, bands proportional. Used by `roster-health/contingency.ts` (`horizonBatch`) and `schedule-planning/evaluate.ts` (`synthBatch`). Test: `test/forward-row-normalization.test.ts`.

## 8. G1 final-pregame record (v2)
Record carries: forecast id (`fpf:` content hash), composed_at, source projection, canonical expected, conditional-active, injury state/probability/workload/semantics, contribution ledger, bye state, freshness + source-observation identity, versions, shadow values/modes, K/DST certification, content signature, full forecast snapshot. Content signature excludes time-varying freshness fields and `FORECAST_STALE`/`OBSERVATION_AFTER_KICKOFF` notes.

## 9. G2 hindsight protection
Reproduced: a post-kickoff request rewrote a frozen 14.0 forecast to 0. Fix: revisions are immutable and append-only (store + DB trigger); the final pointer is deterministic; `decideCandidate` rejects composition at/after kickoff, observations after kickoff, and observation-after-composition. The capture filter in `context.ts` also drops rows whose composition is not before kickoff. Database CHECKs repeat the rule.

## 10. G3 calibration integration
New artifact kind `FINAL_PREGAME_FORECAST`, preferred over source snapshots by `selectPregameEvidence`. League-scoped, no Sleeper-id requirement; `evaluation_basis` and `source_basis_error` keep source-quality and league-scored quality distinct. No auto-promotion, no weight change.

## 11. Migration strategy
Additive follow-on `20261009120000_w1r1_final_pregame_revisions.sql`; the W1.P4 migration is untouched (it cannot be proven unapplied; no remote database was queried). Non-unique belief index (a unique one would collide with `ON CONFLICT (forecast_id)`); pointer table gains `forecast_id`/`composed_at` with a NOT VALID check so legacy rows survive; calibration kind CHECK extended; RLS enabled and anon/authenticated revoked on the new and W1.P4 tables.

## 12. Real-Postgres compatibility
`scripts/w1r1-pg-compat.sh`: throwaway local PostgreSQL 16 cluster, never remote. All 17 migrations apply; the two W1 migrations re-apply idempotently; assertions cover real production-built records and ids, CHECK refusals, immutability trigger, ON CONFLICT semantics, pointer guards, FK order, enums, timestamptz rendering, NULL ordering, calibration kind, grants/RLS. Result: **ALL POSTGRES COMPATIBILITY ASSERTIONS PASSED**. Limit: SQL semantics only — no real PostgREST in the loop.

## 13. Consumer wiring matrix
| Consumer | Reads canonical forecast |
|---|---|
| weekly intelligence | yes |
| `/api/lineup` | yes (P1-2) |
| close calls | yes |
| waivers | yes (+ verified-bye hold evidence) |
| roster health / schedule planning / trade ROS | yes, via `deriveForwardRow` |
| calibration ledger | yes, final-pregame preferred |

## 14. Multi-league
Dynamic registry: 3 Sleeper + 2 Yahoo. `test/w1r1-five-league-certification.test.ts` (4 tests): defense identity identical across providers; five league-scoped distinct revisions; post-kickoff composition rejected for every league with frozen records untouched. `test/multi-league-freshness.test.ts` (W1.P4) still passes.

## 15. Mutation results
`scripts/w1r1-mutation-suite.py`: **11/11 killed**, files restored byte-for-byte (hash-checked). Survivors: none. M1 structured missing-column detection; M2 `/api/lineup` own source-basis lineup; M3 Yahoo DST provider-specific id; M4/M4b unknown-value bye drop fallback and feed-absent bye built without ROS evidence; M5 stale `is_bye` in forward rows; M6 contribution ledger dropped from the record; M7 post-kickoff composition rewrites the frozen forecast; M8 calibrating against the source projection; M9 Sleeper id required for calibration identity; M10 divergent forecast-set identity between the two lineup endpoints.

## 16. Ratchets
`test/helpers/wave1-ratchets.ts` + `test/wave1-ratchets.test.ts`: `app/` routes may not bypass the canonical view; `is_bye` equivalent forms (`is_bye: true`, `case "bye"` on projection status, spread writes) must go through the normalizer; freshness fields must not be recomputed from snapshot time. Stale exemptions removed (start-sit-fi/capture, matchup2/capture, waiver2/capture). Existing ratchets unweakened. Each rule has a planted-variant self-test. **Limits:** regex/paren-matching heuristics — a sufficiently indirect write (computed key, helper in another module) is not caught.

## 17. Verification
- Full suite vs baseline: 0 new failures (127 = 127).
- `tsc --noEmit`: clean. `npm run lint`: 39 warnings = baseline, 0 errors. `next build`: exit 0.
- Live validation (read-only smoke): **LIVE_VALIDATION_BLOCKED** for all 5 leagues (Sleeper 403 at `/state/nfl` through the egress proxy). Not bypassed. Fixture and real-Postgres evidence only.

## 18. Remaining debt (P2/P3, intentionally not done)
Request-scope memo ignores `max_source_age_ms`; broad event supersession; process-local event ledger; no near-kickoff scheduler; unused event types/scopes; cron per-league refetch; Market State vs replacement-pool mismatch; Yahoo Market State; waiver add-side bye/injury double credit; hand-tuned weights. Yahoo-only individuals are representable in the ledger but not gradable without a stats join.

## 19. Staging checklist
1. Review the diff; decide the W1.P4 and W1.R1 migrations as one reviewed set.
2. Apply both to a staging project (not production); confirm via `scripts/w1r1-pg-compat/assertions.sql`.
3. Run the read-only smoke from an environment that can reach Sleeper; require PASS/PASS_WITH_LIMITATION for all five leagues, including both Yahoo leagues' defenses.
4. Observe one pre-kickoff window: a frozen revision exists, a post-kickoff request does not alter it.
5. Confirm PostgREST schema cache reload after migration.

## 20. Readiness
Wave 1: READY FOR STAGING CERTIFICATION. Wave 2: calibration ledger — READY AFTER STAGING; injury/role calibration — NOT READY (out of scope here); waivers/ROS/Market State — READY DURING ITS PHASE.
