# Bloodline Bowl Team Management — Phase 1A

**Repository & data-flow audit + canonical league snapshot proposal**

Date: 2026-09-06
Scope: audit only. No recommendation logic, projection methodology, waiver/trade/matchup
logic was changed. No new engine (Matchup Model, R Football Intelligence Engine, Team
Management Orchestrator) was introduced.

Status legend for findings: **observed fact** = read directly from the code / a live call;
**recommendation** = a Phase 1B/1C proposal, not something the repo does today.

---

## 0. Executive summary

The repository already contains a genuine canonical model
(`lib/canonical/schema.ts` + `lib/canonical/state.ts` + `lib/providers/*`) and **two of the
three heavyweight engines — the weekly intelligence engine and the trade engine — are
already built entirely on it** through a single code path
(`buildCanonicalLeagueState` → `buildWeeklyTeamContext` → `buildTradeAnalysisContext`).
The trade engine already reads league state exactly once per request and threads one
immutable snapshot through every sub-analysis (Phase 2A design).

What is **not** canonicalised:

1. A **second, older league-state stack** (`lib/sleeper/service.ts`,
   `lib/analytics/*`, `lib/scoring/scoring-service.ts`) still backs ~20 endpoints
   (`/api/league`, `/api/snapshot`, `/api/standings`, `/api/managers`, `/api/history`,
   the whole `?league=` analytics surface, the `/api/leagues/:slug` REST resources, and
   the personalised `/api/leagues/:slug/managers/:slug/snapshot`). It uses raw Sleeper
   `player_id`, raw `roster.players`, `league.scoring_settings`, and its own week
   derivation.
2. The **season projection model** (`lib/projections/*`, `ri-structural-2026.3`) and the
   **weekly projection provider** (`lib/weekly/projections/sleeper-weekly`) are two
   independent projection systems with different versions, different `generated_at`,
   different K/DST handling, and no shared lineage field surfaced to consumers.
3. The **draft recommendation engine** (`lib/draft/*`) reads its own live roster
   (`getLeagueRostersLive`), its own league config (`loadLeagueConfig`), and raw Sleeper
   ids — it never touches the canonical layer.
4. There is **no `league_snapshot_id`** on the live read path. `snapshotContentHash`
   exists but is private to the persistence layer; live engines cannot cite
   "this recommendation came from snapshot X".

No **P0** (invalid-recommendation-causing) discrepancy was proven under the current
single-league, all-Sleeper, in-season state. Several **P1** risks exist that would bite as
soon as (a) Yahoo leagues go live, (b) two engines are composed in one response, or
(c) a recommendation needs to be reproduced/audited later.

**Verdict: CONDITIONAL GO** — see §10.

---

## 1. Current architecture map

```
                              ┌───────────────────────── PROVIDERS ─────────────────────────┐
                              │  Sleeper public API            Yahoo API (OAuth, not yet    │
                              │  api.sleeper.app               authorised for any league)   │
                              └───────────────┬───────────────────────────┬─────────────────┘
                                              │                           │
                      ┌───────────────────────┴───────────┐     ┌─────────┴──────────┐
                      │  lib/sleeper/client.ts (cached)    │     │ lib/providers/     │
                      │  getLeague / getLeagueRosters /    │     │ yahoo/*            │
                      │  getLeagueUsers / getMatchups /    │     └─────────┬──────────┘
                      │  getPlayerIndex / getNflState /    │               │
                      │  getDraftPicks / *Live variants    │               │
                      └───┬───────────────────────────┬────┘               │
                          │                           │                    │
        ┌─────────────────┘                           │                    │
        │  LEGACY STACK                               │  CANONICAL STACK    │
        │  (raw Sleeper ids, raw roster.players)      │                     │
        ▼                                             ▼                     ▼
  lib/sleeper/service.ts   lib/analytics/*      lib/providers/sleeper/{provider,canonical}.ts
  buildLeagueBundle        loadSeasonData       lib/providers/yahoo/{provider,canonical}.ts
  resolveLeagueId          buildSnapshot                 │
  lib/scoring/             computeStandings              │  toCanonical{League,Managers,
  scoring-service.ts       historical-*                  │  Teams,Rosters,Standings,
        │                       │                        │  Matchups,Transactions,DraftPicks}
        │                       │                        │  + PlayerCrosswalk (gsis→sleeper→
        │                       │                        │    yahoo→name resolution)
        ▼                       ▼                        ▼
  /api/league             /api/standings          lib/canonical/state.ts
  /api/scoring            /api/managers           buildCanonicalLeagueState(slug)
  /api/snapshot           /api/history               → CanonicalLeagueSnapshot
  /api/lineups            /api/matchups                 (schema_version, captured_at,
  /api/roster-analysis    /api/manager-availability     provider_synced_at, league,
  /api/leagues/:slug              │                     managers, teams, rosters,
  /api/leagues/:slug/scoring      │                     standings, matchups,
  /api/leagues/:slug/snapshot     │                     recent_transactions, draft_picks,
  /api/leagues/:slug/managers/    │                     players, unresolved_players,
    :slug/snapshot                │                     live_provider_status,
        │                         │                     history_persistence_status)
        │                         │                            │
        │   ┌─────────────────────┘         ┌──────────────────┼──────────────────┐
        │   │  lib/stats/provider.ts        ▼                  ▼                  ▼
        │   │  (nflreadr weekly actuals)  lib/canonical/     lib/weekly/context.ts   lib/persistence/
        │   │                             manager-context.ts buildWeeklyTeamContext  capture.ts
        │   │                             buildManagerContext        │              captureLeagueState
        │   │                                    │                   │              (Supabase
        ▼   ▼                                    ▼                   │               SnapshotStore
  SEASON PROJECTION MODEL              /api/context/:league/:manager  │               + LedgerStore)
  lib/projections/*  (ri-structural-2026.3)                          │                    │
  buildBaseProjections (nflreadr actuals, module-cached)             │              /api/cron/capture
  buildLeagueProjections (league.scoring_settings + calculateFantasyPoints)          /api/history
  buildSpecialTeams (vendored K/DEF snapshot)     │                  │              /api/transactions/:league
        │                        │                │                  │
        ▼                        ▼                │   ┌──────────────┼───────────────┐
  /api/projections        lib/draft/service.ts    │   ▼              ▼               ▼
  /api/leagues/:slug/     buildManagerRecommendation  lib/weekly/    lib/weekly/     lib/trades/context.ts
    projections           Response                    intelligence.ts lineup/matchup/ buildTradeAnalysisContext
        │                 recommendDraft (engine.ts)  buildWeekly     waivers/start-  (ONE state read; threads
        │                 + market/survival/tiers     Intelligence    sit             snapshot into weekly ctx)
        │                        │                        │              │                   │
        ▼                        ▼                        ▼              ▼                   ▼
  season projection       /api/leagues/:slug/       /api/intelligence  /api/lineup     lib/trades/analyze.ts
  consumers               managers/:slug/           /:l/:m/week/:w     /api/matchup    lib/trades/discovery/discover.ts
                          recommendations                              /api/waivers    lib/trades/negotiation/negotiate.ts
                                                                                            │
                          ALSO: lib/weekly/projections-ri.ts pulls the SEASON model    /api/trades/analyze
                          back in as an ORDINAL rest-of-season signal only             /api/trades/discover
                                                                                      /api/trades/negotiate
```

