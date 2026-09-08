# Bridge Real-Time State — Stage C: Shadow Comparison + Materiality-Aware Capabilities

Status: **Stage C complete. Operationally read-only — no route migrated, no flag flipped,
no model file touched, 0 pointer rows written to production.**
Branch: `bridge-realtime-state-phase-a`
Depends on: Stage B (`534ca7f`)
Machine report: [`BRIDGE_REALTIME_STATE_PHASE_C_SHADOW_RUN.md`](./BRIDGE_REALTIME_STATE_PHASE_C_SHADOW_RUN.md)
(regenerate: `npx tsx scripts/bridge-shadow-compare.ts`)

---

## 1. Files changed

### New
| File | Purpose |
| --- | --- |
| `lib/canonical/capabilities.ts` | Materiality-aware capability model. `assessCapabilities(snapshot, findings)` → `{ snapshot_integrity, capabilities: Record<Capability, {status, reasons, missing_inputs}>, material_unresolved, benign_unresolved_count, unresolved_categories }`. Formalizes **SNAPSHOT INTEGRITY** vs **CAPABILITY COMPLETENESS**. |
| `lib/canonical/shadow.ts` | `compareCanonicalPaths(old, new, {mode, sourceStartHash, sourceEndHash, reconcileOk})` → classified `ShadowComparison`; `compareDirectSurface()` for P0 routes (splits `certify()` discrepancies into timing-plausible vs. semantic). Difference taxonomy: `EXPECTED_METADATA / EXPECTED_ORDERING / SOURCE_MOVED_DURING_RUN / CORRECTED_IDENTITY / CORRECTED_STALE_STATE / KNOWN_OLD_PATH_BUG / OPTIONAL_CAPABILITY_DIFFERENCE / UNEXPLAINED`. |
| `scripts/bridge-shadow-compare.ts` | The Stage C harness (see §3). Read-only: in-memory persistence, `dryRun`, Sleeper GETs only. |
| `test/bridge-capabilities.test.ts` | 9 tests — both directions of the materiality rule. |
| `test/bridge-shadow-compare.test.ts` | 6 tests — Layer A determinism, dry-run writes nothing, taxonomy classification. |
| `test/helpers/canonical-snapshot.ts` | Shared snapshot fixture builder (not a test file). |

### Modified
| File | Change |
| --- | --- |
| `lib/canonical/reconcile.ts` | Integrity verdict + warning tolerance now delegated to `assessCapabilities`. `ReconcileResult` gains `capabilities: CapabilityReport`; drops the ad-hoc `eligibility` list. `certify()` + structural checks unchanged; still the two inputs to the gate. |
| `lib/canonical/published.ts` | `PublishedSnapshotResult` gains `capabilities` + `dry_run`. New `dryRun` option: build + reconcile, **no `put`, no `advance`, pointer untouched**. `outcome: "dry_run"`. Public accessor now wraps an inner pipeline and attaches the capability report for the served snapshot. |
| `lib/observability/events.ts` | dropped an unused eslint-disable. |

---

## 2. Materiality-aware capability model

Replaces the Stage-B unconditional benign-warning allow-list with the rule you specified:
**a warning is tolerated for publication only when proven non-material to snapshot
integrity and to every capability still reported HEALTHY.**

### SNAPSHOT INTEGRITY vs CAPABILITY COMPLETENESS

```
snapshot_integrity = CERTIFIED        ← safe to treat as current league reality
capabilities:
  roster_state        HEALTHY
  ownership           HEALTHY
  standings           HEALTHY
  matchups            HEALTHY
  transactions        HEALTHY | DEGRADED   (week feed incomplete)
  history_persistence HEALTHY | DEGRADED   (Supabase history down)
  free_agent_pool     HEALTHY | UNAVAILABLE (pool not materialized)
  draft_availability  HEALTHY | DEGRADED
  player_identity     HEALTHY | DEGRADED | UNAVAILABLE
```

Hard rule encoded once: **no capability reports HEALTHY if one of its required inputs is missing.**

### The four tolerated warnings — conditions

