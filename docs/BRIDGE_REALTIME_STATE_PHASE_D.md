# Bridge Real-Time State — Stage D: Observability, Freshness & Deep Health

Status: **Stage D complete. Observational only — production route state source
unchanged, feature flag OFF, 0 pointer writes, 0 model files changed.**
Branch: `bridge-realtime-state-phase-a`
Depends on: Stage C (`046694d`)

Stage D makes the Bridge able to answer *"how current is this data, what snapshot
exists, and which capabilities can I trust?"* — **without** changing which state
path serves production results.

---

## 1. Files changed

### New
| File | Purpose |
| --- | --- |
| `lib/canonical/freshness-envelope.ts` | `buildFreshnessEnvelope()` (pure) + `resolveFreshnessEnvelope()` (one read-only pointer read + events). Assembles the additive `{ state_source, response_state_lineage, published_snapshot, freshness, integrity, capabilities }` object. |
| `test/bridge-freshness-envelope.test.ts` | 13 tests — boundaries, clock safety, missing pointer, certified-but-stale, fresh-but-degraded-capability, source-outage LKG, legacy lineage honesty, additive compatibility. |

### Modified
| File | Change |
| --- | --- |
| `lib/canonical/freshness.ts` | `+ "UNKNOWN"` status (distinct from STALE and DEGRADED): no published snapshot ⇒ age genuinely unknown. `NO_PUBLISHED_SNAPSHOT` reason now maps to `UNKNOWN`, not `DEGRADED`. |
| `lib/canonical/published.ts` | `servePrior` no longer rewrites a real degraded reason to `NO_PUBLISHED_SNAPSHOT` — a failed candidate with no prior is `DEGRADED` (something went wrong), not `UNKNOWN` (nothing wrong, just no snapshot). |
| `lib/canonical/manager-context.ts` | `ManagerContextResult` gains optional `snapshot` so `/api/context` can attach the envelope without a second provider read. |
| `lib/observability/events.ts` | `+ freshness_evaluated, snapshot_missing, snapshot_stale, capability_degraded, capability_unavailable, deep_health_checked`. |
| `app/api/league/[league]/state/route.ts` | **additive** `freshness` field. `state` + every existing field unchanged. |
| `app/api/context/[league]/[manager]/route.ts` | **additive** `freshness` field. `manager_context` + every existing field unchanged. |
| `app/api/health/route.ts` | `+ ?deep=1` branch (see §5). Bare `/api/health` and `?draft=1` byte-for-byte unchanged. |
| `package.json` | `+ "shadow:compare"` script (weekly read-only shadow run). |

---

## 2. Freshness schema (additive envelope)

```jsonc
"freshness": {
  "state_source": "LEGACY_LIVE_PATH",          // what served THIS response

  "response_state_lineage": {                   // the payload you were served
    "snapshot_id": "snap:bloodline-bowl:2026:w1:1af3658949f1d670",
    "observed_at": "2026-09-07T17:45:05.593Z",  // provider read start (provider_synced_at)
    "age_basis": "provider_read_start",
    "age_seconds": 0,                            // now − observed_at, measured
    "source_max_staleness_seconds": 300,         // the read itself may be this cache-stale
    "conservative_age_seconds": 300,             // age + max staleness = worst case
    "served_freshness": "ACCEPTABLE",            // bucket of THIS payload (from conservative age)
    "note": "…legacy live path… classified from the conservative worst-case age"
  },

  "published_snapshot": {                        // the durable pointer, INSPECTED
    "present": false,                            //   (Stage D: empty — flag off, nothing publishes)
    "snapshot_id": null, "content_hash": null, "published_seq": null,
    "published_at": null, "source_synced_at": null, "age_seconds": null,
    "week": null, "certified": null
  },

  "freshness": {                                 // freshness of the PUBLISHED snapshot
    "status": "UNKNOWN",                         //   UNKNOWN ⇒ no pointer yet (not STALE)
    "source_status": "AVAILABLE",
    "mode": "NORMAL",
    "degraded_reason": "NO_PUBLISHED_SNAPSHOT",
    "thresholds": { "fresh_seconds": 120, "acceptable_seconds": 600 }
  },

  "integrity": { "snapshot_integrity": "CERTIFIED", "failures": [] },

  "capabilities": {                              // centralised model (lib/canonical/capabilities.ts)
    "roster_state": { "status": "HEALTHY", "reasons": [], "missing_inputs": [] },
    "free_agent_pool": { "status": "UNAVAILABLE", "reasons": ["…MUST NOT claim CURRENT/FRESH"], "missing_inputs": ["free_agent_pool"] },
    // …
  },
  "material_unresolved": [], "unresolved_categories": {}
}
```

