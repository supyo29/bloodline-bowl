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
  /** Checkpoint C acceptance result (feasibility gate) */
  acceptance: AcceptanceEstimate | null;
  /** competitive block aggregate market edge */
  aggregate_edge: AggregateEdge | null;
  owner_perception_confidence: import("./schema").ValueConfidence | null;
  config?: PartialCompetitiveDConfig;
  owner_context_cache?: (id: string) => OwnerContext;
}

export interface CompetitiveDResult {
  opponent_impact: OpponentImpact;
  opponent_threat: OpponentThreat;
  competitive_externality: CompetitiveExternality;
  competitive_result: CompetitiveResult;
}

export function evaluateCompetitiveDimension(input: CompetitiveDInput): CompetitiveDResult {
  const config: CompetitiveDConfig = resolveCompetitiveDConfig(input.config);
  const cache = input.owner_context_cache ?? makeOwnerContextCache(input.ctx);

  // ---- opponent actual impact (from OUR private models) ----
  const opponent_impact = buildOpponentImpact({
    baseline: input.baseline,
    counterparty_slug: input.counterparty_manager_slug,
    counterparty_manager_id: input.counterparty_manager_id,
    received_ids: input.received_by_counterparty,
    players_by_id: input.ctx.players_by_id,
  });

  // ---- threat ----
  const league = buildLeagueThreat(input.ctx, config, input.my_manager_id, cache);
  const opponent_threat: OpponentThreat =
    league.by_manager.get(input.counterparty_manager_id) ?? noThreat(input.counterparty_manager_id);

  // ---- externality ----
  const competitive_externality = buildCompetitiveExternality({ opponent_impact, threat: opponent_threat, config });

  // ---- our private gain (from OUR participant in the baseline) ----
  const mine =
    input.baseline.participants[input.my_manager_slug] ??
    Object.values(input.baseline.participants).find((p) => p.manager_slug === input.my_manager_slug);
  const ourGain = mine ? (mine.phase2 ? mine.phase2.contextual_utility_delta : mine.roster_utility_delta) : null;

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

  return { opponent_impact, opponent_threat, competitive_externality, competitive_result };
}

function noThreat(id: string): OpponentThreat {
  return {
    owner_manager_id: id,
    score: 0,
    band: "MODERATE",
    components: { projected_strength_z: 0, results_strength_z: null, results_weight: 0, blended_strength_z: 0, balance_penalty: 0 },
    league_strength_percentile: null,
    relative_to_us: null,
    contender_band: "UNKNOWN",
    readiness: "NO_THREAT_CONTEXT",
    calibration_status: "HEURISTIC",
    reasons: ["threat context unavailable for this counterparty"],
  };
}
