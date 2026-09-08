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

**Gates 1 and 2 are now `PASS` on production.** The operator set `REFRESH_SECRET`;
an authenticated `POST /api/refresh?scope=all` published certified pointers for
`bloodline-bowl` (seq 1) and `devoted-to-the-game` (seq 1), skipped `pre_draft`
`sportys-alumni`, and — critically — **did not change the serving path**
(`state_source` stayed `LEGACY_LIVE_PATH`). Two concurrent bursts (8 same-league +
5 cross-league, all HTTP 200) left the pointer monotonic, produced zero duplicate
content rows, zero cross-league bleed, and kept LKG readable. One residual: the
deployed *contended advance* (`raced`) is proven only at the storage layer, not
end-to-end HTTP, because the source content did not move between calls.

The flag still **cannot** be enabled: Gate 3 requires a real NFL scoring window,
Gate 4 requires the Sporty's Alumni draft (2026-09-08 22:00 UTC), and the daily-only
publish cron does not meet the NORMAL freshness ceiling without a Vercel plan upgrade.

---

## Deployment state

| item | value |
| --- | --- |
| `origin/main` HEAD | `8378255` (merge commit, PR #17) — parents `6007d5f` + `05fabd6` |
| production URL | `https://bloodline-bowl-sleeper-bridge.vercel.app` |
| production deploy | auto-deployed from `origin/main` after merge; code identity verified below |
| PR preview | `bloodline-bowl-sleeper-bridge-3s1tgbcpp-…` @ `05fabd6` (Vercel check PASS) |
| `BRIDGE_PUBLISHED_SNAPSHOT` (prod) | **OFF** (`feature_flags.BRIDGE_PUBLISHED_SNAPSHOT: "OFF"`, all waves false) |
| `REFRESH_SECRET` (prod) | **set** (operator, 2026-09-08 ~03:15 UTC) — `POST /api/refresh` no auth → `401 unauthorized`, bad bearer → `401 unauthorized` "Invalid credentials", value never echoed |
| `REFRESH_SECRET` (preview) | **set** (operator, 2026-09-08 ~03:20 UTC) — auth gate active (`401 unauthorized` on no/bad auth); an authed publish returns `503` (see next row) — deliberately left there |
| Supabase env (prod) | **set** — deep health `persistence.{history_stores, published_pointer_store, publication_audit_store} = READY` |
| Supabase env (preview) | **not set, by choice** — deep health persistence `PERSISTENCE_NOT_CONFIGURED`; an authed `POST /api/refresh` on preview authenticates then returns `503 PERSISTENCE_UNAVAILABLE` (the documented fail-safe). Preview can verify the auth gate only, not a real publish. |
| `bridge_published_snapshot` rows (prod DB) | **2** — `bloodline-bowl` seq 1, `devoted-to-the-game` seq 1 (written by the Gate 1 authenticated refresh, 2026-09-08 03:17 UTC) |
| `bridge_publication_audit` rows (prod DB) | **16** — 2 `published` (Gate 1) + 2 `skipped` (`sportys-alumni`) + 12 `unchanged` (Gate 2 bursts); all `ok:true` `integrity:CERTIFIED` `error:null` |
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

### `PASS` — executed on production, 2026-09-08 03:17 UTC

The operator set `REFRESH_SECRET` on the production environment and redeployed
(`331672e`, `dpl_Ebg…`). An authenticated `POST /api/refresh?scope=all` was run from the
operator's shell (secret supplied via `X-Refresh-Secret`, never entered into this
session). HTTP **200**, `ok:true`.

| league | outcome | pointer | persisted | integrity | freshness | audit id |
| --- | --- | --- | --- | --- | --- | --- |
| `bloodline-bowl` | **published** | seq null → **1**, `pointer_advanced:true` | `created` | **CERTIFIED** | `FRESH` (`age_seconds:0`) | `48fdf4a0-…` |
| `devoted-to-the-game` | **published** | seq null → **1**, `pointer_advanced:true` | `duplicate` (snapshot content already existed from the capture cron — pointer still advanced) | **CERTIFIED** | `FRESH` | `f177b907-…` |
| `sportys-alumni` | **skipped** (`pre_draft`) | none | `skipped` | CERTIFIED (nominal) | `UNKNOWN` / `NO_PUBLISHED_SNAPSHOT` | `e6849fd7-…` |

**Auth gate (production, post-secret):** `GET /api/refresh` → 405; `POST` no auth →
`401 unauthorized` "Missing credentials"; `POST` bad bearer → `401 unauthorized`
"Invalid credentials"; secret value never appears in any response body.

