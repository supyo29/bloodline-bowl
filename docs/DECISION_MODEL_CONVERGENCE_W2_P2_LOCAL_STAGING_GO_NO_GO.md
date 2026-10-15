# W2.P2 local-staging validation — GO / NO-GO FOR PRODUCTION SHADOW CAPTURE

Date: 2026-10-13 · Stack under test: Wave 1 → W2.P1 → W2.P2 as merged on `intelligence-convergence-w2-p1-role-opportunity` @ `f4e84b1`, plus the fixes in this branch (`w2p2-local-staging-validation`). Environment: **free local Docker Supabase only** (Postgres 17.11, Kong 2.8.1, PostgREST v16.4, CLI 2.120.0, colima). **Nothing production was touched.**

## DECISION

| | |
|---|---|
| **GO / NO-GO for production shadow capture today** | **NO-GO** |
| W2.P2 code itself | **READY** — no open P0/P1 in W2.P2; two production-build/restart defects were found and fixed here |
| Why NO-GO | `main`/production does not contain Wave 1 (the canonical forecast the capture observes); Wave 1's hosted-staging certification is not complete; production migration/flag/cron are unauthorized. These are prerequisites *outside* W2.P2 |
| Becomes GO when | the conditions in §8 are met |

## 0. Safety record (what was and was not done)

| Requirement | Result |
|---|---|
| no Supabase remote link | `supabase/.temp/project-ref` never existed in the staging worktree; `supabase link` never run; `run-all.sh` refuses to start if it exists |
| `supabase/config.toml` project id | replaced locally with `bloodline-wave1-w2-local-staging` (uncommitted, never staged); the file still names the production ref in git — the orchestrator refuses to run while it does |
| production ref `ijpfjdzmaztofawhwepf` never a migration/DB target | never used by any command in this phase; the harness `guard.ts` aborts (exit 99) on any non-loopback `SUPABASE_URL`, any `*.supabase.co/.com` value, the prod ref or `SUPABASE_PROJECT_REF` in the environment |
| no production URL/service key in the environment | verified empty before every phase; the Next server under test received a **minimal explicit env** (PATH/HOME, local URL, local demo key, local cron secret, flag) |
| stop if anything resolves remotely | nothing did. **Egress audit** of a real capture run: `GET api.sleeper.app` 58, `GET site.api.espn.com` 7, `GET 127.0.0.1:54321` 30, `POST 127.0.0.1:54321` 456 — **no non-GET traffic to any external host, no hosted Supabase, no Yahoo** |
| no migration/flag/cron/merge/deploy on production | none |
| disclosure | before your approval message, this turn's discovery made two read-only **control-plane** calls (`list_projects`, `list_branches` on the Supabase account — metadata only, no SQL) and one rejected (403) Vercel env-var listing. No data plane was touched. |

## 1. Local Supabase / PostgREST — **PASS** (71 checks PASS, 0 FAIL, 1 documented P2 finding)

Everything below is reproducible from scratch with `bash scripts/staging-local/run-all.sh` (3.6 minutes; evidence in `docs/evidence/w2p2-local-staging-*.json`).

