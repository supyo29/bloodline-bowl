# Bloodline Bowl Team Management — Phase 1B.1

**Canonical-path hardening — completion report + contract reference**

Date: 2026-09-06
Predecessor: `docs/TEAM_MANAGEMENT_PHASE_1A.md` (verdict: CONDITIONAL GO)
Scope guard: **no second canonical model was created**; the legacy REST/analytics
stack was **not** migrated (that is Phase 1B.2); projection models were **not**
merged; no recommendation/scoring/waiver/lineup methodology was redesigned.

---

## Part 1 — Contract reference

### 1.1 `league_snapshot_id`

Every `CanonicalLeagueSnapshot` returned by `buildCanonicalLeagueState` (success
**and** degraded shell) carries `lineage.league_snapshot_id`:

```
snap:<league_slug>:<season>:w<week>:<first 16 hex of content_hash>
e.g.  snap:bloodline-bowl:2026:w1:b02bbc9d4a8a0190
```

**What contributes to the hash** (`snapshotContentHash`, `lib/persistence/serialize.ts`):
everything in the snapshot **except**

- top-level volatile keys: `captured_at`, `provider_synced_at`,
  `live_provider_status`, `history_persistence_status`, `warnings`, `lineage`
- every nested `provider_synced_at` (inside each `provenance` block) — a per-read
  wall-clock stamp, not league state. Stripped recursively before hashing.

So the hash **does** reflect: `schema_version`, the full `league` config
(`raw_scoring`, `roster_settings`, `playoff_settings`, `waiver_settings`, and the
derived `scoring_fingerprint` / `roster_fingerprint`), `season`, `week`,
`managers`, `teams`, `rosters` (**including `starters` / `bench` / `ir` — a
lineup-only change produces a new id**), `standings`, `matchups`,
`recent_transactions`, `draft_picks`, `players`, `unresolved_players`.

**Determinism** (verified live, `bloodline-bowl`): two back-to-back reads of an
unchanged league produce an identical `league_snapshot_id`. A roster change, a
starter⇄bench swap, or a scoring change each produce a different id.

**Immutability**: unchanged — the persistence layer still treats a matching
`content_hash` for `(league_slug, season, week, capture_type)` as a *duplicate*,
never an overwrite. The nested-timestamp fix makes that dedupe actually fire for
identical re-captures (it previously almost never did).

### 1.2 Lineage envelope — `RecommendationLineage`

`lib/canonical/lineage.ts`. Two nested shapes; every field an engine cannot yet
populate is optional (progressive adoption).

```ts
SnapshotLineage {
  league_snapshot_id, snapshot_schema_version, content_hash, generated_at,
  provider, league_slug, league_id, season, week,
  scoring_fingerprint, roster_fingerprint, player_data_version, crosswalk_version
}

ProjectionLineageEntry {
  role: "weekly_absolute" | "season_ordinal" | "special_teams" | "benchmark",
  source, model_version, generated_at, scoring_fingerprint,
  status: "READY" | "PARTIAL" | "UNAVAILABLE" | "UNRESOLVED"
}

RecommendationLineage {
  snapshot: SnapshotLineage,
  projections: ProjectionLineageEntry[],
  engine_versions: Record<string, string>   // { weekly_engine, trade_foundation, … }
}
```

**Who carries it now:**

| Surface | Field |
|---|---|
| `CanonicalLeagueSnapshot` | `.lineage` (SnapshotLineage) |
| `WeeklyTeamContext` | `.lineage` (RecommendationLineage) |
| `WeeklyIntelligence` result + `ContextView.context_meta` | `.lineage` — so `/api/intelligence`, `/api/lineup`, `/api/matchup`, `/api/waivers` responses carry it |
| `TradeAnalysisContext` | `.lineage` |
| `TradeAnalysis` (`/api/trades/analyze`) | `.lineage` (`null` only when `status: CONTEXT_UNAVAILABLE`) |
| season projection responses (`/api/leagues/:slug/projections`, `/api/projections`) | `.projection_lineage` + per-player `.canonical_identity` |

