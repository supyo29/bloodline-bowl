# Intelligence Modernization — Phase 3.5C
## Book-Ready Intelligence Retrofit

Branch `intelligence-modernization-phase3-5c-book-ready-retrofit`. **Not merged, not deployed, not tagged.** Additive and read-only: no model, artifact, scoring, lineup, Start/Sit, waiver, matchup or trade value was changed. Contract version `book-ready-evidence-2026.1`.

## 1. Starting state
Branch cut from `main` after the Phase 3.5B merge. `origin/main` drift checked at every checkpoint (none at Checkpoint E; the FI daily bot commits to `main` and is expected to drift later). Frozen: Phase 1 contracts, Phase 2/3 model logic, `ri-startsit-2026.1` (sha256 `85d2ddd5…b293`, pinned by test), Player-Scheme `player_scheme_version` and `content_identity.served_content_id`.

## 2. Scope and non-goals
Delivered: common EvidenceBlock contract, vocabulary, unit registry, identity classes, temporal identity, immutable history store, per-family converters, unified query layer, `/api/evidence`, registry extension, tests. **Not built:** the Analysis Planner (3.5D), Phase 4, any modeling change, any player-team temporal identity (Phase 7).

## 3. Registry (single, extended)
`docs/intelligence-surface-registry.json` → `intelligence-surface-registry-2026.2`. Every one of the 14 surfaces gains a `book_ready` block (query topics, capability state, history class, comparison populations, refresh policy, phase refs). No second registry. `test/book-ready-registry.test.ts` checks declared topics ↔ implemented `TOPICS` in both directions.

## 4. EvidenceBlock contract (`lib/book-ready/schema.ts`)
One block = one metric for one subject at one temporal identity: value + unit, origin (`source_class` preserved, `analysis_class` normalized), independent axes, freshness, lineage, limitations, optional history / comparison / change / components / relationships / chart hints. `validateEvidenceBlock` enforces the rules (non-available blocks carry no value and a reason; descriptive/shadow never predictive; CONDITIONAL declares its condition; SOURCE_CONFLICT states limitations; comparison populations explicit; transitions carry no numeric delta; significance only if model-supplied).

## 5. Vocabulary and independent axes
Analysis classes: OBSERVED, MODELED, PROJECTED, CONDITIONAL, DESCRIPTIVE, SHADOW, RECONSTRUCTED, UNAVAILABLE, UNSUPPORTED, SOURCE_CONFLICT. Model confidence, sample support, freshness, deployment and predictive class are separate fields. Player-Scheme `evidence_class` maps to sample support, never confidence. Schedule `value_confidence = ROS_CONTEXT_ONLY` is a *context flag, not a grade*: no confidence is asserted and a limitation says so (found and fixed by the decision-fixture tests).

## 6. Units and scale
Explicit registry (`units.ts`); unknown keys throw; nothing inferred from names; nothing clamped. Legitimately >1: QB snap share, inheritance ratios. Legitimately negative: air-yards share. FI percentile orientation is per-metric (VALUE_ORIENTED vs INVERTED_VALUE). FI `modeled` is a deviation from league mean, raw kept as a component. `off_proe` is percentage points. Tested against every served Role/FI value.

## 7. Identity quality
RESOLVED / PARTIAL / PLACEHOLDER (`XX`/blank position, id-only) / UNRESOLVED. Placeholder Player-Scheme rows stay queryable with explicit limitations; nothing is invented.

## 8. Source-native categories
Raw category text preserved (`UNDER CENTER`); normalization only where verified. FTN numeric `RAW_*` read codes are `SOURCE_CONFLICT` with no first/second/third-read mapping.

## 9. Predictive-status normalization
PREDICTIVE → SHADOW_PREDICTIVE unless deployment is PRODUCTION_ACTIVE; NOT_PREDICTIVE → EXCLUDED; compound `off:X|def:Y` takes the conservative side; descriptive never becomes `*_PREDICTIVE`.

