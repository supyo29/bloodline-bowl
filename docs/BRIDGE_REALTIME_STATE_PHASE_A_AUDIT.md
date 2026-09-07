# Bridge Real-Time State, Snapshot Consistency & Safe Refresh — Stage A Audit + Design + Rollout Plan

Status: **AUDIT ONLY — no production behavior changed in this commit.**
Branch: `bridge-realtime-state-phase-a`
Date: 2026-09-07
Overriding constraint: **do not change any football-intelligence math, weights, model
outputs, R engines, scoring, calibration, routing, or decision policy.** This is a
data-state phase. We change the *state supplied to* the existing models, not the models.

---

## 0. TL;DR — what already exists vs. what is missing

The Bridge is far more mature than the task prompt assumes. Much of the target
architecture is already built and certified:

| Target capability | Current state |
| --- | --- |
| Canonical league snapshot abstraction | **EXISTS** — `lib/canonical/state.ts` → `CanonicalLeagueSnapshot`, schema v3 |
| Stable snapshot identity + content hash | **EXISTS** — `lib/canonical/snapshot-lineage.ts`, `leagueSnapshotId` = `snap:<slug>:<season>:wNN:<hash16>` |
| Recommendation lineage | **EXISTS** — `lib/canonical/lineage.ts` `buildRecommendationLineage`, consumed by weekly / team-state / trade engines |
| Immutable snapshot store + append-only idempotent ledger | **EXISTS** — `lib/persistence/*` (Supabase), dedupe on content hash / `provider_transaction_id` |
| Cross-surface certification harness | **EXISTS** — `lib/canonical/certification/harness.ts`, `certify()` → `Discrepancy[]`, `cross_surface_discrepancies = 0` gate |
| Request-scoped single-read memoization | **EXISTS** — `runInLeagueStateScope` / `activeLeagueStateScope` (N managers → 1 provider read) |
| Degraded-status separation (live vs. history) | **EXISTS** — `live_provider_status` vs `history_persistence_status` |
| Live-draft no-store reads | **EXISTS** — `getDraftLive` / `getDraftPicksLive` / `getLeagueRostersLive` |
| Automated capture job | **EXISTS** — `/api/cron/capture` (daily 12:00 UTC), `captureLeagueState` + `syncLeagueTransactions` |
| Per-manager analytical context surface | **EXISTS** — `/api/context/{league}/{manager}` |
| **Atomic publication of a certified "current" snapshot** | **MISSING** — every request rebuilds live state; nothing holds "snapshot N authoritative while N+1 builds" |
| **Freshness metadata block on responses** (`FRESH/STALE/DEGRADED` + `age_seconds`) | **MISSING** — lineage IDs exist, human-readable freshness status does not |
| **Request-time change detection** (skip recompute when nothing changed) | **PARTIAL** — content hash used only for *write* dedupe, not read-path short-circuit |
| **Rich health / consistency surface** | **MISSING** — `/api/health` is liveness + player-cache + optional draft id only |
| **League-wide canonical context entry point** | **PARTIAL** — `/api/league/{league}/state` is close; no `freshness`/`health`/lineage roll-up |
| **Forced-refresh operation** | **MISSING** — cron writes *history*, does not publish an authoritative live snapshot |
| **Reconciliation watchdog wired to reject a candidate snapshot** | **PARTIAL** — `certify()` exists and tests fail on discrepancies; nothing rejects a *runtime* snapshot |
| **Old-path vs. new-path shadow / equivalence harness** | **MISSING** for this phase (Phase 1C harness certifies surfaces against canonical, not old-vs-new refresh generations) |
| Adaptive polling / high-activity / live-draft refresh modes | **MISSING** — single fixed TTL per resource class |

**Conclusion:** this is an *extension* job, not a rewrite. The canonical snapshot,
lineage, certification, and persistence primitives are sound and must be reused
verbatim. The missing pieces are: (1) a published-snapshot cache with atomic
swap + certification gate, (2) freshness metadata, (3) a real health/consistency
surface, (4) forced refresh, (5) refresh-mode / adaptive-polling policy, (6) an
old-vs-new equivalence harness.

---

## 1. Current Sleeper ingestion architecture

### 1.1 The one HTTP client — `lib/sleeper/client.ts`

