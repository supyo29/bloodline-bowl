# Phase 7 — Temporal Identity / Team Membership: Production Certification

Certified 2026-09-21. Production: `bloodline-bowl-sleeper-bridge.vercel.app`. Supabase project `ijpfjdzmaztofawhwepf`.

## 1. Verdict
**A — PHASE 7 OPERATIONAL IN PRODUCTION.** Every production gate passed: stable identity and time-varying membership are separate; the live provider team wins over the stale crosswalk team without changing person identity; historical membership never falls back to today's team; historical opponent joins are chronology-safe; uncertain transitions stay uncertain; **no canonical-ID migration occurred (0 of 634 changed)**; Matchup 2.0 historical joins are guarded; Player-Scheme vintage is explicit; current recommendation surfaces are unchanged (one explained, metadata-only difference); Phase 5 captures are immutable; Phase 6 scoring is untouched; **P7-F2 remains explicitly deferred (§8)**. One item was deliberately *not* done: the Book-Ready `player_team_temporal_identity` marker was **not** bumped (§21).

## 2. Git
| Item | Value |
|---|---|
| Certified branch / tip / last code commit | `intelligence-modernization-phase7-temporal-identity` / `66f9d8e` / `ecf4399` |
| main before merge | `6485997` (= `origin/main`); **0 intervening commits**, so no drift to audit (no identity/provider/crosswalk/Supabase/Matchup2/Player-Scheme/Role/FI/Book-Ready/Analysis-Book/Phase 5/Phase 6 changes) |
| Merge method | **fast-forward** (`6485997..66f9d8e`), no rebase, no force-push, history preserved; branch also pushed to origin |
| Resulting main SHA | `66f9d8e1e9d2e0fee07d005fd068bab2ce7c51f3` |
| Follow-up commits | this certification commit (test + doc only, no runtime change; SHA in the final report) |
| Working tree | clean |

## 3. Rollback state (recorded before merge)
- Production deployment `dpl_64hwtP7VMG4977FpxLDbPzwM6jvr`, SHA `6485997`, READY, `isRollbackCandidate: true`. Prior deployment `dpl_G5RQcghu…` (Phase 6 merge `9329465`).
- Migrations (9, unchanged before/after): `…nfl_plays_schema, bridge_post_draft_foundation, bridge_published_snapshot_pointer, bridge_publication_audit, bridge_yahoo_oauth_connections, startsit_shadow_evidence, waiver2_shadow_captures, market_state_snapshots, matchup2_shadow_captures`.
- Pre-deploy canonical population saved for all 3 Sleeper leagues (634 player records). **Puka Nacua before:** `canonical_player_id player:gsis:00-0039075`, `nfl_team "LA"`, identifiers `{sleeper 9493, gsis 00-0039075, yahoo 40168, espn 4426515, pfr NacuPu00, name_key puka-nacua-wr-lar}`, resolution `stable_id/exact`; `player_data_version` per league (`players:v1:0e200adb8e8579ce` / `…70675d9c6cb3f102` / `…2d8694e10cc54fcb`), `crosswalk_version supabase:nfl_players:266`.
- Rollback = promote `dpl_64hwtP7…` (no data change to undo). The rollback record separates a **team-field correction** (nfl_team string only) from **identity change** (`canonical_player_id`/`identifiers`), which this deployment does not make.

## 4. Deployment
`dpl_7i4qwByC9VvYrnKVFcgL8DSyADiU`, SHA `66f9d8e`, **READY**, `aliasError: null`, aliases: `bloodline-bowl-sleeper-bridge.vercel.app`, `…-supyo29s-projects.vercel.app`, `…-git-main-supyo29s-projects.vercel.app`. Runtime logs since deploy: 150 requests, **all 200**, 0 error/warning entries (3 info lines are the pre-existing published-snapshot freshness events; flag `BRIDGE_PUBLISHED_SNAPSHOT` remains OFF).

## 5. Database
**No Phase 7 database migration required.** Confirmed from the actual diff (no `supabase/migrations` file; the only persistence file, `lib/persistence/supabase/team-membership-source.ts`, is a read-only adapter) and from `list_migrations` before and after (identical 9). The existing `(gsis_id, season DESC, week DESC)` index serves the reads.

