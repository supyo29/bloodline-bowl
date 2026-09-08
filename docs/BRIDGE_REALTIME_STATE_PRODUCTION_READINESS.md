# Bridge Real-Time State — Production Readiness / Deployed-Verification Report

Generated: 2026-09-08 (local). Branch: `bridge-realtime-state-phase-f` @ `379f062`.
Scope: close or precisely document the four remaining operator gates. Evidence-driven.
A local test pass is **not** accepted as evidence for a deployed/runtime gate.

---

## Executive verdict

### `CONDITIONAL — PRODUCTION FLAG FLIP BLOCKED`

**Root blocker (upstream of all four gates): none of the Stage A–F work — nor the
Sporty's Alumni Bridge profile — is deployed, or even pushed to a remote branch.**

Verified against production `https://bloodline-bowl-sleeper-bridge.vercel.app`
(deploys from `origin/main`):

| production probe | result | meaning |
| --- | --- | --- |
| `GET /api/refresh` | **404** | Stage E refresh route not deployed |
| `POST /api/refresh` (no auth) | **404** | " |
| `GET /api/health?deep=1` | `deep: undefined`, no `feature_flags`, no `leagues[]` | Stage D deep health not deployed |
| `GET /api/league/bloodline-bowl/state` | no `freshness` key | Stage D envelope not deployed |
| `GET /api/bridge/board?league=sportys-alumni` | **400** ("must resolve to a Bridge profile") | Sporty's Bridge profile not deployed |
| `origin/main` HEAD | `6007d5f "Add Sporty's Alumni Sleeper league"` (parent `c6edde6`) | production commit |
| remote branches | no `bridge-realtime-state-*` | the entire remodel is **local only** |
| `bridge_published_snapshot` rows (prod DB) | **0** | pointer path inert — no deployed writer |
| `bridge_publication_audit` rows (prod DB) | **0** | " |

The production `BRIDGE_PUBLISHED_SNAPSHOT` flag cannot be "flipped" because the code
that reads it is not deployed. **Prerequisite for every gate below: push
`bridge-realtime-state-phase-f`, review/merge per the repo's release process, deploy a
preview with `REFRESH_SECRET` + the existing Supabase env, then deploy to production
with the flag OFF.**

What *is* already live and verified in production (from `6007d5f`): the `sportys-alumni`
registry entry and the generic Draft-Live API path — see Gate 4.

---

## Code changes (this phase)

| file | change | model/semantics touched? |
| --- | --- | --- |
| `scripts/bridge-shadow-compare.ts` | records a publication-`skipped` league (pre_draft/drafting) as "NOT APPLICABLE" instead of crashing on the absent `reconcile`. Aggregate gate unaffected. | **no** — pure harness robustness; the skip semantics in `getPublishedLeagueSnapshot` are unchanged |
| `test/draft-sportys-alumni.test.ts` | +1 deterministic test: a `skipped` result carries no `reconcile` | test only |

**No change to** `ri-snake-decision-2026.2` · projection / trade / waiver models ·
canonical data model · published-snapshot schema · pointer semantics · feature-flag
semantics · league-profile architecture · manager-neutral architecture · DraftPoller
behavior · Bloodline Bowl behavior · Devoted to the Game behavior.

Commit: `379f062`.

---

## Gate 1 — Preview publication

### `INCONCLUSIVE` (cannot run — prerequisite not met)

- `/api/refresh` returns **404 on production** — the route does not exist on any
  deployment. There is no preview deployment of `bridge-realtime-state-phase-f`
  (branch not pushed; Vercel cannot build it).
- I have no Vercel deploy access and do not push/merge without an explicit request.

**Local evidence only** (not accepted as gate closure): `POST /api/refresh` unit +
route behavior — `GET → 405`, no secret → `401 endpoint_disabled`, wrong secret → `401`
(value never echoed), unknown league → `404` pre-write, authenticated (no local
Supabase) → `503 / PERSISTENCE_UNAVAILABLE`, LKG preserved. 21 orchestrator tests
(`test/bridge-refresh.test.ts`). Storage-layer atomic-advance proof on the **production
DB** (Stage E §5, transaction rolled back): 8 writers/seq0 → 1 advanced / 7 raced;
guarded stale write → 0 rows.

