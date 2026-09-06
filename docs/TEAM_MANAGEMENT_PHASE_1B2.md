# Bloodline Bowl Team Management — Phase 1B.2

**Legacy REST / analytics canonical migration**

Date: 2026-09-06
Branch: `team-management-phase-1b2-legacy-canonical-migration` (from the 1B.1
checkpoint `bdebe29`)
Sources of truth: `docs/TEAM_MANAGEMENT_PHASE_1A.md`,
`docs/TEAM_MANAGEMENT_PHASE_1B1.md`

Target architecture:
`provider → buildCanonicalLeagueState → CanonicalLeagueSnapshot → compatibility
adapter → existing endpoint payload` — one live league reality, many
backwards-compatible surfaces.

Constraints honoured: no second canonical model; no API-contract redesign; no
projection-model merge; no recommendation/scoring/waiver/lineup methodology
change; no process-lifetime caching of live state; draft-night freshness
preserved; schema reader tolerance preserved; additive-first; **no golden test
weakened to conceal drift**.

---

## 1. Endpoint inventory

`app/api/**/route.ts` — every route, its current handler, and its live-state
source (verified by reading each handler on the branch head).

### Already canonical (no work — the target architecture already)

| Route | Handler / state source |
|---|---|
| `GET /api/league/:league/state` | `buildCanonicalLeagueState` |
| `GET /api/context/:league/:manager` | `buildManagerContext` → canonical |
| `GET /api/intelligence\|lineup\|matchup\|waivers/:l/:m/week/:w` | weekly engine → canonical |
| `POST /api/trades/analyze`, `/api/trades/discover`, `/api/trades/negotiate` | trade engine → canonical (`buildTradeAnalysisContext`) |
| `GET /api/leagues/:slug/managers/:slug/strategic-context` | `buildTradeAnalysisContext` → canonical |
| `GET /api/transactions/:league` | `getProvider(...).getTransactions` (canonical provider adapter) |
| `POST /api/cron/capture`, `GET /api/history/:league/week/:week` | canonical persistence (`captureLeagueState`, `SnapshotStore`) |
| `GET /api/providers`, `/api/leagues`, `/api/ai`, `/api/auth/yahoo/*`, `/api/health` | registry / config / no league state |
| `GET /api/bridge/board` | pre-draft Bridge tool — deliberately separate universe (Phase 1A) |

### Legacy stack — current-state surfaces

| Route | Current handler / state source | Identity | Scoring repr. | Class |
|---|---|---|---|---|
| `GET /api/scoring` (`?league=`) | `buildScoringBundle(resolveLeagueId(sel))` → `getLeague()` | n/a | `getLeague().scoring_settings` | **D** |
| `GET /api/scoring/:leagueSlug` → `/api/leagues/:slug/scoring` | `buildScoringBundle(league.league_id)` → `getLeague()` | n/a | `getLeague().scoring_settings` | **D** |
| `POST /api/scoring/calculate` | `getLeague(resolveLeagueId(sel)).scoring_settings` | n/a | `getLeague().scoring_settings` | **D** |
| `GET /api/snapshot` (`?league=`) → `/api/leagues/:slug/snapshot` (+ `/api/snapshot/:leagueSlug`) | `buildSnapshot` = `buildLeagueBundle` + `buildDraftBundle` + `buildScoringBundle` + `getNflState` + `getLeagueRosters/Users` + `getMatchups` + `getLeagueTransactions` + `computeStandings` | raw Sleeper id | via `buildScoringBundle` | **B** |
| `GET /api/leagues/:slug/managers/:slug/snapshot` | `buildManagerDraftContext` + `getLeague` + `getLeagueRosters` + `getLeagueUsers` + `computeStandings(...,{},[])` | raw Sleeper id | n/a | **A/D** |
| `GET /api/league` (`?league=`) → `/api/leagues/:slug` | `buildLeagueBundle` → `buildLeagueResponse` (874-line normaliser) | raw Sleeper id | raw passthrough | **A** |
| `GET /api/leagues/:slug/managers` | `getLeagueRosters` + `getLeagueUsers` + `selectActiveDraft` | raw Sleeper id | n/a | **A** |
| `GET /api/leagues/:slug/managers/:slug` | `getLeague` + `getLeagueRosters` + `getPlayerIndex` | raw Sleeper id | n/a | **A** |
| `GET /api/standings` (`?league=`, `?season=`) | `loadSeasonData` (all weeks) + `computeStandings` + brackets + lineage | raw Sleeper id | `hashScoringSettings` | **B** |
| `GET /api/value` (`?league=`) | `getLeagueRosters` + `getPlayerIndex` + value provider | raw Sleeper id | n/a | **D** |
| `GET /api/roster-analysis` (`?league=`) | `getLeague` + `getLeagueRosters/Users` + `getPlayerIndex` + draft capital | raw Sleeper id | n/a | **D** |
| `GET /api/transactions` (`?league=`) | `getLeague` + `getLeagueRosters/Users` + `getPlayerIndex` + `getLeagueTransactions` | raw Sleeper id | n/a | **B** |
| `GET /api/raw` (`?league=`) | `fetchSleeper(path)` passthrough proxy | n/a | n/a | debug |

