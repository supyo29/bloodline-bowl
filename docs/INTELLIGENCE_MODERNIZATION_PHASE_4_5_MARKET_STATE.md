# Intelligence Modernization Phase 4.5 — Free-Agent Availability & Market-State Hardening

Branch `intelligence-modernization-phase4-5-market-state`, based on `main` @ `15f7b0a`.
Status: IN PROGRESS. This document grows checkpoint by checkpoint. Nothing here is merged or deployed.

## 1. Starting state (recorded before any change)

- Production Waiver 2.0 (`b510813`, deployment `dpl_4oTNuKcUorsEL4ZWT5DCLnyCUTE8`): `NOT_READY` / `FREE_AGENT_POOL_UNAVAILABLE`, 0 recommendations.
- Capture table `waiver2_shadow_captures`: 6 rows, all `NOT_ACTIONABLE` / `POOL_READINESS_BLOCKED`; 0 ranked, 0 live.
- Root cause: `SleeperProvider.getWaiverState` (`lib/providers/sleeper/provider.ts`) reports rostered ownership only and always emits the `free_agent_pool_not_materialized` warning. `buildCanonicalLeagueState` (`lib/canonical/state.ts`) sets `waiver_state: null` on both the success and the degraded path. `assessFreeAgentPoolReadiness` (`lib/canonical/capabilities.ts`) therefore reports the `free_agent_pool` capability UNAVAILABLE, and every waiver surface fails closed.
- The canonical mapper (`lib/providers/sleeper/canonical.ts`) maps `waiver_type` (2 → faab, 1 → priority) and `waiver_budget`, but sets `waiver_day: null` and does not map `waiver_clear_days` at all.

## 2. Checkpoint A — provider & rules forensic audit (live Sleeper, 2026-09-20, read-only)

### 2.1 Exact provider capabilities

| Endpoint | Gives | Availability relevance |
|---|---|---|
| `GET /league/{id}` | `waiver_type`, `waiver_budget`, `waiver_day_of_week`, `waiver_clear_days`, `reserve_slots`, `taxi_slots`, roster positions, scoring | Acquisition rules. |
| `GET /league/{id}/rosters` | Per roster: `players` (includes IR and taxi ids), `reserve`, `taxi`, `starters`, `owner_id`, `settings.waiver_position`, `settings.waiver_budget_used` | Authoritative ownership; FAAB used and priority position per team. |
| `GET /players/nfl` | 12,228 entries: `status`, `active`, `team`, `position`, `injury_status`, `depth_chart_*` | Player universe; noisy. |
| `GET /league/{id}/transactions/{week}` | `complete` and `failed` `waiver` / `free_agent` / `trade` / `commissioner` entries with `adds`, `drops`, `settings.waiver_bid`, `status_updated` | Winning and failed bids are visible after processing; the movement chronology is real. |
| NFL schedule game status | Kickoff and completion per game | Game-lock derivation, already used by the 3.5A and Phase 4 lock classifiers. |

### 2.2 Exact gaps (nothing below is available from Sleeper)

- No free-agent list endpoint. Availability can only be derived, never read.
- No pending waiver claims and no per-player waiver clear time. Pending claims are not exposed for other teams; even the caller's own claims would need authentication we do not have.
- No hidden bids. Only processed bids appear, and only after the run.
- No provider-side "is this player addable" flag.
- No league-level published lock list.

Consequence: `WAIVER` status can only be inferred (see 2.6) and the clear instant stays `UNKNOWN`. Pending-claim state is `UNKNOWN`, never assumed empty.

### 2.3 League waiver settings (both real leagues)

| | Bloodline Bowl | Devoted |
|---|---|---|
| Acquisition system | FAAB (`waiver_type` 2), budget 100 | Reverse-standings priority (`waiver_type` 1); `waiver_budget` 1000 is unused |
| `waiver_day_of_week` | 2 | see raw settings; carried as league data |
| `waiver_clear_days` | 2 | 2 |
| Reserve (IR) slots | 1 | 2 |
| Positions | includes FLEX | 3 FLEX |

