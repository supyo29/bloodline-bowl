# Intelligence Modernization — Phase 7: Temporal Identity / Team Membership

Branch `intelligence-modernization-phase7-temporal-identity` (from `main` @ `6485997`). **Not merged, not deployed.** IDENTITY IS NOT MEMBERSHIP.

## 1. Starting Git / production state
`main` = `origin/main` = production `dpl_64hwtP7VMG4977FpxLDbPzwM6jvr` @ `6485997` (re-verified 2026-09-21 19:57 UTC; 0 intervening commits). Production six-surface baseline (wk 2) recorded before implementation (supyo29 `028b5cfa785e / 39447c7812f5 / e1bc7d1f993e / 90606382e513 / da3177e444c1 / 476655a6fc04`; bijimac `cde8cc85ae95 / 4f53cda18c2b / e1bc7d1f993e / d84c13592d7f / 4f53cda18c2b / 67cda0171205`; darthmarker `4b303592297a / a28f8533e79e / ad0ea2116094 / ca25bb86cfca / fe738e76d4aa / 2feb4b4a0039`).

## 2. Existing identity architecture
`PlayerCrosswalk.resolve` (GSIS → provider id → name|position|team → name|position → unresolved) builds a `CanonicalPlayer`; `playerId()` prefers GSIS, then sleeper, yahoo, then a name key that **embeds team**. `CanonicalPlayer.nfl_team` is point-in-time and feeds bye/roster/schedule/trade logic; `player_data_version` hashes it (a current-snapshot hash, deliberately unchanged and not repurposed). `lib/weekly/context.ts` refuses non-current weeks (`NON_CURRENT_WEEK_UNSUPPORTED`) — untouched.