## 10. Temporal identity
`as_of`, `through_week`, `point_kind` (POINT_IN_TIME_STATE / CURRENT_UNSNAPSHOTTED / SCENARIO / CURRENT), `as_of_kind` (PUBLISHED_STATE vs CURRENT_SNAPSHOT vs SCENARIO_INPUT), `week_state`, `snapshot_id`. `player_team_temporal_identity` is stamped `NOT_MODELED_UNTIL_INTELLIGENCE_MODERNIZATION_PHASE_7` on every block.

## 11. Refresh cadence decision
FI daily (existing workflow). Role weekly after a complete NFL week (heavy R build; manual runbook; lag surfaced as `freshness.refresh_lag_weeks`, reported in `capabilities.refresh_status`). OPP weekly after Role. Player-Scheme seasonal (content-change snapshots). Staleness is a *freshness fact*, kept separate from availability.

## 12. History classes and store
`data/intelligence-history/` — append-only `manifest.json` + content-addressed gz objects, `verifyHistoryStore` + tamper detection. Policy COMPLETE_WEEK (FI/Role/OPP) or CONTENT_CHANGE (Player-Scheme). Snapshot id `surface@version#content12`. Backfill only from genuinely published git states. Current store: 9 entries (4 FI week-1 COMPLETE revisions, 3 Role, 1 OPP, 1 Scheme), 4.4 MB, verifies clean. Classes: FI = RECONSTRUCTABLE_AS_OF (genuine published states); Role = one preserved week plus per-game native observations; OPP = UNSUPPORTED (conditional scenarios); Player-Scheme = CURRENT_ONLY (cumulative, PRIOR_ONLY through 2025).

## 13. Deltas
Change is computed only against the previous *preserved* state, with the prior snapshot id named; transitions (categorical) carry no numeric delta; no significance unless the model supplies one. Test: with two differing synthetic snapshots each week reads its own content.

## 14. Comparison contract
Comparisons are opt-in and always name an explicit population (`NFL_WR`, `<TEAM>_WR`, `NFL_OFFENSE_TEAMS`, `NFL_DEFENSE_TEAMS`) with n, season, rank/of and percentile with orientation. Percentiles on roster-health are converted to 0–1 only when a population size is supplied; otherwise none is fabricated.

## 15. Decomposition and relationships
Raw values, EWMA horizons, opportunity totals, OPP trace weights and beneficiary/vacated/residual roles exposed as components. Relationship types UPSTREAM_OF, DEPENDS_ON, DESCRIBES, DERIVED_FROM, COMPARABLE_TO, CONDITIONAL_ON. OPP blocks are CONDITIONAL, declare CONDITIONAL_ON + DEPENDS_ON (Role), keep the Phase 2 observed role as a separate OBSERVED component, and never estimate the probability of the condition.

## 16. Availability contract
AVAILABLE, UNAVAILABLE, NOT_APPLICABLE, HISTORY_NOT_SUPPORTED, NOT_YET_REFRESHED, SOURCE_CONFLICT, INSUFFICIENT_SAMPLE, UNSUPPORTED_COMPARISON, EXPECTED_SOURCE_LAG, CURRENT_ONLY — never collapsed. Waivers stay UNAVAILABLE per the readiness contract; trade evaluation is UNSUPPORTED through GET (needs a POST body).

## 17. Retrofit by surface
FI (team metrics, player usage), Role (profile, change), OPP (scenario), Player-Scheme (QB progression / spatial / formation, defense coverage), Start/Sit shadow, Matchup, roster health, schedule planning, waiver and trade foundations. Decision converters run over frozen real production responses (`test/fixtures/book-ready/`, bloodline-bowl/supyo29 week 2) and are verified non-mutating.

## 18. Query layer and route
`lib/book-ready/query.ts`: 15 topics; `getEvidence`, `getCapabilities`; `MAX_BLOCKS = 400`; per-block validation; `performance` (ms, bytes, cost class). `GET /api/evidence?topic=…&params[&history=1][&comparisons=1]` or `?capabilities=1`. History and comparisons are opt-in; ordinary recommendation endpoints are untouched. Discovery lists `book_ready_evidence`. No planner.

