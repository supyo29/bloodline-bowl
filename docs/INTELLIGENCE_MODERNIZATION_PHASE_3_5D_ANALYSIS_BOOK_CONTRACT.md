# Intelligence Modernization — Phase 3.5D
## Analysis Book Contract, Research Planner & Navigation Foundation

Branch `intelligence-modernization-phase3-5d-analysis-book-contract`. **Not merged, not deployed, not tagged.** Additive and read-only: no model, artifact, scoring, lineup, Start/Sit, waiver, matchup or trade behavior changed, and no new HTTP route was added. Contract `analysis-book-2026.1`, taxonomy `analysis-taxonomy-2026.1`, planner rules `analysis-planner-rules-2026.1`.

Design principle: **map the entire problem first; investigate only what the user opens; once opened, investigate it completely.** Contents is exhaustive in breadth, chapters are exhaustive in depth, execution is lazy.

## 1. Starting state
- Branched from `main` = `origin/main` = `3b0c8bb` (Phase 3.5C merge/deploy/production record). Drift checked after every checkpoint commit: 0 commits on `origin/main` not on the branch each time.
- Book-Ready contract `book-ready-evidence-2026.1`; registry `intelligence-surface-registry-2026.2`; `/api/evidence` live (3.5C, production `fa1048b`, `dpl_14CP52udWUZiFZazkX1bmEdWDabx`).
- Served versions: FI `fi:2026:w02:bfd77c9959a6` (through week 2, PARTIAL 1/16), Role `roi:2026:w01:819dc3166607`, OPP `opi:2026:w01:bef17990fe91`, Player-Scheme `psi:2025:w18:08123edd58c9` (content identity `psc:a7280380b358`), Start/Sit `ri-startsit-2026.1` (sha256 `85d2ddd5…b293`, SHADOW_ONLY).
- History store: 9 entries, 4.4 MB. Known history by surface: FI NATIVE_HISTORY (1 complete week), Role NATIVE_HISTORY (1 week), OPP UNSUPPORTED, Player-Scheme CURRENT_ONLY, Start/Sit CURRENT_ONLY/PARTIAL, request-scoped surfaces CURRENT_ONLY.
- Refresh cadences: FI daily; Role/OPP `MANUAL_WEEKLY_RUNBOOK` (no scheduled rebuild); Player-Scheme seasonal; request-scoped per request.
- 3.5C latency: artifact topics ~0.1–0.3 s; matchup/roster-health/schedule ~1 s; Start/Sit ~1–6 s; waiver up to ~4 s.

## 2. Architecture (`lib/analysis-book/`, 1,600 lines, 14 modules)
```
QUESTION → entities.ts + classify.ts → contents.ts (createBook) → EXHAUSTIVE CONTENTS
        → selection.ts / commands.ts (parse + resolve)  → plan.ts (ResearchPlan)
        → executor.ts (ONLY module touching Book-Ready) → research.ts (record) → session.ts (state)
        → synthesis.ts (coverage-aware findings + report)          view.ts (JSON + plain-text Contents)
```
`schema.ts` (types + versions), `library.ts` (99 chapters + 9 templates), `topics.ts` (Book-Ready topic mirror + unsupported capabilities), `capability.ts` (registry-constrained researchability), `directory.ts` (cheap identity lookup from served Role profiles). A library, not a route: no HTTP surface, no mutation endpoint.

## 3. Book types
PLAYER_ANALYSIS, START_SIT_COMPARISON, GAME_ANALYSIS, DEFENSE_ANALYSIS, WAIVER_ANALYSIS, TRADE_ANALYSIS, MANAGER_REVIEW, WHY_ANALYSIS, and the hybrid PLAYER_VS_DEFENSE_GAME_ANALYSIS. Secondary supplements: a single-player start/sit adds PLAYER_ANALYSIS parts; a manager question that also asks "what happened" adds WHY_ANALYSIS parts (chapters deduplicated, one final synthesis). Classification is an ordered list of typed rules over extracted features and *resolved* entities (13 rules; matched rule ids returned), not one keyword match: the same words route differently with different entities. Ambiguous or empty questions return `NEEDS_CLARIFICATION` (e.g. "Jennings" matches 3 players; "Analyze that guy").

