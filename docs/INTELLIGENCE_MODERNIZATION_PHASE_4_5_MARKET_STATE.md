# Intelligence Modernization Phase 4.5 — Free-Agent Availability & Market-State Hardening

Branch `intelligence-modernization-phase4-5-market-state`, based on `main` @ `15f7b0a`. Checkpoints A–G committed; **not merged, not deployed, migration not applied to production.**
Verdict: **B — CERTIFIED WITH PROVIDER LIMITATION** (§25).

Phase 4.5 is a data/readiness infrastructure phase. It builds ONE canonical league market state — "which players are acquirable by this league, at this point in time, through which mechanism" — and makes Waiver 2.0 consume it. No Waiver 2.0 weight, prior, ranking math, uncertainty model or lifecycle state changed, and Waiver 2.0 remains `SHADOW_ONLY`.

---

## 1. Starting state (recorded before any change)

- Production Waiver 2.0 (`b510813`, `dpl_4oTNuKcUorsEL4ZWT5DCLnyCUTE8`): `NOT_READY` / `FREE_AGENT_POOL_UNAVAILABLE`, 0 recommendations.
- `waiver2_shadow_captures`: 6 rows, all `NOT_ACTIONABLE` / `POOL_READINESS_BLOCKED`; 0 ranked, 0 live.
- Root cause: `SleeperProvider.getWaiverState` reports rostered ownership only and always emits `free_agent_pool_not_materialized`; `buildCanonicalLeagueState` sets `waiver_state: null`; `assessFreeAgentPoolReadiness` therefore reports the `free_agent_pool` capability UNAVAILABLE and every waiver surface fails closed.
- The canonical mapper set `waiver_day: null` and did not map `waiver_clear_days`.

**Design consequence.** The canonical `waiver_state` and the production readiness contract are deliberately **left untouched**. Flipping them would have changed the production waiver section (a parity violation). The market state is a separate substrate that Waiver 2.0 consumes; the production waiver section stays `NOT_READY` (verified byte-identical, §22).

## 2. Provider audit (Checkpoint A, live Sleeper, 2026-09-20, read-only)

| Endpoint | Gives | Availability relevance |
|---|---|---|
| `GET /league/{id}` | `waiver_type`, `waiver_budget`, `waiver_bid_min`, `waiver_day_of_week`, `waiver_clear_days`, `daily_waivers*`, `reserve_slots`, `taxi_slots`, `roster_positions` | Acquisition rules. |
| `GET /league/{id}/rosters` | Per roster `players` (IR and taxi ids included), `reserve`, `taxi`, `starters`, `settings.waiver_position`, `settings.waiver_budget_used` | Authoritative ownership; FAAB used; priority. |
| `GET /players/nfl` | 12,228 entries (`status`, `active`, `team`, `position`, `injury_status`) | Player universe; noisy. |
| `GET /league/{id}/transactions/{week}` | Complete and failed `waiver` / `free_agent` / `trade` / `commissioner` entries with `adds`, `drops`, `settings.waiver_bid`, `status_updated` | Real movement chronology; processed winning bids. |
| Schedule (`/schedule/nfl/regular/{season}`) | Per-game `status` (`pre_game` / `in_game` / `complete`) | Game state. |

**Gaps (nothing below is available from Sleeper):** no free-agent list endpoint; no pending waiver claims; no per-player waiver clear instant; no hidden bids; no provider-side "addable" flag; no published add-lock rule for started games.

## 3. League waiver rules (both real leagues, plus a third registered league)

| | Bloodline Bowl | Devoted | Sporty's Alumni |
|---|---|---|---|
| System | FAAB (`waiver_type` 2), budget 100, min bid 0 | Priority, reverse standings (`waiver_type` 1) | Priority |
| `waiver_clear_days` | 2 | 2 | 0 (no waiver window) |
| `waiver_day_of_week` | 2 | carried as league data | carried |
| Stray `waiver_budget` | n/a | 1000 — **not a currency** | not a currency |