## 19. Performance and storage
Local read-only measurement (real artifacts): 0–70 ms per request (first call warms CSV cache), payload 6–150 KB. `fi.team_metric` KC with history+comparisons: 20 blocks, 150 KB, largest case. **Limitation:** lineage is repeated on every block (dominant payload cost); a lineage-dedupe/compact mode is a recommended follow-up. Storage estimate ~12–17 MB per season at current cadence; 4.4 MB now.

## 20. Phase namespaces
INTELLIGENCE_MODERNIZATION_PHASE, TEAM_MANAGEMENT_PHASE, TRADE_ENGINE_PHASE, FOOTBALL_INTELLIGENCE_PHASE, BRIDGE_REALTIME_STATE_STAGE; `formatPhaseRef` prevents "Phase 7" ambiguity.

## 21. Tests
`npm test`: **2197 tests, 2193 pass, 0 fail** (4 pre-existing skips). New: `book-ready-contract`, `-history-store`, `-evidence` (15), `-decision` (5), `-isolation` (4), `-registry` (4). `tsc --noEmit` clean; eslint: 0 errors (3 unused-parameter warnings in new files). R suites unaffected: no R file, model artifact or lib data file changed in this branch (`git diff origin/main...HEAD -- analysis '*.R' lib/**/data` empty).
Two existing text-scan isolation tests (`football-intel-read`, `startsit-capture-integrity`) now skip `lib/book-ready/`, which observes those surfaces read-only; `book-ready-isolation.test.ts` separately enforces that only `app/api/evidence/route.ts` imports it and that it performs no writes/network.

## 22. Live and production validation
- Local read-only validation across QB/RB/WR/TE profiles, FI team (offense and defense), role change, scheme coverage: all `OK`, all blocks valid.
- **Not done: live validation of the deployed `/api/evidence`** — the route is not deployed (merge/deploy forbidden). Production parity: the diff against `origin/main` touches only 5 non-doc/test/store files, all additive (new route, new workflow, registry types, one discovery capability entry, tracing includes); no existing route handler or model file is modified. Fresh pre/post production output hashing should be run after deploy with `scripts/startsit-production-parity.ts` against the 3.5B baseline (six sections, supyo29 + darthmarker, lineup totals 113.78 / 130.62).
- **Not done: `intelligence-snapshot` workflow dispatch** — a workflow must be on `main` before it can be dispatched (GitHub platform rule, same as Phase 10).

## 23. Limitations, follow-ups and verdict
Limitations: Role/OPP/Scheme history is thin (one preserved week / unsupported / current-only) and grows only with the snapshot workflow; FI receiver-side progression is SOURCE_CONFLICT with no topic; Start/Sit captured-record retrieval and lineage-dedupe/compact mode are follow-ups; player-team temporal identity waits for Phase 7; trade evaluation needs a POST-shaped evidence path.

**Verdict: CERTIFIED FOR MERGE REVIEW — code-complete and locally verified; post-deploy live validation, parity hashing and workflow dispatch remain as explicit post-merge gates.** Not merged, deployed or tagged. Phase 3.5D and Phase 4 not started.

---

# Appendix — Merge, Deployment & Production Certification (2026-09-20)

Branch findings above are unchanged. This appendix records the merge and the production proof.

## M1. Reconciliation
Certified branch tip `10798bb`; local and `origin/main` both `b2472cc` (= merge base); working tree clean; 0 commits on `origin/main` not on the branch; 5 branch commits not on `origin/main`. No drift, so no reconciliation was needed. Fast-forward merge, no force-push, no history rewrite, no tag.

## M2. Baseline (pre-merge)
Production deployment `dpl_C78s3NhPAxGt3d8e486W4DDTF4cb`, commit `b2472cc`. Versions: FI `fi:2026:w02:bfd77c9959a6` (through week 2, PARTIAL 1/16), Role `roi:2026:w01:819dc3166607`, OPP `opi:2026:w01:bef17990fe91`, Player-Scheme `psi:2025:w18:08123edd58c9`, Start/Sit `ri-startsit-2026.1` (sha256 `85d2ddd5…b293`, SHADOW_ONLY).

