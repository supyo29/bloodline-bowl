# W2.R1 current-stack integration — certification record (2026-10-14)

Branch `intelligence-convergence-w2-r1-dynamic-value-gameplan` merged with `origin/main` @ `77b3ab6` (merge commit `80b5c4c`; history not rewritten). Conflicts: `package.json` only (kept `test:live` / `test:recertify:player-scheme` and main's `storage:audit`; MCP deps from main). Auto-merged cleanly and re-verified: `vercel.json` (`ignoreCommand` kept; `yahoo-health` cron from the Yahoo stack retained), `next.config.ts` (main's `/api/mcp` tracing includes + `/mcp` rewrite kept, the W2.P2 role-shadow include kept), `lib/public-api/policy.ts`, `lib/discovery.ts`, `test/discovery-route-coverage.test.ts`; main's latest football-intel / role-calibration / intelligence-history data is untouched.
Adjustments required by main's infrastructure guards (none relaxed): W2.R1 view route 120 → 60 s; `/api/w2r1/manifest` and `/api/yahoo/health` got explicit `maxDuration = 60`; `/api/cron/yahoo-health` 60 → 300 and `role-shadow-capture` (already 300) were registered as documented crons in `test/function-duration-classes.test.ts` + `docs/VERCEL_FUNCTION_STORAGE.md`. Still exactly two duration classes (60/300).

## Gates
| Gate | Result |
|---|---|
| Full suite (`npm test`) | 4098 tests: 4093 pass, 1 fail (pre-existing on `origin/main`, below), 4 skipped |
| TypeScript / lint / production build | clean / 0 errors (43 pre-existing warnings) / pass |
| Frozen-artifact integrity (`s7_verify_frozen.ts`) | intact (`FROZEN.json` `3685aa7f…`) |
| Function-storage audit (clean `git archive`, `vercel build --prod`, `scripts/function-storage-audit.mjs`) | **OK**: 6 physical lambdas, 554.4 MB uncompressed (ceiling 600), largest 149.5 MB (< 80 % of 250), 141 MB gz; durations 60/300 only; no whole-project tracing; no forbidden caches; required files present (main was 544.8 MB; +9.6 MB = the W2/W2.R1 code and data) |
| Pre-existing failure on main | `book-ready-history-store.test.ts` "writer is idempotent / append-only" (served state `fi:2026:w05` not yet preserved by the snapshot workflow) fails identically on `origin/main` @ `77b3ab6` |

## Protected preview vs production (read-only MCP tool calls through `vercel curl`)
Preview = this branch redeployed with the production Yahoo/Supabase variables exposed for ~78 s only (scope restored to production-only; verified), compared with the current production deployment. Leagues: Bloodline Bowl (`supyo29`), Devoted to the Game (`darthmarker`), Maclin on Chick's XVI (`justin`), Rogers Park (`john`).
* Every W2.R1 view (`roster`, `dst`, `upside`, `qualification`, `add`) answered `OK` for all four leagues; current rosters, verified market state (Yahoo FRESH, Sleeper UNKNOWN freshness), projections, availability, Dynamic VOR (16/16/17/15 roster players), D/ST components and per-component qualification states are present. The weekly MCP analysis carries the `w2r1` block (Devoted: `QUALIFIED_SHADOW`, 28 D/ST rows replaced, capture week 6; Maclin: 28; Rogers Park `EXPLORATORY_POST_DEFECT`, 0; Bloodline `DIAGNOSTIC_ONLY`, 0).
* D/ST influence is isolated to qualified leagues: Devoted's lineup D/ST projection is 6.66 (W2.R1) vs 8.07 (production); Rogers Park / Bloodline D/ST values are unchanged (Bloodline 8.98 = 8.98).
* Differences in non-D/ST slots (e.g. Devoted FLEX, Bloodline WR DJ Moore 10.38 vs 12.51) come from the **Wave-1 canonical, injury-aware forecasts that main does not yet contain** (this branch stacks W1 → W2.P1/P2 → Yahoo Market State → W2.R1), not from W2.R1; Yahoo leagues go from all-null lineup projections and `UNAVAILABLE`/`NOT_READY` waivers on production to fully projected lineups and `AVAILABLE` waivers (the Yahoo identity-bridge fix + Yahoo Market State).
* No fantasy write: every call was a GET or a read-only MCP `tools/call` (all tools declare `readOnlyHint`), and no write code path exists in W2.R1 (hard tests).
* Latency (preview, cold-ish): W2.R1 views 1.9–2.8 s (Sleeper), 4.2–8.7 s (Yahoo); lineup 7–12 s, weekly analysis 6–10.6 s.

## Migrations
**No migration was applied.** The W2.R1 migration (`20261014120000_w2r1_prospective_captures.sql`) is not required by the runtime (nothing reads or writes it). **However, production lacks three migrations the merged Wave-1/W2 code expects:** `20261008120000_projection_freshness_w1p4`, `20261009120000_w1r1_final_pregame_revisions` (table `bridge_final_pregame_forecasts`) and `20261013180000_role_shadow_captures`. Runtime effect today (observed on the preview): every weekly context logs the warning `final_pregame_capture_failed … 404 [PGRST205]` and skips persisting W1 calibration evidence; analysis is unaffected. Applying them is a separate decision (they only enable calibration/shadow persistence) — not done.

## Mutation suites (final)
W2.R1 103/103 after the final test restoration (101 + W84/W94 re-killed; no survivors); Yahoo market 55/56 (Y36 pre-classified equivalent); W1.R1 9/9; role-shadow 38/39 (M4 pre-classified equivalent). Not killed and unrelated to this change (identical before the integration; their target files are untouched here): W1.R2 M2b and M26, W2.P1 M3, W1.P4 M4 (anchor drifted: `&gt;` entity in the suite source).