## 4. Parts / groups and 5. chapter taxonomy
| Book type | Parts | Chapters |
|---|---|---|
| Player | Player & Role · Team Environment · Performance · Matchup & Forward Outlook · Fantasy Decision | 37 (34 for a WR: QB-only chapters are not asked) |
| Start/Sit comparison | Role & Opportunity · Matchup · Scoring Opportunity · Projection & Uncertainty · Comparative Evidence | 25 |
| Game | Offensive Plans · Defensive Plans · Offense vs Defense · Scoring & Repeatability · Fantasy Implications | 15 |
| Defense | Structure · Pressure · Coverage · Outcomes | 13 |
| Waiver | Role & Opportunity · Outlook · Fantasy Decision | 13 |
| Trade | Player Value · Roster & Manager Context · Risk | 12 |
| Manager review | Roster · Decisions · Forward | 11 |
| Why did X happen | What Happened · The Opponent · Context · Repeatability | 11 |
| Player vs defense (game) | The Player's Role · The Defense · The Interaction · Execution & Repeatability | 22 |
No universal list: a test asserts every template differs. Each template carries explicit **coverage expectations** (tags that must be present; e.g. a WR matchup book cannot omit route/role, coverage, slot-boundary, pressure/QB interaction, scoring opportunity, uncertainty). 7 chapters have optional **subchapters** (e.g. Coverage interaction → 20A man/zone, B shell, C slot/boundary, D safety help, E historical vs similar structures).

## 6. Chapter identity
Stable id independent of number (`player.role.route_participation`); display number is assigned per book. The same id has different numbers in different books (tested); saved state is keyed by id (`chapter_id` or `chapter_id/SUB`).

## 7. Researchability (capability-aware Contents)
States: READY, PARTIAL, CURRENT_ONLY, HISTORY_LIMITED, CONDITIONAL, SOURCE_LAG, SOURCE_CONFLICT, UNSUPPORTED, UNAVAILABLE. Derived from **metadata only**: the surface registry, served manifests, history-store manifest, and a mirror of Book-Ready topics. Per need: UNSUPPORTED (registry says so, or a named capability the system lacks), MISSING_CONTEXT (no manager / opponent / scenario), or SUPPORTED with flags. Roll-up precedence: PARTIAL (a required need missing) > SOURCE_CONFLICT > SOURCE_LAG > CONDITIONAL > CURRENT_ONLY > HISTORY_LIMITED > registry-PARTIAL > READY. Only *required* needs change the state; enrichment gaps are listed in `reasons`.
For "Analyze Rome Odunze" (34 chapters, no manager): 7 READY, 10 HISTORY_LIMITED, 11 UNSUPPORTED, 1 CONDITIONAL, 1 CURRENT_ONLY, 1 PARTIAL, 3 UNAVAILABLE (need manager context). With a manager supplied the 3 become researchable. **No chapter is ever dropped for lack of evidence** (tested).
Honest by construction, and double-guarded: a registry that *overstated* Start/Sit history would still not make the planner advertise it, because the Book-Ready topic itself serves none (`history_capable`, verified against real Book-Ready output — this check found and fixed a real gap: **`fi.player_usage` serves no history or comparison populations**).
The planner names 30 explicit **unsupported capabilities** (projection distribution, replacement value, CB assignment, slot/boundary alignment, injury probability, play-call intent, personnel, fronts, receiver/RB scheme profiles — the 3.5C carry-forward — etc.), each with a stated reason, and a test asserts none is also a Book-Ready topic.

## 8. Navigation (`selection.ts`, `commands.ts`)
`4` · `4, 7, 12` · `4-9` · `Part II` · `Parts I and IV` · `the workload chapters` · `everything about touchdowns` · `18A` · `next` · `next chapter` · `next 3` · `everything remaining` · `contents` · `go deeper` · `refresh 4` · `refresh Part II` · `refresh what we've covered` · `synthesize what we've covered` · `final synthesis`. Parsing is deterministic; invalid input says what *is* valid ("chapter 99 does not exist: this book has chapters 1–34"; "no chapter group matches 'banana'. Groups in this book: …"). Semantic groups are by tag (16 groups: workload, touchdowns, role, matchup, coverage, pressure, scheme, schedule, efficiency, injury, roster, uncertainty, projection, market, history, team). **Next** proceeds in book order from the current chapter over unopened, researchable, not-blocked chapters, wraps, and never assumes linear reading. Selecting an already-researched chapter RECALLS it (with a stale flag) rather than re-running it.

## 9. Multi-chapter selection
Numbers, lists, ranges, Parts, and semantic groups all resolve to one deterministic ordered chapter set (with a note of what a phrase resolved to). "Everything remaining" leaves out unresearchable/blocked chapters and says so.

## 10. Lazy execution
`createBook` reads the taxonomy, registry and manifests only. Tests prove no `fetch`, no Book-Ready import in any planner/navigation/synthesis module, and zero client calls for Contents, Contents rendering and even plan building. Opening chapter 4 issues exactly the queries of chapter 4's plan (1 call).

