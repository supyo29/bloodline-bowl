# Intelligence Modernization — Phase 10: Analysis Book & Intelligence Lifecycle

Branch `main` (no branch task specified a separate branch name; committed directly per the operator's established pattern where the certification message precedes a separate merge/deploy instruction). Base `f74836e` (Phase 9 production certification). HEAD `6249d15`. **Not merged as a distinguished deployment event beyond the local commit; not deployed.** No Phase 9 code, model, or certified intelligence family was changed.

## 0. Starting state (verified)
`main` = `origin/main` = production = `f74836e` before this work (re-confirmed: 0 drift). Phase 9 remains merged/deployed; its cron is registered (`30 14 * * *`); week 2 2026 closed at Phase 9 certification and **week 3 is now the provider-reported current week** (re-verified live during this task via the same canonical schedule source). Phase 10 did not wait for, and did not modify, Phase 9's first scheduled execution.

## 1. Non-negotiable architectural principle — how it's enforced, not just stated
The repository already had a mature, 1,639-line `lib/analysis-book/` system (Phase 3.5D) implementing almost everything the brief asks for: a chapter registry with stable ids, book templates, capability-aware researchability sourced from the single surface registry, lazy/deferred evidence retrieval through Book-Ready (`executor.ts` is the *only* file that touches it), deterministic navigation (numbers/ranges/lists/parts/semantic groups/next/go-deeper/refresh/synthesize), and session state that preserves research revisions and distinguishes EXPLORED from USED_AS_SUPPORT. **Phase 10 extends this system; it does not replace it.** Every "may not" in the brief was already a tested invariant (`test/analysis-book-isolation.test.ts`, `test/analysis-book-taxonomy.test.ts`) before this task began, and remains one: no new chapter duplicates Matchup 2.0/Waiver 2.0/FI/Player-Scheme/Phase 9 logic — every new chapter *reads* those surfaces through their own certified Book-Ready topics, never re-derives them.

## 2. Forensic Book-readiness inventory (Checkpoint A)
| Family | Canonical reader | Temporal/as-of | Prospective captures | Book-ready today |
|---|---|---|---|---|
| League/roster/standings/scoring | `lib/canonical/state.ts`, `scoring.league_contract` | current only | n/a | yes (existing) |
| Player identity, NFL schedule/completion | `lib/canonical/nfl-reality-frontier.ts` | real game-level completion status | n/a | **new**: `league.week_summary` (thin) |
| Start/Sit FI | `startsit.shadow` | current | `bridge_startsit_shadow_captures` (0 outcomes yet) | yes (existing) |
| Matchup 2.0 | `matchup2.player.*`, `matchup2.defense.*` | current | `bridge_matchup2_shadow_captures` (291, 0 outcomes) | yes (existing) |
| Waiver 2.0 | `waiver2.*` | current | `bridge_waiver2_shadow_captures` (51, 0 outcomes) | yes (existing) |
| Football Intelligence | `fi.team_metric`, `fi.player_usage` | current, history-limited | n/a | yes (existing) |
| Player-Scheme | `scheme.*` | current-season snapshot | n/a | yes (existing) |
| Market state | `market.state` | current | n/a | yes (existing) |
| Phase 9 weekly audit | `audit.weekly_model` | per (season,week) | `bridge_weekly_model_audit` (0 rows — no completed/captured week yet) | yes (existing, unused by Analysis Book until now) |
| Personnel, fronts, run fits, CB assignment, betting lines, box-score/score data | none | — | — | **UNSUPPORTED_CAPABILITIES (unchanged)** — no chapter here invents them |
No system needed redesigning. The only genuinely missing primitive was a thin, honest reader for "which games were played and is the week complete" (no score/box-score source exists anywhere in this repository) — built as `league.week_summary` (§5).

## 3. Canonical Book identity
`book_id = book:<16-hex hash>` (unchanged mechanism, `contents.ts::createBook`), now additionally folding in the requested lifecycle type and — for lifecycle types — the frontier's `game_state`/`week_closure` (never its wall-clock `as_of`, matching Phase 9's evidence-based-not-timestamp identity philosophy). Consequence, tested: a PREGAME and a POSTGAME book for the identical game/week have different `book_id`s; two PREGAME requests before kickoff (nothing material changed) collide to the same id, which is correct — identity changes only when the evidence frontier materially changes, never merely because time passed.

