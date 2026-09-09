/**
 * Competitive Trade Intelligence — Checkpoint D orchestrator.
 *
 * opponent actual impact → threat → competitive externality → competitive result.
 * Consumed additively by `evaluateCompetitiveTrade` when a counterparty is given.
 */

import type { TradeAnalysisContext } from "../context";
import type { TradeEvaluationOutput } from "../evaluate";
import { resolveCompetitiveDConfig, type CompetitiveDConfig, type PartialCompetitiveDConfig } from "./config";
import { makeOwnerContextCache, type OwnerContext } from "./owner-context";
import { buildOpponentImpact } from "./opponent-impact";
import { buildLeagueThreat } from "./threat";
import { buildCompetitiveExternality } from "./externality";
import { buildCompetitiveResult } from "./competitive-result";
import { evaluateTradeHorizons } from "./horizon";
import type { PartialHorizonConfig } from "./config";
import type {
  AcceptanceEstimate,
  AggregateEdge,
  CompetitiveExternality,
  CompetitiveReadinessState,
  CompetitiveResult,
  OpponentImpact,
  OpponentThreat,
} from "./schema";

export interface CompetitiveDInput {
  ctx: TradeAnalysisContext;
  baseline: TradeEvaluationOutput;
  my_manager_id: string;
  my_manager_slug: string;
  counterparty_manager_id: string;
  counterparty_manager_slug: string;
  /** ids the counterparty RECEIVES (our outgoing) */
  received_by_counterparty: string[];
  /** ids WE receive (our incoming = what the counterparty gives up) */
  received_by_us: string[];
  /** Checkpoint C acceptance result (feasibility gate) */
  acceptance: AcceptanceEstimate | null;
  /** competitive block aggregate market edge */
  aggregate_edge: AggregateEdge | null;
  owner_perception_confidence: import("./schema").ValueConfidence | null;
  config?: PartialCompetitiveDConfig;
  horizon_config?: PartialHorizonConfig;
  owner_context_cache?: (id: string) => OwnerContext;
}

export interface CompetitiveDResult {
  our_horizon: import("./schema").TradeHorizonEvaluation;
  opponent_horizon: import("./schema").TradeHorizonEvaluation;
  opponent_impact: OpponentImpact;
  opponent_threat: OpponentThreat;
  competitive_externality: CompetitiveExternality;
  competitive_result: CompetitiveResult;
}