## 6. P7-D1 current-team correction (live production)
| Player | Provider (Sleeper) | Crosswalk `latest_team` | Canonical team before → after | canonical id before → after |
|---|---|---|---|---|
| **Puka Nacua** | LAR | LA | **LA → LAR** (all 3 leagues) | `player:gsis:00-0039075` → **same** |
| Rome Odunze, Malik Nabers, Jalen Nailor, Chig Okonkwo, Bo Nix, Chris Olave, Jason Myers, Kyler Murray (MIN) | = crosswalk | = provider | unchanged | unchanged |

All 9 crosswalk-resolved (GSIS-form) players: 8 already agreed; the one disagreement was the `LA`/`LAR` vocabulary defect and is corrected. Resolution method for Nacua remains `stable_id/exact`; identifiers byte-identical. Invariant proven live: **a provider current-team observation corrected membership without changing person identity.**

## 7. Canonical-ID stability (hard gate — PASSED)
Full before/after over all three Sleeper leagues (198 + 208 + 228 records):
| Measure | Result |
|---|---|
| canonical player records compared | **634** |
| canonical IDs changed | **0** |
| `player:sleeper:* → player:gsis:*` migrations | **0** |
| identifiers changed | **0** |
| players missing/new after | 0 / 0 |
| team values changed | **3** (all Puka Nacua, one per league) |
| `crosswalk_version` | `supabase:nfl_players:266` before and after |
`player_data_version` changed in each league (it hashes the team field); the change is fully accounted for by the Nacua team correction. Identity links (`identityLinks`) remain a compatibility layer only; nothing was rewritten.

## 8. Crosswalk Identity Migration — NOT EXECUTED
- **Status: P7-F2 remains OPEN by design. The crosswalk pagination was not touched.**
- **Available ID-bearing rows: 6,053** of 24,375 `nfl_players` rows (5,892 with a sleeper id). **Loaded: 266** (`supabase:nfl_players:266`, ≈4.4%) — `SupabaseCrosswalkSource` issues one un-paginated select and PostgREST caps the response at 1,000 rows.
- **Migration risk, measured live today:** of the **228 distinct sleeper-form ids** (including team-defense codes such as `SF`, `PHI`) behind the 608 `player:sleeper:*` records currently in the canonical population, **192 map to a GSIS id in `nfl_players`** and would flip to `player:gsis:*` if the loader were paginated (the remaining 36 are team defenses / unmapped). Production today: 608 records are `player:sleeper:*`, 26 are `player:gsis:*`. It would also expose stale `latest_team` snapshot values (≈10% disagreement measured at the branch).
- **Why deferred:** a silent identity rewrite at scale would break historical snapshots, captures, ledger keys and any id-keyed consumer; explicitly prohibited without a migration plan.
- **Recommended future path (separate authorization):** (1) keep `canonical_player_id` stable and resolve both forms through the alias layer; (2) paginate the crosswalk behind a flag but carry the GSIS form in a new `identity_key`, not in `canonical_player_id`; (3) dual-read comparison period over snapshots/captures; (4) migrate consumers to `identity_key` with old ids valid via aliases; (5) only then consider GSIS as canonical for *new* records, versioned. P7-D1 (team precedence) is the prerequisite and is now live.

## 9. Temporal resolver (live, deployed `player.team_membership`)
Statuses observed live: `SUPPORTED_GAME`, `SUPPORTED_BRACKETED`, `SUPPORTED_CURRENT`, `AMBIGUOUS_TRANSITION` (as `GRANULARITY_INSUFFICIENT`), `BRACKET_GAP_TOO_LONG`, `CURRENT_ONLY_OUT_OF_SCOPE` (as `CURRENT_ONLY_FOR_HISTORICAL_QUERY`), `NO_EVIDENCE` (as `MEMBERSHIP_UNKNOWN`). `CONFLICT`/`SOURCE_CONFLICT`, `TEMPORAL_SOURCE_UNAVAILABLE`, `IDENTITY_UNRESOLVED`, `NO_TEAM_OBSERVED`, `SUPPORTED_SEASON` are proven by tests (real sources contain 0 conflicts).

