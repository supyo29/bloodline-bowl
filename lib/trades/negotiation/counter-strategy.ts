/**
 * Trade Engine — Phase 5E: counteroffer strategy.
 *
 * Adds strategic interpretation on top of Phase 4's local ADD/REMOVE/SWAP
 * counteroffers (`lib/trades/discovery/counteroffer.ts`) — problem
 * classification and a deterministic distance metric — without generating
 * any new package or valuation logic of its own.
 */

import type { TradeAnalysisContext } from "../context";
import type { TradeConfig } from "../config";
import { generateCounteroffers, type OriginalTransfer } from "../discovery/counteroffer";
import type { DiscoveryEvalContext } from "../discovery/candidate-eval";
import { acceptanceAtLeast } from "../discovery/config";
import type { CounterStrategyResult, NegotiationProblem } from "./types";
import { DEFAULT_NEGOTIATION_LIMITS } from "./config";

function transferKey(t: OriginalTransfer): string {
  return `${t.from_manager_id}>${t.to_manager_id}:${t.canonical_player_id}`;
}

/** assets_added + assets_removed + assets_swapped-counted-as-2 (a swap is one remove + one add on the same slot) — a simple, deterministic count. */
function distance(original: OriginalTransfer[], variant: OriginalTransfer[]): number {
  const origKeys = new Set(original.map(transferKey));
  const varKeys = new Set(variant.map(transferKey));
  let d = 0;
  for (const k of varKeys) if (!origKeys.has(k)) d += 1; // added or swapped-in
  for (const k of origKeys) if (!varKeys.has(k)) d += 1; // removed or swapped-out
  return d;
}

export interface CounterStrategyInput {
  ctx: TradeAnalysisContext;
  evalCtx: DiscoveryEvalContext;
  config: TradeConfig;
  myManagerId: string;
  myManagerSlug: string;
  originalTransfers: OriginalTransfer[];
  untouchablePlayerIds?: string[];
}

export function classifyProblem(originalMyUtility: number | null, originalPartnerAcceptance: string | null, complexity: number): NegotiationProblem {
  if (originalPartnerAcceptance != null && acceptanceAtLeast(originalPartnerAcceptance, "ACCEPT") && originalMyUtility != null && originalMyUtility > 0) {
    return "NO_CONCESSION_NEEDED";
  }
  if (originalMyUtility != null && originalMyUtility <= 0) return "REQUESTER_OVERPAY";
  if (complexity > 3) return "PACKAGE_TOO_COMPLEX";
  if (originalPartnerAcceptance != null && !acceptanceAtLeast(originalPartnerAcceptance, "NEUTRAL")) return "PARTNER_VALUE_TOO_LOW";
  return "POSITIONAL_FIT_POOR";
}

export function buildCounterStrategy(input: CounterStrategyInput): CounterStrategyResult {
  const { ctx, evalCtx, config, myManagerId, myManagerSlug, originalTransfers, untouchablePlayerIds } = input;

  const { original, counters } = generateCounteroffers({
    ctx, evalCtx, config, myManagerId, myManagerSlug, originalTransfers,
    constraints: { untouchable_player_ids: untouchablePlayerIds },
    maxResults: DEFAULT_NEGOTIATION_LIMITS.max_counter_variants * 3,
  });

  const originalMyUtility = original?.my_gain ?? null;
  const originalPartnerAcceptance = original?.participants.find((p) => p.manager_slug !== myManagerSlug)?.acceptance ?? null;
  const problem = classifyProblem(originalMyUtility, originalPartnerAcceptance, originalTransfers.length);

  if (problem === "NO_CONCESSION_NEEDED") {
    return { problem, counters: [] };
  }

  // Prefer SMALLER distance from the original offer first (never jump to an unrelated
  // package when a local repair works), breaking ties by higher requester utility.
  const ranked = counters
    .map((c) => ({ result: c, distance: distance(originalTransfers, c.transfers) }))
    .sort((a, b) => a.distance - b.distance || b.result.my_gain - a.result.my_gain)
    .slice(0, DEFAULT_NEGOTIATION_LIMITS.max_counter_variants)
    .map((x, i) => ({ rank: i + 1, distance: x.distance, result: x.result }));

  return { problem, counters: ranked };
}