**Nothing existing is removed, renamed, reordered, or reinterpreted.** Verified live:
`/api/league/[l]/state` still returns `status, live_provider_status,
history_persistence_status, warnings, state` (schema_version 3) + `freshness`;
`/api/context` still returns `context, manager_context` + `freshness`.

---

## 3. Timestamp semantics (§5) — no lineage fix required

**Question asked:** can accurate freshness be calculated from existing snapshot timestamps?
**Answer:** yes, with the conservative model below. No lineage/timestamp schema change needed.

- `provider_synced_at` on a `CanonicalLeagueSnapshot` = wall-clock when the Bridge **began the provider read**. It is an *optimistic* marker: the underlying Sleeper reads pass through the Next data cache (`CORE_REVALIDATE_SECONDS = 300`), so the data can be up to 300 s older than that stamp.
- The envelope therefore exposes **both**:
  - `age_seconds` — `now − observed_at`, precisely measured ("when did we last read");
  - `source_max_staleness_seconds` — the cache TTL behind that read;
  - `conservative_age_seconds` — `age_seconds + source_max_staleness_seconds`, the worst-case data age.
- **`served_freshness` is classified from the conservative age**, never the optimistic read time. A request that rebuilt in 1 s but read 4-minute-old cached rosters is `ACCEPTABLE`, not `FRESH` — exactly the "don't label a 5-min-old snapshot 5 s old" requirement. (Live proof: both routes show `age_seconds: 0`, `conservative_age_seconds: 300`, `served_freshness: ACCEPTABLE`.)
- **Single conservative timestamp**, not per-domain. The canonical snapshot does not carry per-domain observation times, and Stage D does not add them. When `POST /api/refresh` (Stage E) does forced `no-store` reads, `source_max_staleness_seconds ≈ 0` and conservative age ≈ real age ≈ `FRESH`.

---

## 4. Refresh-mode policy

Centralised in `lib/canonical/refresh-policy.ts` (Stage B) + `FRESHNESS_THRESHOLDS`
in `lib/canonical/freshness.ts`. All three modes defined; **none activated** — Stage D
is semantics only. `resolveRefreshPolicy(signals)` returns `{ mode, rebuild_after_seconds,
pointer_cache_seconds, provider_revalidate_seconds }`; Stage E/G selects a mode.

| Mode | FRESH ≤ | ACCEPTABLE ≤ | STALE > |
| --- | --- | --- | --- |
| NORMAL | 120 s | 600 s | 600 s |
| HIGH_ACTIVITY | 30 s | 90 s | 90 s |
| LIVE_DRAFT | 10 s | 30 s | 30 s |

Boundary exactness (`≤`, so 120→FRESH, 121→ACCEPTABLE, 600→ACCEPTABLE, 601→STALE)
tested for every mode. Future/skewed timestamps clamp to age 0 — tested.

---

## 5. Deep health — `GET /api/health?deep=1`

**Read-only.** No refresh, no candidate build for publication, no pointer advance,
no model recompute, no persistence write. (`buildCanonicalLeagueState` reads only;
`reconcilePublishCandidate` is pure; the pointer is `get`, never `advance`.)