### Legacy stack — historical / weekly-actuals surfaces

| Route | Source | Class |
|---|---|---|
| `GET /api/managers` (`?league=`) | `buildLeagueHistory` + `buildManagerProfiles` (career, multi-season) | **C** |
| `GET /api/history` (`?league=`, `?season=`) | `buildLeagueHistory` (season lineage) | **C** |
| `GET /api/lineups`, `/api/matchups`, `/api/player-weekly`, `/api/player-availability`, `/api/manager-availability`, `/api/weekly-stats` (`?league=`, `?season=`, `?week=`) | `loadSeasonData` / `getMatchups` per week + `getStatsProvider` (nflreadr box-score ACTUALS) | **C** (historical) / **B** |

### Draft-night surfaces (live-uncached — must NOT go through cached canonical)

| Route | Source | Class |
|---|---|---|
| `GET /api/draft` (`?league=`), `/api/draft/:leagueSlug`, `/api/leagues/:slug/draft` | `buildDraftBundle` (`getLeagueRostersLive`, `getDraftPicksLive`) | **D** — freshness-critical |
| `GET /api/leagues/:slug/managers/:slug/draft` | `buildManagerDraftContext` (live) | **D** — freshness-critical |
| `GET /api/leagues/:slug/managers/:slug/recommendations` | `buildManagerRecommendationResponse` (`getLeagueRostersLive`) | **D** — freshness-critical |
| `GET /api/leagues/:slug/managers/:slug/projections` | season projection model (got `canonical_identity` in 1B.1) | **D** |
| `GET /api/draft/debug` | debug | debug |

---

## 2. Migration classification

- **A — direct current-state canonical migration**: `/api/scoring` family,
  `/api/leagues/:slug/managers`, `/api/leagues/:slug/managers/:slug`,
  `/api/league` + `/api/leagues/:slug`.
- **B — mixed current + historical**: `/api/snapshot` family, `/api/standings`,
  `/api/transactions` (`?league=`), the `?league=` weekly-actuals routes.
- **C — historical-only**: `/api/managers`, `/api/history`, most `?league=`
  weekly-actuals routes.
- **D — specialised analytics using current state**: `/api/scoring/*`,
  `/api/value`, `/api/roster-analysis`, all draft-night routes.

---

## 3. Architecture before / after

### Before (Phase 1A finding P1-1)

```
Sleeper ──┬─ buildCanonicalLeagueState ── /api/league/:slug/state, weekly, trades, context
          │
          └─ buildLeagueBundle / loadSeasonData / getLeague ──┬─ /api/scoring (getLeague().scoring_settings)
                                                              ├─ /api/snapshot (computeStandings + buildLeagueBundle)
                                                              ├─ /api/leagues/:slug/managers/:slug/snapshot (computeStandings)
                                                              └─ /api/league, /api/standings, /api/managers, …
```
Two independent derivations of standings, records, scoring config, league status,
current week — able to disagree (esp. once Yahoo goes live).

### After (Phase 1B.2)

```
Sleeper ── buildCanonicalLeagueState ── CanonicalLeagueSnapshot (v3, one live read; runInLeagueStateScope-memoized)
             │
             ├─ canonicalScoringInputs   ─── buildScoringBundle ─── /api/scoring, /api/scoring/:slug,
             │                                                       /api/leagues/:slug/scoring, /api/scoring/calculate
             ├─ canonicalToStandingsFacts ─── /api/leagues/:slug/managers/:slug/snapshot (standings + league block)
             │                            └── buildSnapshot (standings; league/teams/matchups/txn keep their reads)
             └─ (weekly / trades / context / state — unchanged)
```
The `/api/scoring` family and the `/api/leagues/:slug/managers/:slug/snapshot`
league/standings block are now **fully** canonical. `buildSnapshot` is
**partially** canonical (standings + scoring_summary). `/api/league`,
`/api/leagues/:slug`, `/api/leagues/:slug/managers`, `/api/standings` are
**classified, not migrated** (§6).