Single choke point: `fetchSleeper<T>(path, options)`.

- Retries transient failures (408/429/5xx) with exponential backoff, `MAX_RETRIES = 2`, 10s default timeout.
- Two cache layers:
  1. **Next data cache** via `next: { revalidate }` for small resources.
  2. **Module-scoped map** for the ~14 MB `/players/nfl` dump (`PLAYER_DB_TTL_MS = 24h`), with `inFlightPlayerFetch` de-duping concurrent cold-start downloads and stale-serve-on-failure fallback.

TTL classes:

| Constant | Value | Applies to |
| --- | --- | --- |
| `CORE_REVALIDATE_SECONDS` | 300s | league, users, rosters, drafts, picks, state (default) |
| `LIVE_REVALIDATE_SECONDS` | 60s | opt-in for current-season facts that move during the week |
| `HISTORICAL_REVALIDATE_SECONDS` | 24h | fully historical seasons |
| `PLAYER_DB_TTL_MS` | 24h | `/players/nfl` |
| season projections | 6h | `getSeasonProjections` |
| weekly projections / weekly stats | 60m | `getWeeklyProjections`, `getWeeklyStats` |
| `getSleeperUser` | 24h | username → user_id |
| `getSeasonStats` | 24h | season totals |
| Live draft helpers | `no-store` | `getDraftLive`, `getDraftPicksLive`, `getLeagueRostersLive` |

**Observation:** the *default* freshness ceiling for rosters/transactions/matchups
is **300s from the Next data cache**, decided per-resource at the call site, not
per-league or per-activity. `getLeagueTransactions` / `getMatchups` are called
with **no explicit `revalidate`**, so they inherit 300s.

### 1.2 The provider adapter — `lib/providers/sleeper/provider.ts`

`SleeperProvider` wraps the client and produces canonical bundles. `getLeagueState`
does the heavy read: `#loadCore` fetches league+users+rosters+drafts+nflState in
parallel, then per-draft picks sequentially, resolves every player id through ONE
shared `createSleeperResolver` (crosswalk-derived, mutually consistent), and
returns a `CanonicalLeagueStateBundle`. `provider_synced_at` is stamped once at
the top of the call.

`getWaiverState` is explicitly **foundation-only**: it reports rostered ownership
only, never materializes the 12k free-agent pool (`free_agent_pool_not_materialized`).

### 1.3 The canonical assembly — `lib/canonical/state.ts`

`buildCanonicalLeagueState(slug, opts)`:

1. `resolveLeagueStrict(slug)` → provider + external id (strict, no fallback).
2. `provider.getLeagueState(ctx)`.
3. Best-effort `getMatchups(week)` + `getTransactions({week, limit:25})`.
4. `live_provider_status` = `READY` only if provider READY **and zero warnings**, else `PARTIAL`. Persistence status is **reported, never blocking**.
5. `deriveSnapshotLineage(snapshot, { crosswalkVersion })` stamped last (content hash of a canonical subset).

Memoized for the lifetime of a `runInLeagueStateScope` — so `/api/context`,
`/manage`, weekly, team-state all do **one** provider read per request even though
they each ask for canonical state.

### 1.4 Persistence — `lib/persistence/*`

- `SnapshotStore`: immutable. `put()` → `created` | `duplicate` (identical content hash) | `error`. `getLatest(key)`, `listVersions`, `listWeeks`. Backend: Supabase (`lib/persistence/supabase/stores.ts`), single migration `20260902172602_bridge_post_draft_foundation.sql`.
- `LedgerStore`: append-only, idempotent on `(league_slug, season, provider, provider_transaction_id)`. `inserted + duplicates === seen`.
- `CaptureRunStore`: run bookkeeping (`start` / `finish`).
- `getPersistence()` returns the bundle; `status()` is READY only if every store is READY. In-memory + serialize implementations exist for tests.

### 1.5 The capture job — `/api/cron/capture` + `lib/persistence/capture.ts`

Daily 12:00 UTC (`vercel.json`). For each READY Sleeper league: `captureLeagueState`
(build canonical → `snapshots.put`) + `syncLeagueTransactions` (provider txns →
`ledger.append`). Bearer `CRON_SECRET` (refuses if unset). Non-2xx on any failure;
never falsely reports success. **This writes history for backtest/analytics — it
does not feed the live read path.**