## 10. Historical validation (deployed production, real data)
Identity is the same GSIS id on both sides of every move. Every row `validation.ok = true`; source vintage `GAME_LOG:player_lab_game_logs` (`ROLE_PARTICIPATION:player_game_role.csv` for 2026 wk1); granularity `GAME_OBSERVED`.
**Midseason (both sides shown):**
| Player | Before | After |
|---|---|---|
| Christian McCaffrey `00-0033280` | 2022 wk6 **CAR** vs LAR | 2022 wk7 **SF** vs KC; wk9 (bye) → SF, `SUPPORTED_BRACKETED`, gap 1 |
| DeAndre Hopkins `00-0030564` | 2024 wk7 **TEN** vs BUF | 2024 wk8 **KC** vs LV |
| Joshua Dobbs `00-0033949` | 2023 wk8 **ARI** vs BAL | 2023 wk9 **MIN** vs ATL |
| Mecole Hardman `00-0035140` | 2023 wk6 **NYJ** vs PHI | 2023 wk7 **KC** vs LAC |
**Offseason:** Darren Waller 2022 wk18 LV vs KC → 2023 wk1 NYG vs DAL · Kenny Golladay 2020 wk8 DET vs IND → 2021 wk1 NYG vs DEN · Jimmy Garoppolo 2022 wk13 SF vs MIA → 2023 wk1 LV vs DEN · DeAndre Carter 2021 wk1 WAS vs LAC → 2022 wk1 LAC vs LV · Hopkins 2022 wk16 ARI vs TB → 2023 wk1 TEN vs NO · Justin Fields / A.J. Brown / Deebo Samuel / Jaylen Waddle 2025 → 2026 (§14).
**Ambiguous (Step 12):** Le'Veon Bell 2021 wk13 (BAL wk10 → TB wk16) and 2020 wk6 (NYJ wk5 → KC wk7), DeAndre Carter 2020 wk11 (HOU wk10 → CHI wk12) → `UNAVAILABLE`, `GRANULARITY_INSUFFICIENT / AMBIGUOUS_TRANSITION`, both candidates listed, "the change point … is not located by any source". Not interpolated.
**Gap too long (live):** Puka Nacua 2024 wk5 — the data holds only wk1 and wk8 (real injury absence) → `BRACKET_GAP_TOO_LONG`, "6 missing weeks exceeds the 3-week inference limit … membership in week 5 is not asserted".
**A→B→A:** real Bausby 2020 (DEN wk6, ARI wk9, DEN wk12) — the sparse bracket is refused (integration test) and pinned again by the new grid (§11).

## 11. Chronology
- **Bracket-gap grid (new test-only file `test/temporal-identity-prodcert.test.ts`, 11 tests):** gaps 1, 2, 3 → `SUPPORTED_BRACKETED` with the gap exposed and `INFERRED_BETWEEN_OBSERVATIONS`; gaps 4, 5, 6 → `BRACKET_GAP_TOO_LONG`, no team; hidden-middle A→B→A refused, answered exactly once the middle game is observed. Cap = 3, **not widened**.
- **Future-mutation invariance:** synthetic (byte-identical for every week ≤ T with and without later game/provider/crosswalk evidence) and real (strict as-of over every real player-season and every cutoff week, >5,000 checks; cross-season >1,400 real queries) — all pass on the merged tree.
- **Latest-team leakage:** 0. Current-only evidence returns `CURRENT_ONLY_FOR_HISTORICAL_QUERY` and the present-day team is not even echoed (live: Nacua 2018 wk5, 2026 wk2, 2026 wk3; synthetic: provider SF / crosswalk LA never answer a 2023 week).
- Rejected source preserved: `player_weekly_projections.team` (≈86% agreement) is not admitted.

## 12. Opponent resolution
- **Live sample:** 80 fresh salted-random real game rows (2019–2025, salt `p7-prodcert`, disjoint from the branch fixtures) through the deployed endpoint → **80/80 team and opponent exact, 0 mismatches**, including 4 rows whose raw code is `LA` (normalized `LAR`).
- **Schedule integrity (recomputed today on all data):** **3,920 / 3,920** distinct team-weeks reciprocated, 0 team-weeks with more than one opponent; source unchanged (129,657 rows, 4,365 players, 2019–2025).
- Branch-level ~900-row sample and leave-one-out (102,298 / 103,096 correct, 796 ambiguous, 2 wrong outside the cap) re-pass in the merged suite. Zero current-team substitution.