## 3. Team-field forensic audit (source-of-truth matrix)
| # | Location / field | Vintage | Scope | Drives an opponent join? | Authority | On disagreement |
|---|---|---|---|---|---|---|
| 1 | Sleeper player index `team` → `ObservedPlayer.nfl_team` | live | current only | via `CanonicalPlayer.nfl_team` | authoritative for NOW | **now wins** (was overridden) |
| 2 | `nfl_players.latest_team` → crosswalk row | snapshot 2026-03-18 | current only, stale-risk, vocabulary `LA` | yes (formerly overwrote #1) | normalized fallback only | 10.1% disagreed with 2026 wk1 participation |
| 3 | Weekly projection feed `team`/`opponent` | weekly | projection-time | weekly path uses the feed's own opponent | provider | n/a |
| 4 | Player-Scheme directory `nfl_team` | **2026 (current-season) label** | current | Matchup 2.0 offense team + opponent lookup | descriptive | **NOT the team of the `current_team` window** (§21) |
| 5 | Role `player_game_role.csv` | 2026 wk1 | **game-level** | yes | source #1 of the policy | — |
| 6 | Role `player_role_profile.csv` `team` | 2026 through wk1 | profile | no | descriptive | 0 contradictions vs temporal (407/407 where answered) |
| 7 | FI `player_usage_profile.csv` `team` | 2026 through wk2 | profile | no | descriptive | 0 contradictions (407/407 where answered) |
| 8 | Supabase `player_lab_game_logs` | 2019–2025 | **game-level** | yes | game evidence | internally consistent (§28) |
| 9 | Supabase `player_weekly_projections.team` | 2025 run | projection-time claim | **not admitted** | not evidence | 86.06% agree; not first/last team, not opponent |
| 10 | Supabase `coach_intel_player_move_impact` | 2019–2025 | derived | **not admitted** | derived from #8 | 3,368/3,368 "joined" rows are exactly game-log transitions — no independent information |
| 11 | `player_data_version` | — | point-in-time hash | n/a | not a membership model | unchanged |

## 4. Available temporal-source inventory
Game-level (week): 129,657 rows 2019–2025 (weeks 1–22; team+opponent; 0 nulls; indexed `(gsis_id, season DESC, week DESC)`) + Role participation 2026 wk1 (1,200 rows, 407 with snaps; `prior_game_team` empty on all rows). **No** transaction/date source (`bridge_transaction_ledger` is fantasy transactions), no season-level roster source, **no depth-chart source**, no PBP roster fields (`nfl_plays` is empty here). `nfl_players` is ONE row per player (24,375 rows, 24,375 distinct GSIS) — the brief's "one row per player/season" premise is false. Finest supported claim: "team at a game".

## 5. Temporal contract (`lib/temporal-identity/membership.ts`, `temporal-identity-2026.1`)
`TeamObservation`: gsis_id, season, week, normalized `team`, `no_team`, **raw_team**, opponent, source, granularity, source_record_id, source_vintage. Evidence granularities `GAME_OBSERVED | SEASON_MEMBERSHIP | CURRENT_ONLY`; `WEEK_BRACKETED` is a *resolution*, never evidence. `TeamResolution`: status, team (non-null only for SUPPORTED_*), granularity, evidence_class (`OBSERVED | INFERRED_BETWEEN_OBSERVATIONS | SNAPSHOT_STALE_RISK`), candidates, selected_by_policy, gap_weeks, reasons, evidence_ids, policy, `evidence_version`, `source_vintages`, `basis` (`RETROSPECTIVE | KNOWN_THROUGH`), `failure_code`. Statuses: `SUPPORTED_GAME|BRACKETED|SEASON|CURRENT`, `AMBIGUOUS_TRANSITION`, `BRACKET_GAP_TOO_LONG`, `CONFLICT`, `NO_TEAM_OBSERVED`, `NO_EVIDENCE`, `CURRENT_ONLY_OUT_OF_SCOPE`. **Failure codes**: `MEMBERSHIP_UNKNOWN`, `SOURCE_CONFLICT`, `GRANULARITY_INSUFFICIENT`, `BRACKET_GAP_TOO_LONG`, `CURRENT_ONLY_FOR_HISTORICAL_QUERY`, `TEMPORAL_SOURCE_UNAVAILABLE`, `IDENTITY_UNRESOLVED`. Pure: no I/O, clock or network.

## 6. Source priority
One policy: `ROLE_PARTICIPATION > GAME_LOG > PROVIDER_CURRENT > CROSSWALK_LATEST_TEAM`. Participation is closer to "represented TEAM in this game" than a stat-log column; current-only statements are not evidence about a past time. The policy only *names* a candidate inside a CONFLICT; consumers never choose. Order of resolution: exact game → same-season bracket → season-level → (CURRENT only) provider-now → identity snapshot (stale-risk) → nothing. No cross-season inference.

## 7. Conflict policy
Two sources naming different teams for one game ⇒ `CONFLICT`: `team` = null, all candidates + sources + raw records retained, policy pick exposed for lineage only, `failure_code SOURCE_CONFLICT`; the opponent join is `UNAVAILABLE`. Raw `LA` vs `LAR` from two sources is one supported fact (normalization-only), not a conflict. Real sources contain 0 conflicts; the conflict path is exercised by construction.

## 8. Temporal granularity
Season-level evidence ⇒ `SUPPORTED_SEASON` ("sometime in the season; exact interval unknown"; two clubs ⇒ ambiguous; exact game evidence outranks it; never crosses seasons). A bracket is `INFERRED_BETWEEN_OBSERVATIONS` with the gap exposed. Current-only evidence is never returned for a past time, and its team value is not even echoed in `candidates`. **Bracket gap cap** (evidence-backed): leave-one-out over all 103,096 interior games — gaps of 1–3 weeks: 92,952 inferences, **0 wrong**; ≥4 weeks: 9,348 inferences, 2 wrong (real A→B→A: Bausby DEN–ARI–DEN 2020, Houston-Carson HOU–BAL–HOU 2023). Default `DEFAULT_MAX_BRACKET_GAP_WEEKS = 3`; longer ⇒ `BRACKET_GAP_TOO_LONG`.

## 9. Player identity stability
Same GSIS person across offseason change, midseason trade, release (no team), signing and historical observations ⇒ one `canonical_player_id` (tested through `PlayerCrosswalk`; live: A.J. Brown, Deebo Samuel, Jaylen Waddle, Justin Fields each keep one id across clubs). Name-only fallback ids embed the team and change with it — related by a deterministic **alias set** (`identityAliases`, `relateIdentities`, `identityLinks`): strong ids link, a weak name match alone never does. Collision test: two "Mike Williams" WRs (NYJ/PIT), no strong ids — a team-qualified name resolves to the matching one only; otherwise `unresolved`, never guessed. Historical ids are never rewritten.

## 10. Crosswalk / current-team precedence (Defect P7-D1 — FIXED)
`buildPlayer` used `row?.nfl_team ?? observed.nfl_team`. Evidence: `latest_team` disagreed with 2026 wk1 participation for **35 of 347 (10.1%)** matched players; **live proof:** Puka Nacua's canonical `nfl_team` was `LA` vs Sleeper `LAR`. Fix (`lib/canonical/players.ts`): **observed provider team wins; the crosswalk team is a normalized fallback only when the provider gave none.** Production sizing: 634 canonical players / 3 leagues, 26 crosswalk-resolved, **3 differ (all Puka Nacua `LA`→`LAR`)**. Residual: a provider "no team" can still surface the snapshot team (unchanged behavior; flagged `SNAPSHOT_STALE_RISK` in the temporal layer).

## 11. Crosswalk coverage / pagination finding (P7-F2 — NOT fixed, deliberately)
`SupabaseCrosswalkSource.load` issues one un-paginated `select`; PostgREST's 1,000-row default returned **266 usable rows of 6,053** id-bearing rows (4.4% coverage; crosswalk stamp `supabase:nfl_players:266`). Production today: 634 canonical players → 608 `player:sleeper:*`, 26 `player:gsis:*`, all `stable_id`, 0 name-fallback identities.

## 12. Identity migration risk and recommended strategy
**Scope if paginated:** `playerId()` prefers GSIS, so ~95% of canonical ids (every player whose sleeper/yahoo id is in `nfl_players` but currently missed) would flip from `player:sleeper:5872` to `player:gsis:00-0035719` — breaking historical snapshots, captures, ledger keys and any consumer keyed by canonical id; and without P7-D1 it would also expose the stale `latest_team` for ~10% of players. **Why not fixed:** silent identity change at scale is explicitly prohibited. **Recommended strategy (needs separate authorization):** (1) keep `canonical_player_id` stable and add an *alias-resolution layer* (`identityLinks`) so both forms resolve to one person; (2) paginate the crosswalk load behind a flag, reading ids into `identifiers` **without** changing the canonical id (new field `identity_key` carries the GSIS form); (3) dual-read period comparing both forms across snapshots/captures; (4) migrate consumers to `identity_key`, leaving old ids valid via aliases; (5) only then consider making GSIS the canonical form for *new* records, versioned. P7-D1 (already shipped) is the prerequisite.

## 13. Free-agent / gap policy
A provider's explicit current no-team ⇒ `NO_TEAM_OBSERVED`. A gap between differently-teamed games ⇒ `AMBIGUOUS_TRANSITION` (never bridged); a long same-team gap ⇒ `BRACKET_GAP_TOO_LONG`. Free-agent intervals are never inferred (no source proves them; real: Le'Veon Bell 2021 BAL wk10 → TB wk16, 5 missing weeks).

