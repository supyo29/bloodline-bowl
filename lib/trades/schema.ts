/**
 * Trade Engine — Phase 1: Multi-Team Trade Foundation.
 *
 * The engine answers ONE question: *how does this transaction change the actual
 * utility of each manager's roster?* — never "what are the standalone
 * trade-chart values of the players involved?".
 *
 * A trade is represented as a generalized N-party transaction: `participants` +
 * `transfers`. A 2-team trade is a proposal with two participants; a 3-team
 * trade is a proposal with three. There is NO `twoWayTradeEngine` /
 * `threeWayTradeEngine` split, and the system never assumes bilateral
 * reciprocity between every pair of participants.
 *
 * Every participating roster is reconstructed before/after and re-run through
 * the SAME roster intelligence the rest of Bloodline Bowl uses
 * (`buildOptimalLineup`, `computeWeeklyReplacement` / `weeklyVOR`,
 * `computePositionalNeeds`). The marginal effect — not a summed player value —
 * is the result.
 */

import type {
  CanonicalManager,
  CanonicalFantasyTeam,
  CanonicalRoster,
} from "@/lib/canonical/schema";
import type { PositionalNeed } from "@/lib/weekly/schema";

/**
 * Trade-model behavior version (not a deployment version). Bump on any change
 * that can alter a trade analysis result.
 *   2026.1 — initial Phase 1 foundation
 *   2026.2 — audit pass: contiguous acceptance bands (RELUCTANT now reachable),
 *            starter_vor removed from the default composite weight (exposed, not
 *            summed — was double-counting the starter-points term), positional
 *            pressure summed over base positions only (was triple-counting a hole
 *            via flex-label + STRUCTURAL entries), order-invariant tie-breaks.
 */
export const TRADE_ENGINE_VERSION = "ri-trade-foundation-2026.2" as const;

/* -------------------------------------------------------------------------- */
/* Proposal representation (the generalized N-party model)                     */
/* -------------------------------------------------------------------------- */

export interface TradeParticipant {
  /** A manager slug/id/username — resolved through canonical manager resolution. */
  manager_id: string;
}

export type TradeAsset = {
  type: "PLAYER";
  /** Sleeper id, canonical id, or name-key — resolved through the crosswalk. */
  player_id: string;
};

export interface TradeTransfer {
  from_manager_id: string;
  to_manager_id: string;
  asset: TradeAsset;
}

export interface TradeProposal {
  /** League the trade happens in (registry slug). */
  league: string;
  participants: TradeParticipant[];
  transfers: TradeTransfer[];
}

/** A proposal after identity resolution — every id is canonical. */
export interface NormalizedTransfer {
  from_manager_id: string;
  to_manager_id: string;
  canonical_player_id: string;
  /** what the caller originally passed, for diagnostics */
  input_player_id: string;
}

export interface NormalizedProposal {
  league_slug: string;
  /** canonical_manager_id per participant, in the caller's order */
  participant_manager_ids: string[];
  transfers: NormalizedTransfer[];
}

/* -------------------------------------------------------------------------- */
/* Validation                                                                  */
/* -------------------------------------------------------------------------- */

export type TradeValidationCode =
  | "NO_PARTICIPANTS"
  | "TOO_FEW_PARTICIPANTS"
  | "NO_TRANSFERS"
  | "UNKNOWN_MANAGER"
  | "DUPLICATE_PARTICIPANT"
  | "MANAGER_HAS_NO_TEAM"
  | "UNKNOWN_PLAYER"
  | "INVALID_PARTICIPANT"
  | "SELF_TRANSFER"
  | "DUPLICATE_TRANSFER"
  | "PLAYER_NOT_OWNED_BY_SENDER"
  | "PLAYER_ON_MULTIPLE_POST_TRADE_ROSTERS"
  | "POST_TRADE_ROSTER_OVER_SIZE_LIMIT"
  | "POST_TRADE_ROSTER_ILLEGAL";

export interface TradeValidationFailure {
  code: TradeValidationCode;
  message: string;
  /** the offending transfer / manager / player, when applicable */
  subject?: string;
}

export interface TradeValidationResult {
  ok: boolean;
  failures: TradeValidationFailure[];
}

