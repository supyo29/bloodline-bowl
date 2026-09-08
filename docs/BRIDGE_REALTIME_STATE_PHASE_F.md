# Bridge Real-Time State — Stage F: Read Migration to the Published Snapshot

Status: **Stage F code complete. `BRIDGE_PUBLISHED_SNAPSHOT` OFF. Eligible reads still
serve `LEGACY_LIVE_PATH`. Three deployment/scoring gates remain PENDING — the
production flag flip is BLOCKED until they pass.**
Branch: `bridge-realtime-state-phase-f` (from Stage E `cf67186`)
This is the final stage. There is no Stage G.

---

## 0. Starting-state confirmation (§1)

- Stage E checkpoint `cf67186` confirmed; branch `bridge-realtime-state-phase-f` cut from it.
- Before any Stage F change: non-live suite green; `BRIDGE_PUBLISHED_SNAPSHOT` unset (OFF); ordinary reads reported `state_source: "LEGACY_LIVE_PATH"`.
- Baseline note: even on `cf67186`, `npm test` (which includes network-dependent `*-live.test.ts`) is flaky — a clean-checkpoint run showed `1390 pass / 1 fail / 4 skipped`. The **non-live** suite is deterministic. Stage F does not touch any `*-live` file.

---

## 1. Objective (§Stage F Objective)

Migrate eligible ordinary read surfaces from `LEGACY_LIVE_PATH` to `PUBLISHED_SNAPSHOT`
via one shared reader, gated by `BRIDGE_PUBLISHED_SNAPSHOT`, with explicit legacy
fallback, Draft Live untouched, and waiver/free-agent surfaces untouched. State-serving
migration only — no model / scoring / trade / waiver / lineup / Draft-Live / Team-State /
canonical-state semantics changed.

---

## 2. Route eligibility matrix (§2)

### A — migrated (reader swapped; gated by the flag)

| Surface | Wave | Reader call site | `state_source` surfaced? |
| --- | --- | --- | --- |
| `GET /api/league/[league]/state` | 1 | route → `readLeagueState` | ✅ in `freshness` envelope |
| `/api/leagues/[l]/scoring`, `/api/scoring/[l]`, `/api/scoring`, `POST /api/scoring/calculate` | 1 | `lib/scoring/scoring-service.ts` | scoring payload unchanged; source visible via deep health |
| `GET /api/context/[league]/[manager]` | 2 | `lib/canonical/manager-context.ts` | ✅ in `freshness` envelope + `ManagerContextResult.state_source` |
| `GET /api/leagues/[l]/manage` | 2 | `lib/team-state/build.ts` | ✅ top-level `state_source` field |
| `GET /api/leagues/[l]/managers/[m]/manage` | 2 | `lib/team-state/build.ts` | ✅ top-level `state_source` field |
| trade-context consumers (`/api/trades/*`) | 3 | `lib/trades/context.ts` | trade payloads unchanged; source via deep health |

### B — explicitly excluded

| Surface | Reason |
| --- | --- |
| **Draft Live** — `/api/draft`, `/api/draft/[l]`, `/api/draft/debug`, `/api/leagues/[l]/draft`, `/api/leagues/[l]/managers/[m]/draft`, `/api/leagues/[l]/managers/[m]/recommendations`, `/api/bridge/board` | Hard exclusion (§3). Verified by grep: **zero** references to `readLeagueState` / `getPublishedLeagueSnapshot` / the pointer / the publish cron across every draft-path file (`lib/sleeper/draft*.ts`, `lib/draft/*.ts`, `lib/leagues/manager-draft.ts`, all draft routes). The draft path uses its own `getDraftLive` / `getDraftPicksLive` / `getLeagueRostersLive` seconds-level contract and is structurally independent. |
| **Waiver / free-agent / pickup** — `/api/waivers`, `/api/player-availability`, `/api/manager-availability` | Stage E chose Option B: `free_agent_pool` permanently `UNAVAILABLE`. `lib/weekly/context.ts` (which feeds `/api/waivers`, `/api/matchup`, `/api/lineup`) was **reverted** to `buildCanonicalLeagueState` — kept fully legacy so the waiver-adjacent surface cannot be affected. Availability determination (`lib/weekly/availability.ts`) derives from canonical roster ownership + a bounded projection-candidate list — it never reads `snapshot.waiver_state` (null in both paths), so nothing infers claimability from ownership absence. |
| `/api/health`, `/api/health?deep=1` | Diagnoses live-vs-published — must always read live. |
| `/api/cron/publish`, `/api/cron/capture`, `lib/canonical/publish.ts` | Produce snapshots — must read live (circular otherwise). |

### C — eligible in principle, deferred (documented later cleanup, §29)

| Surface | Note |
| --- | --- |
| `GET /api/leagues/[l]/managers/[m]` (identity/roster) | eligible; still `buildCanonicalLeagueState`. Low-risk; migrate in a post-remodel pass. |
| `/api/snapshot`, `/api/snapshot/[l]`, `/api/leagues/[l]/managers/[m]/snapshot`, `lib/analytics/snapshot.ts` | standings-focused; eligible; deferred. |
| `lib/weekly/context.ts` (matchup / lineup inputs) | eligible for provider-read reduction but shares code with the excluded waiver surface; deferred to a dedicated phase once availability is materialized. |
| `/api/league`, `/api/leagues/[l]` (legacy summary) | eligible; deferred. |

### C — historical / provider-native (never migrate)

`/api/history*`, `/api/raw`, `/api/weekly-stats`, `/api/player-weekly`, `/api/projections*`, `/api/transactions*` — not current-state or intentionally raw.

---

## 3. Draft Live — hard exclusion (§3, §20)