## 14. Real transaction examples
McCaffrey 2022 CAR→SF (wk6 CAR vs `LAR`, wk7 SF vs KC; wk9 bye bracketed SF); Ertz 2021 PHI→ARI; Sanders 2019 DEN→SF; Hopkins 2024 TEN→KC; Meyers 2025 LV→JAX; Dobbs 2023 ARI→MIN; Hardman 2023 NYJ→KC; unlocated: Bell 2020 NYJ/KC, Carter 2020 HOU/CHI. **Plus a hash-ordered (md5) deterministic sample: 30 mid-season movers and 20 offseason movers with both seasons** (585 rows) and 8 real 2025 players (4 offseason movers + 4 same-team controls). Across ~900 recorded rows: every row resolves to exactly its own team (0 mismatches, 0 conflicts); every recorded opponent equals the opponent derived from (effective team, schedule). **Live**: A.J. Brown 2025 PHI vs DAL → 2026 NE vs SEA; Deebo Samuel WAS vs NYG → SF vs LAR; Jaylen Waddle MIA vs IND → DEN vs KC; Justin Fields NYJ vs PIT → KC vs DEN — identity constant.

## 15. Team normalization
`lib/canonical/team-codes.ts`, one function (`LA/STL→LAR`, `OAK→LV`, `SD/SDG→LAC`, directory codes, `FA`/`FA*`/blank ⇒ no team, unknown codes passed through). **Raw code preserved** on every observation; a normalization-only difference is not a conflict. Matchup 2.0's private alias table now re-exports this function (byte-identical behavior; tested). Population: 8,330 game-log rows use `LA`; 937 `latest_team` values need aliasing.