/* -------------------------------------------------------------------------- */
/* Per-participant before/after evaluation                                     */
/* -------------------------------------------------------------------------- */

export type AcceptanceClass =
  | "STRONG_ACCEPT"
  | "ACCEPT"
  | "NEUTRAL"
  | "RELUCTANT"
  | "REJECT"
  | "HARD_REJECT";

export interface RosterSnapshotView {
  /** canonical ids of the optimal legal starting lineup (starter SET, order-free) */
  optimal_starters: string[];
  /** projected points of the optimal legal lineup; null when an UNKNOWN starter
   *  makes it unquantifiable (never a silently-low number) */
  optimal_starter_points: number | null;
  /** sum of positive weekly VOR across the optimal starters */
  starter_vor: number | null;
  /** sum of positive weekly VOR across rostered players NOT in the optimal lineup */
  bench_value: number;
  all_player_ids: string[];
  incoming_player_ids: string[];
  outgoing_player_ids: string[];
  /** structural: can a legal lineup still be fielded? */
  fieldable: boolean;
  roster_size: number;
}

export interface LineupDisplacement {
  entered_starting_lineup: string[];
  left_starting_lineup: string[];
  moved_to_bench: string[];
  bench_promotions: string[];
}

export type PositionalNeedChangeKind =
  | "IMPROVES_NEED"
  | "NEUTRAL"
  | "WORSENS_POSITION"
  | "CREATES_NEW_WEAKNESS";

export interface PositionalNeedChange {
  position: string;
  before_severity: PositionalNeed["severity"] | "absent";
  after_severity: PositionalNeed["severity"] | "absent";
  kind: PositionalNeedChangeKind;
}

export interface ParticipantTradeResult {
  manager_id: string;
  manager_slug: string;
  canonical_team_id: string;

  before: RosterSnapshotView;
  after: RosterSnapshotView;

  /** after.optimal_starter_points - before.optimal_starter_points; null if unresolved */
  starter_points_delta: number | null;
  starter_points_delta_status: "RESOLVED" | "UNRESOLVED";
  /** after.starter_vor - before.starter_vor; null if unresolved */
  starter_vor_delta: number | null;
  bench_value_delta: number;

  /** Phase 1 composite — a weighted blend of the components above, all of which
   *  are also exposed individually. Configurable weights (see TradeConfig). */
  roster_utility_delta: number;
  roster_utility_components: {
    starter_points: number;
    starter_vor: number;
    bench_value: number;
    positional_need: number;
  };

  positional_need_changes: PositionalNeedChange[];
  lineup_displacement: LineupDisplacement;

  acceptance: AcceptanceClass;
  /** roster_utility_delta >= config.acceptance_floor */
  above_acceptance_floor: boolean;

  diagnostics: TradeDiagnostic[];

  /**
   * Phase 2 contextual valuation (`ri-trade-contextual-2026.2`). Present only
   * when `evaluateTrade` was given a `TradeAnalysisContext` (the API path).
   * Every Phase 1 field above is unchanged and authoritative; Phase 2 is an
   * ADDITIVE layer, never a replacement.
   */
  phase2?: Phase2ParticipantResult;

  /**
   * Phase 3 calibration + player intelligence (`ri-trade-calibrated-2026.2`),
   * SHADOW MODE ONLY — present only when `evaluateTrade` was given a
   * `TradeAnalysisContext`. It never changes `acceptance`, `roster_utility_delta`,
   * `trade_summary`, or Phase 2's own fields. `shadow_acceptance` /
   * `shadow_utility_delta` are informational until a calibration pass promotes
   * a signal out of weight 0.
   */
  phase3?: Phase3ParticipantResult;
}

/* -------------------------------------------------------------------------- */
/* Phase 3 — calibration + player intelligence (shadow mode)                   */
/* -------------------------------------------------------------------------- */

export type Phase3Confidence = "HIGH" | "MEDIUM" | "LOW" | "DEGRADED";

