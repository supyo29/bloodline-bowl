# Intelligence Modernization — Phase 7: Temporal Identity / Team Membership

Branch `intelligence-modernization-phase7-temporal-identity` (from `main` @ `6485997`). **Not merged, not deployed.** IDENTITY IS NOT MEMBERSHIP.

## 1. Starting Git / production state
2026-09-21 19:37 UTC: local `main` = `origin/main` = production `dpl_64hwtP7VMG4977FpxLDbPzwM6jvr` @ `6485997` — no drift since Phase 6 closeout (0 intervening commits). Phase 5 captures at start: 291 rows (21 LIVE_CAPTURED / 270 LIVE_POST_LOCK), window 14:31:16–14:31:42 UTC 2026-09-21, content digest `e0816ec3a3b9edf2a0b6cd7639fb05c0`, 0 outcomes (no later cron run had occurred). Production six-surface baseline (wk 2) recorded before implementation (supyo29 `028b5cfa785e / 39447c7812f5 / e1bc7d1f993e / 90606382e513 / da3177e444c1 / 476655a6fc04`; bijimac `cde8cc85ae95 / 4f53cda18c2b / e1bc7d1f993e / d84c13592d7f / 4f53cda18c2b / 67cda0171205`; darthmarker `4b303592297a / a28f8533e79e / ad0ea2116094 / ca25bb86cfca / fe738e76d4aa / 2feb4b4a0039`).

## 2. Existing identity architecture
`PlayerCrosswalk.resolve` (GSIS → provider id → name|position|team → name|position → unresolved) builds a `CanonicalPlayer`; `playerId()` prefers GSIS, then sleeper, yahoo, then a name key that **embeds team**. `CanonicalPlayer.nfl_team` (point-in-time) feeds bye/roster-health/schedule/trade logic; `player_data_version` hashes it (a current-snapshot hash, deliberately not repurposed). `lib/weekly/context.ts` refuses non-current weeks (`NON_CURRENT_WEEK_UNSUPPORTED`) — untouched.

