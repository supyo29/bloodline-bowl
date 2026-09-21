# Intelligence Modernization — Phase 5 (Matchup Intelligence 2.0): merge, deployment and production certification

Date: 2026-09-21. Operationalization only — no modeling change, no numeric matchup adjustment, Phase 6 not started.

## Verdict
**A — PHASE 5 OPERATIONAL IN PRODUCTION, FIRST SCHEDULED CAPTURE PENDING OBSERVATION.**
`CRON CONFIGURATION VERIFIED — FIRST SCHEDULED EXECUTION NOT YET OBSERVED` (next run 14:15 UTC).

## Git
- Certified branch `intelligence-modernization-phase5-matchup-2` tip `f84010e`; base and pre-merge `main`/`origin/main` = `0b21f2f` (no drift; 7 ahead / 0 behind).
- Merge: fast-forward (`0b21f2f..f84010e`), pushed, no force. 41 files changed = exactly the certified diff. No follow-up fix commits. This record is a docs-only commit on top.

## Rollback reference (recorded before any change)
- Prior production deployment `dpl_8S52VBednqgMBss9WZ4cdh632zij`, SHA `0b21f2f`, READY, rollback candidate.
- Aliases: `bloodline-bowl-sleeper-bridge.vercel.app`, `bloodline-bowl-sleeper-bridge-supyo29s-projects.vercel.app`, `bloodline-bowl-sleeper-bridge-git-main-supyo29s-projects.vercel.app`.
- Prior crons: capture 12:00, publish 13:00, waiver2-capture 14:00 (no matchup2).
- Prior migrations through `20260921040113 market_state_snapshots`.
- DB rollback: the two new tables are telemetry-only and additive; drop statements are in the migration header. Rows are immutable by trigger, so recovery from a bad row is drop-and-recapture, never edit.

## Deployment
- `dpl_4m5kCmq3URqNajAV89BPqi6BWuNp`, SHA `f84010e`, READY (build 28 s), all three aliases attached, no alias error.

## Database
Applied `supabase/migrations/20260921120000_matchup2_shadow_captures.sql` verbatim via Supabase MCP `apply_migration` (name `matchup2_shadow_captures`; version stamped at apply time) to production `ijpfjdzmaztofawhwepf`. Pre-checks: no name collisions, all statements `if not exists`/`create or replace`, additive only.
Verified: 2 tables, 18 + 4 columns, 8 constraints on captures (PK, class/position/lifecycle/id-format checks, record-consistency check, `LIVE_CAPTURED requires PRE_KICKOFF_VERIFIED lock AND baseline`, `LIVE_POST_LOCK requires POST_LOCK`), FK + PK on outcomes, indexes `scope_idx` and `class_idx`, immutability triggers on both tables, RLS enabled with no policies, no anon/authenticated grants (anon REST read → 42501).
Constraint proof on the real production schema (single DO block, forced rollback, 0 rows left): 10/10 invalid writes rejected (LIVE_CAPTURED without lock/baseline, wrong lock verdicts, ILLUSTRATIVE, non-SHADOW_ONLY, `may_influence_production=true`, id mismatch, K position, orphan outcome); valid pre-kickoff and post-lock rows accepted; duplicate `ON CONFLICT DO NOTHING` inserted 0 rows and plain duplicate rejected; UPDATE/DELETE blocked.
Not exercised: a real service-role REST insert through `insertIgnoreDuplicates` into this table (would leave a permanent immutable row). The same client path already backs the waiver2/start-sit stores; the first scheduled run is its first real exercise.

## Cron
- Route `/api/cron/matchup2-capture`, schedule `15 14 * * *` in `vercel.json` of deployed commit `f84010e`. Route is live (401, not 404).
- Auth: `authorizeSecret(CRON_SECRET)`. No credentials → 401, wrong bearer → 401 "Invalid credentials" (proves secret is set), query-string secret ignored → 401, POST → 405. Same behaviour as the waiver2 control endpoint.
- Not verifiable with available tools: Vercel's cron registry/enabled flag (no API surface). Configuration verified from deployed source; **first scheduled execution NOT observed**.

