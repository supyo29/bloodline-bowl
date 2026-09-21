# Intelligence Modernization — Phase 7: Temporal Identity / Team Membership

Branch `intelligence-modernization-phase7-temporal-identity` (from `main` @ `6485997`). **Not merged, not deployed.** IDENTITY IS NOT MEMBERSHIP.
Scope note: the task brief was cut off mid-sentence at Step 17 (Player-Scheme integration). Steps 1–16 were executed as written; Step 17 onward (Player-Scheme, Role, Book-Ready, Analysis Book, tests, performance, this record) was completed in the manner of Phases 5–6 and is labelled as inferred wherever it goes beyond the brief.

## 1. Starting state
`main` = `origin/main` = production `dpl_64hwtP7VMG4977FpxLDbPzwM6jvr` @ `6485997` — no drift since Phase 6 closeout. Production six-surface baseline (week 2): supyo29 lineup `028b5cfa785e` / start_sit `39447c7812f5` / waivers `e1bc7d1f993e` / matchup `90606382e513` / leverage `da3177e444c1` / positional_needs `476655a6fc04`; bijimac `cde8cc85ae95` / `4f53cda18c2b` / `e1bc7d1f993e` / `d84c13592d7f` / `4f53cda18c2b` / `67cda0171205`; darthmarker `4b303592297a` / `a28f8533e79e` / `ad0ea2116094` / `ca25bb86cfca` / `fe738e76d4aa` / `2feb4b4a0039`. Phase 5 captures (291 rows) untouched.

## 2. Corrections to the brief's premises (audited, not assumed)
- **`nfl_players` is one row per player, not per player-season**: 24,375 rows, 24,375 distinct GSIS, 0 duplicates. Its only team fact is a single `latest_team`, in a **snapshot dated 2026-03-18** (`updated_at` = `source_synced_at`). It holds **no historical membership**.
- **Real game-level history exists elsewhere**: Supabase `player_lab_game_logs` — 129,657 rows, 2019–2025, weeks 1–22, one row per player-game with `team` and `opponent_team`, 0 null team/opponent, 32 teams, **484 multi-team player-seasons (441 players)**. Plus Role Intelligence's `player_game_role.csv` (2026 week 1 only, 1,200 rows, with `game_id`, `prior_game_team`, `team_changed_since_prior_game`).
- The crosswalk precedence risk is **real and live** (§6). A second, larger defect (the crosswalk loads 266 of 6,053 id-bearing rows) is documented but deliberately **not** fixed here (§7).