FAAB context is keyed off `waiver_type`, never off the presence of `waiver_budget` (Devoted carries a budget value but uses reverse-standings priority). `priority_rule` (rolling vs reverse standings), `daily_waivers` and `daily_waivers_hour` are exposed as-is; `waiver_clear_days`, not the daily-waiver flags, governs how long a dropped player stays on waivers.

## 4. Canonical market contract (`lib/market-state/contract.ts`)

`PlayerMarketState` carries: league, season, week, as-of, `status`, `ownership` (+ owner team and roster slot), `acquisition.{status, mechanism}`, `waiver_clears_at` (**always null** — never fabricated), `waiver_window` (`dropped_at` + configured `clear_days`, from the transaction feed), `eligible_to_add` + `reason`, `lock`, `caveats`, position/team, `source.{class, freshness}`, canonical id bridge.

`status` ∈ `ROSTERED · AVAILABLE_FREE_AGENT · ON_WAIVERS · WAIVER_CLAIM_PENDING · LOCKED · INELIGIBLE · UNKNOWN_AVAILABILITY · SOURCE_UNAVAILABLE`. `WAIVER_CLAIM_PENDING` and `LOCKED` are vocabulary only: no supported provider can establish either, so the builder never emits them and the integrity validator rejects `WAIVER_CLAIM_PENDING`.

Integrity validators (`integrity.ts`) enforce: AVAILABLE requires verified `UNROSTERED` (never `UNKNOWN`), `eligible_to_add`, `FREE_AGENT/FREE_AGENT_ADD`, no waiver window; ROSTERED is never addable; ON_WAIVERS needs a provable drop window; no fabricated clear time; one entry per player (a duplicate owner surfaces as a blocking `OWNERSHIP_INTEGRITY_VIOLATION`); DEF entities are team entities.

## 5. Player universe (`classify.ts`, versioned `market-eligibility-2026.1`)

Every one of the 12k+ entries gets exactly one outcome with a reason. Poor or injured players are **never** excluded for that reason (IR / PUP / suspended / injury designations are `caveats`).

- `INELIGIBLE`: no fantasy position (`XX`/null), position not startable in this league (expanded from `roster_positions` incl. FLEX/SUPER_FLEX/IDP), no NFL team, retired, **duplicate/stale identity** (name `Duplicate …`).
- `UNKNOWN_AVAILABILITY` (never eligible): practice squad, unrecognized status, empty status, and **any `active === false`** row.
- DEF/ST are `TEAM_DEFENSE` entities keyed by team abbreviation; they never pass through individual-player status logic.
- Live counts (Bloodline Bowl, week 2): 11,342 ineligible (7,723 position not in league, 3,379 no team, 240 no position), 4 unknown, 185 rostered, 691 available, 2 on waivers.

**A defect found by the live certification (Checkpoint G) and fixed:** Sleeper carries rows with `status: "Inactive"` **and** `active: false` — including a placeholder named "Duplicate Player". The first classifier treated `Inactive` as a legitimate IR-style caveat and let 4 such rows into every league's pool. The independent derivation caught it (691 vs 695); the fix is above and covered by tests. `Inactive` with `active: true` remains a legitimate designation.

## 6. Ownership

Rosters are authoritative. IR / taxi / bench all count as owned; empty slots (`"0"`, null, `""`) create no identity; numeric ids are normalized to strings at the provider edge so ownership can never be missed by a type mismatch. Live: 0 duplicate owners across 185 / 199 / 217 rostered players; ROSTERED sets equal the raw roster sets exactly in all three leagues. Roster truth beats history: a player dropped then re-added is ROSTERED.

## 7. Acquisition status

A player is `AVAILABLE_FREE_AGENT` only if **all** hold: rosters verified · rules verified · universe verified · transaction window verified · identity eligible · on no roster in this league · no provable drop inside the league's `waiver_clear_days`.