## 11. Research plans
`ResearchPlan`: selected chapters + depth, deduplicated queries (topic, params, history, comparisons, cost, supports[]), shared queries, support-only chapters, unsupported / partial / missing-context / deferred requirements, cost, dedupe stats, warnings. Depth ladder: **1** = every required need with its declared history/comparisons (the chapter's standard, complete investigation); **2** = + enrichment needs and history/comparisons wherever the topic can return them; **3** = + subchapter needs. Only what a topic can actually return is requested.
Multi-chapter proof: rushing usage + high-value usage + teammate competition + playing time for one RB → **one** Role query attributed to all four (the test asserts ≥3 queries saved; planning all 33 evidence chapters of the Rome book needs 12 unique queries instead of 31); merged queries carry the union of flags; combined plan is cheaper than four separate plans. Within a session the `QueryCache` serves repeats and is **invalidated when a source's identity changes**.

## 12. Research state (`session.ts`)
`AnalysisBookSession`: contract/taxonomy/planner versions, `book_id` (content hash), question, subject, classification, `contents_version`, frozen `contents`, per-chapter state, `current_chapter`, `selected_part`, findings, `synthesis_state`. Chapter status: NOT_OPENED, RESEARCHING, EXPLORED, PARTIAL, STALE, NEEDS_REFRESH. Research is **revisioned** (older revisions preserved; go-deeper and refresh append). Evidence that yields nothing marks a chapter *blocked*, not researched. All functions are pure (return a new session).

## 13–14. Chapter dependencies; evidence used vs explored
`depends_on` is an *evidence* dependency: retrieving it is recorded as `USED_AS_SUPPORT` on the dependency chapter and **never marks it explored** (tested: risk & uncertainty retrieves playing-time/target/sustainability evidence; those three stay NOT_OPENED with 1 support use each, Contents shows `◦`, progress counts support-only separately; later exploring one keeps the prior support record). If both are selected, no double counting.

## 15. Evidence references
Each revision stores `EvidenceRef` (evidence id, surface, topic, metric, subject, availability, analysis class, version, season, through_week, week_state) plus per-source identities — never payloads. A 7-chapter Rome session serializes to ~66 KB; the test asserts no components/comparison/unit payload leaks into state.

## 16. Stale detection
Stored evidence identity vs current source identity per surface: NEW_THROUGH_WEEK, WEEK_COMPLETED, SEASON_CHANGED, VERSION_CHANGED. **Wall-clock time never makes anything stale** (tested). Stale is *derived* (`↻ N. Role trajectory — STALE — update available`); stored research is untouched; `refresh` queues NEEDS_REFRESH and re-research appends a revision. Go deeper works on the same chapter (depth 1→3, then suggests subchapters).

## 17. Synthesis semantics (`synthesis.ts`)
No model, no prose engine, no new score. Findings (`OBSERVATION`, `MODEL_RESULT`, `ANALYST_SYNTHESIS`) may rest **only on researched chapters** and only on evidence those chapters' own research retrieved (NOT_OPENED, blocked, unsupported and support-only chapters are rejected). Model results keep a verbatim `model_value_ref` and cannot restate numbers; an analyst synthesis cannot carry a number or state a "score/rating/projection of N". Claim strength: STRONG only for a fresh, fully researched, single-vintage, non-conditional finding; conditional/shadow/projected support, partial or stale chapters, source-lag/conflict chapters, trend claims over limited history, and mixed vintage all force TENTATIVE with recorded reasons. The report separates researched / partial / stale / not researched / not researchable / support-only (as ranges, e.g. "Researched: 2-4; Not researched: …; Cannot be researched: …"), strong vs tentative conclusions, unresolved questions, unexamined dimensions, and explicitly notes that an exhaustive Contents does not mean exhaustive research. Stored findings are not silently rewritten; the report re-assesses them (a stale chapter downgrades a STRONG finding at report time). Cross-chapter findings (≥2 chapters) are first-class. `synthesisIsCurrent` detects that new research made an earlier synthesis out of date.
**Mixed vintage:** every source keeps its own vintage. Tested with FI week 2 PARTIAL, Role week 1, Player-Scheme 2025 week 18 and OPP-on-Role-week-1: the finding is `mixed_vintage`, TENTATIVE, the statement lists each source, and text calling it "current week 2 intelligence" / "based on current data" / "this week's evidence" is **rejected**. Request-scoped surfaces are described as "live request-scoped build (no NFL through-week)", not a fake week.

## 18. Capability constraints
Constrained by `docs/intelligence-surface-registry.json` (no second registry): tests copy the repo, edit the registry (Role → UNSUPPORTED; Role history → CURRENT_ONLY) and verify researchability changes accordingly; registry query topics equal Book-Ready `TOPICS` equal the planner's `TOPIC_META`. 3.5C limitations are encoded: Start/Sit current-only (`startsit.historical_accuracy` = CURRENT_ONLY, never READY), Role history HISTORY_LIMITED, OPP CONDITIONAL, Player-Scheme prior-season SOURCE_LAG and QB read codes SOURCE_CONFLICT, receiver-side scheme UNSUPPORTED (placeholder XX/blank identities' attached evidence has no topic), mixed vintage carried into synthesis.