### Shared / single-implementation components (good)

| Component | File | Used by |
|---|---|---|
| Scoring math | `lib/scoring/calculate.ts` `calculateFantasyPoints` | scoring-service, `lib/projections/league.ts`, `lib/weekly/scoring.ts` |
| League identity resolver | `lib/leagues/registry.ts` + `lib/leagues/resolve.ts` | canonical stack, `/api/leagues/*` REST; legacy `resolveLeagueId` shares the registry |
| Player crosswalk | `lib/canonical/players.ts` `PlayerCrosswalk` | every provider adapter, weekly, trades |
| Canonical id construction | `lib/canonical/ids.ts` | provider adapters only |
| NFL schedule (byes) | `lib/weekly/schedule/sleeper-schedule.ts` | weekly context, trade ROS context |
| Replacement frontier | `lib/weekly/replacement.ts` | weekly lineup + waiver + trade eval (one impl) |
| Snapshot content hash | `lib/persistence/serialize.ts` `snapshotContentHash` | **persistence only — not surfaced live** |

### Parallel / divergent components (integration risk)

| Concern | Canonical stack | Legacy / other stacks |
|---|---|---|
| League state assembly | `buildCanonicalLeagueState` | `buildLeagueBundle`, `loadSeasonData`, `buildSnapshot` |
| Player identity | `canonical_player_id` (gsis→sleeper→yahoo→name) | raw Sleeper `player_id` (projections, draft, analytics, scoring, bridge) |
| Ownership | `snap.rosters[].all_players` + provider-id belt (`lib/weekly/availability.ts`) | raw `roster.players` (analytics `computeStandings`, `buildSnapshot`); client-side `entries` map (bridge) |
| Scoring representation | `raw_scoring` map + `scoring_rules[]` (no fingerprint) | `league.scoring_settings` + `scoring_hash` (`hashScoringSettings`) |
| Weekly points | `sleeper-weekly` RotoWire feed, league-scored; K/DST = `pts_std` approximation | season model K/DST = vendored special-teams snapshot |
| Current week | `getNflState().week` via provider `current_week` | `getNflState().week` (analytics); draft-pick state (draft engine); hard-coded `PROJECTION_SEASON = 2026` (projections) |
| Roster/FLEX eligibility | `roster_settings.slot_requirements` + `lib/weekly/slots.ts FLEX_ELIGIBILITY` | `cfg.roster_positions` (draft); `["RB","WR","TE"]` hard-coded for trade *validation* (`analyze.ts:171`) |

---

## 2. Current data-flow map

```
SOURCE            → INGESTION                → NORMALIZATION            → SHARED DATA           → ENGINE                     → OUTPUT
─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
Sleeper API       lib/sleeper/client.ts       lib/providers/sleeper/     CanonicalLeagueSnapshot  lib/weekly/context.ts       /api/context
(league, users,   (fetch + Next cache)        canonical.ts              (in-memory, per request;   buildWeeklyTeamContext     /api/intelligence
 rosters,                                     + PlayerCrosswalk         NOT persisted unless the      → lineup/matchup/       /api/lineup
 matchups,                                    (Supabase crosswalk       cron/capture job runs)        waivers/start-sit       /api/matchup
 drafts,                                       source, else NoCrosswalk)        │                                             /api/waivers
 transactions,                                       │                          │                lib/trades/context.ts       /api/trades/analyze
 nfl state,       lib/canonical/state.ts ──────┘                                └──────────────►  buildTradeAnalysisContext  /api/trades/discover
 player index)    buildCanonicalLeagueState                                        (ONE read,        → evaluate/discover/     /api/trades/negotiate
                  (matchups + recent txns                                          snapshot threaded    negotiate/strategy    /api/leagues/:slug/
                   layered best-effort)                                            via snapshotOverride)                       managers/:slug/
                       │                                                                │                                     strategic-context
                       ├──────────────────────────────────────────────────────────────►  lib/persistence/capture.ts          /api/cron/capture
                       │                                                                 captureLeagueState                   (daily 12:00 UTC)
                       │                                                                  → Supabase snapshot_versions        /api/history
                       │                                                                    (content-hash dedupe, immutable)
                       │
Sleeper weekly    lib/weekly/projections/     league-scored via          WeeklyProjectionBatch   (consumed inside weekly     (same routes as
 projections      sleeper-weekly.ts           lib/weekly/scoring.ts      (per request)            context above)              weekly engine)
 feed             (RotoWire-backed)           calculateFantasyPoints
 (/projections/                               K/DST → pts_std
  nfl/{s}/{w})

nflreadr /        lib/projections/actuals.ts  lib/projections/build.ts   BaseProjectionResult    lib/projections/league.ts   /api/projections
 nflverse         (season actuals,            model.ts / baselines.ts    (module-cached,         buildLeagueProjections      /api/leagues/:slug/
 season actuals   module-cached)              rookie-model.ts            process lifetime)         → replacement/VOR/tier    projections
                                              → scoring-neutral pts             │                lib/draft/engine.ts         /api/leagues/:slug/
                                                                               ├──────────────►  recommendDraft              managers/:slug/
                                                                               │                 (+ market/survival/         recommendations
Sleeper draft    lib/sleeper/draft-service    lib/sleeper/normalize.ts          │                  tiers/geometry)            /api/leagues/:slug/
 (live picks)     buildDraftBundle /          NormalizedPlayer                  │                                             managers/:slug/
                  getDraftPicksLive           (raw Sleeper ids)                 └──────────────►  lib/weekly/projections-ri   snapshot (draft ctx)
                                                                                                  ORDINAL ROS signal only

Sleeper API      lib/sleeper/service.ts       lib/sleeper/normalize.ts   LeagueResponse /        lib/analytics/*             /api/league
(LEGACY path)    buildLeagueBundle            buildLeagueResponse        SeasonDataBundle        standings/history/          /api/snapshot
                 lib/analytics/season-data    computeStandings           (per request)           managers/matchups/         /api/standings
                 loadSeasonData                                                                  transactions               /api/managers
                                                                                                lib/analytics/snapshot.ts   /api/history
                                                                                                buildSnapshot               /api/leagues/:slug
                                                                                                                            /api/leagues/:slug/snapshot
                                                                                                                            /api/leagues/:slug/
                                                                                                                              managers/:slug/snapshot

nflreadr weekly  lib/stats/provider.ts        lib/analytics/weekly-stats  PlayerStatLine[]       lib/analytics/             /api/player-weekly
 actuals         getStatsProvider                                                                manager-availability       /api/player-availability
                                                                                                historical-*               /api/manager-availability

Sleeper draft    lib/bridge/*                 client-side               BridgeDraftState        lib/bridge/board.ts         /api/bridge/board
 + ranking pack  (browser + node)             (localStorage,           (per league, isolated)   ranking-packs              app/bridge (UI)
                                               league-keyed)
```

---

## 3. Engine input matrix

Per the 11 audit questions. "canonical" = via `buildCanonicalLeagueState`.