**Operator runbook to close Gate 1** (on the preview deployment, `BRIDGE_PUBLISHED_SNAPSHOT` unset):
```
GET  <preview>/api/refresh                      → expect 405
POST <preview>/api/refresh?league=bloodline-bowl (no auth) → expect 401
POST <preview>/api/refresh?scope=all   -H "Authorization: Bearer $REFRESH_SECRET"
     → expect 200; per league: outcome ∈ {published, unchanged},
       integrity CERTIFIED, snapshot_id present, pointer_advanced true (first run)
POST <preview>/api/refresh?league=sportys-alumni -H "Authorization: Bearer $REFRESH_SECRET"
     → expect 200, outcome "skipped" (pre_draft) OR "published" if it has gone in_season
POST <preview>/api/refresh?league=no-such-league -H "Authorization: Bearer $REFRESH_SECRET"
     → expect 404, no DB write
GET  <preview>/api/health?deep=1
     → per league: publication_generation set, last_successful_refresh_at set,
       freshness.status ≠ "UNKNOWN"; no secret anywhere in the body
```
Record: deployment id, commit SHA, timestamps, HTTP statuses, `snapshot_id` /
`published_seq` per league. Confirm `bridge_publication_audit` gained one row per attempt.

---

## Gate 2 — Deployed concurrency

### `INCONCLUSIVE` (cannot run — prerequisite not met)

Same blocker: no deployed `/api/refresh`.

**Evidence that exists:** deterministic concurrency (`test/bridge-refresh.test.ts` —
`Promise.all` of two publishes → outcomes `["published","raced"]`, seq monotonic) +
the production-DB SQL race proof (Stage E §5). Neither exercises the deployed HTTP /
serverless path, which is what this gate requires.

**Operator runbook to close Gate 2** (on the preview deployment):
- **A. Same league:** fire 5–10 near-simultaneous authorized `POST /api/refresh?league=bloodline-bowl`. Expect each response ∈ {published, unchanged, raced}; `bridge_published_snapshot.published_seq` strictly increases and never regresses; `bridge_league_snapshots` gains at most one *new* content hash; last-known-good readable throughout.
- **B. Cross-league:** concurrent `?league=bloodline-bowl` and `?league=sportys-alumni` (and `devoted-to-the-game`). Verify per-league pointer rows carry the correct `league_slug` / `snapshot_id` / `content_hash` / `schema_version`; no manager/profile/scoring bleed (compare each pointer's snapshot's `league.provenance.provider_id` + `scoring_fingerprint` + `roster_fingerprint` to that league's known values).
- **C. Failure preservation:** only if the repo has a safe supported failure toggle — it does not; do not invent one. Skip and note.

Record request start/end timestamps per call.

---

## Gate 3 — Active-scoring-window shadow

### `INCONCLUSIVE` — two independent blockers

1. **Code not deployed** — the published/read path being compared is local only.
2. **No active NFL scoring window** — both real leagues are at week 1 with no completed
   games; `bridge_league_snapshots` latest capture is 2026-09-07. Synthetic activity
   does not satisfy this gate.

### Local run (live Sleeper, preseason — informational, NOT gate closure)

`npm run shadow:compare` @ `379f062`, 2026-09-08 02:10 UTC:

| league | source start id | source end id | source moved? | Layer A (deterministic) | Layer B | taxonomy | UNEXPLAINED | reconcile |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `bloodline-bowl` | `snap:…:w1:1af3658949f1d670` | `…1af3658949f1d670` | **no** | EQUIVALENT (0) | **EQUIVALENT** | all categories 0 | **0** | CERTIFIED |
| `devoted-to-the-game` | `snap:…:w1:22479a5b6e50687c` | `…22479a5b6e50687c` | **no** | EQUIVALENT (0) | **EQUIVALENT** | all categories 0 | **0** | CERTIFIED |
| `sportys-alumni` | — | — | n/a | **NOT APPLICABLE** — publication path skips a `pre_draft` league | — | — | 0 | (skipped) |

P0 direct-route surfaces (canonical vs raw rosters/users/matchups/transactions):
**0 timing / 0 semantic** for both scored leagues. Team-state model-input equivalence:
12 teams each, **0 divergent**. Pointer rows written by the run: **0**. Model files
changed: none.

**This clears the "stable source ⇒ `UNEXPLAINED = 0`" property but NOT the gate** — the
gate explicitly requires an *active scoring window with live state changing*.

**Operator runbook to close Gate 3** (during a real Sun/Mon/Thu game window, code deployed):
run `npm run shadow:compare` (or trigger the equivalent on the deployment) repeatedly
across the window; let the publish cron advance pointers as scores move. For each
league record: source-start id, source-end id, source-moved verdict, deterministic
result, taxonomy counts, `UNEXPLAINED`, reconcile status. Required: `UNEXPLAINED = 0`
on every stable-source run; `SOURCE_MOVED_DURING_RUN` runs classified as inconclusive
(not "equivalent"), re-run. Do not adjust taxonomy thresholds.

---

## Gate 4 — Live Sporty's Alumni draft smoke

### `PENDING` — draft starts `2026-09-08T22:00:00Z` (not observable in this session)

The `/bridge` UI seat-picker path is **not deployed** (Sporty's Bridge profile is on the
local branch). The **generic Draft-Live API path IS deployed** (`6007d5f`) and was
verified against production.

### Pre-draft state — verified against **production** (deployed `6007d5f`), 2026-09-08 02:xx UTC

| check | result |
| --- | --- |
| `GET /api/health?draft=1&league=sportys-alumni` | `league_id=1389404340015370240`, `active_draft_id=1389404340032118784`, `draft_status=pre_draft`, `draft_type=snake` ✅ |
| `GET /api/leagues/sportys-alumni/draft` | HTTP 200, `status=pre_draft`, `type=snake`, `teams=14`, `available=300` ✅ |
| `GET /api/leagues/sportys-alumni/managers/mallermb/recommendations` | HTTP 200, `model=ri-snake-decision-2026.2`, `snake_engine_status=READY`, `league_slug=sportys-alumni`, `error=none` ✅ |
| `GET /api/leagues/sportys-alumni/managers/rspata2/recommendations` | HTTP 200, same ✅ |
| cross-league isolation | Bloodline / Devoted / Sporty's each resolve to their own `league_id` + `draft_id` (all distinct; Bloodline & Devoted `complete`, Sporty's `pre_draft`) ✅ |
| contamination scan | Sporty's recommendation payload contains **no** `bloodline` / `devoted` / `darthmarker` / other-league-id string ✅ |