## 19. Cost awareness
FAST (artifact reads, ~250 ms), MODERATE (matchup / roster health / schedule, ~1.5 s), EXPENSIVE (Start/Sit ~6 s, waiver ~4 s). Chapter cost = worst required need even when context is missing. Plans report sequential and parallel estimates. **Honest limit:** `startsit.shadow`, `matchup.shadow`, `waiver.status` each re-run the weekly build inside Book-Ready; the plan warns ("N topics … each re-run the weekly build") rather than pretending to share it.

## 20. Versioning and persistence
Three versions on every session. Sessions store a frozen copy of their Contents; `deserializeSession` verifies a canonical hash (tampering rejected) and **reports** taxonomy drift (removed/added chapters) without applying it. Persistence decision: **ephemeral session object + canonical, hash-verified JSON serialization** (deterministic round-trip tested). No database, no endpoint; Phase 10 decides product persistence.

## 21. Tests
Full suite **2265 tests, 2261 pass, 0 fail, 4 skipped** (`npm test`); `tsc --noEmit` clean; `npm run lint` 0 errors (38 pre-existing/new warnings). New Analysis Book suites (64 tests): taxonomy 7, planner 15, navigation 11, research 15, synthesis 9, isolation 7 — covering typed classification, per-book exhaustiveness, capability honesty, laziness, navigation grammar, deterministic selection, state, stale detection, serialization, plan dedupe, support-vs-explored, real Book-Ready integration, synthesis honesty, mixed vintage, registry constraint, and isolation. Three existing text-scan tests were adjusted minimally and precisely (no folder allowlisting): Book-Ready isolation now allows exactly `lib/analysis-book/executor.ts` (+ the registry-key reader `capability.ts`), the Start/Sit text-scan allows exactly `lib/analysis-book/topics.ts` (a registry surface-id string), and the surface registry lists the new consumer. No R file, model artifact or data file changed, so R suites were not re-run.

## 22. Performance
Measured locally (in-process, real artifacts): directory load 44 ms cold; capability snapshot 0.7 ms; **Contents creation median 0.4–1.2 ms** (p95 ≤ 1.4 ms) for 12–40-chapter books; Contents render 0.1 ms; plan for all 33 chapters 6.8 ms (12 unique queries vs 31 naive); 34-chapter session serializes to 34 KB.
Live, read-only, against production `/api/evidence` (real HTTP): Rome book, chapters 2–6 researched in 1.6 s with 2 HTTP calls (naive 6); Part IV (9 chapters incl. matchup/roster/schedule request-scoped topics) 6.0 s with 8 calls; `next 2` 1.1 s; workload group 0.1 s. Total 13 HTTP calls, 441 KB.

## 23. Limitations
- Depth 1 is the standard investigation; "go deeper" broadens (enrichment/history/comparisons/subchapters) — evidence Book-Ready cannot yet return (e.g. usage history) does not deepen anything.
- `fi.player_usage` serves no history or comparison populations (3.5C gap, now recorded in the topic mirror).
- 11 of a WR book's 34 chapters are UNSUPPORTED today (projection range/floor/ceiling, replacement value, market/trade value, CB assignment, NFL schedule strength, efficiency/explosiveness/expected-vs-actual, game script, scheme usage profile); 10 more are HISTORY_LIMITED (one preserved week).
- Entity resolution is by served-Role-profile names only (no aliases like "JCM"; unresolved references are reported, never guessed); manager names are not resolved to managers.
- Request-scoped topics each re-run the weekly build (1–6 s each); no cross-topic build sharing.
- No visual/chart selection, no narrative writer, no route: `visualization_intent` is exposed per chapter as a hint only.
- Taxonomy is authored, not learned: exhaustiveness is guarded by explicit coverage expectations, not proven.

## 24. Phase 4 requirements
Phase 4 modeling can plug in by (a) adding a Book-Ready topic + registry entry, (b) replacing a named unsupported capability in `topics.ts` with that topic. The planner then upgrades chapters automatically; nothing else changes. Highest-value gaps: player projection distribution, replacement value, receiver/RB scheme topics, Start/Sit captured-record retrieval, player-level efficiency.

## 25. Phase 10 requirements
Presentation of the machine-readable Contents / plan / synthesis; chart selection from `viz`; a real narrative writer that consumes findings (never alters model values); product persistence and multi-session handling; a route or agent tool over this library; lineage de-duplication / compact evidence presentation (3.5C carry-forward); shared weekly-build across request-scoped topics; scheduled Role/OPP rebuild for real weekly history.

## 26. Certification verdict
**CERTIFIED WITH DOCUMENTED LIMITATIONS.** All gates below pass with tests; the limitations in §23 are capability gaps that the planner exposes honestly rather than defects.