## 13. Matchup 2.0 (deployed)
- **Current week unchanged:** wk2 returns the full 21-block evidence set (uncapped, no adjustment); 48 Matchup2 tests pass; six-surface parity identical (§18).
- **Historical guard:** a past week with no game-level evidence → single `UNAVAILABLE` block: "historical week 1: the player's NFL team at that time is not established by game-level evidence (NO_EVIDENCE); the current/directory team is never substituted" (live, `00-0037013`).
- **Contradictory opponent refused (live):** Nacua wk1 with `opponent=DAL` → "requested opponent DAL conflicts with the schedule opponent SF for his effective team LAR".
- No numeric weight, composite adjustment, or promotion; Phase 5 stays descriptive/evidence-only.

## 14. Player-Scheme vintage (live)
`player.team_membership → membership.scheme_window_vintage`, window team derived from temporal evidence at the Player-Scheme cutoff (2025 wk18), **not** the 2026 directory label:
| Movers | 2025 wk9 → 2026 wk1 | Flag |
|---|---|---|
| A.J. Brown | PHI → NE vs SEA | `TEAM_CHANGED_SINCE_SCHEME_VINTAGE` |
| Deebo Samuel | WAS vs SEA → SF vs LAR | `TEAM_CHANGED_SINCE_SCHEME_VINTAGE` |
| Jaylen Waddle | MIA vs BAL → DEN vs KC | `TEAM_CHANGED_SINCE_SCHEME_VINTAGE` |
| Justin Fields | NYJ → KC vs DEN | `TEAM_CHANGED_SINCE_SCHEME_VINTAGE` |
| **Controls** Bo Nix / Ja'Marr Chase / Justin Jefferson / Puka Nacua (raw `LA`) | same club both seasons | `SAME_TEAM_AS_SCHEME_VINTAGE` |
Every live Player-Scheme block (`scheme.qb_progression` 6/6, `qb_spatial` 1/1, `qb_formation` 7/7, `defense_coverage` 2/2) carries the limitation "'current_team' = career rows on the player's AS-OF team at the source cutoff … NOT the team he is on today … belongs to his FORMER club". No 2025 evidence is labelled with today's team.

