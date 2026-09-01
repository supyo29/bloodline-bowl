/**
 * PHASE 4 — snake-draft recommendation engine: output contract + versions.
 *
 * This engine answers "who should this manager draft NOW, given what we lose by
 * waiting?" — not "who is the highest projection" and not "who fits a need".
 *
 * It is a strict CONSUMER of the frozen projection stack:
 *   - Layer 1  ri-structural-2026.3  (football stats)   — never modified here
 *   - Layer 2  league scoring + VOR + replacement + tiers
 *   - Layer 3  manager need-weighting is re-derived here for the draft context
 *
 * `recommendation_version` is independent of `projection_version`: a change to
 * the decision function must NOT imply a change to any player's projection.
 *
 * SNAKE_ONLY: auction drafts are out of scope for the 2026 engine. An auction
 * draft that reaches this engine returns `UNSUPPORTED_MODE`, never snake logic.
 */

import type { FantasyPosition } from "@/lib/projections/schema";

export const RECOMMENDATION_MODEL_VERSION = "ri-snake-decision-2026.1";
export const RECOMMENDATION_SCHEMA_VERSION = "recommendation.v1";

/** The production draft engine supports snake only for 2026. */
export type DraftEngineMode = "SNAKE_ONLY";
export type SnakeEngineStatus = "READY" | "DEGRADED" | "BLOCKED";
export type AuctionEngineStatus = "UNSUPPORTED_2026";
export type SupportedDraftType = "snake" | "linear";

export interface DraftEngineReadiness {
  draft_engine_mode: DraftEngineMode;
  snake_engine_status: SnakeEngineStatus;
  auction_engine_status: AuctionEngineStatus;
  /** Why the status is not READY (empty when READY). */
  degraded_reasons: string[];
  blocked_reasons: string[];
}

/* -------------------------------------------------------------------------- */
/* Hard vs soft gates (§22)                                                    */
/* -------------------------------------------------------------------------- */

/** A hard-ineligible player can NEVER be recommended, regardless of value. */
export type HardIneligibilityReason =
  | "already_drafted"
  | "invalid_player"
  | "unsupported_position"
  | "not_league_draftable"
  | "kdst_before_release"
  | "roster_rule_impossible";

/** A soft signal changes score/warnings but never vetoes a legal candidate. */
export type SoftWarningCode =
  | "LOW_CONFIDENCE"
  | "MARKET_DIVERGENCE_RI_HIGH"
  | "MARKET_DIVERGENCE_RI_LOW"
  | "MILD_REACH"
  | "SEVERE_REACH"
  | "ROSTER_REDUNDANT"
  | "SURVIVAL_UNCERTAIN"
  | "THIN_CANDIDATE_SET"
  | "SURVIVES_EASILY";

/* -------------------------------------------------------------------------- */
/* Snake geometry (§5)                                                         */
/* -------------------------------------------------------------------------- */

export interface FuturePick {
  round: number;
  /** 1-indexed overall pick number. */
  overall: number;
}

export interface SnakeTurnState {
  order: SupportedDraftType;
  team_count: number;
  rounds: number;
  slot: number;
  overall_picks_made: number;
  /** every overall pick this slot owns, ascending */
  all_picks: FuturePick[];
  current_pick: FuturePick | null;
  next_manager_pick: FuturePick | null;
  second_next_manager_pick: FuturePick | null;
  /** picks by other teams between the current pick and next_manager_pick */
  picks_until_next: number;
  /** picks by other teams between next_manager_pick and second_next_manager_pick */
  picks_until_second_next: number | null;
  current_round: number | null;
  own_picks_made: number;
  /**
   * True when `current_pick` and `next_manager_pick` are consecutive overall
   * picks (the snake turn) — the manager is making a two-pick decision.
   */
  is_consecutive_turn: boolean;
}

/* -------------------------------------------------------------------------- */
/* Replacement / tiers / scarcity evidence                                     */
/* -------------------------------------------------------------------------- */

export interface ReplacementDerivation {
  position: FantasyPosition;
  /** starter slots demanded league-wide (base + flex share) */
  league_starter_demand: number;
  /** flex slots attributed to this position by marginal-value competition */
  flex_share: number;
  /** bench/streaming cushion added past the last starter */
  bench_cushion: number;
  /** 1-indexed pool rank used as replacement */
  replacement_rank: number;
  replacement_points: number;
  /** how the rank was derived, human-readable */
  basis: string;
}