export interface Phase3PlayerAttribution {
  canonical_player_id: string;
  direction: "INCOMING" | "OUTGOING";
  /** pass-through of the Phase 2 leave-one-out ROS marginal for this player */
  phase2_marginal_ros: number | null;
  /** always 0 today — no validated role/usage signal exists to adjust from (see intelligence.ts) */
  role_adjustment: number;
  /** always 0 today — no validated schedule-strength signal exists */
  schedule_adjustment: number;
  uncertainty: import("./intelligence").VolatilityLevel;
  /** phase2_marginal_ros + role_adjustment + schedule_adjustment (== phase2_marginal_ros today) */
  phase3_adjusted_value: number | null;
}

export interface ValuationRangeView {
  estimate: number;
  low: number;
  high: number;
  basis: "std_dev_heuristic" | "single_point_no_band";
}

export interface Phase3ParticipantResult {
  /** unmodified pass-through of phase2.ros.ros_usable_value_delta */
  phase2_ros_value: number;
  /** phase2_ros_value + Σ role/schedule adjustments (== phase2_ros_value today; all adjustments are 0) */
  phase3_role_adjusted_ros_value: number;
  /** the Phase 3 calibrated composite (SHADOW): phase2.contextual_utility_delta + Σ calibratedWeight·component (all weights 0 today) */
  shadow_utility_delta: number;
  shadow_acceptance: AcceptanceClass;
  phase2_contextual_acceptance: AcceptanceClass;
  phase1_acceptance: AcceptanceClass;
  confidence: Phase3Confidence;
  confidence_reasons: string[];
  valuation_range: ValuationRangeView;
  /** populated when shadow_acceptance != phase2_contextual_acceptance */
  divergence_reason: string | null;
  player_attribution: Phase3PlayerAttribution[];
  diagnostics: TradeDiagnostic[];
}

export interface Phase3Summary {
  shadow_only: true;
  participants_with_divergence: string[];
  participants_with_low_confidence: string[];
}

/* -------------------------------------------------------------------------- */
/* Phase 2 — contextual valuation                                              */
/* -------------------------------------------------------------------------- */

export interface Phase2Components {
  /** ros_usable_value_delta expressed as a per-remaining-week equivalent */
  ros_usable_value: number;
  /** playoff-window usable-value delta, per playoff week; null when unavailable */
  playoff_window: number | null;
  /** bye-hole (slot × week) reduction across the ROS range */
  bye_coverage: number;
  /** Phase 2C usable-depth score delta */
  usable_depth: number;
  /** Phase 2C fragility improvement (before_score − after_score; + = less fragile) */
  roster_fragility: number;
  /** net weekly production lost after realistic replacement of outgoing players (<=0) */
  replacement_context: number;
}

export interface Phase2ParticipantResult {
  ros: import("./ros").RosParticipantResult;
  depth: import("./depth").DepthParticipantResult;
  components: Phase2Components;
  /**
   * Phase 2 composite: `roster_utility_delta` (Phase 1) + Σ weightᵢ·componentᵢ.
   * All Phase 2 weights DEFAULT TO 0 (components exposed, not summed) until
   * calibration supports inclusion — so by default this equals the Phase 1
   * `roster_utility_delta`.
   */
  contextual_utility_delta: number;
  contextual_acceptance: AcceptanceClass;
  /** Phase 1 acceptance, copied here for side-by-side comparison */
  phase1_acceptance: AcceptanceClass;
  /** populated when contextual_acceptance != phase1_acceptance */
  acceptance_divergence_reason: string | null;
  diagnostics: TradeDiagnostic[];
}

export interface Phase2Summary {
  /** every participant's ros_usable_value_delta > 0 */
  all_teams_improve_ros: boolean;
  ros_largest_beneficiary: string | null;
  /** a participant Phase 1 rates as improving but whose ROS usable value drops */
  ros_losers_phase1_missed: string[];
  /** any participant whose fragility materially worsens (fragility_delta < -1) */
  fragility_worsened_for: string[];
  contextual_viability: TradeViability;
}

/* -------------------------------------------------------------------------- */
/* Trade-level verdict                                                         */
/* -------------------------------------------------------------------------- */

export type TradeViability = "HIGH" | "MODERATE" | "LOW" | "NON_VIABLE";