## M3. Merge and deployment
| Step | SHA | Deployment | State |
|---|---|---|---|
| ff merge | `10798bb` | `dpl_FxAWEcLXyAjgxGncbDMs7eY5ZA8u` | READY |
| certification fixes (M11) | `fa1048b` | `dpl_14CP52udWUZiFZazkX1bmEdWDabx` | READY — **final certified code SHA** |
Aliases attached (`bloodline-bowl-sleeper-bridge.vercel.app`, `-supyo29s-projects`, `-git-main-`); `/api/health` 200. A docs-only record commit follows and changes no code.

## M4. Live `/api/evidence`
Every topic exercised on the deployed route with real Bloodline Bowl data (QB/RB/WR/TE role + FI usage, KC offense, CHI defense, role change, Player-Scheme QB progression/spatial/formation, defense coverage, OPP scenario, Start/Sit shadow, matchup, waiver, roster health, schedule planning, trade): **HTTP 200, 0 contract-validation errors across every block**, subject identity correct on all player/team queries. Meaning verified, not only status:
- Axes independent: e.g. FI `off_pass_epa.modeled` = source class MODELED, confidence LOW, freshness through_week 2 PARTIAL, deployment SHARED_DESCRIPTIVE (`may_influence_production=false`), predictive SOURCE `PREDICTIVE` → `SHADOW_PREDICTIVE`.
- Comparison populations explicit (`NFL_OFFENSE_TEAMS` n=32, `NFL_DEFENSE_TEAMS`); defense "allowed" metrics `INVERTED_VALUE`, pressure/blitz `VALUE_ORIENTED`.
- Legitimate >1: QB `participation.snap_share` = 1.0308, `may_exceed_one=true`, preserved unclamped.
- OPP: 91 blocks, all `CONDITIONAL`, point_kind SCENARIO, relationships `CONDITIONAL_ON` + `DEPENDS_ON` (role-opportunity), limitations state the availability source is consumer-supplied and no probability/uncertainty interval is estimated, `observed_pre_scenario_role` kept as a separate component, trace weights exposed, history UNSUPPORTED.
- Player-Scheme: `RAW_1`/`RAW_2` are `SOURCE_CONFLICT` with no read-order mapping; named buckets VERIFIED; formation categories keep raw text with `NO_VERIFIED_MAPPING`; all-tier `content_identity` `psc:a7280380b358`; history CURRENT_ONLY.
- Decision converters: deployed Start/Sit (17 blocks), Matchup (4), Waiver (1) compared field-by-field against deployed native `/api/intelligence` responses: **0 differences apart from regenerated timestamps / `age_seconds`**. Waivers remain UNAVAILABLE per the readiness contract; trade is UNSUPPORTED via GET. Roster health and schedule planning were validated for contract validity and subject/lineage, and unit-tested against frozen native fixtures; no live field-by-field diff was run for those two.

## M5. History
- FI: `NATIVE_HISTORY`. Store holds 4 week-1 COMPLETE revisions with 4 distinct content ids (git-publication provenance); the query returns the latest revision per through_week plus the current partial week labelled `CURRENT_UNSNAPSHOTTED` (KC `off_pass_epa` week 1 = 0.0251 from snapshot `…#22b45ae4bd70`, current week 2 PARTIAL = 0.0256). Distinct states stay distinct (unit test with two differing synthetic snapshots proves each week reads its own content).
- Role: one preserved COMPLETE state + one per-game NATIVE_OBSERVATION, note states coverage starts with 2026; no longer series implied.
- OPP: history UNSUPPORTED. Player-Scheme: CURRENT_ONLY. Start/Sit: see M11.

## M6. Snapshot workflow (real dispatch on `main`, run 35532294447)
Succeeded. FI week 2 **refused** ("PARTIAL — COMPLETE_WEEK policy stores only complete weeks"); Role, OPP, Player-Scheme skipped "already preserved"; nothing written; whole-store verification passed; publish step "nothing new to preserve". Entries 9, 4.4 MB, 0 added, 4 skipped/refused, 0 hash problems. Two Role entries share version `roi:2026:w01:819dc3166607` with different content ids (`fb02804d…` vs `af5af8f1…`), demonstrating same-logical-version revisions remain distinguishable.