FAAB context must apply only to the FAAB league. In Devoted, a budget value exists in settings but does not describe an acquisition currency; the market layer must key FAAB off `waiver_type`, not off the presence of `waiver_budget`.

### 2.4 Player universe

- 12,228 `/players/nfl` entries; the large majority are inactive, retired or without a team.
- 32 DEF entries keyed by team abbreviation (`player_id` is the abbreviation, e.g. `KC`). The canonical layer already treats DEF as a team entity (`lib/canonical/players.ts` forces `position: "DEF"` for these, bypassing name matching); the market layer must do the same and never send DEF through individual-player logic.
- 240 entries have a null or `XX` position: never eligible, and never counted as available.
- Status values include `Active`, `Inactive`, `Injured Reserve`, `PUP`, `Suspended`, `Practice Squad`, `Non Football Injury`, `Retired`-like states and empty. Each must be classified explicitly; unknown values map to UNKNOWN, not to eligible.
- Universe must be filtered by an explicit, versioned eligibility rule (rostered NFL team, fantasy position, status), and every exclusion must carry a reason code.

### 2.5 Ownership source

- Rosters are authoritative. Live check: 185 rostered players across the league rosters, **0 duplicate owners**. IR and taxi ids are inside `players`, so IR/taxi/bench all count as owned. Empty slots appear as `"0"`/null and must produce no identity.
- The market layer must assert: at most one owner per player, no AVAILABLE and OWNED for the same identity, and every rostered id resolved or explicitly listed as unresolved.

### 2.6 Acquisition semantics and reconstruction feasibility

Empirical test against completed transactions from both leagues since 2026-08-31 (49 completed transactions; 31 `free_agent` adds):

- **0 of 31** free-agent adds involved a player dropped less than `waiver_clear_days` earlier. That is exactly what the Sleeper rule predicts (recently dropped players go through waivers, not straight to the wire), and it validates the inference "dropped within `waiver_clear_days` ⇒ WAIVER, else FREE_AGENT".
- 3 free-agent adds were of previously dropped players after the window had elapsed; consistent with the rule.
- 3 `waiver` adds fell inside a drop window (`waiver` claims of recently dropped players); consistent.

Conclusions:

1. `FREE_AGENT` = eligible universe − rostered − ineligible − in-waiver-window − game-locked, and only when the rosters, universe, settings and transaction reads all succeed.
2. `WAIVER` is inferable only for players with a provable drop inside `waiver_clear_days`. Clear time = drop time + `waiver_clear_days`, aligned to `waiver_day_of_week`; because the exact processing hour is not exposed, the instant stays `UNKNOWN` and only the window is reported. Where the drop is not in the transaction window we read, the player is not marked WAIVER, so the pool may over-include a just-dropped player; this must surface as a stated limitation whenever the transaction read is partial.
3. Game lock comes from schedule status; if the schedule is unverifiable the lock is `UNKNOWN` (no invented kickoffs).
4. FAAB remaining and waiver priority are per-team acquisition context, kept separate from availability. Missing FAAB data must never turn an available free agent into unavailable.
5. Historical pools are `RETROSPECTIVE_ONLY` at best: transactions carry timestamps, so a past pool could be approximated, but the roster set at that instant, the universe status and the schedule at that instant are not preserved by the provider. No fake backfill; only immutable snapshots taken from now on are TRUE_AS_OF.

### 2.7 Audit verdict and implications for design

- Certifiable outcome is at best "B, certified with provider limitation": Sleeper cannot supply pending claims or exact waiver clear instants. The design must state precisely that limitation and must make Waiver 2.0 fail closed on it only where it matters.
- No production behaviour was changed by this checkpoint; the only change is this document.