export interface TierBoundary {
  position: FantasyPosition;
  tier: number;
  /** best player in this tier (player_id) */
  top_player_id: string;
  /** worst player still in this tier */
  last_player_id: string;
  members: number;
  tier_top_points: number;
  tier_last_points: number;
  /** points from this tier's last player to the next tier's best — the cliff */
  cliff_to_next_points: number;
  cliff_to_next_vor: number;
}

export interface ScarcitySnapshot {
  position: FantasyPosition;
  starter_quality_remaining: number;
  /** VOR of the best remaining minus VOR of the marginal starter — curve steepness */
  remaining_value_slope: number;
  replacement_drop: number;
  expected_demand_before_next_pick: number;
  /** 0..1 — high only when the remaining-value curve actually falls */
  scarcity_index: number;
}

/* -------------------------------------------------------------------------- */
/* Survival interface (§7, §9, §10) — provisional, Phase 5 calibrates          */
/* -------------------------------------------------------------------------- */

export type SurvivalConfidence = "HIGH" | "MEDIUM" | "LOW" | "UNAVAILABLE";
export type SurvivalSource =
  | "ranking_pack_adp"
  | "sleeper_search_rank"
  | "positional_demand_only"
  | "none";

export interface SurvivalEstimate {
  /** P(this exact player is still available at the manager's next pick) */
  p_survives_next_pick: number;
  /** P(this exact player is still available at the manager's second-next pick) */
  p_survives_second_next: number | null;
  /** [earliest, latest] plausible overall pick this player goes */
  expected_pick_window: [number, number] | null;
  source: SurvivalSource;
  confidence: SurvivalConfidence;
  /** ISO timestamp of the market snapshot this used */
  market_timestamp: string | null;
  note: string;
}

export interface TierSurvivalEstimate {
  position: FantasyPosition;
  tier: number;
  players_in_tier_available: number;
  /** P(at least one equivalent-tier player is still there at the next pick) */
  p_tier_survives_next_pick: number;
  confidence: SurvivalConfidence;
}

/* -------------------------------------------------------------------------- */
/* Positional runs (§11)                                                       */
/* -------------------------------------------------------------------------- */

export interface RunSignal {
  position: FantasyPosition;
  picked_in_window: number;
  window_size: number;
  /** league-average rate for this window, for comparison */
  baseline_rate: number;
  /** picked_in_window / window_size − baseline_rate, clamped ≥ 0 */
  run_intensity: number;
  is_run: boolean;
}

export interface RunEffect {
  position: FantasyPosition;
  /** multiplier applied to expected picks-of-this-position before the next turn */
  demand_multiplier: number;
  /** survival probability delta attributable to the run (negative = more urgent) */
  survival_delta: number;
  /** runs never change fundamental player value — always 0, surfaced for audit */
  fundamental_value_delta: 0;
}

/* -------------------------------------------------------------------------- */
/* Roster construction (§15)                                                   */
/* -------------------------------------------------------------------------- */

export interface RosterTrajectory {
  /** open required starter slots, per position (flex counted toward eligible) */
  open_starters: Record<string, number>;
  open_flex: number;
  /** 0..1 — risk the manager cannot complete a startable lineup on this path */
  starter_completion_risk: number;
  flex_completion_risk: number;
  /** how lopsided the roster is (0 = balanced) */
  position_concentration: number;
  bench_balance: number;
  /** positions where completion risk is already elevated */
  at_risk_positions: FantasyPosition[];
}

/* -------------------------------------------------------------------------- */
/* Utility decomposition (§16, §17) — every term in league-point units         */
/* -------------------------------------------------------------------------- */

export interface UtilityComponents {
  /** value over replacement, this league's scoring (points) */
  vor: number;
  /** points to the first player of the next tier down — urgency of the cliff */
  tier_drop: number;
  /** points-equivalent scarcity pressure */
  scarcity_value: number;
  /** points-equivalent roster-need adjustment (can be negative for redundancy) */
  roster_need: number;
  /** points this player beats his expected later alternative at this position */
  positional_advantage: number;
  /** take-now minus wait value: expected points lost by passing (points) */
  urgency: number;
  /** points-equivalent penalty for drafting far ahead of market (subtracted) */
  reach_cost: number;
  /** points-equivalent penalty for projection uncertainty (subtracted) */
  uncertainty_penalty: number;
  /** points-equivalent penalty for paths that raise starter-completion risk */
  construction_risk: number;
}

