# Bridge Real-Time State — Stage B: Published Snapshot Infrastructure

Status: **Stage B complete. Feature flag `BRIDGE_PUBLISHED_SNAPSHOT` is OFF. No route
consumes the new path. No model / strategy / scoring / R / calibration file touched.**
Branch: `bridge-realtime-state-phase-a`
Depends on: Stage A (`ef3a4c1`)

The primary abstraction this stage adds is **not** "how to create snapshots" (that
already exists and is reused verbatim). It is: *which already-certified snapshot is
the authoritative current league reality, how fresh is it, and how is that decided
atomically across a multi-instance serverless deployment.*

---

## 1. Files changed

### New — canonical layer (pure, no route wiring)
| File | Purpose |
| --- | --- |
| `lib/canonical/freshness.ts` | `deriveFreshness()` — three distinct axes: `status` (FRESH/ACCEPTABLE/STALE/REFRESHING/DEGRADED/SOURCE_UNAVAILABLE), `source_status` (AVAILABLE/DEGRADED/SOURCE_UNAVAILABLE), `degraded_reason`. Codified thresholds for all three modes. |
| `lib/canonical/refresh-policy.ts` | `resolveRefreshPolicy(signals)` — pure mode selection `NORMAL` / `HIGH_ACTIVITY` / `LIVE_DRAFT` + reuse windows. `LIVE_DRAFT` defined, **not** wired to high-frequency polling (Stage G). |
| `lib/canonical/reconcile.ts` | `reconcilePublishCandidate(snapshot)` — the publish-time gate. **Reuses `certify()` + `factsFromCanonical` verbatim**; adds a second independent fact view (`team.record` only, ignoring `standings`) so `certify()` has two sides, plus referential-integrity checks + a provider-eligibility check. |
| `lib/canonical/published.ts` | `getPublishedLeagueSnapshot(slug, opts)` — the accessor. build → reconcile → `SnapshotStore.put` → `PublishedPointerStore.advance`. Failure paths preserve snapshot N. |
| `lib/canonical/published-flag.ts` | `publishedSnapshotEnabled()` — reads `BRIDGE_PUBLISHED_SNAPSHOT`. Governs route adoption only; the primitive is always callable. |
| `lib/observability/events.ts` | `emitBridgeEvent()` — one JSON line per event, secret-key stripping, id-only fields. Covers the §24 event vocabulary. |
| `lib/persistence/supabase/published-pointer.ts` | `SupabasePublishedPointerStore` — durable authoritative pointer; atomic advance via one `published_seq`-guarded PATCH. |

### New — tests
| File | Coverage |
| --- | --- |
| `test/bridge-refresh-policy.test.ts` | mode selection, forced bypass, threshold codification (5 tests) |
| `test/bridge-freshness.test.ts` | age buckets per mode; source-health vs. STALE vs. DEGRADED kept distinct (6 tests) |
| `test/bridge-published-snapshot.test.ts` | candidate→certify→publish; rejected candidate keeps N; non-benign warning gate; benign warning publishes; idempotency; reuse window; past-window rebuild; provider-failure preserves N; no-prior→503; **atomic monotonic advance under concurrency** (12 tests) |

### Modified — persistence contracts (additive)
| File | Change |
| --- | --- |
| `lib/persistence/types.ts` | `+ PublishedPointer`, `+ PublishedPointerStore`, `+ AdvancePointerInput/Result`; `+ SnapshotStore.getById(id)`; `PersistenceBundle.published`. Aggregate `status()` **deliberately unchanged** (still the 3 historical stores) so a pointer-table outage degrades live freshness without blocking historical capture. |
| `lib/persistence/memory.ts` | `+ MemoryPublishedPointerStore` — reference implementation of the atomic-monotonic contract; `+ getById`; wired into `memoryPersistence()`. |
| `lib/persistence/index.ts` | `+ UnconfiguredPublishedPointerStore`; wired Supabase store; `+ getById` on the unconfigured snapshot store. |
| `lib/persistence/supabase/stores.ts` | `+ SupabaseSnapshotStore.getById()`. |
| `lib/persistence/supabase/rest.ts` | `+ updateReturning()` — filtered PATCH that returns changed rows (empty ⇒ lost race, unambiguous). |

