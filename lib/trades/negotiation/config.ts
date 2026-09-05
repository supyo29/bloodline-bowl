/**
 * Trade Engine — Phase 5 configuration and thresholds. Every threshold here
 * is documented and rules-based — none is learned or calibrated (trade-level
 * calibration remains deferred, see `lib/trades/data-readiness.ts`).
 */

export const TRADE_NEGOTIATION_VERSION = "ri-trade-negotiation-2026.1" as const;

/** OPENING offers must clear at least this partner acceptance floor — deliberately low, but never below RELUCTANT (never an insulting lowball by default). */
export const OPENING_PARTNER_FLOOR = "RELUCTANT" as const;

/** Minimum sample requirements for `ManagerBehaviorEvidence.confidence` — conservative, documented, never auto-promoted to authoritative. */
export function behavioralConfidence(completedTradeCount: number): "INSUFFICIENT" | "LOW" | "MEDIUM" | "HIGH" {
  if (completedTradeCount <= 2) return "INSUFFICIENT";
  if (completedTradeCount <= 5) return "LOW";
  if (completedTradeCount <= 10) return "MEDIUM"; // "still exploratory" per the Phase 5 spec — MEDIUM is not authoritative, see behavior.ts
  return "HIGH"; // 10+ — "possible behavioral review," still never auto-authoritative; see behavior.ts's status field
}

/** Concession-efficiency thresholds (partner_utility_gain / requester_utility_cost). Documented, not tuned against outcomes — there are no real outcomes to tune against yet. */
export const SWEETENER_THRESHOLDS = {
  /** requester cost below this is "CHEAP" regardless of partner gain */
  cheap_max_cost: 0.5,
  /** efficiency (gain/cost) at or above this is "EFFICIENT" */
  efficient_min_ratio: 2.0,
  /** efficiency at or above this (but below EFFICIENT's cost bar) is "MEANINGFUL" */
  meaningful_min_ratio: 1.0,
  /** below this efficiency, and above cheap_max_cost, the sweetener costs more than it helps: DO_NOT_ADD */
} as const;

/** Requester-side dependency thresholds, in weekly points (current-week leave-one-out optimal-lineup delta). */
export const DEPENDENCY_THRESHOLDS = {
  core_min_impact: 6,
  important_min_impact: 2,
  replaceable_min_impact: 0.5,
  // below replaceable_min_impact -> SURPLUS
} as const;

export interface NegotiationLimits {
  max_candidates_considered: number;
  max_offer_ladder_size: number;
  max_sweetener_candidates: number;
  max_counter_variants: number;
  max_alternative_targets: number;
}

export const DEFAULT_NEGOTIATION_LIMITS: NegotiationLimits = {
  max_candidates_considered: 40,
  max_offer_ladder_size: 4,
  max_sweetener_candidates: 6,
  max_counter_variants: 3,
  max_alternative_targets: 3,
};