Not yet adopted (progressive): `discover` / `negotiate` response bodies (their
context carries it; the response envelope does not surface it yet), start/sit,
matchup-only routes' own bodies (covered via `context_meta`).

### 1.3 Scoring fingerprint ownership

`lib/canonical/scoring-fingerprint.ts#scoringFingerprint(raw)` →
`scoring:v1:<24 hex>` is **authoritative** for the canonical path.

Equivalence rules (test-enforced, `test/canonical-lineage.test.ts`):
1. key order irrelevant
2. a rule whose value is `0` ≡ the rule being absent (both score nothing)
3. `1` ≡ `1.0`, `-0` ≡ `0`, sub-1e-6 dust collapses
4. any non-zero value change, or add/remove of a non-zero rule, changes it

**Legacy, unchanged, still shipped:** `lib/analytics/historical-scoring.ts#hashScoringSettings`
(the 32-bit `sha_*_n*` form) is still the season model's cache key and the
`scoring_hash` on projection responses. `leagueScoringContext` now returns **both**
(`scoring_hash` legacy + `scoring_fingerprint` canonical). Phase 1B.2 can retire
`hashScoringSettings` once the analytics surface is on the canonical path.

Verified live: `CanonicalLeague.scoring_fingerprint` (from the provider's
`raw_scoring`) `===` the fingerprint the season model computes from
`getLeague().scoring_settings` — `scoring:v1:29acc6bcd911df090b5b9b9c` for
`bloodline-bowl`.

### 1.4 `player_data_version`

`lib/canonical/player-data-version.ts` → `players:v1:<16 hex>`. A **content hash**
of per-player material metadata — `canonical_player_id`, `nfl_team`, `position`,
`eligible_positions`, `injury_status`, `status`, `is_team_defense`,
`resolution.method` — for every player in the snapshot, sorted.

**Not a timestamp.** Neither Sleeper's `/players/nfl` nor Yahoo's player feed
exposes a generation number, so a hash of the fields that actually affect a
recommendation is the strongest available identity. Two recommendations with the
same `player_data_version` used the same player metadata; a different value means
some player's team / injury / eligibility / identity-resolution changed. Name
spelling fixes and new id aliases are deliberately excluded (they change no
recommendation).

### 1.5 Provider-read memoization scope

`lib/canonical/request-scope.ts`.

- `runInLeagueStateScope(fn)` establishes an `AsyncLocalStorage` memo map for the
  duration of `fn`. Nesting composes (a nested call reuses the parent scope).
- Inside a scope, `buildCanonicalLeagueState(slug, opts)` is memoized on
  `slug` + the three read-shape flags (`includeMatchups`,
  `includeRecentTransactions`, `reportPersistence`).
- **Not a cache**: the map is unreachable once `fn` resolves. No TTL, no
  process-lifetime retention. A later independent operation (a new HTTP request,
  the next cron tick) reads the provider fresh.
- A scope assumes ONE provider/crosswalk environment for its lifetime (the normal
  case). `buildCanonicalLeagueState({ bypassScope: true })` opts a call out (used
  only by multi-provider tests).
- Wrapped entry points: `buildWeeklyIntelligence`, `runWithWeeklyContext`,
  `buildManagerContext`, `analyzeTrade`, `discoverTrades`, `negotiateTrade`.
  A future orchestrator wraps its own multi-manager / multi-engine work in one
  `runInLeagueStateScope` and every engine inside it shares one snapshot.

Draft-night freshness is untouched — the draft engine
(`buildManagerRecommendationResponse`) never calls `buildCanonicalLeagueState`
and still uses `getLeagueRostersLive`.

Verified (`test/canonical-lineage.test.ts`): two manager analyses in one scope ⇒
**one** `provider.getLeagueState` call and one `league_snapshot_id`; two
independent scopes ⇒ two reads; no scope ⇒ two reads (unchanged default).

