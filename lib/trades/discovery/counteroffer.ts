/**
 * Trade Engine — Phase 4F: counteroffer generation.
 *
 * Given an existing proposal, searches LOCAL modifications only (add one
 * asset, remove one asset, swap one asset) — never a full league-wide
 * re-discovery. Every variant still goes through the same canonical
 * evaluator as everything else in this module.
 */

import type { TradeAnalysisContext } from "../context";
import type { TradeConfig } from "../config";
import type { AssetValue, TradeDiscoveryResult, TradeSearchConstraints } from "./types";
import { evaluateCandidate, type DiscoveryEvalContext } from "./candidate-eval";
import { buildDiscoveryResult, rankResults } from "./rank";
import { weeklyVOR } from "@/lib/weekly/replacement";

export interface OriginalTransfer {
  from_manager_id: string;
  to_manager_id: string;
  canonical_player_id: string;
}

function rosterAssets(managerId: string, ctx: TradeAnalysisContext): AssetValue[] {
  const roster = ctx.rosters_by_manager.get(managerId);
  if (!roster) return [];
  const reserve = new Set([...roster.ir, ...roster.taxi]);
  const out: AssetValue[] = [];
  for (const id of roster.all_players) {
    if (reserve.has(id)) continue;
    const p = ctx.players_by_id.get(id);
    if (!p) continue;
    const pts = ctx.projections.by_player.get(id)?.projected_points ?? null;
    const v = weeklyVOR(id, p.position, pts, ctx.replacement);
    out.push({ canonical_player_id: id, position: p.position, starter_vor: v.vor, projected_points: pts, is_current_starter: roster.starters.includes(id) });
  }
  return out;
}

function transfersEqual(a: OriginalTransfer[], b: OriginalTransfer[]): boolean {
  if (a.length !== b.length) return false;
  const key = (t: OriginalTransfer) => `${t.from_manager_id}>${t.to_manager_id}:${t.canonical_player_id}`;
  const as = new Set(a.map(key));
  return b.every((t) => as.has(key(t)));
}

export interface CounterofferOptions {
  ctx: TradeAnalysisContext;
  evalCtx: DiscoveryEvalContext;
  config: TradeConfig;
  myManagerId: string;
  myManagerSlug: string;
  originalTransfers: OriginalTransfer[];
  constraints?: TradeSearchConstraints;
  maxResults: number;
}

/** Generates and evaluates local variants of `originalTransfers`; also includes the ORIGINAL itself (rank 0 candidate) for comparison. */
export function generateCounteroffers(opts: CounterofferOptions): { original: TradeDiscoveryResult | null; counters: TradeDiscoveryResult[] } {
  const { ctx, evalCtx, config, myManagerId, myManagerSlug, originalTransfers, constraints } = opts;
  const participantIds = [...new Set(originalTransfers.flatMap((t) => [t.from_manager_id, t.to_manager_id]))];
  const untouchable = new Set(constraints?.untouchable_player_ids ?? []);
  const hardConstraints = { requesterManagerId: myManagerId, constraints };

  // The ORIGINAL proposal is evaluated WITHOUT the hard-constraint gate — it's shown for
  // comparison regardless of whether it happens to satisfy `constraints` (e.g. an untouchable
  // added to the search request after a trade was already proposed); only the GENERATED
  // variants below are required to satisfy it.
  const originalEval = evaluateCandidate(participantIds, originalTransfers, ctx, evalCtx, config);
  const original = buildDiscoveryResult(myManagerSlug, { shape: originalTransfers.length <= 2 ? "ONE_FOR_ONE" : "TWO_FOR_ONE", transfers: originalTransfers, participant_manager_ids: participantIds }, originalEval, "BEST_AVAILABLE", null, undefined, undefined);

  const assetPoolByManager = new Map<string, AssetValue[]>(participantIds.map((id) => [id, rosterAssets(id, ctx)]));
  const variants: OriginalTransfer[][] = [];

  // REMOVE: drop each transfer, one at a time (only if 2+ transfers remain — a trade needs at least one asset moving each way to stay meaningful)
  if (originalTransfers.length > 1) {
    for (let i = 0; i < originalTransfers.length; i += 1) {
      const withoutI = originalTransfers.filter((_, idx) => idx !== i);
      if (withoutI.length > 0) variants.push(withoutI);
    }
  }

  // SWAP: replace each transfer's player with up to 2 alternatives from the same giver, same position, not untouchable, not already in the deal
  const inDeal = new Set(originalTransfers.map((t) => t.canonical_player_id));
  for (let i = 0; i < originalTransfers.length; i += 1) {
    const t = originalTransfers[i]!;
    if (untouchable.has(t.canonical_player_id)) continue;
    const giverAssets = assetPoolByManager.get(t.from_manager_id) ?? [];
    const originalPos = ctx.players_by_id.get(t.canonical_player_id)?.position;
    const alternatives = giverAssets
      .filter((a) => a.position === originalPos && a.canonical_player_id !== t.canonical_player_id && !inDeal.has(a.canonical_player_id) && !untouchable.has(a.canonical_player_id))
      .sort((a, b) => (b.starter_vor ?? -Infinity) - (a.starter_vor ?? -Infinity))
      .slice(0, 2);
    for (const alt of alternatives) {
      const swapped = originalTransfers.map((ot, idx) => (idx === i ? { ...ot, canonical_player_id: alt.canonical_player_id } : ot));
      variants.push(swapped);
    }
  }

  // ADD: sweeten the deal by adding one more expendable asset from each side (up to 1 addition per side)
  for (const giverId of participantIds) {
    const receiverCandidates = participantIds.filter((id) => id !== giverId);
    const giverAssets = (assetPoolByManager.get(giverId) ?? []).filter((a) => !a.is_current_starter && !inDeal.has(a.canonical_player_id) && !untouchable.has(a.canonical_player_id));
    if (giverAssets.length === 0) continue;
    const add = giverAssets.sort((a, b) => (b.starter_vor ?? -Infinity) - (a.starter_vor ?? -Infinity))[0]!;
    for (const receiverId of receiverCandidates) {
      variants.push([...originalTransfers, { from_manager_id: giverId, to_manager_id: receiverId, canonical_player_id: add.canonical_player_id }]);
    }
  }

  const seen = new Set<string>();
  const results: TradeDiscoveryResult[] = [];
  for (const variant of variants) {
    if (transfersEqual(variant, originalTransfers)) continue;
    const key = variant.map((t) => `${t.from_manager_id}>${t.to_manager_id}:${t.canonical_player_id}`).sort().join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    const evaluated = evaluateCandidate(participantIds, variant, ctx, evalCtx, config, hardConstraints);
    const result = buildDiscoveryResult(myManagerSlug, { shape: variant.length <= 2 ? "ONE_FOR_ONE" : "TWO_FOR_ONE", transfers: variant, participant_manager_ids: participantIds }, evaluated, "BEST_AVAILABLE", null, undefined, undefined);
    if (result) results.push(result);
  }

  return { original, counters: rankResults(results).slice(0, opts.maxResults) };
}
