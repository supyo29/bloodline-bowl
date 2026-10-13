# Decision Model Convergence — W2.P2 Prospective Role Shadow Capture & Evaluation: gate certification

Date: 2026-10-13 · Branch `w2p2-role-shadow` (stacked on `intelligence-convergence-w2-p1-role-opportunity` @ `a9ac13c`) · **Not merged, not deployed, no migration applied, capture flag OFF.**

## Summary of verdicts (one per question — they are deliberately not compressed)

| Question | Verdict |
|---|---|
| Implementation completeness | **PASS — REBUILT.** The original W2.P2 work is conclusively absent (section A), so it was rebuilt on the recovered W2.P1 artifacts. |
| Capture pipeline correctness | **PASS** (unit, integration, parity, mutation, and a real-source dry run on live data). Hosted/staging validation: **BLOCKED** (below). |
| Storage durability | **PASS at the SQL-engine level** (27/27 checks on real Postgres semantics; store contract on both implementations). Supabase-hosted validation: **BLOCKED** (no staging database; production migration not authorized). |
| Production isolation | **PASS** (zero production code changed; structural proof; real-context decision parity; auth + flag gates). |
| Prospective evidence readiness | **INSUFFICIENT_EVIDENCE.** 0 prospective rows exist. The pipeline is not running, and it cannot run in production until the Wave 1 chain is merged. |
| G3 statistical qualification | **INSUFFICIENT_EVIDENCE** (`G3_INSUFFICIENT_PROSPECTIVE_EVIDENCE`): no prospective sample exists. This is a valid scientific outcome, not a failure. |
| W2.P3 readiness | **BLOCKED — NO-GO.** Role has no qualified evidence; Wave 1 is not on `main`; Wave 1 staging certification is pending; no W2.P3 specification exists in the repository. |

A technically complete W2.P2 does not imply a promotable Role model. Nothing here changes a production number.

---

## A. Recovered implementation — recovery inventory

**Conclusion: the previously reported W2.P2 implementation was never persisted anywhere recoverable. It was rebuilt, not recovered.**