export interface UtilityWeights {
  vor: number;
  tier_drop: number;
  scarcity_value: number;
  roster_need: number;
  positional_advantage: number;
  urgency: number;
  reach_cost: number;
  uncertainty_penalty: number;
  construction_risk: number;
}

/* -------------------------------------------------------------------------- */
/* Reason codes (§21.4)                                                        */
/* -------------------------------------------------------------------------- */

export type ReasonCode =
  | "TIER_CLIFF_URGENT"
  | "EXPECTED_WAIT_LOSS"
  | "POSITIONAL_ADVANTAGE"
  | "ROSTER_STARTER_NEED"
  | "LIKELY_NOT_SURVIVE"
  | "LOW_SURVIVAL_TO_NEXT_PICK"
  | "LIKELY_AVAILABLE_LATER"
  | "TIER_LIKELY_GONE"
  | "EQUIVALENT_TIER_LIKELY_SURVIVES"
  | "HIGH_VOR"
  | "POSITIONAL_RUN_PRESSURE"
  | "MARKET_VALUE_INEFFICIENCY"
  | "SAFE_FLOOR"
  | "CEILING_UPSIDE"
  | "CONSTRUCTION_RISK_RELIEF"
  | "DO_NOT_REACH_SURVIVES"
  | "KDST_HELD_UNTIL_ENDGAME"
  | "TURN_PAIR_OPTIMAL"
  | "TIER_CLIFF_CAPTURE"
  | "RB_WAIT_LOSS_HIGH"
  | "WR_WAIT_LOSS_HIGH"
  | "WR_VALUE_CAPTURE"
  | "RB_VALUE_CAPTURE";

/* -------------------------------------------------------------------------- */
/* Provenance (§21.5)                                                          */
/* -------------------------------------------------------------------------- */

export interface RecommendationProvenance {
  projection_source: string;
  projection_version: string;
  projection_timestamp: string;
  league_scoring_hash: string;
  market_source: SurvivalSource;
  market_timestamp: string | null;
  /** Phase 5 — market/survival model provenance (§30, §31) */
  survival_model_version: string;
  market_consensus_version: string;
  /** market data coverage for this draft: fraction of the pool with ≥1 DIRECT_ADP */
  market_direct_adp_coverage: number;
  /** what the market layer degraded to, if anything */
  market_degraded_reason: string | null;
  tier_model_version: string;
  recommendation_model_version: string;
  recommendation_schema_version: string;
  draft_state_timestamp: string;
}

/* -------------------------------------------------------------------------- */
/* Anticipated-alternative comparison (§21.2, §21.3)                           */
/* -------------------------------------------------------------------------- */

export interface WaitComparison {
  position: FantasyPosition;
  take_now_points: number;
  take_now_vor: number;
  /** expected best comparable projection available at the next manager pick */
  expected_alternative_points: [number, number];
  expected_alternative_vor: [number, number];
  /** take_now − E[alternative] */
  wait_projection_loss: [number, number];
  wait_vor_loss: [number, number];
  basis: string;
}

/* -------------------------------------------------------------------------- */
/* The recommendation object (§20, §21)                                        */
/* -------------------------------------------------------------------------- */

export type RecommendationKind =
  | "PRIMARY_RECOMMENDATION"
  | "ALTERNATE"
  | "WAIT_CANDIDATE"
  | "DO_NOT_REACH";

export interface DraftRecommendation {
  kind: RecommendationKind;
  rank: number;
  player_id: string;
  player_name: string;
  position: FantasyPosition;
  team: string | null;

  recommendation_score: number;
  projected_points: number;
  vor: number;
  position_rank: number;
  tier: number;
  tier_drop: number;
  /** points from this player to the next player in his own tier */
  distance_to_next_in_tier: number;
  /** points from this player to the first player of the next tier */
  distance_to_next_tier: number;

  positional_scarcity: number;
  roster_need: number;
  positional_advantage: number;

  current_pick: number | null;
  next_manager_pick: number | null;
  picks_until_next: number;

  market_adp: number | null;
  reach_cost: number;

  survival: SurvivalEstimate;
  tier_survival: TierSurvivalEstimate;