export function evaluateCompetitiveDimension(input: CompetitiveDInput): CompetitiveDResult {
  const config: CompetitiveDConfig = resolveCompetitiveDConfig(input.config);
  const cache = input.owner_context_cache ?? makeOwnerContextCache(input.ctx);

  // ---- horizon-aware permanent-trade utility (D.5) — replaces the immediate-
  // week-only value for both sides in the competitive scoring (§30, §46) ----
  const our_horizon = evaluateTradeHorizons({
    baseline: input.baseline,
    ctx: input.ctx,
    manager_slug: input.my_manager_slug,
    incoming_ids: input.received_by_us,
    outgoing_ids: input.received_by_counterparty,
    config: input.horizon_config,
  });
  const opponent_horizon = evaluateTradeHorizons({
    baseline: input.baseline,
    ctx: input.ctx,
    manager_slug: input.counterparty_manager_slug,
    incoming_ids: input.received_by_counterparty,
    outgoing_ids: input.received_by_us,
    config: input.horizon_config,
  });

  // ---- opponent actual impact (from OUR private models) ----
  const opponent_impact = buildOpponentImpact({
    baseline: input.baseline,
    counterparty_slug: input.counterparty_manager_slug,
    counterparty_manager_id: input.counterparty_manager_id,
    received_ids: input.received_by_counterparty,
    players_by_id: input.ctx.players_by_id,
  });
  // override private_delta / starter_delta with the permanent-horizon values —
  // starter/depth split is kept (reason codes) but the magnitude that feeds the
  // externality is the ROS-dominant one.
  opponent_impact.private_delta = round4(opponent_horizon.permanent_trade_utility);
  opponent_impact.starter_delta =
    opponent_impact.starter_delta == null
      ? round4(opponent_horizon.ros.starter_delta)
      : round4(0.75 * opponent_horizon.ros.starter_delta + 0.25 * opponent_impact.starter_delta);
  opponent_impact.ros_delta = round4(opponent_horizon.ros.total_delta);
  if (opponent_horizon.horizon_classification === "SHORT_TERM_LOSS_LONG_TERM_GAIN") opponent_impact.reason_codes.push("SHORT_TERM_LOSS_LONG_TERM_GAIN");
  if (opponent_horizon.horizon_classification === "SHORT_TERM_GAIN_LONG_TERM_LOSS") opponent_impact.reason_codes.push("SHORT_TERM_GAIN_LONG_TERM_LOSS");
  if (opponent_horizon.horizon_classification === "REVIEW_REQUIRED") opponent_impact.reason_codes.push("HORIZON_REVIEW_REQUIRED");
  opponent_impact.reason_codes.push("ROS_HORIZON_USED");
  opponent_impact.reasons.push(
    `permanent-horizon impact: immediate ${opponent_horizon.immediate.total_delta.toFixed(2)} / ROS ${opponent_horizon.ros.total_delta.toFixed(2)} / permanent ${opponent_horizon.permanent_trade_utility.toFixed(2)} (${opponent_horizon.horizon_classification})`,
  );

  // ---- threat ----
  const league = buildLeagueThreat(input.ctx, config, input.my_manager_id, cache);
  const opponent_threat: OpponentThreat =
    league.by_manager.get(input.counterparty_manager_id) ?? noThreat(input.counterparty_manager_id);

  // ---- externality ----
  const competitive_externality = buildCompetitiveExternality({ opponent_impact, threat: opponent_threat, config });

  // ---- our private gain: the horizon-aware PERMANENT utility (§30) ----
  const mine =
    input.baseline.participants[input.my_manager_slug] ??
    Object.values(input.baseline.participants).find((p) => p.manager_slug === input.my_manager_slug);
  const ourGain = mine ? our_horizon.permanent_trade_utility : null;

  // ---- readiness ----
  const readiness: CompetitiveReadinessState =
    mine == null || !league.by_manager.has(input.counterparty_manager_id)
      ? "PARTIAL_COMPETITIVE_CONTEXT"
      : opponent_threat.readiness === "PARTIAL_COMPETITIVE_CONTEXT"
        ? "PARTIAL_COMPETITIVE_CONTEXT"
        : "FULL_COMPETITIVE_CONTEXT";

  const competitive_result = buildCompetitiveResult({
    our_private_gain: ourGain,
    market_net_actionable_edge: input.aggregate_edge?.net_actionable_edge ?? null,
    acceptance_likelihood: input.acceptance?.likelihood ?? null,
    acceptance_confidence: input.acceptance?.confidence ?? null,
    externality: competitive_externality,
    threat: opponent_threat,
    owner_perception_confidence: input.owner_perception_confidence,
    readiness,
    config,
  });

  return { our_horizon, opponent_horizon, opponent_impact, opponent_threat, competitive_externality, competitive_result };
}

function round4(v: number): number {
  const x = Math.round(v * 10000) / 10000;
  return x === 0 ? 0 : x;
}

function noThreat(id: string): OpponentThreat {
  return {
    owner_manager_id: id,
    score: 0,
    band: "MODERATE",
    components: { projected_strength_z: 0, projected_strength_horizon: "CURRENT_WEEK", results_strength_z: null, results_weight: 0, blended_strength_z: 0, balance_penalty: 0 },
    league_strength_percentile: null,
    relative_to_us: null,
    contender_band: "UNKNOWN",
    readiness: "NO_THREAT_CONTEXT",
    calibration_status: "HEURISTIC",
    reasons: ["threat context unavailable for this counterparty"],
  };
}