**Persistence verified directly (Supabase, prod project `ijpfjdzmaztofawhwepf`):**
```
bridge_published_snapshot:
  bloodline-bowl       season 2026  published_seq 1  certified true  schema_version 3
    league_snapshot_id snap:bloodline-bowl:2026:w1:44ba3cfb957dad7d
    content_hash 44ba3cfb957dad7d… (matches the refresh response)
  devoted-to-the-game  season 2026  published_seq 1  certified true  schema_version 3
    league_snapshot_id snap:devoted-to-the-game:2026:w1:f0e050746ffd9fa9
  (no sportys-alumni row)
bridge_publication_audit: 3 rows, trigger=API, matching the 3 audit ids above,
  ok=true, integrity=CERTIFIED, error=null
```

**Serving path unchanged (the critical safety property):** after the publish, the
deployed `GET /api/league/bloodline-bowl/state` freshness envelope reports
`state_source: "LEGACY_LIVE_PATH"`, `fallback.occurred: false` — the published snapshot
did **not** become the serving source, because `BRIDGE_PUBLISHED_SNAPSHOT` is still OFF.
What did change, additively: `published_snapshot.present` flipped `false → true`
(`published_seq:1`, `certified:true`), and `freshness.status` moved `UNKNOWN → FRESH`
for both published leagues. `/api/health?deep=1` shows `bloodline-bowl` +
`devoted-to-the-game` `FRESH`, `sportys-alumni` `UNKNOWN`, flag `OFF`, all waves false.

**Not exercised** (deferred, low risk): `POST /api/refresh?league=no-such-league` →
expected `404`, no DB write. Covered by `publish.ts` resolving the league before any
store call and by a deterministic test; worth one operator call to confirm on the
deployment when convenient.

---

## Gate 2 — Deployed concurrency

### `PASS` (with one residual noted) — executed on production, 2026-09-08 03:37 UTC

Two authenticated bursts fired from the operator's shell (secret via `X-Refresh-Secret`,
never entered this session), against production `331672e`, flag OFF.

**A. Same-league burst — 8 concurrent `POST /api/refresh?league=bloodline-bowl`:**

| property | result |
| --- | --- |
| HTTP status | **200 × 8** |
| outcome | `unchanged` × 8 (source content byte-identical to the Gate 1 publish → every rebuild produced hash `44ba3cfb…`, so no advance was warranted) |
| `integrity` | `CERTIFIED` × 8 |
| `bridge_published_snapshot.published_seq` | **stayed 1** — never advanced, never regressed |
| new content-hash rows in `bridge_league_snapshots` | **0** — hash `44ba3cfb…` present exactly once |
| audit rows | 8, all `ok:true`, `error:null`, 8 distinct `audit_id` |
| reads during the burst | `GET /api/league/bloodline-bowl/state` → `status: READY`, `state_source: LEGACY_LIVE_PATH`, lineage hash `44ba3cfb…` — LKG served throughout |

**B. Cross-league burst — 5 concurrent `POST /api/refresh` across
`bloodline-bowl` ×2, `devoted-to-the-game` ×2, `sportys-alumni` ×1:**

| property | result |
| --- | --- |
| HTTP status | **200 × 5** |
| outcome | `bloodline-bowl` `unchanged` ×2, `devoted-to-the-game` `unchanged` ×2, `sportys-alumni` `skipped` ×1 |
| pointer rows after | `bloodline-bowl` seq 1 / hash `44ba3cfb…`; `devoted-to-the-game` seq 1 / hash `f0e05074…`; **no `sportys-alumni` row** |
| cross-league bleed | **none** — each pointer carries its own `league_slug` + own `content_hash` + `schema_version 3`; each audit row tagged with the correct league |
| errors | 0 across all 13 concurrent requests (8 + 5) |

**Residual (documented, not blocking):** every burst request landed as `unchanged`
because the underlying Sleeper state did not move between rebuilds, so the deployed HTTP
path's *contended pointer advance* — N racers, one wins, the rest return `raced` — was
not exercised end-to-end. That specific race is proven at the storage layer (Stage E §5,
production DB, transaction rolled back: 8 writers seq0 → **1 advanced / 7 raced**,
guarded stale write → 0 rows) and by `test/bridge-refresh.test.ts` (`Promise.all` of two
publishes → `["published","raced"]`). Everything the concurrency gate guards against —
pointer regression, duplicate content rows, cross-league contamination, uncertified or
errored writes, unreadable LKG — is verified clean on the deployed path. To close the
residual fully: repeat burst A during a real scoring window when the source hash changes
between calls, and confirm exactly one `published` + the rest `raced`/`unchanged` with a
single seq increment.