### 1.6 Projection lineage + canonical identity on projection outputs

The season model (`ri-structural-2026.3`) and the weekly provider
(`sleeper-weekly-rotowire`) remain **separate**. Additive annotations only:

- `buildLeagueResponse` (season) now returns `projection_lineage: [{ role:
  "season_ordinal", source: "roster_intel_season", model_version:
  "ri-structural-2026.3", generated_at, scoring_fingerprint, status }]` and
  `league.scoring_fingerprint`.
- Each returned player gains `canonical_identity: { canonical_player_id, method,
  confidence, cross_provider_verified }`. `cross_provider_verified` is true only
  for a `player:gsis:*` id; a player the crosswalk cannot line up cross-provider
  is `player:sleeper:*` with `cross_provider_verified: false` — the unresolved
  state is explicit, never a silent substitution.
- `RiSeasonEntry` (the weekly ROS ordinal signal) gains `canonical_player_id`;
  `RiSeasonSignalResult` gains `by_canonical_id` + `unresolved_count`.
  `assembleRosSignals` now joins RI to weekly projections **by canonical id
  first**, sleeper-id fallback, and reports the split
  (`"RI season signal join: N by canonical id, M by sleeper-id fallback, …"`).
- `WeeklyTeamContext.lineage.projections` carries a `weekly_absolute` entry
  (`sleeper-weekly-rotowire`) and, when the RI signal ran, a `season_ordinal`
  entry — each with the snapshot's `scoring_fingerprint` so a consumer can detect
  a mismatch.

### 1.7 Projection cache invalidation

`lib/projections/build.ts#buildBaseProjections` — the module-scoped `baseCache`.

**Investigation result:** the historical-actuals inputs (`HISTORY_SEASONS =
[2021…2025]`, all complete seasons) are immutable. The one mutable input is
Sleeper's `/players/nfl` index (a player changing NFL team, a rookie signing, a
status flip through the `isCurrentlyDraftable` gate). So stale in-season data
**is** possible over a long-lived process.

**Fix (minimal):** the cache entry now carries `builtAt` and expires after
`BASE_PROJECTION_CACHE_TTL_MS` (default **6h**, override
`RI_BASE_PROJECTION_TTL_MS`). The TTL is far longer than any single analysis
operation (so one operation never rebuilds mid-flight) and far shorter than a
process lifetime (so new player data is observable without a restart). Key still
includes `(season, projection_version, model_version, calibration_id)` — a code
change to the model still invalidates immediately. `opts.force` and
`clearProjectionCaches()` unchanged. `baseCacheFresh()` exported for diagnostics.

### 1.8 Identity alias behaviour (GSIS)

The canonical identity layer already carries `gsis_id` in `PlayerIdentifiers` and
`playerId()` already prefers a `player:gsis:*` id. Phase 1B.1 closes the two gaps:

- `PlayerCrosswalk` now indexes rows `byGsis` and `resolve()` checks
  `known_identifiers.gsis_id` **first** (GSIS is the strongest cross-provider
  key). Reliable GSIS mapping data exists in production
  (`public.nfl_players.gsis_id` via `SupabaseCrosswalkSource`); with no Supabase
  configured the crosswalk simply has no GSIS rows and resolution is unchanged.
- `/api/trades/analyze` now indexes the snapshot's already-resolved players by
  `identifiers.gsis_id` too — symmetric with the existing `sleeper_id` /
  `name_key` indexing. This is not one-off matching: it looks the input id up
  against the identity the shared crosswalk already established.

Verified (`test/canonical-lineage.test.ts`): a bare GSIS id and the matching
Sleeper id resolve to the **same** `player:gsis:*` canonical player.

`crosswalk_version` (`<source name>:<row count>`, or `null` for `NoCrosswalk`) is
now on `PlayerCrosswalk.version` and in `SnapshotLineage`.

### 1.9 FLEX validation

