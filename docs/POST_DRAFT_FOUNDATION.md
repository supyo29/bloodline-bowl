# Post-Draft Foundation — Multi-League, Multi-Manager, Multi-Provider

This document describes the architectural spine added in the *Post-Draft
Foundation* phase. It is the layer every future analytical engine (trades,
waivers, matchup win probability, lineup optimisation, playoff sims, …) will
consume. This phase deliberately builds **no analytics** — only the reliable,
historical, provider-independent data foundation those engines need.

```
Sleeper API ─┐
             ├─▶  Provider adapter  ─▶  Canonical fantasy schema  ─▶  League / manager context
Yahoo API ───┘         (lib/providers)        (lib/canonical)            (lib/canonical/*.ts)
                                                     │
                                          Snapshot + Ledger stores
                                             (lib/persistence)
                                                     │
                                            Future intelligence layer
```

**Non-negotiable rule:** no analytical or shared code consumes a Sleeper-native
or Yahoo-native object. Everything passes through the canonical schema first.

---

## 1. Layers

| Layer | Location | Responsibility |
| --- | --- | --- |
| League registry v2 | `lib/leagues/registry.ts` | slug → provider + external id + season + known managers |
| Provider abstraction | `lib/providers/` | the *only* code that calls a fantasy platform API |
| Canonical schema | `lib/canonical/schema.ts` | the internal analytical model + `CANONICAL_SCHEMA_VERSION` |
| Player crosswalk | `lib/canonical/players.ts` | one NFL identity across providers; unresolved is recorded |
| League-state service | `lib/canonical/state.ts` | `buildCanonicalLeagueState(slug)` → `CanonicalLeagueSnapshot` |
| Manager-context service | `lib/canonical/manager-context.ts` | generic `buildManagerContext(slug, manager)` |
| Persistence | `lib/persistence/` | `SnapshotStore` / `LedgerStore` interfaces + Supabase impl |
| Capture logic | `lib/persistence/capture.ts` | `captureLeagueState`, `syncLeagueTransactions` (reused by CLI + cron) |

---

## 2. Routes added

| Route | Purpose |
| --- | --- |
| `GET /api/providers` | live readiness of every provider + persistence; per-league config status |
| `GET /api/league/{league}/state` | canonical current state (the `CanonicalLeagueSnapshot`) |
| `GET /api/context/{league}/{manager}` | generic manager-centric analytical context |
| `GET /api/history/{league}/week/{week}` | durable historical snapshot (preferred capture + retained versions) |
| `GET /api/transactions/{league}` | canonical transactions — from the ledger, falling back to a live read |
| `GET /api/auth/yahoo/connect` · `/callback` · `/status` | Yahoo OAuth shells (pre-auth: explicit `NOT_CONFIGURED`) |

Legacy `?league=` query routes are unchanged and still supported.

### Degraded-state vocabulary

`READY · DEGRADED · PARTIAL · NOT_CONFIGURED · AUTH_REQUIRED · PROVIDER_ERROR ·
PERSISTENCE_NOT_CONFIGURED · PERSISTENCE_ERROR`

`/api/league/{league}/state` reports **`live_provider_status`** and
**`history_persistence_status`** *separately*. A Supabase outage still returns
live league data with a `HISTORY_PERSISTENCE_UNAVAILABLE` warning; it never
blocks a live read and never silently claims a snapshot was saved.

---

## 3. How to add …

### … a league
Append one object to `LEAGUE_TARGETS` in `lib/leagues/registry.ts`:

```ts
{
  key: "my-league",
  provider: "sleeper",              // or "yahoo"
  league_id: "1234567890",          // provider-native id
  external_league_id: "1234567890",
  season: 2026,
  display_name: "My League",
  known_managers: ["someslug"],     // test fixtures only — never branched on
  sleeper_username: "commish", sleeper_user_id: "…",  // Sleeper only
  yahoo_league_key: null,           // Yahoo only, resolved after auth
  enabled: true,
}
```

No route code changes. `/api/league/my-league/state` works immediately (Sleeper)
or reports `AUTH_REQUIRED` (Yahoo, until connected).

### … a manager
Nothing. Any league member resolves generically from live provider data.
`lib/leagues/managers.ts` only pins a *canonical slug + exact-cased username* for
the three known managers; it never binds them to a league and is not required
for resolution.

### … a provider (e.g. ESPN)
1. `lib/providers/espn/provider.ts` implementing `FantasyProvider`
2. `lib/providers/espn/canonical.ts` — pure `Raw → Canonical` adapter
3. register it in `lib/providers/registry.ts#getProvider`

The analytical engine does not change.

---

## 4. Canonical schema (major entities)