### Pre-draft `/bridge` UI seat-picker — verified **locally** (dev server, branch code) — NOT deployed

`/bridge` lists all 3 leagues · Sporty's shows the "no default manager — pick your seat"
banner + a 14-seat `<select>` (`1. mallermb … 14. TylerShreve`, matching Sleeper's
`slot_to_roster_id` + `draft_order`) · no seat → `manager_neutral: true`,
`manager_key: null`, `draft_slot_source: "unconfirmed"`, no `is_me` slot ·
`?slot=1` → real manager `mallermb` (`1265477633718624256`) · full-PPR own board order
(Bijan/Gibbs/Chase, not Bloodline's half-PPR order) · distinct scoring hash.
9 live tests (`test/bridge-sportys-profile-live.test.ts`) green.

### DraftPoller cadence

**Not measured at runtime** — no deployed draft to observe, and the draft is in the
future. The constant is `DRAFT_LIVE_POLL_MS = 2000`; 13 fake-timer tests
(`test/bridge-draft-poller.test.ts`) prove: pre_draft = 7 s, drafting/paused = 2 s,
`pre_draft → drafting` auto-activates, `drafting → complete` stops, no pileups,
transient-error backoff + recovery, visibility pause/resume. The board route returns
`Cache-Control: no-store` when `draft_feed.status ∈ {drafting, paused}` (verified for
the `pre_draft` case: `s-maxage=5`).

### Operator runbook to close Gate 4 (during the real draft, `/bridge` deployed)

Choose one real seat (record it). Before start: confirm `pre_draft`, manager-neutral
intact, 14 seats, `?slot=N` resolves the right slot + username + user id, feed matches
Sleeper. At start: record last `pre_draft` and first `drafting` timestamps; confirm the
board flips without a manual reload. Cadence: capture ≥ 8–10 consecutive board requests;
report the timestamp sequence, per-interval delta, median / min / max, any long
interval, and whether tab-visibility/network explains it — expect a ~2 s cluster, no
pileups, no unintended 7 s loop while `drafting`. Picks: for ≥ 5 consecutive real picks
record Sleeper pick #, player, slot, Sleeper timestamp, first bridge observation,
propagation delay; verify the drafted player leaves the pool + feed shows the pick +
recommendations stop offering them + snake order advances + seat stays bound. Seat: an
`is_me`/ownership marker appears only for the selected real seat, never when unselected,
never inferred from Bloodline/Devoted/local identity; changing seats changes to the
real corresponding manager. Recommendation smoke (narrow, not a model audit): after
several picks the endpoint stays `READY`, `model` stays `ri-snake-decision-2026.2`,
drafted players excluded, context reflects the selected seat, no other-league context.
Completion: if observed, `drafting → complete` stops the poller; if not observed,
mark **unobserved** (not a fabricated pass).

---

## Cross-league isolation — findings so far

Production (`6007d5f`): **clean** — each league's `league_id` / `draft_id` distinct;
Sporty's recommendations carry `league_slug=sportys-alumni` and no other-league string.
Local branch: the shadow harness compares `league_id`, `draft_id`, `scoring_fingerprint`,
`roster_fingerprint`, manager mapping, draft feed, current pick, and the published
snapshot identity across all three leagues on every run — **0 contamination** across the
2026-09-08 run. The Bridge board's own isolation guards (`findBridgeProfile` never
falls back to another league; a board whose returned `league_key` ≠ requested is
rejected client-side) are unchanged and tested.