## 3. Team-field forensic audit (source-of-truth matrix)
| # | Location / field | Vintage | Scope | Affects opponent join? | Authority | On disagreement |
|---|---|---|---|---|---|---|
| 1 | Sleeper player index `team` → `ObservedPlayer.nfl_team` | live | current only | via `CanonicalPlayer.nfl_team` | authoritative for NOW | **now wins** (was overridden) |
| 2 | `nfl_players.latest_team` → crosswalk row | snapshot 2026-03-18 | current only, stale-risk, vocabulary `LA` | yes (formerly overwrote #1) | normalized fallback only | 10.1% disagreed with 2026 wk1 participation |
| 3 | Weekly projection feed `team`/`opponent` | weekly | projection-time | weekly path joins on the feed's own opponent | provider | n/a |
| 4 | Player-Scheme directory `nfl_team` | as-of PBP cutoff (2025 wk18 team) | as-of | Matchup 2.0 offense team + opponent lookup | descriptive | agrees with 2026 wk1 for 303/303 overlapping players after normalization; 1,027/1,536 are `FA` at that vintage |
| 5 | Role `player_game_role.csv` | 2026 wk1 | **game-level** | yes | source #1 of the policy | — |
| 6 | Role `player_role_profile.csv` `team` | 2026 through wk1 | profile | no | descriptive | **0 contradictions** vs temporal (407/407 where answered) |
| 7 | FI `player_usage_profile.csv` `team` | 2026 through wk2 | profile | no | descriptive | **0 contradictions** (407/407 where answered) |
| 8 | Supabase `player_lab_game_logs` | 2019–2025 | **game-level** | yes | game evidence | internally consistent (§25) |
| 9 | Supabase `player_weekly_projections.team` | 2025 run | projection-time claim | **not admitted** | not evidence | 86.06% agree; not first/last/opponent |
| 10 | Supabase `coach_intel_player_move_impact` | 2019–2025 | derived | **not admitted** | derived from #8 | 3,368/3,368 "joined" rows are exactly game-log transitions — no independent information |
| 11 | `player_data_version` | — | point-in-time hash | n/a | not a membership model | unchanged |
Code vocabularies: Sleeper/Role/FI (`LAR`,`LV`,`SF`,`JAX`), directory (`LVR`,`SFO`,`KCC`,`JAC`,`NEP`,`NOS`,`GBP`,`TBB`,`FA`,`FA*`), game logs / `latest_team` (`LA`).

## 4. Available temporal source inventory (granularity actually present)
Game-level (week): 129,657 rows 2019–2025 (weeks 1–22, team+opponent, 0 nulls, indexed `(gsis_id, season DESC, week DESC)`) + Role participation 2026 wk1 (1,200 rows, 407 with snaps). **No** transaction/date source (`bridge_transaction_ledger` is fantasy transactions), no season-level roster source, no depth-chart source, no PBP roster fields (`nfl_plays` is empty here), `nfl_players` is ONE row per player (24,375 rows, 24,375 distinct GSIS) — the brief's "one row per player/season" premise is false. Finest claim supported: "team at a game"; a transition is located only between two games.

## 5. Temporal contract (`lib/temporal-identity/membership.ts`, `temporal-identity-2026.1`)
`TeamObservation` = gsis_id, season, week, normalized `team`, `no_team`, **raw_team**, opponent, source, granularity, source_record_id, source_vintage. Evidence granularities `GAME_OBSERVED | SEASON_MEMBERSHIP | CURRENT_ONLY`; `WEEK_BRACKETED` is a *resolution*, never evidence. `TeamResolution` = status, team (non-null only for SUPPORTED_*), granularity, evidence_class (`OBSERVED | INFERRED_BETWEEN_OBSERVATIONS | SNAPSHOT_STALE_RISK`), candidates, selected_by_policy, gap_weeks, reasons, evidence_ids, policy, **evidence_version**, **basis** (`RETROSPECTIVE | KNOWN_THROUGH`), **failure_code**. Statuses: `SUPPORTED_GAME|BRACKETED|SEASON|CURRENT`, `AMBIGUOUS_TRANSITION`, `BRACKET_GAP_TOO_LONG`, `CONFLICT`, `NO_TEAM_OBSERVED`, `NO_EVIDENCE`, `CURRENT_ONLY_OUT_OF_SCOPE`. Failure codes: `MEMBERSHIP_UNKNOWN`, `SOURCE_CONFLICT`, `GRANULARITY_INSUFFICIENT`, `TEMPORAL_SOURCE_UNAVAILABLE` (loader-level), `IDENTITY_UNRESOLVED`. Pure: no I/O, clock or network.

## 6. Source priority
One policy, `SOURCE_PRIORITY`: `ROLE_PARTICIPATION > GAME_LOG > PROVIDER_CURRENT > CROSSWALK_LATEST_TEAM`. Participation is closer to "represented TEAM in this game" than a stat-log column; current-only statements are not evidence about a past time. The policy only *names* a candidate inside a CONFLICT; consumers never choose. Resolution order: exact game → same-season bracket → season-level → (CURRENT only) provider-now → identity snapshot (stale-risk) → nothing. **No cross-season inference.**

## 7. Conflict policy
Two sources naming different teams for one game ⇒ `CONFLICT`: `team` = null, all candidates + sources + raw records retained, the policy pick exposed for lineage only, `failure_code SOURCE_CONFLICT`; the opponent join is `UNAVAILABLE`. A raw `LA` vs `LAR` from two sources is one supported fact (normalization-only), not a conflict. (Tested; real sources contain 0 conflicts.)

## 8. Temporal granularity
Season-level evidence would yield `SUPPORTED_SEASON` ("sometime in the season", exact interval unknown); a bracket is labelled `INFERRED_BETWEEN_OBSERVATIONS` with the gap exposed; current-only evidence is never returned for a past time. **Bracket gap cap** (data-justified): leave-one-out over all 103,096 interior games — gaps of 1–3 weeks: 92,952 inferences, **0 wrong**; ≥4 weeks: 9,348 inferences, 2 wrong (real A→B→A: Bausby DEN–ARI–DEN 2020, Houston-Carson HOU–BAL–HOU 2023). Default `DEFAULT_MAX_BRACKET_GAP_WEEKS = 3`; longer ⇒ `BRACKET_GAP_TOO_LONG`.

## 9. Player identity stability
Same GSIS person across offseason change, midseason trade, release (no team), signing, and a historical snapshot ⇒ one `canonical_player_id` (tested through `PlayerCrosswalk`; live: A.J. Brown, Deebo Samuel, Jaylen Waddle, Justin Fields keep one id across clubs). Name-only fallback ids embed the team and change with it — related by a deterministic **alias set** (`identityAliases`, `relateIdentities`, `identityLinks`): strong ids link, a weak name match alone never does. **Collision test**: two "Mike Williams" WRs (NYJ/PIT), no strong ids — a team-qualified name resolves to the matching one only; otherwise `unresolved` (never guessed).

## 10. Crosswalk / current-team precedence (Defect P7-D1 — FIXED)
`buildPlayer` used `row?.nfl_team ?? observed.nfl_team`. Evidence: `latest_team` disagreed with 2026 wk1 participation for **35 of 347 (10.1%)**; **live proof:** Puka Nacua's canonical `nfl_team` was `LA` vs Sleeper `LAR`. Fix: **observed provider team wins; the crosswalk team is a normalized fallback only when the provider gave none.** Production sizing: 634 canonical players / 3 leagues, 26 crosswalk-resolved, **3 differ (all Puka Nacua `LA`→`LAR`)**. Residual: a provider "no team" can still surface the snapshot team (unchanged; flagged `SNAPSHOT_STALE_RISK` in the temporal layer).
**P7-F2 (NOT fixed — needs authorization):** `SupabaseCrosswalkSource` loads only 266 of 6,053 id-bearing rows (PostgREST 1,000-row cap; stamp `supabase:nfl_players:266`). Paginating would rewrite ~95% of canonical ids (`player:sleeper:*` → `player:gsis:*`) and, without P7-D1, expose stale teams. Production today: 634 canonical players, 608 `player:sleeper:*` / 26 `player:gsis:*`, all `stable_id`, **0 name-fallback identities**.

## 11. Free-agent / no-team gaps
A provider's explicit current no-team ⇒ `NO_TEAM_OBSERVED`. A gap between differently-teamed games is `AMBIGUOUS_TRANSITION` (never bridged); a long same-team gap is `BRACKET_GAP_TOO_LONG`. Free-agent intervals are represented as unresolved gaps because no source proves them (real: Le'Veon Bell 2021 BAL wk10 → TB wk16, 5 missing weeks).