**Sporty's Alumni is NOT in `lib/leagues/registry.ts`.** It cannot be resolved,
drafted against, or preflighted by this codebase. Before relying on the Bridge for
that draft, it must be added to the registry (one appended object). This is flagged as
a **PENDING** item, not a defect.

**Representative preflight (deterministic, done):**
- The draft-live path (`lib/sleeper/draft.ts` `selectActiveDraft`, `getDraftLive`, `getDraftPicksLive`, `getLeagueRostersLive`; `lib/draft/service.ts`; all `/api/draft*` + `/api/leagues/[l]/managers/[m]/recommendations` routes) has **zero** dependency on the Stage E/F published machinery — verified by exhaustive grep.
- No Stage F freshness threshold, the flag, or the `*/5` cron can reach the draft path.
- Existing draft suites (pre-draft resolution, snake order, seat/manager mapping, mock-override, availability-on-pick, `pre_draft`/`drafting`/`complete` transitions) remain green (`draft*.test.ts`, `draft-live.test.ts`, `draft-mock-override.test.ts`, `available-player-eligibility*.test.ts`).
- Live smoke (dev server, flag OFF **and** flag ON): `/api/leagues/bloodline-bowl/draft` → 200, `/api/leagues/bloodline-bowl/managers/supyo29/recommendations` → 200, unaffected by the flag.

**Active-transition check for the real draft: PENDING** — run a live smoke during Sporty's Alumni's actual draft once that league is registered (§20).

---

## 4. Feature-flag contract (§4)

`BRIDGE_PUBLISHED_SNAPSHOT` (in `lib/canonical/published-flag.ts`):

| Value | Meaning |
| --- | --- |
| unset / `off` / `0` | every eligible route → `LEGACY_LIVE_PATH` (default) |
| `wave1` | Wave 1 routes prefer the published snapshot |
| `wave2` | Waves 1–2 |
| `wave3` | Waves 1–3 |
| `1` / `on` / `all` | every eligible wave |

- **Flag OFF:** eligible routes behave exactly as legacy; `state_source: "LEGACY_LIVE_PATH"`, `fallback.occurred: false`. (Live-verified.)
- **Flag ON:** an eligible route serves the published snapshot **iff** a pointer exists, its target loads, lineage/hash match, schema is supported, integrity is `CERTIFIED`, and freshness ∈ {FRESH, ACCEPTABLE}. Then `state_source: "PUBLISHED_SNAPSHOT"`. Otherwise it falls back to legacy with an observable `fallback.reason`. (Live-verified: flag ON + no pointer → every eligible route `LEGACY_LIVE_PATH` / `fallback: {occurred: true, reason: "PERSISTENCE_UNAVAILABLE"}`, never a false `PUBLISHED_SNAPSHOT`.)
- **Reversible** by unsetting the env var: no migration, no cache flush, no snapshot rewrite, no redeploy-specific cleanup. The legacy path is never removed.

---

## 5. Shared published-snapshot reader (§5, §6)

`lib/canonical/read.ts` → `readLeagueState(slug, opts)` — a near drop-in for
`buildCanonicalLeagueState` returning the same `{ ok, status, code?, detail?, snapshot }`
plus `provenance: { state_source, served_from_pointer, fallback_reason, pointer_present,
pointer_snapshot_id, pointer_published_seq, serving_freshness, wave }`.

Validation gate before a snapshot may serve (§6):
1. flag enabled for this wave;
2. `published.status()` READY (else `PERSISTENCE_UNAVAILABLE`);
3. pointer exists (else `NO_POINTER`);
4. pointer league + season match (else `LEAGUE_MISMATCH`);
5. `snapshots.getById(pointer.snapshot_id)` returns a payload (else `TARGET_MISSING`);
6. `schema_version ∈ {1,2,3}` (else `UNSUPPORTED_SCHEMA`);
7. snapshot league/season match + `teams.length > 0` (else `MALFORMED`);
8. `snapshotLineage(snapshot).league_snapshot_id === pointer.league_snapshot_id` **and** `snapshotContentHash(snapshot) === pointer.content_hash` (else `ID_MISMATCH`);
9. `reconcilePublishCandidate(snapshot).snapshot_integrity === "CERTIFIED"` (else `INTEGRITY_FAILED`);
10. `deriveFreshness(...).status ∈ {FRESH, ACCEPTABLE}` (else `TOO_STALE`).

