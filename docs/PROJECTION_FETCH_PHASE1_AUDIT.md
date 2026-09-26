# Projection Fetch & Availability Contract Repair — Phase 1 Forensic Audit

Date: 2026-09-26  
Branch: `infra/projection-fetch-contract-repair`  
Baseline main SHA: `da2effde8e47c2f4391838464a5aebf72c8b366a`  
Production deployment: `dpl_FAN2kFggUxQy4VV4z5ikZ9cxaYua`  
Production commit: `da2effde8e47c2f4391838464a5aebf72c8b366a`

## Verdict

The 2 MB Next.js Data Cache warning is real, reproducible, and structurally important, but it is not itself proof that Sleeper or the Bloodline Bowl bridge is unavailable. The raw projection fetch succeeds; Next.js then refuses to cache the oversized response. Because the projection provider has no request-scoped/shared cache for those raw feeds, multiple analytical surfaces re-fetch the same large payloads inside one logical request.

This creates a failure-amplification path:

1. large raw Sleeper projection payload succeeds;
2. Next.js Data Cache rejects it (>2 MB);
3. later projection assemblies cannot reuse the rejected entry;
4. the same logical request may fetch the same payload several times;
5. latency, upstream dependency, and timeout exposure increase;
6. partial projection status can then be incorrectly interpreted by a caller/automation as a broader bridge or market failure.

The current waiver endpoint remains actionable even when projection quality is partial:
- HTTP 200
- top-level status `PROJECTIONS_PARTIAL`
- `data.availability_status = AVAILABLE`
- hundreds of free agents evaluated
- recommendations returned

Therefore Phase 2 must repair fetch/caching behavior without changing these semantics.

## 1. Production baseline

### 1.1 Production identity

At audit start:
- `main = da2effde8e47c2f4391838464a5aebf72c8b366a`
- Vercel production deployment `dpl_FAN2kFggUxQy4VV4z5ikZ9cxaYua`
- deployment state `READY`
- branch `main`

No runtime code changes are made in Phase 1.

### 1.2 Oversized projection responses observed in Vercel

Current production warnings show:

Weekly projection feed:
- URL family: `https://api.sleeper.app/projections/nfl/2026/3?...QB...RB...WR...TE...K...DEF`
- observed size: approximately **2,788,473 bytes** (~2.79 MB)
- Next.js result: `items over 2MB can not be cached`

Season projection feed:
- URL family: `https://api.sleeper.app/projections/nfl/2026?...QB...RB...WR...TE...K...DEF`
- observed size: approximately **4,137,836 bytes** (~4.14 MB)
- Next.js result: `items over 2MB can not be cached`

These warnings are emitted after successful upstream reads. They are cache-write failures, not upstream fetch failures.

## 2. Direct waiver request baseline

Production request:
`GET /api/waivers/bloodline-bowl/supyo29/week/3`

Observed response:
- HTTP 200
- status: `PROJECTIONS_PARTIAL`
- waiver availability: `AVAILABLE`
- considered candidate count: ~692
- recommendation count: 5

Observed projection fetch fan-out on a warm request:
- 1 x weekly all-position feed (~2.79 MB)
- 1 x season all-position feed (~4.14 MB)

Approximate raw projection transfer per ordinary direct waiver call:
**~6.93 MB**

A cold-path request was observed emitting:
- 1 x weekly all-position feed
- 2 x season all-position feed

Approximate cold-path raw projection transfer:
**~11.06 MB**

The second season fetch is explained by two independent consumers:
1. weekly provider ROS construction (`fetchSeason` in `lib/weekly/projections/sleeper-weekly.ts`);
2. RI season signal / benchmark build (`RosterIntelSeasonSignalProvider -> buildLeagueResponse -> buildBaseProjections -> loadSleeperSeasonProjections`).

The RI base projection layer has a six-hour module cache, so the second season fetch is most visible on a cold process/cache rebuild.

## 3. Manager orchestrator baseline