| Engine / endpoint | 1. State origin | 2. Fetches live independently | 3. Normalises independently | 4. Canonical player id | 5. Ownership source | 6. Roster/FLEX eligibility | 7. Scoring interpretation | 8. Current week | 9. Projection source/version | 10. Cache / stale risk | 11. Duplicate transform elsewhere |
|---|---|---|---|---|---|---|---|---|---|---|---|
| **Weekly intelligence** `/api/intelligence,lineup,matchup,waivers` | canonical (`buildWeeklyTeamContext`) | yes — one `buildCanonicalLeagueState` per request | no (uses canonical adapter) | `canonical_player_id` | `snap.rosters[].all_players` + provider-id belt | `roster_settings.slot_requirements` + `slots.ts FLEX_ELIGIBILITY` | `raw_scoring` → `calculateFantasyPoints` | `getNflState().week` (only current week allowed; non-current → `NON_CURRENT_WEEK_UNSUPPORTED`) | `sleeper_weekly` (`sleeper-weekly-rotowire`) absolute + RI (`ri-structural-2026.3`) ordinal | client `getLeague`/`getPlayerIndex` cached; per-request state build; no cross-request snapshot reuse | shares nothing with legacy stack |
| **Trade engine** `/api/trades/{analyze,discover,negotiate}`, `/strategic-context` | canonical (`buildTradeAnalysisContext`) | yes — **one** `buildCanonicalLeagueState` + one `buildWeeklyTeamContext` (via `snapshotOverride`, no 2nd read) | no | `canonical_player_id`; `analyze` also accepts raw Sleeper id / name_key (not raw GSIS id) | `snap.rosters` | resolved `RosterConstraints`; validation path hard-codes `flex_positions:["RB","WR","TE"]` | `raw_scoring` → `calculateFantasyPoints` | `wctx.league.week` (= `getNflState().week`) | same as weekly | one read per API call; 3 separate endpoints each do their own read | — |
| **Manager context** `/api/context/:l/:m` | canonical (`buildManagerContext`) | yes | no | `canonical_player_id` | `snap.rosters` | `slot_requirements` | `scoring_rules` | `getNflState().week` | none embedded (bye detection explicitly deferred, still returns a stub note) | per-request | — |
| **Canonical state** `/api/league/:l/state` | canonical | yes | no | `canonical_player_id` | `snap.rosters` | `roster_settings` | `raw_scoring` + `scoring_rules` | provider `current_week` | per-request, `Cache-Control` short | — |
| **Season projections** `/api/projections`, `/api/leagues/:slug/projections` | `loadLeagueConfig` (`getLeague` + `getLeagueRosters`) | yes — own fetch | yes — own `NormalizedPlayer` / `PlayerProjection` | **raw Sleeper `player_id`** | n/a (whole-pool) | `cfg.roster_positions` | `league.scoring_settings` + `scoring_hash` (`hashScoringSettings`) → `calculateFantasyPoints` | hard-coded `PROJECTION_SEASON = 2026` | self (`ri-structural-2026.3` / `PROJECTION_MODEL_VERSION`); Sleeper season feed = BENCHMARK only | `buildBaseProjections` **module-cached for process lifetime** (actuals + nflreadr); league layer keyed `league_id+scoring_hash` | K/DST built separately from weekly K/DST |
| **Draft recommendations** `/api/leagues/:slug/managers/:slug/recommendations` | `loadLeagueConfig` + `getLeagueRostersLive` + `buildDraftBundle` | yes — own fetches, **live (uncached) roster** | yes — `NormalizedPlayer` | **raw Sleeper `player_id`** | `getLeagueRostersLive` (roster_id match) or draft picks fallback | `cfg.roster_positions` (+ engine geometry) | `cfg.scoring_settings` via `leagueScoringContext` | draft-pick state / `draftBundle.generated_at` | season model + `buildSpecialTeamsProjections` (vendored K/DEF); `market-adp-2026` snapshot | live roster uncached (correct for draft); base projections module-cached | — |
| **Draft context / manager snapshot** `/api/leagues/:slug/managers/:slug/{draft,snapshot}` | `buildManagerDraftContext` (`getLeague`+`getLeagueRosters`) | yes | yes — own | raw Sleeper `player_id` | `getLeagueRosters` roster_id match | `roster_positions` | n/a (best-available list only) | `getNflState` / draft status | best-available list (not the decision engine) | `computeStandings` from raw rosters | duplicates standings vs `/api/standings` |
| **Legacy league** `/api/league`, `/api/leagues/:slug` | `buildLeagueBundle` | yes | yes — `buildLeagueResponse` | raw Sleeper `player_id` | raw `roster.players` / `roster.starters` | `roster_positions` | `league.scoring_settings` (raw passthrough) | `getNflState().week` (best-effort) | none | `getLeague` cached | reimplements roster/starter/bench split vs canonical adapter |
| **Legacy snapshot** `/api/snapshot`, `/api/leagues/:slug/snapshot` | `buildSnapshot` → composes `buildLeagueBundle` + `buildDraftBundle` + `buildScoringBundle` + analytics | yes (many parallel Sleeper calls) | yes | raw Sleeper `player_id` | raw `roster.players`; `computeStandings(rosters, users, new Map(), [])` | `roster_positions` | `buildScoringBundle` classification | `getNflState().week` else 1 | none | none | its own standings + matchup + transaction normalisation, distinct from canonical `toCanonical*` |
| **Standings / history / managers** `/api/standings,history,managers` | `loadSeasonData` / `buildLeagueHistory` | yes | yes | raw Sleeper `player_id` | raw rosters | n/a | n/a | `getNflState().week` | none | league lineage traversal cached | `computeStandings` reused here and in `buildSnapshot` and manager-snapshot (3 call sites, same fn — OK) |
| **Analytics `?league=`** `/api/{lineups,matchups,player-weekly,player-availability,manager-availability,weekly-stats,transactions,value}` | `resolveLeagueId` + `loadSeasonData` + `getStatsProvider` (nflreadr) | yes | yes | raw Sleeper `player_id`; nflreadr join by name/gsis inside `lib/stats` | raw matchup `players` / `starters` | n/a | `hashScoringSettings` (historical-scoring) | `parseWeek` param / `getNflState` | nflreadr weekly actuals (not projections) | historical, mostly immutable | own scoring hash + own transaction normaliser (`lib/analytics/transactions.ts`) vs canonical `toCanonicalTransactions` |
| **Scoring** `/api/scoring`, `/api/leagues/:slug/scoring` | `getLeague` | yes | yes — `buildNormalizedRules` | n/a | n/a | n/a | `league.scoring_settings` (own normalisation catalog) | n/a | `getLeague` cached | none | `scoring_rules` also derived independently in `toCanonicalScoringRules` (`lib/providers/sleeper/canonical.ts`) — **two scoring-rule normalisers** |
| **Draft Bridge** `/api/bridge/board`, `app/bridge` | Sleeper draft feed + ranking pack | yes (client + server) | yes — client-side | raw Sleeper `player_id` | client `BridgeDraftState.entries` (draft picks) | `fantasy_positions` on the entry | ranking-pack scoring identity (`scoring_sha`) | n/a (draft) | ranking pack (`darthmarker-2026`) | localStorage, league-keyed, fail-closed isolation | fully separate universe (by design — pre-draft tool) |
| **Persistence / cron** `/api/cron/capture`, `/api/history`, `/api/transactions/:league` | canonical (`captureLeagueState`, `syncLeagueTransactions`) | yes | no | `canonical_player_id` | `snap.rosters` | `roster_settings` | `raw_scoring` | provider `current_week` | **immutable** content-hash-dedupe snapshots; ledger dedupes on `(league,season,provider,provider_transaction_id)` | — |

