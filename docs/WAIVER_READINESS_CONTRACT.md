# Waiver / free-agent readiness contract

Two invariants every waiver / free-agent / pickup / add-drop / claim surface enforces:

- **`UNROSTERED != CERTIFIED_FREE_AGENT`** — a player being absent from every roster
  in ownership data does **not** make them a current free agent or waiver claim.
  `ownership = HEALTHY` does not imply `free_agent_pool = HEALTHY`.
- **`HTTP_200 != ACTIONABLE_DATA`** — a route returning HTTP 200 does not mean the
  underlying data is actionable.

## The one authoritative gate

`assessFreeAgentPoolReadiness(snapshot)` in `lib/canonical/capabilities.ts` is the
single source of truth. It delegates to `assessCapabilities` (the same model
`/api/league/[l]/state` and `/api/ai` discovery use) — there is **no** parallel
readiness logic. The pool is actionable **only** when the canonical
`free_agent_pool` capability is `HEALTHY`, which requires a materialized
`snapshot.waiver_state` (real provider/league claimability) and no
`free_agent_pool_not_materialized` warning. It is never made `HEALTHY` from
`all_players - rostered_players`.

`buildWeeklyTeamContext` computes it once and exposes it as
`WeeklyTeamContext.free_agent_pool_readiness`. Every consumer reads that field.

## Behaviour when the pool is NOT actionable

| Surface | Behaviour |
| --- | --- |
| `GET /api/waivers/{league}/{manager}/week/{week}` | HTTP 200, body `status: "NOT_READY"`, `reason_code: "FREE_AGENT_POOL_UNAVAILABLE"`, canonical `capability` reasons + `missing_inputs`, `data.recommendations: []`, `data.do_not_add: []`, `data.considered: 0`. No add/drop pair, score, or "stand pat" is emitted. Lineage/readiness metadata (`context`) preserved. |
| `GET /api/intelligence/{league}/{manager}/week/{week}` | No `type: "WAIVER"` in `top_actions`. `summary.waiver_priority` = "Waiver recommendations unavailable: current free-agent pool is not materialized/certified." Nested `waivers.availability_status: "UNAVAILABLE"`. Lineup, start/sit, matchup, Football-Intelligence shadow and positional-needs are **unaffected**. |
| Team-Management orchestrator | Consumes the frozen waiver engine's (now empty) `recommendations` — produces no `WAIVER` candidate or action. |

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