| Gate | Result |
|---|---|
| Exhaustive taxonomy per supported book type; lightweight Contents; unavailable evidence does not remove questions | PASS |
| No exhaustive retrieval until chapters are selected | PASS (0 calls for Contents/plan; 1 call for chapter 4) |
| Chapters / lists / ranges / Parts / semantic groups resolve | PASS |
| Explored vs support explicit; stale detectable | PASS |
| Synthesis only from explored evidence; skipped/unavailable visible; mixed vintage retained | PASS |
| Planner never invents capabilities (registry-constrained, topic-verified) | PASS |
| Model output vs analyst synthesis separate | PASS |
| No production behavior change | PASS (parity script: all six sections identical, interleaved runs, both managers; 4 existing files touched: registry JSON + 3 tests) |
Not merged, deployed or tagged. Phase 4 not started.

---

# Appendix — Merge, Deployment & Production Certification (2026-09-20)

Branch-certification findings above are unchanged. This appendix records the merge and the final-main proof.

## M1. Reconciliation
Certified branch tip `3489e56`; local `main` = `origin/main` = merge base = `3b0c8bb`; clean tree; 0 commits only on `main`; 8 commits only on the branch. No drift (no FI refresh, registry, `/api/evidence`, snapshot-store or surface-version change intervened). Fast-forward merge; no force-push, no history rewrite. Drift was re-checked before each later push (0 each time).

## M2. Pre-merge production baseline (rollback reference)
Deployment `dpl_6UoRyV7tYkDG5vQU9wdqVFgGyjpN`, commit `3b0c8bb`, aliases `bloodline-bowl-sleeper-bridge.vercel.app` / `-supyo29s-projects` / `-git-main-`, `/api/health` 200. Versions: FI `fi:2026:w02:bfd77c9959a6` (through week 2, PARTIAL), Role `roi:2026:w01:819dc3166607`, OPP `opi:2026:w01:bef17990fe91`, Player-Scheme `psi:2025:w18:08123edd58c9`, Start/Sit `ri-startsit-2026.1`. Book-Ready `book-ready-evidence-2026.1`, registry `intelligence-surface-registry-2026.2`. Parity reference (supyo29, lineup total 113.76): lineup `9a245126…`, start_sit `36a45afe…`, matchup `b6b557c6…`, leverage `32aa9c8e…`, positional_needs `c76e25bc…`; waivers moved between two runs of the same unmodified code (live upstream drift — see M12).

## M3. Merge and deployment
| Step | SHA | Deployment | State |
|---|---|---|---|
| ff merge of certified branch | `3489e56` | `dpl_5K3UaxVwGDmHLFB5XHL2M2or4vfQ` | READY |
| cert fix 1 (cross-subject scales) | `e2c7914` | `dpl_4TBDgx9GQ1bdvzEwdjQxrDCwpsw5` | superseded |
| cert fix 2 (blocked chapters fetch nothing) | `f9eb8a5` | `dpl_BPbtVF6hpprYdv3M6UqzuAFxWwes` | READY — **final certified code SHA** |
All three aliases attached, `aliasError: null`, health 200. The Analysis Book has no route, so it is built into the deployment as an unreferenced library; a docs-only record commit follows the final code SHA.

## M4. Frozen boundaries
Beyond `lib/analysis-book/`, its tests and this doc, `main` differs from `3b0c8bb` in exactly three files: `docs/intelligence-surface-registry.json` (one consumer entry), `test/book-ready-isolation.test.ts`, `test/startsit-capture-integrity.test.ts`. No `lib/weekly`, projection, scoring, trade, model coefficient, R or data file changed. `ri-startsit-2026.1` sha256 pinned by test, deployed `shadow_deployment=SHADOW_ONLY`, `eligible_to_influence_production=false`.

## M5. Contract versions and session/taxonomy binding
Final `main` contains exactly `analysis-book-2026.1`, `analysis-taxonomy-2026.1`, `analysis-planner-rules-2026.1`. A serialized session round-trips byte-identically with its taxonomy retained; re-labelling a saved session to `analysis-taxonomy-2025.9` is **reported as drift while its frozen Contents (34 chapters) are not reinterpreted**; a tampered document is rejected by hash.