---

## 4. Canonical league snapshot proposal

The good news: `CanonicalLeagueSnapshot` (`lib/canonical/schema.ts`) **already covers ~90%
of the required contract**. The proposal is to *adopt it as the shared truth* with a small
set of additive fields, not to design a new shape.

### 4.1 What already exists and is sufficient

| Required area | Already in `CanonicalLeagueSnapshot` |
|---|---|
| Snapshot metadata | `schema_version`, `captured_at`, `provider_synced_at`, `league.canonical_league_id`, `league.league_slug`, `season`, `week`, `league.provenance.provider` |
| League configuration | `league.scoring_rules[]`, `league.raw_scoring`, `league.roster_settings` (`starting_slots`, `bench_slots`, `ir_slots`, `taxi_slots`, `slot_requirements`), `league.playoff_settings`, `league.waiver_settings` |
| Managers / teams | `managers[]` (`canonical_manager_id`, `manager_slug`, `provider_username`, `display_name`, `provider_user_id`, `is_commissioner`, `is_co_manager`), `teams[]` (`canonical_team_id`, `provider_team_id`, `team_name`, `canonical_manager_ids`, `record`, `faab_remaining`, `waiver_priority`), `standings[]` (`rank`, `win_percentage`, `playoff_seed`, …) |
| Rosters | `rosters[]` (`slots[]` with `slot`/`slot_index`/`canonical_player_id`/`is_empty`, `starters`, `bench`, `ir`, `taxi`, `all_players`) |
| Players | `players[]` (`canonical_player_id`, `identifiers` crosswalk, `full_name`, `nfl_team`, `position`, `eligible_positions`, `is_team_defense`, `status`, `injury_status`, `resolution`), `unresolved_players[]` |
| Schedule / matchup state | `matchups[]` (`week`, `status`, `sides[]` with `starters`/`bench`/`actual_points`/`player_points`), `week` |
| Degradation | `live_provider_status`, `history_persistence_status`, `warnings[]` |
| Immutability (persisted) | `snapshot_versions` table, content-hash dedupe (`snapshotContentHash`), `StoredSnapshotMeta.id` |

### 4.2 Proposed additive fields (recommendation — each justified)

Add to `CanonicalLeague`:

| Field | Type | Why (traceability / consistency / modeling) |
|---|---|---|
| `scoring_fingerprint` | `string` | consistency — lets any consumer assert "the scoring I evaluated under". Reuse the existing `hashScoringSettings(raw_scoring)` so the season model's `scoring_hash` and the canonical fingerprint are the **same value** (removes the "two hashes" ambiguity). |
| `roster_fingerprint` | `string` | consistency — `sha256(stableStringify(roster_settings))`. A change means FLEX/IR/bench rules moved under a cached recommendation. |
| `nfl_week_source` | `"provider_state" \| "override" \| "unknown"` | traceability — records *how* `week` was decided (today always provider `/state/nfl`). |

Add to `CanonicalLeagueSnapshot` (top level):

| Field | Type | Why |
|---|---|---|
| `league_snapshot_id` | `string` | traceability — the deterministic id every downstream recommendation cites (see §5). Currently only assigned by the persistence layer *after the fact*; move it onto the live object. |
| `content_hash` | `string` | traceability — surface the existing `snapshotContentHash` on the live object so a consumer can dedupe / compare without a DB round-trip. |
| `player_data_version` | `string` | traceability — a stamp for the Sleeper player-index generation used to resolve identities (e.g. `sleeper-players:<yyyy-mm-dd>` or a hash of the index size + a sample). Identity resolution silently depends on this today. |
| `crosswalk_version` | `string \| null` | traceability — which crosswalk source/generation resolved `identifiers` (`NoCrosswalk` vs a dated Supabase load). |
| `projection_lineage` | `ProjectionLineage[]` (see §4.3) | traceability — the snapshot names which projection systems a recommendation *may* have used, without embedding the numbers. |

**Explicitly NOT proposed:** embedding weekly/season projection point values in the
snapshot (they have their own cache lifetimes and versioning; keep them in the
`WeeklyProjectionBatch` / `BaseProjectionResult` structures and reference them by lineage).
No per-player ADP, no NFL play-by-play, no "theoretical completeness" fields.

### 4.3 Projection lineage sub-shape (recommendation)

```ts
interface ProjectionLineage {
  role: "weekly_absolute" | "season_ordinal" | "special_teams";
  source: string;            // e.g. "sleeper_weekly", "roster_intel_season"
  model_version: string;     // e.g. "sleeper-weekly-rotowire", "ri-structural-2026.3"
  generated_at: string | null;
  scoring_fingerprint: string; // MUST equal league.scoring_fingerprint or a warning is raised
  status: "READY" | "PARTIAL" | "UNAVAILABLE";
}
```

This is the minimum needed so a recommendation response can say *"lineup built from
`league_snapshot_id=… ` + weekly projections `sleeper-weekly-rotowire@<ts>`"*.

### 4.4 Systems that should keep owning their calculation (not pushed into the snapshot)

- **Replacement level / VOR / positional scarcity** — `lib/weekly/replacement.ts`,
  `lib/projections/replacement.ts`. These are frontier-strategy-parameterised; the snapshot
  should carry the *inputs* (rosters, roster settings, team_count), not a frozen replacement number.
- **Weekly + season projections** — keep in their own providers; reference by lineage.
- **Trade valuation, negotiation, discovery** — pure functions over the context; unchanged.
- **Draft recommendation engine** — turn geometry / survival / tiers stay in `lib/draft/*`.
- **Scoring math** — `calculateFantasyPoints` stays the one engine; the snapshot carries
  `raw_scoring` + `scoring_fingerprint` only.
- **Historical analytics** — reads persisted snapshots + the transaction ledger; no change.

---

## 5. Snapshot lineage / versioning proposal

### 5.1 Deterministic `league_snapshot_id`

**Recommendation:**

```
league_snapshot_id = "snap:" + league_slug + ":" + season + ":w" + week + ":" + contentHash12
```

where `contentHash12` = first 12 hex chars of `snapshotContentHash(snapshot)` (already
implemented; hashes everything **except** the volatile keys `captured_at`,
`provider_synced_at`, `live_provider_status`, `history_persistence_status`, `warnings`).

Properties:

- **Deterministic** — same league state an hour later, same id. Two engines that build a
  context in the same request window get the same id.
- **Content-addressed** — a genuine change to rosters / scoring / matchups / players
  produces a new id automatically.