---

## 2. Every endpoint that independently touches Sleeper

`app/api` has **59 route files**. All are `dynamic = "force-dynamic"`, `runtime = "nodejs"`.
**36 route files import `@/lib/sleeper/client` or `service` directly** (i.e. bypass
the canonical layer):

- **Canonical-path (safe) consumers of `buildCanonicalLeagueState`:**
  `/api/league/[league]/state`, `/api/leagues/[l]/managers/[m]`,
  `/api/leagues/[l]/managers/[m]/snapshot`, `/api/leagues/[l]/scoring`,
  plus libs: `analytics/snapshot`, `scoring/scoring-service`, `team-state/build`,
  `trades/context`, `weekly/context`, `canonical/*`, `persistence/capture`.
- **Direct-client consumers (each can observe a different Sleeper generation):**
  `bridge/board`, `draft`, `draft/[leagueSlug]`, `draft/debug`, `history`,
  `league`, `leagues/[l]`, `leagues/[l]/draft`, `leagues/[l]/managers` (+`/[m]`,
  `/[m]/draft`, `/[m]/projections`, `/[m]/recommendations`),
  `leagues/[l]/projections` (+`/[playerId]`), `leagues/[l]/scoring`,
  `leagues/[l]/snapshot`, `lineups`, `manager-availability`, `managers`,
  `matchups`, `player-availability`, `player-weekly`, `projections`
  (+`/[playerId]`), `raw`, `roster-analysis`, `scoring` (+`/calculate`),
  `standings`, `transactions`, `value`, `weekly-stats`, `snapshot`.
  Libs: all of `lib/analytics/*`, `lib/draft/*`, `lib/projections/*`,
  `lib/scoring/scoring-service`, `lib/stats/provider`, `lib/weekly/projections`,
  `lib/weekly/schedule`, `lib/bridge/board`.

**Cross-surface time-skew risk (concrete):** `/api/standings` (direct
`getLeagueRosters`, 300s cache) and `/api/context/{l}/{m}` (canonical, same 300s
cache but a *different cache entry generation*) can disagree on wins/points for up
to ~5 min after a Sleeper update, because there is no shared "this is the current
snapshot" anchor — only independent per-URL Next cache entries with independent
revalidation clocks. The Phase 1C certification harness proves they are
*structurally* consistent given the *same* input; it does not prevent them
reading *different* inputs in production.

---

## 3. Caching & runtime (Vercel) reality

- **Next.js 16.3.1 App Router, all routes `force-dynamic`.** No route-level `revalidate`; all freshness comes from the *data cache* (`fetch` `next.revalidate`) inside `fetchSleeper`.
- **Data cache** on Vercel is backed by a shared/persistent cache — survives across instances and (mostly) across deploys until `revalidate` elapses. Good: dedupes Sleeper load. Bad: no explicit invalidation hook is used (`revalidateTag` / `revalidatePath` are **not** used anywhere), so "force refresh" today = wait out the TTL.
- **Module scope** (`playerCache`, `inFlightPlayerFetch`, `runInLeagueStateScope` AsyncLocalStorage) is **per-instance** and **per-request** respectively. Any design that needs a cross-instance "current snapshot" must use the **data cache** (tag-based) or **Supabase**, never a module singleton.
- **Cron:** one entry, daily. Vercel Hobby/Pro cron minimum granularity and the "at most one `/players/nfl` call per day" Sleeper ask both constrain how aggressive any polling can be.
- `maxDuration`: 60s on most analytical routes, 300s on cron.

---

## 4. Canonical identity — status

Strong and must be preserved:

- **Players:** `createSleeperResolver(playerIndex, crosswalk)` — one resolver per bundle, crosswalk-first, provider provenance retained on every unresolved id (`unresolved_players` + `unresolved_player_identities` warning). `player:sleeper:<id>` only when no better evidence. James Cook / James Cook III class bugs are fixed here and regression-covered.
- **Managers / rosters:** `resolveManager()` order = canonical slug → registered identity (`provider_user_id`) → case-insensitive username → **explicit `manager_not_in_league`** (never a fallback pick). `canonical_team_id = team:<slug>:<roster_id>`.
- **Leagues:** `resolveLeagueStrict` — strict, `league_slug != manager_slug`, single resolver.
- **Fingerprints:** `scoring_fingerprint`, `roster_fingerprint`, `player_data_version` all derived and carried on lineage.

