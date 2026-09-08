/**
 * Phase 7 — Schedule & Forward Planning Intelligence (Scope 3).
 *
 * A SHARED EVALUATIVE CONTEXT: forward-looking schedule/bye/coverage facts +
 * evaluative planning context. NOT a recommendation. `deployment =
 * "SHARED_CONTEXT"` — consumers may read it, future engines may consume it, but
 * no trade / waiver / lineup / start-sit / matchup recommendation value changes.
 *
 * CORE PRINCIPLE (spec §1): every week-level output separates
 *   - STRUCTURE confidence  — bye, NFL opponent, home/away, legal coverage,
 *     uncovered slot, playoff week (known for the full regular season)
 *   - VALUE confidence       — projected lineup total, bye-loss points, future
 *     roster-health value (only the current week has a true weekly projection;
 *     future weeks use prorated ROS)
 * These are NEVER collapsed into one confidence field.
 */

export const PLANNING_MODEL_VERSION = "schedule-planning-2026.1";

export type PlanningDeployment = "SHARED_CONTEXT" | "PRODUCTION_WIRED";

export type StructureConfidence = "HIGH" | "MEDIUM" | "LOW";
export type ValueConfidence = "HIGH" | "MEDIUM" | "LOW" | "ROS_CONTEXT_ONLY";
export type ProjectionBasis = "WEEKLY" | "ROS_PROJECTION" | "NONE";

export type PlanningDegradationReason =
  | "FUTURE_WEEKLY_PROJECTION_UNAVAILABLE"
  | "ROS_PROJECTION_USED"
  | "ROSTER_ASSUMED_STATIC"
  | "SCHEDULE_TIME_TENTATIVE"
  | "OPPONENT_UNKNOWN"
  | "FA_POOL_UNAVAILABLE"
  | "PLAYER_TEAM_UNCERTAIN"
  | "PLAYOFF_CONFIG_UNAVAILABLE"
  | "PLAYOFF_FORMAT_UNMODELED"
  | "FI_PRIOR_ONLY"
  | "MISSING_PLAYER_PROJECTION"
  | "PROJECTION_HORIZON_MISMATCH"
  | "SCHEDULE_WEEK_INCOMPLETE"
  | "LINEAGE_MISMATCH";

export interface PlanningDegradation {
  reasons: PlanningDegradationReason[];
  /** structure grade — must NOT degrade just because value confidence is low. */
  structure: "OK" | "PARTIAL" | "INSUFFICIENT";
  /** value grade — reflects projection horizon / availability. */
  value: "OK" | "DEGRADED" | "ROS_ONLY" | "INSUFFICIENT";
}

export interface ScheduleContextEntry {
  slot_key: string;
  canonical_player_id: string | null;
  nfl_team: string | null;
  opponent: string | null;
  home_away: "home" | "away" | null;
  is_bye: boolean;
  /** derived from inputs the production projection may not already price. */
  context_label: "favorable" | "neutral" | "difficult" | "bye" | "unknown";
  evidence: Record<string, number | string | null>;
}

export interface FutureRosterHealthPressure {
  fragility_profile: string;
  worst_dependency: number | null;
  single_points_of_failure: string[];
  uncovered_slot_labels: string[];
  /** vs the current-week baseline roster-health (same horizon). */
  depth_quality_delta: number | null;
  quality_surplus_slots_lost: string[];
}

export interface WeekPlan {
  week: number;
  is_current: boolean;
  is_playoff_week: boolean;
  /* ---- STRUCTURE (schedule-grounded, HIGH confidence for the full season) ---- */
  nfl_schedule_state: "SCHEDULE_KNOWN" | "SCHEDULE_WEEK_INCOMPLETE";
  starters_on_bye: string[];
  bye_player_count: number;
  legal_lineup_covered: boolean;
  uncovered_slot_labels: string[];
  structure_confidence: StructureConfidence;
  /* ---- VALUE (projection-driven, degrades with horizon) ---- */
  projection_basis: ProjectionBasis;
  projected_lineup_value: number | null;
  no_bye_lineup_value: number | null;
  estimated_bye_loss: number | null;
  value_confidence: ValueConfidence;
  value_source: { weekly_model_version: string; ros_source: string; ri_model_version: string | null };
  /* ---- context + health ---- */
  schedule_context: ScheduleContextEntry[];
  future_roster_health: FutureRosterHealthPressure | null;
  degradation: PlanningDegradation;
}