- `ON_WAIVERS` = a `complete` `free_agent` / `waiver` / `commissioner` drop within `waiver_clear_days` (trades ignored; failed/pending/future/null-timestamp entries ignored). The clear **instant** stays `null`; only the drop time and the window length are reported.
- Empirical validation of the rule (both leagues, 49 completed transactions): **0 of 31** free-agent adds involved a player dropped inside the window; 3 adds of previously dropped players occurred only after the window elapsed.
- **Game lock (§12 of the task).** Lock is reported per player from the schedule (`OPEN` = pre-game or bye, `LOCKED` = in progress/complete, `UNKNOWN`) as a **fact about this week's scoring**, not an add-eligibility verdict. Sleeper publishes no add-lock rule and players are routinely added after their game ends (claims process Wednesday). Treating a started game as "unavailable" would have emptied 651 of 695 candidates on a Sunday evening for no verified reason. This is a stated provider limitation (`GAME_LOCK_ADD_RULE_NOT_PUBLISHED`), and its consequence is enforced where evidence is at stake: a ranked decision whose involved games are not verifiably pre-game is `LIVE_POST_LOCK` / `LIVE_UNVERIFIED`, never pristine, never counted (§15). No kickoff time is ever invented.

## 8. Readiness

`READY | PARTIAL | NOT_READY`, with precise, severity-tagged reason codes (no generic `FREE_AGENT_POOL_UNAVAILABLE` when a precise reason is known):

- **BLOCKING:** `PLAYER_UNIVERSE_UNAVAILABLE`, `ROSTER_STATE_UNAVAILABLE`, `ACQUISITION_RULES_UNKNOWN`, `WAIVER_STATE_UNVERIFIABLE`, `STALE_MARKET_STATE`, `PROVIDER_ERROR`, `OWNERSHIP_INTEGRITY_VIOLATION`.
- **LIMITING:** `IDENTITY_INCOMPLETE` (rostered ids absent from the universe — still owned), `GAME_LOCK_UNVERIFIABLE`, `FAAB_CONTEXT_UNAVAILABLE`.
- **INFO (permanent provider limits, always disclosed):** `PENDING_CLAIMS_NOT_EXPOSED`, `WAIVER_CLEAR_TIME_NOT_EXPOSED`, `GAME_LOCK_ADD_RULE_NOT_PUBLISHED`.

Staleness ceilings: live sources 10 min, the 24h-cached player universe 26 h. Partial readiness is allowed; each consumer states explicitly which limiting codes it tolerates (`consumerActionability` + `ConsumerPolicy`). Waiver 2.0's policy (`lib/waiver2/market-policy.ts`) tolerates lock-unverifiable (the capture layer classifies it `LIVE_UNVERIFIED`), missing FAAB (ranges degrade to UNKNOWN; a real free agent is never hidden) and identity-incomplete; `also_blocking` is empty today and adding a code is a deliberate act.

## 9. Market content identity

Three identities never mix: **request id** (per read), **source snapshot id** (per read), **semantic `market_content_id`**. The content id hashes only ownership (player→team, slot moves excluded), the eligible-universe classification, the waiver-window set, the rules, and the readiness *codes* (not details). It excludes request/snapshot ids, timestamps, injury designations, roster slot moves, FAAB, and game-lock progression (kickoffs must not churn the market identity; `lock_id` is reported separately). FAAB/priority live in a separate `acquisition.context_id`. Verified: byte-identical snapshots for identical inputs; shuffled provider payloads → identical snapshot; content id stable across two live reads with different request ids; changes on ownership change, add/drop, status change, window change, readiness change.

## 10. Materialized free-agent pool (`pool.ts`)

`buildFreeAgentPool(snapshot)` is an explicit deterministic product (`pool_id` = hash of content id + member keys): members (AVAILABLE only, empty when not actionable), `by_position` views over the **same** snapshot, and explicit exclusion accounting (ineligible reasons, on waivers, unknown, rostered). Replacement-level support is availability-only: `replacementAvailability`, `positionalSupply` (available and available-per-team). Valuation stays with Phase 4.