## Capture provenance
- Public: only the cron route can write (import graph: writer referenced only by the cron route, store module and a dry-run script). ~30 public `/api/evidence` and `/api/intelligence` requests → 0 rows. Public callers cannot create `LIVE_CAPTURED`.
- Pre-kickoff / post-lock / duplicate semantics: certified test suite (`test/matchup2-capture.test.ts`) green on merged main; in-memory run of the real scheduled job against live inputs = 291 records / 3 leagues / 21 LIVE_CAPTURED / 270 LIVE_POST_LOCK; second run 291 DUPLICATE_IDENTICAL; DB-level enforcement proven above. The scheduled job itself was not invoked against production (no secret; would write permanent rows).

## Prospective gate (production)
Real production rows: 0 captures, 0 outcomes → 0/8 weeks, 0/300 decisions, 0/100 players, 0/4 positions. `NOT READY` is correct. Dry-run numbers above are in-memory only and are not prospective evidence. The gate counts one decision per (player, season, week, scoring fingerprint), earliest eligible record.

## Production isolation
Old production deployment (`dpl_8S52…`, via authenticated share link) vs new (alias), 3 league/manager pairs (bloodline-bowl/supyo29, bloodline-bowl/bijimac, devoted-to-the-game/darthmarker), week 2, 3 rounds interleaved: lineup, start_sit, waivers, matchup, matchup_leverage, positional_needs hashes identical every round; each side self-stable. Method note: timestamp-like fields (`generated_at`, `synced_at`, `age_seconds`, …) are stripped; my first filter missed `source_synced_at`, which caused a transient false `waivers` diff, diagnosed as timestamps only. Import graph: no production decision surface imports `lib/matchup2`.

## Matchup2 evidence in production
QB Hurts vs DAL MIXED; RB Barkley vs MIN UNFAVORABLE; WR Beckham vs MIN FAVORABLE; TE Wright vs CAR UNFAVORABLE (certified examples reproduced). All `validation.ok`, deterministic across repeat calls, one `mctx:` context identity per game. Vintages exposed unblended: FI 2026 w2 LIVE_CURRENT, Player-Scheme 2025 w18 PRIOR_ONLY, Role 2026 w1 LIVE_CURRENT. `composite_adjustment` UNAVAILABLE with reason. 11 `unsupported.*` blocks present (CB, alignment, front, personnel, run-fit scheme, game script, coach history, …). Beckham unit coverage evidence tier INSUFFICIENT (no direction).

## Analysis Book
10 matchup2 topics live (6 player, 4 defense). 99 chapter ids unchanged. `defense.run_fits` PARTIAL, `matchup.coverage_interaction` SOURCE_LAG; CB assignment, defense.front, defense.personnel, defense.slot_boundary UNSUPPORTED. States computed from the deployed-identical tree (no Book route exists).

## Performance
Production warm evidence read ≈0.2 s (cold ≈1 s). Local re-run on a loaded machine (load avg ≈6.5): 15.5 ms/pair (ref 5.6), full team 121 ms (ref 61), full in-memory capture 10–12 s (ref ~4); results identical to certification. Player-Scheme CSV mtime cache verified working (0.05 ms warm vs 7.9 ms cold). Slowdown attributed to host contention; code unchanged; not re-timed on an idle host.

## Tests
2,432 total / 2,428 pass / 0 fail / 4 skipped (identical to certified). `tsc --noEmit` exit 0. eslint on changed/relevant paths: 0 errors, 6 warnings (unused vars).

## Limitations
Player-Scheme prior-season only (through 2025 w18); Football Intelligence week-2 partial; mixed vintages visible; unit coverage often lacks evidence; evaluation baseline production-like, not the historical projection; some archetypes covered synthetically; 0/13 families predictively incremental; promotion gated on future evidence. Store identity is a content hash (includes baseline/lock), so re-captures with changed baselines create additional rows; the gate, not the store, enforces one decision per player-week-fingerprint.

Phase 6: NOT STARTED