## M7. Immutability / tamper / backfill
Store tests (7) pass on merged `main`: content-derived ids, any change → new id, tampered object rejected on read and by whole-store verify, missing object / forged content_id caught, writer idempotent and append-only. Backfill walks `git log` of each surface manifest path (only commits that changed the served manifest), then applies the same retention policy; every backfilled entry carries `GIT_PUBLICATION` commit provenance. Caveat: it walks the checked-out branch's history — run it from `main` only.

## M8. Refresh cadence (verified against actual workflows)
| Family | Actual mechanism | Snapshot | Note |
|---|---|---|---|
| FI | daily workflow (existing) | snapshot workflow 13:40 UTC, COMPLETE_WEEK only | partial weeks refused |
| Role | **no scheduled workflow** — manual R runbook per completed week | preserves served state if week COMPLETE | history accrues only if someone rebuilds |
| OPP | **no scheduled workflow** — manual after Role | same | scenario history UNSUPPORTED regardless |
| Player-Scheme | none (seasonal, manual) | CONTENT_CHANGE | current-only until rebuilt |
The registry initially labelled Role/OPP "WEEKLY"; corrected to `MANUAL_WEEKLY_RUNBOOK` (M11). No "weekly history" capability is claimed for families that no process rebuilds.

## M9. Mixed vintage
Real situation today: FI is week 2 PARTIAL (`fi:2026:w02:bfd77c9959a6`) while Role/OPP are week 1 COMPLETE (`roi:…w01…`, `opi:…w01…`) and Player-Scheme is 2025 w18 PRIOR_ONLY. Each live block carries its own `through_week`, `week_state`, `surface_version` and lineage; nothing is merged into one synchronized answer; capabilities `refresh_status` reports each surface against the completed-week frontier (currently week 1, so Role/OPP are CURRENT). Test-proven lag case (frontier advanced to week 2): Role blocks report `refresh_lag_weeks=1`, and capabilities report `NOT_YET_REFRESHED`. **Fix made during certification:** blocks previously carried only a numeric lag; they now also carry an explicit `NOT_YET_REFRESHED … must not be combined … as if synchronized` limitation.

## M10. Identity quality
Live: the four known placeholders (`00-0036936`, `00-0027713` position `XX`; `00-0023968`, `00-0028049` blank) return `PLACEHOLDER` identity with explicit limitations, `source_player_id` preserved, no invented position/name. **Limitation:** their attached evidence sits in receiver/RB scheme files (`receiver_spatial_matrix`, `rb_*`, `receiver_route_profile`, `receiver_coverage_profile`) which Book-Ready has no topic for (only QB progression/spatial/formation and defense coverage are retrofitted), so `scheme.qb_*` returns UNAVAILABLE for them. The data remains retrievable through the native Player-Scheme routes; a receiver/RB Book-Ready topic is carried forward.

## M11. Certification findings fixed (commit `fa1048b`)
1. Registry overstated Start/Sit: `NATIVE_HISTORY`/`AVAILABLE`, but `/api/evidence` converts only the live comparison. Now `CURRENT_ONLY`/`PARTIAL`; captured-record retrieval carried forward.
2. Registry cadence for Role/OPP corrected to `MANUAL_WEEKLY_RUNBOOK` (see M8).
3. Lagging substrates now state `NOT_YET_REFRESHED` on the block (M9).
4. Isolation strengthened beyond folder allowlisting: no file outside `lib/book-ready/` and `app/api/evidence/route.ts` may mention `book-ready` in any form (import, dynamic import, string path); registry types and discovery may not import it; `lib/weekly`, `lib/trades` and the intelligence/lineup/waivers/matchup routes may not reference it. The two older text-scan tests skip `lib/book-ready/` only because it is proven unreachable by these checks.
Registry ↔ query layer test (both directions) still passes; no second registry exists.

