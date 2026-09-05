/**
 * Trade Engine — Phase 5F: walk-away analysis.
 *
 * Derives a walk-away boundary from the SAME offer ladder already built —
 * no new evaluation, no fabricated "market price." Reasons are structural
 * facts read from real Phase 1/2 fields on the MAXIMUM_RATIONAL candidate
 * (or the absence of any viable candidate at all).
 */

import type { TradeDiscoveryResult } from "../discovery/types";
import type { PlayerDependency, WalkAwayAnalysis, WalkAwayReason } from "./types";

export interface WalkAwayInput {
  ladder: Partial<Record<"OPENING" | "BALANCED" | "STRONG_ACCEPT" | "MAXIMUM_RATIONAL", TradeDiscoveryResult>>;
  myManagerSlug: string;
  /** dependency classification for every REQUESTER-outgoing asset across the ladder's candidates */
  outgoingDependencies: PlayerDependency[];
  /** true if every viable candidate requires giving up an asset the caller explicitly marked untouchable-adjacent (a CORE dependency) */
  fragilityDeltaThreshold?: number;
}

const DEFAULT_FRAGILITY_THRESHOLD = -2;

export function analyzeWalkAway(input: WalkAwayInput): WalkAwayAnalysis {
  const { ladder, outgoingDependencies } = input;
  const fragilityThreshold = input.fragilityDeltaThreshold ?? DEFAULT_FRAGILITY_THRESHOLD;
  const reasons: WalkAwayReason[] = [];
  const maxRational = ladder.MAXIMUM_RATIONAL ?? ladder.STRONG_ACCEPT ?? ladder.BALANCED ?? ladder.OPENING ?? null;

  if (!maxRational) {
    reasons.push("NEGATIVE_REQUESTER_UTILITY");
    return { trigger: "No candidate package clears the requester's own positive-utility floor.", reasons, maximum_rational_offer: null };
  }

  if (maxRational.my_gain <= 0) reasons.push("NEGATIVE_REQUESTER_UTILITY");

  const coreDependencies = outgoingDependencies.filter((d) => d.dependency === "CORE");
  if (coreDependencies.length > 0) reasons.push("CORE_ASSET_REQUIRED");

  const mine = Object.values(maxRational.full_evaluation.participants).find((p) => p.manager_slug === input.myManagerSlug);
  if (mine?.phase2 && mine.phase2.depth.fragility_delta < fragilityThreshold) reasons.push("FRAGILITY_TOO_HIGH");
  if (mine?.phase2 && mine.phase2.depth.usable_depth_delta < fragilityThreshold) reasons.push("DEPTH_COLLAPSE");

  if (maxRational.search_metadata.complexity > 3) reasons.push("PARTNER_PRICE_TOO_HIGH");

  const trigger =
    reasons.length === 0
      ? "No walk-away condition triggered within the searched candidate set — the maximum rational offer remains a reasonable, low-risk package."
      : `Walk away beyond the maximum rational offer if: ${reasons.join(", ")}.`;

  return { trigger, reasons, maximum_rational_offer: maxRational };
}