## 16. Persistence architecture (Step 23 outcome A)
Existing source sufficient: a deterministic read/model layer over `player_lab_game_logs` (+ the Role participation file). Its `(gsis_id, season DESC, week DESC)` index already serves player+time queries. **No Phase 7 persistence migration required.** Nothing writes; no public writes; no rollback needed. A store becomes appropriate only when a dated transaction source exists (§36).

## 17. Temporal versioning
Distinct identities: `canonical_player_id` ≠ `player_data_version` (`players:v1:…`, unchanged) ≠ **`temporal_data_version`** (`tm:v1:…`) ≠ scoring fingerprint (`scoring:v1:…`) ≠ projection model version ≠ FI version (`fi:2026:w02:…`). `tm:v1` hashes (player, season, week, normalized team, source, granularity, source record) — independent of input order, key order, raw-code spelling, vintage labels, serialization and any query. Each resolution carries `evidence_version` (only the evidence records it **cited**, so unrelated future evidence cannot change a historical result) and `source_vintages` (e.g. `GAME_LOG:player_lab_game_logs`, `ROLE_PARTICIPATION:player_game_role.csv`); the index carries the dataset-level version.

## 18. As-of reconstruction
Deterministic: same evidence + same (player, season/week) ⇒ byte-identical output (repeat, shuffled input, and via the index — tested). A historical result never depends on live provider state (adding/removing provider-now or snapshot rows changes nothing). Two modes: **RETROSPECTIVE** (default; uses same-season later games to bracket a bye — not within-season lookahead-free) and **KNOWN_THROUGH** (strict as-of: only evidence at or before the cutoff, current-only excluded).

## 19. Historical opponent resolution
`resolveOpponentAt` = effective team at game time + schedule ⇒ opponent; never current team + historical week. Ambiguous/conflicting/unsupported/too-long membership ⇒ `UNAVAILABLE` with reasons. The schedule derived from game rows is 100% reciprocal (3,920/3,920 team-weeks, each with exactly one opponent, each reciprocated).

## 20. Matchup 2.0 integration
Current week unchanged. A historical week (< current NFL week) takes offense team + opponent only from temporal resolution (Role participation for 2026), else an explicit UNAVAILABLE block ("…not established by game-level evidence…; the current/directory team is never substituted"); a requested opponent contradicting the schedule is refused. No numeric weights; the 13 families remain 0 predictive-incremental. Historical Matchup2 context build 80 ms vs current 78 ms.

## 21. Player-Scheme integration (Step 17) — including a bug found in my first pass
**Audit:** the builder's `current_team` window is "career rows on the player's **as-of team**" (`last_team(...)` = team of his last charted pass/rush play through the cutoff, 2025 wk18) — not a leak of today's team, but a label that reads like "team today". **Finding:** the Player-Scheme *directory* `nfl_team` is a **2026** label (A.J. Brown `NEP`, Deebo `SFO`, Fields `KCC`) while the window rows are the **2025** club's (PHI, WAS, NYJ). My first-pass `scheme_window_vintage` compared the directory to today's team and would have reported "SAME" for exactly the players it warns about. **Fix:** `schemeAsOfTeam` derives the window's team from temporal evidence (last game-level team at/before the cutoff); real check: 4 movers ⇒ `TEAM_CHANGED_SINCE_SCHEME_VINTAGE`, 4 same-team controls (Nacua raw `LA`, Nix, Jefferson, Chase) ⇒ `SAME_TEAM_AS_SCHEME_VINTAGE`. **Every Player-Scheme evidence block now carries** the limitation "`current_team` = career rows on the player's AS-OF team at the source cutoff…, NOT the team he is on today… (see `player.team_membership` → `membership.scheme_window_vintage`)"; the membership block also states the directory label is a different, current-season label. Methodology, data and chronology classification unchanged. Approximation: the R builder uses the last charted play's team; a last game-level team differs only if he changed clubs between those two points.

