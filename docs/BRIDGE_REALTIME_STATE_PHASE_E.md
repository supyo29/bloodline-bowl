# Bridge Real-Time State — Stage E: Operational Publication

Status: **Stage E code complete. Feature flag OFF. Reads remain `LEGACY_LIVE_PATH`.
Two verification gates require a deployment and are PENDING (see §22).**
Branch: `bridge-realtime-state-phase-e` (from Stage D `f1052e9`)

Stage E makes the published canonical-snapshot path *operational* — an authenticated
refresh, a scheduler, an audit trail, concurrency-safe pointer advancement — **without
migrating any read traffic**. No model / scoring / trade / waiver / Team-State /
canonical-state semantics changed.

---

## 0. Starting-state confirmation (§1)

- Stage D checkpoint `f1052e9` confirmed; branch `bridge-realtime-state-phase-e` cut from it.
- Stage D + Stage C suites green before any Stage E change (49 bridge tests).
- `BRIDGE_PUBLISHED_SNAPSHOT` unset (OFF).
- No ordinary read route advances the pointer — verified live (`state_source: LEGACY_LIVE_PATH`, `published_snapshot.present: false` after every Stage E change).

---

## 1. Refresh API contract (§2)

```
POST /api/refresh?league=<slug>       one league
POST /api/refresh?scope=all           every READY Sleeper league
POST /api/refresh?...&forced=0         respect the refresh-policy reuse window (default forced=1)
Authorization: Bearer <REFRESH_SECRET>     (or  X-Refresh-Secret: <secret>)
```

| Situation | HTTP |
| --- | --- |
| published / unchanged / pointer race resolved to a valid newer pointer | `200` |
| missing or invalid `REFRESH_SECRET` | `401` |
| `REFRESH_SECRET` not configured | `401` (endpoint disabled) |
| no `?league` and no `?scope=all` | `400` |
| unknown league slug | `404` |
| candidate failed certification / integrity | `422` |
| provider / persistence / pointer subsystem unavailable — nothing published, LKG intact | `503` |
| `scope=all` with mixed per-league outcomes | `207` |
| `GET /api/refresh` | `405` (no mutation via GET) |

Response body carries per-league `{ outcome, snapshot_id, prior_pointer_seq,
resulting_pointer_seq, pointer_advanced, snapshot_persisted, integrity,
validation_detail, source_status, error_category, freshness, duration_ms, audit_id }`.
**A failed publication never returns 200.**

Live-verified (dev server, no Supabase configured locally):
`GET → 405`, no secret → `401 endpoint_disabled`, wrong secret → `401` (secret value
never echoed), unknown league → `404`, no target → `400`, authenticated →
`503 / source_unavailable / error_category: PERSISTENCE_UNAVAILABLE` (correct — local
env has no persistence), and `/api/league/state` still `LEGACY_LIVE_PATH`.

---

## 2. Auth model (§2, §22)

`lib/http-auth.ts` — `authorizeSecret(request, envName, { header? })`:
- secret read from `process.env`, **never returned, never logged, never in an error body** (test asserts the expected value never appears in the rejection);
- constant-time comparison over **sha256 digests** — neither the value nor its length leaks, and a length mismatch cannot throw;
- **header only** — the query string is never read (test), so a secret cannot leak into an access log or browser history;
- missing env secret ⇒ endpoint **disabled** (401), never open;
- `REFRESH_SECRET` (operator/on-demand) is separate from `CRON_SECRET` (scheduler) — decoupled capabilities;
- `/api/cron/publish` uses `CRON_SECRET` (Vercel sends it automatically).

No public unauthenticated route advances published state. GET never mutates. `/api/health`
(incl. `?deep=1`) is read-only — verified by inspection (no `put` / `advance` in the handler).

---

## 3. Publication lifecycle (§3, §4) — what "publish" means

`lib/canonical/publish.ts` → `publishLeagueSnapshot(slug, { trigger })` is the single
orchestrator behind `POST /api/refresh` and `/api/cron/publish`:

```
resolve league (unknown ⇒ 404, NOTHING written)
        ↓
read prior pointer  (for the audit + the concurrency guard)
        ↓
getPublishedLeagueSnapshot(forced, real persistence)   ← Stage B machinery, unchanged
   ├─ buildCanonicalLeagueState        (canonical + lineage, unchanged)
   ├─ reconcilePublishCandidate        (certify() + integrity + materiality gate)
   ├─ SnapshotStore.put                (immutable; dedupe on content hash)
   └─ PublishedPointerStore.advance    (one published_seq-guarded UPDATE)
        ↓
record ONE bridge_publication_audit row  (best-effort — audit failure never fails a publish)
        ↓
PublishResult (HTTP status never 200 on failure)
```

**"Publish" = the pointer now names a freshly-certified immutable snapshot.** Distinct
from "persist" (writing the immutable `bridge_league_snapshots` row — dedupes on
`league_snapshot_id` / content hash, so identical material state never creates a
conflicting identity, and a provider-timestamp-only difference does not create a new
snapshot — `provider_synced_at` is excluded from the content hash). Pointer advancement
is a **separate** step from snapshot persistence.

The pointer is not advanced until the candidate passes the reconcile gate. A failed
build or failed certification leaves the existing pointer **untouched** (tested).

---

## 4. Pointer schema (§5)

`public.bridge_published_snapshot` (Stage B, unchanged): one row per
`(league_slug, season)` —
`snapshot_id` (FK → immutable snapshot), `league_snapshot_id`, `content_hash`, `week`,
`published_seq` (`> 0`, monotonic), `certified`, `source_provider_synced_at`,
`published_at`, `updated_at`, `schema_version`. It locates/inspects the snapshot; it is
**not** a second copy of state — the immutable `bridge_league_snapshots` row remains the state.

---

## 5. Atomicity & concurrency strategy (§6)

The pointer moves via a single Postgres statement:
```sql
UPDATE bridge_published_snapshot
   SET snapshot_id=$1, ..., published_seq = $observed + 1
 WHERE league_slug=$L AND season=$S AND published_seq = $observed;
```
First publication is a conflict-safe `INSERT ... ON CONFLICT (league_slug, season) DO NOTHING`.

- **Two concurrent refreshes:** both `put` (immutable — two rows, or one + a dedupe), both `advance($observed)`; exactly one `UPDATE` matches a row → `advanced`, the other matches **zero** → `raced`, and the caller serves the winner's snapshot. Tested (`Promise.all` → outcomes `["published","raced"]`, final seq 1).
- **Stale refresh finishes later:** its `advance($old_seq)` matches zero rows → `raced`. The pointer **never moves backward**. Tested at the storage layer: a guarded `UPDATE` from seq 1 against a seq-2 pointer changes 0 rows.
- **One region advances while another computes:** same guard — the slow one races on completion.
- **Duplicate publication:** `advance` short-circuits to `unchanged` when the current pointer's `content_hash` already equals the candidate's, before any write.
- **Partial persistence then pointer move:** `put` is immutable and precedes `advance`; a `put` that errors returns before `advance` is called (→ 503, pointer untouched). An `advance` that errors leaves the (immutable, harmless) snapshot row and the prior pointer (→ 503).
- **Death after snapshot write, before pointer advance:** the immutable row is orphaned but harmless (deduped on next attempt via a `duplicate` `put`); the pointer is unchanged, so the next refresh completes it.
- **No process-local mutex is used anywhere** — the only concurrency protection is the DB `published_seq` guard, which is multi-region-safe.

**Explicit publication generation:** `published_seq` IS the generation counter. Strict
ordering is *publication-arrival* order, not *source-observation* order (see §21 P2-1).

### Storage-layer concurrency proof (run on the production database, in a transaction, rolled back)

| Scenario | Result |
| --- | --- |
| 8 writers from `published_seq = 0` | **1 advanced, 7 raced**, final seq 1 |
| 5 writers from `published_seq = 1` | **1 advanced, 4 raced**, final seq 2 |
| stale writer guarded on `published_seq = 1` while real seq is 2 | **0 rows changed**, pointer stays seq 2 |
| cleanup | probe rows removed; `bridge_published_snapshot` back to 0 rows |

Plus a `bridge_publication_audit` insert/read shape probe against the real schema (removed).

**True multi-region invocation (separate Vercel function instances) is a preview-deployment
gate — PENDING (§22).**

---

## 6. Idempotency semantics (§7)

- `refresh A` publishes snapshot X (seq 1). `refresh B` with unchanged provider state → `unchanged`, seq stays 1. Tested.
- Retry after a transient provider failure → the following successful refresh publishes; a second identical retry → `unchanged`. Tested.
- Every attempt (success or not) writes exactly one audit row; no duplicate material snapshot creates inconsistent pointer history.