## 11. Manager acquisition context

League-level availability is built once; `managerAcquisitionContext(snapshot, team_id)` adds budget, priority, roster size/limit, open slots and whether an add requires a drop. No per-manager pool exists.

## 12. FAAB / priority state

Exposed separately from availability: system, budget (FAAB leagues only), min bid, per-team `faab_remaining` (= budget − `waiver_budget_used`) and `waiver_position`, priority rule, and **visible processed winning bids** (complete `waiver` transactions with a bid; failed/pending/hidden bids are never listed or inferred). Missing FAAB is a LIMITING code and never changes a player's status.

## 13. History / snapshots (Checkpoint E)

**Decision: store immutable, content-addressed, compact snapshots going forward; never backfill.** A capture preserves the candidates Waiver 2.0 evaluated but not who else was available, who was in a waiver window, who was unknown, or the league rules at that moment — facts a provider cannot reconstruct afterwards.

- Artifact id = hash of the compact snapshot excluding volatile fields; ~30 KB per artifact (the full in-memory snapshot is ~590 KB and is not stored).
- Written only when the market content or FAAB context changes (an unchanged market re-observed is `DUPLICATE_IDENTICAL`), once per artifact per instance, with a per-(league, week) 2-minute throttle; blocked markets are never stored.
- `classifyHistoricalMarket`: own immutable snapshot → `TRUE_AS_OF`; roster+universe archive + chronology → `RECONSTRUCTED` (Sleeper preserves neither); transaction chronology alone → `RETROSPECTIVE_ONLY`; otherwise `UNSAFE`. Only snapshots taken from now on are `TRUE_AS_OF`.
- Table `bridge_market_state_snapshots` (`supabase/migrations/20260920200000_market_state_snapshots.sql`): insert-only (UPDATE/DELETE rejected by trigger), CHECKs (`history_class = 'TRUE_AS_OF'`, readiness `READY|PARTIAL`), RLS on with no policies, privileges revoked from anon/authenticated. **Validated locally** (PGlite): insert accepted; bad class, blocked readiness, update, delete, duplicate all rejected. **Not applied to production.**

## 14. Waiver 2.0 integration (Checkpoint D)

Only the pool/readiness substrate changed (`lib/waiver2/market-pool.ts`, called from the adapter). Candidates = weekly-projected players that the market state says are `AVAILABLE_FREE_AGENT` (intersection: a candidate the market calls on-waivers, or the weekly layer calls rostered, is excluded — the conservative direction). A blocked market yields `UNCERTIFIED_UNROSTERED` and the engine reports `UNCERTIFIED_POOL` with no recommendation.

**Ranking math unchanged — proven:** a market-sourced pool and the legacy certified pool over the same candidates produce byte-identical `actions` and `evaluation_hash`; `params_hash` identical; all 63 pre-existing Waiver 2.0 tests pass unchanged (only the pool fixture gained a market stub). Lifecycle `SHADOW_ONLY`, `mayInfluenceProduction() === false`.

**Previously blocked real-league runs now produce ranked shadow evidence** (all three leagues, 2 managers each, week 2): `availability CERTIFIED`, 12 ranked actions, tier-A/B recommendations, FAAB rungs `[0,0,20,32]`, coverage `pool 691 / evaluated 691 / unmatched 0`, `deployment SHADOW_ONLY`.

## 15. Prospective evidence impact (Checkpoints D–E)