## 12. Transaction examples (real, verbatim fixtures)
McCaffrey 2022 CAR→SF (wk6 CAR vs `LAR`, wk7 SF vs KC; wk9 bye bracketed SF); Ertz 2021 PHI→ARI; Sanders 2019 DEN→SF; Hopkins 2024 TEN→KC; Meyers 2025 LV→JAX; Dobbs 2023 ARI→MIN; Hardman 2023 NYJ→KC; unlocated: Bell 2020 NYJ/KC, Carter 2020 HOU/CHI. **Plus a hash-ordered (md5) deterministic sample: 30 mid-season movers, 20 offseason movers (both seasons)** — 585 rows, not hand-picked. Across all ~900 recorded rows: every row resolves to exactly its own team (0 mismatches, 0 conflicts); every recorded opponent equals the opponent derived from (effective team, schedule).

## 13. Team-code normalization
`lib/canonical/team-codes.ts`: one function (`LA/STL→LAR`, `OAK→LV`, `SD/SDG→LAC`, directory codes, `FA`/`FA*`/blank ⇒ no team, unknown codes passed through). **Raw code preserved** on every observation; normalization-only differences are not conflicts. Matchup 2.0's private alias table now re-exports it (behavior-identical). Population: 8,330 game-log rows use `LA`; 937 `latest_team` values need aliasing.

## 14. Persistence architecture (Step 23 outcome A)
Existing source sufficient: a deterministic read/model layer over `player_lab_game_logs` (+ Role participation file). Its `(gsis_id, season DESC, week DESC)` index already serves player+time queries; **no new store, no migration.** Nothing writes; no public writes; rollback = none required. A store would become appropriate only when a dated transaction source exists (Future dependencies).

## 15. Versioning
Distinct: `canonical_player_id` (identity) ≠ `player_data_version` (`players:v1:…`, unchanged) ≠ **`temporal_data_version`** (`tm:v1:…`, over (player, season, week, normalized team, source, granularity, source record); independent of input order, raw-code spelling, vintage labels and queries) ≠ scoring fingerprint (`scoring:v1:…`) ≠ projection model version. Each resolution carries `evidence_version` — the version of the evidence records it **cited**, so unrelated future evidence cannot change a historical result; the index carries the dataset-level version.

## 16. Historical opponent resolution
`resolveOpponentAt` = effective team at game time + schedule ⇒ opponent; never current team + historical week. Ambiguous/conflicting/unsupported/too-long membership ⇒ `UNAVAILABLE` with reasons. Schedule derived from the game rows is 100% reciprocal (3,920/3,920 team-weeks each with exactly one opponent, each reciprocated).

## 17. Matchup 2.0 integration
Current week unchanged. Historical week (< current NFL week): offense team + opponent only from temporal resolution (Role participation for 2026), else an explicit UNAVAILABLE block ("…not established by game-level evidence…; the current/directory team is never substituted"); a requested opponent contradicting the schedule is refused. No numeric weights; the 13 families remain 0 predictive-incremental. Tested live.