| Phase | What ran | Result |
|---|---|---|
| Chain | all 17 Wave 1 → W2.P1 migrations from an empty database, then the W2.P2 migration applied **separately** (`supabase migration up --local`), and again all 18 at once | applies cleanly both ways |
| PostgreSQL assertions | the repo's own `w1r1-pg-compat/assertions.sql` (real production-built fixtures), idempotent re-apply of both Wave 1 migrations | **ALL PASSED** (the shell driver is skipped on macOS; this ran it against the container) |
| Stage 1 (chain only, no Role-shadow migration) | 33 tables + 3 views: exist, RLS on, exposed by PostgREST to the service key; code-vs-schema drift scan; **differential tests** of `SupabaseFinalPregameStore` (8-step sequence incl. confirm / change / older-observation / at-kickoff / post-kickoff / incoherent / idempotent) and `SupabaseSourceObservationStore` against their in-memory oracles; 120-player bulk; 20 concurrent writers; PATCH/DELETE via HTTP; hindsight row POSTed over HTTP | **18 PASS**, 0 FAIL, **1 P2 FINDING** (below) |
| Stage 2 (Role-shadow migration applied) | table/RLS/privileges over HTTP; INSERT; idempotent duplicate; **25 concurrent writers** → exactly 1 insert; **PATCH, DELETE and the `merge-duplicates` upsert bypass all refused**; **post-kickoff refusal on the database clock** (trigger `P0001` through PostgREST → store `REFUSED_LATE`, even with the app clock frozen "pregame"); 4 CHECK violations (`23514`) over HTTP; model-version isolation; **2,300-row paging against the real server row cap**; **restart of the DB and PostgREST containers**; **database outage visibility**; recovery by retry (exactly-once); wrong-key visibility; jsonb round-trip **re-validation** | **20 PASS**, 0 FAIL |
| Real HTTP route (`next start`, minimal env) | auth (401 ×3), flag unset → `DISABLED` no-op, flag `"true"` → still `DISABLED`, `?dry_run=1` writes nothing, real run #1 inserts every built record, run #2 and a **server restart** insert **nothing** (456 × `DUPLICATE_IDENTICAL`), every stored row pregame by the **database's own** insertion time, no silent pooling of leagues | **11 PASS**, 0 FAIL |

**Capture-failure visibility (requirement 7):** with the table missing (before the migration) a real capture over HTTP returned `PARTIAL` with `failures = 456` and `by_status = {ERROR: 456}` (not `OK`, nothing thrown). Database stopped mid-run → `ERROR` per write, `PARTIAL`; restart + retry → each capture inserted exactly once. Wrong credentials → `ERROR`.

**Immutability / idempotency / isolation (requirement 7):** see stage 2 above; additionally the table row count and a content checksum are unchanged by every refused write.

## 2. Provider / live capture — **PASS** (Sleeper leagues); Yahoo **BLOCKED**

Real Sleeper projections/rosters/schedule and ESPN kickoffs for the not-yet-played week 6 (next kickoff: TNF 2026-10-16 00:15Z, 49.7 h away), read-only, into the local database:

| | Bloodline Bowl | Devoted | Sporty's |
|---|---|---|---|
| league-wide forecasts built | 190 | 202 | 226 |
| Role Shadow rows stored (`LIVE_CAPTURED`, all re-validate) | 140 | 154 | 162 → **456 total** |
| on the frozen HALF fit / **eligible** | **yes / 127** | no / 0 | no / 0 |
| Wave 1 final-pregame revisions stored | 165 | 181 | 195 → **541** |

