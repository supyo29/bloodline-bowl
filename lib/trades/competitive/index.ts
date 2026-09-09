/**
 * Competitive Trade Intelligence — public surface (Checkpoint B).
 *
 * Everything the future API route (`POST /api/trades/competitive`, settled in
 * the Checkpoint B doc, wired in Checkpoint G) and the live smoke consume.
 */

export { COMPETITIVE_TRADE_VERSION } from "./schema";
export type {
  CompetitiveTradeEvaluation,
  CompetitiveBlock,
  CompetitiveReadiness,
  MarketEdge,
  MarketEdgeDirection,
  MarketLineage,
  NormalizedValue,
  SellBoardEntry,
  BuyBoardEntry,
  SellSignal,
  BuySignal,
} from "./schema";

export {
  DEFAULT_COMPETITIVE_TRADE_CONFIG,
  resolveCompetitiveTradeConfig,
  type CompetitiveTradeConfig,
  type PartialCompetitiveTradeConfig,
} from "./config";

export {
  evaluateCompetitiveTrade,
  buildLeagueMarketEdgeTable,
  leagueUniverse,
  pprModeOf,
  type LeagueMarketEdgeTable,
  type EvaluateCompetitiveTradeInput,
} from "./evaluate";

export { buildMarketEdges, type MarketEdgeTable } from "./market-edge";
export { buildBoards, type Boards, type BuildBoardsInput } from "./boards";
export { assessCompetitiveTradeReadiness } from "./readiness";
export {
  generateStructuralTradeCandidates,
  legacyMutualBenefitWouldKeep,
  type StructuralCandidate,
} from "./candidates";

import type { TradeAnalysisContext } from "../context";
import { buildLeagueMarketEdgeTable } from "./evaluate";
import { buildBoards, type Boards } from "./boards";
import type { PartialCompetitiveTradeConfig } from "./config";
import type { CompetitiveReadiness } from "./schema";
import { COMPETITIVE_TRADE_VERSION } from "./schema";
import { assessCompetitiveTradeReadiness } from "./readiness";

export interface CompetitiveMarketReport {
  version: string;
  as_of: string;
  ppr_mode: string;
  readiness: CompetitiveReadiness;
  boards: Boards;
  /** every league-wide edge, ordered by |actionable_edge| desc (analytical). */
  ranked_edges: import("./schema").MarketEdge[];
  notes: string[];
}

/**
 * League-wide market-edge report for one manager: sell board (our roster),
 * buy board (other rosters), and the ranked edge list. ANALYTICAL ONLY.
 */
export function buildCompetitiveMarketReport(
  ctx: TradeAnalysisContext,
  myManagerId: string,
  override?: PartialCompetitiveTradeConfig,
): CompetitiveMarketReport {
  const table = buildLeagueMarketEdgeTable(ctx, override);

  const teamOwner = new Map<string, { manager_id: string; manager_slug: string }>();
  let myTeamId = "";
  for (const team of ctx.snapshot.teams) {
    const mid = team.canonical_manager_ids[0];
    if (!mid) continue;
    const slug = ctx.snapshot.managers.find((m) => m.canonical_manager_id === mid)?.manager_slug ?? mid;
    teamOwner.set(team.canonical_team_id, { manager_id: mid, manager_slug: slug });
    if (mid === myManagerId) myTeamId = team.canonical_team_id;
  }
  const ownership = new Map<string, string>();
  for (const r of ctx.snapshot.rosters) for (const id of r.all_players) ownership.set(id, r.canonical_team_id);

  const boards = buildBoards({
    edges: table.edges,
    ownership,
    my_team_id: myTeamId,
    team_owner: teamOwner,
    config: table.config,
  });

  const focus = [...table.edges.by_player.keys()];
  const readiness = assessCompetitiveTradeReadiness({
    projections: ctx.projections,
    market_snapshots: table.market_snapshots,
    players_by_id: ctx.players_by_id,
    focus_player_ids: focus,
    ownership_known: ownership.size > 0,
    manager_identity_known: Boolean(myTeamId),
    ppr_mode: table.ppr_mode,
  });

  const ranked_edges = [...table.edges.by_player.values()]
    .filter((e) => e.actionable_edge != null)
    .sort(
      (a, b) =>
        Math.abs(b.actionable_edge ?? 0) - Math.abs(a.actionable_edge ?? 0) ||
        a.canonical_player_id.localeCompare(b.canonical_player_id),
    );

  return {
    version: COMPETITIVE_TRADE_VERSION,
    as_of: ctx.snapshot.captured_at,
    ppr_mode: table.ppr_mode,
    readiness,
    boards,
    ranked_edges,
    notes: [
      "ANALYTICAL_ONLY — market edge shows where our model and outside-market pricing disagree. It does not model owner perception, acquisition price, acceptance, opponent cost, liquidity or appreciation (Checkpoint C+).",
    ],
  };
}
