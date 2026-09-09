/**
 * Competitive Trade Intelligence — `evaluateCompetitiveTrade` (Checkpoint B).
 *
 * A WRAPPER. It never calls into `evaluateTrade`'s implementation and never
 * mutates its output. It takes a finished `TradeEvaluationOutput` as `baseline`
 * and returns `{ baseline, competitive }`. Legacy callers of `evaluateTrade`
 * are completely unaffected — they never touch this module.
 *
 * Checkpoint B populates ONLY the market-edge block. Owner perception,
 * acceptance, extraction, competitive cost, liquidity, appreciation and
 * negotiation are later checkpoints and are ABSENT from the output, not stubbed.
 */

import type { TradeAnalysisContext } from "../context";
import type { TradeEvaluationOutput } from "../evaluate";
import {
  resolveCompetitiveTradeConfig,
  type PartialCompetitiveTradeConfig,
  type CompetitiveTradeConfig,
} from "./config";
import { COMPETITIVE_TRADE_VERSION } from "./schema";
import type {
  AggregateEdge,
  CompetitiveBlock,
  CompetitivePlayerValue,
  CompetitiveTradeEvaluation,
  MarketEdge,
  ValueConfidence,
} from "./schema";
import { buildPrivateValues } from "./private-value";
import { buildTradeMarketSnapshot, type PprMode, type PlayerMarketSnapshot } from "./market/snapshot";
import { buildMarketEdges, type MarketEdgeTable } from "./market-edge";
import { assessCompetitiveTradeReadiness } from "./readiness";

export function pprModeOf(rawScoring: Record<string, number>): PprMode {
  const rec = rawScoring.rec ?? 0;
  if (rec >= 0.9) return "PPR";
  if (rec >= 0.4) return "HALF_PPR";
  if (rec === 0) return "STANDARD";
  return "UNKNOWN";
}

/** The league player universe used for within-position normalization. */
export function leagueUniverse(ctx: TradeAnalysisContext): string[] {
  const ids = new Set<string>();
  for (const roster of ctx.rosters_by_manager.values()) for (const id of roster.all_players) ids.add(id);
  for (const id of ctx.projections.by_player.keys()) ids.add(id);
  return [...ids];
}

export interface LeagueMarketEdgeTable {
  edges: MarketEdgeTable;
  market_snapshots: Map<string, PlayerMarketSnapshot>;
  config: CompetitiveTradeConfig;
  ppr_mode: PprMode;
  universe: string[];
}

/**
 * Build the league-wide market-edge table ONCE. Reused by
 * `evaluateCompetitiveTrade`, the sell/buy boards, and the live smoke — the
 * per-player value calculations are memoized in this single table so a
 * discovery sweep never recomputes them per candidate.
 */
export function buildLeagueMarketEdgeTable(
  ctx: TradeAnalysisContext,
  override?: PartialCompetitiveTradeConfig,
): LeagueMarketEdgeTable {
  const config = resolveCompetitiveTradeConfig(override);
  const universe = leagueUniverse(ctx);
  const ppr_mode = pprModeOf(ctx.scoring.raw_scoring);
  const as_of_iso = ctx.snapshot.captured_at;
  const remaining_weeks = Math.max(1, ctx.ros.weeks.length);

  const manager_slug_by_id = new Map(ctx.snapshot.managers.map((m) => [m.canonical_manager_id, m.manager_slug]));

  const privateValues = buildPrivateValues({
    projections: ctx.projections,
    replacement: ctx.replacement,
    players_by_id: ctx.players_by_id,
    universe,
    as_of_iso,
  });

  const marketSnapshots = buildTradeMarketSnapshot({
    projections: ctx.projections,
    replacement: ctx.replacement,
    players_by_id: ctx.players_by_id,
    draft_picks: ctx.snapshot.draft_picks,
    manager_slug_by_id,
    as_of_iso,
    remaining_weeks,
    ppr_mode,
    config,
    universe,
  });

  const edges = buildMarketEdges({
    private_values: privateValues,
    market_snapshots: marketSnapshots,
    players_by_id: ctx.players_by_id,
    universe,
    config,
  });

  return { edges, market_snapshots: marketSnapshots, config, ppr_mode, universe };
}

export interface EvaluateCompetitiveTradeInput {
  baseline: TradeEvaluationOutput;
  ctx: TradeAnalysisContext;
  my_manager_id: string;
  incoming_player_ids: string[];
  outgoing_player_ids: string[];
  config?: PartialCompetitiveTradeConfig;
  /** reuse a league-wide table instead of rebuilding (discovery sweeps) */
  precomputed?: LeagueMarketEdgeTable;
}

const CONF_LEVEL: Record<ValueConfidence, number> = { HIGH: 3, MEDIUM: 2, LOW: 1, VERY_LOW: 0 };
const LEVEL_CONF: ValueConfidence[] = ["VERY_LOW", "LOW", "MEDIUM", "HIGH"];