| Surface searched | Result |
|---|---|
| Git refs (116 refs: local branches, remote branches, tags) — every tree searched for `role-shadow`, `w2p2`, `W2_P2` paths | 0 hits |
| `origin` branches relevant to this program | only `decision-convergence-w1-r2-asset-value-clock` @ `57a6606`, `infra/projection-consumer-convergence` @ `02ae1a7` (merged as PR #36) and `intelligence-convergence-w2-p1-role-opportunity` @ `a9ac13c`. None contains W2.P2 code. |
| Local worktrees | `projection-calibration-phase3` (main checkout, clean), `.claude/worktrees/mcp-connector` (**not touched**), one stale prunable temp worktree |
| Stashes | none |
| Reflogs | no commit, merge or checkout mentions W2.P2 / role-shadow |
| Dangling objects | all 21 dangling commits' trees scanned for the paths above: 0; both dangling blobs scanned for `ROLE_SHADOW_CAPTURE`: 0 |
| GitHub | PRs #1–#40 (none about W2.P2); no forks |
| Claude session transcripts on this machine (`~/.claude`, all projects, `.jsonl`) searched for `lib/role-shadow`, `44/47`, `ROLE_SHADOW_CAPTURE`, `G3_INSUFFICIENT`, `W2.P2` | the only file containing them is the current session (the brief itself) — no earlier session ever wrote that code |
| Other local repos / directories (`~/rosterintel`, `find ~ -name role-shadow`) | nothing |
| Production Supabase (`ijpfjdzmaztofawhwepf`, public schema) | no `role_shadow` table; existing Role tables are Phase 2's `bridge_role_forecasts` (10,802 rows) and `bridge_role_calibration_analysis` (8,964) |

The reported "44/47 tests" result and its "three failures" do not exist in any artifact, so they cannot be identified. The only two failing focused tests at the recovery commit are the pre-existing real-data leakage audits in `test/role-calibration.test.ts` (committed profile CSV rolled to target weeks 5–6, so the audits stopped executing; documented in W2.P1 §3, which replaced them with 2025-data equivalents). Whether those are "the three" is **unestablishable**.

**What was recovered and used:** the W2.P1 pre-registration, frozen models (`FROZEN.json`), SHADOW challenger spec and qualification harness (`a9ac13c`); the Wave 1 substrate it sits on; and the structure listed in the brief as design leads (challenger + control + capture store + coverage + G3 evaluator; a Supabase migration; opt-in capture; pregame restrictions; model-version protection) — each re-implemented. One deliberate design difference from the brief's lead: capture runs as a **separate scheduled job** that observes the production forecast batch, not as a hook inside `lib/weekly/context.ts`. That keeps every production module byte-identical, which makes isolation provable from the import graph rather than argued.

**Branching fact that governs deployment:** `origin/main` contains none of `lib/weekly/forecast`, `lib/weekly/freshness` or the injury model — all live in the 10 unmerged commits of the Wave 1 / W2.P1 chain. W2.P2 therefore stacks on that chain.

## B. Specification reconciliation

No W2.P2 specification exists. Every requirement below is labeled. Reconstructed criteria are in `lib/role-shadow/frozen/g3-prereg.json` (content-pinned) with a provenance label on each item; nothing reconstructed is represented as previously frozen.

| Requirement | Source | Status |
|---|---|---|
| Prospective, production-isolated capture of the Role challenger into final-pregame records | W2.P1 §20 rec. (2); `candidate` spec `required_before_any_promotion` | VERIFIED |
| Evaluate against the REAL source baseline (G3), not the proxy | W2.P1 §2.1, §7, §19, §20 | VERIFIED |
| ≥ 6 real completed weeks | W2.P1 §20 ("≥ 6 real completed weeks") | VERIFIED |
| Frozen challenger = `role-opportunity-challenger-2026.0`; application before the injury model; availability exactly once; missing data neutral | candidate spec | VERIFIED |
| Thresholds T1, T2, T2b, T3, T7, T8 and the numbers in T4/T6/T9 | `scripts/w2p1/prereg.json` | VERIFIED (a test cross-checks every number) |
| Re-specify T4 (relative bias), T6 (adequate pair counts), T9 (permutation control) before looking | W2.P1 §20 | VERIFIED as a requirement; the re-specification itself is **PROPOSED** |
| T5 generalized to N weeks (≥ 75% positive); dropping the VAL clause | architecture | INFERRED |
| T10 STD/PPR robustness | prereg T10 | **NOT_EVALUABLE prospectively** (no STD/PPR league on a frozen fit) — reported, never counted as a pass |
| Eligible population = QB/RB/WR/TE, conditional-active ≥ 3.0, no bye, template-compatible scoring, proven identity | prereg `population` + spec "other scorings need their own frozen fit" | INFERRED (rule R-P1, R-S1) |
| One decision per (player, season, week, scoring) = latest valid pre-kickoff capture | final-pregame semantics (W1.R1) | PROPOSED (rule R-D1; outcome-blind) |
| Look policy (interim never logged; one logged DECISION look per model; repeats refused) | brief ("do not optimize after inspecting") | PROPOSED |
| Rejection of late evidence; DB-clock refusal | brief | VERIFIED (requirement) / implementation new |

## C. Frozen-model integrity

| Artifact | SHA-256 / hash | Where verified |
|---|---|---|
| `scripts/w2p1/candidate/role-opportunity-challenger-2026.0.json` | `696c2a51…cd23b` | byte-identical copy in `lib/role-shadow/frozen/` (test) |
| `scripts/w2p1/FROZEN.json` | `ec313a87…8d3d` | entry-for-entry equal subset in `frozen/w2p1-frozen-models-half.json` (test) |
| `scripts/w2p1/prereg.json` | `aefb0ee4…7967` | equals the hash `FROZEN.json` was frozen against |
| harness / driver | `393f064a…0169` / `3070507c…3d` | equal the hashes `FROZEN.json` recorded (the freeze is intact) |
| challenger config hash (runtime) | `a95fe2c494cee49e4dec475bb176a6bc` | `verifyFrozenIntegrity()` before every capture |
| Role-free control config hash | `327a30acfcba88b5dc8c37576c8a25e0` | same |
| diagnostic full-C2 config hash | `757319e18c28caa4223fd297e770a7e3` | same |
| G3 pre-registration content hash | `b083470af606e521878bb366affce9d5` | evaluator + capture refuse on mismatch |

Verified facts (tests in `test/role-shadow-frozen.test.ts`, 13): the challenger **is** the frozen full C2 minus exactly the intercept and the baseline (`b0`) term (means, sds, coefficients, λ, n_fit equal); the control is baseline-only (`features = [b0]`); the feature table equals the harness's `FEATURES`; shrinkage `MEDIUM 1 / LOW 0.6 / INSUFFICIENT 0` and cap `max(1, 0.25 × conditional-active)` equal both the spec text and the existing Role convention; mutating any single coefficient, mean, sd or λ changes the config hash.

**A finding to carry forward (not a defect):** the challenger spec drops the intercept and baseline term while the control contains them. Offline T2b compared C2-full vs C0 (like for like). The prospective "challenger vs control" contrast is therefore Role-effect minus C0's baseline-drift term. The diagnostic C2-full-vs-C0 contrast (the offline T2b definition) is reported next to it and is never a gate. Further, C0's drift term was fit on the **proxy** baseline; on a real-source baseline it is out of domain and can be worse than doing nothing (the dry run shows QB control deltas of mean |1.70| points). The evaluator therefore flags Q2 `informative: false` whenever the control is itself worse than the champion, and Q2 can never qualify anything alone (Q1, against the champion, binds). A new candidate (different coefficients) must be a new model id; nothing here rewrites the frozen one.

## D. Point-in-time evidence

Every instant must be **strictly before kickoff**: capture time, source observation, forecast composition, Role as-of, Role data cutoff; and the timeline must be coherent (`observed ≤ composed ≤ captured`, `role as-of ≤ captured`). Kickoff is the **earliest** of the champion's clock and the Role clock (a disagreement can only tighten the guard).

- Late evidence is **rejected, not relabeled**: `buildRecord` returns reasons and no record; the run summary counts `rejected_late / rejected_no_kickoff / rejected_incoherent`. `LIVE_CAPTURED` also requires a live-frozen Role forecast; a reconstruction is `HISTORICALLY_RECONSTRUCTED`, can never be eligible, and relabeling attacks fail validation (both directions tested).
- The store refuses a record whose pregame-composed evidence ARRIVES after kickoff (`REFUSED_LATE`) on its own clock; Postgres independently refuses on the **database** clock (trigger) even if the application clock lies — verified on a real engine (section E).
- Arms take no outcome input (the input type has none) and are pure functions of stored fields; a record's arms are replayed at validation (detects tampering and code drift).
- Boundary tests (35 in `role-shadow-record.test.ts`): kickoff-instant capture, post-kickoff capture, observation at/after kickoff, composition after kickoff, Role as-of/cutoff after kickoff, missing kickoff, incoherent timeline, per-player clocks in one week, earliest-kickoff rule, hand-edited late timestamps, content-hash tamper, re-hashed tamper.
- Identity: gsis first, else the Role profile's own sleeper id (unique only); team/position disagreement = identity conflict and skipped (temporal-identity safe); the crosswalk is neither consulted nor repaired (project memory: pagination "fix" would flip 192/228 ids).

## E. Capture durability

Migration `supabase/migrations/20261013180000_role_shadow_captures.sql` — one additive table, `bridge_role_shadow_captures`; no existing object touched. **Not applied anywhere.**

Verified on **real Postgres semantics** (PGlite = Postgres in WASM; `node scripts/w2p2/verify-migration.mjs` after `npm i --no-save @electric-sql/pglite@0.3.2`): **27/27** — applies cleanly and adds exactly one table; idempotent re-apply; valid pregame insert; duplicate id is a silent no-op; UPDATE and DELETE rejected; **late insert refused on the DATABASE clock** (including when the application-supplied `captured_at` is pregame); CHECKs for `captured_at < kickoff_at`, `source_observed_at < kickoff_at`, source observation present, reconstructed-never-eligible, SHADOW_ONLY, `may_influence_production=false`, `record.capture_id = id`, position ∈ QB/RB/WR/TE, id and hash formats, class domain; RLS enabled; `anon`/`authenticated` hold no privileges; exactly two guard triggers; the documented rollback block removes the table and both functions and restores the original table set.

Store contract (`test/role-shadow-store.test.ts`, 24, run through **both** the in-memory store and the Supabase store on the repo's `FakeRest`): insert; idempotent duplicate; 25-way concurrent writers → exactly one row; changed evidence never replaces the old row; no update/delete surface; model-version isolation; tamper/late refusal; late-on-store-clock refusal; DB `P0001` → `REFUSED_LATE`, `23514` → `REFUSED_INVALID`; missing table / 5xx / network error → `ERROR` (never thrown); retry after transient failure inserts once; **restart/redeploy** → a new store instance sees every prior row and re-capturing changes no stored row; 1,203-row paging.

**Residual / blocked:** not exercised against Supabase-hosted Postgres/PostgREST; `TRUNCATE` is not blocked by row triggers (not reachable with the service-role REST path; same property as every other `bridge_*` immutable table).

## F. Production isolation

- **Diff proof.** Versus the recovery commit: 33 files, +4,199/−2. Existing files modified: `next.config.ts` (+1 additive tracing entry), `test/discovery-route-coverage.test.ts` and `test/role-calibration.test.ts` (one allowlist entry each). **Zero changes** under `lib/weekly`, `lib/trades`, `lib/waiver2`, `lib/matchup2`, `lib/scoring`, `lib/canonical`, `lib/leagues`, `lib/providers`, `lib/sleeper`, `lib/projections`, `lib/role-calibration`, `lib/game-distribution`, `lib/orchestrator`, `proxy.ts`, `vercel.json`.
- **Structural** (`test/role-shadow-isolation.test.ts`, 13): nothing under `app/` or `lib/` imports `lib/role-shadow` except the store, the runtime wiring and the cron route; the outcomes loader is reachable from nothing in `app/`/`lib/`; `lib/role-shadow` imports only an allowlist (itself, hashing, team codes, the pure injury-model/forecast-schema helpers) and provably nothing from lineup / start-sit / matchup / waivers / trades / scoring / providers / sleeper client / persistence; no network I/O, no credentials, no direct DB mutation; the import scanner itself is tested (it once missed bare side-effect imports — section K).
- **Behavioral.** The real weekly context and the real lineup / start-sit / matchup / waiver decisions are **byte-identical** with the flag unset vs set, and before vs after an actual capture run over the same context (wall-clock stamps `generated_at`, `source_synced_at` excluded by name; they differ between any two builds). The capture does not mutate its inputs (deep-frozen inputs run clean). Trade evaluation is covered by the import-graph proof (no path to `lib/trades`).
- **Opt-in:** `ROLE_SHADOW_CAPTURE` must be exactly `"1"` (strictness tested for 11 other values). Flag off ⇒ a complete no-op: no context built, no Role forecast loaded, no database call.
- **Fail-safe:** an unavailable research database, a league that will not build, a Role-load failure, one record's write failing — each is counted and reported; nothing throws; no production recommendation depends on it; the audit/eligibility checks are never weakened to achieve this.
- **Access:** the only route is `GET /api/cron/role-shadow-capture`, classified self-guarded by the proxy's `/api/cron/` prefix (no public CORS, no public read), authenticates with `CRON_SECRET` before any work (query-string secrets rejected), and is **not scheduled** by this change. No public route reads the table.
- **Boundary tests of the repo kept intact:** W2.P1's "no production file imports the qualification harness or its frozen artifacts" passes because the frozen configuration ships as reviewed, byte-verified **copies** in `lib/role-shadow/frozen/` (as W2.P1 §15 prescribes); the Role Calibration isolation test's allowlist gained exactly one **filename** (`lib/persistence/supabase/role-shadow-runtime.ts`), following the precedent of the other research crons, and a new test pins that this is the only research-side bridge.

## G. Evaluation results

**Prospective results: none exist** (0 captured rows; capture not enabled). `evaluateG3` over an empty store returns `G3_INSUFFICIENT_PROSPECTIVE_EVIDENCE`, look `INTERIM_DESCRIPTIVE`, no gate evaluated.

**Real-source dry run (live data, no writes)** — merged tree (W2.P2 + current `main`), 2026-10-13 21:51Z, live Sleeper projections and the committed Role inputs for the unplayed week 6 (`docs/evidence/w2p2-real-source-dry-run-2026-10-13.json`):

| | Bloodline Bowl | Devoted | Sporty's |
|---|---|---|---|
| league-wide forecasts | 190 | 202 | 226 |
| records built (all `LIVE_CAPTURED`, all re-validate) | 144 | 158 | 167 |
| rejected late / no-kickoff / incoherent / conflict / ambiguous | 0 / 0 / 0 / 0 / 0 | 0 | 0 |
| scoring on the frozen fit | **yes** | no (PPR, INT −1) | no (PPR, INT −1) |

- 469 records built, **469/469 valid**; second run: **469 × `DUPLICATE_IDENTICAL`** (idempotent on real data); 0 injury-identity mismatches; the Role delta never changed a player's P(active) in this sample.
- **Only Bloodline Bowl is on the frozen fit:** 127 eligible (QB 19, RB 44, WR 47, TE 17), 115 covered (QB 17, RB 40, WR 42, TE 16). The other two Sleeper leagues are stored for coverage reporting but are never eligible. Yahoo leagues are excluded.
- Every join used the **sleeper-id-via-profile** fallback (`join_method` = 469/469): the canonical players carry no gsis id (the known crosswalk gap).
- Challenger deltas (covered, mean |Δ| / max): QB 1.00/3.43, RB 1.86/5.84, WR 1.01/2.29, TE 1.55/3.30 points. **Cap-hit rate: RB 47.5%, TE 50.0%** (QB, WR 0%). Pre-registered gate Q8 requires ≤ 10%; the same tendency appeared offline (RB 33.9%, WR 29.6%). **Expect Q8 to fail for RB/TE regardless of accuracy** unless the cap is reconsidered under a *new* model version.

**Evaluator validation on synthetic evidence (NOT evidence about Role)** — built through the real capture path: a real planted effect with ample data qualifies all four positions for *human review* (never promotion; Q10 `NOT_EVALUABLE`); the same volume with no effect fails Q1 everywhere; a negative effect fails and shows the harm; 3 excellent weeks stay insufficient; Q6 below 100 decided pairs is `INSUFFICIENT_EVIDENCE`, not a fail. Statistics (MAE/RMSE/bias, cluster bootstrap CI, per-week deltas, start/sit decision test) equal the frozen harness's to the last digit under the same seed.

**When could sufficiency be reached? (planning estimate from the dry run's eligible counts — not data).** S2 needs covered decisions with outcomes of QB 120 / RB 300 / WR 300 / TE 300 over ≥ 6 weeks. At the observed ~17 / 40 / 42 / 16 covered per week: QB ≈ 8 weeks, RB ≈ 8, WR ≈ 8, **TE ≈ 19 — unreachable in the 2026 regular season** from one league. With ~13 weeks left (6–18) and deployment not before the Wave 1 chain lands, QB/RB/WR sufficiency is a late-season prospect at best; Q6 (≥ 100 decided same-team pairs) will bind first at QB (~12 pairs per week).

## H. Regression evidence

| | tests | pass | fail | skipped | failing names |
|---|---|---|---|---|---|
| `origin/main` @ `966b51e` | 3,135 | 3,048 | 83 | 4 | 113 |
| recovery tip `a9ac13c` | 3,537 | 3,450 | 83 | 4 | 113 (identical to main's) |
| **this branch (final)** | **3,688** | **3,601** | **83** | 4 | **113 — identical set; 0 new failures** |
| merged tree (branch + `main` @ `966b51e`, trial merge) | 3,738 | 3,651 | 83 | 4 | 113 — identical; 0 new |

151 new tests, all passing: frozen 13, arms 16, record 35, store 24, capture 17, isolation 13, G3 25, CLI/outcomes 8. `tsc --noEmit` clean; `npm run lint` 39 warnings / 0 errors (= baseline); `next build` passes and lists `ƒ /api/cron/role-shadow-capture`.

**The 83 pre-existing failures** (identical on `main`, the recovery tip and this branch) are not W2.P2: missing gitignored `outputs/` artifacts (ENOENT), live-network smoke tests, flag/environment-dependent bridge suites, and the real-data leakage audits W2.P1 §3 documented. They are **not** treated as certification evidence either way.

**Mutation suite** (`scripts/role-shadow-mutation-suite.py`, results in `docs/evidence/w2p2-mutation-suite-2026-10-13.jsonl`): 37 source mutations, one at a time; **36 killed**, 1 **equivalent by proof** (M4: `role_as_of ≤ captured < kickoff` already implies `role_as_of < kickoff`), **0 survivors**, files restored byte-for-byte. Covers every late-evidence check, the identity guard, availability-twice and the linear-shortcut bug, cap, shrinkage, OUT handling, missing-feature-as-zero, store late/idempotency, flag strictness, kickoff-min, identity conflicts, dedupe, sufficiency bypass, version pooling, uncertified outcomes, Q6, hash drift, production importing research, input mutation, record identity, relevance floor, cron auth, DB-late classification, integrity check, look-policy, run log, outcome relabeling, capture-clock order and manager-scoped roster set.

## I. Deployment readiness

State today: migration **not applied**; `ROLE_SHADOW_CAPTURE` **unset**; no cron scheduled; `main` lacks the Wave 1 forecast the capture observes.

**Blockers, in order**
1. Merge the Wave 1 → W2.P1 chain into `main` (10 commits; its own review). **Wave 1 staging certification is still pending** (W2.P1 §1, §19); the "champion" evaluated here is the Wave 1 canonical forecast, which production does not serve yet.
2. Merge this PR (it merges cleanly with current `main`: verified by a trial merge, no conflicts).
3. Apply the migration to **staging**, run `node scripts/w2p2/verify-migration.mjs`-equivalent checks, then production. *Requires explicit authorization.*
4. Set `ROLE_SHADOW_CAPTURE=1` and `CRON_SECRET` (already set) in the target environment. *Requires explicit authorization.*
5. Add the schedule (not included in this PR on purpose): `{ "path": "/api/cron/role-shadow-capture", "schedule": "30 12 * * *" }`. Rationale: a daily run after the 11:10 projection snapshot and before Sunday's earliest (13:30Z) kickoffs; "latest valid pre-kickoff capture" is the decision, so every daily capture before a game is useful. Hobby-plan crons may fire any time within their hour; a run that lands after a kickoff simply rejects those players (by design).
6. First run: `GET /api/cron/role-shadow-capture?dry_run=1` with the bearer secret; check `status`, `totals.counters` (expect `rejected_* = 0`, `built ≈` the dry run's), then a real run; confirm rows with `select count(*) … where capture_class='LIVE_CAPTURED'`; re-run and confirm `DUPLICATE_IDENTICAL`.
7. Weekly: `node --import tsx scripts/role-shadow-g3.ts` (needs `SUPABASE_*`), which reads the store and the calibration ledger, writes `bundle.json` + `report.json` (re-evaluable offline to the identical digest) and enforces the look policy.

**Rollback.** Unset `ROLE_SHADOW_CAPTURE` → the job becomes an immediate no-op (nothing else to change). Remove the cron entry. The table is insert-only research telemetry that no decision path reads; to remove it entirely use the `ROLLBACK` block in the migration header (verified on a real engine).

**Merged-tree check** (branch + current `main`, trial merge, not committed): clean merge; results below.

Full suite on the merged tree: **3,738 tests, 3,651 pass, 83 fail** — the identical 113 failing names as the tip/`main` baselines (0 new); `tsc` clean; lint 39 warnings / 0 errors. The MCP connector (PR #40) and its worktree were not touched; its tracing entry merges alongside this one.

## J. Final decision

See the verdict table at the top. In one sentence each:

- **Implementation completeness — PASS (rebuilt).** The original is unrecoverable; the rebuild is complete, tested and review-ready.
- **Capture pipeline correctness — PASS.** Real-source dry run: 469/469 records valid, 0 rejections, idempotent; hosted/staging validation **BLOCKED**.
- **Storage durability — PASS (engine-level) / BLOCKED (Supabase-hosted).**
- **Production isolation — PASS.**
- **Prospective evidence readiness — INSUFFICIENT_EVIDENCE.** Zero rows; cannot start before Wave 1 lands and the migration/flag are authorized.
- **G3 statistical qualification — INSUFFICIENT_EVIDENCE.** The honest, expected outcome today.
- **W2.P3 readiness — BLOCKED (NO-GO).**

## K. Defects found and disposition

| # | Defect | How found | Disposition |
|---|---|---|---|
| 1 | The injury model is **not linear** in the source value: a Questionable player's P(active) depends on a role tier derived from `source_points` (threshold 8), so a Role delta can change availability; my first arms used a linear shortcut | parity sweep vs the frozen harness (2,000 randomized cases) | Fixed: arms re-run the production model on the adjusted value with the champion's own evidence; exact identity guard; regression test + mutations M9/M10 |
| 2 | Capture clock read **before** the league contexts were built → every record "composed after capture", whole run rejected | real-source dry run | Fixed; test + M36 |
| 3 | Rostered set taken from `ctx.all_rostered` (the requesting **manager's** 16 players) instead of the league's ~190 | real-source dry run | Fixed (`leagueRosteredIds(snapshot)`); test + M37 |
| 4 | Isolation scanner ignored bare side-effect imports (`import "x"`) | mutation M26 survived | Fixed; the scanner is now itself tested |
| 5 | A gate lacking data (Q6 < 100 pairs) was mapped to `G3_FAIL` | synthetic scenario review | Fixed → `G3_INSUFFICIENT_PROSPECTIVE_EVIDENCE`; test |
| 6 | "Beat the control" is easy when the control is out-of-domain and harmful | null-effect synthetic run (Q2 passed with no signal) | Mitigated: Q2 flagged `informative:false`; never qualifies alone; documented |
| 7 | Two repo boundary tests failed (W2.P1 "no import of frozen artifacts"; Role Calibration importers) | full-suite comparison | Fixed without weakening: byte-verified copies in `lib/`; one filename-pinned allowlist entry |
| 8 | My own mutation run was contaminated by a file I added mid-run | M16+ "killed" by an unrelated failure | Re-run from a clean tree; final run clean |
| 9 | `next.config.ts` tracing entry would conflict with `main` | trial merge | Moved so the merge is clean |

Not fixed (out of scope, pre-existing): the 83 baseline failures; the two real-data leakage audits (W2.P1 §3); the crosswalk gsis gap (do not repair casually).

## L. Remaining risks and limits

- **Wave 1 is not on `main`** and its staging certification is pending; W2.P2 cannot run in production until both are resolved.
- **One league** is on the frozen fit; QB penalty rules in Bloodline Bowl's scoring (`pass_sack`, `pass_int_td`) and `fum_rec` are **unmodeled** by the HALF fit (listed on every record for stratification, not silently ignored).
- **Expected Q8 failure** for RB/TE (cap-hit ~48–50% vs ≤ 10%) and **TE sufficiency unreachable** in 2026.
- All Role joins rely on the sleeper-id fallback; Yahoo leagues excluded; free agents are not captured (rostered only, like the final-pregame record).
- Arm expected points are cent-quantized exactly like the champion (the production model rounds to 0.01); ΔMAE thresholds are ≥ 0.03, well above that noise.
- If the injury-model version changes, stored arms stop being replayable (validation then trusts the content hash); the evaluator should be re-run with that in mind.
- Hosted Postgres/PostgREST behavior is unverified until a staging database exists.

## M. Reproduce

```bash
node --import tsx --test test/role-shadow-*.test.ts            # 151 tests
python3 scripts/role-shadow-mutation-suite.py                  # 37 mutations
npm i --no-save @electric-sql/pglite@0.3.2 && node scripts/w2p2/verify-migration.mjs   # 27 checks on a real engine
node --import tsx scripts/role-shadow-g3.ts --records r.json --outcomes o.json --out out/ --no-log        # evaluate any bundle offline
```