`CanonicalLeague`, `CanonicalManager`, `CanonicalFantasyTeam`, `CanonicalRoster`
(+ `CanonicalRosterSlot`), `CanonicalPlayer` (+ `PlayerIdentifiers`,
`PlayerResolution`), `CanonicalStanding`, `CanonicalMatchup`,
`CanonicalTransaction`, `CanonicalScoringRule`, `CanonicalDraftPick`,
`CanonicalWaiverState`, and the aggregate `CanonicalLeagueSnapshot`.

Every provider-sourced entity carries `provenance: { provider, provider_id,
provider_synced_at }`. Provider ids are preserved in
`CanonicalPlayer.identifiers` (`sleeper_id`, `yahoo_id`, `yahoo_player_key`,
`gsis_id`, …) alongside the canonical id.

### Player identity

Resolution order: **stable cross-provider id (gsis)** → **provider's own id** →
**name+position+team** → **name+position** → **unresolved (recorded, never
guessed)**. Name matching strips suffixes, punctuation and accents
(`Michael Pittman Jr.` → `michael pittman`). The crosswalk source is pluggable;
production reads the shared Supabase `nfl_players` table read-only.

---

## 5. Persistence

Supabase is the production store, **behind the `SnapshotStore` / `LedgerStore`
interfaces** — it is an implementation detail, never part of the domain model.
Tests use `memoryPersistence()`; a filesystem/JSON path exists for export and
recovery (`lib/persistence/serialize.ts`).

### Tables (migration `bridge_post_draft_foundation`)

| Table | Contract |
| --- | --- |
| `bridge_league_snapshots` | **immutable, versioned.** `UNIQUE(league_slug, season, week, capture_type, content_hash)` + a trigger that blocks `UPDATE`/`DELETE`. A later capture with identical content is a no-op; changed content is a new row. `capture_type ∈ {PRE_WEEK, MID_WEEK, FINAL, AD_HOC}`. |
| `bridge_transaction_ledger` | **append-only, idempotent.** `UNIQUE(league_slug, season, provider, provider_transaction_id)`. Overlapping sync windows never duplicate. |
| `bridge_capture_runs` | capture/sync run metadata |

RLS is enabled with **no policies** — server/service-role access only.

### Environment

```
SUPABASE_URL=https://<ref>.supabase.co     # or SUPABASE_PROJECT_REF=<ref>
SUPABASE_SERVICE_ROLE_KEY=<service_role JWT>   # server secret — never committed, never logged, never sent to a client
```

With neither set, every persisted-write path returns
`PERSISTENCE_NOT_CONFIGURED` and reads return `NOT_CAPTURED`. Live provider reads
are unaffected.

### Capture

Core logic is in `lib/persistence/capture.ts`:

```ts
captureLeagueState(leagueSlug, { capture_type })   // -> a snapshot version
syncLeagueTransactions(leagueSlug, { week })        // -> idempotent ledger append
```

CLI:

```bash
npx tsx scripts/capture-snapshot.ts bloodline-bowl --type FINAL --transactions
npx tsx scripts/capture-snapshot.ts --all --type MID_WEEK
```

A Vercel Cron / API job would call the same two functions. Cron wiring is
deferred (no cron infra configured yet).

---

## 6. Yahoo

Structurally complete, **not live**. `YahooProvider` reports `NOT_CONFIGURED`
(no env) or `AUTH_REQUIRED` (env set, no account connected) and never fabricates
data. The `Yahoo flat → canonical` adapter (`lib/providers/yahoo/canonical.ts`)
*is* exercised against a fixture, so only the fetch/flatten layer is new work
when credentials arrive.

### OAuth (design — unverified against the live API)

```
YAHOO_CLIENT_ID       OAuth client id
YAHOO_CLIENT_SECRET   OAuth client secret   (server secret)
YAHOO_REDIRECT_URI    must match the registered redirect exactly
YAHOO_GAME_KEY        optional; defaults to "nfl"
```

Flow: `/api/auth/yahoo/connect` → Yahoo consent (CSRF `state` cookie) →
`/api/auth/yahoo/callback` exchanges the code for tokens →
`YahooTokenStore` persists them server-side (read-only scope `fspt-r`). Token
values are never logged or returned to a client. The Supabase-backed token store
(`yahoo_connections`) is a follow-up; the callback currently reports
`CONNECTED_NOT_PERSISTED` after a successful exchange.

Two Yahoo leagues are registered — `maclin-on-chicks-xvi` (`82713`) and
`rogers-park` (`287140`) — proving the Yahoo path is not single-league. For each,
only the human-facing id is known; the full Yahoo `game.l.id` key is resolved and
persisted (`yahoo_league_key`) once authenticated access exists, and may differ
per season. The canonical slug never changes and is the only analytical identity
— Yahoo's provider ids stay in `provenance`, never in `canonical_league_id`.

Initial registry: **4 leagues · 2 providers · 3 known manager contexts
(`supyo29`, `BijiMac`, `DarthMarker`) · 1 shared canonical architecture.**