export function evaluateCompetitiveTrade(input: EvaluateCompetitiveTradeInput): CompetitiveTradeEvaluation {
  const { baseline, ctx, incoming_player_ids, outgoing_player_ids } = input;
  const table = input.precomputed ?? buildLeagueMarketEdgeTable(ctx, input.config);

  const focus = [...new Set([...incoming_player_ids, ...outgoing_player_ids])];

  const readiness = assessCompetitiveTradeReadiness({
    projections: ctx.projections,
    market_snapshots: table.market_snapshots,
    players_by_id: ctx.players_by_id,
    focus_player_ids: focus,
    ownership_known: ctx.rosters_by_manager.size > 0,
    manager_identity_known: ctx.snapshot.managers.some((m) => m.canonical_manager_id === input.my_manager_id),
    ppr_mode: table.ppr_mode,
  });

  const edgeFor = (id: string): MarketEdge =>
    table.edges.by_player.get(id) ?? fallbackInsufficientEdge(id, ctx);

  const outgoing = outgoing_player_ids.map(edgeFor);
  const incoming = incoming_player_ids.map(edgeFor);

  const toPlayerValue = (e: MarketEdge, dir: "INCOMING" | "OUTGOING"): CompetitivePlayerValue => ({
    canonical_player_id: e.canonical_player_id,
    name: e.name,
    position: e.position,
    nfl_team: e.nfl_team,
    direction_for_us: dir,
    edge: e,
  });

  const notes: string[] = [
    "Checkpoint B — market edge only. This block tells us where our valuation differs from outside-market pricing; it does NOT model what any specific owner would accept, an acquisition price, acceptance likelihood, opponent competitive cost, liquidity or appreciation. Those are later checkpoints.",
  ];
  if (readiness.overall !== "READY") notes.push(readiness.summary);

  const aggregate_edge: AggregateEdge | null =
    readiness.overall === "UNAVAILABLE"
      ? null
      : buildAggregate(incoming, outgoing);

  const competitive: CompetitiveBlock = {
    version: COMPETITIVE_TRADE_VERSION,
    readiness,
    assets: {
      outgoing: outgoing.map((e) => toPlayerValue(e, "OUTGOING")),
      incoming: incoming.map((e) => toPlayerValue(e, "INCOMING")),
    },
    market_edge: {
      outgoing,
      incoming,
      aggregate_edge,
    },
    notes,
  };

  return { baseline, competitive };
}

function buildAggregate(incoming: MarketEdge[], outgoing: MarketEdge[]): AggregateEdge {
  const inActionable = incoming.reduce((s, e) => s + (e.actionable_edge ?? 0), 0);
  const outActionable = outgoing.reduce((s, e) => s + (e.actionable_edge ?? 0), 0);
  const all = [...incoming, ...outgoing];
  const withData = all.filter((e) => e.direction !== "INSUFFICIENT_DATA").length;
  const missing = all.length - withData;

  // aggregate confidence = min confidence among assets that have data (fail-safe: VERY_LOW if none)
  const levels = all.filter((e) => e.direction !== "INSUFFICIENT_DATA").map((e) => CONF_LEVEL[e.confidence]);
  const conf = levels.length > 0 ? LEVEL_CONF[Math.min(...levels)]! : "VERY_LOW";

  return {
    incoming_actionable_edge: round4(inActionable),
    outgoing_actionable_edge: round4(outActionable),
    net_actionable_edge: round4(inActionable - outActionable),
    players_with_market_data: withData,
    players_missing_market_data: missing,
    confidence: conf,
  };
}

function fallbackInsufficientEdge(id: string, ctx: TradeAnalysisContext): MarketEdge {
  const p = ctx.players_by_id.get(id);
  return {
    canonical_player_id: id,
    name: p?.full_name ?? id,
    position: p?.position ?? "UNKNOWN",
    nfl_team: p?.nfl_team ?? null,
    private_value: {
      basis: "unavailable",
      raw: null,
      normalized_value: null,
      percentile: null,
      position_rank: null,
      confidence: "VERY_LOW",
      as_of: ctx.snapshot.captured_at,
      model_version: null,
    },
    market_value: null,
    direction: "INSUFFICIENT_DATA",
    edge_score: null,
    actionable_edge: null,
    confidence: "VERY_LOW",
    reason_codes: ["PRIVATE_VALUE_UNAVAILABLE", "MARKET_DATA_UNAVAILABLE", "ANALYTICAL_ONLY_NO_ACQUISITION_MODEL"],
    reasons: [`Player ${id} is not in the league normalization universe — no competitive value.`],
    lineage: {
      sources: [],
      primary_source_type: null,
      usable_source_count: 0,
      dispersion: 0,
      worst_readiness: "UNAVAILABLE",
      scoring_normalization: "player not in universe",
    },
    analytical_only: true,
  };
}

function round4(v: number): number {
  const r = Math.round(v * 10000) / 10000;
  return r === 0 ? 0 : r;
}