No regressions permitted. New code consumes these; it does not re-implement matching.

---

## 5. Duplicated fetch logic / stale-cache / race hotspots

1. **36 direct client importers** — duplicated fetch + normalization outside the canonical layer. Not all need canonical state (e.g. `/api/raw`, `/api/weekly-stats` are deliberately raw), but `/api/standings`, `/api/matchups`, `/api/managers`, `/api/transactions`, `/api/roster-analysis`, `/api/value`, `/api/lineups` express **league facts that already live in the canonical snapshot** and could skew against it.
2. **Independent revalidation clocks** — every `fetchSleeper` call site starts its own TTL. Two endpoints reading `/league/{id}/rosters` 4 minutes apart get two different 300s windows.
3. **No atomic multi-resource read** — `getLeagueState` reads league/rosters/drafts/matchups/transactions as separate cached fetches; a roster fetch can be 4 min old while the matchup fetch is fresh. Within one `runInLeagueStateScope` the *assembly* is consistent, but the *inputs* can straddle a Sleeper change.
4. **`getWeeklyStats` / projections TTLs (60m/6h)** vs. roster TTL (5m) — a lineup recommendation can pair a 5-min-old roster with a 60-min-old projection. Acceptable for projections (they move slowly) but currently invisible to the caller.
5. **Model caches:** none of the engines cache their *outputs* across requests (every analytical route is `force-dynamic` and recomputes). So there is **no stale-recommendation-served bug today** — but also no lineage *check* that would catch one if an output cache were ever added. The recommendation-lineage plumbing is there; the enforcement is not.
6. **Concurrent cron vs. manual capture** — safe by construction (immutable snapshots, idempotent ledger).
7. **`playerCache` cold start** — first request on a cold instance pays a 14 MB download (up to 45s); `inFlightPlayerFetch` prevents a thundering herd within one instance but not across instances.

---

## 6. Existing health / diagnostics / certification inventory

| Asset | What it does | Gap |
| --- | --- | --- |
| `/api/health` | liveness, player-cache status, league registry, optional active-draft id | no snapshot age, no reconciliation, no discrepancy count, no model versions |
| `getPlayerCacheStatus()` | `{cached, player_count, age_seconds}` | fine, reuse |
| `SleeperProvider.healthCheck()` | live `/state/nfl` probe → `READY` \| `PROVIDER_ERROR` | not surfaced by `/api/health` |
| `lib/canonical/certification/harness.ts` | `certify(a,b)` → `Discrepancy[]`; `factsFromCanonical` | test-time only; not a runtime gate |
| `scripts/phase1c-certify.ts` | real-league cross-surface certification CLI | manual; not scheduled |
| `lib/canonical/snapshot-lineage.ts` | snapshot id + content hash + backfill for v1 rows | reuse as-is |
| `lib/canonical/lineage.ts` | `buildRecommendationLineage` | reuse as-is |
| `deriveSnapshotLineage` degraded shell | honest degraded snapshot instead of fabricated 200 | reuse as-is |
| Persistence `runs` table | capture-run bookkeeping | could back an observability surface |

---

## 7. Design — what to build (reusing everything above)

### 7.1 Guiding decisions