## M12. Performance (production, final deployment)
| Query | Warm latency | Size |
|---|---|---|
| Artifact topics (FI/Role/Scheme/OPP) | ~0.08–0.25 s (server 9–155 ms) | 6–350 KB |
| `fi.team_metric` KC plain | 0.17 s | 99 KB |
| `fi.team_metric` KC + history + comparisons | 0.19–0.22 s | 154 KB |
| Request-scoped: matchup / roster health / schedule | ~1.0–1.3 s | 40–100 KB |
| Request-scoped: Start/Sit shadow | 0.9–1.2 s warm (5.7 s first call after deploy) | 102 KB |
| Waiver (first call) | 3.7 s | 8 KB |
Cold start after deploy: ~0.85 s on the first artifact query. Native `/api/intelligence` is ~0.13 s (cached path); the request-scoped evidence topics rebuild and are slower but bounded and opt-in. Acceptable for an analytical route; not on any recommendation path. Lineage repetition remains the main payload driver (plain → history+comparison only +55%; per-block lineage ~2.3 KB); recorded as a Phase 3.5D/Phase 10 optimization, provenance not weakened.

## M13. Production parity
Local parity script (real builder, live upstream), back-to-back: baseline `b2472cc` vs final `fa1048b` for bloodline-bowl/supyo29 — **all six sections identical** (lineup `9a245126…`, start_sit `36a45afe…`, waivers `42c7bb00…`, matchup `b6b557c6…`, leverage `32aa9c8e…`, positional_needs `c76e25bc…`; lineup total 113.76). Earlier the waiver hash differed between two runs of the *unmodified baseline* itself and matched the branch, isolating that as live upstream projection movement, not code. Deployed native output vs the pre-merge production fixture: differences are only live drift (snapshot ids, `player_data_version`, projection ticks such as team-score expected 121.43→121.5); no keys added or removed. Deployed lineup total 113.76 = local. `ri-startsit-2026.1` byte-identical (pinned by test) and SHADOW_ONLY. The diff to existing code is 6 additive files (route, workflow, registry types, discovery entry, `next.config.ts` tracing includes, snapshot script). Limitation: the deployed-route hash comparison could not be made bit-identical to the in-process script (different serialization path), so parity rests on same-code-path runs plus the semantic fixture diff, not a pre/post hash of the deployed route.

## M14. Tests (final `main`, code SHA `fa1048b`)
Full suite **2200 tests, 2196 pass, 0 fail, 4 skipped** (in 3 of 4 full runs; 1 run failed `orchestrator-isolation: roster-health + schedule-planning identical to a direct build` because the live Sleeper snapshot id changed between the two builds inside the test — a pre-existing network-dependent flake, unrelated to Book-Ready, which imports nothing it touches). Book-Ready suites: 49 tests (contract, history-store 7, evidence 16, decision 5, isolation 6, registry 4); discovery and registry tests green. `tsc --noEmit` clean; `npm run lint` (`eslint app lib test`) 0 errors. R: no R file, model artifact or lib data file changed between `b2472cc` and `fa1048b` (verified by diff), so no R suite was re-run; the frozen-model invariants (Start/Sit hash pin, FI/Role/Scheme data untouched) are covered by the TS suite.

## M15. Carried forward (not solved here)
Chapter generation, Parts/groups, chapter selection, multi-chapter requests, chapter state, Contents/Next/Go deeper, synthesis, **lineage deduplication / compact presentation**, visual rendering, chart selection, analyst UX (Phase 3.5D / 10). Also: Start/Sit captured-record retrieval; receiver/RB Player-Scheme Book-Ready topics (placeholder players' attached evidence); a scheduled Role/OPP rebuild workflow if weekly history is wanted; live field-by-field diffs for roster-health/schedule-planning converters; run `--backfill-git` from `main` only.

## M16. Verdict
**B. DEPLOYED WITH DOCUMENTED LIMITATIONS.** `/api/evidence` is live and semantically correct, the snapshot workflow ran green and refused the partial week, history is honest and immutable, mixed vintage is explicit, parity holds and tests are green. Not A because: Role/OPP weekly history depends on a manual rebuild (no scheduled process), Start/Sit history and receiver-side scheme evidence are not served by Book-Ready, and deployed-route parity was semantic rather than a bit-identical pre/post hash. None is dangerous or affects production recommendations.