`lib/trades/analyze.ts` no longer builds a second constraints object with a
hard-coded `flex_positions: ["RB","WR","TE"]`. Validation and evaluation now use
the **same** `tctx.constraints`, whose `flex_positions` is derived by
`buildWeeklyTeamContext` from the actual slot labels via
`lib/weekly/slots.ts` (`FLEX` → RB/WR/TE, `SUPER_FLEX` → QB/RB/WR/TE, Yahoo
`W/R/T` → WR/RB/TE, …).

Verified: for `bloodline-bowl` (`FLEX`) → `["RB","WR","TE"]` (unchanged
behaviour); for a synthetic `SUPER_FLEX` league → `flex_positions` includes `QB`
and equals `slotEligiblePositions("SUPER_FLEX")` — the hard-coded list never
could. `validateTrade` itself only consumes `starting_slots` +
`roster_size_limit` + `maxSlotMatching` (which reads slot labels), so the fix is
consistency/clarity plus a latent-bug fix for non-standard flex leagues.

### 1.10 Bye-detection stub — deferred (documented)

`buildManagerContext`'s `bye_week_notes` is an informational placeholder for a
future roster-planning surface. **Investigation result:** nothing consumes it for
active-week analysis — the weekly engine (`buildWeeklyTeamContext`) does its own
schedule-verified current-week bye detection via `getScheduleProvider()` and
never reads this field. It is not a correctness bug. A real multi-week schedule
model stays deferred to the Schedule / ROS phase, as originally planned. The
stub's text and code comment now say so explicitly.

### 1.11 Schema reader tolerance

`CANONICAL_SCHEMA_VERSION` is now `2`. The new fields are **optional in the
TypeScript types** (`CanonicalLeague.scoring_fingerprint` /
`roster_fingerprint`, `CanonicalLeagueSnapshot.lineage`) so every pre-existing
fixture and every v1 persisted row still compiles and loads. The live build path
**always** populates them. `hydratePersistedSnapshot`
(`lib/canonical/snapshot-lineage.ts`) backfills a deterministic lineage +
fingerprints for a v1 payload on read (wired into the Supabase store's
`getLatest`). `snapshotLineage(snap)` is the safe accessor — it never returns
`undefined`.

---

## Part 2 — Completion report

### 2.1 Files changed

**New (`lib/canonical/`):** `scoring-fingerprint.ts`, `league-fingerprints.ts`,
`lineage.ts`, `player-data-version.ts`, `snapshot-lineage.ts`, `request-scope.ts`.
**New (`lib/projections/`):** `canonical-identity.ts`, `lineage.ts`.
**New (tests):** `test/canonical-lineage.test.ts` (18 subtests).

**Modified — canonical core:**
`lib/canonical/schema.ts` (v2, optional lineage + fingerprint fields),
`lib/canonical/state.ts` (lineage population + scope memoization + `bypassScope`),
`lib/canonical/players.ts` (`byGsis` index, GSIS-first resolve, `version` getter,
`rowCount`), `lib/canonical/manager-context.ts` (scope wrap + bye-stub doc).

**Modified — providers:** `lib/providers/sleeper/canonical.ts`,
`lib/providers/yahoo/canonical.ts` (both `toCanonicalLeague` →
`attachLeagueFingerprints`).

**Modified — persistence:** `lib/persistence/serialize.ts`
(`leagueSnapshotId`, deep-strip `provider_synced_at`, `lineage` excluded from
hash), `lib/persistence/supabase/stores.ts` (`hydratePersistedSnapshot` on
`getLatest`).

**Modified — weekly:** `lib/weekly/schema.ts` (`WeeklyTeamContext.lineage`),
`lib/weekly/context.ts` (build lineage + projection lineage),
`lib/weekly/intelligence.ts` (surface lineage on result + `context_meta` + scope
wraps), `lib/weekly/projections-ri.ts` (canonical ids on RI entries),
`lib/weekly/ros.ts` (canonical-first join + join-split warning).