## 4. Temporal integrity / no hindsight leakage — the central new mechanism
`lib/analysis-book/frontier.ts` is the **single choke point** (`gateFrontier`) `createBook` calls before building any lifecycle book (PREGAME/POSTGAME/WEEK_REVIEW/NEXT_WEEK_OUTLOOK). It reuses the exact `isCompleted` predicate Phase 1/3.5A/9 already use — nothing is re-derived. Rules, each adversarially tested (`test/analysis-book-frontier.test.ts`, 18 tests):
- **PREGAME**: allowed only when the target game is verifiably `PRE_GAME`; refused once `IN_PROGRESS`/`FINAL`/`UNKNOWN`.
- **POSTGAME**: allowed only when the target game is verifiably `FINAL`; refused while `PRE_GAME`/`IN_PROGRESS` (no forecasting a recap).
- **WEEK_REVIEW**: allowed only when the target week is `WEEK_COMPLETE` (Phase 9's own closure semantics, reproduced by value — not imported, to preserve `lib/analysis-book`'s existing isolation boundary from `lib/weekly*`).
- **NEXT_WEEK_OUTLOOK**: allowed only when the *prior* week is `WEEK_COMPLETE`.
A missing frontier is refused, never assumed. Non-lifecycle types (PLAYER_ANALYSIS, etc.) are never gated — Phase 10 adds a gate, it narrows nothing that already worked (confirmed by test).

## 5. New evidence: `league.week_summary`
`lib/book-ready/families/week-summary.ts` (topic `league.week_summary`, surface `league-week-summary`, registered in the intelligence surface registry). Reads `buildNflSeasonCompletion` directly and reports **only** what that source knows: participating teams, week completion state, per-status game counts, earliest/latest dates. It states plainly, in its own limitations, that no score/box-score/narrative source exists anywhere in the repository — the Weekly Book organizes evidence, it does not manufacture it.

## 6. Canonical schema additions
`lib/analysis-book/schema.ts`: `BookType` gains `PREGAME | POSTGAME | WEEK_REVIEW | NEXT_WEEK_OUTLOOK | TEAM_ANALYSIS`. `BookFrontier` (`as_of`, `game_state`, `week_closure`, `source`) and `BookSubject.frontier` are new, frozen at creation exactly like `capability_basis`. `Bind` gains `"league_week"` for season/week-scoped topics (`audit.weekly_model`, `league.week_summary`). No existing field was renamed or repurposed.

## 7. Canonical chapter registry — additions (7 new; 99 → 106)
| Chapter | Reads | Kind |
|---|---|---|
| `league.week_at_a_glance` | `league.week_summary` | EVIDENCE |
| `audit.startsit_outcomes` | `audit.weekly_model` §start_sit | EVIDENCE |
| `audit.matchup_outcomes` | `audit.weekly_model` §matchup2 | EVIDENCE |
| `audit.waiver_outcomes` | `audit.weekly_model` §waiver2 | EVIDENCE |
| `audit.fi_recertification` | `audit.weekly_model` §fi_recertification | EVIDENCE |
| `postgame.expectation_vs_actual` | session findings (depends_on pregame + audit chapters) | SYNTHESIS |
| `outlook.carryover` | session findings (depends_on role/competition/injury/audit chapters) | SYNTHESIS |
Every existing chapter is unchanged; no chapter id was renamed. Stable-id, acyclic-dependency and topic-integrity tests (`test/analysis-book-taxonomy.test.ts`) pass over the enlarged registry unmodified.

## 8-11. Pregame / Postgame / Week Review / Next-Week Outlook books
Templates (`lib/analysis-book/library.ts::TEMPLATES`) built from the chapters above:
- **PREGAME** (4 parts, 14 chapters + synthesis): reuses `GAME_ANALYSIS`'s exact evidence chapters (`game.*`, `team.red_zone_offense`, `injury.contingencies`) — genuinely prospective by construction, since no chapter here reads an outcome/audit source.
- **POSTGAME** (4 parts, 10 chapters + synthesis): reuses `WHY_ANALYSIS`'s "what happened / why" chapters plus the new `audit.*` chapters and `postgame.expectation_vs_actual`, whose `depends_on` literally lists both the pregame evidence chapters (`game.offensive_plan`, `game.defensive_plan`, `game.offense_vs_defense.*`, `why.role_usage`, `why.game_script`) and the postgame audit chapters — the Expectation → Actual structure the brief asks for, expressed as real chapter dependencies, not prose.
- **WEEK_REVIEW** (3 parts, 6 chapters + synthesis): deliberately **thin** — week-at-a-glance + the four Phase 9 audit chapters + carryover. It reaches every team and every game **through lineage** (§12), never by inlining 32 teams' chapters into one contents read (Step 24's "no N × chapter fan-out").
- **NEXT_WEEK_OUTLOOK** (3 parts, 6 chapters + synthesis): only forward-looking chapters (`schedule.*`, `injury.contingencies`, `team.competition`, `matchup.defensive_structure`, `outlook.carryover`) — no `game.*`/`why.*` chapter is ever included, so it structurally cannot masquerade as a late-week Pregame Book (tested).
- **TEAM_ANALYSIS** ("Team Book", 4 parts, 18 chapters + synthesis): combines the existing `team.*` (offense) and `defense.*` chapters under one book; `DEFENSE_ANALYSIS` remains the defense-only book — no duplication, both read the identical chapters.