---

## Tests

| suite | result |
| --- | --- |
| targeted deterministic (`test/draft-sportys-alumni.test.ts`) | **17 pass / 0 fail** |
| full non-live (`test/*.test.ts` minus `*-live`) | **1272 pass / 0 fail / 0 skipped** |
| live bridge (`bridge-live` + `bridge-sportys-profile-live`) | **19 pass / 0 fail / 0 skipped** |
| TypeScript (`tsc --noEmit`) | **clean** |
| lint (`npm run lint`) | **0 errors** (29 pre-existing warnings) |
| build (`npm run build`) | **compiles successfully** |
| deployed / preview | **none run** — no deployment of this branch exists |

No skips or failures hidden.

---

## Remaining blockers

1. **`bridge-realtime-state-phase-f` is not pushed or deployed.** Prerequisite for Gates 1–4. Push → review/merge per the repo's process → deploy preview with `REFRESH_SECRET` + Supabase env → deploy production with `BRIDGE_PUBLISHED_SNAPSHOT` OFF.
2. **Gate 1 — preview publication:** not run (needs the deployment).
3. **Gate 2 — deployed concurrency:** not run (needs the deployment).
4. **Gate 3 — active-scoring-window shadow:** not run (needs the deployment **and** a real NFL scoring window; preseason cannot satisfy it).
5. **Gate 4 — live Sporty's Alumni draft smoke:** pending the real draft (`2026-09-08T22:00:00Z`); the `/bridge` seat-picker path also needs to be deployed first.

`Remaining production blockers: 5` (one prerequisite + four gates).

---

## Final release recommendation

**Do not flip `BRIDGE_PUBLISHED_SNAPSHOT` in production.** It has no effect until the
branch is deployed, and even then all four gates must pass on the deployment first. The
code is complete and every local/deterministic check that gates the deployed work is
green (1272 non-live + 19 live, tsc/lint/build clean, 0 model files changed, shadow
`UNEXPLAINED = 0` on stable preseason source). The remaining work is a **deploy +
operator-verification** exercise, in this order:

1. push + merge + deploy preview (flag OFF)
2. Gate 1 on preview
3. Gate 2 on preview
4. deploy production (flag OFF) — cron begins advancing pointers; no read-path change
5. Gate 3 during the next real scoring window
6. Gate 4 during the Sporty's Alumni draft (2026-09-08 22:00 UTC)
7. only after 1–6 are all green: flip `BRIDGE_PUBLISHED_SNAPSHOT` wave-by-wave
   (`wave1` → validate → `wave2` → `wave3`), re-running `shadow:compare` after each,
   requiring `UNEXPLAINED = 0`. Rollback at any point = unset the env var (no data rollback).