| Warning | Publication | Capability effect | Guard |
| --- | --- | --- | --- |
| `unresolved_player_identities` | allowed **iff** no unresolved id touches current actionable state | `player_identity` → DEGRADED (benign) or UNAVAILABLE (material) | for every `resolution.method === "unresolved"` player, its `canonical_player_id` is checked against roster / starting lineup / bench / IR / taxi / matchup starters / recent transactions / trades / draft picks / availability pool. **Any hit ⇒ material ⇒ integrity REJECTED.** |
| `HISTORY_PERSISTENCE_UNAVAILABLE` | allowed (live state doesn't need it) | `history_persistence` → DEGRADED; reason explicitly states historical lineage/history is **not authoritative** | current canonical state complete + reconcile passes |
| `free_agent_pool_not_materialized` | allowed (snapshot self-consistent without it) | `free_agent_pool` → **UNAVAILABLE**; reason: any waiver/FA/pickup surface MUST report unavailable and MUST NOT claim CURRENT/FRESH | — |
| `week_transactions_unavailable` | allowed **iff** current roster ownership independently certifies | `transactions` → DEGRADED; reason: history/chronology not authoritative, **an empty list does NOT imply no transactions** | roster/ownership structural checks pass |

`player_database_unavailable` is **not** tolerated — without the player DB, rosters are
id-only stubs, so roster/lineup/ownership truth is compromised. Integrity → REJECTED.
Any **unmapped** warning also fails closed (integrity REJECTED).

Tests prove both directions: `test/bridge-capabilities.test.ts` — a non-material
`unresolved_player_identities` publishes with `player_identity: DEGRADED`; the same
warning with the id on a starting lineup → `snapshot_integrity: REJECTED`,
`roster_state: DEGRADED`, `ownership: DEGRADED`.

Diagnostics expose `material_unresolved` (with the surfaces each id touches),
`benign_unresolved_count`, and `unresolved_categories` (e.g. `no_position`, `team_defense`).

---

## 3. Shadow harness — two layers

`scripts/bridge-shadow-compare.ts`. **Read-only:** `memoryPersistence()` (the real
Supabase bundle is never passed in), `dryRun: true`, only Sleeper GET reads.

### Layer A — deterministic same-source
Feed one frozen snapshot through the OLD path (canonical, consumed directly) and the
NEW path (`getPublishedLeagueSnapshot({dryRun})`). They must be **semantically identical**
— this isolates the publish wrapper. Any difference on a stable source is `UNEXPLAINED`.
(Legacy-analytics-vs-canonical equivalence from a frozen Sleeper fixture is already the
job of `certification.test.ts` / `certification-live.test.ts`, still green.)

### Layer B — live shadow
OLD `buildCanonicalLeagueState(slug)` vs NEW `getPublishedLeagueSnapshot(slug,{dryRun})`
on both real leagues. **Source-moved detection:** `buildCanonicalLeagueState` is run again
at the end; if `snapshotContentHash(start) !== snapshotContentHash(end)` the run is
`INCONCLUSIVE_SOURCE_MOVED` and its diffs are classified `SOURCE_MOVED_DURING_RUN`, never
counted as regressions.

### Normalization before diffing
Comparison is semantic, not raw-JSON:
- fact level via `certify(factsFromCanonical(old), factsFromCanonical(new))` — records, scoring fingerprint, slots, team identity, player metadata;
- ownership / roster-slot / matchup / player-metadata via `diffCanonicalSnapshots` (already ignores timestamps, lineage, ordering);
- explicit player-id set membership + transaction-id set;
- capability health (`assessCapabilities(new)`).
Ignored: `captured_at`, `provider_synced_at`, `lineage`, `league_snapshot_id`, freshness, array ordering.
**Not** ignored: ownership, player set, manager mapping, roster membership, records, matchups, transactions, team-state inputs.

---

## 4. Results (run 2026-09-07T17:27Z)

Both leagues are at **week 1** — no live scoring, no completed transactions yet.

| League | Layer A | Layer B | source stable | UNEXPLAINED | reconcile | capabilities |
| --- | --- | --- | --- | --- | --- | --- |
| `bloodline-bowl` | EQUIVALENT (0) | **EQUIVALENT** | yes | **0** | CERTIFIED | `free_agent_pool=UNAVAILABLE` only |
| `devoted-to-the-game` | EQUIVALENT (0) | **EQUIVALENT** | yes | **0** | CERTIFIED | `free_agent_pool=UNAVAILABLE` only |

- **Difference taxonomy:** every category `0` for both leagues. No `CORRECTED_*`, no `KNOWN_OLD_PATH_BUG`, no `UNEXPLAINED`.
- **P0 direct-route surfaces** (canonical vs. a raw `rosters`/`users`/`matchups`/`transactions` reduction): `0` timing, `0` semantic for both leagues.
- **Model-input equivalence (team-state):** 12 teams per league, `0` divergent — `buildTeamManagementState` produces identical inputs/outputs from the old snapshot and the new published snapshot given the same schedule.
- **Capability health:** correctly reports `free_agent_pool = UNAVAILABLE` (the pool is genuinely not materialized — Stage-B behavior, unchanged) and everything else `HEALTHY`. No false "healthy".
- **Pointer rows written by the shadow run: 0.**

### Caveat — quiet-league window
Week 1 means the harness has not yet observed: live in-progress scoring drift, a real
completed transaction, an injury-status change, or a matchup in progress. The
structural-state equivalence is solid; the **timing-vs-semantic** classifier for P0
routes and the `SOURCE_MOVED_DURING_RUN` path are exercised only by the deterministic
tests so far. **Recommendation:** re-run `bridge-shadow-compare.ts` weekly through
Stages D–E (it's read-only and cheap) and attach each run to the rollout log; require a
clean stable-source run during an active scoring window before the Stage F flag flip.

---

## 5. P0 route findings (guidance for Stage D–F)

At week 1 the P0 surfaces **do not currently disagree** with canonical on any substantive
field. That does not retire the migration priority — it means the disagreement they're
*capable* of (independent 300s revalidation clocks producing different in-progress
scores / different transaction snapshots mid-week) can't be measured yet.

| Surface | Week-1 finding | Migration priority | Rationale |
| --- | --- | --- | --- |
| `/api/standings` | agrees (0/0) | **P0 — hold** | flagship skew risk during live scoring; re-measure week ≥ 2 |
| `/api/managers`, `/api/leagues/[l]/managers*` | agrees (0/0) | **P0** | identity/roster; low drift risk but high contradiction visibility |
| `/api/matchups` | agrees (0/0) | **P0** | opponent pairs stable; in-progress points will drift |
| `/api/transactions` | agrees (0/0, no txns yet) | **P0** | cannot be characterized until a real transaction lands |

No migration performed in Stage C (as instructed). The inventory in
`BRIDGE_REALTIME_STATE_PHASE_B.md` §9 stands; Stage D re-runs the harness with live
scoring to convert "capable of disagreeing" into a measured rate.

---

## 6. Capability-health comparison (the "transactions = [] / status = FRESH" trap)

`assessCapabilities` is designed so the new system cannot present the bad pattern:

```
BAD:   transactions = []            + freshness FRESH
GOOD:  transactions capability = DEGRADED (reason: "empty list does NOT imply no
       transactions occurred")     + roster_state CERTIFIED
```

Deterministic coverage in `test/bridge-capabilities.test.ts`:
`week_transactions_unavailable` → `snapshot_integrity: CERTIFIED`,
`transactions: DEGRADED` with that exact reason, `roster_state: HEALTHY`.
`free_agent_pool_not_materialized` → `free_agent_pool: UNAVAILABLE` with
"MUST NOT claim CURRENT/FRESH". Live run: both leagues show `free_agent_pool=UNAVAILABLE`
surfaced, not hidden.

---

## 7. Model-safety comparison

Model freeze honored. `test/bridge-*.test.ts` and `scripts/bridge-shadow-compare.ts`
import no engine code except `buildTeamManagementState` (pure, snapshot-in) which is
**read** to compare inputs, never modified. Live run: `0` divergent team-state builds
across 24 team-seasons. No file under `lib/weekly/`, `lib/trades/`, `lib/draft/`,
`lib/projections/`, `lib/scoring/`, `analysis/`, or any calibration path was opened.

---

## 8. Checkpoint report

```
files changed                 5 new (capabilities, shadow, script, 2 tests) + 1 helper;
                              3 modified (reconcile, published, events)
tests added                   15 (9 capabilities + 6 shadow)  — full suite 1362 pass / 0 fail / 4 skipped
deterministic comparison      Layer A EQUIVALENT, UNEXPLAINED = 0, both leagues
Bloodline Bowl live           Layer B EQUIVALENT, source stable, UNEXPLAINED = 0, CERTIFIED
Devoted to the Game live      Layer B EQUIVALENT, source stable, UNEXPLAINED = 0, CERTIFIED
source-moved / inconclusive   0 runs (both stable this window)
expected differences          0
corrected differences         0 (none needed — old path already correct at week 1)
unexplained differences       0
P0 route findings             no substantive disagreement at week 1; priorities held,
                              re-measure with live scoring in Stage D
capability-health findings    free_agent_pool=UNAVAILABLE correctly surfaced both leagues;
                              no false-healthy; transactions-not-empty trap covered
model/input equivalence       team-state: 24 team-seasons, 0 divergent
full regression               1362 pass / 0 fail / 4 pre-existing skipped; tsc + lint clean (0 errors)
model files changed           none
pointer rows written by shadow 0
```

### Recommended Stage D scope

1. **Additive `freshness` + `capabilities` envelope** on `/api/league/[l]/state`,
   `/api/context/[l]/[m]`, and `/api/health?deep=1`. Derived from the pointer + snapshot;
   **no existing field changes**; routes still read the OLD path. `/api/health?deep=1`
   adds: per-league published-pointer age, `SleeperProvider.healthCheck()`, reconcile
   discrepancy count, capability matrix, model versions, degraded-systems list.
2. **Weekly shadow re-run** wired into the rollout log (still read-only).
3. `REFRESH_SECRET` + `POST /api/refresh` remain Stage E.
4. No route migration, no flag flip in Stage D.

The Stage C gate — **`unexplained_differences = 0` on every stable-source run** — is met.
No genuine unexplained semantic difference was found, so we proceed to Stage D scoping
rather than stopping to diagnose.