## 22. Role integration (Step 18)
`historicalEvidenceContext(...).role_team` attributes Role evidence to the club valid at the effective week. Tests (real): **offseason mover** A.J. Brown 2025 wk9 PHI vs 2026 wk1 NE (Role availability UNAVAILABLE for 2025, AVAILABLE_AS_OF for 2026 wk1); **same-team control** Puka Nacua LAR/LAR (raw `LA`→`LAR`, no false change); **mid-season**: Role preserves only 2026 wk1 and `prior_game_team` is empty on all 1,200 rows, so a 2026 wk2 membership is `NO_EVIDENCE` with Role `SOURCE_LAG` — explicitly history-limited. Role profile team vs temporal: 407 agree / 0 disagree (793 unanswered: no wk1 participation row).

## 23. Football Intelligence integration (Step 19)
`fi_join = {offense_team, defense_team = the game's actual opponent, season, week}` from the effective team (e.g. Deebo 2026 wk1 `SF` vs `LAR`; 2025 wk1 `WAS` vs `NYG`). FI ratings untouched; FI not activated. FI usage team vs temporal: 407/407 agree. **Historical availability (Step 37):** `historicalEvidenceAvailability` states, from the served manifests, that the join is safe but the *features* are not reconstructable as-of: FI `HISTORY_LIMITED` (2026, one cumulative state) / `UNAVAILABLE` (earlier seasons); Player-Scheme `HISTORY_LIMITED` (cumulative through 2025 wk18) / `SOURCE_LAG` (2026); Role `AVAILABLE_AS_OF` for 2026 wk1, else `UNAVAILABLE`/`SOURCE_LAG`; **Matchup 2.0 `UNAVAILABLE`** for historical games.

## 24. Weekly-context boundary
`NON_CURRENT_WEEK_UNSUPPORTED` is untouched and pinned by test (the file is unchanged and does not import the temporal layer). A chronology-safe NFL team lookup is not a historical fantasy-league snapshot: ownership, lineup, waiver pool, standings and FAAB history do not exist.

## 25. Depth-chart status (Step 21)
**No dated depth-chart source exists** in the repository or database (audited: no table, no column, no CSV field). `DEPTH_CHART_HISTORY.status = "UNSUPPORTED"`. Nothing infers WR1/RB2/QB1/starter/backup/handcuff from membership, snap share, projections, names or today's chart (source scan test). Historical depth-chart order remains unsupported.

## 26. Book-Ready
Topic `player.team_membership` (surface `temporal-team-membership`, one registry entry; answers CURRENT and as-of). Blocks: `membership.team` (value **or** UNAVAILABLE + failure code + reasons + candidates), `membership.candidates`, `membership.opponent`, `membership.scheme_window_vintage`. Components/lineage expose: canonical identity (subject), requested season/week (temporal), resolved team + normalized/raw code (candidates/raw), source, granularity, evidence class, `temporal_data_version`, `source_vintages`, basis, gap, failure code, policy, evidence ids, limitations. Unavailable sources ⇒ `TEMPORAL_SOURCE_UNAVAILABLE`; unknown ids ⇒ `IDENTITY_UNRESOLVED`; conflicts/ambiguity ⇒ UNAVAILABLE with all candidates listed. DESCRIPTIVE_ONLY, `may_influence_production:false`. The evidence loader lives in `lib/temporal-identity` (Book-Ready may not import persistence or mention stores — enforced by existing isolation tests). Caveat: Book-Ready's `player_team_temporal_identity` marker/validator still read `NOT_MODELED` until a contract-version bump at merge time.