## M6. Contents certification (final main, manager context supplied where a book needs one)
| Book | Parts | Chapters | Researchability | Unsupported chapters present + labelled |
|---|---|---|---|---|
| Player (WR) | 5 | 34 | READY 10 · HISTORY_LIMITED 10 · UNSUPPORTED 11 · CURRENT_ONLY 1 · PARTIAL 1 · CONDITIONAL 1 | yes |
| Start/Sit (3 players) | 5 | 25 | READY 9 · HISTORY_LIMITED 8 · UNSUPPORTED 4 · PARTIAL 2 · CURRENT_ONLY 1 · CONDITIONAL 1 | yes |
| Game (CHI–CAR) | 5 | 15 | READY 6 · HISTORY_LIMITED 4 · UNSUPPORTED 4 · SOURCE_LAG 1 | yes |
| Defense (MIA) | 4 | 13 | READY 1 · HISTORY_LIMITED 4 · UNSUPPORTED 5 · SOURCE_LAG 3 | yes |
| Waiver (no candidate named) | 3 | 13 | READY 4 · UNAVAILABLE 6 (no candidate player) · UNSUPPORTED 2 · PARTIAL 1 | yes |
| Trade | 3 | 12 | READY 5 · UNSUPPORTED 5 · HISTORY_LIMITED 2 | yes |
| Manager review ("Mark's team") | 7 | 21 | UNAVAILABLE 14 (manager unresolved) · UNSUPPORTED 6 · READY 1 | yes |
| Why did X happen | 4 | 11 | CURRENT_ONLY 3 · UNSUPPORTED 4 · HISTORY_LIMITED 1 · PARTIAL 1 · READY 2 | yes |
| Player-vs-defense hybrid | 4 | 21 | UNSUPPORTED 8 · HISTORY_LIMITED 4 · SOURCE_LAG 3 · CURRENT_ONLY 3 · PARTIAL 1 · READY 2 | yes |
(READY includes the final-synthesis chapter.) Every template meets its coverage expectations; no chapter was dropped for lack of evidence.

## M7. Capability honesty (verified against the PRODUCTION registry)
Planner registry version == production `intelligence-surface-registry-2026.2`. Production says: Start/Sit `CURRENT_ONLY`/`PARTIAL`; Role and OPP cadence `MANUAL_WEEKLY_RUNBOOK` with "NO scheduled workflow"; OPP history `UNSUPPORTED`; Player-Scheme `CURRENT_ONLY`. Planner agrees on every point. `fi.player_usage`: production returns **no** history/comparison even when asked; the planner marks the chapter CURRENT_ONLY ("serves no history") and never requests either flag. HISTORY_LIMITED matches reality (Role: 1 preserved state; store `history_weeks`). Executing **all 22 non-unsupported chapters** of the Rome book against production produced real evidence for every one, and **all 9 READY chapters were fully EXPLORED**; the 11 UNSUPPORTED chapters produced no request, no evidence, and each recorded a `blocked_reason`. Manager-dependent chapters without a manager stay visible as UNAVAILABLE with their missing context.

## M8. Lazy Contents
In a fresh process: creating 9 books, rendering Contents and building a full-book plan made **0 network calls** and loaded **no** `book-ready/query`, `weekly/intelligence`, `start-sit-fi` or persistence module (detector validated with a positive control). Contents create+render (300 runs): **p50 0.40 ms, p95 0.56 ms, max 1.04 ms**.

## M9. Live research execution (production `/api/evidence`)
| Scenario | Planned | Actual requests | Notes |
|---|---|---|---|
| One chapter (target opportunity) | 1 | 1 (`role.player_profile`) | 61 KB |
| Five Role/workload chapters | 2 unique / 6 naive | 2 (**1** Role) | shared Role evidence retrieved once; 69 KB |
| Part II (7 chapters, FI team + Role) | 4 unique / 7 naive | 4, no duplicates | 163 KB |
| Larger Part IV (9 chapters, request-scoped topics) | — | 7–8 | ~206–255 KB |
| All 22 researchable + 11 unsupported chapters | 16 unique / 31 naive | 16 | unsupported chapters requested nothing |
| Three-player comparison (4 chapters) | — | 9 (**3** Role, one per player; naive 12) | 318 KB |

## M10. Navigation, blocked-chapter and vintage regressions
All of `4`, `4,7,12`, `4-9`, `Part II`, `Parts I and IV`, `workload chapters`, `next`, `next 3`, `contents`, `go deeper`, `refresh 4`, `synthesize what we've covered`, `final synthesis` resolve deterministically (two independent runs identical); invalid input (`99`, `the banana chapters`, `Part IX`) returns the valid alternatives. **Blocked-chapter regression:** after live blocking of `injury.contingencies` (scenario input missing), `matchup.cornerback_assignment` and `decision.projection_range` (unsupported), six successive `next 3` and `next 30` never re-propose them; permanent test `Next/remaining do not re-propose a chapter that was already attempted and BLOCKED`. **Vintage regression:** live mixed-vintage statements label request-scoped sources "live request-scoped build (no NFL through-week)"; no `week ?`/`null`/`undefined`/`NaN` appears in any finding, statement or rendered synthesis; permanent test retained.