---

## 7. Certification before publication (§8)

Delegated to `reconcilePublishCandidate` (Stage B/C) — `certify()` + referential
integrity + the centralized materiality model (`lib/canonical/capabilities.ts`).
Validates: schema, canonical integrity, standings ↔ team-record agreement, roster ↔
team ↔ player referential integrity, one-owner-per-player, `standings.length ==
teams.length`, scoring/roster fingerprints (via lineage), material-unresolved count = 0,
provider status eligibility, tolerated-warning conditions. **Not** dependent on any
recommendation engine — this is state certification. On failure: audit row records
`integrity: REJECTED` + `validation_detail`; pointer not advanced; `422`.

---

## 8. Refresh-policy activation (§10)

`resolveRefreshPolicy(signals)` (Stage B) is now executed operationally: `POST /api/refresh`
and `/api/cron/publish` call it and pass `mode` through to `getPublishedLeagueSnapshot`.
Thresholds unchanged, `≤` semantics unchanged (tested). No new policy classes. Modes are
selected but **no high-frequency runtime is activated** — `LIVE_DRAFT` stays a
classification only (Stage G).

| Mode | FRESH ≤ | ACCEPTABLE ≤ | STALE > | operational use |
| --- | --- | --- | --- | --- |
| NORMAL | 120 s | 600 s | 600 s | ordinary in-season |
| HIGH_ACTIVITY | 30 s | 90 s | 90 s | waiver processing / trade churn |
| LIVE_DRAFT | 10 s | 30 s | 30 s | defined; not activated |

---

## 9. Cron / scheduled refresh (§11)

`GET /api/cron/publish` — new Vercel cron entry `*/10 * * * *` (`vercel.json`), alongside
the existing daily `/api/cron/capture` (historical).
- Vercel sends `Authorization: Bearer $CRON_SECRET`; the route uses `authorizeSecret(..., "CRON_SECRET")`.
- Iterates READY Sleeper leagues **sequentially** — no uncontrolled fan-out.
- `forced: false` — respects the refresh-policy reuse window so back-to-back runs don't hammer Sleeper.
- Per-league result is logged (`[cron:publish] <slug>: outcome=… advanced=… seq=N→M …`) and returned; **one league's failure returns a non-2xx and never marks another successful**.
- Retries are idempotent (§6).

**Cadence rationale:** 10 min > the 120 s NORMAL reuse window, so every run does refresh,
but Sleeper reads flow through the existing 300 s Next data cache — net upstream load is
roughly one full `getLeagueState` per ~5 min per league (2 leagues). This keeps the
published pointer within NORMAL `ACCEPTABLE` at all times without over-polling. Tune to
`*/5` later if freshness demands it.

---

## 10. Multi-league behavior (§12)

Works for `bloodline-bowl` and `devoted-to-the-game` (the two READY Sleeper leagues).
`POST /api/refresh` accepts one `?league=<slug>` or `?scope=all` (registry-resolved
only — an arbitrary unknown slug is rejected `404` before any store write, tested).
Per-league outcomes are reported independently; `scope=all` returns `207` on a mix.

---

## 11. Free-agent-pool decision (§13) — **Option B: permanent explicit degradation**

