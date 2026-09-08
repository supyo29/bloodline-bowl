# Bridge Real-Time State — Production Readiness / Deployed-Verification Report

Generated: 2026-09-08 (local). Supersedes the earlier `379f062` revision of this file.
Branch `bridge-realtime-state-phase-f` (`fd376a8 → 05fabd6`) **merged to `main`** as
merge commit `8378255` (PR #17) and **deployed to production** with
`BRIDGE_PUBLISHED_SNAPSHOT` OFF.

Scope of this phase: push the completed bridge work, merge it safely, deploy it to
production with the flag OFF, verify deployed code identity, and exercise / precisely
document the four remaining operator gates. A local test pass is **not** accepted as
evidence for a deployed/runtime gate.

---

## Executive verdict

### `CONDITIONAL — PRODUCTION FLAG FLIP BLOCKED`

The Stage A–F remodel and the Sporty's Alumni Bridge profile are now **merged and live
in production behind an OFF flag**. Deployed code identity is verified on both the PR
preview and production: the legacy live path is byte-for-byte the serving path, and the
new machinery (refresh route, deep health, freshness envelope, published-pointer store,
Sporty's manager-neutral profile) is present and inert.

The flag **cannot** be enabled yet. Two of the four hard gates require an operator to
set `REFRESH_SECRET` on a deployment (I cannot set Vercel env vars); one requires a real
NFL scoring window; one requires the Sporty's Alumni draft (2026-09-08 22:00 UTC). None
of these can be closed from this session.

---

## Deployment state

| item | value |
| --- | --- |
| `origin/main` HEAD | `8378255` (merge commit, PR #17) — parents `6007d5f` + `05fabd6` |
| production URL | `https://bloodline-bowl-sleeper-bridge.vercel.app` |
| production deploy | auto-deployed from `origin/main` after merge; code identity verified below |
| PR preview | `bloodline-bowl-sleeper-bridge-3s1tgbcpp-…` @ `05fabd6` (Vercel check PASS) |
| `BRIDGE_PUBLISHED_SNAPSHOT` (prod) | **OFF** (`feature_flags.BRIDGE_PUBLISHED_SNAPSHOT: "OFF"`, all waves false) |
| `REFRESH_SECRET` (prod) | **not set** — `POST /api/refresh` → `401 endpoint_disabled` (fail-closed) |
| `REFRESH_SECRET` (preview) | **not set** — same |
| Supabase env (prod) | **set** — deep health `persistence.{history_stores, published_pointer_store, publication_audit_store} = READY` |
| Supabase env (preview) | **not set** — deep health persistence `PERSISTENCE_NOT_CONFIGURED` |
| `bridge_published_snapshot` rows (prod DB) | **0** (baseline; first writer will be the daily publish cron) |
| `bridge_publication_audit` rows (prod DB) | **0** (baseline) |
| `/api/cron/publish` schedule | `0 13 * * *` (daily — Vercel Hobby plan constraint, see "Code changes") |
| `/api/cron/capture` schedule | `0 12 * * *` (unchanged) |

### Rebase note (branch history)

The branch as originally built contained one unrelated commit — `62fc1c2`
(`docs/TEAM_MANAGEMENT_PHASE_3.md`, a 423-line audit doc for a different workstream).
Per "do not merge unrelated local changes" it was excluded via
`git rebase --onto origin/main 62fc1c2 …`. The one rebase conflict
(`lib/leagues/registry.ts`, both sides adding the `sportys-alumni` entry) was resolved
by keeping the entry already on `origin/main` (`6007d5f`) — functionally identical.
`62fc1c2` is preserved on branch `team-management-phase3-football-intelligence`.
Pre-rebase backup: branch `backup/phase-f-pre-rebase-f9c73dd`.

The 14 bridge commits (A–F, Sporty's registry, Stage F addendum, DraftPoller, Sporty's
profile, shadow-harness fix, prior readiness report) plus the cron fix (`05fabd6`) are
all present under merge commit `8378255`.

---

## Code identity checks

`web_fetch_vercel_url` / share-cookie fetch (preview) and direct fetch (production).

| probe | production (`8378255`) | preview (`05fabd6`) | expected | verdict |
| --- | --- | --- | --- | --- |
| `GET /api/refresh` | **405** `method_not_allowed` | **405** | 405 (route exists, GET disallowed) | ✅ |
| `POST /api/refresh` (no auth) | **401** `endpoint_disabled` | **401** | 401 (fail-closed, secret unset) | ✅ |
| `POST /api/refresh` (bad bearer) | **401** `endpoint_disabled` | **401** | 401, secret value never echoed | ✅ |
| `GET /api/health?deep=1` | **200** `deep:true`, `feature_flags` block, `waves_enabled` all false, `draft_live_independent:true`, `persistence` triad `READY`, `leagues[]` with `response_state_lineage` + `freshness` | **200** same shape, `persistence` triad `PERSISTENCE_NOT_CONFIGURED` | deep fields present | ✅ |
| `GET /api/league/bloodline-bowl/state` | **200**, `freshness` envelope present: `state_source:"LEGACY_LIVE_PATH"`, `fallback.occurred:false`, `published_snapshot.present:false`, `freshness.status:"UNKNOWN"` / `degraded_reason:"NO_PUBLISHED_SNAPSHOT"`, `integrity.snapshot_integrity:"CERTIFIED"`, `capabilities` (free_agent_pool `UNAVAILABLE`, history_persistence `DEGRADED` on preview / `HEALTHY`-capable on prod) | **200** same | additive `freshness`, legacy serving path | ✅ |
| `GET /api/bridge/board?league=sportys-alumni` | **200**, `manager_neutral:true`, `manager_key:null`, `draft_slot:null`, `draft_slot_source:"unconfirmed"`, `draft_feed.status:"pre_draft"`, 14 slots | **200** same | 200 (was **400** pre-merge), no default manager | ✅ |
| `GET /api/bridge/board?league=sportys-alumni&slot=1` | — | **200**, `draft_slot:1`, `draft_slot_source:"user_override"`, still `manager_neutral:true` / `manager_key:null` | seat resolves without inventing an owner | ✅ |
| `GET /api/bridge/board?league=bloodline-bowl` | **200**, `manager_key:"supyo29"`, `draft_slot:7` (`sleeper_draft_order`) | **200** same | unchanged | ✅ |
| `GET /api/bridge/board?league=devoted-to-the-game` | **200**, `manager_key:"darthmarker"`, `draft_slot:4` | **200** same | unchanged | ✅ |

No `404` on any probe → the correct build is deployed on both targets. Production and
preview differ only in env configuration (Supabase set on prod, not preview; secret
unset on both), never in code behavior.

---

## Gate 1 — Preview / deployed publication

### `BLOCKED — operator action required` (not run)

`POST /api/refresh` is deployed and fail-closed: with `REFRESH_SECRET` unset it returns
`401 endpoint_disabled` on **both** preview and production. An authenticated publish
cannot be triggered from this session — I cannot set Vercel environment variables, and
the `CRON_SECRET`-gated `/api/cron/publish` path is likewise not callable by hand.

**What is proven:** route deployed, method gating (405), auth gating (401, value never
echoed), deep-health wiring, published-pointer store `READY` on production, 0 baseline
rows. Storage-layer atomic-advance proof on the production DB (Stage E §5, transaction
rolled back): 8 writers/seq0 → 1 advanced / 7 raced; guarded stale write → 0 rows.
21 orchestrator tests (`test/bridge-refresh.test.ts`).

**What is not proven:** a real end-to-end deployed publish writing a pointer + audit row.

**Two paths to close Gate 1:**

1. **Operator sets `REFRESH_SECRET`** on the preview (or production) deployment, then
   runs the runbook below.
2. **Wait for the daily `/api/cron/publish` run** (13:00 UTC) on production — it uses
   Vercel's auto-injected `CRON_SECRET` and Supabase is configured, so it will attempt
   a real publish. Afterward verify:
   ```sql
   select league_slug, season, published_seq, league_snapshot_id, content_hash
     from bridge_published_snapshot;
   select league_slug, outcome, ok, integrity, pointer_advanced, error_category, attempted_at
     from bridge_publication_audit order by attempted_at desc;
   ```
   Expect: `bloodline-bowl` + `devoted-to-the-game` → `outcome ∈ {published, unchanged}`,
   `integrity=CERTIFIED`, `pointer_advanced=true` on the first run; `sportys-alumni` →
   `outcome="skipped"` (pre_draft) with no pointer row. Flag stays OFF, so no read path
   is affected either way.

**Operator runbook (path 1, on a deployment with `REFRESH_SECRET` set, flag still OFF):**
```
GET  <url>/api/refresh                                   → 405
POST <url>/api/refresh?league=bloodline-bowl  (no auth)  → 401
POST <url>/api/refresh?scope=all  -H "Authorization: Bearer $REFRESH_SECRET"
     → 200; per league outcome ∈ {published, unchanged}, integrity CERTIFIED,
       snapshot_id present, pointer_advanced true (first run)
POST <url>/api/refresh?league=sportys-alumni  -H "Authorization: Bearer $REFRESH_SECRET"
     → 200, outcome "skipped" (pre_draft)
POST <url>/api/refresh?league=no-such-league  -H "Authorization: Bearer $REFRESH_SECRET"
     → 404, no DB write
GET  <url>/api/health?deep=1
     → per league: freshness.status ≠ "UNKNOWN" after a publish; no secret in the body
```
Record: deployment id, commit SHA, timestamps, HTTP statuses, `snapshot_id` /
`published_seq` per league, and one `bridge_publication_audit` row per attempt.

---

## Gate 2 — Deployed concurrency

### `BLOCKED — operator action required` (not run)

Same blocker as Gate 1 — no callable authenticated publish endpoint from this session.

**What is proven:** deterministic concurrency (`test/bridge-refresh.test.ts` —
`Promise.all` of two publishes → `["published","raced"]`, seq monotonic) + the
production-DB SQL race proof (Stage E §5). Neither exercises the deployed
HTTP/serverless path.

**Operator runbook (on a deployment with `REFRESH_SECRET`, flag OFF):**
- **A. Same league:** 5–10 near-simultaneous authorized `POST /api/refresh?league=bloodline-bowl`.
  Expect each response ∈ {published, unchanged, raced}; `bridge_published_snapshot.published_seq`
  strictly increases, never regresses; at most one *new* content hash in `bridge_league_snapshots`;
  last-known-good readable throughout.
- **B. Cross-league:** concurrent `?league=bloodline-bowl`, `?league=devoted-to-the-game`,
  `?league=sportys-alumni`. Verify per-league pointer rows carry the correct `league_slug` /
  `snapshot_id` / `content_hash` / `schema_version`; no manager / scoring / roster bleed
  (compare each pointer's snapshot `scoring_fingerprint` + `roster_fingerprint` to that
  league's known values).
- **C. Failure preservation:** the repo has no safe supported failure toggle — do not
  invent one. Skip and note.

Record request start/end timestamps per call.

---

## Gate 3 — Active-scoring-window shadow

### `PENDING — real scoring window required` (deployed code ready; window unavailable)

The published/read paths are now deployed, so blocker (1) from the prior report is
cleared. Blocker (2) stands: it is 2026-09-08 ~02:45 UTC, NFL Week 1, no games live
(Sunday games completed 09-07; MNF ~09-09 00:15 UTC). A synthetic window does not
satisfy this gate.

### Post-merge shadow run (live Sleeper, no active window — informational, NOT gate closure)

`npm run shadow:compare` @ `05fabd6`, 2026-09-08 ~02:44 UTC:

| league | source moved? | Layer A (deterministic) | Layer B | taxonomy | UNEXPLAINED | reconcile |
| --- | --- | --- | --- | --- | --- | --- |
| `bloodline-bowl` | no | EQUIVALENT (0) | **EQUIVALENT** | all 8 categories 0 | **0** | CERTIFIED |
| `devoted-to-the-game` | no | EQUIVALENT (0) | **EQUIVALENT** | all 8 categories 0 | **0** | CERTIFIED |
| `sportys-alumni` | n/a | **NOT APPLICABLE** — publication skips a `pre_draft` league | — | — | 0 | (skipped) |

P0 direct-route surfaces: **0 timing / 0 semantic** for both scored leagues. Team-state
model-input equivalence: 12 teams each, **0 divergent**. Pointer rows written by the
run: **0**. Model files changed: none. Aggregate gate lines: both PASS.

**This confirms determinism holds post-merge but does NOT close the gate** — the gate
requires an active scoring window with live state changing.

**Operator runbook (during a real Sun/Mon/Thu game window):** run `npm run shadow:compare`
repeatedly across the window while the publish cron advances pointers as scores move.
Per league record: source-start id, source-end id, source-moved verdict, deterministic
result, taxonomy counts, `UNEXPLAINED`, reconcile status. Required: `UNEXPLAINED = 0` on
every stable-source run; `SOURCE_MOVED_DURING_RUN` runs are inconclusive (re-run), not
"equivalent". Do not adjust taxonomy thresholds.

---

## Gate 4 — Live Sporty's Alumni draft smoke

### `PENDING — draft starts 2026-09-08T22:00:00Z` (not observable in this session)

The Sporty's Bridge profile and the `/bridge` seat-picker are now **deployed**
(verified above: board 200, `manager_neutral:true`, 14 slots, `?slot=1` → `draft_slot:1`
`user_override`). The generic Draft-Live API path is also live and was independently
verified.

### Pre-draft state — verified against **production** (`8378255`), 2026-09-08 ~02:4x UTC

| check | result |
| --- | --- |
| `GET /api/bridge/board?league=sportys-alumni` | 200, `platform_league_id=1389404340015370240`, `platform_draft_id=1389404340032118784`, `draft_feed.status=pre_draft`, 14 slots, `manager_neutral=true` ✅ |
| `GET /api/bridge/board?league=sportys-alumni&slot=1` | 200, `draft_slot=1`, `draft_slot_source=user_override`, `manager_key=null` (no fabricated owner) ✅ |
| cross-league isolation | Bloodline / Devoted / Sporty's each resolve to their own `league_id` + `draft_id` (all distinct; Bloodline & Devoted `complete`, Sporty's `pre_draft`) ✅ |
| Bloodline & Devoted boards | unchanged — `manager_key` `supyo29` / `darthmarker`, slots 7 / 4 ✅ |

### DraftPoller cadence

**Not measured at runtime** — the draft is in the future. `DRAFT_LIVE_POLL_MS = 2000`;
13 fake-timer tests (`test/bridge-draft-poller.test.ts`) prove: pre_draft = 7 s,
drafting/paused = 2 s, `pre_draft → drafting` auto-activates, `drafting → complete`
stops, no pileups, transient-error backoff + recovery, visibility pause/resume. The
board route returns `Cache-Control: no-store` when `draft_feed.status ∈ {drafting,
paused}`.

### Operator runbook to close Gate 4 (during the real draft)

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
never inferred from Bloodline/Devoted/local identity. Recommendation smoke (narrow):
after several picks the endpoint stays `READY`, `model` stays `ri-snake-decision-2026.2`,
drafted players excluded, context reflects the selected seat, no other-league context.
Completion: if observed, `drafting → complete` stops the poller; if not observed, mark
**unobserved** (not a fabricated pass).

---

## Cross-league isolation

Production (`8378255`): **clean** — each league's `league_id` / `draft_id` distinct;
Sporty's recommendations carry `league_slug=sportys-alumni` and no other-league string;
Sporty's board `manager_neutral:true` with no default seat. Bloodline & Devoted boards
resolve to their own managers/slots, unchanged. The shadow harness compares `league_id`,
`draft_id`, `scoring_fingerprint`, `roster_fingerprint`, manager mapping, draft feed,
current pick, and published-snapshot identity across all three leagues on every run —
**0 contamination** on the post-merge run. `findBridgeProfile` never falls back to
another league; a board whose returned `league_key` ≠ requested is rejected client-side.

---

## Tests

| suite | result |
| --- | --- |
| targeted deterministic (`test/draft-sportys-alumni.test.ts`) | **17 pass / 0 fail** |
| full non-live (`test/*.test.ts` minus `*-live`) | **1272 pass / 0 fail / 0 skipped** |
| live bridge (`bridge-live` + `bridge-sportys-profile-live`) | **19 pass / 0 fail / 0 skipped** |
| shadow compare (`npm run shadow:compare`, post-merge, live Sleeper) | `UNEXPLAINED = 0` both layers; 0 P0 semantic; 0 divergent teams; model files unchanged |
| TypeScript (`tsc --noEmit`) | **clean** |
| lint (`npm run lint`) | **0 errors** (pre-existing warnings only) |
| build (`npm run build`) | **compiles** |
| deployed code identity (preview `05fabd6` + production `8378255`) | **all probes pass** (table above) |

No skips or failures hidden. `*-live.test.ts` files remain network-flaky under parallel
load (pre-existing; reproduced on a clean pre-branch checkout) — the deterministic
non-live suite is the gating signal.

---

## Code changes during this phase

| commit | file(s) | change | model / semantics touched? |
| --- | --- | --- | --- |
| (rebase) | `lib/leagues/registry.ts` | conflict resolution: keep the `sportys-alumni` entry already on `origin/main` (`6007d5f`), drop the branch's functionally-identical duplicate | **no** |
| `05fabd6` | `vercel.json` | **deployment/config defect fix.** PR #17's Vercel build failed (`vercel.link/3Fpeeb1` → cron usage-and-pricing). Root cause: `/api/cron/publish` at `*/5 * * * *` — the Vercel **Hobby** plan (confirmed `team_LetK8hiDkOnuySZBJL8Nst7U` `plan=hobby`) rejects any sub-daily cron at build time. Smallest fix: `/api/cron/publish` → `0 13 * * *` (daily, 13:00 UTC, 1 h after the capture cron so they never overlap). | **no** — not code, not a route, not auth, not the pointer, not the flag, not the DraftPoller. Publish *cadence* is reduced; documented below. |
| `8378255` | (merge commit) | PR #17 merged to `main` with a merge commit preserving the staged A–F history | n/a |

**Freshness implication of the cron change (documented, not a blocker):** under NORMAL
thresholds (`ACCEPTABLE ≤ 600 s`) a once-daily automated publish leaves the published
pointer STALE for most of each day. This is **inert while `BRIDGE_PUBLISHED_SNAPSHOT` is
OFF** — no read path serves the pointer — and the operator `POST /api/refresh` path
remains the on-demand advance. A sub-daily automated cadence needs a Vercel plan upgrade
and is a **precondition for flipping the flag on**, not for this deploy. If the flag is
ever enabled on the Hobby plan without an upgrade, `readLeagueState`'s `TOO_STALE`
fallback correctly routes every eligible read back to the legacy live path between the
daily cron run and the next operator refresh — degraded-safe, never wrong.

**No change to** `ri-snake-decision-2026.2` · projection / trade / waiver / matchup
models · canonical data model or schema · published-snapshot schema · pointer semantics
· feature-flag semantics · league-profile architecture · manager-neutral architecture ·
DraftPoller constants or behavior · Bloodline Bowl behavior · Devoted to the Game
behavior · Sporty's ranking logic.

---

## Remaining blockers

| # | gate | blocker | who can clear it |
| --- | --- | --- | --- |
| 1 | Gate 1 — deployed publication | `REFRESH_SECRET` not set on any deployment (endpoint fail-closed at 401) | operator sets the env var, **or** wait for the 13:00 UTC publish cron + verify the DB |
| 2 | Gate 2 — deployed concurrency | same as #1 | same as #1 |
| 3 | Gate 3 — active-scoring-window shadow | no live NFL scoring window right now | real Sun/Mon/Thu game window + operator runs `shadow:compare` |
| 4 | Gate 4 — live Sporty's Alumni draft smoke | draft starts `2026-09-08T22:00:00Z` | operator observes the real draft |

`Remaining production blockers: 4` (all four hard gates; the deploy prerequisite is now
satisfied).

No P0 contamination found. No unresolved defect. Production is on the intended SHA
(`8378255`).

---

## Final release recommendation

**Do not flip `BRIDGE_PUBLISHED_SNAPSHOT` in production.** The code is merged, deployed,
and verified inert (flag OFF, legacy live path serving, all code-identity probes pass on
both preview and production, 0 model files changed, shadow `UNEXPLAINED = 0`). But the
flag-flip criteria require **all four** deployed gates to pass on the deployment first,
and none can be closed from this session.

Order of remaining work:

1. Operator sets `REFRESH_SECRET` on preview (or production) — flag stays OFF.
2. Gate 1 on that deployment (runbook above). Alternatively: let the 13:00 UTC publish
   cron run on production and verify `bridge_published_snapshot` + `bridge_publication_audit`.
3. Gate 2 on that deployment (concurrency runbook).
4. Gate 3 during the next real NFL scoring window — `shadow:compare`, `UNEXPLAINED = 0`.
5. Gate 4 during the Sporty's Alumni draft (2026-09-08 22:00 UTC).
6. Only after 1–5 are all green, **and** the publish cadence is fast enough for the
   NORMAL freshness ceiling (Vercel plan upgrade, or an accepted narrower serving
   policy): flip `BRIDGE_PUBLISHED_SNAPSHOT` wave-by-wave (`wave1` → validate → `wave2`
   → `wave3`), re-running `shadow:compare` after each and requiring `UNEXPLAINED = 0`.
   Rollback at any point = unset the env var (no data rollback).

### May `BRIDGE_PUBLISHED_SNAPSHOT` be enabled in production? **NO.**

Not until Gates 1–4 are closed on the deployment and the publish cadence meets the
freshness ceiling. Enabling it today is unsafe only in that it is unverified — the
fallback path would still protect every read — but "unverified" is disqualifying under
the stated criteria.
