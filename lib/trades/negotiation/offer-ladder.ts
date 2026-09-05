/**
 * Trade Engine — Phase 5B: the offer ladder.
 *
 * Reuses Phase 4's bilateral search funnel verbatim (`runBilateralSearch`) to
 * generate every candidate package that acquires the target player, then
 * applies the Pareto frontier (`pareto.ts`) to select OPENING/BALANCED/
 * STRONG_ACCEPT/MAXIMUM_RATIONAL. No new package-generation or valuation
 * logic exists in this file — it is a selection layer over Phase 4's
 * already-canonical candidates.
 *
 * Partner-acceptance floor: the ladder must be able to reach a genuine
 * OPENING offer down to RELUCTANT (per the Phase 5 spec's `OPENING_PARTNER_FLOOR`)
 * — looser than `BEST_AVAILABLE`'s own NEUTRAL default. Rather than duplicate
 * `runBilateralSearch`'s floor logic, this module runs the search under
 * Phase 4's existing `"BLOCKBUSTER"` mode, whose documented floor is
 * RELUCTANT (`partnerAcceptanceFloor` in `lib/trades/discovery/config.ts`) —
 * the exact floor this module needs, already implemented and tested. Every
 * returned candidate's OWN tier label (OPENING/BALANCED/...) comes from
 * `selectOfferTiers` below, not from the underlying search mode string.
 */

import type { TradeAnalysisContext } from "../context";
import type { TradeConfig } from "../config";
import { runBilateralSearch } from "../discovery/bilateral";
import type { DiscoveryEvalContext } from "../discovery/candidate-eval";
import type { TradeDiscoveryResult } from "../discovery/types";
import { DEFAULT_SEARCH_LIMITS } from "../discovery/config";
import { paretoFrontier, selectOfferTiers } from "./pareto";
import type { OfferTier } from "./types";

export interface BuildOfferLadderInput {
  ctx: TradeAnalysisContext;
  evalCtx: DiscoveryEvalContext;
  config: TradeConfig;
  myManagerId: string;
  myManagerSlug: string;
  ownerManagerId: string;
  targetPlayerId: string;
  untouchablePlayerIds?: string[];
}

export interface OfferLadderOutput {
  candidates_considered: number;
  frontier_size: number;
  ladder: Partial<Record<OfferTier, TradeDiscoveryResult>>;
}

export function buildOfferLadder(input: BuildOfferLadderInput): OfferLadderOutput {
  const { ctx, evalCtx, config, myManagerId, myManagerSlug, ownerManagerId, targetPlayerId, untouchablePlayerIds } = input;

  const { results } = runBilateralSearch({
    ctx, evalCtx, config, mode: "BLOCKBUSTER", myManagerId, myManagerSlug, limits: DEFAULT_SEARCH_LIMITS, maxResults: 25,
    constraints: {
      required_incoming_player_ids: [targetPlayerId],
      allowed_trade_partner_ids: [ownerManagerId],
      untouchable_player_ids: untouchablePlayerIds,
    },
  });

  const frontier = paretoFrontier(results, myManagerSlug);
  const ladder = selectOfferTiers(frontier, myManagerSlug);
  return { candidates_considered: results.length, frontier_size: frontier.length, ladder };
}