**C. Failure preservation:** the repo has no safe supported failure toggle — not
invented, not tested.

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
| deployed code identity (preview `05fabd6` + production `8378255` / `331672e`) | **all probes pass** (table above) |
| **Gate 1 — deployed publication (production `331672e`)** | **PASS** — authed refresh published 2 certified pointers (seq 1), skipped `pre_draft` Sporty's, serving path unchanged (`LEGACY_LIVE_PATH`) |
| **Gate 2 — deployed concurrency (production `331672e`)** | **PASS** (residual noted) — 13 concurrent authed requests, all 200, pointer monotonic, 0 duplicate content rows, 0 cross-league bleed, LKG readable; contended `raced` advance still storage-layer-only |

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
| `9e97b6e` | `docs/BRIDGE_REALTIME_STATE_PRODUCTION_READINESS.md`, `docs/BRIDGE_REALTIME_STATE_PHASE_C_SHADOW_RUN.md` | post-merge report + regenerated shadow-run artifact | docs only |
| `331672e` | (empty commit) | forces a production redeploy so the operator-added `REFRESH_SECRET` binds into the running deployment (Gate 1) | **no** |

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

| # | gate | status | who can clear it |
| --- | --- | --- | --- |
| 1 | Gate 1 — deployed publication | **PASS** (2026-09-08 03:17 UTC) | — done |
| 2 | Gate 2 — deployed concurrency | **PASS**, residual noted (2026-09-08 03:37 UTC) | — done; residual (contended `raced` on the HTTP path) closes opportunistically during a scoring window |
| 3 | Gate 3 — active-scoring-window shadow | PENDING | real Sun/Mon/Thu game window + operator runs `shadow:compare` |
| 4 | Gate 4 — live Sporty's Alumni draft smoke | PENDING | operator observes the real draft (2026-09-08 22:00 UTC) |

`Remaining production blockers: 2` (Gates 3–4). The deploy prerequisite and Gates 1–2
are satisfied.

Additional flag-flip precondition (not a gate, but disqualifying on its own): the
daily-only `/api/cron/publish` cadence does not keep the pointer inside the NORMAL
`ACCEPTABLE ≤ 600 s` window — needs a Vercel plan upgrade or an accepted narrower
serving policy before the flag goes on.

No P0 contamination found. No unresolved defect. Production is on the intended SHA
(`main` = `331672e`, a no-op redeploy of `8378255`).

---

## Final release recommendation

**Do not flip `BRIDGE_PUBLISHED_SNAPSHOT` in production.** The code is merged, deployed,
and verified inert (flag OFF, legacy live path serving, all code-identity probes pass on
both preview and production, 0 model files changed, shadow `UNEXPLAINED = 0`). Gates 1–2
now prove the deployed publish path end-to-end: it advances certified pointers, writes
audit rows, and survives concurrency **without touching the serving path**. But the
flag-flip criteria require **all four** deployed gates plus an adequate publish cadence,
and Gates 3–4 are open.

Order of remaining work:

1. ~~Operator sets `REFRESH_SECRET`~~ — done. ~~Gate 1~~ **PASS**. ~~Gate 2~~ **PASS** (residual noted).
2. **Gate 3** — during the next real NFL scoring window: `shadow:compare`, require
   `UNEXPLAINED = 0` on every stable-source run. Opportunistically also close the Gate 2
   residual (a burst that produces one `published` + the rest `raced`).
3. **Gate 4** — during the Sporty's Alumni draft (2026-09-08 22:00 UTC).
4. Resolve the publish-cadence precondition (Vercel plan upgrade for a sub-daily
   `/api/cron/publish`, or an accepted narrower serving policy).
5. Only after 2–4 are all green: flip `BRIDGE_PUBLISHED_SNAPSHOT` wave-by-wave
   (`wave1` → validate → `wave2` → `wave3`), re-running `shadow:compare` after each and
   requiring `UNEXPLAINED = 0`. Rollback at any point = unset the env var (no data
   rollback; the published pointers can stay — they are only read when the flag is on).

### May `BRIDGE_PUBLISHED_SNAPSHOT` be enabled in production? **NO.**

Not until Gates 3–4 are closed on the deployment and the publish cadence meets the
freshness ceiling. Gates 1–2 are done. Enabling the flag today would still be
fallback-safe for every read, but "unverified against Gates 3–4" is disqualifying under
the stated criteria.