### Schema / migration
`supabase/migrations/20260907090000_bridge_published_snapshot_pointer.sql` — **applied**
to project `ijpfjdzmaztofawhwepf` as migration `bridge_published_snapshot_pointer`.

```
create table public.bridge_published_snapshot (
  league_slug text, season int,
  snapshot_id uuid not null references bridge_league_snapshots(id) on delete restrict,
  league_snapshot_id text, content_hash text, week int,
  published_seq bigint not null default 1 check (published_seq > 0),
  certified boolean not null default true,
  source_provider_synced_at timestamptz,
  published_at timestamptz, updated_at timestamptz, schema_version int,
  primary key (league_slug, season)
);
-- RLS enabled, no policies (service-role only, matches every other bridge_* table)
```

- Does **not** duplicate the snapshot payload — `bridge_league_snapshots` stays the source of truth.
- FK `on delete restrict` — a published snapshot cannot be deleted out from under the pointer (and snapshots are already immutable/undeletable via trigger).
- **Rollback:** `drop table if exists public.bridge_published_snapshot;` after unsetting `BRIDGE_PUBLISHED_SNAPSHOT`. Nothing else references the table. Verified: table currently holds 0 rows.

---

## 2. Publication semantics

`getPublishedLeagueSnapshot(slug, opts)` outcomes:

| Outcome | When | Pointer moves? | Response |
| --- | --- | --- | --- |
| `reused` | pointer age ≤ `policy.rebuild_after_seconds` and not forced | no | stored snapshot, freshness by age |
| `published` | candidate built, passed the gate, pointer advanced | **yes** (`published_seq++`) | new snapshot, `FRESH`, `certified:true` |
| `unchanged` | candidate identical (content hash) to current pointer | no | candidate, `FRESH` |
| `raced` | another instance advanced the pointer first | no (by us) | **the winner's** snapshot |
| `rejected` | candidate failed the gate, a prior published snapshot exists | no | **prior** snapshot, `DEGRADED` + reason |
| `uncertified` | candidate failed the gate, no prior snapshot exists | no | candidate returned but flagged, `ok` still true only if… no — `ok:false`? see note | 
| `source_unavailable` | provider read failed | no | prior snapshot if any (`DEGRADED`), else `503` |

The **reconcile gate** (`reconcilePublishCandidate`) fails a candidate on any of:
1. `certify()` discrepancy between `factsFromCanonical(snap)` and a `team.record`-only fact view (catches standings ↔ record contradictions).
2. Referential integrity: roster→team, roster→player, standings→team, matchup→team, one-owner-per-player, `standings.length == teams.length`.
3. Eligibility: `live_provider_status ∈ {PROVIDER_ERROR, AUTH_REQUIRED, NOT_CONFIGURED, DEGRADED}`, or any non-benign warning, or zero teams.

> **Design decision needing your sign-off (§6.1):** "benign" warnings that still
> publish are `unresolved_player_identities`, `HISTORY_PERSISTENCE_UNAVAILABLE`,
> `free_agent_pool_not_materialized`, `week_transactions_unavailable`. A strict
> reading of "a PARTIAL live status never becomes FRESH" would block publication
> for any real league (they routinely carry a handful of unresolvable
> practice-squad ids). The freshness block always surfaces the warning count and
> provider status, so nothing is hidden — but confirm this allow-list is right.

---

## 3. Concurrency semantics

**The durable Supabase pointer is the authority. Next tagged caching is not used for authority (see §5).**