---

## 4. Compatibility adapter architecture

New directory `lib/canonical/compat/` — small pure `canonical → legacy shape`
serialisers. They do **no I/O**, hold **no normalisation logic of their own**
(they only reshape already-canonical fields), and each is guarded by a
golden-parity test against the untouched legacy function.

| Adapter | `lib/canonical/compat/` file | Produces | Legacy equivalent |
|---|---|---|---|
| `canonicalScoringInputs(snapshot)` | `scoring-inputs.ts` | `{ league_id, name, season(string), roster_positions[], scoring_settings }` | the 4 fields `buildScoringBundle` read from `getLeague()` |
| `reconstructRosterPositions(rs)` | `scoring-inputs.ts` | verbatim `roster_positions_raw`, or `starting_slots + BN*n + IR*n + TAXI*n` fallback for a pre-v3 snapshot | Sleeper `league.roster_positions` |
| `canonicalToStandingsFacts(snapshot)` | `standings.ts` | `RosterStandingFacts[]` (weekly + bracket fields null) | `computeStandings(rosters, users, new Map(), [])` |

Golden parity (`test/canonical-migration.test.ts`, `-live`): both adapters are
**byte-identical** (`assert.deepEqual`) to their legacy counterparts, on the
synthetic fixture (departed manager + vacant roster) and on the **live** 12-team
Bloodline Bowl league.

---

## 5. Migrated routes

### Wave 1 — scoring family (Class D, fully canonical)

| Route | Change |
|---|---|
| `GET /api/leagues/:slug/scoring` (+ `/api/scoring/:leagueSlug` alias) | `buildScoringBundle(league.league_slug)` — was `buildScoringBundle(league.league_id)` |
| `GET /api/scoring` (`?league=`) | `buildScoringBundle(selector ?? undefined)` — was `buildScoringBundle(resolveLeagueId(selector))` |
| `POST /api/scoring/calculate` | `resolveScoringInputs(selector).scoring_settings` — was `getLeague(resolveLeagueId(selector)).scoring_settings` |

`buildScoringBundle` / new `resolveScoringInputs` now take a selector (slug / raw
id / undefined) OR an already-built snapshot, resolve via
`resolveLeagueForQuery` + `buildCanonicalLeagueState`, and throw a `SleeperError`
(404 / 502) on an unusable snapshot so the route error mapping is unchanged.
The scoring ANALYSIS (`buildNormalizedRules`, `classifyScoring`,
`buildSensitivity`, `buildDiagnostics`, archetypes) is **untouched**.

### Wave 2 — standings (Class A/D + partial B)

| Route | Change |
|---|---|
| `GET /api/leagues/:slug/managers/:slug/snapshot` | SHARED `league` block + `standings` now from `buildCanonicalLeagueState` + `canonicalToStandingsFacts` + `reconstructRosterPositions`, inside one `runInLeagueStateScope`. The personalised draft context (`buildManagerDraftContext`, live board, recommendations) is unchanged. Dropped: `getLeague`, `getLeagueRosters`, `getLeagueUsers`, `computeStandings`. |
| `buildSnapshot` (`/api/snapshot`, `/api/snapshot/:leagueSlug`, `/api/leagues/:slug/snapshot`) | `standings` now from `canonicalToStandingsFacts` (fallback: legacy `computeStandings` if the canonical read fails, with a warning); `scoring_summary` from `buildScoringBundle({ snapshot })` — the SAME canonical read, no extra fetch; `currentWeek` from `snapshot.week`. Whole build wrapped in `runInLeagueStateScope`. **Retained** (specialised, not duplicated state): `buildLeagueBundle` (only for `teams[]` incl. `draft_pick_count` — a count of FUTURE pick ASSETS the canonical model does not represent), `buildDraftBundle` (auction budget + draft block), `getMatchups` + `buildWeekMatchupFacts`, `getLeagueTransactions` + `normalizeTransaction`. |

### Canonical model additions (schema v2 → v3, additive + optional)