## 18. Player-Scheme integration
The builder's `current_team` window is "career rows on the player's **as-of team**" = team of his last PBP game at the cutoff (2025 wk18): not a leak of today's team, but mislabelled after offseason moves. Not rebuilt. `historicalEvidenceContext` and the `membership.scheme_window_vintage` block flag `SAME_TEAM_AS_SCHEME_VINTAGE | TEAM_CHANGED_SINCE_SCHEME_VINTAGE | SCHEME_TEAM_UNKNOWN_AT_VINTAGE | CURRENT_TEAM_UNKNOWN`. Chronology classification of Player-Scheme profiles is preserved.

## 19. Role integration
Role evidence is attributed to the club valid at its effective week via `historicalEvidenceContext(...).role_team`; today's team never relabels past opportunity. Real cross-check: Role profile team vs temporal resolution at its `through_week`: 407 agree, **0 disagree** (793 unanswered: no week-1 participation row).

## 20. Football Intelligence integration
FI is team-based: `fi_join = {offense_team, defense_team = actual opponent, season, week}` from the effective team — FI ratings untouched, FI not activated. Real cross-check: FI usage team vs temporal: 407 agree, **0 disagree**.

## 21. Weekly-context boundary
`NON_CURRENT_WEEK_UNSUPPORTED` untouched and pinned by test (file unchanged; does not import the temporal layer). Phase 7 supplies NFL membership only — not fantasy ownership, lineup, waiver pool, standings, or FAAB history.

## 22. Depth-chart status
No dated depth-chart source exists in the repository or database (audited). `DEPTH_CHART_HISTORY.status = "UNSUPPORTED"`; nothing infers WR1/RB2/starter slots from membership, snaps, projections, names, or a current chart (tested).

## 23. Book-Ready
Topic `player.team_membership` (surface `temporal-team-membership`, one registry entry). Blocks: `membership.team` (value **or** UNAVAILABLE + failure code + reasons + candidates), `membership.candidates`, `membership.opponent`, `membership.scheme_window_vintage`. Lineage carries `temporal_data_version`, policy, evidence ids, basis; components carry status, granularity, evidence class, gap, failure code. Unavailable sources surface as `TEMPORAL_SOURCE_UNAVAILABLE` (absence of a source ≠ absence of evidence). DESCRIPTIVE_ONLY, `may_influence_production:false`. The evidence loader lives in `lib/temporal-identity` (Book-Ready may not touch stores or import persistence — enforced by existing isolation tests). Caveat: Book-Ready's `player_team_temporal_identity` marker/validator still read `NOT_MODELED` until a contract-version bump at merge time.

## 24. Analysis Book
Audited 52 chapters across 3 representative books: 14 HISTORY_LIMITED, 2 CURRENT_ONLY, 4 SOURCE_LAG; **none is limited by team identity** (limits are preserved-snapshot depth, multi-season Role history, coach/OL data, Player-Scheme vintage). Therefore **no chapter state changed**; 99 ids unchanged; the topic is registered and required by no chapter (pinned by test).

## 25. Real-data coverage and validation
| Metric | Value |
|---|---|
| nfl_players total / with GSIS / with sleeper_id / sleeper-or-yahoo | 24,375 / 24,375 / 5,892 / 6,053 |
| players with game-level temporal evidence | **4,365 (17.9%)**; none for 20,010 (defenders, linemen, older) |
| player-seasons / player-games / seasons | 13,953 / 129,657 / 2019–2025 |
| by position (players / player-seasons / games) | QB 163/571/4,819 · RB 358/1,075/11,075 · WR 547/1,665/17,769 · TE 286/897/8,638 · K 88/302/3,914 |
| current-only records (identity snapshot) | 24,375 |
| conflicting periods (same player-week, two teams) | **0** |
| unknown/ambiguous interior periods | bracketable(≤3wk) 92,952 · same-team gap >3wk (unresolved by cap) 9,348 · ambiguous transition 796 · one-sided (no evidence) 26,561 |
| team transitions | 3,369 (511 within-season, 2,858 across seasons) |
| fallback-name identities in production canonical state | 0 of 634 |
| leave-one-out (all 103,096 interior games) | 102,298 correct (99.2%), 796 ambiguous, **2 wrong** (both excluded by the gap cap) |
| **false current-team leakage** | **0** (every one of ~900 real game rows resolved to its own team even with a different `latest_team`/provider-now listed first) |