- **Capture record v3** carries the market lineage (`market_content_id`, `pool_id`, `acquisition_context_id`, `history_class`, readiness codes, coverage) alongside the candidate set, roster identity, model version, scoring fingerprint, evidence identities, ranked actions, alternatives, FAAB rungs, pass option and uncertainty. v2 rows remain valid. A v3 live record without market lineage is refused; a blocked record carries readiness codes only.
- **Dedupe defect found and fixed.** The canonical snapshot id **and content hash** change on every read (they fold in provider-sync timestamps); `evaluation_hash` folds in `lineage.snapshot`. Phase 4 already excluded the snapshot id from *blocked* identity, but not from *ranked* identity — which had never been exercised because no ranked record existed. With the pool now certified, every request would have written a new ranked row. Ranked identity now excludes snapshot id/hash and `evaluation_hash` and is decided by market content id, roster hash, evidence versions and action content ids. Live proof: three repeated real evaluations per manager produced **1 insert + 2 `DUPLICATE_IDENTICAL`** even though the snapshot id changed between reads.
- **Eligibility** additionally requires a `TRUE_AS_OF`, non-blocked market. Existing `NOT_ACTIONABLE` rows never count (gate `NOT_ELIGIBLE`, 0/4 thresholds).
- **Automatic capture, no manual step:** `GET /api/cron/waiver2-capture` (`vercel.json`, daily 14:00 UTC, `CRON_SECRET`-gated) evaluates every manager of every ready Sleeper league and records the market snapshot and shadow capture through the same certified path. The class is *derived*: a run landing after a kickoff is `LIVE_POST_LOCK`, one whose schedule is unverifiable is `LIVE_UNVERIFIED` — never pristine. Live proof against an in-memory store (no database write): today (Sunday, games complete) the real path produced `LIVE_POST_LOCK` records, `valid: true`, not counted (`decision not verified pre-kickoff`). A pristine `LIVE_CAPTURED` needs every involved game pre-game at decision time; that can only be observed on a pre-kickoff run, so this checkpoint proves classification and identity, not a pristine row.
- Deployment note: the market snapshot table must exist before the cron/route can persist history; until the migration is applied the runtime records `ERROR`/health and evaluations are unaffected (telemetry only).

## 16. Book-Ready integration (Checkpoint F)

New topic `market.state` (`lib/book-ready/families/market-state.ts`), league-level: readiness status, acquisition system, clear days, FAAB budget (`NOT_APPLICABLE` in priority leagues), and pool counts (available with positional components, on waivers, unknown by reason, rostered, ineligible by reason). Deployment `SHARED_DESCRIPTIVE`, `may_influence_production: false`. Every block carries the market **content id** as lineage identity, readiness codes, freshness and the permanent provider limits; a blocked market yields `UNAVAILABLE` pool blocks with the precise codes, never a count presented as current. It does **not** duplicate `waiver2.market` (per-action FAAB ranges/scarcity/competitors). Units `market.count` / `market.days` added to the explicit registry. Live evidence for both leagues verified.

## 17. Analysis Book integration (Checkpoint F)

The single surface registry gained `league-market-state` (owner, builders, readers, consumers, refresh policy, history capability, Book-Ready capability) — no second registry. Chapter `waiver.availability_faab` now **requires** `market.state` (plus `waiver2.market`); no chapter ids, taxonomy version or templates changed. Waiver chapters read READY because the registry declares `waiver-intelligence-2` and `league-market-state` AVAILABLE (previously PARTIAL "until the pool is certified"); the integration test proves the downgrade path: `waiver-intelligence-2` PARTIAL → all four waiver chapters PARTIAL; `league-market-state` PARTIAL → only `waiver.availability_faab` PARTIAL. Runtime availability still decides per request.

## 18. Refresh strategy & performance

