/**
 * Competitive Trade Intelligence — sell-side & buy-side boards (Checkpoint B).
 *
 * Pure projection of a `MarketEdgeTable` onto two lists:
 *   sell board — OUR roster, ordered by how far outside-market pricing exceeds
 *                our private valuation (potential trade leverage).
 *   buy  board — OTHER rosters, ordered by trustworthy positive private-vs-market
 *                discrepancy (a model bargain).
 *
 * A SELL signal means "market > private, enough to create leverage" — NOT drop,
 * NOT trade now, NOT "player is bad". A BUY signal means "we think the market
 * undervalues him" — NOT "the owner will sell" and NOT an acquisition price.
 * Every entry carries `status: "ANALYTICAL_ONLY"`.
 */

import type { CompetitiveTradeConfig } from "./config";
import type {
  BuyBoardEntry,
  BuySignal,
  MarketEdge,
  SellBoardEntry,
  SellSignal,
} from "./schema";
import type { MarketEdgeTable } from "./market-edge";

function sellSignal(edge: MarketEdge, config: CompetitiveTradeConfig): SellSignal {
  if (edge.direction === "INSUFFICIENT_DATA") return "INSUFFICIENT_DATA";
  if (edge.edge_score == null) return "INSUFFICIENT_DATA";
  // sell-side ⇒ market above private ⇒ edge_score < 0
  if (edge.direction === "STRONG_SELL") return "STRONG_MARKET_SELL";
  if (edge.direction === "SELL") return "MARKET_SELL";
  if (edge.edge_score >= config.edge_bands.fair_band) return "HOLD_SIGNAL"; // private clearly above market
  return "FAIR";
}

function buySignal(edge: MarketEdge, config: CompetitiveTradeConfig): BuySignal {
  if (edge.direction === "INSUFFICIENT_DATA") return "INSUFFICIENT_DATA";
  if (edge.edge_score == null) return "INSUFFICIENT_DATA";
  if (edge.direction === "STRONG_BUY") return "STRONG_MODEL_BUY_CANDIDATE";
  if (edge.direction === "BUY") return "MODEL_BUY_CANDIDATE";
  if (edge.edge_score <= -config.edge_bands.fair_band) return "NO_DISCOUNT";
  return "FAIR";
}

export interface BuildBoardsInput {
  edges: MarketEdgeTable;
  /** canonical_player_id → canonical_team_id */
  ownership: Map<string, string>;
  /** OUR canonical_team_id */
  my_team_id: string;
  /** canonical_team_id → { manager_id, manager_slug } */
  team_owner: Map<string, { manager_id: string; manager_slug: string }>;
  config: CompetitiveTradeConfig;
  /** include FAIR / HOLD_SIGNAL / NO_DISCOUNT entries too (default false — only signal-bearing rows) */
  include_neutral?: boolean;
}

export interface Boards {
  sell_board: SellBoardEntry[];
  buy_board: BuyBoardEntry[];
}

export function buildBoards(input: BuildBoardsInput): Boards {
  const { edges, ownership, my_team_id, team_owner, config, include_neutral } = input;

  const sell: SellBoardEntry[] = [];
  const buy: BuyBoardEntry[] = [];

  for (const [cid, edge] of edges.by_player) {
    const teamId = ownership.get(cid);
    if (!teamId) continue;

    if (teamId === my_team_id) {
      const signal = sellSignal(edge, config);
      const keep = include_neutral || signal === "STRONG_MARKET_SELL" || signal === "MARKET_SELL";
      if (keep) sell.push({ edge, signal, status: "ANALYTICAL_ONLY" });
    } else {
      const owner = team_owner.get(teamId);
      if (!owner) continue;
      const signal = buySignal(edge, config);
      const keep = include_neutral || signal === "STRONG_MODEL_BUY_CANDIDATE" || signal === "MODEL_BUY_CANDIDATE";
      if (keep) {
        buy.push({
          edge,
          owner_manager_id: owner.manager_id,
          owner_manager_slug: owner.manager_slug,
          signal,
          status: "ANALYTICAL_ONLY",
        });
      }
    }
  }

  // sell: most negative actionable_edge first (biggest market-over-private gap)
  sell.sort(
    (a, b) =>
      (a.edge.actionable_edge ?? 0) - (b.edge.actionable_edge ?? 0) ||
      a.edge.canonical_player_id.localeCompare(b.edge.canonical_player_id),
  );
  // buy: most positive actionable_edge first
  buy.sort(
    (a, b) =>
      (b.edge.actionable_edge ?? 0) - (a.edge.actionable_edge ?? 0) ||
      a.edge.canonical_player_id.localeCompare(b.edge.canonical_player_id),
  );

  return { sell_board: sell, buy_board: buy };
}
