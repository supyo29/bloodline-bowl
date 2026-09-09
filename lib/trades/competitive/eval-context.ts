/**
 * Competitive Trade Intelligence — reusable request-scoped evaluation context
 * (Checkpoint F, §2–§4, §76).
 *
 * Checkpoint E rebuilt the 3,304-player dynamic-market table, the 14-team
 * threat model and every manager context ONCE PER PROPOSAL (~8–12× per
 * negotiation envelope ⇒ ~700 ms). Multi-step path search would multiply that
 * again. This module precomputes every league-wide, trade-INVARIANT input ONCE
 * so proposal evaluation and path search reuse immutable shared state.
 *
 * Everything here is a function of the league SNAPSHOT only — never of a
 * specific proposed trade — so it is safe to reuse across every proposal built
 * on the same snapshot. `snapshot_identity` pins it; a different snapshot needs
 * a fresh context (there is no mutable cross-request global).
 */

import { buildMarketConsensus, type MarketConsensusTable } from "@/lib/draft/market";
import { snapshotLineage } from "@/lib/canonical/snapshot-lineage";
import type { TradeAnalysisContext } from "../context";
import { resolveTradeConfig, type TradeConfig } from "../config";
import { buildDiscoveryEvalContext, type DiscoveryEvalContext } from "../discovery/candidate-eval";
import { buildLeagueMarketEdgeTable, type LeagueMarketEdgeTable } from "./evaluate";
import { buildDynamicMarketEdges } from "./dynamic";
import { buildLeagueThreat, type LeagueThreat } from "./threat";
import { makeOwnerContextCache, type OwnerContext } from "./owner-context";
import {
  resolveCompetitiveDConfig,
  type CompetitiveDConfig,
  type PartialCompetitiveDConfig,
  type PartialCompetitiveTradeConfig,
} from "./config";
import type { MarketEdge } from "./schema";

export interface CompetitiveTradeEvaluationContext {
  ctx: TradeAnalysisContext;
  /** deterministic identity of the underlying league state (cache key) */
  snapshot_identity: string;
  /** the within-position private / market edge table (Checkpoint B) */
  market_table: LeagueMarketEdgeTable;
  /** the time-aware dynamic market edges (Checkpoint B.5) — keyed by player id */
  dynamic_edges: Map<string, MarketEdge>;
  /** forward-looking opponent threat for every manager (Checkpoint D / D.5) */
  league_threat: LeagueThreat;
  /** memoized per-manager roster context (starters, draft anchors, needs) */
  owner_context: (managerId: string) => OwnerContext;
  /** shared structural resolver for evaluateCandidate */
  discovery_eval_context: DiscoveryEvalContext;
  /** preseason ADP consensus (pure, vendored) */
  market_consensus: MarketConsensusTable;
  trade_config: TradeConfig;
  d_config: CompetitiveDConfig;
  /** instrumentation — how many times each league-wide build actually ran */
  build_counts: {
    market_table: number;
    dynamic_edges: number;
    league_threat: number;
    market_consensus: number;
  };
}

export interface BuildEvalContextOverrides {
  competitive_config?: PartialCompetitiveTradeConfig;
  d_config?: PartialCompetitiveDConfig;
}

export function buildCompetitiveTradeEvaluationContext(
  ctx: TradeAnalysisContext,
  overrides?: BuildEvalContextOverrides,
): CompetitiveTradeEvaluationContext {
  const build_counts = { market_table: 0, dynamic_edges: 0, league_threat: 0, market_consensus: 0 };

  const market_table = buildLeagueMarketEdgeTable(ctx, overrides?.competitive_config);
  build_counts.market_table += 1;

  const dyn = buildDynamicMarketEdges({
    table: market_table,
    season: ctx.season,
    as_of_week: ctx.week,
    remaining_games_expected: Math.max(1, ctx.ros.weeks.length),
    config: market_table.config,
  });
  build_counts.dynamic_edges += 1;

  const d_config = resolveCompetitiveDConfig(overrides?.d_config);
  const owner_context = makeOwnerContextCache(ctx);

  const league_threat = buildLeagueThreat(ctx, d_config, ctx.snapshot.managers[0]?.canonical_manager_id ?? "", owner_context);
  build_counts.league_threat += 1;

  const market_consensus = buildMarketConsensus({ referenceDate: ctx.snapshot.captured_at });
  build_counts.market_consensus += 1;

  let identity: string;
  try {
    identity = snapshotLineage(ctx.snapshot).league_snapshot_id;
  } catch {
    identity = `${ctx.league_slug}:${ctx.season}:w${ctx.week}:${ctx.snapshot.captured_at}`;
  }

  return {
    ctx,
    snapshot_identity: identity,
    market_table,
    dynamic_edges: dyn.by_player,
    league_threat,
    owner_context,
    discovery_eval_context: buildDiscoveryEvalContext(ctx),
    market_consensus,
    trade_config: resolveTradeConfig(),
    d_config,
    build_counts,
  };
}

/** Guard: a context may only be used with the snapshot it was built from (§74). */
export function assertContextMatchesSnapshot(
  ec: CompetitiveTradeEvaluationContext,
  ctx: TradeAnalysisContext,
): void {
  if (ec.ctx !== ctx && ec.ctx.snapshot.captured_at !== ctx.snapshot.captured_at) {
    throw new Error(
      `CompetitiveTradeEvaluationContext snapshot mismatch: context is for ${ec.snapshot_identity} / ${ec.ctx.snapshot.captured_at}, evaluation is for ${ctx.snapshot.captured_at}`,
    );
  }
}
