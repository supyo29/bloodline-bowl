/**
 * Trade Engine — Phase 5: negotiation intelligence and offer strategy.
 *
 * CORE INVARIANT (repeated everywhere it matters — see negotiate.ts):
 * negotiation intelligence reasons about incentives, leverage, roster fit,
 * and offer structure, but it NEVER redefines trade value. Every offer,
 * counter, sweetener, and walk-away boundary in this module is a real,
 * canonically-evaluated candidate from `lib/trades/discovery/candidate-eval.ts`
 * (the same `validateTrade`/`evaluateTrade` pair every other phase uses).
 * There is no negotiation-only scoring model.
 *
 * HONESTY RULE: negotiation intelligence != acceptance probability. Nothing
 * in this module outputs a percentage or a probability. Structural labels
 * (CORE/IMPORTANT/REPLACEABLE/SURPLUS, HIGH/MODERATE/LOW/NONE leverage) are
 * derived from real, already-computed Phase 1/2 roster mechanics — never
 * from psychology, personality, or unobserved manager behavior. Behavioral
 * intelligence (`ManagerBehaviorEvidence`) is a framework only; with 1 real
 * historical trade in this repository (`lib/trades/data-readiness.ts`), its
 * status is `INSUFFICIENT_DATA` for every manager today.
 */

import type { AcceptanceClass, TradeViability } from "../schema";
import type { TradeDiscoveryResult } from "../discovery/types";

export type DependencyClass = "CORE" | "IMPORTANT" | "REPLACEABLE" | "SURPLUS";

export interface PlayerDependency {
  canonical_player_id: string;
  dependency: DependencyClass;
  /** current-week leave-one-out optimal-lineup delta on the OWNER's roster (positive = owner loses this many points by losing the player) */
  marginal_starter_impact: number | null;
  /** positional severity at the player's position AFTER removal (computePositionalNeeds, unchanged) */
  severity_after_removal: "critical" | "weak" | "adequate" | "strong" | null;
  is_current_starter: boolean;
  reasons: string[];
}

export type LeverageLevel = "HIGH" | "MODERATE" | "LOW" | "NONE";

export interface LeverageAnalysis {
  level: LeverageLevel;
  score: number;
  components: {
    need_match: number;
    surplus_match: number;
    replacement_pressure: number;
    alternative_partner_count: number;
    target_owner_depth: number;
  };
  reasons: string[];
}

export type RosterPressureDiagnostic =
  | "POSITIONAL_HOLE"
  | "DEPTH_SHORTAGE"
  | "STARTER_WEAKNESS"
  | "BENCH_REDUNDANCY"
  | "CONSOLIDATION_OPPORTUNITY"
  | "DECONSOLIDATION_NEED";

export type NegotiationArchetype =
  | "CONSOLIDATION_CANDIDATE"
  | "DEPTH_SEEKER"
  | "BALANCED"
  | "POSITIONAL_REBALANCE"
  | "PREMIUM_ASSET_HEAVY"
  | "BENCH_HEAVY"
  | "QB_SURPLUS_1QB";

export interface NegotiationProfile {
  manager_id: string;
  manager_slug: string;
  roster_pressure: RosterPressureDiagnostic[];
  archetype: NegotiationArchetype[];
  evidence_quality: "STRUCTURAL_ONLY";
}

export type OfferTier = "OPENING" | "BALANCED" | "STRONG_ACCEPT" | "MAXIMUM_RATIONAL";

export interface OfferLadderEntry {
  tier: OfferTier;
  result: TradeDiscoveryResult;
}

export type WalkAwayReason =
  | "NEGATIVE_REQUESTER_UTILITY"
  | "CORE_ASSET_REQUIRED"
  | "FRAGILITY_TOO_HIGH"
  | "DEPTH_COLLAPSE"
  | "BETTER_ALTERNATIVE_EXISTS"
  | "PARTNER_PRICE_TOO_HIGH";

export interface WalkAwayAnalysis {
  trigger: string;
  reasons: WalkAwayReason[];
  maximum_rational_offer: TradeDiscoveryResult | null;
}

export type SweetenerClass = "CHEAP" | "EFFICIENT" | "MEANINGFUL" | "EXPENSIVE" | "DO_NOT_ADD";