**Modified — trades:** `lib/trades/context.ts` (`TradeAnalysisContext.lineage`),
`lib/trades/analyze.ts` (FLEX fix — use `tctx.constraints`; GSIS index;
`lineage` on result; scope wrap), `lib/trades/schema.ts` (`TradeAnalysis.lineage`),
`lib/trades/discovery/discover.ts`, `lib/trades/negotiation/negotiate.ts` (scope
wraps).

**Modified — projections:** `lib/projections/build.ts` (TTL-bounded base cache),
`lib/projections/league.ts` (`scoring_fingerprint` on `LeagueScoringContext`),
`lib/projections/service.ts` (`projection_lineage` + per-player
`canonical_identity` on `buildLeagueResponse`).

**Modified — tests (re-scoped, not weakened):**
`test/canonical-schema.test.ts` (schema version 1→2),
`test/foundation-live.test.ts` (schema 2 + assert `league_snapshot_id` shape),
`test/analytics-live.test.ts` (3 subtests: honest-null / FAAB / league-status
assertions made season-state-independent),
`test/draft-live.test.ts` (poll/cache policy made state-valid not draft-pinned;
4 pre-draft-only subtests now self-skip once the league has drafted),
`test/draft-cache-headers-live.test.ts` (readiness enum widened to include
`BLOCKED`; K/DEF pool bounded 1..32 with the "all 32" check gated on `pre_draft`),
`test/fixtures/{weekly,trades}.ts` (fixture contexts carry a `lineage`).

### 2.2 Architecture changes

- **One traceable identity.** `CanonicalLeagueSnapshot` → deterministic
  `league_snapshot_id`. Downstream contexts and results echo it.
- **One scoring fingerprint** on the canonical path (`scoringFingerprint`);
  legacy `hashScoringSettings` retained side-by-side for 1B.2.
- **Execution-scoped read memoization** — a composition primitive
  (`runInLeagueStateScope`) with no persistent state.
- **Shared lineage contract** (`RecommendationLineage`) instead of per-engine
  ad-hoc version fields.
- **GSIS is a first-class crosswalk alias.**
- No new state model. No engine algorithm changed. No legacy route touched.

### 2.3 Behaviour changes

Production-observable:

1. `GET /api/league/:league/state` — response `schema_version` is `2`; the
   snapshot now has a `lineage` object. **Additive.**
2. `GET /api/intelligence|lineup|matchup|waivers/...` — the response `context` /
   body now includes a `lineage` object. **Additive.**
3. `POST /api/trades/analyze` — response includes `lineage` (or `lineage: null`
   when `CONTEXT_UNAVAILABLE`). **Additive.**
4. `GET /api/leagues/:slug/projections`, `GET /api/projections` — each player
   gains `canonical_identity`; the response gains `projection_lineage` and
   `league.scoring_fingerprint`. Existing fields (`player_id`, `scoring_hash`,
   points, ranks) **unchanged**. **Additive.**
5. `/api/trades/analyze` now accepts a bare **GSIS** player id as a transfer
   asset (previously only Sleeper-native id / name_key). **Additive.**
6. Trade validation for a non-standard flex league (`SUPER_FLEX`, `W/R/T`+`Q`,
   …) now uses correct FLEX eligibility. For `bloodline-bowl` — **no change**
   (its `FLEX` was already RB/WR/TE).
7. Persistence snapshot dedupe now actually collapses identical re-captures (the
   nested `provider_synced_at` no longer perturbs the content hash). Snapshots
   are still immutable and content-addressed; a genuine state change still lands
   as a new version.
8. `buildBaseProjections` rebuilds after 6h instead of never (per process).
   Adds a periodic recompute; no output shape or value change.

Not changed: any recommendation number, trade valuation, waiver score, lineup
optimisation, projection value, draft recommendation, week resolution,
manager/roster routing, degradation semantics, cache-control headers.

### 2.4 Test results

- `npx tsc --noEmit` — **clean.**
- `npx eslint app lib test` — **0 errors**, 18 warnings (all pre-existing
  unused-var style warnings on clean `8ef4f10`; none introduced).