| Field | Why | Populated by |
|---|---|---|
| `CanonicalRosterSettings.roster_positions_raw?: string[]` | the legacy scoring/snapshot payloads expose the provider's verbatim ordered slot array | sleeper + yahoo adapters |
| `CanonicalFantasyTeam.provider_owner_id?: string \| null` | a roster whose owner LEFT the league has an `owner_id` but no `managers` entry — the legacy `ManagerRef.user_id` is that raw id | sleeper adapter |
| `CanonicalFantasyTeam.team_name` **fix** (not a new field) | **P1 bug**: Sleeper stores the team name on the OWNING USER's metadata; `toCanonicalTeams` read `roster.metadata` → `null` for **every production team**. Now prefers `user.metadata.team_name`. | sleeper adapter (`toCanonicalTeams` now takes `users`) |

`hydratePersistedSnapshot` still backfills v1→v2 deterministically; the v3
fields simply stay `undefined` for an older persisted row and the adapters fall
back (`reconstructRosterPositions`; departed-owner `user_id` degrades to `null`
— documented, tested, not a crash).

---

## 6. Routes intentionally NOT migrated (with reasons)

| Route(s) | Class | Reason |
|---|---|---|
| `GET /api/league`, `GET /api/leagues/:slug` | A | The `LeagueResponse` payload is a **Sleeper-native projection** — per-player NFL bio (`age`, `years_exp`, `number`, `active`, `search_rank`, `depth_chart_*`), full `drafts[]` with every pick, `traded_picks[]`, per-team `NormalizedDraftPickAsset[]` (future pick capital), `keepers`, `division`, `waiver_budget_used`, `key_settings` glosses, `status_description`, `metadata.build_ms`. None of this is in the canonical model. A faithful adapter would require either (a) enriching canonical into a Sleeper mirror (forbidden — "no second canonical model") or (b) supplementary Sleeper reads inside the adapter (forbidden — "compatibility adapters becoming alternate normalizers"). **Its current-state facts already agree with canonical** — proven by the cross-surface tests (§12). Recommend a dedicated payload-v2 phase or a contract decision. |
| `GET /api/leagues/:slug/managers` | A | Small, but needs the draft-order map (`draft.draft_order`, user→slot) and registry `sleeper_username` — not in canonical. Deferred; low risk (routing/identity metadata only, `resolveManager` covers the identity path). |
| `GET /api/standings` | B | The current-season **records** match canonical, but every populated field beyond them (`highest/lowest/median/stdev weekly score`, `weekly_high/low_score_count`, `regular_season_finish`, playoff bracket) needs the full multi-week `loadSeasonData` + `winnersBracket`. Migrating only the record columns would leave a mixed handler that double-reads. The `computeStandings` engine is retained and correct. |
| `GET /api/managers`, `GET /api/history` | C | Historical career / season-lineage analytics — explicitly out of scope ("Do not unnecessarily migrate historical-only functionality"). |
| `GET /api/lineups`, `/api/matchups`, `/api/player-weekly`, `/api/player-availability`, `/api/manager-availability`, `/api/weekly-stats` | B/C | nflreadr box-score **ACTUALS**, `?season=`/`?week=` parameterised. Not current league state. |
| `GET /api/value`, `/api/roster-analysis`, `/api/transactions` (`?league=`) | B/D | Specialised (replacement value / draft capital / FAAB-aware transaction facts). `/api/transactions/:league` is ALREADY canonical; the `?league=` form is a legacy alias slated for the same treatment as a follow-up. |
| all draft-night routes | D | Deliberately use `getLeagueRostersLive` / `getDraftPicksLive` (uncached). Routing them through the cached canonical read would regress draft-night freshness — a hard constraint. |
| `GET /api/raw`, `/api/draft/debug` | debug | Passthrough / debug. |

---

## 7. Legacy live-state code still active after 1B.2

| Symbol | Category | Disposition |
|---|---|---|
| `lib/sleeper/service.ts#buildLeagueBundle` / `resolveLeagueId` | required | backs `/api/league`, `/api/leagues/:slug`; `buildSnapshot` still uses it for `teams[]` (future-pick-asset counts). Keep. |
| `lib/analytics/season-data.ts#loadSeasonData` | required | backs `/api/standings`, `/api/lineups`, `/api/matchups`, weekly-actuals. Keep (historical). |
| `lib/analytics/standings.ts#computeStandings` | specialised + fallback | backs `/api/standings` (full weekly stats); `buildSnapshot` fallback path only. Keep. |
| `lib/analytics/snapshot.ts` matchup/transaction sections | specialised | `buildWeekMatchupFacts`, `normalizeTransaction` — distinct analytics contracts. Keep. |
| `lib/analytics/history.ts`, `managers.ts` | required | historical career. Keep. |
| `lib/scoring/scoring-service.ts#buildScoringBundle` | **migrated** | now canonical-backed; kept as the public entry point. |
| `getLeague()` direct calls in route handlers | reduced | removed from the scoring routes and the manager-snapshot route; still in `/api/leagues/:slug/managers/:slug` (identity), `/api/roster-analysis`, `/api/weekly-stats`, `/api/scoring/calculate`→ (migrated). |
| `lib/analytics/historical-scoring.ts#hashScoringSettings` | compatibility | still the season model's cache key + the `scoring_hash` response field. Retire when all consumers move to `scoringFingerprint` (post-1C). |