## 15. Role / Football Intelligence
- Role game-level participation is 2026 **week 1 only** (407 players with snaps; `prior_game_team` empty on all 1,200 rows). Live proof of the limit: a directory player without a wk1 row (`00-0037013`) gets an explicit UNAVAILABLE for a historical week; the integration suite pins wk2 → `NO_EVIDENCE` and Role availability `SOURCE_LAG`, and 2025 and earlier `UNAVAILABLE`. No consumer fabricates older or newer Role history.
- FI: the historical player→team→FI join uses the temporal effective team (`fi_join`, defense team = the game's actual opponent). FI ratings untouched; FI not activated. Role/FI team vs temporal: **407/407 agree, 0 disagree** (re-asserted by the integration suite, passing on merged main). FI features remain `HISTORY_LIMITED`/`UNAVAILABLE` as-of; no Phase 8 work.

## 16. Depth chart
**`UNSUPPORTED`.** No dated depth-chart source exists in the repository, database or the (empty) drift. `DEPTH_CHART_HISTORY.status = "UNSUPPORTED"`; a source-scan test confirms nothing infers WR1/WR2/RB1/RB2/starter/backup from membership, snaps or projections.

## 17. Historical fantasy context
`NON_CURRENT_WEEK_UNSUPPORTED` is unchanged (file has zero diff and does not import the temporal layer; pinned by test). Phase 7 supplies no fantasy ownership, lineups, waiver pools, FAAB, standings or roster state.

## 18. Six-surface production behavior
Two independent checks.
**(a) Local interleaved, base `6485997` vs merged main (real code, same live provider data), 3 pairs × 2 rounds:** `bloodline-bowl/supyo29`, `bloodline-bowl/bijimac`, `devoted-to-the-game/darthmarker` × lineup, start_sit, waivers, matchup, matchup_leverage, positional_needs → **all 6 surfaces identical in every pair and every round (0 differing sections).**
**(b) Deployed production, pre-deploy vs post-deploy (wk2, 2 post rounds):** lineup, start_sit, matchup, matchup_leverage, positional_needs **identical for all three pairs** (15/15). **Waivers differ pre→post for all three pairs and the new deployment agrees with itself across rounds; traced completely:** all 9 differing JSON paths per pair are lineage/readiness metadata only — `lineage.snapshot.{content_hash, league_snapshot_id, player_data_version}`, `readiness.canonical.{content_hash, snapshot_id, age_seconds}` and the same three inside `readiness.football_intelligence.lineage.snapshot` — with **zero** recommendation content (no candidate, ranking, add/drop or price value) different. Cause: `player_data_version` hashes the team field, and the only team change is Nacua `LA→LAR` (§7), so the snapshot hash and id change; `age_seconds` differs by wall clock. This is a real, verified consequence of P7-D1, not live-pool drift. (The old deployment is behind Vercel deployment protection, so a direct old-vs-new interleave against live data was not possible; the local interleaved harness in (a) supplies it.)

## 19. Phase 5 compatibility
Re-queried after deployment: `bridge_matchup2_shadow_captures` = **291** rows (LIVE_CAPTURED 21 / LIVE_POST_LOCK 270), max `captured_at` 2026-09-21 14:31:42.597 (no cron rows since), 2 distinct scoring fingerprints. **Digest of the original population (`captured_at ≤ 2026-09-21 14:31:43+00`, `md5(string_agg(capture_id||content_hash order by capture_id))`) = `e0816ec3a3b9edf2a0b6cd7639fb05c0` — identical before merge, after deploy, and to the branch value.** No old row mutated; nothing backfilled; fingerprints untouched. The total is not assumed (any later cron rows are append-only and outside the boundary). Phase 7 code contains no capture-store access (import-scan test). 53 capture tests pass.

## 20. Phase 6 compatibility
Zero diff vs base in `lib/scoring`, `lib/weekly/scoring.ts`, projections, `lib/waiver2`, `lib/weekly/context.ts`, scoring fingerprint. 143 scoring tests (calculator, return-yard fix, position premiums, support matrix, fingerprints, waiver translation) pass. Live league `scoring_fingerprint` values are identical before and after deployment in all three leagues (e.g. `scoring:v1:29acc6bcd911df090b5b9b9c` for bloodline-bowl, `scoring:v1:d4795fa723cdd12d9ba3bfb1` for devoted-to-the-game). The fingerprint still describes league rules, not temporal identity.

## 21. Book-Ready
Live `GET /api/evidence?topic=player.team_membership&gsis_id=…[&season=&week=]` (`validation.ok = true` on every response; registered in `?capabilities=1`). Examples: current supported (Nacua current → `LAR`, `SUPPORTED_CURRENT`, `CURRENT_ONLY`, **`SNAPSHOT_STALE_RISK`** because the request supplied no provider id) · historical game-observed (McCaffrey 2022 wk7 → SF vs KC) · bracketed (McCaffrey 2022 wk9 → SF, gap 1) · long gap (Nacua 2024 wk5) · ambiguous (Bell/Carter) · current-only historical (Nacua 2018/2026) · unknown id (`MEMBERSHIP_UNKNOWN / NO_EVIDENCE`). Blocks carry canonical subject, requested season/week, team/opponent when supported, source, granularity, evidence class, `temporal_data_version` (`tm:v1:…`), source vintages, status/failure code, conflict candidates, limitations and lineage; DESCRIPTIVE_ONLY, `may_influence_production:false`. Conflict behavior is proven by the fixture test (UNAVAILABLE + all candidates).
**Marker decision (Step 6): `player_team_temporal_identity` was NOT bumped.** The literal `NOT_MODELED_UNTIL_INTELLIGENCE_MODERNIZATION_PHASE_7` is a required stamp on *every* block of *every* family (scoring, waiver2, market-state, role, matchup2, player-scheme, …) and is enforced by the validator. Phase 7 models temporal identity for one topic only, so flipping it globally would make a false claim on most blocks, and a correct change would need a new per-family literal plus validator/registry redesign that the certified record does not specify. Per the instruction not to invent a version, it remains a **documented limitation**; team-membership blocks state their temporal semantics in their own fields.

## 22. Analysis Book
The runtime diff to `lib/analysis-book` is the single topic registration in `topics.ts` (+1 line); no chapter file changed. Chapter ids/states as certified: **99 chapter ids before = after, no state change, no enrichment attached**; the topic is registered and required by no chapter (pinned by test); history-limited chapters stay limited by their own missing capabilities (preserved-snapshot depth, multi-season Role, coach/OL data, Player-Scheme vintage). 66 Analysis Book tests pass.

## 23. Temporal versioning
Tests (all passing): same data in different order ⇒ same `tm:v1:` version; irrelevant metadata (raw spelling, vintage label) ⇒ same; a changed membership fact or added evidence ⇒ different (also in the new grid); per-resolution `evidence_version` hashes only cited evidence, so unrelated future rows cannot alter a fixed as-of result; index memo keyed by evidence version + full effective time. Kept separate: `canonical_player_id`, `player_data_version` (`players:v1:`), `temporal_data_version` (`tm:v1:`), scoring fingerprint (`scoring:v1:`), projection model version, FI version (`fi:2026:w02:…`).

## 24. Performance (production)
Warm requests, 5 samples each: membership historical **0.17–0.23 s**, membership current **0.16–0.19 s** (server-reported `elapsed_ms` 106 for a warm historical build, ~389 ms cold); Matchup 2.0 current **0.18–0.19 s**, historical **0.17–0.18 s** (no regression from the guard); static baseline 0.07–0.09 s. Cold-start outliers (0.7 s / 3.2 s) are function warm-up, not Phase 7 work. Read behavior: **2 Supabase reads per request** (one game-log chunk for the single requested player, one identity row), never one request per player of a population; a career is ≤ ~130 rows against the 1,000-row cap; Role CSV parsed once per (file, mtime); the 129k-row set is never scanned per request; cache keys include effective time. Branch micro-benchmarks (index 5.6 µs vs 1,440 µs naive) re-pass in the suite.

## 25. Tests
- Full merged main (with the new test file): **2,616 total / 2,612 passed / 0 failed / 4 skipped** (branch reference 2,605/2,601/0/4; the +11 are the new production-certification grid).
- Temporal/adversarial: **100** (89 certified + 11 new).
- Focused: Book-Ready 50, Analysis Book 66, Matchup2 48, canonical/providers/weekly-temporal 80, Phase 5 + capture suites 53, Phase 6 scoring 143 — all pass.
- `tsc --noEmit`: clean. eslint on changed/new files: 0 errors, 0 warnings (the 3 known Book-Ready warnings are in unchanged files).
- Production parity harness: identical (§18).

## 26. Fixes made
**None** to runtime code. Test-only addition: `test/temporal-identity-prodcert.test.ts` (11 tests) in the certification commit.

## 27. Remaining limitations
No exact transaction dates (a move is located only between two games; offseason moves appear as a new season's first game) · free-agent gaps unresolved, never inferred · game-level history only for QB/RB/WR/TE/K (≈17.9% of players; none for defenders/linemen) · **no game-level source after 2026 week 1** · no historical depth chart · no roster-status history · no fantasy-ownership history · **P7-F2 unresolved (§8)** · a provider "no team" can still fall back to the snapshot/crosswalk team, labeled `SNAPSHOT_STALE_RISK` (also shown on a Book-Ready current query that supplies no provider id) · Player-Scheme window-team is derived from the last game-level team (approximation of the builder's last charted play) · historical fantasy contexts unavailable (`NON_CURRENT_WEEK_UNSUPPORTED`) · `player_team_temporal_identity` marker not bumped (§21) · RETROSPECTIVE mode is not within-season lookahead-free (`knownThrough` is) · historical FI/Role/Player-Scheme/Matchup2 *features* are not reconstructable as-of (only the team/opponent join) · Phase 5 outcome ingestion absent.

## 28. Next phase
Phase 7: CLOSED
Phase 8: NOT STARTED