A missing/corrupt target never yields a partially reconstructed response — it falls
back to a complete legacy read (or the legacy path's own explicit degraded result).
The reader does **not** re-normalize canonical state — it validates and serves the
already-certified immutable snapshot.

---

## 6. Fallback architecture (§7)

Any gate failure → `legacy()` → `buildCanonicalLeagueState(slug, options)` with
`provenance.state_source = "LEGACY_LIVE_PATH"` and `provenance.fallback_reason` set
(one of `NO_POINTER / TARGET_MISSING / ID_MISMATCH / LEAGUE_MISMATCH /
UNSUPPORTED_SCHEMA / INTEGRITY_FAILED / PERSISTENCE_UNAVAILABLE / TOO_STALE /
MALFORMED`; `FLAG_OFF` maps to `null` — not a fallback, the flag is simply off).
Envelope routes carry `fallback: { occurred, reason }`. Emits `stale_snapshot_served`
with `fallback: true`.

---

## 7. Stage D envelope semantics preserved (§8, §9)

`state_source` / `response_state_lineage` / `published_snapshot` / `freshness` /
`response_state_lineage.served_freshness` / `integrity` / `capabilities` stay
independent — no field reinterpreted. `fallback` is **additive**.

- On PUBLISHED serve: `response_state_lineage.snapshot_id === published_snapshot.snapshot_id` (the reader's `ID_MISMATCH` check guarantees it).
- On fallback: `response_state_lineage.snapshot_id` = the **live** snapshot's id; `published_snapshot.snapshot_id` = the **pointer target** (preserved, not overwritten). A deterministic test (`readLeagueState: lineage IDs are never conflated`) asserts the two are not conflated on fallback.

Representable, unchanged:
`{ state_source: LEGACY_LIVE_PATH, published_snapshot.present: true, freshness STALE, served_freshness ACCEPTABLE }` and
`{ state_source: PUBLISHED_SNAPSHOT, integrity CERTIFIED, source_status SOURCE_UNAVAILABLE }`.

---

## 8. Serving freshness policy (§10)

Reuses Stage D thresholds and `≤` boundary semantics unchanged.

| Published-snapshot freshness | May serve? |
| --- | --- |
| `FRESH` (≤ mode fresh threshold) | yes |
| `ACCEPTABLE` (≤ mode acceptable threshold) | yes — served as current |
| `STALE` (> acceptable) | **no** → fall back to a fresher live read (`TOO_STALE`) |
| `REFRESHING` / `DEGRADED` / `SOURCE_UNAVAILABLE` / `UNKNOWN` | no → fall back |

Rationale: a certified-but-STALE snapshot is **not invalidated** — it stays visible and
`CERTIFIED` in `published_snapshot`, and provider-source unavailability alone never
changes that (the serve check is purely age-based). But when the provider is reachable a
fresher live read is preferable; if the live read also fails, `buildCanonicalLeagueState`
returns its own explicit degraded result. Integrity and freshness stay separate.

`STALE`-as-LKG serving (serve the certified stale snapshot rather than fall back) is a
deliberate future tuning knob, not enabled in Stage F.

---

## 9. Wave-by-wave migration (§13)

One boolean-ish flag with graduated levels (`wave1` → `wave2` → `wave3` → `all`). The
code migration is uniform (each eligible consumer calls `readLeagueState` with a `wave`
tag); the **wave discipline is the preview rollout procedure** — enable `wave1`,
validate the Wave-1 route family (flag-ON vs flag-OFF payload compare + shadow compare +
fallback test + provider-read count), then `wave2`, then `wave3`. Each wave's validation
is part of the pending deployment gates (§ Stage F readiness).

Wave 1 = `state` + `scoring`. Wave 2 = `context` + `manage` (Team-State). Wave 3 = trade
context. `wave` gating is unit-tested (`wave1` flag serves a wave-1 read as published but
a wave-2 read stays legacy).

---

## 10. Payload compatibility (§11)

- Deterministic: `readLeagueState` flag-ON serves a snapshot **byte-identical** (same content hash) to the one published — proven by test. So route-owned facts (manager/roster mapping, ownership, starters/bench/IR, scoring, week, team names, player identity/eligibility, matchup facts) are exactly those of a certified canonical snapshot.
- Legacy-vs-published equivalence for the *same source moment* is proven structurally by `reconcilePublishCandidate` (only a `CERTIFIED` snapshot serves) and, with real data, by the shadow harness (§11 below).
- No existing payload test was loosened. Non-live suite: **1225 pass / 0 fail / 0 skipped**, deterministic across repeated runs.

---

## 11. Shadow comparison (§12)

`npm run shadow:compare` (`scripts/bridge-shadow-compare.ts`) — the §16 block now:
1. compares legacy live vs the **actual published pointer snapshot** (`compareCanonicalPaths`, `LIVE_SHADOW`, source-moved aware); and
2. records what `readLeagueState` (flag forced ON, wave 3) actually serves — `reader_state_source` + `reader_fallback_reason`.

Stage C rule holds: `UNEXPLAINED = 0` on stable-source runs; no blanket timestamp
ignore (ownership / lineup / records / matchups / transactions still compared). Local
run: deterministic + Layer B `UNEXPLAINED = 0` both leagues; the §16 block reports
"published-pointer store not configured in this environment" (expected locally — real
comparison needs a deploy).

---

## 12. Provider-read reduction (§14)

When flag ON + pointer serves, an eligible read does: `published.status()` +
`published.get()` + `snapshots.getById()` + `reconcilePublishCandidate()` (pure) — and
**zero Sleeper calls**. vs legacy `buildCanonicalLeagueState` ≈ 5–7 Sleeper fetch
attempts (league/users/rosters/drafts/state + matchups + transactions), mostly cache
hits but each with overhead.

Remaining intentional live provider reads: Stage E refresh/publication, `/api/cron/*`,
Draft Live, waiver/free-agent, `/api/health`, `weekly/context.ts` (deferred), the C-list
deferred routes, history, `/api/raw`. No accidental duplicate live-normalization path —
`readLeagueState` is the only new read front door and it never normalizes.

**Before/after measurement: PENDING** — requires a deploy with a live pointer.

---

## 13. Read / publish concurrency (§15)

`readLeagueState` reads the pointer (one atomic row: `snapshot_id` + `content_hash`
move together in one `UPDATE`) then `getById` (one whole immutable row). A read
concurrent with an advance resolves to either the whole old snapshot or the whole new
one — never a mix. A torn read (pointer says hash X, snapshot hashes to Y) is caught by
the `ID_MISMATCH` gate → fallback, never a wrong serve. Tested
(`readLeagueState: read / publish concurrency` — `Promise.all([read, publish])`, read is
a whole snapshot, final pointer seq 2 / hash B).

---

## 14. Preview deployment (§16) — Stage E gate #1

**PENDING.** Deploy a preview with the existing Supabase env + `REFRESH_SECRET`
(+ `CRON_SECRET`) and `BRIDGE_PUBLISHED_SNAPSHOT` OFF, then `POST /api/refresh?scope=all`
and confirm: publication succeeds/dedupes for both leagues, pointer exists, target
exists, integrity CERTIFIED, `freshness.status` ≠ `UNKNOWN`, deep health reports
`publication_generation`, an audit row exists, and ordinary reads still `LEGACY_LIVE_PATH`.

---

## 15. Deployed concurrency (§17) — Stage E gate #2

**PENDING.** From the preview, fire concurrent `POST /api/refresh` invocations; confirm
no pointer regression, no duplicate corruption, one valid final pointer, `raced`
outcomes reported as such, idempotent retries, accurate audit trail. Storage-layer
proof on the production DB is already done (Stage E §5: 8 writers → 1 advanced / 7
raced; stale guarded write → 0 rows); this gate needs the deployed HTTP path.

---

## 16. Active NFL scoring-window gate (§19) — Stage E gate #3

**PENDING.** Both leagues are at week 1, no completed games. Run `npm run shadow:compare`
(incl. the P0 route comparison `standings / managers / matchups / transactions /
leagues/[l]/managers*`) during real scoring activity; require `UNEXPLAINED = 0`. Not
satisfiable with preseason/synthetic activity.

---

## 17. Sporty's Alumni Draft Live (§20)

- League **not registered** — add to `lib/leagues/registry.ts` before relying on the Bridge for that draft.
- The draft-live path's independence from Stage E/F is proven for the representative Sleeper configuration (§3).
- `pre_draft → drafting → complete` transition selection is covered by existing deterministic draft tests; a live smoke during the real draft is **PENDING** on registration + an active draft.

---

## 18. Waiver / free-agent exclusion certification (§21)

- `lib/weekly/context.ts` **reverted** to `buildCanonicalLeagueState` — matchup / lineup / waiver inputs stay fully legacy.
- `/api/waivers`, `/api/player-availability`, `/api/manager-availability` — not migrated.
- `free_agent_pool` capability stays `UNAVAILABLE`; `LeagueManagementContext.ownership.free_agent_pool = "NOT_MATERIALIZED"` unchanged.
- `lib/weekly/availability.ts` classifies a bounded projection-candidate list against canonical roster ownership — it never reads `snapshot.waiver_state`, and "not rostered" is never equated with "addable" beyond that existing bounded mechanism.
- This is an intentional Stage F exception, documented, not an incomplete migration.

---

## 19. Health / observability (§22, §23)

`GET /api/health?deep=1` — additive only (bare `/api/health` unchanged, read-only):
- `feature_flags.BRIDGE_PUBLISHED_SNAPSHOT` (state string: `OFF` / `WAVE1..3` / `ALL_WAVES`), `eligible_routes_expected_source`, `waves_enabled.{wave1,wave2,wave3}`, `draft_live_independent: true`, `waiver_free_agent_migration_eligible: false`;
- per league (from Stage D/E): `publication_generation`, `last_refresh`, `last_successful_refresh_at`, `recent_refresh_outcomes`, pointer inspection, integrity, capability matrix, discrepancy/material-unresolved counts;
- `persistence.{history_stores, published_pointer_store, publication_audit_store}`.

Structured events extended: `freshness_evaluated` now carries `state_source` +
`serving_freshness` + `wave`; `stale_snapshot_served` carries `fallback: true` + `reason`
+ `wave`; `deep_health_checked` carries `flag_state`. IDs only — no secrets. Enough to
tell "served from published vs legacy fallback, which route family, which league, which
snapshot, freshness, fallback reason" from logs. No new telemetry subsystem.

---

## 20. Failure injection (§24)

`test/bridge-published-read.test.ts` (12 tests, hermetic — `stubProvider` on the legacy
branch, no network):

| Injection | Result |
| --- | --- |
| flag OFF | legacy, `fallback_reason: null` |
| flag ON, valid fresh pointer | `PUBLISHED_SNAPSHOT`, byte-identical snapshot |
| wave gating (`wave1` flag, wave-2 read) | legacy, no fallback (flag off for that wave) |
| NO_POINTER | legacy, `fallback_reason: NO_POINTER`, `pointer_present: false` |
| TARGET_MISSING (pointer names a missing snapshot) | legacy, `TARGET_MISSING`, `pointer_present: true` |
| ID_MISMATCH (tampered content_hash) | legacy, `ID_MISMATCH` |
| UNSUPPORTED_SCHEMA (`schema_version: 99`) | legacy, `UNSUPPORTED_SCHEMA` |
| MALFORMED (no teams) | legacy, `MALFORMED` |
| TOO_STALE (1h-old pointer) | legacy, `TOO_STALE`, `serving_freshness: STALE`, pointer still visible |
| PERSISTENCE_UNAVAILABLE (store status error) | legacy, `PERSISTENCE_UNAVAILABLE` |
| lineage not conflated on fallback | `pointer_snapshot_id` = pointer target, not live id |
| read concurrent with advance | whole old OR whole new, never a mix; final seq 2 |
| flag toggled OFF / ON | `afterEach` clears; both states verified |

`INTEGRITY_FAILED` and `LEAGUE_MISMATCH` are covered by inspection (a published snapshot
always passes read-time `reconcilePublishCandidate` since it's the same gate; the pointer
key guarantees league match) — the code paths exist and fall back.

If neither published nor legacy can satisfy a route, `buildCanonicalLeagueState`'s
explicit degraded result is returned — no fabricated success.

---

## 21. Security / rollout review (§25)

- Stage F introduces **no new mutation surface** — `readLeagueState` only reads (pointer `get`, `getById`, pure reconcile).
- Refresh auth unchanged (Stage E). `/api/health` still read-only. Ordinary reads cannot trigger publication.
- Flag is a plain env var — not exposed to clients except as a status string in `?deep=1`.
- Arbitrary league slugs: `readLeagueState` runs `resolveLeagueStrict` on the published branch; an unresolvable slug maps to `MALFORMED` → legacy path produces the canonical error. No unintended storage access.
- No secrets in response/log output.

---

## 22. Adversarial audit — P0/P1/P2/P3 (§27)

**P0 (wrong/unsafe state served): NONE.** `state_source: PUBLISHED_SNAPSHOT` is set only
by the reader's success branch, which returns the pointer's own snapshot after 10
validation gates including lineage + content-hash equality. Every other path hardcodes
`LEGACY_LIVE_PATH`. A torn pointer/snapshot read → `ID_MISMATCH` → fallback, never served.

**P1 (material freshness/fallback/compat/migration defect): NONE.**

**P2:**
- **P2-1 — cron cadence vs serving ceiling.** Original `*/10` cron vs NORMAL `ACCEPTABLE ≤ 600s` was too tight (a slightly-late cron → pointer STALE → all eligible reads flap to legacy). **Fixed in this commit → `*/5 * * * *`** so the pointer stays ≤ ~5–6 min ≤ 600 s and never STALE under normal operation.
- **P2-2 — `reconcilePublishCandidate` on every published read.** Pure, O(rosters × players), microseconds for a 12-team league. Acceptable; noted.
- **P2-3 — `lib/weekly/context.ts` not migrated.** Provider-read reduction not realized for `/api/matchup`, `/api/lineup` (waiver-adjacent). Deliberate; deferred to a post-remodel availability-materialization phase.
- **P2-4 — C-list deferred routes.** `/api/leagues/[l]/managers/[m]`, `/api/*/snapshot`, `/api/league`, `/api/leagues/[l]` still legacy. Eligible; deferred; documented.

**P3:**
- lint: `_`-prefixed unused params on unconfigured stores (established pattern).
- `npm test` flakiness lives entirely in `*-live.test.ts` (network/Supabase under parallel load) — **pre-existing** (reproduced on `cf67186`), unchanged by Stage F. Non-live suite is deterministic.

No P0/P1 → Stage F is eligible to freeze on the code axis.

---

## 23. Regression (§28)

| Check | Result |
| --- | --- |
| `tsc --noEmit` | clean |
| `npm run lint` | 0 errors (29 warnings, pre-existing patterns) |
| non-live deterministic suite (`test/*.test.ts` minus `*-live`) | **1225 pass / 0 fail / 0 skipped**, repeated runs identical |
| bridge suite (`test/bridge-*.test.ts`) | **87 pass / 0 fail** (Stage E: 75; +12 Stage F reader tests) |
| full `npm test` (incl. `*-live`) | pre-existing flaky (`cf67186` baseline: 1390/1/4); best Stage F run 1395/0/11 — flakiness is network-bound `*-live` only |
| Stage C equivalence (`npm run shadow:compare`) | deterministic `UNEXPLAINED = 0`; live stable-source `UNEXPLAINED = 0` |
| Stage D freshness / Stage E publication / Stage F reader tests | green |
| canonical + Team-State certification | green (non-live) |
| weekly / trade parity | green (non-live); `weekly/context.ts` unchanged |
| live smoke both leagues (dev server, flag OFF and ON) | eligible routes `LEGACY_LIVE_PATH` (OFF) / safe fallback `PERSISTENCE_UNAVAILABLE` (ON, no local pointer); draft routes unaffected |
| preview deployment / deployed concurrency / active-scoring window | **PENDING** (§14–16) |
| model files changed | **none** |
| pointer writes caused by Stage F dev work | **0** |
| feature flag | **OFF** |

No existing test weakened.

---

## 24. Files changed

### New
`lib/canonical/read.ts`, `test/bridge-published-read.test.ts`.

### Modified
`lib/canonical/published-flag.ts` (wave levels + `publishedFlagState`),
`lib/canonical/freshness-envelope.ts` (`+ fallback`),
`lib/canonical/manager-context.ts` (→ `readLeagueState`, `+ state_source`),
`lib/team-state/build.ts` (→ `readLeagueState`, `+ state_source`),
`lib/scoring/scoring-service.ts` (→ `readLeagueState`),
`lib/trades/context.ts` (→ `readLeagueState`),
`app/api/league/[league]/state/route.ts`, `app/api/context/[league]/[manager]/route.ts`,
`app/api/leagues/[leagueSlug]/manage/route.ts`,
`app/api/leagues/[leagueSlug]/managers/[managerSlug]/manage/route.ts` (surface `state_source`),
`app/api/health/route.ts` (`?deep=1` flag/wave/exclusion fields),
`scripts/bridge-shadow-compare.ts` (§16 reader check),
`test/helpers/canonical-snapshot.ts` (`+ stubProvider`),
`vercel.json` (publish cron `*/10` → `*/5`).

`lib/weekly/context.ts` — **reverted** (kept legacy, §18).

---

## 25. Production rollout plan (§26)

1. Deploy Stage F with `BRIDGE_PUBLISHED_SNAPSHOT` **OFF** — no behavior change.
2. Verify `/api/cron/publish` advances the pointer; `/api/health?deep=1` shows `publication_generation`, `last_successful_refresh_at`, integrity CERTIFIED.
3. `npm run shadow:compare` — stable-source legacy-vs-published `UNEXPLAINED = 0`.
4. Deployed concurrency gate (§15).
5. Active NFL scoring-window gate (§16) — `UNEXPLAINED = 0`.
6. Confirm Sporty's Alumni registered + Draft Live independent (§17).
7. Flip `BRIDGE_PUBLISHED_SNAPSHOT = wave1`; validate; then `wave2`; then `wave3` / `all`. After each: eligible routes → `PUBLISHED_SNAPSHOT`, `response_state_lineage.snapshot_id` matches the pointer, payload facts equivalent, provider reads drop, fallback works, Draft Live + waiver unaffected.
8. Any P0/P1 / material discrepancy → unset the flag immediately. No data rollback needed.

## 26. Rollback procedure

Unset `BRIDGE_PUBLISHED_SNAPSHOT` (or set `off`). Next request → every eligible route
serves `LEGACY_LIVE_PATH`. No migration reversal, no cache flush, no snapshot rewrite.
The `bridge_published_snapshot` / `bridge_publication_audit` tables stay (inert while
unread). The `/api/cron/publish` cron can keep running harmlessly or be removed from
`vercel.json`.

## 27. Remaining intentional legacy paths / later cleanup (outside this remodel)

- Draft Live — permanent.
- Waiver / free-agent / pickup + `lib/weekly/context.ts` — until a dedicated availability-materialization phase.
- `/api/health` — permanent (must read live).
- Publication / capture path — permanent (must read live).
- C-list deferred routes (`/api/leagues/[l]/managers/[m]`, `/api/*/snapshot`, `/api/league`, `/api/leagues/[l]`, `analytics/snapshot`) — migrate in a small follow-up pass after the flag flip is stable.
- **Not part of this remodel:** free-agent-pool materialization; `STALE`-as-LKG serving; per-domain snapshot timestamps; migrating the C-list; Sporty's Alumni registry entry.

---

---

# Stage F — Operational Addendum (post-`6e76a5e`)

Commit `518f8de`. No remodel architecture added; no recommendation-model change.

## A1. Sporty's Alumni registry addition (Part 1)

`lib/leagues/registry.ts` — append-only entry, existing leagues untouched:

| field | value | source |
| --- | --- | --- |
| `key` | `sportys-alumni` | — |
| `provider` | `sleeper` | — |
| `league_id` / `external_league_id` | `1389404340015370240` | user commit `6007d5f`, verified live |
| `season` | `2026` | Sleeper `league.season` |
| `display_name` | `Sporty's Alumni` | Sleeper `league.name` (`Sporty's Alumni`) |
| `known_managers` | `[]` | the bridge account is **not a member** — every manager resolves generically at request time |
| `sleeper_username` / `sleeper_user_id` | `null` | **genuinely N/A** — no registered self-manager (matches the two Yahoo entries) |

**Live-verified against Sleeper (2026-09-07):** league `1389404340015370240` = "Sporty's Alumni",
season 2026, status `pre_draft`, 14 rosters, roster `QB/RB/RB/WR/WR/TE/FLEX/FLEX/K/DEF + 5 BN`
(no IR/taxi), 132 scoring keys. Draft `1389404340032118784`: `pre_draft`, type **snake**,
15 rounds, 14 slots, 60 s pick timer, `reversal_round: 0`, `start_time` 2026-09-08 (tomorrow).
Full `draft_order` + `slot_to_roster_id` present.

Verified (deterministic + live smoke):
- slug resolves → `1389404340015370240`; `resolveLeagueStrict` ok, `registered: true`;
- no other configured league resolves to that id or draft; a typo does not fall back;
- `selectActiveDraft` → `1389404340032118784`, type `snake`;
- season 2026; draft type resolves; `draft_order`/`slot_to_roster_id` accessible;
- manager mapping resolves generically (`rspata2` etc. — 14 real members);
- scoring + roster settings resolve (132 keys, 15-slot roster);
- canonical state builds where applicable → `DEGRADED` pre-draft shell (14 teams, empty rosters), honest;
- ordinary registry lookups for other leagues unchanged.

Deterministic coverage: `test/leagues-registry.test.ts` (+5), `test/draft-sportys-alumni.test.ts` (15).

## A2. Sporty's Alumni Draft-Live preflight (Part 2)

**Draft Live is NOT routed through the published-snapshot system** — proven three ways:
1. exhaustive grep: `lib/draft/service.ts`, `lib/sleeper/draft*.ts`, `lib/leagues/manager-draft.ts`, every `/api/draft*` + `/api/bridge/board` + `/api/leagues/[l]/managers/[m]/recommendations` route → **zero** references to `readLeagueState` / `getPublishedLeagueSnapshot` / the pointer / `published-flag` / the publish cron;
2. a test asserts `lib/draft/service.ts` source contains none of those symbols;
3. `computeDraftGeometry` + `selectActiveDraft` are pure (no `process.env` read) — a test runs them with `BRIDGE_PUBLISHED_SNAPSHOT=all` and gets byte-identical output.

**Pre-draft checks (live smoke, dev server):**
- `/api/health?draft=1&league=sportys-alumni` → `active_draft_id: 1389404340032118784`, `draft_status: pre_draft`, `draft_type: snake`;
- `/api/leagues/sportys-alumni/draft` → HTTP 200, 14 teams, 300-player bounded pool, `Cache-Control: no-store`;
- `/api/leagues/sportys-alumni/managers/rspata2/recommendations` → HTTP 200, `readiness: READY`, `error: null`, `recommendation_model_version: ri-snake-decision-2026.2` (**snake** engine — SNAKE_ONLY gate passes for `type: snake`), `completed_picks: 0`, **`Cache-Control: no-store`**, **no `state_source` field** (correctly a direct draft-path response, not a canonical/published one);
- already-drafted-player reconciliation: the pool excludes drafted + rostered players (existing `available-player-eligibility` + `draft-live` coverage; 0 picks so far);
- current/next pick + snake geometry: deterministic tests for a 14-team draft (round 1 slot 7 → pick 7; round 2 reverses → 22; round 3 → 35; "next pick" advances past spent picks so a manager is never stranded; impossible slot 15 rejected).

**Freshness / source-path checks:**
- room endpoints (`/api/leagues/[l]/draft`, `.../managers/[m]/draft`, `.../recommendations`) → `Cache-Control: no-store`, hit fresh Sleeper via `getDraftLive` / `getDraftPicksLive` / `getLeagueRostersLive`;
- independent of the `*/5` publish cron and the published pointer (grep + pure-function tests);
- a `pre_draft` / `drafting` league is now **skipped** by `getPublishedLeagueSnapshot` (`outcome: "skipped"`, no `put`, no pointer advance) — so the publish cron cannot even build state for Sporty's Alumni during its draft. Auto-enrolls once `status` becomes `in_season`. (`test/draft-sportys-alumni.test.ts` — pre_draft → skipped/no pointer; drafting → skipped; in_season → published.)

**Actual polling cadence (as implemented in code — not assumed):**
- **The repository implements NO automatic draft-poll loop.** The `/bridge` UI (`app/bridge/page.tsx`) refetches the board on a state-signature change (`leagueKey|slot|rankingMode`), via `fetch(..., { cache: "no-store" })` — there is no `setInterval`.
- The **backend makes the endpoints poll-safe**: room endpoints are `Cache-Control: no-store` (no CDN floor); the legacy `/api/draft` form is `s-maxage` = **5 s when `drafting`**, 30 s `pre_draft`, 300 s `complete` (`CACHE_SECONDS_BY_STATUS` in `lib/sleeper/draft-service.ts`), and reports `metadata.polling_safe: true` + `cache_seconds`.
- **Seconds-level live updating during a draft is the client's responsibility** — a client polling a no-store room endpoint every ~2–5 s would work, but that loop is not in this repo. This is a factual finding, not a defect.

**State-transition checks:** `pre_draft → drafting → complete` selection is covered deterministically (`selectActiveDraft` picks `drafting` over `complete`, surfaces `pre_draft` as the upcoming draft, keeps a `complete` draft readable). **The live active-transition smoke is PENDING** the real draft — do not fake it.

## A3. Draft safety regression (Part 3)

`test/draft-sportys-alumni.test.ts` — all 10 required checks, deterministic, 15 tests, 0 network:
1. configured league → correct draft ✅
2. wrong league cannot resolve to Sporty's draft ✅
3. active pick increments (geometry "next pick" advances) ✅
4. drafted player disappears from availability — existing `draft-live` / `available-player-eligibility` coverage (0 picks yet) ✅
5. duplicate Sleeper pick ingestion idempotent — existing `draft*.test.ts` coverage ✅
6. snake-order reversal correct for 14 teams ✅
7. manager/slot mapping stable ✅ (draft_order + slot_to_roster_id from Sleeper, geometry deterministic)
8. API response not from published snapshot ✅ (grep + source assertion + no `state_source` on the live response)
9. Stage F flag cannot throttle Draft Live ✅ (pure functions, `BRIDGE_PUBLISHED_SNAPSHOT=all` → identical)
10. completed draft exits active mode ✅ (`selectActiveDraft` + status-based cache)

No recommendation-model file changed. No P0/P1.

## A4. Deployment / scoring gates (Parts 4–9) — status

| Gate | Status |
| --- | --- |
| Part 4 — preview publication (`POST /api/refresh?scope=all`, pointer advances, `freshness` leaves `UNKNOWN`) | **PENDING** — needs a preview deploy with `REFRESH_SECRET` + Supabase env |
| Part 5 — deployed concurrency (concurrent `POST /api/refresh` on the deployed HTTP path) | **PENDING** — storage-layer proof on the production DB is done (Stage E §5); the deployed path is not |
| Part 6 — active NFL scoring-window shadow (`npm run shadow:compare` incl. P0, `UNEXPLAINED = 0`) | **PENDING** — preseason; no scoring window available. Synthetic activity does not satisfy this gate. |
| Part 7 — preview wave rollout (`wave1` → `wave2` → `wave3`, `UNEXPLAINED = 0` after each) | **PENDING** — follows Parts 4–5 |
| Part 8/9 — production flip + wave rollout | **BLOCKED** on Parts 4–7 + a live Sporty's Alumni draft smoke |

I cannot deploy, and no live NFL scoring window is available during this session. Parts 4–9
are operator actions; the code and the local/deterministic checks that gate them are complete.

## A5. Regression (updated)

| Check | Result |
| --- | --- |
| `tsc --noEmit` | clean |
| `npm run lint` | 0 errors (29 warnings, pre-existing patterns) |
| non-live deterministic suite | **1245 pass / 0 fail / 0 skipped** (was 1225; +20 Sporty's/registry), repeated runs identical |
| bridge suite | **87 pass / 0 fail** |
| draft suite incl. `draft-sportys-alumni` | green |
| model files changed | **none** |
| feature flag | **OFF** |
| pointer writes from dev work | **0** |

Updated for the 5th league (no test weakened): `test/multi-league-isolation.test.ts`
(`SLEEPER` list, "5 leagues" describe title), `test/cron-capture.test.ts` (READY-sleeper list).

---

# Stage F — Draft-Live Automatic Polling (readiness fix, `c68d5dc`)

Narrow client-side fix. No new remodel stage; no recommendation-model / snake /
valuation / canonical / published-snapshot / pointer change.

## P1. What was missing

Verified before: the repo had **no automatic draft-poll loop** — `/bridge` refetched
only on a state-signature change. Seconds-level pick visibility during a live draft
was not guaranteed.

## P2. Implementation

- **`lib/bridge/draft-poller.ts`** — `DraftPoller`, a framework-agnostic status-driven
  poller (so the interval mechanics are unit-testable with fake timers; the React
  component just wires it up). One place for the constants:
  `DRAFT_LIVE_POLL_MS = 2000`, `DRAFT_STATUS_POLL_MS = 7000`, `DRAFT_POLL_MAX_BACKOFF_MS = 15000`.

  | draft status | behavior |
  | --- | --- |
  | `drafting` / `paused` | poll every **2 s** |
  | `pre_draft` | poll every **7 s** (notice the start; no indefinite 2 s loop) |
  | `complete` / any other known status | **stop** polling |
  | unknown (no board yet) | poll once to learn it, then bounded (≤8) 7 s re-checks |

  - **No request pileups** — recursive `setTimeout` schedules the next tick only *after*
    the current `poll()` promise settles; a structural in-flight guard on top.
  - **Transient failure** — bounded exponential backoff (`interval × 2ⁿ`, capped 15 s),
    the loop never stops, the board is never cleared, no other state is substituted.
  - **Visibility** — `pause()` on tab hidden, `resume()` on visible does an *immediate*
    refresh then resumes cadence.
  - Reads no env, imports no canonical / published / pointer / model code (asserted).

- **`app/bridge/page.tsx`** — one `useEffect` creates a `DraftPoller` (re-armed per
  league), feeds it `board.draft_feed.status`, wires a `visibilitychange` listener.
  `fetchBoard()` gains `{ silent, keepOnError }`: a polled refresh doesn't toggle the
  loading spinner and **keeps the last-known-good board on any error** ("showing last
  update; retrying") — a user-driven load still clears as before.

- **`app/api/bridge/board/route.ts`** — `Cache-Control: no-store` when
  `draft_feed.status ∈ {drafting, paused}` (was always `s-maxage=5`). No CDN window can
  now stretch the effective 2 s cadence. `pre_draft` / `complete` keep the short CDN cache.

## P3. Pick-change flow (automatic, no reload / button / external trigger)

On each 2 s poll the client refetches `/api/bridge/board`, which already composes
everything from fresh Sleeper reads (`getDraft`/`getDraftPicks` with `noStore`):
new completed picks, current/next pick geometry inputs, the available-player pool
(drafted players already excluded), and the ranked recommendation source. No alternate
Draft-Live state model was introduced.

## P4. Tests — `test/bridge-draft-poller.test.ts` (13, fake timers, no network, no React render)

cadence per status · `pre_draft → drafting` auto-activation · unknown-status learn poll ·
`drafting → complete` stops rapid polling · no pileups (a hanging poll → `maxConcurrent = 1`) ·
transient error keeps the board + auto-recovers + returns to 2 s · tab hidden pauses /
visible refreshes immediately · `stop()` cancels a pending tick · `BRIDGE_PUBLISHED_SNAPSHOT=all`
changes nothing and the source has no env/pointer reference · a 14-team snake draft
(Sporty's Alumni shape) drives the identical path. `pollIntervalForStatus` /
`pollDecision` boundary values.

## P5. Scope note — Sporty's Alumni and the `/bridge` UI

The **`/bridge` web UI serves `bloodline_bowl` and `devoted_to_the_game` only** — those
are the two registered *Bridge profiles* (`lib/bridge/profiles.ts`), which carry a
frozen `model_profile`. **Sporty's Alumni has no Bridge profile**, so it is not
selectable in that UI. Its Draft-Live consumers are the API routes
(`/api/leagues/sportys-alumni/draft`, `.../managers/{m}/draft`, `.../managers/{m}/recommendations`),
which are already `Cache-Control: no-store` and poll-safe. The polling fix makes the
`/bridge` UI auto-refresh during `drafting` for the leagues it serves, and the board
route now returns `no-store` during an active draft for *any* client. Giving Sporty's
Alumni a rapid-polling UI would require adding a Bridge profile with a `model_profile`
— out of scope for this narrow fix (would touch model wiring) and flagged for the user.

## P6. Regression

`tsc` clean · `lint` 0 errors · **non-live suite 1258 / 0 / 0** (deterministic) ·
**production `npm run build` compiles** · draft + Sporty's Alumni + Stage F reader
suites green · no model files changed · `BRIDGE_PUBLISHED_SNAPSHOT` OFF · 0 pointer writes.

## P7. Live Sporty's Alumni draft smoke — still an operator gate

During the real draft, read-only: confirm `drafting` is detected, rapid polling
activates, **record the observed poll cadence**, a real pick appears without a manual
refresh within one poll cycle + normal latency (else → material Draft-Live defect),
the player leaves availability, current pick advances, recommendations update, no stale
drafted player stays recommended, snake reversal at a real round boundary if observed,
and completion disables rapid polling.

---

## Stage F Certification

**CONDITIONAL — PRODUCTION FLAG FLIP BLOCKED.**

Stage F code is complete and correct, and Sporty's Alumni is registered and its Draft
Live path is preflighted (deterministic + live smoke). No P0/P1 findings. Flag OFF,
eligible reads still `LEGACY_LIVE_PATH`, 0 pointer writes from dev work, 0
recommendation-model files changed, non-live suite deterministic (**1245 / 0 / 0**),
two P2s fixed (cron `*/5`; pre-draft/drafting publish skip).

The production `BRIDGE_PUBLISHED_SNAPSHOT` flag **must not be flipped** until every one
of these operator gates passes:

1. **Preview publication gate** — deploy with `REFRESH_SECRET` + Supabase env, `POST /api/refresh?scope=all`; pointer advances, target exists, integrity CERTIFIED, `freshness.status` leaves `UNKNOWN`, audit row written, ordinary reads still `LEGACY_LIVE_PATH`.
2. **Deployed concurrency gate** — concurrent `POST /api/refresh` from the deployed HTTP path; no pointer regression / duplication; races reported as `raced`.
3. **Active NFL scoring-window gate** — `npm run shadow:compare` incl. the P0 route comparison during real scoring; `UNEXPLAINED = 0` on stable-source runs.
4. **Live Sporty's Alumni draft smoke** — during the actual draft: `pre_draft → drafting → complete` selection, picks observed on the next live poll, drafted players leave the pool, snake seat mapping stays correct, Draft Live never touches the pointer.

Rollback at any point: unset `BRIDGE_PUBLISHED_SNAPSHOT`. No data rollback needed.

Once all four pass, flip the flag wave-by-wave (§25). The bridge real-time-state remodel
is then complete. **There is no Stage G.**

STOPPING per protocol.