## M11. Support vs explored, session state, stale detection
Live: researching `decision.risk_uncertainty` left its three dependency chapters `NOT_OPENED` with one `USED_AS_SUPPORT` record each (Contents: 1 explored / 3 support-only); exploring one later keeps its prior support record. Session round trip serialize→deserialize→serialize is identical; current chapter, chapter state, evidence identity and taxonomy retained; tampering rejected. Advancing Role to week 2 (synthetic identity) made exactly the 3 Role-dependent chapters STALE with research preserved (revision count unchanged); against live identities nothing is stale, and a re-record dated 2035 is still not stale — staleness is identity-driven, never time-driven.

## M12. Mixed-vintage synthesis and honesty (real production evidence)
A finding spanning FI (2026 week 2 PARTIAL, `fi:2026:w02:bfd77c9959a6`), Role (week 1 COMPLETE), OPP (week 1, on Role week 1), Player-Scheme (2025 week 18) and live matchup build is `mixed_vintage`, **TENTATIVE**, and lists each source; "This is the current week 2 intelligence" and "Using this week's evidence…" were both **rejected**. The FINAL synthesis of a partially researched book states "Researched 8 of 33; not researched 14; cannot be researched 11" plus "FINAL synthesis of PARTIAL coverage… exhaustive Contents does not mean research was", separates researched / partial / support-only / not researched / not researchable / stale, and machine-separates model result, observation and analyst synthesis. MODEL_RESULT keeps `model_value_ref` to the FI evidence id; analyst synthesis with "score of 8.5" or a `numeric` field is rejected.

## M13. Comparison book
One shared START_SIT_COMPARISON book for Rome/Deebo/Tuten; per-player lineage (3 distinct Role queries, refs per player); mixed-position populations flagged "NOT DIRECTLY COMPARABLE (NFL_WR vs NFL_RB)". **Certification fix:** the branch only flagged incompatibility on the chapter; findings could still cite it silently. `EvidenceRef` now carries `unit_kind` and comparison population: a cross-subject claim over **different unit kinds is rejected** ("no scale conversion is attempted") and **different populations force TENTATIVE**. No overall recommendation was produced.

## M14. Certification fixes made during this task
1. `e2c7914` — cross-subject scale rejection (above); regression test added.
2. `f9eb8a5` — live run showed a chapter that cannot run (deferred scenario / unsupported) still fetched its dependency evidence and recorded false support-only progress. A chapter with no runnable primary evidence now retrieves nothing, including dependencies (plan warning states why); regression test added. Both are library-only, non-production changes.

## M15. Performance (final main)
Contents p50 0.40 ms / p95 0.56 ms; full-book plan 6.8 ms (16 unique / 35 naive queries, est. 7.3 s if every chapter were opened). Live retrieval: one cheap chapter 0.56–1.0 s (first call includes cold start); five shared Role chapters 0.19–0.52 s; expensive request-scoped Start/Sit chapter 3.7–4.7 s (1 request); Part II 1.3–1.4 s; Part IV 4.4–5.1 s. Same general range as branch certification; retrieval is intentionally costlier than Contents.

## M16. Entity-resolution limitation (documented, not changed)
Served Role names resolve directly. Not resolved and never guessed: `Analyze JCM` → NEEDS_CLARIFICATION; `Should I start Jennings?` → ambiguous (3 players, asks for a full name); `What happened to Mark's team?` → MANAGER_REVIEW with `unresolved: ["manager:mark"]` and 14 chapters honestly UNAVAILABLE. Carry to Phase 10 or an earlier targeted capability phase.