- **D1. No new state store.** The "published snapshot" lives in the **Next data cache under an explicit tag** (`league-snapshot:<slug>`), plus the existing Supabase `SnapshotStore` as the durable record. `revalidateTag` becomes the atomic-swap primitive. No module singleton, no new table for the hot path. (A new `published_snapshot` pointer row in Supabase is optional and only if tag invalidation proves insufficient under multi-instance testing — decided in Stage E, not now.)
- **D2. One published-snapshot accessor.** New `lib/canonical/published.ts`: `getPublishedLeagueSnapshot(slug, { mode })`. Internally calls `buildCanonicalLeagueState` but wraps the whole assembly in a single tagged `unstable_cache` / cached function keyed by `(slug, mode)` so **all downstream consumers share one generation**. This is the single anchor §2/§5 lack.
- **D3. Certification gate on publish.** Before a freshly built candidate replaces the published generation, run the existing `certify()` between the candidate's own surfaces (canonical vs. reconstructed-from-transactions vs. standings) — if `Discrepancy[]` non-empty → **keep the previous generation**, mark `DEGRADED`, emit `snapshot_rejected` + `cross_surface_discrepancy`. Reuse `factsFromCanonical` + the transaction-reconstruction path already in `compat/scoring-inputs.ts`.
- **D4. Freshness metadata is purely additive.** A `freshness` block is added to responses; **no existing field changes type or meaning**. Consumers that ignore it are unaffected.
- **D5. Recommendation lineage becomes a checked invariant.** Engines already stamp `recommendation_lineage.source_snapshot_id`. Add a cheap assertion helper `assertRecommendationCurrent(lineage, slug)` that engines/routes can call; when `source_snapshot_id != current published id` the response is marked `stale` in its freshness block (engines recompute anyway today, so this is belt-and-suspenders + future-proofing).
- **D6. Refresh modes = TTL policy, not new machinery.** A `resolveRefreshPolicy(slug, signals)` function returns `{ revalidateSeconds, tag }` given: draft active? recent transaction burst? → `LIVE_DRAFT` (~3s / no-store) | `HIGH_ACTIVITY` (~20s) | `NORMAL` (~120s). Draft-active detection reuses `selectActiveDraft`. Activity detection reuses the ledger `last_seen_at` / `recent_transactions`.

### 7.2 New/changed modules (proposed)