Production request:
`GET /api/leagues/bloodline-bowl/managers/supyo29/orchestrate?include_trace=1`

Observed trace:
- canonical provider reads: 1
- snapshot coherent: true
- canonical stage: 317 ms
- team-state stage: 44 ms
- roster-health stage: 1,137 ms
- schedule-planning stage: 1,496 ms
- trade-context stage: 818 ms
- weekly intelligence (supyo29): 2,423 ms

Observed Vercel projection warnings for the same manager-orchestrator invocation:
- **4 x weekly all-position projection fetches**
- **4 x season all-position projection fetches**

Approximate raw projection transfer:
`4 * (2.788473 MB + 4.137836 MB) = ~27.7 MB`

The four projection assemblies are explained by:
1. Roster Health -> `buildRosterHealthInputs`
2. Schedule Planning -> `buildRosterHealthInputs`
3. Trade Analysis -> `buildWeeklyTeamContext`
4. Weekly Intelligence -> `buildWeeklyTeamContext`

The canonical league snapshot is correctly request-memoized, but the Sleeper projection feed is not. Existing comments describing these as "in-memory projection assemblies" / "zero extra provider reads" apply to canonical league-provider reads, not to the independent Sleeper projection upstream.

## 4. League orchestrator theoretical fan-out

The league orchestrator:
- builds Roster Health once;
- builds Schedule Planning once;
- builds Trade Analysis once;
- then calls `orchestrateManager` for every manager;
- each manager lazily builds its own Weekly Intelligence once.

For a 12-team league, current code can therefore assemble projections approximately:
- 3 shared specialist projection builds
- 12 manager Weekly Intelligence projection builds
- total: **15 weekly projection assemblies**

Because the oversized projection feeds cannot be reused by Next's Data Cache, the theoretical raw projection transfer is approximately:

`15 * (2.788473 MB + 4.137836 MB) = ~103.9 MB`

A cold RI benchmark rebuild can add at least one more ~4.14 MB season projection read.

This is a derived upper-path estimate from current code, not a measured league-orchestrator production invocation.

## 5. Projection fetch entry points

### 5.1 Shared Sleeper client

`lib/sleeper/client.ts`

Two caching patterns already exist:

**Normal small resources**
- `fetchSleeper` uses Next `next: { revalidate }`
- appropriate while entries remain below Next's Data Cache entry limit

**Oversized player database**
- `/players/nfl` is explicitly `no-store`
- raw response is immediately slimmed
- module-scoped TTL cache stores the normalized map
- in-flight Promise deduplicates concurrent cold-start reads
- stale module cache may be served if refresh fails

This existing player-index architecture is the preferred design precedent for Phase 2.

### 5.2 Weekly production provider

`lib/weekly/projections/sleeper-weekly.ts`

`fetchWeek(season, week)`
- calls the unversioned Sleeper projection root
- requests QB/RB/WR/TE/K/DEF in one response
- `revalidate: 30 minutes`
- raw response >2 MB, so Next cannot cache it

`fetchSeason(season)`
- calls the unversioned Sleeper season projection root
- requests QB/RB/WR/TE/K/DEF in one response
- `revalidate: 6 hours`
- raw response >4 MB, so Next cannot cache it
- used whenever `want_rest_of_season` is true (default in weekly context)

There is no module-level or request-scoped cache around these two functions.

### 5.3 RI benchmark provider

`lib/projections/sleeper.ts`
- `loadSleeperSeasonProjections` calls `getSeasonProjections`
- `getSeasonProjections` uses `fetchSleeper` with Next revalidation
- raw all-position season response is the same oversized source class

`lib/projections/build.ts`
- `buildBaseProjections` has a six-hour module cache
- on a base-cache miss, it calls `loadSleeperSeasonProjections` as `BENCHMARK_ONLY`

`lib/weekly/projections-ri.ts`
- `RosterIntelSeasonSignalProvider`
- `buildLeagueResponse -> getBaseProjections`
- therefore a cold weekly request can independently trigger the same season feed already read by the weekly provider