## M17. Unsupported / limited chapter inventory (WR book; roadmap signal, nothing implemented)
The repository defines Phase 4 (Waiver/Matchup 2.0) and Phase 7 (player-team temporal identity); Phases 5/6 are not defined in-repo, so those assignments are **provisional**.
| Chapter (state) | Missing capability | Roadmap class |
|---|---|---|
| Projection range; Floor/median/ceiling (UNSUPPORTED) | `player_projection_distribution` — production projections exist but are not exposed as Book-Ready evidence | Phase 4 |
| Replacement value (UNSUPPORTED) | `replacement_level_evidence` (computed in the weekly engine, not exposed) | Phase 4 |
| Market/trade value (UNSUPPORTED) | trade-foundations UNSUPPORTED via GET; needs a POST-shaped evidence path | trade-engine follow-up (targeted capability phase) |
| Scheme-specific usage profile (UNSUPPORTED); Coverage interaction (PARTIAL) | `receiver_scheme_profile` — data exists in Player-Scheme files, no Book-Ready topic | Phase 4 (Matchup 2.0) / targeted topic addition |
| Efficiency; Explosiveness; Expected vs actual (UNSUPPORTED) | `player_efficiency_metrics`, `player_explosive_play_rate`, `expected_fantasy_points_model` | Phase 5/6 (provisional) |
| Game-script sensitivity (UNSUPPORTED) | `game_script_splits` (derivable from nflverse pbp) | Phase 5/6 (provisional) |
| Remaining NFL schedule (UNSUPPORTED) | `nfl_schedule_strength` | Phase 4 (Matchup 2.0) |
| Cornerback assignment (UNSUPPORTED) | `cornerback_assignment_data` | future data-source requirement |
| Route participation / Coaching tendencies / Offensive line (HISTORY_LIMITED, enrichment gaps) | `multi_season_route_history`; `coach_specific_profile`; `ol_player_level_pass_block` | Phase 7; Phase 7; future data source |
| Injury contingencies (CONDITIONAL) | `injury_probability` enrichment only | future data source |
| Role chapters (HISTORY_LIMITED ×10 incl. team chapters) | only one preserved complete week; Role/OPP rebuild is manual | accrues with the snapshot workflow / scheduled Role rebuild |
| Sustainability (CURRENT_ONLY) | `fi.player_usage` serves no history | 3.5C follow-up (targeted capability phase) |
Other books add: `slot_boundary_alignment_data`, `safety_help_bracket_data`, `defensive_front_alignment`, `in_game_adjustments`, `play_call_intent`, `betting_lines` (future data source); `personnel_groupings`, `drive_level_scoring_data` (Phase 5/6, derivable from nflverse); `run_fit_evidence`, `defense_position_vulnerability`, `qb_pressure_profile`, `rb_scheme_profile` (data exists, Phase 4 Matchup 2.0 topic exposure); `manager_competition_evidence`, `drop_cost_evidence` (Phase 4 Waiver 2.0); `manager_incentive_evidence`, `positional_scarcity_evidence`, `manager_weekly_results` (trade-engine / Phase 5 provisional). Phase 10/presentation: no chapter is unsupported for presentation reasons; visualization is a Phase 10 concern. Intentionally unsupported: none.

## M18. Production parity
Interleaved runs of the real weekly builder (`scripts/startsit-production-parity.ts`), pre-merge code `3b0c8bb` vs final `f9eb8a5`, three rounds each for bloodline-bowl/supyo29 and devoted-to-the-game/darthmarker: lineup, start_sit, matchup, leverage and positional_needs identical in all 6 rounds; waivers identical in 4 of 6 rounds. The two differing rounds are upstream drift, not code: **unmodified `3b0c8bb` disagrees with itself** (supyo29 waivers `0693fc29…` → `26e2af96…`; darthmarker `06026ef2…` → `192e1c32…` between its own consecutive runs), and every final-code run equals the *later* pre-merge run. Lineup totals 113.73 / 131.41 identical pre and post; deployed `/api/intelligence` lineup total 113.73 = local; deployed shadow `SHADOW_ONLY`, ineligible to influence. Structurally: nothing in `app/` or `lib/` outside `lib/analysis-book/` names it (dedicated test).

## M19. Isolation (dedicated Analysis Book tests are authoritative)
`test/analysis-book-isolation.test.ts` (7 tests): no production file imports or names the Analysis Book; only `executor.ts` reaches Book-Ready (asserted as an exact one-file list); no writes, network, secrets or production-engine imports anywhere in the library; no start-sit/weekly/matchup/orchestrator/trades/waiver **module** imports; no route exists; planner is registry-constrained. The three legacy tests changed by exact-file allowlists only — `executor.ts`, `capability.ts` (registry JSON key, plus a test asserting it has no import) and `topics.ts` (a registry surface-id string) — and **no folder exclusion was added by 3.5D** (the `lib/book-ready/` skips predate it, from 3.5C).

## M20. Tests
Final `main` (`f9eb8a5`): **2267 tests, 2263 pass, 0 fail, 4 skipped**; `tsc --noEmit` clean; `npm run lint` 0 errors (38 warnings). Analysis Book suites 66 tests: taxonomy 7, planner 15, navigation 11, research 16, synthesis 10, isolation 7; Book-Ready evidence/decision/isolation/registry/history suites and discovery/registry tests green. Live certification harnesses against production: 67/67 and 16/16 checks passed (after the two fixes above). No R, model or data file changed between `3b0c8bb` and final `main` (verified by diff), so no R suite was re-run.

## M21. Limitations
Unsupported/limited chapters (M17); thin Role/FI history and manual Role/OPP rebuild; request-scoped topics each re-run the weekly build (Start/Sit ~4 s); entity/alias/manager resolution (M16); no visualization, narrative writer, route or product persistence (Phase 10). `fi.player_usage` history/comparison is a 3.5C gap the planner now reflects honestly.

## M22. Verdict
**B. DEPLOYED WITH DOCUMENTED LIMITATIONS.** Main is healthy and deployed; production parity holds; live evidence execution works with verified deduplication; Contents stays lazy; navigation, state, stale detection, support-vs-explored, mixed-vintage and synthesis honesty all verified on production evidence; capability honesty matches the production registry; tests are green. The remaining limitations (M21) are non-dangerous capability gaps that the Book reports rather than hides. Phase 4 has not been started.