## 27. Analysis Book
Audited 52 chapters across 3 representative books (READY 11, HISTORY_LIMITED 14, UNSUPPORTED 14, CURRENT_ONLY 2, SOURCE_LAG 4, UNAVAILABLE 4, PARTIAL 2, CONDITIONAL 1); **none is limited by team identity** (limits: preserved-snapshot depth "only 1 complete week", multi-season Role history, coach/OL data, Player-Scheme vintage). **Chapter ids before = after = 99; no chapter state changed; no enrichment attached**; the topic is registered and required by no chapter (pinned by test). Coach identity, depth-chart roles, CB assignment and personnel remain limited by their own missing data.

## 28. Real-data coverage and validation
| Metric | Value |
|---|---|
| source rows / distinct players / seasons / games | 129,657 / 4,365 / 2019–2025 / 13,953 player-seasons |
| strong stable identities (nfl_players) | 24,375 GSIS · 5,892 sleeper_id · 6,053 sleeper-or-yahoo |
| by position (players / player-seasons / games) | QB 163/571/4,819 · RB 358/1,075/11,075 · WR 547/1,665/17,769 · TE 286/897/8,638 · K 88/302/3,914 |
| players with game-level evidence | **17.9%**; **missing for 20,010** (defenders, linemen, older) |
| current-only records | 24,375 (identity snapshot) |
| team transitions / multi-team player-seasons | 3,369 (511 within-season, 2,858 across seasons) / 484 (441 players) |
| conflicting periods | **0** |
| ambiguous transition weeks / long-gap same-team (rejected by cap) / one-sided | 796 / 9,348 (9.1% of same-team brackets) / 26,561 |
| A→B→A sequences | 2 |
| normalization-only cases | 8,330 game-log rows (`LA`) · 937 `latest_team` values |
| fallback/name-only identities (production canonical) | **0 of 634** |
| leave-one-out (all 103,096 interior games) | 102,298 correct (99.2%) · 796 ambiguous · **2 wrong** (excluded by the cap) |
| **actual wrong-team rate with the cap** | **0** in 92,952 cap-eligible inferences |
| **false current-team leakage** | **0** (every one of ~900 real game rows resolved to its own team even with a different latest_team/provider-now listed first) |
Questions Phase 7 supports: "which club did this QB/RB/WR/TE/K play for in game G (2019–2025, 2026 wk1) and who was the opponent". It does not support defenders, exact transaction dates, or 2026 weeks after 1.

## 29. Adversarial chronology
- **Strict as-of** (`knownThrough`): for every real player-season and every cutoff week, adding/mutating any evidence after T changes **no** result at or before T (>5,000 checked; results and evidence versions byte-identical).
- **Cross-season**: modifying any 2026+ assignment (game, provider-now, snapshot, 2027 rows) changes **no** 2019–2025 result, byte for byte (>1,400 real queries). The mere presence of current-only evidence never changes a resolved answer.
- **latest_team leakage**: zero (above); where no game evidence exists the answer is unresolved, never the snapshot team.
- **Defects found by these tests and fixed:** (1) a resolution's version hashed unrelated future rows → now hashes only cited evidence; (2) `CURRENT_ONLY_OUT_OF_SCOPE` listed today's team in `candidates` for a past week → the value is no longer echoed.

## 30. Production isolation
Base (`6485997`) vs branch, 3 pairs × 2 interleaved rounds, run twice during this phase (before and after the full-brief changes): **all six surfaces identical in every round**. The local harness has no Supabase crosswalk, so the P7-D1 effect is proven by tests and sized against production (3 records, Puka Nacua `LA`→`LAR`); expected production delta after deployment = those canonical records only. One earlier back-to-back run showed a `waivers` difference for supyo29, proven transient live waiver-pool drift (interleaved reruns identical, base-vs-base also stable). Import boundary pinned by test: only Book-Ready (topic + family) and the persistence adapter import the temporal layer; weekly/waiver/trades/orchestrator/canonical/matchup2/scoring never do.