- `npm test` (full repository regression, node --test) —
  **1259 pass · 0 fail · 4 skipped** (up from 1235 pass · 10 fail before 1B.1).
  - +18 from `test/canonical-lineage.test.ts`.
  - +6 net from the 10 previously-failing live suites now passing (re-scoped).
  - 4 skipped = the pre-draft-only live guarantees in `draft-live.test.ts` that
    self-skip now the real league is `in_season`. They are intact and run again
    for any future pre-draft league — **not deleted, not weakened.**

### 2.5 Live smoke-test results (real Bloodline Bowl, network available)

- `test/foundation-live.test.ts`, `test/weekly-intelligence-live.test.ts`,
  `test/scoring-live.test.ts`, `test/projections-live.test.ts`,
  `test/bridge-live.test.ts`, `test/live.test.ts`, `test/draft-live.test.ts`,
  `test/draft-cache-headers-live.test.ts`, `test/analytics-live.test.ts`,
  `test/historical-*-live.test.ts`, `test/league-manager-routing-live.test.ts` —
  **all pass** (4 pre-draft-only subtests skip).
- Ad-hoc live checks:
  - `buildCanonicalLeagueState("bloodline-bowl")` ×2 → identical
    `snap:bloodline-bowl:2026:w1:b02bbc9d4a8a0190` (deterministic).
  - `scoring_fingerprint` from the provider `raw_scoring` `===` the season
    model's fingerprint from `getLeague().scoring_settings`
    (`scoring:v1:29acc6bcd911df090b5b9b9c`).
  - `roster_fingerprint` `roster:v1:58bde6f903a48abe18246dcd`;
    `player_data_version` `players:v1:d75bf7737fbf6ed3`; `crosswalk_version`
    `null` (Supabase not configured in this shell — honest).
  - Trade context lineage snapshot id matches the state read;
    `flex_positions` = `["RB","WR","TE"]`.
  - Season projection response carries `projection_lineage` (`ri-structural-2026.3`)
    and per-player `canonical_identity` (`player:sleeper:*`,
    `cross_provider_verified: false` — expected without the Supabase crosswalk).

### 2.6 Unresolved issues / limitations

1. **`crosswalk_version` is `null` and `canonical_identity.cross_provider_verified`
   is `false` in any environment without Supabase configured** (this shell; also
   local dev without the env vars). In production the `SupabaseCrosswalkSource`
   supplies `gsis_id` rows and both become populated. Not a defect — it is the
   honest degraded state — but the GSIS-alias and cross-provider-identity paths
   are exercised live only where Supabase is configured.
2. **`discover` / `negotiate` response envelopes do not yet surface `lineage`.**
   Their `TradeAnalysisContext` carries it; the response bodies were left
   unchanged this phase to keep the diff additive and low-risk. Trivial follow-up.
3. **Legacy `hashScoringSettings` / `scoring_hash` still shipped.** Intentional —
   removing it needs the analytics/season surface on the canonical path (1B.2).
   Two hashes coexist; the canonical one is authoritative.
4. **Yahoo path** — `attachLeagueFingerprints` is wired into the Yahoo adapter
   but, as in Phase 1A, no Yahoo league is authorised, so the Yahoo lineage path
   is covered by unit fixtures only.
5. **`buildBaseProjections` 6h TTL is a heuristic**, not a data-driven freshness
   signal (Sleeper exposes none). A player traded mid-week is visible to the
   season *ordinal* signal within 6h, not instantly. Acceptable — weekly
   *absolute* points come from the live weekly feed, not this cache.
6. The `no-unused-vars` warnings in `lib/canonical/manager-context.ts`
   (`CanonicalRoster`, `_players`) are pre-existing and left alone.

### 2.7 Migration risks for Phase 1B.2 (legacy REST/analytics → canonical)