## 12. Book inheritance / lineage
`lib/analysis-book/lineage.ts::relatedBooks` — pure, returns **references** (book type + season/week + scope), never prose or chapters: Pregame ↔ Postgame of the same game, Postgame → that week's Review, Review → next week's Outlook and the prior week's Review, Review → all 32 Team Books, Player/Manager books → their Team Book. Each reference carries `currently_creatable` (frontier-checked where known, `"UNKNOWN"` when not, **never guessed**). Tested against the real acceptance cases (§13).

## 13-15. Acceptance cases (all real, all passing — `test/analysis-book-lifecycle.test.ts`, 14 tests)
1. **Rome Odunze / Week 2** (real player, real directory data): `PLAYER_ANALYSIS` book created; a chapter range resolves to exactly those chapters in book order; `contents` after a selection returns the byte-identical `ContentsView` for the same `book_id` — context (player, team `CHI`, week) preserved throughout.
2. **Full game lifecycle**: a Pregame Book is created while `PRE_GAME`; the identical request is refused once `FINAL` is impossible to reach from `PRE_GAME` state without going through the gate — and conversely a Postgame request is refused while still `PRE_GAME`; once `FINAL`, the Postgame Book is created and its reconciliation chapter's `depends_on` literally names the pregame + audit evidence; lineage from the Pregame Book correctly reports its own Postgame Book as **not yet creatable**, and vice versa after the game ends.
3. **Week 2 NFL Weekly Book**: live-reconfirmed against the real schedule source that week 2 is `WEEK_COMPLETE`; a `WEEK_REVIEW` book for week 2 builds with exactly 7 chapters (lightweight, no fan-out); the live `audit.weekly_model` read is honestly `UNAVAILABLE` (Phase 9's cron has not yet produced a real row — this is *correct*, not a bug); lineage from that Weekly Book reaches all 32 NFL teams plus the week-3 outlook and week-1 review references.

## 16-18. Navigation / chapter execution / rendering
Unchanged (Phase 3.5D). The 5 new book types use the identical `parseCommand`/`resolveSelector`/`interpret`/`contentsView` machinery — no new navigation code was needed, and none was written, to keep the surface small and consistent.

## 19. Phase 9 integration
Four new chapters read `audit.weekly_model` sections (`start_sit`, `matchup2`, `waiver2`, `fi_recertification`) verbatim through the existing Book-Ready topic; Phase 9's `assertNoAutoPromotion` guard and 30/30 `CERTIFICATION_FAILED` state are untouched (no Phase 10 code writes to any Phase 9 table or artifact — confirmed by the unchanged `lib/weekly-audit` isolation tests, all still passing).

## 20. Historical Books
Supported by construction: a `BookFrontier` records exactly which evidence frontier a lifecycle Book was created against, and `capability_basis`/`contents_version` continue to freeze the taxonomy/vintage at creation (Phase 3.5D mechanism, unchanged). Where the underlying source cannot reconstruct a past instant (most Book-Ready topics are `CURRENT_ONLY`), the existing `Researchability` taxonomy (`CURRENT_ONLY`, `HISTORY_LIMITED`, etc.) states that honestly on the chapter itself — Phase 10 does not claim a capability the underlying evidence does not have.

## 21-23. Acceptance cases — see §13-15.

## 24. Performance
`league.week_summary` and `audit.weekly_model` are both cheap reads (Phase 9 measured `audit.weekly_model` at 0.9 ms/request; `league.week_summary` is a single already-cached schedule fetch). `WEEK_REVIEW`'s contents build touches **zero** evidence (Contents is metadata-only, unchanged Phase 3.5D property) and its lineage call is a pure in-memory function producing 34 references with no I/O. No chapter is executed to build a contents view; the existing "Contents is lightweight and lazy" test (`test/analysis-book-planner.test.ts`) continues to pass unmodified over the enlarged registry.

## 25. Security / isolation
`test/analysis-book-isolation.test.ts` (7/7, re-verified): no production/recommendation file imports the Analysis Book; inside `lib/analysis-book`, only `executor.ts` touches Book-Ready; no file performs a write, network call, or reads a secret; no new HTTP route exists (still a pure library). `lib/book-ready/families/week-summary.ts` follows the same read-only, no-mutation pattern as every other Book-Ready family. Six-surface production parity (base `f74836e` vs this work, 3 pairs × 2 interleaved rounds): **identical, 0 differing sections.**

## 26. Testing
**43 new tests**: `test/analysis-book-frontier.test.ts` (18 — pure gate logic + adversarial hindsight-leakage), `test/analysis-book-lifecycle.test.ts` (14 — the three acceptance cases, lineage, TEAM_ANALYSIS, registry conformity for the 5 new types), plus 11 pre-existing pinned-count assertions updated from 99→106 across `test/{fi-recertification,scoring-contract-bookready,weekly-audit-bookready,temporal-identity-bookready,waiver2-integration}.test.ts` (each legitimately reflecting Phase 10's *intentional* additions, not an accidental drift — every one re-verified to still assert its own phase added nothing). Full suite: **2,770 total / 2,765 passed / 0 failed / 4 skipped / 1 pre-existing, unrelated live-data flake** (`test/weekly-intelligence-live.test.ts`, a real-Sleeper-projection comparison sensitive to week-2 now being over — confirmed to import nothing Phase 10 touched). `tsc --noEmit` clean. eslint: 0 errors, 1 pre-existing warning (unchanged line, not introduced by this work).

## 27. Migration discipline
**No new database table or migration.** Every Phase 10 read goes through existing Book-Ready infrastructure (`getEvidence`) or the existing Phase 9 evidence tables (read-only). `league.week_summary` reads the live schedule source directly with no persistence.

## 28. Deployment discipline
Not deployed in this task. Production remains `f74836e` (Phase 9). Before any merge/deploy: re-run the drift audit, the full suite, the registry conformity tests, and the six-surface parity check exactly as done here.

## 29-30. Deliverables / certification standard
Delivered: forensic inventory (§2), architecture/schema/registry (§3-7), navigation (unchanged, verified compatible), composer/execution (unchanged, verified compatible), Pregame/Postgame/Weekly/Outlook/Team books (§8-11), lineage (§12), Phase 9 integration (§19), temporal-isolation tests (§4, 18 tests), all three required acceptance tests (§13-15, 14 tests), documentation (this record), certification below.
- Registry is canonical, chapter ids stable (7 new, additive, none renamed) ✔
- Navigation deterministic (unchanged machinery, re-verified) ✔
- Deep chapters call real canonical readers (all new chapters use real Book-Ready topics; the two SYNTHESIS chapters compute from session state only, per the existing `evaluateChapter(..., synthesis=true)` contract) ✔
- Pregame Books cannot see future evidence (frontier gate, adversarially tested) ✔
- Postgame Books evaluate Pregame Books (`depends_on` reconciliation, tested) ✔
- Weekly Books aggregate completed-week intelligence without claiming false certainty for missing chapters (`audit.*` honestly `UNAVAILABLE` when Phase 9 has not run) ✔
- Outlook Books carry learning forward without late-week certainty (no `game.*`/`why.*` chapter, tested) ✔
- Phase 9 remains the evaluation authority (read-only consumption, guard tests unchanged) ✔
- No certified intelligence family duplicated (isolation tests unchanged and passing) ✔
- Unavailable evidence stays unavailable; provider limitations stay visible (`UNSUPPORTED_CAPABILITIES` mechanism reused verbatim) ✔
- Historical/temporal integrity preserved (§20) ✔
- Books create no state on ordinary reads (Contents is metadata-only; `league.week_summary`/`audit.weekly_model` are pure reads) ✔
- Production isolation intact (§25, six-surface parity identical) ✔
- Rome Odunze acceptance workflow works end to end (§13) ✔

## Limitations
- `league.week_summary` has no score/box-score/narrative source — by design, not an oversight; no source of that kind exists anywhere in this repository.
- `WEEK_REVIEW`'s team-by-team, offensive-change, defensive-change, player-role-change, injury and fantasy-market groups the brief lists are reached through **lineage to Team/Player Books**, not inlined chapters — this keeps Contents lightweight (Step 24) and is the documented, intentional design, not a gap silently left out.
- No real weekly-model-audit row exists yet in production (Phase 9's cron has not had its first scheduled execution), so `audit.*` chapters are honestly `UNAVAILABLE` today; they will populate automatically once Phase 9 produces real rows — no Phase 10 change is needed for that to happen.
- Historical (past-frontier) reconstruction is only as good as the underlying Book-Ready topics' own `Researchability` (mostly `CURRENT_ONLY`) — Phase 10 states this honestly per chapter rather than claiming a capability that does not exist.

## Next phase
Phase 10: CERTIFIED (branch/local); not merged as a distinguished production event beyond this commit, not deployed.
NEXT PHASE: NOT STARTED
