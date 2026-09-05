/**
 * Trade Engine — Phase 6G/6H: discovery/negotiation integration helpers.
 *
 * These attach a `StrategicTradeAssessment` to an already-produced
 * `TradeDiscoveryResult` (Phase 4/5's own output) — never a second
 * valuation. Base fields (`rank`, `my_gain`, `trade_viability`, offer-ladder
 * tier construction) are read, never rewritten.
 */

import type { TradeDiscoveryResult } from "../discovery/types";
import type { ManagerStrategicProfile, StrategicOfferGuidance, StrategicTradeAssessment } from "./types";
import { assessStrategicTrade } from "./adjustment";

export interface StrategicallyRankedResult {
  result: TradeDiscoveryResult;
  strategic: StrategicTradeAssessment | null;
}

/**
 * Attaches a strategic assessment to one discovery result for `managerSlug`.
 * Returns null (never a fabricated assessment) when the manager's own
 * participant record cannot be found in the canonical evaluation.
 */
export function assessDiscoveryResult(result: TradeDiscoveryResult, profile: ManagerStrategicProfile, managerSlug: string): StrategicTradeAssessment | null {
  const participant = result.full_evaluation.participants[managerSlug];
  if (!participant) return null;
  return assessStrategicTrade(profile, participant);
}

/**
 * Spec §39: `discovery_rank = base_trade_quality + strategic_fit +
 * partner_viability - complexity`. Base quality (`my_gain`) remains
 * dominant — `strategic_fit` here is `strategic_adjustment`, itself already
 * capped relative to base value (see adjustment.ts), so it can reorder
 * among comparably-good trades but cannot promote a poor one above a
 * clearly better one (see the "same base score, different strategic fit"
 * test). `partner_viability` reuses the existing `minimum_partner_gain`
 * sign as a coarse viability signal; `complexity` is transfer count.
 */
export function strategicDiscoveryRank(result: TradeDiscoveryResult, strategic: StrategicTradeAssessment | null): number {
  const baseQuality = result.my_gain;
  const strategicFit = strategic?.strategic_adjustment ?? 0;
  const partnerViability = result.minimum_partner_gain > 0 ? 0.1 : 0;
  const complexity = result.search_metadata.complexity * 0.05;
  return Math.round((baseQuality + strategicFit + partnerViability - complexity) * 1000) / 1000;
}

/**
 * Ranks a set of already-produced (base-valid) discovery results by
 * strategic fit for one manager, WITHOUT discarding or reordering the base
 * `results` array itself — callers should treat this as a secondary,
 * additive view (spec §38: "apply strategic ranking secondarily, return
 * both scores").
 */
export function rankResultsStrategically(results: TradeDiscoveryResult[], profile: ManagerStrategicProfile, managerSlug: string): StrategicallyRankedResult[] {
  return results
    .map((result) => ({ result, strategic: assessDiscoveryResult(result, profile, managerSlug) }))
    .sort((a, b) => strategicDiscoveryRank(b.result, b.strategic) - strategicDiscoveryRank(a.result, a.strategic));
}

/**
 * Phase 6H — spec §43/§44: annotates which of Phase 5's ALREADY-CONSTRUCTED
 * offer-ladder tiers best fits this manager's current urgency/archetype.
 * This NEVER redefines tier construction and NEVER selects anything outside
 * the ladder Phase 5 already produced — `exceeded_maximum_rational` is
 * always false BY CONSTRUCTION, since this function can only return a key
 * that already exists in `ladder`.
 */
export function recommendOfferTier(ladder: Partial<Record<"OPENING" | "BALANCED" | "STRONG_ACCEPT" | "MAXIMUM_RATIONAL", TradeDiscoveryResult>>, profile: ManagerStrategicProfile): StrategicOfferGuidance {
  const available = (Object.keys(ladder) as Array<keyof typeof ladder>).filter((k) => ladder[k] != null);
  if (available.length === 0) {
    return { recommended_tier: null, reasons: ["no offer-ladder tier is available to recommend from"], exceeded_maximum_rational: false };
  }
  const reasons: string[] = [];
  // High urgency (must-win/bubble teams) -> favor the tier most likely to
  // clear the partner's floor quickly (STRONG_ACCEPT if present, else the
  // most generous tier reachable). Low urgency (front-runner/contender) ->
  // favor OPENING (cheapest for the requester), consistent with Phase 5's
  // own "offer the cheapest rational package first" philosophy.
  let preferenceOrder: Array<"STRONG_ACCEPT" | "BALANCED" | "OPENING" | "MAXIMUM_RATIONAL">;
  if (profile.urgency.score >= 0.7) {
    preferenceOrder = ["STRONG_ACCEPT", "BALANCED", "MAXIMUM_RATIONAL", "OPENING"];
    reasons.push(`high urgency (${profile.urgency.score.toFixed(2)}) for a ${profile.archetype} team favors a faster-to-accept offer over the cheapest opening bid`);
  } else if (profile.urgency.score <= 0.3) {
    preferenceOrder = ["OPENING", "BALANCED", "STRONG_ACCEPT", "MAXIMUM_RATIONAL"];
    reasons.push(`low urgency (${profile.urgency.score.toFixed(2)}) for a ${profile.archetype} team favors starting with the cheapest rational offer`);
  } else {
    preferenceOrder = ["BALANCED", "OPENING", "STRONG_ACCEPT", "MAXIMUM_RATIONAL"];
    reasons.push(`moderate urgency (${profile.urgency.score.toFixed(2)}) favors a balanced offer`);
  }
  const recommended = preferenceOrder.find((t) => available.includes(t)) ?? available[0]!;
  reasons.push(`recommended tier: ${recommended} (of ${available.join(", ")} available on this ladder)`);
  return { recommended_tier: recommended, reasons, exceeded_maximum_rational: false };
}