## 6. Direct consumers of the weekly projection provider

The following production surfaces assemble weekly projections via `buildWeeklyTeamContext` or `buildRosterHealthInputs`:

### Weekly decision surfaces
- `/api/waivers/{league}/{manager}/week/{week}`
- `/api/lineup/{league}/{manager}/week/{week}`
- `/api/matchup/{league}/{manager}/week/{week}`
- `/api/intelligence/{league}/{manager}/week/{week}`

### Shared-context analytical surfaces
- Roster Health
- Schedule Planning
- Trade Analysis context

### Composite surfaces
- manager Team-Management Orchestrator
- league Team-Management Orchestrator
- Book-Ready topics which invoke weekly decision surfaces (for example `waiver.status`, `startsit.shadow`, `matchup.shadow`)
- other callers of Roster Health / Schedule Planning inherit the same projection fetch path

The projection provider registry returns a new `SleeperWeeklyProjectionProvider` instance each time; provider instances do not share projection data.

## 7. Availability-contract finding

Two facts can currently coexist:

### Canonical league-state/free-agent capability
The league-state freshness/capability path can log:
`bridge.capability_unavailable: free_agent_pool`

This may occur because the canonical published snapshot is stale or because `waiver_state` is not materialized.

### Dedicated production waiver engine
At the same time, the waiver route can return:
- `availability_status: AVAILABLE`
- certified Market State free-agent pool
- hundreds of candidates considered
- real add/drop recommendations

This is not necessarily a data contradiction: the direct waiver route opts into Market State certification, while the generic canonical state can still lack a materialized `waiver_state`. But the status vocabulary is easy for an automation to misread as a system-wide failure.

Phase 4 must separate:
- live-provider health
- ownership/market availability
- free-agent-pool actionability
- weekly projection completeness
- season/ROS projection completeness
- recommendation readiness

## 8. Existing test coverage

Existing tests already cover important correctness invariants:
- Sleeper season benchmark ingestion
- projection layer invariance
- waiver ownership safety
- add/drop economics
- free-agent pool HEALTHY vs UNAVAILABLE semantics
- combined intelligence when waivers are unavailable

Missing coverage relevant to this repair:
1. oversized projection fetch must not use Next Data Cache;
2. one logical request must deduplicate identical projection fetches;
3. concurrent projection consumers must share an in-flight fetch;
4. manager orchestrator must not read the same raw weekly/season projection payload four times;
5. league orchestrator fan-out must not scale upstream projection reads linearly with manager count;
6. `PROJECTIONS_PARTIAL + availability_status=AVAILABLE` must remain actionable;
7. one position/chunk projection failure must degrade that projection family without becoming a market/provider outage;
8. cache-write warnings must never be surfaced as provider unavailability.

## 9. Phase 2 acceptance baseline

Phase 2 ("Oversized Fetch Repair") should preserve all scoring and recommendation outputs while changing only projection retrieval/reuse.

Minimum acceptance targets:

1. No production projection call attempts to put a >2 MB raw Sleeper projection payload into Next Data Cache.
2. No `items over 2MB can not be cached` warning on the repaired projection path.
3. Direct waiver request:
   - raw weekly projection upstream reads <= 1
   - raw season projection upstream reads <= 1
   - identical results/lineage semantics within source-data timing tolerance
4. Manager orchestrator:
   - projection upstream reads are shared across Roster Health, Schedule Planning, Trade Context, and Weekly Intelligence
   - no fourfold raw projection fetch fan-out
5. Concurrent cold-start calls deduplicate identical source reads with an in-flight Promise.
6. Projection source failure remains explicit and does not manufacture zero projections.
7. `availability_status` remains independent of projection quality.

## 10. Phase 1 boundary

Phase 1 is documentation/audit only.

No changes were made to:
- projection numbers
- scoring
- waiver ranking
- lineup logic
- market-state logic
- cache TTLs
- endpoint contracts
- production deployment

Phase 2 begins with the fetch/caching implementation.