- Wave 1 persisted through real PostgREST: 541 revisions + 541 pointers (one per player-week, no dangling), 3 projection snapshots / 9,906 snapshot rows, 1 source observation / 3,302 rows (header `row_count` equals stored rows); every revision satisfies `observed ≤ composed < kickoff` by the database's arithmetic.
- **Per-player kickoff exclusion on the real schedule** (injected capture clocks): 456 capturable decisions now → 420 after the TNF kickoff → 164 after the Sunday-early window → **0** after the last game.
- Other results: real **bye** players are exactly 0 for the week yet keep underlying/asset value (25 byes, 22 with value); **Questionable** relevant players are discounted exactly once (e.g. source 11.94, conditional 13.97, expected 9.91, P(active) 0.709); **Out** is a known zero distinct from a bye; an **Out+bye** player is `BYE_VERIFIED` with his Out status preserved (the schema's rule, verified).
- **Not exercised (blocked):** Yahoo leagues (no OAuth locally) — see §5.

## 3. Wave 1 certification status — **LOCAL STAGING: PASS WITH LIMITATIONS; HOSTED STAGING CERTIFICATION: NOT DONE → Wave 1 is NOT certified for production**

Mapped to the two staging checklists Wave 1 itself published (W1.R2 §20, W1.R1 §19):

| Checklist item | Status |
|---|---|
| Apply the P4 and R1 migrations to staging; repo's `assertions.sql` | **PASS (local)** — real PG 17; idempotent re-apply |
| Reload the PostgREST schema cache after migration | **PASS (local)** — `supabase migration up` made the new table servable immediately (the CLI reloads it). Hosted: run `NOTIFY pgrst, 'reload schema'` and verify |
| Read-only smoke, all five leagues PASS | **PARTIAL** — 3 Sleeper leagues `PASS_WITH_LIMITATION` (K/DST approximated), one shared source observation across all five. **Yahoo ×2: BLOCKED** — league scoring not applied (smoke prints `scoring_fingerprint: 0`, no OAuth) yet labels it `PASS_WITH_LIMITATION` (P3: the label overstates it) |
| Real pre-kickoff window: `final_pregame_capture` CAPTURED, RECORDED > 0 | **PASS** — 541 revisions recorded from live fetches |
| A post-kickoff request leaves the frozen revision unchanged | **PASS with a limit** — a request composed with an injected post-kickoff clock submits 48 fewer candidates and leaves revisions + pointers **byte-identical**. A *real wall-clock* crossing of a kickoff has not been observed (next: Thu 00:15Z) |
| Spot-check waiver drops and trade valuation against a real injured and a real bye star | **PARTIAL** — injured-star and bye-star forecast/asset semantics verified on real data; the **waiver-drop and trade-valuation engines were not run** (free-agent pool `UNAVAILABLE` by design; trade engine not exercised) → **NOT RUN** |
| Five-league *live* validation | 3 of 5 live; Yahoo ×2 BLOCKED |
| Active-scoring-window shadow | **NOT RUN** — no game is in progress for 49 h |

## 4. W2.P2 capture status — **READY; not running anywhere**

Capture, storage, evaluation, isolation and failure behavior are verified end to end on the real HTTP path. The G3 evaluator reads the local store and the calibration-ledger view through PostgREST: 456 records read back with **0 invalid** (the jsonb round trip holds), 127 eligible decisions awaiting outcomes → `INTERIM_DESCRIPTIVE / G3_INSUFFICIENT_PROSPECTIVE_EVIDENCE`. The frozen configuration verifies **inside the real production bundle** (after fix F1), and Vercel's file trace for the route includes every Role data file (`.nft.json`, 142 files; no `scripts/w2p1` path).

## 5. Five-league matrix

| League | Provider | Architectural treatment verified | Live provider data | Role Shadow rows | G3-eligible |
|---|---|---|---|---|---|
| Bloodline Bowl | Sleeper | built, captured, stored | yes | 140 | **127 (only league on the frozen HALF fit)** |
| Devoted to the Game | Sleeper | built, captured, stored | yes | 154 | 0 — PPR, INT −1 (`NO_FROZEN_FIT`) |
| Sporty's Alumni | Sleeper | built, captured, stored | yes | 162 | 0 — PPR, INT −1 (`NO_FROZEN_FIT`) |
| Maclin on Chick's XVI | Yahoo | **explicitly SKIPPED with a reason** in every run summary (not failed, not silent) | **BLOCKED** (no OAuth) | 0 | 0 |
| Rogers Park | Yahoo | same | **BLOCKED** | 0 | 0 |

No pooling: in the database, `eligible = true` rows exist only for Bloodline Bowl with template scoring; zero eligible rows for any other league or any non-template scoring.

## 6. Findings

**P0: none.**

**P1 (all fixed in this branch; each has a regression test + mutation):**
| # | Finding | Found by | Disposition |
|---|---|---|---|
| F1 | **Production build altered the frozen coefficients.** Turbopack's JSON importer is not bit-exact for floats (e.g. `0.9240314943585303` → `…304`, 1 ULP). Invisible to every `tsx` test; in the built server the integrity guard refused to run (`INTEGRITY_FAILURE`). The guard was *right* (fail-closed) but the capture could never have run in production | real `next start` HTTP test | **Fixed.** Frozen numbers ship as generated TypeScript literals (`scripts/w2p2/gen-frozen-ts.mjs`); tests prove **bit-for-bit** equality with the byte-verified JSON and the W2.P1 originals; the built bundle now carries the exact values |
| F2 | (earlier phase) capture clock read before contexts were built → every record rejected | real-source dry run | fixed (previous PR) |
| F3 | (earlier phase) manager-scoped roster used instead of the league's | real-source dry run | fixed (previous PR) |
| F4 | (earlier phase) injury model non-linear in source points | harness parity | fixed (previous PR) |

**P2:**
| # | Finding | Disposition |
|---|---|---|
| F5 | **Record identity included fetch-instant lineage ids** → after any restart/cold start every record of an unchanged belief was minted again (456 duplicates). Evaluator would still dedupe, but storage and the idempotency claim were wrong | **Fixed.** Identity = belief content; re-observation of an identical belief is a no-op keeping the earliest valid observation; 3 new tests + 2 mutations |
| F6 | **Older tables never revoke Supabase's default `anon`/`authenticated` grants** (8 tables: snapshots, ledger, capture runs, published pointer, publication audit, Yahoo connections, Start/Sit captures). Protection is RLS-without-policies alone (verified: zero policies, roles lack `BYPASSRLS`, anon reads/writes nothing). The W2.P2 table *does* revoke. **Production's actual grants were not inspected (untouchable); verify with a read-only advisor before enabling** | **OPEN** (pre-existing; not W2.P2). A one-line `REVOKE` migration is the fix |

**P3:** shared `jsonResponse` adds `Access-Control-Allow-Origin: *` to cron routes' 401s (pre-existing; no data in the body); the five-league smoke labels Yahoo `PASS_WITH_LIMITATION` with 0 scoring rules applied; `bridge_intelligence_freshness_history` stays empty on the request path (it is written by the Phase 9 audit cron — expected).

## 7. Remaining blockers

1. **Wave 1 is not on `main`/production.** It is the hard dependency; deploying it is its own decision (not authorized here) and its hosted staging certification is incomplete (§3).
2. Wave 1 items not yet done anywhere: Yahoo live (OAuth), waiver-drop and trade-valuation spot checks, active-scoring-window shadow, a real wall-clock kickoff crossing.
3. Hosted-environment unknowns this local stack cannot answer: hosted PostgREST/Postgres versions (local PostgREST v16.4, PG 17.11), Vercel serverless cold starts and **Hobby cron jitter** (a run landing after a kickoff will correctly reject those players), actual production grants (F6).
4. Production migration, `ROLE_SHADOW_CAPTURE=1`, and the cron entry — all unauthorized by design.
5. Not a blocker for capture, but for the *gate*: only one league is on the frozen fit; expected G3 failures for RB/TE cap-hit and TE sufficiency (unchanged from the certification report).

## 8. What flips this to GO

All of: (a) Wave 1 merged and deployed to production under its own authorization, with the Yahoo/waiver/trade/active-window items closed or explicitly accepted; (b) a **hosted** pre-production dry run of this exact sequence (migration → `?dry_run=1` → real run → re-run idempotency) on a non-production hosted Supabase/Vercel preview — the harness runs unchanged against any such target once `guard.ts` is pointed at it; (c) production grants inspected read-only and F6 decided; (d) explicit authorization for the migration, the flag and the cron entry. Recommended first production step after that: the migration + `?dry_run=1`, then one real run, then the daily schedule.

Suggested follow-up that needs no authorization: re-run `bash scripts/staging-local/run-all.sh` (or phases 2–3) **across Thursday's 00:15Z kickoff** to observe a true wall-clock crossing.

## 9. Changes in this branch / reproduce

Code: frozen configuration as exact TS literals + generator; record identity; per-league skip reporting; local-only staging harness (`scripts/staging-local/`); evidence (`docs/evidence/w2p2-local-staging-*.json`). Tests: **3,693 total, 83 failing — the identical 113-name baseline set (0 new)**; `tsc` clean; `npm run lint` 39 warnings / 0 errors (= baseline); `next build` passes; mutation suite 39 mutants: 38 killed, 1 equivalent by proof, 0 survivors.

```bash
sed -i '' 's/^project_id = .*/project_id = "bloodline-wave1-w2-local-staging"/' supabase/config.toml   # uncommitted, local only
npm ci && npx next build && bash scripts/staging-local/run-all.sh
```