| Module | Type | Purpose |
| --- | --- | --- |
| `lib/canonical/published.ts` | NEW | `getPublishedLeagueSnapshot`, tag-based atomic generation, certification gate, degraded fallback |
| `lib/canonical/freshness.ts` | NEW | `FreshnessStatus` (`FRESH`/`ACCEPTABLE`/`STALE`/`REFRESHING`/`DEGRADED`/`SOURCE_UNAVAILABLE`), `deriveFreshness(snapshot, policy)` |
| `lib/canonical/refresh-policy.ts` | NEW | `resolveRefreshPolicy` (mode selection), pure |
| `lib/canonical/reconcile.ts` | NEW (thin) | wraps existing `certify()` for the publish-time gate |
| `lib/observability/events.ts` | NEW | structured `console.log(JSON.stringify({evt,...}))` emitters for the §24 event list |
| `app/api/health/route.ts` | EXTEND | add `?deep=1`: snapshot age per league, provider healthCheck, discrepancy count, model versions, degraded systems |
| `app/api/refresh/route.ts` | NEW | `POST` forced refresh, `CRON_SECRET`-style auth, scoped (`league`/`rosters`/`transactions`/`draft`/`all`), returns new snapshot id |
| `app/api/league/[league]/state/route.ts` | EXTEND | add `freshness` + `lineage` roll-up (additive) |
| `app/api/context/[league]/[manager]/route.ts` | EXTEND | add `freshness` (additive) |
| `lib/canonical/state.ts` | MINIMAL | allow the caller to pass a `revalidateSeconds` / `noStore` hint through to the provider reads (additive option, default = today's behavior) |
| `scripts/bridge-shadow-compare.ts` | NEW | old-path vs. published-path equivalence report on frozen + live leagues |
| `scripts/bridge-realtime-certify.ts` | NEW | Stage-by-stage certification (see §9) |
| `test/bridge-realtime-*.test.ts` | NEW | §20 scenario tests + §19 regression harness |

### 7.3 Data flow after the change

```
Sleeper
  ↓  fetchSleeper (unchanged client, policy-driven revalidate)
provider.getLeagueState  (unchanged)
  ↓
buildCanonicalLeagueState  (unchanged assembly + lineage)
  ↓
getPublishedLeagueSnapshot   ← NEW: tagged cache generation + certify() gate
  ↓  (certified)               on fail → keep prior generation, mark DEGRADED
Published Snapshot (one shared generation, freshness-stamped)
  ↓
EXISTING engines / endpoints  (unchanged math; now read the shared generation + echo freshness)
```

### 7.4 Explicitly NOT doing

- No change to any file under `lib/weekly/` (math), `lib/trades/` (except `context.ts` already reads canonical), `lib/draft/` (strategy), `lib/projections/` (model), `lib/scoring/` (rules), `analysis/*.R`, calibration.
- No new Supabase table in the hot path (Stage E may add one *pointer* row if multi-instance tag invalidation is proven insufficient).
- No schema-breaking change to any response. `CANONICAL_SCHEMA_VERSION` bump only if a genuinely new required field lands (freshness is delivered at the *route envelope* level, not inside `CanonicalLeagueSnapshot`, to avoid a bump).
- No migration of the 36 direct-client endpoints in this phase — that is a follow-on consolidation phase. We only add the shared anchor and let high-value skew-prone endpoints opt in behind a flag.

---

## 8. Regression risks & mitigations

| # | Risk | Mitigation |
| --- | --- | --- |
| R1 | Tagged cache changes effective TTL → engine reads *fresher* data → output differs → looks like a model regression | §19 equivalence harness feeds the **same frozen snapshot** to old + new path; any diff must be traced to state, not math. Ship freshness metadata (Stage D) before changing any TTL (Stage E). |
| R2 | `certify()` publish-gate false-positive rejects a valid snapshot → Bridge stuck on stale generation | Gate runs in **shadow** first (Stage C): log rejections, don't act. Only enforce after a clean run window on both real leagues. Degraded state is always *served* (last good), never empty. |
| R3 | `revalidateTag` semantics differ on Vercel prod vs. local | Stage E gated behind `BRIDGE_PUBLISHED_SNAPSHOT=1` env flag; validate on a preview deployment against real leagues before prod. Rollback = unset flag (routes fall back to `buildCanonicalLeagueState` directly). |
| R4 | Forced-refresh endpoint abused → hammers Sleeper | `CRON_SECRET`-class bearer auth (reuse `/api/cron/capture` pattern), per-league cooldown (min 10s between accepted refreshes, tracked via cache tag timestamp), scoped. |
| R5 | Live-draft `no-store` policy widens to non-draft reads → Sleeper rate-limit / `/players/nfl` daily-cap breach | Policy function hard-caps: `/players/nfl` never `no-store`; `LIVE_DRAFT` mode only touches draft + picks + rosters endpoints. |
| R6 | Freshness block added to a response a consumer parses strictly | Additive only, at envelope level; grep every internal consumer + `test/` fixtures first; document in §25. |
| R7 | Observability logging leaks league/user detail or secrets | Emit ids only (`league_slug`, `snapshot_id`), never tokens; lint rule / review. |
| R8 | Cross-instance: two instances build N+1 concurrently | Idempotent by content hash (identical build → same id → `duplicate`); `certify()` gate is pure; last writer wins harmlessly. |

---

## 9. Certification additions (Stage-gated)

Keep every existing gate (TS clean, unit tests, canonical-lineage, migration/schema,
Phase 1C `cross_surface_discrepancies = 0`, `null_required_fields = 0`). Add:

- `snapshot lineage complete` on every published generation
- `cross-surface discrepancies = 0` at **publish time** (not just test time)
- `published state certified` flag present
- `recommendation lineage valid` — `source_snapshot_id` resolves to a real generation
- `no stale recommendation presented as current` — freshness `stale` ⇒ response not `FRESH`
- `no partial snapshot publication` — a `PARTIAL` live status never becomes the `FRESH` published generation
- `duplicate refresh idempotent` — two `POST /api/refresh` in a row → second is `duplicate`
- `source failure preserves last known good` — kill Sleeper (fixture) → published generation unchanged, freshness `SOURCE_UNAVAILABLE`
- `old/new frozen-state model outputs equivalent` — §19 harness, exact equality modulo lineage/timestamp/freshness

---

## 10. Rollout plan (staged, matches prompt §28 with repo-appropriate ordering)

| Stage | Content | Behavior change? | Gate to advance |
| --- | --- | --- | --- |
| **A** (this commit) | Audit + design + plan doc | **None** | User sign-off |
| **B** | `published.ts`, `freshness.ts`, `refresh-policy.ts`, `reconcile.ts`, observability; unit tests. Published path built but **no route uses it**. | None | TS clean, new unit tests pass, full suite green |
| **C** | `scripts/bridge-shadow-compare.ts`; run published-path vs. old-path on both real leagues + frozen fixtures; certify() publish-gate in **log-only** mode | None | Shadow report: 0 unexplained diffs; gate log clean over an observation window |
| **D** | Additive `freshness` + lineage roll-up on `/api/league/[l]/state`, `/api/context`, `/api/health?deep=1`. Still reading old path; freshness derived from lineage timestamps. | Additive metadata only | §25 consumer sweep; snapshot tests updated (additive); suite green |
| **E** | `POST /api/refresh`; opt-in `BRIDGE_PUBLISHED_SNAPSHOT=1` routing for skew-prone endpoints; enforce certify() gate; refresh-policy TTLs for `NORMAL`/`HIGH_ACTIVITY` | Yes, flagged | §19 equivalence pass; real-league smoke; latency within budget |
| **F** | Published snapshot authoritative by default (flag on) for canonical-path routes | Yes | Full certification §9; 48h clean shadow; rollback rehearsed |
| **G** | `LIVE_DRAFT` mode + adaptive polling for the draft surface | Yes | Draft-day dry run on a Sleeper mock; pick-detection latency measured |

**Rollback:** unset `BRIDGE_PUBLISHED_SNAPSHOT` → all routes call `buildCanonicalLeagueState`
directly exactly as today. `POST /api/refresh` and the `freshness` block are inert
additions that can stay. No schema migration to reverse. Documented in the design doc.

---

## 11. Performance measurement plan

Baseline to capture in Stage B (before any change), via `scripts/bridge-realtime-certify.ts`:

- Sleeper requests/min per league under a synthetic "refresh + analyze" burst (10 sequential analytical calls)
- Duplicate upstream fetches in one logical operation (expect ~0 inside a scope, measure across scopes)
- `buildCanonicalLeagueState` p50/p95 latency (cold instance, warm instance, warm data cache)
- `/api/context`, `/api/league/state`, `/api/leagues/[l]/manage` p50/p95
- Player-DB cold-download cost

Target after Stage F: **fewer** Sleeper requests for a multi-endpoint session
(shared published generation), equivalent or better p95, no increase in cold-start cost.

---

## 12. Open questions for the user (Stage A gate)

1. **Draft timing.** Is a live Bloodline draft imminent (Stage G urgency), or is this
   primarily about weekly in-season freshness (Stages D–F)? Memory says the 2026
   Bloodline draft is snake and already happened; confirm whether Stage G is needed now.
2. **`/api/refresh` auth.** Reuse `CRON_SECRET`, or a separate `REFRESH_SECRET`? Any
   non-secret internal caller (e.g. the `/bridge` UI) that needs it?
3. **Endpoint consolidation appetite.** Is migrating the 36 direct-client endpoints
   onto the published snapshot in-scope for a later phase, or explicitly out?
4. **Supabase pointer row.** Pre-approve a tiny `published_snapshot(league_slug,
   season, snapshot_id, published_at)` pointer table as a Stage-E fallback if data-cache
   tag invalidation proves unreliable multi-instance? (No hot-path reads; just a
   durable "what is current" record.)
5. **Freshness thresholds.** Proposed: `FRESH` ≤ 120s, `ACCEPTABLE` ≤ 600s, `STALE`
   > 600s in `NORMAL`; `FRESH` ≤ 10s in `LIVE_DRAFT`. OK to codify these?

---

## 13. Deliverables tracking (prompt §31)

| # | Deliverable | Stage |
| --- | --- | --- |
| 1 | Repository audit | **A (this doc)** |
| 2 | Design document | **A (§7)** — expanded in B |
| 3 | Implementation | B–G |
| 4 | Tests | B (unit), C (shadow), E (scenario), F (cert) |
| 5 | Certification script updates | B + F (`bridge-realtime-certify.ts`) |
| 6 | Health / diagnostic surface | D |
| 7 | Forced-refresh capability | E |
| 8 | Snapshot lineage | exists; verified B |
| 9 | Recommendation lineage | exists; enforced E |
| 10 | Shadow-mode comparison report | C |
| 11 | Performance measurements | B (baseline), F (after) |
| 12 | Real-league smoke results | C, E, F |
| 13 | Rollout plan | **A (§10)** |
| 14 | Rollback plan | **A (§10)** |
| 15 | Documentation | D (freshness/health), F (full) |

---

*End of Stage A. Awaiting user sign-off on §12 before Stage B.*