- **Immutable once published** — the persistence layer already enforces this: a matching
  `content_hash` for `(league_slug, season, week, capture_type)` is a *duplicate*, not an
  overwrite (`stores.ts:106`). A refreshed league state that actually differs lands as a
  new row / new id.
- **Human-inspectable** — `snap:bloodline-bowl:2026:w1:a1b2c3d4e5f6`.

### 5.2 Fingerprints summary

| Fingerprint | Derivation | Consumers assert against |
|---|---|---|
| `league_snapshot_id` | `snap:<slug>:<season>:w<week>:<contentHash12>` | every recommendation response |
| `content_hash` | `snapshotContentHash` (sha256, volatile keys excluded) | snapshot dedupe / diffing |
| `scoring_fingerprint` | `hashScoringSettings(raw_scoring)` (reuse existing) | projection lineage, cached league projections, trade eval |
| `roster_fingerprint` | `sha256(stableStringify(roster_settings))` | lineup legality cache invalidation |
| `player_data_version` | Sleeper player-index generation stamp | identity-resolution reproducibility |
| `crosswalk_version` | crosswalk source name + load date/size hash | cross-provider identity reproducibility |
| `projection_version` (weekly) | `WeeklyProjectionBatch.model_version` | already present; add to lineage |
| `projection_version` (season) | `PROJECTION_MODEL_VERSION` (`ri-structural-2026.3`) | already present; add to lineage |
| `weekly_engine_version` | `WEEKLY_ENGINE_VERSION` | already on `WeeklyTeamContext` |
| `trade_*_version` | `ri-trade-foundation/contextual/…` | already surfaced in trade responses |

### 5.3 Recommendation lineage envelope (recommendation)

Every engine response should carry:

```ts
interface RecommendationLineage {
  league_snapshot_id: string;
  snapshot_captured_at: string;
  scoring_fingerprint: string;
  roster_fingerprint: string;
  player_data_version: string;
  projection_lineage: ProjectionLineage[];
  engine_versions: Record<string, string>; // weekly_engine, trade_foundation, …
}
```

The weekly and trade responses already carry most of this piecemeal; this just standardises
the envelope and adds the `league_snapshot_id` anchor.

---

## 6. Real Bloodline Bowl consistency results

**Live state at audit time** (`api.sleeper.app`, 2026-09-06):

- NFL `/state/nfl`: `season 2026`, `week 1`, `season_type regular`, season starts 2026-09-09.
- League `1395549281678532608` "Bloodline Bowl": `status in_season`, `season 2026`,
  `playoff_week_start 15`,
  `roster_positions = [QB, RB, RB, WR, WR, TE, FLEX, FLEX, K, DEF, BN×5]` — **no IR slot**.
- Registry: `bloodline-bowl` (Sleeper), `devoted-to-the-game` (Sleeper),
  `maclin-on-chicks-xvi` + `rogers-park` (Yahoo, `AWAITING_CREDENTIALS`).

**Test suite** (`npm test`, `node --test`): **1235 pass / 10 fail**, all 10 failures in
`*-live.test.ts` suites that call Sleeper and assert **pre-draft / draft-night** state
(`draft-live`, `draft-cache-headers-live`, `analytics-live: standings/managers/snapshot`).
The league is now `in_season` with a completed draft, so those fixtures are stale — **not a
production defect**, but the pre-draft live tests are now unrunnable and should be re-scoped
to in-season assertions (P3). All non-live unit/integration tests pass, including
`canonical-schema`, `canonical-routing`, `weekly-*`, `trade-engine-*`,
`multi-league-isolation`, `weekly-isolation`.

**Cross-engine contradiction checks** (from code analysis + the passing isolation/parity
test suites; a live automated cross-engine differ is proposed in §9 but not yet built):

| Check | Result | Notes |
|---|---|---|
| Player owned by one engine, free by another | **No contradiction found** within the canonical stack — weekly `availability` and trade `ownership` both derive from `snap.rosters[].all_players`. **Risk** between canonical and legacy: legacy uses raw `roster.players` (superset incl. the `"0"` sentinel handled separately). Same underlying array, so equal today. |
| Different canonical identity for the same player | **Divergence exists by construction**: canonical `canonical_player_id` (gsis-preferred) vs raw Sleeper `player_id` everywhere in projections/draft/analytics/bridge. They are joined only inside `PlayerCrosswalk`. `/api/trades/analyze` accepts a raw Sleeper id or `name_key` but **not a raw GSIS id** (documented P2, `analyze.ts:106-111`). |
| Starter in one system, bench in another | **No contradiction** — canonical `toCanonicalRosters` and legacy `buildLeagueResponse` both read Sleeper `roster.starters` vs `roster.players`. Weekly/trade use canonical; legacy `/api/league` uses its own split; values match because the source array matches. |
| IR disagreement | League has 0 IR slots → `ir` arrays empty in every stack. Not exercised. Divergence *latent*: canonical models `ir`/`taxi` explicitly; legacy `/api/league` and bridge do not. |
| Roster-slot / FLEX eligibility | **Three interpretations**: `slots.ts FLEX_ELIGIBILITY` (canonical/weekly, RB/WR/TE for `FLEX`), trade **validation** hard-codes `["RB","WR","TE"]` (`analyze.ts:171`) while trade **evaluation** uses resolved constraints, draft engine uses `cfg.roster_positions` raw. For this league (`FLEX` = RB/WR/TE) they agree; a `SUPER_FLEX` or `W/R/T`+`Q` league would diverge in the trade validation path. |
| Inconsistent league scoring | **No value disagreement** — every path ultimately calls `calculateFantasyPoints` on Sleeper `scoring_settings` / `raw_scoring` (same data). **Representation** differs (`scoring_rules[]` vs `scoring_settings` map) and there are **two rule normalisers** (`toCanonicalScoringRules` vs `buildNormalizedRules`) and **two hashes** (canonical has none; season model has `hashScoringSettings`). |
| Inconsistent current week | All live paths currently resolve `getNflState().week = 1`. **No single cached week** — each engine re-fetches `/state/nfl` (cached ~short TTL). Projection model hard-codes `season 2026` (matches). Low risk now; a mismatch window exists around the Tue/Wed NFL week rollover. |
| Different manager/roster mapping | **Consistent** — one resolver (`lib/leagues/resolve.ts` + `resolveManager`) is used by canonical routes; `known_managers` are test fixtures only, no hard-coded branches (verified: `multi-league-isolation`, `league-manager-routing` tests pass). Legacy `?league=` routes are league-wide (no manager) or use the same resolver. |
| Stale roster snapshots | Canonical stack builds fresh per request (no cross-request reuse) → **no staleness within a request**, but **N provider reads per manager per page** (see P1-4). Draft engine correctly uses `getLeagueRostersLive`. `buildBaseProjections` is **module-cached for the whole process** — a long-lived serverless instance serves month-old actuals silently (P1-5). |
| Projection-version disagreement | **Yes, by design** — weekly absolute (`sleeper-weekly-rotowire`) ≠ season model (`ri-structural-2026.3`) ≠ special-teams vendored snapshot. Weekly K/DST (`pts_std` approximation) and draft K/DST (vendored snapshot) will give **different K/DEF point values** for the same player. No consumer-visible lineage field ties a recommendation to the exact set used. |
| Duplicate players | Canonical crosswalk **collapses** cross-provider duplicates (test: "the same gsis-mapped player from two providers is one free agent" passes). Legacy stack has no dedupe but is single-provider so no duplicates arise today. |
| Recommendations involving unavailable players | Weekly waiver engine sources candidates only from `ctx.availability.free_agents` (canonical identity). Trade engine validates ownership + fieldability. **No defect found.** |
| Recommendations creating an illegal roster | Trade `validateTrade` enforces roster-size + `maxSlotMatching` fieldability; weekly lineup enforces slot legality. **No defect found.** |
| Trade analysis using stale rosters | `buildTradeAnalysisContext` = one read, threaded immutably. **Safe within a call.** Across `analyze` vs `discover` vs `negotiate` calls, three independent reads (acceptable — each call is self-consistent). |
| Waiver ownership vs trade/weekly ownership | Same source (`snap.rosters`), same request-time read. **Consistent.** |

