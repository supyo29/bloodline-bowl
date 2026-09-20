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