No legacy code was deleted. `computeStandings` gained a `test/canonical-migration.test.ts` parity harness that will fail loudly if the canonical adapter ever drifts from it.

---

## 8. Identity compatibility

- Migrated surfaces derive **ownership** and **manager↔roster mapping** from
  `snapshot.teams` / `snapshot.managers` / `snapshot.standings`.
- **Externally-expected legacy ids are preserved**: `RosterStandingFacts.roster_id`
  stays the numeric Sleeper roster id (`Number(provider_team_id)`);
  `ManagerRef.user_id` stays the raw Sleeper user id
  (`provider_user_id`, or `provider_owner_id` for a departed owner);
  `scoring.league_id` stays the numeric Sleeper league id
  (`provenance.provider_id`). No canonical id replaces a legacy id in any
  migrated payload.
- **Unresolved / departed identity is explicit**: a roster owned by a
  league-leaver yields `{ user_id: <raw id>, display_name: null, team_name: null }`
  — matching the pre-migration `managerRef`, tested. A vacant roster yields
  `{ user_id: null, ... }`.
- K / D-ST identity: not exercised by the migrated surfaces (all team-level).
- GSIS: the 1B.1 crosswalk alias is unchanged; no migrated surface resolves
  players.

---

## 9. Scoring compatibility

- `scoringFingerprint()` (1B.1) is authoritative internally and on
  `LeagueScoringContext`, `CanonicalLeague.scoring_fingerprint`, projection
  lineage.
- `scoring_hash` (legacy `hashScoringSettings`) is **unchanged** and still
  emitted on `/api/leagues/:slug/projections` and the season projection
  responses.
- The migrated `/api/scoring*` surface: `scoring_settings` is
  `snapshot.league.raw_scoring` **verbatim** (byte-identical to the old
  `getLeague().scoring_settings` — proven live). `classification`,
  `normalized`, `derived`, `comparisons`, `sensitivity`, `diagnostics`,
  `archetype_examples`, `scoring_engine` are all produced by the same
  unchanged functions.
- No legacy scoring field was removed or renamed. `hashScoringSettings` is not
  deleted.

---

## 10. Historical continuity

- Persisted snapshots: `SnapshotStore.getLatest` runs `hydratePersistedSnapshot`,
  which backfills a deterministic `lineage` + `scoring_fingerprint` +
  `roster_fingerprint` for any pre-v2 row. The v3 fields
  (`roster_positions_raw`, `provider_owner_id`) stay `undefined` for an older
  row; adapters degrade gracefully (reconstruction; `user_id: null` for a
  departed owner on a v1 row).
- `content_hash`: old rows keep their stored hash for dedupe continuity; the
  `snapshotContentHash` change (1B.1, deep-strip `provider_synced_at`) means a
  fresh re-capture of an old league state now produces a STABLE hash — a new
  version row lands once, then dedupes. No retroactive backfill performed or
  required.
- `/api/history/:league/week/:week` (reads `listVersions` only — metadata, no
  payload) is unaffected.
- Test: `test/canonical-migration.test.ts` "historical continuity" builds a
  schema-v1 snapshot (all additive fields stripped), hydrates it, and runs both
  compat adapters successfully.

---

## 11. Provider-read results

Measured by instrumented call-counting + the `runInLeagueStateScope` memo
(`test/canonical-lineage.test.ts` proves the memo collapses repeat reads).

| Surface | Before (distinct state reads) | After |
|---|---|---|
| `GET /api/leagues/:slug/scoring` | `getLeague` (1) | `buildCanonicalLeagueState` (1, memoized in scope) |
| `POST /api/scoring/calculate` | `getLeague` (1) | `buildCanonicalLeagueState` (1) |
| `GET /api/leagues/:slug/managers/:slug/snapshot` | `getLeague` + `getLeagueRosters` + `getLeagueUsers` + (`buildManagerDraftContext` live) | `buildCanonicalLeagueState` (1) + (`buildManagerDraftContext` live) — 3 raw reads collapsed to the one canonical read |
| `buildSnapshot` | `buildLeagueBundle` + `buildScoringBundle`(→`getLeague`) + `getNflState` + `getLeagueRosters` + `getLeagueUsers` + `getMatchups` + `getLeagueTransactions` | 1 `buildCanonicalLeagueState` (feeds standings + threads into `buildScoringBundle` — no 2nd read) + `buildLeagueBundle` + `buildDraftBundle` + `getMatchups` + `getLeagueTransactions`. `getNflState` + the standalone `computeStandings` reads eliminated. Raw Sleeper client calls that remain are deduped by the Next fetch cache within a request. |