Reports, per the live run:
- `service` liveness, `player_cache`
- `schema.canonical_schema_version`
- `feature_flags.BRIDGE_PUBLISHED_SNAPSHOT` (**false**)
- `source_connectivity` — `SleeperProvider.healthCheck()` (`READY`, "NFL 2026 week 1")
- `persistence.{history_stores, published_pointer_store}` — independent statuses
- per active league:
  - `reachable`, `week`, `live_provider_status`
  - `response_state_lineage` + `freshness` + `published_snapshot` (pointer inspection)
  - `snapshot_integrity` + `integrity_failures`
  - `cross_surface_discrepancy_count`, `structural_problem_count`
  - `material_unresolved_count`, `benign_unresolved_count`, `unresolved_categories`
  - `capabilities` (compact status map)
  - `last_successful_publication` (from pointer), `last_failed_publication` (null — not persisted until Stage E)
  - `warnings` (codes only)
- `can_i_trust_the_bridge` — one-line verdict

Bare `/api/health` stays lightweight (no upstream calls). Deep health is bounded to
the READY sleeper leagues (2).

Emits `deep_health_checked`.

---

## 6. Missing-pointer behavior (§6)

The flag is off and nothing advances the pointer in Stage D, so
`bridge_published_snapshot` is **empty in production**. The envelope handles this
honestly (verified live on both real leagues):

```
published_snapshot.present = false
freshness.status           = "UNKNOWN"        (NOT "STALE", NOT "FRESH", NOT an error)
freshness.degraded_reason  = "NO_PUBLISHED_SNAPSHOT"
freshness.age_seconds      = null             (not fabricated as 0)
response_state_lineage     = still fully populated for the legacy payload
HTTP status                = 200              (missing published state is not an app failure)
```

`UNKNOWN` is a distinct enum member from `STALE` and `DEGRADED`.

---

## 7. Legacy-vs-published lineage (§8)

While the flag is off, every response says `state_source: "LEGACY_LIVE_PATH"` and the
served payload's id lives in `response_state_lineage.snapshot_id` — **separate** from
`published_snapshot.snapshot_id`. A test asserts the two are not conflated even when a
(hypothetical) pointer names a different snapshot. When Stage F migrates a route,
`state_source` becomes `"PUBLISHED_SNAPSHOT"` and the two converge — making the rollout
auditable from the response itself.

---

## 8. Integrity / freshness / source / capability — kept separate

Distinct fields, distinct enums, never collapsed:
- `integrity.snapshot_integrity` ∈ {CERTIFIED, REJECTED}
- `freshness.status` ∈ {FRESH, ACCEPTABLE, STALE, REFRESHING, DEGRADED, SOURCE_UNAVAILABLE, UNKNOWN}
- `freshness.source_status` ∈ {AVAILABLE, DEGRADED, SOURCE_UNAVAILABLE}
- `capabilities.<name>.status` ∈ {HEALTHY, DEGRADED, UNAVAILABLE}

Tests cover: `CERTIFIED` + `STALE` + `AVAILABLE`; `FRESH` + `free_agent_pool: UNAVAILABLE`;
`SOURCE_UNAVAILABLE` + pointer present + `CERTIFIED` (LKG is not "corrupt").

---

## 9. Real-league observational results (live, 2026-09-07, week 1)

Both `bloodline-bowl` and `devoted-to-the-game`, via the running dev server:

| field | value (both leagues) |
| --- | --- |
| `state_source` | `LEGACY_LIVE_PATH` |
| `response_state_lineage.age_seconds` | 0 |
| `response_state_lineage.conservative_age_seconds` | 300 |
| `response_state_lineage.served_freshness` | `ACCEPTABLE` |
| `published_snapshot.present` | `false` |
| `freshness.status` | `UNKNOWN` |
| `integrity.snapshot_integrity` | `CERTIFIED` |
| `cross_surface_discrepancy_count` | 0 |
| `material_unresolved_count` | 0 |
| capabilities degraded | `free_agent_pool: UNAVAILABLE` only (+ `history_persistence: DEGRADED` locally, no Supabase env — HEALTHY in prod) |

Observed once: `/api/league/state` and `/api/context` a second apart returned
**different** `response_state_lineage.snapshot_id` — the exact independent-revalidation-clock
drift Stage C/D exists to expose. Stage D makes it visible in the response; Stage F
removes it by putting both routes on one published generation.

