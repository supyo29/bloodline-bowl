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

---

# Appendix M — Merge, deployment & production certification (2026-09-21)

Branch findings above are unchanged. This appendix records the merge task.

## M1. Reconciliation
Certified branch tip `51804af`. `main` = `origin/main` = merge base = `15f7b0a` at start: **0 commits unique to main, no drift**, clean tree; merged by fast-forward (no force-push, no rewrite).

## M2. Pre-merge production baseline
`dpl_35iBD8HvXUKsVwz3N2ZBTGTEr9fh` @ `15f7b0a`; aliases `bloodline-bowl-sleeper-bridge.vercel.app`, `…-supyo29s-projects.vercel.app`, `…-git-main-…`; health 200; FI `fi:2026:w02:bfd77c9959a6`, Role `roi:2026:w01:819dc3166607`; Waiver 2.0 `SHADOW_ONLY`, `may_influence_production: false`; scoring fingerprints `scoring:v1:29acc6bcd911df090b5b9b9c` (Bloodline Bowl), `scoring:v1:d4795fa723cdd12d9ba3bfb1` (Devoted, Sporty's); production waivers `UNAVAILABLE`; capture table 6 rows, all `NOT_ACTIONABLE`; 0 eligible; 0 outcomes; migrations through `20260921022348`. Production section hashes (lineup, start_sit, waivers, matchup, leverage, positional_needs) recorded for 4 league/manager pairs, stable across two reads.

## M3. Defects/gaps found and fixed during the merge task (all before certification)
1. **Correlated captures could inflate the evidence gate.** A daily cron plus requests can create many distinct-identity captures of one manager/week decision (e.g. a FAAB change). The gate now counts **one decision per (league, manager, season, week)** — the earliest eligible record; later ones are excluded as `CORRELATED_SAME_DECISION_WINDOW`. Thresholds are unchanged (min 8 weeks / 60 decisions / 3 managers; preferred 14 / 200 / 6 / 2 leagues). One existing test (which had encoded 3-per-window inflation, expecting 72) was corrected to 128 captures → 64 decisions. 30 correlated variants of one window = 1 decision (permanent test).
2. **Invocation provenance** (`CRON` | `REQUEST`) is recorded on every capture but is **not identity and not an eligibility criterion**; a cron run after a kickoff is `LIVE_POST_LOCK` (permanent test).
3. **Public-parameter poisoning.** The evidence route took `season` from the request and `market.state` accepted a caller-chosen `week` that labelled stored history. Season now comes from canonical state (`week` was already rejected for non-current weeks: `NON_CURRENT_WEEK_UNSUPPORTED`), and market history is persisted only for the current NFL week.
4. **Scoring fingerprint missing from market snapshots** (found from the first three production rows). It is now derived from the league's own scoring settings by the canonical pure function; verified equal to the known fingerprints.
5. **Book-Ready lineage.** `waiver2.*` evidence now carries the consumed market lineage (content id, pool id, manager acquisition context id, coverage) via a side table (evaluation object and its hashes untouched); `market.state` accepts `manager` and adds a manager **overlay** (FAAB remaining, priority, roster size/open slots/add-requires-drop) over an identical league pool identity.
6. **Analysis Book honesty.** Marking all four waiver chapters READY was too generous. A topic-level `PROVIDER_LIMIT_PARTIAL` flag (no taxonomy change) makes `waiver.availability_faab` and `waiver.manager_competition` **PARTIAL** (pending claims and clear times unknown, competitor need structural, FAAB UNCALIBRATED); `waiver.drop_cost` and `decision.replacement_value` are **READY**. Chapter ids unchanged.
7. Migration tightened before it was applied (identity-format CHECKs; snapshot JSON must equal its row identity).

## M4. Migration (production Supabase `ijpfjdzmaztofawhwepf`)
Pre-check: no equivalent table under any name; SQL re-inspected; rollback documented (`drop table … ; drop function …`). Applied through the migration tool as **`20260921040113 market_state_snapshots`**. Verified: RLS on, 0 policies, no anon/authenticated grants, 7 constraints (PK + identity-format + `TRUE_AS_OF` + `READY|PARTIAL` + format + snapshot/identity), 2 indexes + PK, immutability trigger enabled, table empty. There is no outcome relationship for market snapshots (outcomes belong to `bridge_waiver2_shadow_outcomes`, whose FK was verified below).

**Production adversarial test (single statement that always rolls back):** valid insert OK; duplicate rejected; `UNSAFE` class rejected; blocked (`NOT_READY`) market rejected; malformed artifact id rejected; malformed content id rejected; snapshot/identity mismatch rejected; UPDATE blocked; DELETE blocked; invalid capture class rejected; LIVE class on an uncertified pool rejected; orphan outcome rejected. Afterwards: market rows 0, capture rows 6 — unchanged.

## M5. Merge & deploy
Merged fast-forward `15f7b0a → 8324f90`, then `fa72a5a` (scoring fingerprint), `7c62590` (Book-Ready overlay/lineage), `596f7c6` (Analysis Book provider-limit flag). Every deployment READY with all three aliases attached and health 200. **Code SHA certified: `596f7c6` (`dpl_3EVi6bNxxxeSrJPTpZ1HzJ4xpAJe`)**; earlier intermediates were `dpl_DBTiBBh3…` (`8324f90`), `dpl_HXUd9QP8…` (`fa72a5a`). A docs-only commit follows and is not a code change. `vercel.json` now schedules `/api/cron/waiver2-capture` at 14:00 UTC daily.

## M6. Live market state (production evidence route, 3 leagues, week 2)
| League | System | Available | On waivers | Rostered | Unknown | Ineligible | Content id |
|---|---|---|---|---|---|---|---|
| Bloodline Bowl | FAAB (budget 100) | 691 | 2 | 185 | 7 | 11,343 | `mkt:2026:w02:b618f4f5314486c1` |
| Devoted | Priority (reverse standings), FAAB `NOT_APPLICABLE` | 679 | 1 | 199 | 7 | 11,342 | `mkt:2026:w02:0aac83f57be13ce6` |
| Sporty's Alumni | Priority, clear days 0 | 662 | 0 | 217 | 7 | 11,342 | `mkt:2026:w02:695bfa1c77ddfc4c` |

Readiness `READY` in all three, limitations `PENDING_CLAIMS_NOT_EXPOSED`, `WAIVER_CLEAR_TIME_NOT_EXPOSED`, `GAME_LOCK_ADD_RULE_NOT_PUBLISHED` — all three remain **UNKNOWN**; none was converted into an assumed value (waiver clear time null on every player, no `WAIVER_CLAIM_PENDING`, started games are a per-player fact and never remove a player from the pool).

**Independent verification.** `scripts/market-state-certify.ts` (raw HTTP re-derivation, no market-state code) against live Sleeper: ROSTERED, AVAILABLE and ON_WAIVERS sets are **exactly equal** in all three leagues (185/691/2, 199/679/1, 217/662/0), plus schema-consistent lock state and cross-league isolation (**ALL CHECKS PASSED**). The production endpoint's counts equal the derivation and its content ids equal those computed locally at the same moment (the pool list itself has no public route, so set equality was checked on the identical code at the same SHA).

**Stale/inactive regression.** 24 directory rows have a team and `active=false`; in every league 7 are `UNKNOWN_AVAILABILITY` and 17 are excluded (ineligible/duplicate), **0 leak as AVAILABLE**. The 43 "Duplicate Player" directory rows are preserved, not deleted.
**DEF.** 32 team entities per league, position DEF with a team, none misclassified; 19 / 19 / 17 available and present in the DEF positional pool; rostered counts differ by league (13 / 13 / 15).
**Cross-league.** e.g. Tre Tucker: available in Bloodline Bowl, rostered in Devoted and Sporty's; Braelon Allen: rostered in Bloodline Bowl, available in the other two — identical provider id, league-specific status; the three content ids are distinct.
**Manager overlay.** One league pool identity (identical across managers, verified on production evidence) with per-manager FAAB (100 vs 91), priority (9 vs 10), roster room.

## M7. Persistence and deduplication (production database)
- Market snapshots: first reads inserted one row per league; after the scoring-fingerprint fix one new artifact per league (the first three, with `scoring_fingerprint null`, are preserved — nothing is overwritten). **18 cache-busted concurrent requests → +3 rows**, and 12 further concurrent requests → +0 (final: 6 rows, 3 leagues). Stored: league, season/week/as-of, ownership/universe/transactions/rules identities, scoring fingerprint, market content id, acquisition-context id, readiness, limitations, sources.
- Ranked shadow captures: 6 managers × 3 repeats (18 requests) → **6 rows**; 12 further concurrent cache-busted requests → **+0**. `ranked_same_window_dupes = 0`. Snapshot ids change between reads and did not create rows. Deterministic tests prove a new row for market/pool, ownership, roster add/drop, budget, acquisition context, scoring fingerprint change and lock verdict.
- Runtime health shows `duplicates` counting and `failures 0`.

## M8. Waiver 2.0 live shadow output
All three leagues, six managers: `availability CERTIFIED`, ranked actions (e.g. 79 Book-Ready blocks for one manager), `SHADOW_ONLY`, `may_influence_production false`, params hash `db8892b015a8` (unchanged from Phase 4), scoring fingerprint attached, candidate coverage 679/679 evaluated (0 unmatched), uncertainty and alternatives preserved, FAAB `calibration NONE/UNCALIBRATED` and `PRIOR_UNVALIDATED` limitations preserved on the evidence. These are **shadow outputs, not validated recommendations.** The exact-math regression (same pool through the legacy and canonical paths → byte-identical actions, `evaluation_hash`, `params_hash`) is a permanent test.

## M9. Evidence counts (production, after certification traffic — reported separately)
| Kind | Count |
|---|---|
| Market snapshots | 6 (3 leagues; 3 pre-fingerprint + 3 final) |
| `LIVE_CAPTURED` | 0 |
| `LIVE_POST_LOCK` (ranked) | 6 (6 managers, all REQUEST-invoked, week 2, all NFL week-2 games already started/complete) |
| `LIVE_UNVERIFIED` | 0 |
| `NOT_ACTIONABLE` (readiness) | 6 (pre-existing; never count) |
| Reconstructed | 0 |
| Illustrative | 0 (never persisted) |
| Ranked-action rows | 6 |
| Outcome rows | 0 |
| Eligibility-qualified decisions | **0** (gate `NOT_ELIGIBLE`; thresholds unchanged) |

**First pristine ranked capture: pending qualifying live decision window.** Certification ran after the week-2 games, so every capture is honestly `LIVE_POST_LOCK`; nothing was manufactured. The cron dry run (real function, in-memory stores) captured 41 managers in ~14 s, all `LIVE_POST_LOCK`, then 41 `DUPLICATE_IDENTICAL` on a second run, invocation `CRON`, 0 eligible. Pristine `LIVE_CAPTURED` will appear only when a run (cron or request) sees every involved game verifiably pre-game — and even then a manager/week counts once.

## M10. Cron
`/api/cron/waiver2-capture`: unauthenticated → 401, bad bearer → 401 (production), `CRON_SECRET`-gated like the existing crons; read-only toward fantasy platforms (no submission path); duplicate invocations are no-ops (identity + database uniqueness); failures are isolated per manager and never touch recommendations. It could not be invoked with the real secret from this session (the secret is not available), so the scheduled run is confirmed only by its dry run and auth tests; the first scheduled execution (14:00 UTC) should be checked in the deployment logs.

## M11. Production waiver response and parity
Production waiver section unchanged: `waiver_status UNAVAILABLE` for all four sampled managers before and after. The post-deploy production hashes for two managers' `waivers` sections differed from the earlier recorded baseline; the interleaved local comparison of baseline code (`15f7b0a`) vs final code, run against the same live state (3 league/manager pairs × 2 pairs of runs, all six sections), is **identical** — the movement was upstream Sleeper drift (week-2 results and transactions), not Phase 4.5. Lineup, Start/Sit, matchup, leverage, positional needs identical everywhere. Trade/scoring engines untouched (no import path from the market state).

## M12. Book-Ready / Analysis Book (production)
`market.state` (league facts + manager overlay), `waiver2.actions`, `waiver2.market`, `waiver2.replacement` all `OK`: units `count`/`days`/`currency`/`points`/`fraction`/`category`, shadow class, confidence/uncertainty on actions, market content id + pool id + coverage in lineage, provider unknowns and `PRIOR_UNVALIDATED` in limitations. Waiver Analysis Book (13 chapters, ids unchanged): `decision.replacement_value` READY, `waiver.drop_cost` READY, `waiver.availability_faab` **PARTIAL**, `waiver.manager_competition` **PARTIAL** (reasons stated). Market history is prospective-only (`CURRENT_ONLY` in the registry); nothing implies historic availability.

## M13. Performance
Production, warm: `market.state` 0.15 s; `waiver2.actions` ≈1.1 s end to end (Phase 4 baseline ≈1 s input + ≈50 ms evaluation; the pool adds ≈60 ms uncached, 0 ms memoized; universe ≈3,120 candidates → 679–691 market-eligible, ~90 shortlisted, evaluation unchanged); cold first request ≈3.8 s (player-universe download); 12 concurrent evaluations 2.4–5.4 s wall. Cron: ≈14 s for 41 managers (one market read per league). No N×M provider calls.

## M14. Tests
Final code: **2384 tests, 2380 pass, 0 fail, 4 skipped**; `tsc` clean; eslint clean for changed files. New this task: capture provenance / correlated-window gate, manager overlay + lineage, provider-limit chapters, scoring fingerprint, plus all branch suites (market contract, build, load, adversarial, capture, Book-Ready, isolation, cron auth). R suites not run (no R/model artifact changed).

## M15. Remaining limitations
Pending claims, per-player waiver-clear instants and the started-game add rule remain UNKNOWN by provider; Waiver 2.0 weights `PRIOR_UNVALIDATED`; no pristine or outcome-bearing evidence yet (evidence-insufficient, no promotion); market history begins 2026-09-21; the scheduled cron's first real run is unobserved.

## M16. Final verdict
**A — CERTIFIED — CANONICAL MARKET STATE OPERATIONAL.**
Phase 4.5 canonical market-state infrastructure is production-certified. Waiver Intelligence 2.0 now receives a trustworthy league-specific candidate pool and can accumulate ranked prospective shadow evidence. Provider-unsupported acquisition details remain explicitly unknown. Production waiver behavior is unchanged.