---

## 7. Discrepancy report (P0 / P1 / P2 / P3)

### P0 — can cause an invalid recommendation or materially incorrect roster state

**None proven** under the current state (single league, all-Sleeper, `FLEX`=RB/WR/TE,
0 IR slots, in-season week 1).

### P1 — systems materially disagree; may not always create an invalid recommendation

| # | Title | Affected systems | Evidence | Root cause | Recommended fix | Behaviour change? | Regression test to add |
|---|---|---|---|---|---|---|---|
| **P1-1** | Two league-state stacks with independent normalisation | canonical stack vs `lib/sleeper/service.ts` + `lib/analytics/*` + `lib/scoring/scoring-service.ts` (~20 endpoints) | §1, §3 matrix; `buildLeagueBundle`/`buildSnapshot`/`loadSeasonData` never call `buildCanonicalLeagueState` | historical: canonical layer was added post-hoc (Post-Draft Foundation) and legacy routes were left in place for backward compat | Phase 1B: reimplement `/api/leagues/:slug`, `/api/leagues/:slug/snapshot`, `/api/leagues/:slug/managers/:slug/snapshot` on top of `buildCanonicalLeagueState`; keep legacy `?league=` + `/api/league` + `/api/snapshot` as thin compatibility adapters over the canonical snapshot | normalisation only (field shapes preserved via adapter); values must not move | golden-file test: legacy `/api/leagues/:slug/snapshot` payload vs a canonical-derived rebuild for `bloodline-bowl` — standings, records, roster counts identical |
| **P1-2** | Identity space split: `canonical_player_id` vs raw Sleeper `player_id` | projections, draft, analytics, scoring, bridge (raw) vs weekly, trades, persistence (canonical) | `lib/projections/service.ts`, `lib/draft/service.ts` operate on `player_id`; `lib/canonical/players.ts` is never imported there | season/draft models predate the crosswalk | Phase 1B: add `canonical_player_id` alongside `player_id` in the season/draft projection outputs (crosswalk resolve on emit) — additive, does not remove `player_id`; then downstream (weekly RI signal, discovery) joins on canonical id instead of `sleeper_player_id` | additive field; join key change in `projections-ri.ts` (currently keys on `sleeper_player_id` — keep as fallback) | test: every `PlayerProjection` for `bloodline-bowl` resolves to a `canonical_player_id` that matches the canonical snapshot's `players[]` for rostered players |
| **P1-3** | Two projection systems, no consumer-visible lineage | weekly + trades (`sleeper-weekly-rotowire`) vs draft + `/api/projections` (`ri-structural-2026.3`) vs special-teams vendored snapshot | `sleeper-weekly.ts` vs `projections/build.ts`; K/DST path differs (`pts_std` vs `buildSpecialTeamsProjections`) | deliberate (weekly needs opponent-specific; season model has no defensible weekly) — but the *lineage* is not surfaced | add `projection_lineage[]` to the snapshot / recommendation envelope (§4.3, §5.3); do **not** merge the models | additive metadata only | test: `/api/intelligence/...` response carries `projection_lineage` with `sleeper-weekly-rotowire` + a `scoring_fingerprint` equal to `league.scoring_fingerprint` |
| **P1-4** | N provider reads per manager per page | `/api/context`, `/api/intelligence`, `/api/lineup`, `/api/matchup`, `/api/waivers` each call `buildCanonicalLeagueState` independently | each route builds its own context; no request-scoped or short-TTL snapshot cache | no shared snapshot cache layer | Phase 1C: a short-TTL (e.g. 20–40 s) in-process `buildCanonicalLeagueState` memo keyed by `league_slug` (+ a `?fresh=1` bypass), OR a request-batching endpoint. Trade engine already does the "one read" pattern — generalise it. | none (same data, fewer fetches); must respect draft-night freshness for draft routes (exclude) | test: two back-to-back `/api/lineup` + `/api/waivers` calls for the same manager issue one underlying `getLeague`/`getPlayerIndex` set within the TTL |
| **P1-5** | `buildBaseProjections` module-cached for process lifetime | `/api/projections`, `/api/leagues/:slug/projections`, draft recommendations, weekly RI ordinal signal | `lib/projections/build.ts` caches at module scope keyed only by season/version; no TTL, no data-freshness check | performance (actuals load is expensive) | add a `data_as_of` staleness guard / max-age to the module cache; surface `data_as_of` in `projection_lineage` | none functionally; adds a periodic recompute | test: `getBaseProjections()` cache entry older than N hours triggers a rebuild (inject clock) |
| **P1-6** | FLEX eligibility hard-coded in trade validation | `lib/trades/analyze.ts:171` `flex_positions: ["RB","WR","TE"]` for the validation constraint set | code literal; evaluation path uses resolved `tctx.constraints` | shortcut in the validation-only constraint builder | derive `flex_positions` from `roster_settings.starting_slots` via `slotEligiblePositions` (same helper weekly uses) | none for `bloodline-bowl` (`FLEX`=RB/WR/TE); fixes latent bug for SUPER_FLEX / W-R-T-Q leagues | test: a synthetic SUPER_FLEX league — a QB-for-QB trade validates as roster-legal |

### P2 — lineage / versioning / maintainability

