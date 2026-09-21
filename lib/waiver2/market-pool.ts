/**
 * Phase 4.5 — the ONLY place Waiver 2.0 turns the canonical market snapshot into its `pool`. Pure. Ranking math, weights, priors and
 * uncertainty are untouched: this decides WHO may be a candidate and WHETHER the pool is certified, nothing else.
 */
import type { MarketSnapshot } from "@/lib/market-state/contract";
import { MARKET_STATE_VERSION } from "@/lib/market-state/contract";
import { buildFreeAgentPool, consumerActionability } from "@/lib/market-state/pool";
import type { WeeklyTeamContext } from "@/lib/weekly/schema";
import { WAIVER2_MARKET_POLICY } from "./market-policy";
import type { WaiverInput } from "./types";

export function waiverPoolFromMarket(market: MarketSnapshot, weekly: Pick<WeeklyTeamContext, "availability">): WaiverInput["pool"] {
  const verdict = consumerActionability(market, WAIVER2_MARKET_POLICY); const marketPool = buildFreeAgentPool(market);
  const availableSleeperIds = new Set(marketPool.members.map((m) => m.provider_player_id));
  const evaluated = verdict.actionable ? weekly.availability.players.filter((a) => a.ownership === "free_agent" && availableSleeperIds.has(String(a.player.identifiers.sleeper_id ?? ""))) : [];
  const evaluatedIds = new Set(evaluated.map((a) => String(a.player.identifiers.sleeper_id)));
  const blockReasons = market.readiness.reasons.filter((r) => verdict.blocked_by.includes(r.code)).map((r) => `${r.code}: ${r.detail}`);
  return {
    certification: verdict.actionable ? "CERTIFIED" : "UNCERTIFIED_UNROSTERED",
    // Blocked: keep the legacy unrostered list ONLY so the engine reports UNCERTIFIED_POOL (it produces no actions from an uncertified pool).
    candidates: verdict.actionable ? evaluated : weekly.availability.free_agents,
    readiness: { actionable: verdict.actionable, reason_code: verdict.actionable ? null : (verdict.blocked_by[0] ?? "MARKET_STATE_UNAVAILABLE"), reasons: blockReasons, missing_inputs: verdict.blocked_by },
    market: { market_state_version: MARKET_STATE_VERSION, market_content_id: market.identities.market_content_id, pool_id: marketPool.pool_id, acquisition_context_id: market.acquisition.context_id, history_class: market.history_class, readiness_status: market.readiness.status, blocks: verdict.blocked_by, limitations: market.readiness.limitations, coverage: { pool_size: marketPool.members.length, evaluated: evaluated.length, unmatched: marketPool.members.filter((m) => !evaluatedIds.has(m.provider_player_id)).length } },
  }
}