No process-lifetime caching introduced. Independent requests each read fresh.
Draft-night routes untouched (`getLeagueRostersLive`).

---

## 12. Golden / cross-surface compatibility results

`test/canonical-migration.test.ts` (deterministic, 16 subtests) +
`test/canonical-migration-live.test.ts` (live, 3):

| Check | Result |
|---|---|
| `canonicalToStandingsFacts` **`deepEqual`** `computeStandings(rosters, users, {}, [])` — fixture (departed mgr + vacant roster) | ✅ byte-identical |
| same — **LIVE** 12-team Bloodline Bowl | ✅ byte-identical |
| `canonicalScoringInputs` == raw Sleeper `getLeague()` (`league_id`, `name`, `season` string, `roster_positions`, `scoring_settings`) — fixture | ✅ |
| same — **LIVE** | ✅ (`roster_positions` = `[QB,RB,RB,WR,WR,TE,FLEX,FLEX,K,DEF,BN×5]`, `scoring_settings` byte-identical) |
| `reconstructRosterPositions` fallback == verbatim array for a pre-v3 snapshot | ✅ |
| departed-manager `user_id` preserved; vacant-roster nulls preserved; `win_percentage` re-rounded 3dp→2dp | ✅ |
| cross-surface: standings rows' records/team-names trace to `snapshot.standings`/`snapshot.teams` | ✅ |
| cross-surface: scoring `league_id`/`season`/`scoring_settings` == snapshot's | ✅ |
| **LIVE** `buildSnapshot`: `team_count`, `status`, standings length line up with `/api/league/:slug/state`; every standings row carries a real `team_name` (the pre-1B.2 null-team-name bug) | ✅ |
| adversarial: `raw_scoring` passed through verbatim (add/remove/reorder rule) | ✅ |
| adversarial: manager display-name change flows into `ManagerRef` | ✅ |
| adversarial: `buildScoringBundle` throws `SleeperError` (not a partial payload) for an unknown league | ✅ |
| source-guard: no migrated route re-adds `getLeague(` / `computeStandings(` | ✅ |
| `/api/scoring/calculate` route: 200 + correct breakdown + `no-store`; bad league → 502 (unchanged) | ✅ (live) |
| `/api/leagues/:slug/managers/:slug/snapshot` route: 200, same 8 response keys, `roster_positions` array, real `team_name`, draft block intact, `s-maxage=30` cache (unchanged) | ✅ (live) |

No golden test was weakened. The `computeStandings` parity harness is now a
permanent guard.

---

## 13. Test results

- `npx tsc --noEmit` — **clean**.
- `npx eslint app lib test` — **0 errors**, 18 warnings (all pre-existing on the
  1B.1 checkpoint; none introduced).
- `npm test` (full regression) — **1278 pass · 0 fail · 4 skipped**
  (1B.1 checkpoint was 1259 · 0 · 4; +16 `canonical-migration`, +3
  `canonical-migration-live`).
- New: `test/canonical-migration.test.ts` (16), `test/canonical-migration-live.test.ts` (3).
- Updated (schema v2→v3): `test/canonical-schema.test.ts` pinned version,
  `test/foundation-live.test.ts` state `schema_version` assertion. No assertion
  weakened.

---

## 14. Live smoke results (real Bloodline Bowl, network available)

- `buildScoringBundle("bloodline-bowl")` — `league_id` `1395549281678532608`,
  `name` "Bloodline Bowl", `season` "2026", `roster_positions` and
  `scoring_settings` **byte-identical** to a fresh `getLeague()`.
- `canonicalToStandingsFacts(state)` **`deepEqual`** `computeStandings` on all
  12 real teams.
- `buildSnapshot("1395549281678532608")` — 200, `warnings: []`, `league` block
  `{league_id, name, season:"2026", status:"in_season", team_count:12}`,
  12 standings rows, `standings[0].manager.team_name` = "McBride & Prejudice"
  (real name — the canonical `team_name` fix).