## 26. Adversarial chronology
- **Strict as-of mode** (`knownThrough`): for every real player-season and every cutoff week, adding/mutating any evidence after T changes **no** result at or before T (>5,000 checked; results and evidence versions byte-identical).
- **Cross-season**: modifying any 2026+ assignment (game, provider-now, snapshot, 2027 rows) changes **no** 2019–2025 result, byte-for-byte, across >1,400 real queries.
- Retrospective mode uses same-season later games to bracket a bye; it is not lookahead-free within a season — which is exactly why `knownThrough` exists (demonstrated by test).
- **Defects found by these tests and fixed:** (1) a resolution's version hashed unrelated future rows → now hashes only cited evidence; (2) `CURRENT_ONLY_OUT_OF_SCOPE` listed today's team in `candidates` for a past week → the value is no longer echoed (only the existence of current-only evidence is stated).

## 27. Production isolation
Base (`6485997`) vs branch, 3 pairs × 2 interleaved rounds: **all six surfaces identical in every round**. The local harness has no Supabase crosswalk, so the P7-D1 effect is proven by tests and sized against production (3 records, Puka Nacua `LA`→`LAR`); expected production delta after deployment = those canonical records only. Import boundary pinned by test: only Book-Ready (topic + family) and the persistence adapter import the temporal layer; weekly/waiver/trades/orchestrator/canonical/matchup2/scoring never do.

## 28. Phase 5 compatibility
No Phase 7 code touches capture code, tables or scoring; the layer has no import of capture stores (tested). Captures at the start: 291 (21/270), digest `e0816ec3…`, unchanged — no later scheduled capture had run at that time. No temporal lineage is added to future captures in this phase (optional; deferred). Outcome ingestion is NOT built; the resolver (`resolvePlayerTeamAt` / `historicalEvidenceContext`) is exposed for a future outcome process.

## 29. Phase 6 compatibility
`lib/scoring`, `lib/weekly/scoring.ts`, `lib/weekly/projections`, `lib/waiver2`, `lib/canonical/scoring-fingerprint.ts`, `lib/weekly/context.ts`: **zero diff** vs base. The scoring fingerprint still identifies league rules, not implementation version; the temporal layer carries its own version and never alters fingerprints.

## 30. Performance (synthetic data with the REAL shape: 129,657 rows / ~3,950 players)
Index build 59 ms (once per evidence set) · single historical resolution 5.6 µs cold, 0.3 µs memo hit · full roster (100 players, one week) 30 µs · 17-week player-season scan 5 µs · historical evidence context 2.3 µs · schedule derivation 48 ms once · **naive per-call scan of all rows 1,440 µs (~257× slower — what the index avoids)** · Role CSV parse 18 ms, mtime-cached. The memo key is (evidence version, player, kind, season, week, options): historical results are never cached against "the current player".

## 31. Tests
`test/temporal-identity.test.ts` (32) + `test/temporal-identity-bookready.test.ts` (10) + `test/temporal-identity-adversarial.test.ts` (30) = 72 temporal/adversarial tests. Full suite, `tsc`, eslint: see the final report.

## 32. Limitations
No exact transaction dates (a move is located only between two games; offseason moves appear as the first game of a new season). Game-level evidence covers only QB/RB/WR/TE/K (17.9% of players) — none for defenders/linemen. No game-level source after 2026 week 1 (2026 game logs are not in Supabase). Free-agent intervals are unresolved, never proven. Depth chart / roster status / fantasy ownership not modeled. P7-F2 open. Provider "no team" + crosswalk fallback residual. Book-Ready marker unchanged until the contract bump. Historical fantasy-league contexts remain refused. Retrospective mode is not within-season lookahead-free (use `knownThrough` for as-known-then).

## 33. Future dependencies
Authorized crosswalk pagination + id migration (using `identityLinks`); a dated transaction/roster source (exact boundaries, free-agent intervals; then a store per Step 23-B/C); 2026 game-level ingestion; Book-Ready contract-version bump for the temporal marker; optional additive temporal lineage on future Matchup2 captures; Phase 5 outcome ingestion.

## 34. Certification verdict
**CERTIFIED WITH DOCUMENTED LIMITATIONS.** All 16 gates pass at branch level: identity stability ✔, temporal correctness ✔, no lookahead (strict + cross-season) ✔, historical opponent safety ✔, conflict honesty ✔, unknown honesty ✔, granularity honesty ✔, current behavior safe (six surfaces identical; one verified correction, P7-D1) ✔, Matchup2 safe ✔, Player-Scheme/Role/FI vintage-explicit ✔, weekly-context boundary ✔, Phase 5 immutability ✔, scoring isolation ✔, Book-Ready ✔, Analysis Book (audited, no change) ✔, performance ✔. Limitations are §32. Not merged, not deployed. Phase 8: NOT STARTED.