  /** the anticipated wait-loss comparison at this player's position */
  wait_comparison: WaitComparison;
  /** cross-position opportunity-cost comparison vs the other leading candidates */
  cross_position_costs: WaitComparison[];

  confidence: {
    projection: string;
    survival: SurvivalConfidence;
    /** overall decision confidence, a bounded roll-up */
    decision: "HIGH" | "MEDIUM" | "LOW" | "VERY_LOW";
  };

  construction_effect: {
    starter_completion_risk_before: number;
    starter_completion_risk_after: number;
    relieves_position: FantasyPosition | null;
  };

  utility_components: UtilityComponents;
  reason_codes: ReasonCode[];
  reason: string;
  warnings: SoftWarningCode[];

  provenance: RecommendationProvenance;
}

/* -------------------------------------------------------------------------- */
/* Turn-pair (§21A)                                                            */
/* -------------------------------------------------------------------------- */

export interface NextTurnLandscape {
  /** overall pick numbers of the two future picks this landscape describes */
  at_picks: [number, number];
  by_position: Array<{
    position: FantasyPosition;
    best_tier_available: number;
    expected_points_range: [number, number];
    expected_vor_range: [number, number];
    p_target_tier_survives: number;
    projected_cliff_before: boolean;
  }>;
}

export interface DraftPairRecommendation {
  kind: "BEST_PAIR" | "ALTERNATE_PAIR";
  rank: number;
  /** canonical order: sorted by player_id so Pair(A,B) === Pair(B,A) */
  player_1: { player_id: string; player_name: string; position: FantasyPosition; team: string | null; projected_points: number; vor: number; tier: number; position_rank: number };
  player_2: { player_id: string; player_name: string; position: FantasyPosition; team: string | null; projected_points: number; vor: number; tier: number; position_rank: number };

  combined_projected_points: number;
  combined_vor: number;
  combined_recommendation_utility: number;

  tier_cliffs_captured: Array<{ position: FantasyPosition; tier: number; cliff_points: number }>;
  positions_deferred: FantasyPosition[];

  anticipated_next_turn_alternatives: NextTurnLandscape;
  anticipated_projection_loss_if_deferred: Array<{ position: FantasyPosition; loss_range: [number, number] }>;
  anticipated_vor_loss_if_deferred: Array<{ position: FantasyPosition; loss_range: [number, number] }>;

  pair_reason_codes: ReasonCode[];
  reason: string;
  confidence: "HIGH" | "MEDIUM" | "LOW" | "VERY_LOW";
  provenance: RecommendationProvenance;
}

/* -------------------------------------------------------------------------- */
/* Top-level engine response                                                   */
/* -------------------------------------------------------------------------- */

export interface RecommendationResponse {
  readiness: DraftEngineReadiness;
  recommendation_model_version: string;
  recommendation_schema_version: string;
  provenance: RecommendationProvenance;

  turn: SnakeTurnState;

  /** single-pick decision (always populated when the engine is READY) */
  primary_recommendation: DraftRecommendation | null;
  alternates: DraftRecommendation[];
  wait_candidates: DraftRecommendation[];
  do_not_reach: DraftRecommendation[];

  /** consecutive-turn decision (only when `turn.is_consecutive_turn`) */
  primary_pair: DraftPairRecommendation | null;
  alternate_pairs: DraftPairRecommendation[];

  /** decision evidence tables surfaced for audit */
  replacement_levels: ReplacementDerivation[];
  tier_boundaries: TierBoundary[];
  scarcity: ScarcitySnapshot[];
  runs: Array<{ signal: RunSignal; effect: RunEffect }>;
  roster_trajectory: RosterTrajectory;

  /** what the engine actually reasoned over — never the response label (§31 isolation) */
  manager_context: {
    used_roster_id: number;
    used_sleeper_user_id: string;
    used_manager_slug: string;
    used_draft_slot: number | null;
    roster_player_count: number;
    roster_position_counts: Record<string, number>;
    candidate_pool_size: number;
  };

  warnings: string[];
}

/** Returned instead of a recommendation when the draft type is not snake/linear. */
export interface UnsupportedModeResponse {
  readiness: DraftEngineReadiness;
  recommendation_model_version: string;
  error: "UNSUPPORTED_MODE";
  draft_type: string | null;
  detail: string;
}