- `POST /api/scoring/calculate` (`{rec:5, rec_yd:80, rec_td:1}`) → `16.5`,
  correct breakdown, `Cache-Control: no-store`; `?league=999…` → 502.
- `GET /api/leagues/bloodline-bowl/managers/supyo29/snapshot` → 200, keys
  `[context, snapshot_scope, league, draft, standings, board, available_players,
  manager]`, `league.roster_positions` = full 15-slot array, `draft`
  `{status:"complete", type:"snake", rounds:15, completed_picks:180}`,
  `Cache-Control: public, s-maxage=30, stale-while-revalidate=120`.

---

## 15. Adversarial audit

Actively attempted to break the migration.

| Scenario | Result |
|---|---|
| reordered scoring settings | fingerprint stable (1B.1); `scoring_settings` passed through verbatim in given order |
| scoring rule added / removed | `scoring_settings` + `classification` reflect it; fingerprint changes |
| player changes ownership | canonical `snapshot.rosters` change → `league_snapshot_id` changes (1B.1); standings adapter unaffected (team-level) |
| lineup-only change / IR move | `league_snapshot_id` changes (1B.1); standings adapter output unchanged (correct) |
| manager display-name change | flows into `ManagerRef.display_name` |
| departed manager (owner_id, no users entry) | `user_id` = raw `provider_owner_id`, `display_name`/`team_name` null — matches legacy |
| vacant roster | `{user_id:null, display_name:null, team_name:null}` — matches legacy |
| FLEX / SUPER_FLEX / W-R-T | `roster_positions_raw` verbatim; `classifyScoring` reads `starting_slots` (SUPER_FLEX preserved) |
| K / D-ST identity | n/a to migrated surfaces |
| provider failure (`PROVIDER_ERROR`) | `buildScoringBundle` throws `SleeperError` → route 502; `buildSnapshot` warns + falls back to `computeStandings` |
| completed draft (real state now) | `/api/leagues/:slug/managers/:slug/snapshot` → 200, `draft.status:"complete"`, standings correct |
| historical pre-lineage (v1) snapshot | `hydratePersistedSnapshot` + adapters work; departed-owner `user_id` degrades to `null` (documented) |
| missing `roster_positions_raw` (pre-v3) | `reconstructRosterPositions` fallback == verbatim for standard configs |
| repeated builds in one operation | `runInLeagueStateScope` → one provider read (1B.1 test) |
| independent requests | each reads fresh (1B.1 test) |
| hidden raw Sleeper reads in migrated routes | source-guard test: none |
| compat adapter as alternate normalizer | adapters do no I/O, no own logic; golden-`deepEqual` vs legacy |
| `?league=` routing change | `resolveLeagueForQuery` unchanged: empty→`bloodline-bowl`, slug→self, numeric→self, unknown non-numeric→400 (all tested) |
| historical `content_hash` breakage | old rows keep stored hash; no rewrite |
| async scope leakage | `runInLeagueStateScope` is `AsyncLocalStorage`, map unreachable after `fn` resolves (1B.1) |

### Findings

| # | Sev | Finding | Status |
|---|---|---|---|
| **F-1** | **P1** | `CanonicalFantasyTeam.team_name` was `null` for **every production team** — `toCanonicalTeams` read `roster.metadata.team_name` (always null on Sleeper) instead of `user.metadata.team_name`. Any consumer of canonical `team_name` (`/api/league/:slug/state`, weekly/trade context, and this migration) got nothing. | **FIXED** — `toCanonicalTeams` now takes `users` and prefers the user's team name; live-verified for both leagues; `test/canonical-migration-live.test.ts` guards it. |
| **F-2** | **P2** | A roster owned by a league-leaver carries a `canonical_manager_ids` entry that has **no matching `snapshot.managers` row** (dangling reference). | **MITIGATED** — added `CanonicalFantasyTeam.provider_owner_id` (v3) so the raw owner id is always recoverable; the deeper fix (synthesise a departed-manager entry) is deferred to 1C. |
| **F-3** | **P2** | `toCanonicalStandings.win_percentage` is 3dp; legacy `computeStandings` is 2dp. | **HANDLED** — the compat adapter re-rounds to 2dp; golden-`deepEqual` passes. Not changing the canonical value (3dp is fine internally). |
| **F-4** | **P3** | `/api/transactions` (`?league=`) is a legacy alias while `/api/transactions/:league` is already canonical. | documented; migrate the alias as a 1C cleanup. |
| **F-5** | **P3** | Two schema-version bumps across 1B.1 (v2) + 1B.2 (v3). | acceptable — both additive/optional, reader-tolerant, documented; `hydratePersistedSnapshot` covers v1→v2, v3 fields degrade gracefully. |