export interface TradeSummary {
  all_teams_improve: boolean;
  all_teams_above_acceptance_floor: boolean;
  largest_beneficiary: string | null;
  largest_negative: string | null;
  /** population variance of the participants' roster_utility_delta */
  utility_gain_variance: number;
  /** max - min of the participants' roster_utility_delta */
  utility_gain_spread: number;
  trade_viability: TradeViability;
  /** rationality is per-roster improvement; fairness is distribution — kept separate */
  rationality: {
    every_participant_rational: boolean;
    rational_count: number;
    participant_count: number;
  };
  fairness: {
    /** 0 = perfectly even gains, 1 = maximally lopsided */
    imbalance_index: number;
    note: string;
  };
}

/* -------------------------------------------------------------------------- */
/* Diagnostics / degradation                                                   */
/* -------------------------------------------------------------------------- */

export type TradeDiagnosticCode =
  | "TRADE_ANALYSIS_DEGRADED"
  | "STARTER_PROJECTION_UNAVAILABLE"
  | "VOR_FALLBACK_USED"
  | "POSITIONAL_NEED_MODEL_UNAVAILABLE"
  | "LINEUP_PROVISIONAL"
  | "PROJECTIONS_PARTIAL"
  | "ROSTER_UNKNOWN_PLAYER"
  // ---- Phase 2
  | "ROS_PROJECTIONS_UNAVAILABLE"
  | "ROS_PARTIAL_PLAYER_COVERAGE"
  | "BYE_DATA_UNAVAILABLE"
  | "PLAYOFF_WINDOW_UNAVAILABLE"
  | "REPLACEMENT_POOL_DEGRADED"
  | "DEPTH_MODEL_DEGRADED"
  | "TRADE_CONTEXT_SNAPSHOT_INCOMPLETE"
  | "PHASE2_UNAVAILABLE"
  // ---- Phase 3
  | "PLAYER_INTELLIGENCE_UNAVAILABLE"
  | "USAGE_DATA_STALE"
  | "USAGE_SAMPLE_TOO_SMALL"
  | "ROLE_TREND_UNCERTAIN"
  | "INJURY_STATUS_UNCERTAIN"
  | "SCHEDULE_STRENGTH_UNAVAILABLE"
  | "CALIBRATION_DATA_INSUFFICIENT"
  | "CALIBRATION_SIGNAL_DISABLED"
  | "MODEL_DISAGREEMENT_HIGH"
  | "PHASE3_SHADOW_ONLY";

export interface TradeDiagnostic {
  code: TradeDiagnosticCode;
  message: string;
  severity: "info" | "warning" | "error";
}

/* -------------------------------------------------------------------------- */
/* Top-level analysis result                                                   */
/* -------------------------------------------------------------------------- */

export interface TradeAnalysis {
  status: "OK" | "VALIDATION_FAILED" | "CONTEXT_UNAVAILABLE";
  /** frozen Phase 1 transaction-layer version */
  trade_version: typeof TRADE_ENGINE_VERSION;
  trade_foundation_version: typeof TRADE_ENGINE_VERSION;
  /** Phase 2 contextual-valuation version; null when Phase 2 did not run */
  trade_context_version: string | null;
  /** Phase 3 calibration version; null when Phase 3 did not run */
  trade_calibrated_version: string | null;
  versions: {
    foundation: typeof TRADE_ENGINE_VERSION;
    contextual: string | null;
    calibrated: string | null;
  };
  league_slug: string;
  week: number;
  config: import("./config").TradeConfig;

  validation: TradeValidationResult;
  /** the resolved, canonical form of the proposal (present when validation passed) */
  normalized: NormalizedProposal | null;

  participants: Record<string, ParticipantTradeResult>;
  trade_summary: TradeSummary | null;
  /** Phase 2 trade-level rollup; null when Phase 2 did not run */
  phase2_summary: Phase2Summary | null;
  /** Phase 3 trade-level rollup (shadow mode); null when Phase 3 did not run */
  phase3_summary: Phase3Summary | null;
  diagnostics: TradeDiagnostic[];
  generated_at: string;
}

/* -------------------------------------------------------------------------- */
/* Engine input (what analyze.ts assembles and evaluate.ts consumes)           */
/* -------------------------------------------------------------------------- */

export interface TradeParticipantInput {
  manager: CanonicalManager;
  team: CanonicalFantasyTeam;
  roster: CanonicalRoster;
}