The free-agent / waiver pool is **not** materialized in Stage E. `free_agent_pool` stays
`UNAVAILABLE` in the capability model — it correctly represents reality, and materializing
it would be net-new waiver semantics (out of scope: "do not change waiver logic unless a
demonstrated correctness defect blocks the migration" — this is not a defect).

**Consequence for Stage F:** waiver / free-agent / pickup analytical surfaces
**cannot** migrate to published-state authority. They stay on the legacy live path until
a dedicated availability-materialization phase. Route migration must never convert this
truthful `UNAVAILABLE` into silently incomplete waiver intelligence — a migrated route
whose required input is `free_agent_pool` must remain explicitly `DEGRADED` / `UNAVAILABLE`.
No fabricated pool.

---

## 12. LKG / source-failure behavior (§14)

Tested (`test/bridge-refresh.test.ts`):
- prior pointer exists + provider unavailable during refresh → pointer **intact**, its
  integrity **unchanged** (`CERTIFIED`), `source_status` becomes unavailable, HTTP `503`
  (never 200), `error_category: PROVIDER_UNAVAILABLE`;
- no prior pointer + provider down → `503`, no pointer, no fake success.

`SOURCE_UNAVAILABLE ≠ SNAPSHOT_CORRUPT` — a last-known-good published snapshot stays
`CERTIFIED` while its freshness ages normally.

---

## 13. Freshness behavior after publication (§9)

Once `advance` succeeds:
- `published_snapshot.present` → `true`;
- the Stage D `freshness` block (which describes the **published** snapshot) transitions
  out of `UNKNOWN` and reports a real bucket from the pointer's `source_provider_synced_at`;
- `response_state_lineage.served_freshness` continues to describe the **legacy** payload
  from its conservative age — the two stay distinct;
- Stage D field meanings are unchanged.

Unit-verified via `buildFreshnessEnvelope` with a populated pointer (Stage D tests:
`FRESH` / `STALE` / `SOURCE_UNAVAILABLE` classification, `certified` reflected). The
end-to-end "publish on a deploy, watch `UNKNOWN → FRESH`" is PENDING (§22).

---

## 14. Shadow comparison behavior (§16, §17)

`scripts/bridge-shadow-compare.ts` (`npm run shadow:compare`) extended: when a real
published pointer exists it also compares **legacy live vs the actual published snapshot**
(`compareCanonicalPaths`, `LIVE_SHADOW`, source-moved aware). The Stage C rule holds —
`UNEXPLAINED = 0` on stable-source runs, no blanket timestamp ignore (ownership / lineup /
records / matchups / transactions are all still compared).

Local run: deterministic + Layer B `UNEXPLAINED = 0` both leagues; the §16 published
comparison reports "published-pointer store not configured in this environment" (expected
locally). The published-vs-legacy comparison produces real data only where Supabase is
configured — i.e. on a deploy.

---

## 15. Active-scoring-window status (§17)

**PENDING.** Both leagues are at week 1 with no completed games or transactions. The P0
route comparison (`standings / managers / matchups / transactions`) inside the shadow
harness has not been run during a live scoring window. Per the Stage E instructions this
gate may remain pending; **Stage F may be coded but the production feature flag must not
be flipped until it passes.**

---

## 16. Preview / multi-region concurrency results (§18)

- **Storage-layer simulation on the production database: PASS** (§5 table — N-writer
  contention, monotonic advance, no backward move, clean deduped snapshot count).
- **True multi-region invocation from separate Vercel instances: PENDING** — requires a
  preview deployment with `REFRESH_SECRET` + the existing Supabase env, then concurrent
  `POST /api/refresh` from multiple regions/invocations. This must complete before any
  Stage F flag flip.

---

## 17. Operational health fields (§19)

`GET /api/health?deep=1` extended additively (bare `/api/health` unchanged, verified):
per league — `publication_generation` (`published_seq`), `last_refresh`
`{ outcome, ok, attempted_at, pointer_advanced, integrity, error_category, trigger }`,
`last_successful_refresh_at`, `recent_refresh_outcomes[]`; top level —
`persistence.publication_audit_store` status. Reads only (no `put`/`advance`).
Answers "can I trust the published snapshot right now, and what happened on the last refresh?"

---

## 18. Audit-trail behavior (§20)

`public.bridge_publication_audit` (migration `20260907170000_bridge_publication_audit`,
**applied**) — one row per publication ATTEMPT:
`league_slug, season, trigger, attempted_at, finished_at, duration_ms, outcome, ok,
candidate_snapshot_id, candidate_content_hash, prior_pointer_seq, resulting_pointer_seq,
pointer_advanced, snapshot_persisted (created|duplicate|error|skipped|not_attempted),
integrity (CERTIFIED|REJECTED), validation_detail, source_status, error_category, error`.
Append-only, service-role only, RLS on / no policies, off the read path. The refresh
secret is never written. Recording is best-effort — an audit failure never fails a publish
and never touches the pointer.

Rollback: `drop table if exists public.bridge_publication_audit;`

---

## 19. Failure-injection results (§21)

`test/bridge-refresh.test.ts` + `test/bridge-http-auth.test.ts` + reused
`test/bridge-published-snapshot.test.ts`:

| Injection | Behavior | Pointer safe? |
| --- | --- | --- |
| provider unavailable | `503`, `source_unavailable`, LKG intact | ✅ |
| provider returns no snapshot / no prior | `503`, no pointer | ✅ |
| invalid canonical state (contradictory standings) | `422`, `rejected`, `integrity: REJECTED` | ✅ untouched |
| certification failure (non-benign warning) | `422`, `uncertified` | ✅ |
| persistence (`put`) failure | `503`, `error_category: PERSISTENCE_UNAVAILABLE` | ✅ untouched |
| pointer-write (`advance`) failure | `503`, `error_category: POINTER_ADVANCE_FAILED` | ✅ prior intact |
| two concurrent refreshes | one `published` + one `raced`, seq monotonic | ✅ |
| stale refresh finishes after newer | `raced`, serves winner | ✅ never backward |
| duplicate unchanged refresh | `unchanged`, no seq bump | ✅ |
| missing pointer | first publish creates it (seq 1) | ✅ |
| malformed pointer | prevented by CHECK / FK constraints | ✅ |
| unknown league slug | `404` before any store write, no audit row | ✅ |
| refresh auth failure (missing/wrong/query-string secret, GET) | `401` / `405`, no work | ✅ |
| old-schema published snapshot | `hydratePersistedSnapshot` backfills on `getById` | ✅ |
| snapshot missing from storage despite pointer | shadow harness detects + reports; Stage F needs a legacy fallback (P2-2) | ✅ (pointer not moved) |

---

## 20. Security audit (§22)

| Check | Result |
| --- | --- |
| refresh authentication | `REFRESH_SECRET`, constant-time, header-only, disabled when unset |
| secret exposure | never returned / logged / in error body (test) |
| request logging | audit + events log IDs only; `SENSITIVE` key filter in `emitBridgeEvent` |
| error body leakage | rejection body never contains the expected secret (test) |
| replay / idempotency | replays are safe (`unchanged`); every attempt audited |
| arbitrary league selection | registry-resolved only; unknown slug `404` pre-write (test) |
| accidental refresh by GET | `405` |
| health endpoint mutation | none — read-only by inspection + no `put`/`advance` imports used mutatingly |
| scheduler secret use | `CRON_SECRET` server-side, sent by Vercel, decoupled from `REFRESH_SECRET` |

No public unauthenticated route can advance published state.

---

## 21. Adversarial audit — P0/P1/P2/P3 findings (§23)

**P0 (published state can become wrong/corrupt/unsafe): NONE.**
**P1 (material operational / freshness / migration defect): NONE.**

**P2:**
- **P2-1 — publication generation is arrival order, not source-observation order.** Two
  concurrent refreshes: the one that advances first wins even if the other read Sleeper
  microseconds later. Worst case: the published pointer is up to one cron interval
  (~10 min) staler than the absolute freshest possible. Mitigated by the cron cadence and
  by `conservative_age_seconds` in the freshness envelope (which already assumes worst-case
  staleness). Not worth a content-timestamp tiebreak given the mitigations. Documented.
- **P2-2 — Stage F needs a legacy fallback for an unreadable pointer target.** If a
  future Stage F read path serves from the pointer and `getById` returns null (snapshot
  row unreadable), it must fall back to `LEGACY_LIVE_PATH`, not error. Flagged for Stage F
  design; no impact in Stage E (reads are all legacy).
- **P2-3 — cron has no inter-run / vs-manual lock.** A manual `POST /api/refresh`
  concurrent with `/api/cron/publish` both race the pointer; one wins, both are audited.
  Safe (concurrency proven), but produces a `raced` audit row that reads like a near-miss.
  Acceptable; noted for operators.

**P3:**
- lint: `_`-prefixed unused params on the new unconfigured/memory audit stores — matches
  the established pattern for every other unconfigured store in the file.
- `error_category` is `null` for `raced` (raced resolves to a valid newer pointer — a
  success-ish outcome). Intentional.

No P0/P1 → Stage E is eligible to freeze on the code axis.

---

## 22. Stage F readiness gates

| Gate | Status |
| --- | --- |
| authenticated refresh works | ✅ (live-verified: auth paths + status codes) |
| production/preview pointer can advance | ⏳ **PENDING** — needs a deploy with `REFRESH_SECRET` + Supabase env (logic proven by 21 unit tests + storage-layer SQL) |
| immutable snapshot publication works | ✅ (Stage B machinery, reused; audit shape verified on real DB) |
| pointer advancement is concurrency-safe | ✅ storage-layer (real DB); ⏳ true multi-region PENDING |
| retries are idempotent | ✅ tested |
| provider failure preserves last-known-good | ✅ tested |
| deep health accurately describes published state | ✅ (fields present; values null locally = honest) |
| freshness transitions out of `UNKNOWN` once pointer exists | ✅ logic (unit); ⏳ end-to-end on deploy PENDING |
| Stage C comparison remains `UNEXPLAINED = 0` | ✅ re-run after Stage E — deterministic + live stable-source both 0 |
| published-vs-legacy shadow clean under stable source | ✅ harness ready; ⏳ real data needs a deploy |
| multi-region / concurrency gate | ✅ simulated on real DB; ⏳ true multi-region PENDING (§18) |
| free-agent-pool handling explicitly resolved | ✅ Option B (permanent `UNAVAILABLE`, §11) |
| no P0/P1 findings | ✅ none |
| active-scoring-window P0 shadow gate | ⏳ **PENDING** — preseason, no window available (explicitly allowed to remain pending; blocks the flag flip, not the coding) |

---

## 23. Regression (§24)

| Check | Result |
| --- | --- |
| `tsc --noEmit` | clean |
| `npm run lint` | 0 errors (29 warnings, all pre-existing patterns) |
| full deterministic suite | **1390 pass / 0 fail / 4 pre-existing skipped** (Stage D was 1374) |
| bridge suite | 75 pass / 0 fail (Stage D: 60) |
| Stage C equivalence (`npm run shadow:compare`) | deterministic `UNEXPLAINED = 0`; live stable-source `UNEXPLAINED = 0`, both leagues — unchanged by Stage E |
| Stage D freshness tests | green |
| Stage E refresh / publication / auth tests | 25 new, green |
| Phase 1C certification | green |
| Team-State certification | green |
| live smoke (both leagues, dev server) | auth paths + status codes verified; reads still `LEGACY_LIVE_PATH` |
| preview deployment | ⏳ PENDING (§22) |
| preview concurrency test | ⏳ PENDING (§22); storage-layer simulation PASS |
| model files changed | **none** |
| pointer writes caused by Stage E dev work | **0** (all probes rolled back / deleted; tables verified back to 0 rows) |

No existing test was weakened.

---

## 24. Files changed

### New
`lib/http-auth.ts`, `lib/canonical/publish.ts`,
`lib/persistence/supabase/publication-audit.ts`,
`app/api/refresh/route.ts`, `app/api/cron/publish/route.ts`,
`supabase/migrations/20260907170000_bridge_publication_audit.sql`,
`test/bridge-refresh.test.ts`, `test/bridge-http-auth.test.ts`.

### Modified
`lib/persistence/types.ts` (+`PublicationAudit`, +`PublicationAuditStore`, bundle field),
`lib/persistence/memory.ts` (+`MemoryPublicationAuditStore`),
`lib/persistence/index.ts` (+unconfigured + Supabase wiring),
`lib/canonical/published.ts` (+`snapshot_put_outcome`, +`failure_kind` on the result;
`servePrior` gains a `failureKind` arg — behavior unchanged, richer diagnostics),
`app/api/health/route.ts` (`?deep=1` audit fields — additive),
`scripts/bridge-shadow-compare.ts` (§16 published comparison),
`vercel.json` (+`/api/cron/publish` cron).

---

## Verdict

**CONDITIONAL — deployment-verification gates pending.**

There are **no code defects and no P0/P1 findings.** Every code-axis readiness gate
passes, concurrency is proven at the storage layer on the real database, and reads are
untouched (`LEGACY_LIVE_PATH`, flag OFF).

Three gates require an action only the operator can take and are **PENDING**:
1. deploy a preview with `REFRESH_SECRET` set (+ the existing Supabase env) and run
   `POST /api/refresh?scope=all` — confirm the pointer advances and
   `freshness.status` leaves `UNKNOWN`;
2. run concurrent `POST /api/refresh` from multiple regions/invocations against that
   preview — confirm no pointer regression / duplication;
3. run `npm run shadow:compare` (and the P0 route comparison) during a live NFL scoring
   window — confirm `UNEXPLAINED = 0` under real activity.

Per the Stage E instructions, **Stage F may be coded once these are scheduled, but the
production `BRIDGE_PUBLISHED_SNAPSHOT` flag must not be flipped until all three pass.**

STOPPING per protocol — not beginning Stage F.