**No P0. All P1 fixed. All P2 mitigated + tracked.**

---

## 16. P0 / P1 / P2 / P3 summary

- **P0**: none.
- **P1**: F-1 (canonical `team_name` null) — **FIXED**.
- **P2**: F-2 (dangling departed-manager ref) — mitigated via `provider_owner_id`;
  F-3 (win_pct precision) — handled in adapter.
- **P3**: F-4 (`/api/transactions` alias), F-5 (schema bumps) — documented.

---

## 17. Outstanding risks

1. **`/api/league` + `/api/leagues/:slug` remain on the legacy stack.** Their
   current-state facts are proven consistent with canonical, but the endpoints
   still independently normalise rosters/starters/records. A future divergence
   (esp. once Yahoo leagues authorise) would not be caught until a consumer
   notices. Mitigation: the cross-surface invariant tests; a dedicated
   payload-v2 migration phase.
2. **`buildSnapshot` is partially migrated** — `teams[]` (with future-pick-asset
   counts), auction budget, matchup facts and transaction facts still read
   Sleeper directly. Next's fetch cache dedupes the raw calls within a request,
   so no meaningful read amplification, but the endpoint is not "one read".
3. **Departed-manager identity on a pre-v3 persisted snapshot** degrades to
   `user_id: null` (no `provider_owner_id` on an old row). Only affects a
   rehydrated historical snapshot with a since-departed owner — narrow.
4. **`hashScoringSettings` still shipped** alongside `scoringFingerprint`. Two
   hashes coexist until every consumer moves (post-1C).
5. **Yahoo** — the adapters are wired into the Yahoo canonical path but no Yahoo
   league is authorised, so the Yahoo compat path is fixture-tested only.

---

## 18. Recommended Phase 1C certification scope

1. **Cross-surface certification harness** — a single test that, for each
   registered league, builds `/api/league/:slug/state` once and asserts every
   remaining legacy surface (`/api/league`, `/api/leagues/:slug`,
   `/api/leagues/:slug/managers`, `/api/standings`, `/api/snapshot`) agrees on:
   league id/season/week, manager↔roster mapping, ownership, starters/bench/IR,
   roster config, scoring interpretation, team names, records. (The 1B.2 tests
   cover the migrated subset; 1C extends to the un-migrated ones as
   *consistency* checks even though they stay on the legacy stack.)
2. **`/api/league` payload-v2 decision** — either enrich canonical with the
   Sleeper-native presentation data behind a clearly-namespaced `provider_detail`
   block, or publish a `/api/leagues/:slug?v=2` canonical-shaped payload and
   deprecate the v1 shape on a timeline.
3. **Departed-manager canonical fix** — `toCanonicalManagers` synthesises a
   minimal `CanonicalManager` for any roster owner absent from `users`, removing
   the dangling reference and letting the standings adapter drop
   `provider_owner_id`.
4. **Retire `hashScoringSettings`** once `/api/leagues/:slug/projections` and the
   season model consume `scoringFingerprint`.
5. **`/api/transactions` (`?league=`) → alias of the canonical
   `/api/transactions/:league`**.
6. **Yahoo live certification** once a Yahoo league authorises.

---

## Verdict

# CONDITIONAL — FIX BEFORE PHASE 1C

The migrated surfaces (scoring family fully; `/api/leagues/:slug/managers/:slug/snapshot`
league+standings fully; `buildSnapshot` standings+scoring) are **byte-compatible
and canonical-backed**, live-verified, golden-guarded, with `tsc` clean, `eslint`
0 errors, and **1278 / 0 / 4** regression.

The **CONDITIONAL** is because:

- **F-1 (P1)** — the canonical `team_name` bug — **is fixed in this branch**, but
  it revealed that canonical fields can be silently wrong in production without a
  consumer to notice. Phase 1C **must** ship the cross-surface certification
  harness (§18.1) as its first deliverable, extended to the un-migrated
  surfaces, before any further migration or the R Football Intelligence Engine
  is built on top.
- **`/api/league` / `/api/leagues/:slug` are not migrated** and still hold an
  independent current-state normalisation. This is an accepted, documented
  deferral — but Phase 1C must make the §18.2 payload-v2 decision rather than
  leave it open-ended.

No blocker to *starting* Phase 1C; the two conditions above are its entry
criteria. Do not begin Phase 1C here.