| # | Title | Affected systems | Evidence | Root cause | Recommended fix | Behaviour change? | Regression test |
|---|---|---|---|---|---|---|---|
| **P2-1** | No `league_snapshot_id` / `content_hash` on the live snapshot | all canonical consumers | `buildCanonicalLeagueState` returns `captured_at` but no id; hash lives only in `lib/persistence/serialize.ts` | id was only ever needed for persistence | surface `league_snapshot_id` + `content_hash` on the live object (§5.1) | additive | test: `buildCanonicalLeagueState` twice against a fixed fixture → identical `league_snapshot_id` |
| **P2-2** | Two scoring-rule normalisers + two hash conventions | `toCanonicalScoringRules` (canonical) vs `buildNormalizedRules` (scoring-service) vs `hashScoringSettings` (season model) | `lib/providers/sleeper/canonical.ts` vs `lib/scoring/normalize.ts` vs `lib/analytics/historical-scoring.ts` | independent evolution | pick `hashScoringSettings(raw_scoring)` as the one `scoring_fingerprint`; have `scoring-service` classification consume `raw_scoring` from the canonical snapshot | none (same inputs) | test: `scoring_fingerprint` from the canonical snapshot == `buildLeagueProjections(...).scoring_hash` for `bloodline-bowl` |
| **P2-3** | `player_data_version` / `crosswalk_version` unstamped | identity resolution everywhere | `createSleeperResolver` uses `getPlayerIndex()` with no generation stamp; `PlayerCrosswalk` load has no version | never surfaced | add both to the snapshot (§4.2) | additive | test: snapshot carries a non-null `player_data_version` |
| **P2-4** | Trade `analyze` cannot resolve a raw GSIS player id | `/api/trades/analyze` | `analyze.ts:106-111` — `resolvePlayer` checks canonical id, `sleeper_id`, `yahoo:` prefix, `name_key` — not `gsis_id` | oversight; discovery/negotiate use internal canonical ids so never hit it | add `byGsis` map to `resolvePlayer` (identifiers already carry `gsis_id`) | additive input acceptance | test: `analyze` with a transfer asset given as a bare GSIS id resolves the player |
| **P2-5** | Bye detection still a stub in `buildManagerContext` | `/api/context` | `manager-context.ts:243` returns a fixed "deferred" note despite `SleeperScheduleProvider` now existing | written before the schedule provider landed | wire `buildManagerContext` byes to `getScheduleProvider()` (as `buildWeeklyTeamContext` already does) | `bye_week_notes` becomes real | test: `/api/context` for a manager with a week-1-bye player flags it |
| **P2-6** | `week` volatile-key exclusion asymmetry | persistence dedupe | `snapshotContentHash` excludes `captured_at` etc. but **includes** `week` — correct — yet `matchups`/`standings` shift within a week as games play, so a mid-week re-capture is a "new" snapshot even with no roster change | expected, but not documented as intended | document: intra-week snapshots are expected to differ (live scores); dedupe is for *identical* state only | none | n/a (doc) |

### P3 — cleanup / documentation

| # | Title | Evidence | Fix |
|---|---|---|---|
| **P3-1** | Pre-draft live tests are stale | `draft-live.test.ts` "pre-draft state", `analytics-live` standings/managers/snapshot fail because league is `in_season` | re-scope those suites to in-season assertions or gate them on `status === "pre_draft"` |
| **P3-2** | `lib/bridge/state.ts` shares the name "state" with `lib/canonical/state.ts` but is the client draft board | naming | rename to `bridge/draft-board-state.ts` or document the distinction in the module header |
| **P3-3** | `/api/snapshot` (legacy) and `/api/leagues/:slug/snapshot` and `/api/leagues/:slug/managers/:slug/snapshot` all called "snapshot", none is the canonical snapshot | naming collision with the Phase 1 deliverable | reserve "snapshot" for `CanonicalLeagueSnapshot`; rename the compact analytics one to "overview" in docs |
| **P3-4** | `resolveLeagueForQuery` silently falls back to `bloodline-bowl` when `?league=` is empty | `resolve.ts:140` (documented backward-compat) | keep, but log a deprecation warning to move callers to explicit slugs |
| **P3-5** | `CANONICAL_SCHEMA_VERSION = 1` — additive §4 fields require a bump + a migration note | `schema.ts:21` | bump to `2`, note persisted v1 snapshots lack the new fields (readers must tolerate absence) |

---

## 8. Recommended remediation sequence (minimum canonicalisation plan)

Ordering favours "one normalised state → many consumers", smallest safe steps first, no
engine rewrites.

**Step 1 — surface the anchor (additive, zero behaviour change).**
Add `league_snapshot_id`, `content_hash`, `scoring_fingerprint`, `roster_fingerprint`,
`player_data_version`, `crosswalk_version` to the live `CanonicalLeagueSnapshot`
(§4.2). Bump `CANONICAL_SCHEMA_VERSION` to 2. (Fixes P2-1, P2-3; enables everything below.)
Tests: deterministic-id, fingerprint-equality.

**Step 2 — standardise the lineage envelope (additive).**
Add `projection_lineage[]` to the snapshot and a `RecommendationLineage` block to the
weekly + trade + draft responses (§4.3, §5.3). No numbers move. (Fixes P1-3.)

**Step 3 — unify fingerprints (normalisation only).**
Make `scoring_fingerprint = hashScoringSettings(raw_scoring)` the single value; point the
season model's `scoring_hash` and any scoring-service classification at the canonical
`raw_scoring`. (Fixes P2-2.)

**Step 4 — one read per request (performance, no behaviour change).**
Introduce a short-TTL in-process snapshot memo keyed by `league_slug` (draft routes opt
out). Generalise the trade engine's "one read" pattern. (Fixes P1-4.)

**Step 5 — canonical identity on projection outputs (additive).**
Emit `canonical_player_id` alongside `player_id` from `lib/projections/*` and
`lib/draft/*`; switch `projections-ri.ts` join to canonical id with `sleeper_player_id`
fallback. (Fixes P1-2.) Add the GSIS-id acceptance to `analyze` (P2-4).

**Step 6 — rebuild the legacy REST resources on canonical (normalisation, golden-file gated).**
`/api/leagues/:slug`, `/api/leagues/:slug/snapshot`, `/api/leagues/:slug/managers/:slug/snapshot`
become thin adapters over `buildCanonicalLeagueState`. Keep `?league=` + `/api/league` +
`/api/snapshot` as compatibility shims. Golden-file tests must show byte-stable payloads
(or an explicit, reviewed diff). (Fixes P1-1.)

**Step 7 — small correctness fixes.**
FLEX eligibility from slots in trade validation (P1-6); `buildBaseProjections` staleness
guard (P1-5); wire `buildManagerContext` byes (P2-5).

**Step 8 — cleanup.**
P3 items: re-scope live tests, rename collisions, schema-version migration note.

Steps 1–5 are pure additive/observability and can ship without touching any engine output.
Step 6 is the only one that rewrites route internals and it is gated by golden files.

---

## 9. Proposed deterministic integration tests

New suite `test/canonical-consistency.test.ts` (offline, fixture-driven — a captured
`bloodline-bowl` + `devoted-to-the-game` snapshot pair committed under `test/fixtures/`):

1. **Deterministic id** — `buildCanonicalLeagueState` twice on one fixture ⇒ identical
   `league_snapshot_id` and `content_hash`; a one-roster-slot edit ⇒ different id.
2. **Ownership agreement** — for every `canonical_player_id` in `players[]`: at most one
   owning team across `rosters[]`; `weekly availability` classification and `trade ownership`
   map agree for all rostered ids.
3. **Identity agreement** — every rostered player's season projection (`lib/projections`)
   resolves (via crosswalk) to a `canonical_player_id` present in `snapshot.players[]`.
4. **Scoring fingerprint agreement** — `snapshot.league.scoring_fingerprint ==
   buildLeagueProjections(base, cfg).scoring_hash`.
5. **Starter/bench agreement** — `rosters[].starters` ∪ `bench` ∪ `ir` ∪ `taxi` ==
   `all_players` (no leaks, no dupes); matches the legacy `/api/league` team split.