## 3. Source-of-truth matrix — "what team is this player on?"
| # | Location / field | Vintage | Temporal scope | Can it drive an opponent join? | Authority | On disagreement |
|---|---|---|---|---|---|---|
| 1 | Sleeper player index `team` → `ObservedPlayer.nfl_team` | live (request time) | current only | via `CanonicalPlayer.nfl_team` (bye, roster health, schedule planning, trades) | authoritative for NOW | **now wins** over #2 (was overridden) |
| 2 | Supabase `nfl_players.latest_team` → crosswalk row `nfl_team` | snapshot 2026-03-18 | current only, stale-risk, code vocabulary `LA` | yes (formerly overwrote #1) | fallback only, normalized | 10.1% of players disagreed with 2026 wk1 participation |
| 3 | Weekly projection feed `team`/`opponent` | weekly | projection-time | weekly path joins on the feed's own opponent (provider-consistent) | provider | n/a |
| 4 | Player-Scheme directory `nfl_team` | as-of PBP cutoff (2025 wk18 team) | historical-as-of | Matchup 2.0 offense team + opponent lookup | descriptive | after normalization agrees with 2026 wk1 for 303/303 overlapping offensive players; 1,027/1,536 rows are `FA` at that vintage |
| 5 | Role `player_game_role.csv` | 2026 wk1 | **game-level** | yes (participation) | strongest current-season evidence | source #1 of the priority policy |
| 6 | Role `player_role_profile.csv` `team` | current season through_week | profile-level | n/a | descriptive | — |
| 7 | Supabase `player_lab_game_logs` | 2019–2025 | **game-level** | yes | game evidence | internally consistent (§10) |
| 8 | Supabase `player_weekly_projections.team` | 2025 run | projection-time claim | **not admitted** | not evidence | only 86.06% agrees with participation; disagreements are neither first/last team nor opponent |
| 9 | `player_data_version` | — | point-in-time hash | n/a | **not** a membership model (unchanged) | — |
Team-code vocabularies observed: Sleeper/Role/FI (`LAR`,`LV`,`SF`,`JAX`), directory (`LVR`,`SFO`,`KCC`,`JAC`,`NEP`,`NOS`,`GBP`,`TBB`, `FA`,`FA*`), game logs / `latest_team` (`LA`).

## 4. Temporal data audit (granularity actually available)
Game-level (week) for 2019–2025 and 2026 wk1. **No** transaction/date-level source, no season-level roster source, no depth-chart source, no PBP roster fields loaded (`nfl_plays` is empty in this database). Therefore no claim finer than "team at a game" is made; a transition is located only as "between game A and game B".

## 5. The contract (`lib/temporal-identity/membership.ts`, `temporal-identity-2026.1`)
`TeamObservation` (gsis_id, season, week, normalized `team`, `no_team`, `raw_team`, `opponent`, `source`, `granularity`, `source_record_id`, `source_vintage`); granularities `GAME_OBSERVED | SEASON_MEMBERSHIP | CURRENT_ONLY` (evidence) and `WEEK_BRACKETED` (a resolution, never evidence); sources `GAME_LOG | ROLE_PARTICIPATION | PROVIDER_CURRENT | CROSSWALK_LATEST_TEAM`. `resolvePlayerTeamAt(gsis, observations, query, opts)` returns one of `SUPPORTED_GAME | SUPPORTED_BRACKETED | SUPPORTED_SEASON | SUPPORTED_CURRENT | AMBIGUOUS_TRANSITION | BRACKET_GAP_TOO_LONG | CONFLICT | NO_TEAM_OBSERVED | NO_EVIDENCE | CURRENT_ONLY_OUT_OF_SCOPE`, with candidates, policy, gap, reasons, evidence ids. `team` is non-null **only** for SUPPORTED_*. Pure: no I/O, clock or network.

## 6. Defect P7-D1 — crosswalk team overrode the live provider team (FIXED)
`buildPlayer` used `row?.nfl_team ?? observed.nfl_team`. Evidence: `latest_team` disagreed with 2026 week-1 participation for **35 of 347 (10.1%)** matched players (A.J. Brown PHI→NE, Jaylen Waddle MIA→DEN, Deebo Samuel WAS→SF, David Njoku CLE→LAC, Justin Fields NYJ→KC, Jauan Jennings SF→MIN, Darnell Mooney ATL→NYG…). **Live production proof**: Puka Nacua's canonical `nfl_team` is `LA` while Sleeper says `LAR` — the crosswalk supplied both a stale-able value and a different code vocabulary, breaking team-keyed joins (bye/schedule). Fix: **observed provider team wins; the crosswalk team is a normalized fallback only when the provider supplied none** (`lib/canonical/players.ts`). Production sizing: 634 canonical players across the 3 live leagues, 26 crosswalk-resolved, **3 differ — all Puka Nacua (`LA`→`LAR`), one per league**. Known residual: when a provider reports no team, the fallback can still surface the snapshot team (unchanged behavior; flagged `SNAPSHOT_STALE_RISK` in the temporal layer).

## 7. Finding P7-F2 — the production crosswalk loads only 266 of 6,053 id-bearing rows (NOT fixed; critical dependency)
`SupabaseCrosswalkSource.load` issues one un-paginated `select`; PostgREST's 1,000-row default returned 266 usable rows (crosswalk stamp `supabase:nfl_players:266`; only 9 of 198 players in the Bloodline state carry a GSIS). **Fixing pagination alone would (a) rewrite ~95% of canonical ids** (`playerId()` prefers GSIS, so `player:sleeper:5872` → `player:gsis:00-0035719`), breaking historical snapshots and captures, and (b) — before P7-D1 — expose the stale-`latest_team` override for ~10% of players. Phase 7 therefore ships the **alias mechanism first** (`lib/temporal-identity/identity-links.ts`: deterministic strong/weak alias sets, `relateIdentities`, `identityLinks`; never mutates a stored id) and the precedence fix. The pagination fix requires a separate, explicitly-authorized id-migration decision.

## 8. Time semantics and source policy
Query `GAME(season, week)` or `CURRENT(season, week)`. Order: exact game evidence → same-season bracket → season-level → (CURRENT only) provider-now → identity snapshot (stale-risk) → nothing. **Priority policy (single, `SOURCE_PRIORITY`)**: `ROLE_PARTICIPATION > GAME_LOG > PROVIDER_CURRENT > CROSSWALK_LATEST_TEAM` — participation (who was on the field) is closer to "represented TEAM in this game" than a stat-log team column; current-only statements are not evidence about a past time at all. The policy only *names* a candidate inside a CONFLICT; consumers never choose their own. **Cross-season inference is never made.**
- **Bracketing**: no game in week W, same team at the nearest games before *and* after in the same season ⇒ `SUPPORTED_BRACKETED` (label `INFERRED_BETWEEN_OBSERVATIONS`, gap exposed). Different teams ⇒ `AMBIGUOUS_TRANSITION` (candidates in chronological order, gap exposed) — never bridged (this is also how free-agency gaps surface: Le'Veon Bell 2021 BAL wk10 → TB wk16, 5 missing weeks).
- **Gap cap (data-justified)**: leave-one-out over all 103,096 interior games in the real source: gaps of 1–3 weeks — **92,952 inferences, 0 wrong**; gaps of 4+ weeks — 9,348 inferences, **2 wrong** (real A→B→A: DeVante Bausby DEN–ARI–DEN 2020, DeAndre Houston-Carson HOU–BAL–HOU 2023). Default `DEFAULT_MAX_BRACKET_GAP_WEEKS = 3`; a longer same-team gap returns `BRACKET_GAP_TOO_LONG` (unresolved). Callers may raise it explicitly.
- **CURRENT**: a provider's statement about now (`SUPPORTED_CURRENT`); differing from the last observed game is a consistent transition, **not** a conflict; provider "no team" ⇒ `NO_TEAM_OBSERVED`; identity snapshot alone ⇒ `SUPPORTED_CURRENT` labelled `SNAPSHOT_STALE_RISK`.
- **Past time with only current-only evidence ⇒ `CURRENT_ONLY_OUT_OF_SCOPE`, no team.**

## 9. Conflicts
Two sources naming different teams for one game ⇒ `CONFLICT`: `team` = null, both candidates with sources listed, the policy's pick exposed as `selected_by_policy` for lineage only; the opponent join is `UNAVAILABLE`. Agreeing sources collapse into one supported fact citing both. A schedule whose rows disagree on a team-week's opponent is `UNKNOWN`, never silently one of them. (Tested.)

## 10. Real-data validation (Steps 12–14)
**Transactions (real, verbatim fixture `test/fixtures/temporal-real-movers.json`, 252 rows / 17 player-seasons)**: McCaffrey 2022 CAR→SF (wk6 CAR, wk7 SF; wk9 bye bracketed SF; opponents follow the effective team: wk6 `LAR` (raw `LA`), wk7 `KC`), Ertz 2021 PHI→ARI, Sanders 2019 DEN→SF, Hopkins 2024 TEN→KC, Meyers 2025 LV→JAX, Dobbs 2023 ARI→MIN, Hardman 2023 NYJ→KC (bracketed across bye/injury), unlocated ambiguous transitions (Bell 2020 NYJ/KC; Carter 2020 HOU/CHI; Bell 2021 BAL/TB). **Offseason**: Cooper DAL(2021)→CLE(2022)→BUF(2024 wk7); a season with no rows or before/after the first/last game is `NO_EVIDENCE` — no other season's team is carried.
**Source integrity over the full 129,657 rows**: 0 player-weeks with two teams; 3,920 team-weeks each with exactly one opponent; **3,920/3,920 (100%) game sides reciprocated** by the opposing team's rows.
**Leave-one-out inference validation (all 103,096 interior games)**: 102,298 correct (99.2%), 796 honestly AMBIGUOUS, **2 wrong** (the A→B→A class above, both excluded by the gap cap); 26,561 one-sided rows are `NO_EVIDENCE`. On the 252 fixture rows: 0 wrong.
**Independent cross-check**: the projection table's per-week `team` agrees with game participation only 86.06% (8,372/9,728) — rejected as a source.
**Normalization-only differences**: `LA`↔`LAR` and the directory vocabulary; handled by `normalizeTeamCode` (one function; Matchup 2.0's private alias table now re-exports it, behavior-identical).

## 11. Opponent resolution (chronology-safe)
`resolveOpponentAt` = effective team at game time (resolver) + schedule ⇒ opponent; **never** current team + historical week. Ambiguous/conflicting/unsupported/too-long membership ⇒ `UNAVAILABLE` with the reasons. Schedule derived from game rows (reciprocity-validated above) or any `ScheduleSource`. (Tested with traded players.)

## 12. Matchup 2.0 integration
Current week: **unchanged**. Historical week (`week` < current NFL week): offense team and opponent come **only** from temporal resolution (Role participation for 2026); otherwise an explicit UNAVAILABLE block ("…not established by game-level evidence…; the current/directory team is never substituted"); a requested opponent that contradicts the schedule for his effective team is refused. No numeric weights; the 13 tested families remain 0 predictive-incremental. Tested live.

## 13. Player-Scheme / Role integration
Audit: the builder's `current_team` window is "career rows on the player's **as-of team**" = the team of his last PBP game at the data cutoff (2025 wk18) — not a leak of today's team, but mislabelled after offseason moves (A.J. Brown's window is his PHI rows). Phase 7 does not alter the R build or any existing Player-Scheme block; it exposes `membership.scheme_window_vintage` (`SAME_TEAM_AS_SCHEME_VINTAGE | TEAM_CHANGED_SINCE_SCHEME_VINTAGE | SCHEME_TEAM_UNKNOWN_AT_VINTAGE | CURRENT_TEAM_UNKNOWN`) alongside the resolved team. Role participation is now an explicit membership source; mixed vintages remain explicit, never resolved by picking the newest-looking team.

## 14. Identity across team changes (Step 9)
Same GSIS person, team A→B: `canonical_player_id` unchanged (tested through `PlayerCrosswalk`), only membership evidence differs. Provider-id identity is also team-independent. **Name-only fallback ids do change with team** (the name key embeds team) — related by the alias set (weak, never a link alone) without touching stored ids.

## 15. Book-Ready / Analysis Book
New topic `player.team_membership` on the one query layer (surface `temporal-team-membership`, one registry entry): blocks `membership.team` (value **or** UNAVAILABLE + reasons + candidates), `membership.candidates`, `membership.opponent`, `membership.scheme_window_vintage`; lineage = resolution identity over evidence ids + policy; DESCRIPTIVE_ONLY, `may_influence_production:false`. Analysis Book: topic registered only — no chapter id added/renamed/enriched, no state changed. **Contract caveat:** Book-Ready's `player_team_temporal_identity` marker and its validator still read `NOT_MODELED_UNTIL_…_PHASE_7`; flipping it is a contract-version decision left to the merge task (blocks from the new topic carry the existing marker).

## 16. Performance
Resolution is a pure filter/sort over one player's rows (~130 rows per player career); no provider calls inside loops; Supabase game logs are fetched per request in chunks of 4 players. The crosswalk fix adds one string comparison per player.

## 17. Production isolation (base `6485997` worktree vs branch, live Sleeper, 3 pairs)
| Pair | Result |
|---|---|
| bloodline-bowl / bijimac | all 6 surfaces identical |
| devoted-to-the-game / darthmarker | all 6 surfaces identical |
| bloodline-bowl / supyo29 | identical in the interleaved reruns (2 rounds; base-vs-base and branch-vs-branch also stable). One earlier back-to-back run showed a `waivers` difference, proven to be transient live waiver-pool drift (not reproducible interleaved). |
The local harness has no Supabase crosswalk, so it cannot exercise the precedence fix; its effect is proven by tests and sized against production (§6: 3 players, all Puka Nacua `LA`→`LAR`). Expected production delta after deployment: those three canonical records; no projection, scoring, lineup or waiver logic changed.

## 18. Tests
Phase 7 adds `test/temporal-identity.test.ts` (32) and `test/temporal-identity-bookready.test.ts` (8): team codes, real mid-season/offseason transactions, ambiguity, gap cap, conflicts, current-only scope, determinism, leave-one-out, row/schedule consistency, identity stability and aliases, crosswalk precedence, Book-Ready blocks, Matchup 2.0 historical guard (live), Player-Scheme vintage flag. Full suite on the branch: **2,556 total / 2,552 passed / 0 failed / 4 skipped** (baseline 2,516; +40); `tsc --noEmit` clean; eslint 0 errors on changed files (2 pre-existing warnings in `manager-context.ts`).

## 19. Limitations
- No exact transaction dates: a transition is located only between two games; **offseason** moves are visible only as the first game of a new season.
- Membership for weeks after 2025 week 22 / 2026 week 1 has no game-level source yet (the 2026 game logs are not in Supabase; Role participation covers week 1 only).
- Free-agent intervals are represented as ambiguous/unresolved gaps, never as proven "no team" (no source states it), except a provider's explicit current no-team observation.
- Depth chart, NFL roster status, fantasy ownership: not modeled (no source / separate layer).
- The crosswalk loads only 4.4% of id-bearing rows in production (P7-F2); canonical ids remain split between `player:sleeper:*` and `player:gsis:*`.
- The provider "no team" + crosswalk-fallback residual (§6).
- `player_data_version` remains a point-in-time hash, deliberately unchanged.
- The Book-Ready `player_team_temporal_identity` marker is unchanged (§15).
- Historical fantasy-league contexts remain refused (`lib/weekly/context.ts` untouched): Phase 7 supplies NFL membership only, not roster/ownership/waiver history.

## 20. Future dependencies
An authorized crosswalk pagination + id-migration (use `identityLinks`); a dated transaction/roster source (exact boundaries, free-agent intervals); 2026 game-level ingestion into `player_lab_game_logs`; a Book-Ready contract version bump for the temporal marker; Phase 5 outcome ingestion (unrelated, still open).

## 21. Certification verdict
**CERTIFIED WITH DOCUMENTED LIMITATIONS** (branch-level). The temporal substrate, the crosswalk-precedence defect fix, the Matchup 2.0 historical guard and the Book-Ready topic are implemented and validated against real data (129,657 game rows; 17 real player-seasons around real transactions); limitations are §19; the two open dependencies that need explicit authorization are P7-F2 (crosswalk pagination / id migration) and the Book-Ready temporal-marker version bump. Certification is qualified by the truncated brief (Step 17 onward inferred). Not merged, not deployed. Phase 8: NOT STARTED.