export interface PlanningSummary {
  next_bye_week: number | null;
  worst_bye_week: { week: number; estimated_bye_loss: number | null } | null;
  bye_concentration_window: { start_week: number; end_week: number; total_estimated_bye_loss: number } | null;
  weeks_with_uncovered_slots: number[];
  playoff_weeks: number[];
  playoff_exposure: { fragility_profile: string; thin_positions: string[]; weeks_with_uncovered_slots: number[] } | null;
  /** per-week projected optimal-lineup total (the schedule-pressure timeline). */
  projected_lineup_value_timeline: Array<{ week: number; value: number | null; basis: ProjectionBasis }>;
}

export interface PlanningLineage {
  planning_model_version: string;
  team_state_version: string;
  roster_health_version: string;
  weekly_projection_lineage: { model_version: string; source: string };
  ros_projection_lineage: { source: string; ri_model_version: string | null };
  nfl_schedule_source: string;
  football_intelligence_version: string; // "not_used" | descriptive-only marker
  league_snapshot_id: string | null;
  scoring_fingerprint: string | null;
  planning_horizon: { current_week: number; last_regular_week: number; playoff_weeks: number[] };
  playoff_config: { playoff_start_week: number | null; playoff_team_count: number | null; championship_week: number | null } | "unavailable";
  deployment: PlanningDeployment;
  generated_at: string;
}

export interface TeamSchedulePlan {
  planning_model_version: string;
  lineage: PlanningLineage;
  team_id: string;
  roster_id: number;
  manager_slug: string;
  manager_display_name: string | null;
  team_name: string | null;
  is_vacant: boolean;

  week_timeline: WeekPlan[];
  summary: PlanningSummary;
  degradation: PlanningDegradation;
  /** documented extension point for the future Orchestrator (spec §32) — not stubbed. */
  orchestrator_hint: null;
}

export interface SchedulePlanningLeagueContext {
  planning_model_version: string;
  lineage: PlanningLineage;
  league_slug: string;
  season: number;
  week: number;
  teams: TeamSchedulePlan[]; // ascending roster_id
  roster_index: Record<number, number>;
  manager_index: Record<string, number>;
  warnings: string[];
}

/* -------------------- planning delta (spec §22) -------------------- */

export type PlanningChangeType =
  | "WEEK_COVERAGE_IMPROVED"
  | "WEEK_COVERAGE_WORSENED"
  | "NEW_UNCOVERED_SLOT_WEEK"
  | "UNCOVERED_SLOT_WEEK_RESOLVED"
  | "BYE_COLLISION_ADDED"
  | "BYE_COLLISION_REMOVED"
  | "PLAYOFF_FRAGILITY_WORSENED"
  | "PLAYOFF_FRAGILITY_IMPROVED"
  | "ROS_PROJECTED_LINEUP_IMPROVED"
  | "ROS_PROJECTED_LINEUP_WORSENED"
  | "BYE_CONCENTRATION_SHIFTED";

export interface PlanningChange {
  type: PlanningChangeType;
  week: number | null;
  before: number | string | null;
  after: number | string | null;
  delta: number | null;
}

export interface SchedulePlanningDelta {
  planning_model_version: string;
  team_id: string;
  before: { league_snapshot_id: string | null; weekly_model_version: string; ros_source: string };
  after: { league_snapshot_id: string | null; weekly_model_version: string; ros_source: string };
  comparison_degradation: PlanningDegradationReason[];
  changes: PlanningChange[];
  /** descriptive only — NEVER "this move was good" (spec §22). */
  summary: string;
}