export interface SweetenerCandidate {
  canonical_player_id: string;
  requester_utility_cost: number;
  partner_utility_gain: number;
  concession_efficiency: number | null;
  sweetener_class: SweetenerClass;
  resulting_offer: TradeDiscoveryResult | null;
}

export type NegotiationProblem =
  | "PARTNER_VALUE_TOO_LOW"
  | "REQUESTER_OVERPAY"
  | "POSITIONAL_FIT_POOR"
  | "DEPTH_DAMAGE"
  | "TARGET_TOO_EXPENSIVE"
  | "PACKAGE_TOO_COMPLEX"
  | "NO_CONCESSION_NEEDED";

export interface CounterStrategyEntry {
  rank: number;
  distance: number;
  result: TradeDiscoveryResult;
}
export interface CounterStrategyResult {
  problem: NegotiationProblem;
  counters: CounterStrategyEntry[];
}

export type BehavioralConfidence = "INSUFFICIENT" | "LOW" | "MEDIUM" | "HIGH";

export interface ManagerBehaviorEvidence {
  manager_id: string;
  completed_trade_count: number;
  confidence: BehavioralConfidence;
  status: "INSUFFICIENT_DATA" | "AVAILABLE";
  note: string;
}

export interface Phase3ShadowNegotiationNote {
  label: "SHADOW INTELLIGENCE — NOT INCLUDED IN NEGOTIATION VALUE";
  notes: string[];
}

export type NegotiationMode = "ACQUIRE_TARGET" | "SELL_ASSET" | "IMPROVE_OFFER" | "REDUCE_OVERPAY" | "COUNTER_PROPOSAL";

export interface NegotiationRequest {
  league: string;
  manager: string;
  mode?: NegotiationMode; // inferred from target_player_id/sell_player_id/proposal when omitted
  target_player_id?: string;
  sell_player_id?: string;
  proposal?: { participants: string[]; transfers: Array<{ from_manager_id: string; to_manager_id: string; canonical_player_id: string }> };
  untouchable_player_ids?: string[];
  /** Phase 6, ADDITIVE and OPT-IN (default false). See `lib/trades/strategy/types.ts::StrategicOfferGuidance`. */
  include_strategic?: boolean;
}

export interface NegotiationResponse {
  status: "OK" | "VALIDATION_FAILED" | "CONTEXT_UNAVAILABLE";
  league_slug: string;
  manager_slug: string;
  mode: NegotiationMode | null;
  versions: {
    foundation: string;
    contextual: string | null;
    calibrated: string | null;
    data: string | null;
    discovery: string;
    negotiation: string;
  };
  calibration_status: {
    real_trade_count: number;
    required_trade_count: number;
    behavioral_intelligence_status: "INSUFFICIENT_DATA" | "AVAILABLE";
  };
  target_dependency: PlayerDependency | null;
  leverage: LeverageAnalysis | null;
  offers: Partial<Record<OfferTier, TradeDiscoveryResult>>;
  sweeteners: SweetenerCandidate[];
  overpay_reduction: TradeDiscoveryResult | null;
  counter_strategy: CounterStrategyResult | null;
  walk_away: WalkAwayAnalysis | null;
  alternative_targets: Array<{ canonical_player_id: string; comparable_utility: number }>;
  behavioral_intelligence: ManagerBehaviorEvidence;
  phase3_shadow: Phase3ShadowNegotiationNote;
  diagnostics: Array<{ code: string; message: string; severity: "info" | "warning" | "error" }>;
  /**
   * Phase 6, ADDITIVE and OPTIONAL — present only when `include_strategic:
   * true`. `strategic_offer_guidance` only ever names a tier already present
   * in `offers` above (see `lib/trades/strategy/assess.ts::recommendOfferTier`
   * — it never redefines tier construction or exceeds MAXIMUM_RATIONAL).
   */
  manager_strategic_profile?: import("../strategy/types").ManagerStrategicProfile | null;
  strategic_offer_guidance?: import("../strategy/types").StrategicOfferGuidance | null;
  strategy_version?: string;
}

export type { TradeDiscoveryResult, AcceptanceClass, TradeViability };
