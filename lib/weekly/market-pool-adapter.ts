/**
 * Phase 4.5 integration (waiver-readiness-contract fix) — the ONE place the LEGACY (production) weekly waiver
 * engine turns the canonical Market State snapshot into an updated free-agent-pool readiness + a certified
 * candidate list.
 *
 * Deliberately mirrors Waiver 2.0's own market-pool reduction: same `consumerActionability` / `buildFreeAgentPool`
 * pure functions from `lib/market-state/pool.ts`, same "match on provider sleeper id" technique. There is exactly
 * ONE acquisition truth (`lib/market-state/*`) and zero duplicated market-eligibility logic between the two engines —
 * this file only decides WHO gets to be a legacy-engine candidate and WHETHER the pool is certified; it never
 * re-implements readiness classification.
 *
 * `UNROSTERED != CERTIFIED_FREE_AGENT` still holds: when the market is not actionable, the raw canonical
 * unrostered list is returned unchanged (harmless — the readiness gate in `lib/weekly/waivers.ts` refuses to use
 * it), never upgraded to a certified pool.
 */
import type { MarketSnapshot } from "@/lib/market-state/contract";
import { buildFreeAgentPool, consumerActionability, type ConsumerPolicy } from "@/lib/market-state/pool";
import { FREE_AGENT_POOL_UNAVAILABLE, type FreeAgentPoolReadiness } from "@/lib/canonical/capabilities";
import type { AvailablePlayer, LeagueAvailability } from "./schema";

/**
 * The legacy engine's explicit stance toward canonical market-state readiness codes — same posture as Waiver 2.0's
 * own policy: only the snapshot's own BLOCKING set is respected, nothing extra. A distinct `consumer` label (audit
 * trails only; it changes no behavior) so a reasons dump can tell which engine asked.
 */
export const LEGACY_WAIVER_MARKET_POLICY: ConsumerPolicy = { consumer: "legacy-weekly-waiver-engine", also_blocking: [] };

export interface CertifiedFreeAgentPool {
  free_agent_pool_readiness: FreeAgentPoolReadiness;
  /**
   * `availability.free_agents` intersected with the certified Market State pool (matched by provider sleeper id).
   * Unchanged (still the raw canonical unrostered list) when the pool is not actionable — the readiness gate
   * blocks its use downstream regardless of what this array contains.
   */
  free_agents: AvailablePlayer[];
  market_content_id: string;
  pool_id: string;
}

export function certifyFreeAgentPool(market: MarketSnapshot, availability: Pick<LeagueAvailability, "free_agents">): CertifiedFreeAgentPool {
  const verdict = consumerActionability(market, LEGACY_WAIVER_MARKET_POLICY);
  const marketPool = buildFreeAgentPool(market);

  if (!verdict.actionable) {
    const reasons = market.readiness.reasons
      .filter((r) => verdict.blocked_by.includes(r.code))
      .map((r) => `${r.code}: ${r.detail}`);
    return {
      free_agent_pool_readiness: {
        actionable: false,
        status: "UNAVAILABLE",
        reason_code: FREE_AGENT_POOL_UNAVAILABLE,
        reasons: reasons.length ? reasons : ["market state is not actionable for waiver/free-agent recommendations"],
        missing_inputs: verdict.blocked_by,
      },
      free_agents: availability.free_agents,
      market_content_id: market.identities.market_content_id,
      pool_id: marketPool.pool_id,
    };
  }

  const availableSleeperIds = new Set(marketPool.members.map((m) => m.provider_player_id));
  const certified = availability.free_agents.filter((fa) => availableSleeperIds.has(String(fa.player.identifiers.sleeper_id ?? "")));

  return {
    free_agent_pool_readiness: { actionable: true, status: "HEALTHY", reason_code: null, reasons: [], missing_inputs: [] },
    free_agents: certified,
    market_content_id: market.identities.market_content_id,
    pool_id: marketPool.pool_id,
  };
}