6. **FLEX legality** — `maxSlotMatching(starting_slots, rostered players)` fills every
   base slot for each team, or the snapshot carries an `EMPTY_STARTER_SLOT` warning.
7. **Week coherence** — `snapshot.week == getNflState().week` (mock the provider);
   `season == PROJECTION_SEASON` for a current-season league.
8. **Projection lineage** — `/api/intelligence` response `projection_lineage` non-empty,
   each entry's `scoring_fingerprint == league.scoring_fingerprint` or an explicit warning.
9. **Multi-league isolation** — building both fixtures in the same test never lets a
   `bloodline-bowl` `canonical_player_id`/team/manager appear in the `devoted-to-the-game`
   snapshot (extends the existing `multi-league-isolation` suite to the new fields).
10. **Legacy parity golden files** — `/api/leagues/:slug/snapshot` (canonical-rebuilt) vs a
    committed golden file: standings rows, records, roster counts, budget, draft-pick counts
    identical.
11. **Snapshot immutability** — persisting the same fixture twice ⇒ `outcome: "duplicate"`,
    same `id`; a mutated fixture ⇒ `outcome: "created"`, new `id`.
12. **Trade-context single-read** — instrument the provider override; `analyzeTrade`,
    `discoverTrades`, `negotiateTrade` each perform exactly one `getLeagueState`.

Live smoke (opt-in, `RUN_LIVE=1`): `test/canonical-consistency-live.test.ts` — build the
real `bloodline-bowl` snapshot, assert §2/§5/§6 checks against production data, no 500s.

---

## 10. Verdict

### CONDITIONAL GO — implement the canonical snapshot as the shared source of truth.

**Why GO:**
- The canonical model already exists, is well-designed, provenance-preserving, and
  **already backs the two hardest engines** (weekly intelligence, trade engine) through a
  single, tested code path.
- The trade engine already demonstrates the target pattern (one immutable read → many
  consumers) in production.
- The persistence layer already gives immutable, content-hash-versioned snapshots.
- No P0 was found; the plan is overwhelmingly additive.

**Conditions (must be met before/while implementing):**
1. **Steps 1–3 first, purely additive** — `league_snapshot_id`, fingerprints, and
   `projection_lineage` land with zero behaviour change and full determinism tests
   (§9.1–9.4, 9.11) before any route is re-pointed.
2. **Legacy route migration (Step 6) is golden-file gated** — `/api/league`,
   `/api/snapshot`, `/api/leagues/:slug/*` payloads must be shown byte-stable or the diff
   explicitly reviewed and signed off. No silent field/shape changes.
3. **Projections stay separate models** — the canonical snapshot references projection
   lineage; it does **not** merge `sleeper-weekly-rotowire` and `ri-structural-2026.3`, and
   does not embed point values.
4. **Draft-night freshness preserved** — the request-scoped snapshot memo (Step 4) must
   exclude the live-draft routes, which keep using `getLeagueRostersLive`.
5. **No test is loosened to hide a discrepancy** — the 10 stale live-test failures are
   re-scoped to in-season assertions, not deleted or weakened (P3-1).
6. **Schema version bump + reader tolerance** — persisted v1 snapshots must still load
   (new fields optional on read).

**NOT in scope for this canonicalisation** (explicitly deferred): the Matchup Model, the R
Football Intelligence Engine, and the Team Management Orchestrator. Replacement-level, VOR,
projection, trade-valuation, and draft-geometry calculations remain owned by their current
modules.

---

## Appendix A — files inspected

Canonical: `lib/canonical/{schema,state,ids,players,manager-context}.ts`.
Providers: `lib/providers/{registry,types}.ts`, `lib/providers/sleeper/{provider,canonical}.ts`,
`lib/providers/yahoo/*` (skim).
Leagues: `lib/leagues/{registry,resolve,api,managers,manager-draft}.ts`.
Weekly: `lib/weekly/{context,intelligence,routes-shared,availability,scoring,projections-ri}.ts`,
`lib/weekly/projections/sleeper-weekly.ts`, `lib/weekly/schedule/sleeper-schedule.ts`;
skim `lib/weekly/{lineup,matchup,waivers,replacement,slots}.ts`.
Trades: `lib/trades/{analyze,context,providers}.ts`, `lib/trades/discovery/discover.ts`,
`lib/trades/negotiation/negotiate.ts`; grep across `lib/trades/**`.
Projections: `lib/projections/{service,build,league}.ts` (build/league via grep).
Draft: `lib/draft/service.ts`; refs to `lib/draft/{engine,survival,special-teams}`.
Scoring: `lib/scoring/{scoring-service,calculate}.ts`.
Analytics: `lib/analytics/{snapshot,season-data}.ts`; refs to `standings`, `transactions`,
`historical-scoring`, `history`, `managers`.
Sleeper: `lib/sleeper/service.ts`; refs to `client`, `draft`, `draft-service`, `normalize`.
Persistence: `lib/persistence/{capture,serialize,types}.ts`,
`lib/persistence/supabase/stores.ts`.
Bridge: `lib/bridge/state.ts`.
Routes: every `app/api/**/route.ts` (import-level map, §3); full read of
`app/api/leagues/:slug/managers/:slug/snapshot/route.ts`, `app/api/league/:league/state`,
plus grep of all route imports.
Config: `package.json`, `vercel.json`, `lib/leagues/registry.ts`.

## Appendix B — commands run

- `npm test` → 1235 pass / 10 fail (all failures = stale pre-draft live suites; see §6, P3-1).
- `curl https://api.sleeper.app/v1/state/nfl` → season 2026, week 1, regular.
- `curl https://api.sleeper.app/v1/league/1395549281678532608` → `in_season`,
  `playoff_week_start 15`, roster `[QB,RB,RB,WR,WR,TE,FLEX,FLEX,K,DEF,BN×5]`, no IR slot.
- Structural greps for cross-engine state/identity/scoring/week derivation (§1, §3).

## Appendix C — what could not be proven

- **Yahoo-league behaviour** — no Yahoo league is authorised (`AWAITING_CREDENTIALS`), so
  the cross-provider identity path (`yahoo_id` / `yahoo_player_key` resolution, Yahoo
  roster/scoring normalisation) is exercised only by unit fixtures, not live data. The
  canonical/legacy divergence (P1-1, P1-2) is **Sleeper-only** today; its real cost lands
  when Yahoo goes live.
- **A live automated cross-engine differ** — §6 contradiction results are from code
  analysis plus the passing isolation/parity suites; the dedicated
  `canonical-consistency` suite (§9) is proposed, not yet written.
- **Serverless cache lifetimes in production** — `buildBaseProjections` module cache and
  Next fetch-cache TTLs (P1-5, P1-4) are reasoned from code; actual Vercel instance reuse /
  staleness windows were not measured against production.
- **Draft-night paths** — the league has already drafted; the live-draft freshness
  behaviour (`getLeagueRostersLive`, mock-draft rehearsal) could not be re-verified against
  an active draft.
- **Transaction-ledger drift** — the Supabase persistence layer's live state (row counts,
  last capture) was not queried; `/api/cron/capture` runs daily at 12:00 UTC per
  `vercel.json` but its recent run history was not inspected.