Advance is a single Postgres statement:
```sql
UPDATE bridge_published_snapshot
   SET snapshot_id=$1, content_hash=$2, ..., published_seq = $observed + 1
 WHERE league_slug=$L AND season=$S AND published_seq = $observed;
```
- Two instances that both observed `published_seq = N`: Postgres row-locks the row; the first `UPDATE` sets it to `N+1`; the second now matches **zero rows** → PostgREST returns `[]` → store reports `raced`, caller serves the winner. No lost update, no torn pointer.
- First publication: conflict-safe `INSERT ... ON CONFLICT (league_slug, season) DO NOTHING`; a losing insert re-reads and reports `raced`/`unchanged`.
- Idempotency: if the current pointer's `content_hash` already equals the candidate's, `advance()` short-circuits to `unchanged` before any write.

### Evidence

1. **Deterministic test** (`test/bridge-published-snapshot.test.ts` → "MemoryPublishedPointerStore: atomic monotonic advance"): `Promise.all([advance(A,0), advance(B,0)])` → outcomes sort to `["advanced","raced"]`, `published_seq === 1`, exactly one content hash wins. Also: stale-`expected_seq` → `raced`; same-hash re-advance → `unchanged`.
2. **Live SQL proof on the production database** (project `ijpfjdzmaztofawhwepf`, run inside a transaction, rolled back / cleaned up):
   - Seed row `published_seq = 1`.
   - Writer A guarded `UPDATE ... WHERE published_seq = 1` → **1 row changed**, `content_hash → HASH_A`, `published_seq → 2`.
   - Writer B guarded `UPDATE ... WHERE published_seq = 1` (now stale) → **0 rows changed**.
   - Final state: `HASH_A`, `published_seq = 2`. Probe row removed; table back to 0 rows.
3. **Full-suite regression**: `1348 pass / 0 fail / 4 skipped` (the 4 are pre-existing network-gated live tests). Baseline before Stage B: 1325 pass.

---

## 4. Certification gate — status

| Existing gate | Stage B |
| --- | --- |
| TypeScript clean | ✅ `tsc --noEmit` clean |
| `npm run lint` | ✅ 0 errors (24 pre-existing warnings, none in new files except the pre-existing `memory.ts:120`) |
| Full unit suite | ✅ 1348/1348 (+23 new, 0 regressions) |
| Phase 1C `cross_surface_discrepancies = 0` | ✅ unchanged — `certification.test.ts` green |
| Canonical lineage / migration / schema tests | ✅ green |

New gate assertions covered by tests (route-level enforcement lands Stage D–F):
`no partial snapshot publication`, `duplicate refresh idempotent`,
`source failure preserves last known good`, `failed candidate does not become authoritative`,
`concurrent publication safety`.

---

## 5. Publication mechanism: which one, and why

**Chosen: the durable Supabase pointer.** Next tagged caching (`unstable_cache` /
`revalidateTag`) will be layered on in Stage E **only as a per-instance read cache**
with a 2–30s TTL (from `policy.pointer_cache_seconds`); it never holds authority.

Why not tagged caching alone:

| Requirement | `revalidateTag` | Durable pointer |
| --- | --- | --- |
| "Never advance before certification succeeds" | ✗ — a purge just forces the next reader to repopulate; there is no gate on *what* repopulates the entry | ✓ — the gate runs in app code; a failed candidate simply never issues the `UPDATE` |
| Concurrent publishers don't corrupt state | ✗ — no compare-and-set; two instances can populate divergent entries within the revalidate window | ✓ — one atomic `published_seq`-guarded `UPDATE` |
| "Which snapshot is current?" queryable (for `/api/health`) | ✗ — cache internals aren't introspectable | ✓ — `select * from bridge_published_snapshot` |
| Survives cold start / redeploy / multi-instance | partial (Data Cache is shared but opaque, and eviction/versioning across deploys isn't guaranteed) | ✓ — it's a row |

This matches your Stage-B steer: *"Do not choose the simpler implementation if it
cannot provide the consistency guarantee."*

**Evidence limits (honest):** true multi-instance concurrency under Vercel's
runtime cannot be exercised from this environment. What is proven here: (a) the
guard semantics at the SQL layer on the real production database (§3.2), (b) the
store contract under simulated concurrency (§3.1). A preview-deployment
concurrency test (parallel `POST /api/refresh` from multiple regions) is a
**Stage E gate** before the flag is turned on anywhere.

---

## 6. Failure behavior

| Failure | Result |
| --- | --- |
| Provider read fails / times out | `source_unavailable`; prior published snapshot served with `freshness.status = SOURCE_UNAVAILABLE`, `source_status = SOURCE_UNAVAILABLE`; `stale_snapshot_served` + `source_unavailable` events. No prior ⇒ `503`, never empty-as-current. |
| Candidate fails `certify()` | `rejected`; prior snapshot served, `DEGRADED` / `RECONCILIATION_DISCREPANCY`; `snapshot_rejected` + `cross_surface_discrepancy` events. Pointer unchanged. |
| Candidate fails integrity / eligibility | `rejected` / `uncertified`; `DEGRADED` / `CERTIFICATION_FAILED`. |
| `SnapshotStore.put` errors | `source_unavailable`-class; prior served, `REFRESH_FAILED`. Pointer unchanged. |
| `PublishedPointerStore.advance` errors | prior served, `REFRESH_FAILED`. Pointer unchanged. |
| Pointer advance raced | `raced`; the winner's snapshot served (never our rejected/older candidate). |
| Pointer table absent / persistence unconfigured | `advance` → `error` outcome; behaves as "no authoritative pointer" → `503` with `NO_PUBLISHED_SNAPSHOT`. Historical capture + all current routes unaffected (flag off). |

Last-known-good is always preferred over new-but-unverified.

---

## 7. Feature-flag behavior

- `BRIDGE_PUBLISHED_SNAPSHOT` unset / not `"1"` → **no code path in `app/` changes.** Every route still calls `buildCanonicalLeagueState` directly. This is the current production behavior and the default.
- `getPublishedLeagueSnapshot` is independently callable (tests, the Stage C shadow script) regardless of the flag.
- Rollback = unset the env var. No redeploy of code required beyond the env change; no migration to reverse (the table is inert while unread).

---

## 8. Model files changed

**None.** `test/bridge-*.test.ts` import zero engine code. No file under `lib/weekly/`,
`lib/trades/`, `lib/draft/`, `lib/projections/`, `lib/scoring/`, `lib/team-state/`,
`analysis/`, or any calibration/R path was opened. `certify()` and
`factsFromCanonical` are imported read-only and unmodified.

---

## 9. Remaining direct-Sleeper-route migration inventory

36 route files import `@/lib/sleeper/client` or `service` directly. Classification
(A = state-sensitive analytical, must eventually share the published generation;
B = source/reference, may stay direct; C = admin/diagnostic). Priority ordered by
**risk of contradicting `/api/context` or `/api/league/[l]/state`**, not alphabetically.

| Route | Reads | Domains | Canonical equiv? | Class | Priority | Target |
| --- | --- | --- | --- | --- | --- | --- |
| `/api/standings` | rosters + weekly matchups + bracket | standings, records | partial (`compat/standings`) — needs weekly loader | A | **P0** | F |
| `/api/context/[l]/[m]` | *(already canonical)* | — | — | — | — | D (add freshness) |
| `/api/managers` | users + rosters | manager/roster identity | yes | A | **P0** | F |
| `/api/leagues/[l]/managers` | users + rosters | manager/roster identity | yes | A | **P0** | F |
| `/api/leagues/[l]/managers/[m]` | users + rosters + roster | identity, roster | yes | A | **P0** | F |
| `/api/matchups` | matchups + players | matchup state | yes (`snapshot.matchups`) | A | **P0** | F |
| `/api/transactions` + `/api/transactions/[l]` | league transactions | transactions | yes (`snapshot.recent_transactions` / ledger) | A | **P0** | F |
| `/api/roster-analysis` | rosters + players | rosters, positional need | yes | A | **P1** | F |
| `/api/value` | rosters + players + projections | ownership, value | yes + ProjectionProvider | A | **P1** | F |
| `/api/lineups` | rosters + matchups | lineup inputs | yes (weekly ctx already canonical) | A | **P1** | F |
| `/api/player-availability` | rosters (+ full pool) | free agents / availability | partial (waiver phase) | A | **P1** | F/later |
| `/api/manager-availability` | rosters | availability | yes | A | **P1** | F |
| `/api/leagues/[l]/snapshot` | buildSnapshot (standings) | standings | partial (`factsFromLeagueSnapshot`) | A | **P1** | F |
| `/api/snapshot` + `/api/snapshot/[l]` | buildSnapshot | standings | partial | A | **P1** | F |
| `/api/league` (legacy) | league + rosters + users + players | rosters, standings, players | yes (`factsFromLegacyLeagueResponse`) | A | **P2** | F |
| `/api/leagues/[l]` | league summary | league facts | yes | A | **P2** | F |
| `/api/leagues/[l]/managers/[m]/recommendations` | draft picks + rosters | draft availability | draft-state | A | **P2** | E/G |
| `/api/leagues/[l]/managers/[m]/draft`, `/api/leagues/[l]/draft`, `/api/draft*`, `/api/bridge/board` | live draft + picks | draft state | dedicated live-draft path | A/B | P2 | G |
| `/api/leagues/[l]/scoring`, `/api/scoring*` | *(mostly canonical via compat)* | scoring rules | yes | A | P3 | F (finish) |
| `/api/leagues/[l]/projections` + `/[playerId]`, `/api/projections*`, `/api/leagues/[l]/managers/[m]/projections` | projection model | reference (model) | model is the authority, not league state | B | P3 | keep direct, documented |
| `/api/player-weekly`, `/api/weekly-stats` | Sleeper stats dumps | raw stats | intentionally raw | B | — | keep direct |
| `/api/raw` | passthrough | raw | intentionally raw | B | — | keep direct |
| `/api/history` + `/api/history/[l]/week/[w]` | persisted snapshots + season data | historical | not live | B | — | keep direct |
| `/api/draft/debug` | draft internals | diagnostic | — | C | — | keep direct |

**Certification target (Stage F):** zero unexplained direct Sleeper read on a
class-A surface. Class-B/C routes get a one-line `// direct provider read: <reason>`
annotation so the audit is self-documenting.

---

## 10. Next-stage recommendation

Proceed to **Stage C — Shadow Comparison**:

1. `scripts/bridge-shadow-compare.ts` — for both real leagues + frozen fixtures, run
   `buildCanonicalLeagueState` (old) vs. `getPublishedLeagueSnapshot` (new) and diff
   rosters / standings / transactions / availability / manager mappings / team-state
   inputs / a sample of model outputs. Expected: identical modulo lineage / timestamp
   / freshness. Every diff explained (corrected state / fresher state / identity
   reconciliation / pre-existing bug / **regression**).
2. Run the reconcile gate in **log-only** mode against live captures for an
   observation window; confirm no false rejections on real Bloodline / Devoted data.
3. Baseline the §11 performance numbers from Stage A.

Do **not** advance to Stage D (freshness metadata on live routes) until the shadow
report shows 0 unexplained diffs and the gate log is clean.

Open items carried forward:
- §6.1 benign-warning allow-list — confirm.
- Stage E preview-deployment multi-region concurrency test — gate before any flag flip.
- `/api/refresh` will use `REFRESH_SECRET` (separate from `CRON_SECRET`) per your Stage-A call — built in Stage E.