**Hybrid, decided:** request-scoped build (rosters, rules, transactions, schedule read `no-store`; the 12k-player universe from the provider's 24 h in-process cache, its age reported and bounded at 26 h) + a **30 s in-process memo** so the evidence route, Waiver 2.0, and capture share one read + a **daily cron** for prospective capture + snapshot persistence **on content change only**. No polling loop, no per-candidate provider call. Stale tolerance: 10 min live / 26 h universe. Transaction-triggered refresh was rejected: Sleeper has no webhook, and polling to detect changes would hammer the provider for little gain because transactions are low-frequency (49 in three weeks across two leagues).

Measured (`scripts/market-state-perf.ts`, live Sleeper, local machine): first load incl. universe download 301 ms; warm uncached load 53–68 ms; memo hit 0 ms; pool build 1 ms; compact snapshot 1 ms (30 KB); six managers of one league end to end 2.7 s (445 ms/manager, dominated by the unchanged canonical-state/weekly build), Waiver 2.0 evaluation 249 ms total for six, **one distinct market id across all six** (one read shared). A 12,000-player universe builds snapshot + pool in well under 1.5 s (test bound).

## 19. Failure handling

Each provider read has a 10 s ceiling (universe 20 s) and degrades **that source** to `UNAVAILABLE` with a `PROVIDER_ERROR` detail; nothing throws to a caller. Malformed payloads (roster payload not a list, transaction payload not a list, null/numeric/sentinel ids) are failures or are normalized — never an empty success. A partial transaction window (one week fails) fails the whole window (`WAIVER_STATE_UNVERIFIABLE`) because a partial window ≠ verified. In every failure mode the pool has 0 AVAILABLE players, Waiver 2.0 fails closed (`UNCERTIFIED_POOL`), and production outputs are unaffected (they never import the market state).

## 20. Tests

Full suite: **2382 tests, 2378 pass, 0 fail, 4 skipped** (baseline before this phase: the existing suite; 0 existing tests weakened — 4 tests updated because the intended state changed: the Phase 4 registry expectation `PARTIAL → AVAILABLE`, the Phase 4 Analysis Book upgrade test rewritten to the new requirement, the isolation allow-lists extended for the new market family/cron route, and the discovery route allow-list). `tsc --noEmit` clean; `eslint` clean for every changed file (repo-wide 11 pre-existing errors in unrelated scripts).

New: `market-state-contract` (6), `-build` (13), `-load` (3), `-waiver2` (6), `-capture` (10), `-bookready` (4), `-adversarial` (10) = 52 tests covering classification, integrity, determinism/shuffle invariance, every provider failure (unavailable, hung, malformed, partial window, stale), waiver windows, lock, DEF, FAAB-vs-priority, content-identity stability and change, capture dedupe (identical, volatile, snapshot-id churn, ownership/add/drop/acquisition/FAAB change, lock verdict), history store/runtime/hook, cron auth, Book-Ready contract, and import-graph production isolation.

## 21. Live validation (Checkpoint G, read-only, no transaction submitted)

`scripts/market-state-certify.ts` re-derives availability with an **independent** implementation (raw HTTP, no `lib/market-state` import) and requires exact set equality, for all three registered Sleeper leagues at week 2:

- ROSTERED == raw rosters (185 / 199 / 217); 0 duplicate owners.
- AVAILABLE == independent derivation (691 / 679 / 662) — **after** the stale-identity fix described in §5 (it failed 3/3 before the fix).
- ON_WAIVERS == independent drops-in-window (2 / 1 / 0).
- No AVAILABLE/ON_WAIVERS player is rostered in that league; every member has `eligible_to_add`, `UNROSTERED`, no fabricated clear time, team and position.
- Acquisition system and FAAB currency correct (FAAB only in Bloodline Bowl).
- Lock state matches schedule status; content id stable across two reads with different request ids.
- Multi-league isolation: 132 cross-league comparisons (owned in one league, not the other) — no ownership leaked. Manager budgets differ per team in the acquisition context.

## 22. Production isolation & parity

Baseline (`main`) vs branch, interleaved, `scripts/startsit-production-parity.ts`, two leagues / two managers: **lineup, start_sit, waivers, matchup, matchup_leverage, positional_needs hashes are identical** in every run (e.g. Bloodline Bowl `waivers 353688f80789a82a`, Devoted `be674113df18ccf3` — the production waiver section is still `NOT_READY`). Structurally, an import-graph test proves only `lib/waiver2` (adapter, pool, policy, types), the Book-Ready family/query and the persistence runtime import `lib/market-state`; no production, canonical, weekly, trade, orchestrator or provider module does, the substrate imports no consumer, and every file except the loader is pure (no fetch, no env, no DB). `lib/canonical/capabilities.ts` and the production readiness contract are unchanged. Trade/scoring engines are untouched.

## 23. Limitations

1. Sleeper cannot expose pending waiver claims → `WAIVER_CLAIM_PENDING` cannot be established; pending competition is unknown.
2. No per-player waiver clear instant → `waiver_clears_at` is `null`; only the drop time and window length are known. A player dropped before the transaction window we read, or whose drop we cannot see, cannot be marked on-waivers; a partial/failed window blocks the pool rather than guessing.
3. No published add-lock rule for started games → lock is a fact, not a verdict (§7).
4. Hidden bids are never visible; only processed winning bids are.
5. Practice-squad players are `UNKNOWN_AVAILABILITY` (Sleeper's rule for adding them is not proven here).
6. Waiver 2.0 evaluates weekly-projected candidates; the pool covers every eligible unrostered player (coverage reported per evaluation: 691/691 today).
7. No historical pool exists or was invented; history begins when the migration is applied and snapshots are recorded.
8. Weights remain `PRIOR_UNVALIDATED`; no pristine `LIVE_CAPTURED` row exists yet (needs a pre-kickoff run), so the evidence gate is `NOT_ELIGIBLE` and stays so until the sample thresholds are met.

## 24. Future provider work

- Sleeper: pending-claim visibility, a per-player clear time, or a published add-lock rule would remove limitations 1–3; none is available on the public API today, and undocumented private endpoints are deliberately not used.
- Yahoo (bridge Phase 1 is on a separate branch): the provider adapter should supply native availability rather than the derived path; the market contract is provider-neutral (`provider`, `player_key`) so a second adapter reuses the pool, identity, capture and Book-Ready layers. Its semantics must be verified when built, not assumed.
- Applying the migration and the merge/deploy task are separate, explicitly-instructed steps.

## 25. Certification verdict

Gates:

| Gate | Result |
|---|---|
| Truthful availability | PASS — exact set equality with an independent derivation in 3/3 leagues; the one defect it found (stale `active:false` identities) was fixed. |
| Ownership integrity | PASS — 0 conflicts live; duplicate owner fails closed in tests. |
| Stable market identity | PASS — volatile inputs cannot change `market_content_id`; the ranked-capture identity defect (canonical snapshot id/hash) was found and fixed. |
| Multi-league correctness | PASS — league-specific rules, budgets, ownership; 132 cross-league comparisons clean. |
| Readiness | PASS — precise, severity-tagged codes; partial readiness allowed with explicit consumer policy. |
| Waiver 2.0 integration | PASS — byte-identical actions/hash/params for the same candidates; 63/63 existing tests unchanged. |
| Shadow safety | PASS — `SHADOW_ONLY`, `mayInfluenceProduction() === false`, no submission path. |
| Prospective evidence | PASS with a stated boundary — a certified pool automatically produces ranked shadow captures through the real path (cron + evidence route), correctly classified and de-duplicated; a *pristine* row awaits a pre-kickoff run. |
| Book-Ready | PASS — `market.state`, registry, Analysis Book chapters gated on real registry capability. |
| Production isolation | PASS — parity hashes identical, import-graph isolation. |

**Verdict: B — CERTIFIED WITH PROVIDER LIMITATION.**
The market-state framework is correct and operational: the free-agent pool is safely materialized and Waiver 2.0 now produces genuine ranked shadow evidence in all three leagues. It is B rather than A because the provider (Sleeper) still cannot establish three acquisition facts the framework models as UNKNOWN rather than guessing: **(1) pending waiver claims, (2) a per-player waiver clear time, (3) whether a started game blocks an add.** Each is exposed as an explicit limitation and none makes the pool unsafe; they bound how precisely competition and timing can ever be modelled from this provider.

Not done, by design: no merge, no deploy, migration not applied, no claim submitted, no weight tuned, Phase 5 not begun.