| Risk | Detail | Mitigation available now |
|---|---|---|
| **Payload drift** on `/api/league`, `/api/snapshot`, `/api/leagues/:slug`, `/api/leagues/:slug/snapshot`, `/api/leagues/:slug/managers/:slug/snapshot` | canonical `toCanonical*` and legacy `buildLeagueResponse` / `computeStandings` / `buildSnapshot` split roster/starter/bench and normalise records independently | golden-file tests are the gate. `test/canonical-lineage.test.ts` already proves weekly+trade agree with the canonical roster view; extend to a legacy-vs-canonical golden diff per league. |
| **Two scoring hashes** | consumers of `scoring_hash` (season projection cache key, response field) must move to `scoring_fingerprint` or keep a shim | both are emitted today; migrate readers first, delete `hashScoringSettings` last. |
| **Identity space** | analytics / projections / draft still key on raw Sleeper `player_id`; `canonical_player_id` is additive on projection responses only | `resolveCanonicalIdentities` (`lib/projections/canonical-identity.ts`) is the reusable resolver; apply the same pattern to analytics rows. |
| **`resolveLeagueForQuery` default fallback** | legacy `?league=` still silently falls back to `bloodline-bowl` when the selector is empty | canonical `resolveLeagueStrict` already 404s; 1B.2 should route legacy `?league=` through the strict resolver with an explicit deprecation for the empty case. |
| **Scope semantics under legacy composition** | if a 1B.2 legacy route starts calling `buildCanonicalLeagueState`, wrapping the handler in `runInLeagueStateScope` shares the read — but a legacy route that *also* does its own `getLeague`/`getLeagueRosters` will not benefit | acceptable; migrate the route's fetches to the canonical path in the same change. |
| **`snapshot_id` in persisted history** | old `snapshot_versions` rows carry a `content_hash` computed the old way (nested timestamps included) — they will not match a fresh re-capture's hash | `hydratePersistedSnapshot` backfills lineage on read; historical rows keep their stored `content_hash` for dedupe continuity. A one-time backfill migration is optional, not required. |
| **Schema v1 → v2** | external consumers reading persisted payloads | fields are optional; `hydratePersistedSnapshot` backfills; document the bump (done, §1.11). |

None of these blocks 1B.2; each is a known, bounded, golden-file-guardable step.

### 2.8 Verdict

## GO — proceed to Phase 1B.2 (legacy REST/analytics migration).

Phase 1B.1 delivered every objective additively:

- ✅ `league_snapshot_id` on live state — deterministic, content-derived,
  documented, backward-compatible.
- ✅ standard lineage envelope — one typed `RecommendationLineage`, progressively
  adoptable, carried by weekly + trade contexts and results.
- ✅ one canonical scoring fingerprint — order/zero-rule-insensitive, legacy
  hash retained.
- ✅ execution-scoped read memoization — no process-lifetime caching, draft-night
  freshness preserved, verified one-read.
- ✅ canonical identity on projection outputs — explicit unresolved state, no
  silent substitution, models not merged.
- ✅ hard-coded FLEX validation removed — uses canonical slot machinery.
- ✅ projection cache staleness bounded — 6h TTL, documented, version-aware.
- ✅ `player_data_version` — content hash, not a timestamp, documented.
- ✅ deterministic integration tests — 18 new subtests proving snapshot identity,
  cross-engine consistency, shared execution, projection lineage, FLEX, GSIS.
- ✅ stale live tests re-scoped to durable invariants, not weakened; the
  4 genuinely pre-draft-only checks self-skip and remain in the suite.

`tsc` clean · `eslint` 0 errors · **1259 / 0 / 4** · live smoke green.

**Constraints honoured:** no second canonical model; legacy stack untouched;
projection models not merged; no recommendation-scoring change; no Start/Sit,
Matchup Intelligence, R Football Intelligence Engine, ROS/playoff planning, or
Orchestrator; no process-lifetime caching of live league state; draft-night
freshness intact; schema reader tolerance preserved; additive-first; no
deterministic test loosened to hide disagreement.