## 31. Phase 5 compatibility
Phase 7 code contains no capture-store, capture-code or table access (import scan test; `git diff` touches no capture file). Persisted captures re-verified 2026-09-21 19:57 UTC: 291 rows, the digest over the original rows (`captured_at ≤ 14:31:43`) is `e0816ec3a3b9edf2a0b6cd7639fb05c0` — unchanged; this check (digest of the *original* rows) remains valid even after later cron runs add rows. No temporal lineage is added to captures; historical rows are not rewritten. Outcome ingestion is NOT built; `resolvePlayerTeamAt` / `historicalEvidenceContext` are the seam a future outcome process can use.

## 32. Phase 6 compatibility
`lib/scoring`, `lib/weekly/scoring.ts`, `lib/weekly/projections`, `lib/waiver2`, `lib/canonical/scoring-fingerprint.ts`, `lib/weekly/context.ts`: **zero diff** vs base. The scoring fingerprint still identifies league rules, not implementation version; temporal versions are a separate identity.

## 33. Performance
Synthetic data with the REAL shape (129,657 rows / ~3,950 players): index build 59 ms (once per evidence set) · one historical resolution 5.6 µs cold, 0.3 µs memo hit · full roster (100 players) 30 µs · 17-week player-season scan 5 µs · historical evidence context 2.3 µs · schedule derivation 48 ms once · **naive per-call scan of all rows 1,440 µs (~257× slower)** · Role CSV parse 18 ms, cached by (file, mtime). In-process requests (no Supabase locally): Book-Ready `player.team_membership` 24–28 ms; historical Matchup2 context 80 ms vs current-week 78 ms. The memo key is (evidence version, player, kind, season, week, options) — never the player alone. Production adds one chunked Supabase read per request (not measured locally).

## 34. Tests
Temporal/adversarial: `temporal-identity.test.ts` (32) + `temporal-identity-bookready.test.ts` (10) + `temporal-identity-adversarial.test.ts` (30) + `temporal-identity-integration.test.ts` (17) = **89**. Full-suite, `tsc`, eslint figures are in the final report.

## 35. Limitations
No exact transaction dates (a move is located only between two games; offseason moves appear as the first game of a new season). Game-level evidence exists for QB/RB/WR/TE/K only (17.9% of players) — none for defenders/linemen; no game-level source after 2026 week 1 (2026 game logs are not in Supabase). Free-agent intervals are unresolved, never proven. **Historical depth-chart order is unsupported (no source)**; roster status and fantasy ownership are not modeled. P7-F2 (crosswalk coverage / id migration) open. Provider "no team" + crosswalk fallback residual. Book-Ready temporal marker unchanged until the contract bump. Historical fantasy-league contexts remain refused. RETROSPECTIVE mode is not within-season lookahead-free (use `knownThrough`). Player-Scheme window team is derived from the last game-level team (approximation vs the builder's last charted play). Historical FI/Role/Player-Scheme/Matchup2 *features* are not reconstructable as-of; only the team/opponent join is.

## 36. Future dependencies
Authorized crosswalk pagination + id migration (§12); a dated transaction/roster source (exact boundaries, free-agent intervals; then a store per Step 23-B/C); 2026 game-level ingestion into Supabase; Book-Ready contract-version bump for the temporal marker; optional additive temporal lineage on future Matchup2 captures; a dated depth-chart source (for any depth-order claim); Phase 5 outcome ingestion.

## 37. Certification verdict
**CERTIFIED WITH DOCUMENTED LIMITATIONS.** All 16 gates pass at branch level: identity stability ✔ · temporal correctness ✔ · no lookahead (strict + cross-season + latest_team) ✔ · historical opponent safety ✔ · conflict honesty ✔ · unknown honesty ✔ · granularity honesty ✔ · current behavior safe (six surfaces identical; one verified correction, P7-D1) ✔ · Matchup2 safe ✔ · Player-Scheme/Role/FI vintage-explicit (label no longer implies team-today) ✔ · weekly-context boundary ✔ · Phase 5 immutability ✔ · scoring isolation ✔ · Book-Ready ✔ · Analysis Book (audited, no change) ✔ · performance ✔. Limitations are §35; the crosswalk migration finding is §11–12. Not merged, not deployed. Phase 8: NOT STARTED.