---

## 10. Weekly shadow integration (§12)

- `npm run shadow:compare` → `scripts/bridge-shadow-compare.ts` (read-only: in-memory
  persistence, `dryRun`, Sleeper GETs only). Writes
  `docs/BRIDGE_REALTIME_STATE_PHASE_C_SHADOW_RUN.md`.
- **Rollout-log requirement:** run weekly through Stages E–F; attach each run. The P0
  route comparison inside it (`standings / managers / matchups / transactions`) must be
  run during an **active scoring/transaction window** and show 0 unexplained /
  characterised timing-only drift before the Stage F flag flip. Preseason quietness ≠ safe.
- Not automated to mutate/publish anything.

---

## 11. P0 active-window status

Still **week 1, no live scoring, no completed transactions.** P0 routes are not
migrated (deferred, as instructed). Stage D adds the *instrument*
(`response_state_lineage.snapshot_id` per response + the shadow harness's P0 block);
Stage F decides migration order from active-window evidence + the §14 dependency.

---

## 12. Free-agent-pool finding (§14) — recorded as a Stage E/F dependency

Both real leagues report `free_agent_pool: UNAVAILABLE` — the capability model
**correctly** representing that the pool is not materialized. Not "fixed" in Stage D.

**Stage E/F dependency:** before any waiver / free-agent / pickup analytical surface
is migrated to published-state authority, its required availability input must either
be materialized canonically OR the migrated route must remain explicitly
`DEGRADED`/`UNAVAILABLE`. Route migration must not convert this truthful `UNAVAILABLE`
into silently incomplete waiver intelligence.

---

## 13. Checkpoint report

```
commit                       (this commit)
files changed                2 new (envelope + test) ; 7 modified (freshness, published,
                             manager-context, events, 2 routes, health, package.json)
freshness schema             additive envelope §2 — state_source / response_state_lineage /
                             published_snapshot / freshness / integrity / capabilities
capability schema            centralised lib/canonical/capabilities.ts, compact map on routes,
                             full report on deep health
timestamp semantics          §3 — provider_read_start + source_max_staleness_seconds +
                             conservative_age_seconds; served_freshness from conservative age;
                             single conservative stamp, no per-domain, no lineage change needed
refresh-policy               centralised (Stage B), all 3 modes defined, none activated
health output                §5 — ?deep=1 read-only operational trust surface
missing-pointer behavior     §6 — UNKNOWN, present:false, age null, HTTP 200, honest lineage
legacy-vs-published lineage   §7 — state_source=LEGACY_LIVE_PATH, ids never conflated
real-league observational     §9 — both leagues CERTIFIED, freshness UNKNOWN (no pointer),
                             served_freshness ACCEPTABLE, 0 discrepancies
weekly-shadow integration    §10 — npm run shadow:compare, rollout-log requirement documented
P0 active-window status      §11 — still preseason; instrument added, migration deferred
tests                        +13 (freshness-envelope) ; bridge suite 60 → 73
full regression              1374 pass / 0 fail / 4 pre-existing skipped ; tsc + lint clean (0 errors)
Stage C equivalence rerun    npm run shadow:compare after Stage D: deterministic UNEXPLAINED=0,
                             live stable-source UNEXPLAINED=0, both leagues — unchanged
model files changed          none
pointer writes caused by D   0 (routes read-only; deep health read-only; no advance anywhere)
feature flag status          OFF (BRIDGE_PUBLISHED_SNAPSHOT unset)
remaining Stage E deps        (a) REFRESH_SECRET + POST /api/refresh;
                             (b) something must advance the pointer (cron or /api/refresh) so
                                 freshness.status stops being UNKNOWN in prod;
                             (c) free-agent-pool materialization OR permanent route degradation
                                 before any waiver surface migrates (§12);
                             (d) preview-deploy multi-region concurrency test before flag flip;
                             (e) one clean active-scoring-window shadow run
```

Accurate freshness **can** be calculated from existing timestamps (via the conservative
model), so no stop-and-fix was needed. Stage D acceptance gate met.
