# Waiver / free-agent readiness contract

Two invariants every waiver / free-agent / pickup / add-drop / claim surface enforces:

- **`UNROSTERED != CERTIFIED_FREE_AGENT`** — a player being absent from every roster
  in ownership data does **not** make them a current free agent or waiver claim.
  `ownership = HEALTHY` does not imply `free_agent_pool = HEALTHY`.
- **`HTTP_200 != ACTIONABLE_DATA`** — a route returning HTTP 200 does not mean the
  underlying data is actionable.

## The one authoritative gate (updated — Phase 4.5 Market State integration)

`WeeklyTeamContext.free_agent_pool_readiness` is still the one field every
consumer reads, and it is still never made `HEALTHY` from
`all_players - rostered_players`. What feeds it now depends on how
`buildWeeklyTeamContext` is called:

- **Default** (`options.enableMarketStatePool` unset/`false`): unchanged —
  `assessFreeAgentPoolReadiness(snapshot)` in `lib/canonical/capabilities.ts`,
  which delegates to `assessCapabilities` (the same model `/api/league/[l]/state`
  and `/api/ai` discovery use). This requires a materialized
  `snapshot.waiver_state`, which `lib/canonical/state.ts` never populates today
  — so this path is always `UNAVAILABLE` in production. It exists for callers
  that have no reason to pay for a Market State read (e.g. the lineup/matchup
  routes, and every pre-Phase-4.5 test).
- **`options.enableMarketStatePool: true`** (the waivers route, the
  intelligence route, the Team-Management orchestrator, and Book-Ready's
  weekly-intelligence topic all pass this): `free_agent_pool_readiness` and
  `availability.free_agents` are instead certified against the canonical
  **Phase 4.5 Market State** substrate (`lib/market-state/*`) — the SAME
  substrate Waiver 2.0 already consumes. The reduction lives in exactly one
  place, `lib/weekly/market-pool-adapter.ts::certifyFreeAgentPool`, and calls
  the SAME pure `consumerActionability` / `buildFreeAgentPool` functions
  Waiver 2.0's own `lib/waiver2/market-pool.ts` calls — there is still **no**
  parallel readiness implementation, only a second authoritative *source*
  (Market State instead of `snapshot.waiver_state`) feeding the one gate.
  `availability.players` — what the shared replacement/VOR framework consumes
  for lineup + matchup + waiver engines alike — is never touched, so
  lineup/matchup behavior is identical either way. A Market State read
  failure fails closed (falls back to the legacy `UNAVAILABLE` gate above),
  it never silently claims actionability.

Known residual: `/api/league/{league}/state`'s own `free_agent_pool` capability
(`assessCapabilities`) still reports `UNAVAILABLE` (it reads
`snapshot.waiver_state`, still never populated) even when the waivers/
intelligence routes now report the pool actionable via Market State. This is
intentional and out of scope for this fix — populating `waiver_state` on every
canonical snapshot build would mean every `buildCanonicalLeagueState` caller
(not just waiver consumers) pays for a Market State read on every call, and —
more seriously — would change `snapshot.lineage.league_snapshot_id` (it is a
content hash of the whole snapshot body) the moment Market State availability
changes, for reasons entirely unrelated to any of the fields that identity is
supposed to track. That is a materially larger blast radius across every
snapshot-identity-keyed surface (Book-Ready, Start/Sit shadow, Matchup 2.0,
Waiver 2.0, the Team-Management "frozen surfaces byte-identical" trust audit)
than this fix's stated scope.

## Behaviour when the pool is NOT actionable

| Surface | Behaviour |
| --- | --- |
| `GET /api/waivers/{league}/{manager}/week/{week}` | HTTP 200, body `status: "NOT_READY"`, `reason_code: "FREE_AGENT_POOL_UNAVAILABLE"`, canonical `capability` reasons + `missing_inputs`, `data.recommendations: []`, `data.do_not_add: []`, `data.considered: 0`. No add/drop pair, score, or "stand pat" is emitted. Lineage/readiness metadata (`context`) preserved. |
| `GET /api/intelligence/{league}/{manager}/week/{week}` | No `type: "WAIVER"` in `top_actions`. `summary.waiver_priority` = "Waiver recommendations unavailable: current free-agent pool is not materialized/certified." Nested `waivers.availability_status: "UNAVAILABLE"`. Lineup, start/sit, matchup, Football-Intelligence shadow and positional-needs are **unaffected**. |
| Team-Management orchestrator | Consumes the frozen waiver engine's (now empty) `recommendations` — produces no `WAIVER` candidate or action. When Market State certifies the pool `HEALTHY`, the orchestrator instead receives the SAME certified `recommendations` the waivers route serves (it calls `buildWeeklyIntelligence` with `enableMarketStatePool: true` too) — nothing about the orchestrator's own gating logic changed. |

## "Nothing clears the bar" is a different state

`WaiverResult.availability_status` distinguishes:

- `"AVAILABLE"` + `recommendations: []` + `considered > 0` — the pool is certified,
  candidates were evaluated, none beat their drop cost.
- `"UNAVAILABLE"` + `unavailable_reason_code: "FREE_AGENT_POOL_UNAVAILABLE"` — the
  pool itself is not materialized/certified.

These never serialize to the same semantic state.

## Healthy path

When `free_agent_pool` is `HEALTHY` the waiver ranking / scoring, add/drop
counterfactual, FAAB / priority behaviour and response schema are unchanged —
this is a readiness gate, not a waiver-model change.
