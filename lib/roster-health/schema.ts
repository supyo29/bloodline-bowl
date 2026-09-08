/**
 * Phase 6 — Roster Health Intelligence (Scope 3).
 *
 * A SHARED EVALUATIVE CONTEXT: it derives roster quality / resilience / risk
 * from Phase 2 Team-State structural facts + production projections + the
 * existing replacement framework + the frozen `buildOptimalLineup` legality
 * machinery. It is NOT a recommendation. `deployment = "SHARED_CONTEXT"`:
 * consumers may read it, future engines may consume it, but no trade / waiver /
 * lineup / start-sit / matchup recommendation value changes because it exists.
 *
 * Two horizons — `weekly` and `rest_of_season` — are kept STRICTLY separate and
 * never blended. Every metric declares its horizon and its projection lineage.
 */

export const ROSTER_HEALTH_VERSION = "roster-health-2026.1";

export type RosterHealthDeployment = "SHARED_CONTEXT" | "PRODUCTION_WIRED";
export type Horizon = "weekly" | "rest_of_season";

export type RosterHealthDegradationReason =
  | "MISSING_WEEKLY_PROJECTION"
  | "MISSING_ROS_PROJECTION"
  | "UNKNOWN_PLAYER"
  | "UNRESOLVED_IDENTITY"
  | "INCOMPLETE_LINEUP"
  | "FA_POOL_ROS_APPROXIMATE"
  | "SCHEDULE_LIMITED"
  | "INJURY_STATUS_UNKNOWN"
  | "PROJECTION_HORIZON_MISMATCH"
  | "LINEAGE_MISMATCH"
  | "REPLACEMENT_POOL_UNAVAILABLE"
  | "DEPARTED_MANAGER"
  | "VACANT_TEAM"
  | "CONTINGENCY_PROVISIONAL";

export interface RosterHealthDegradation {
  reasons: RosterHealthDegradationReason[];
  overall: "OK" | "PARTIAL" | "DEGRADED" | "INSUFFICIENT";
  detail: Record<string, string | number | boolean | null>;
}

export interface RosterHealthLineage {
  roster_health_model_version: string;
  team_state_version: string;
  replacement_model: { weekly_frontier: string; ros_basis: "position_rank_theoretical" };
  projection_lineage: {
    weekly: { model_version: string; source: string };
    ros: { source: string; ri_model_version: string | null };
  };
  league_snapshot_id: string | null;
  scoring_fingerprint: string | null;
  horizon_note: "weekly and rest_of_season are computed separately and never blended";
  deployment: RosterHealthDeployment;
  generated_at: string;
}

/** one legal-lineup contingency scenario (spec §7, §21). */
export interface ContingencyScenario {
  removed_player_id: string;
  removed_player_name: string | null;
  removed_position: string;
  horizon: Horizon;
  baseline_lineup_value: number | null;
  post_removal_lineup_value: number | null;
  /** baseline − post_removal; >= 0. */
  value_loss: number | null;
  promoted_player_id: string | null;
  promoted_projection: number | null;
  slot_affected: string | null;
  remaining_usable_backups: number;
  provisional: boolean; // an UNKNOWN starter would distort the value
}

/** player dependency in four interpretable forms (spec §7, §8). */
export interface PlayerDependency {
  canonical_player_id: string;
  full_name: string | null;
  position: string;
  starting_slot_label: string | null;
  horizon: Horizon;
  raw_point_loss: number | null;
  pct_lineup_loss: number | null;
  replacement_gap: number | null;
  league_percentile: number | null;
  position_percentile: number | null;
  single_point_of_failure: boolean;
  evidence: Record<string, number | string | null>;
}

export interface PositionHealth {
  slot_key: string;
  horizon: Horizon;
  starter_quality_vor: number | null; // Σ VOR of the best `required` legal starters
  best_backup_vor: number | null;
  second_backup_vor: number | null;
  replacement_cliff: number | null; // marginal starter proj − best backup proj
  usable_backup_count: number;
  nominal_backup_count: number;
  depth_quality_grade: "STRONG" | "ADEQUATE" | "THIN" | "BARE";
  excluded_from_core_fragility: boolean; // K/DST
  reason_code: string;
}

export interface QualitySurplus {
  slot_key: string;
  horizon: Horizon;
  /** structural surplus is a Phase 2 FACT, echoed here for contrast — never overwritten. */
  team_state_structural_surplus: boolean;
  quality_surplus: boolean;
  surplus_players: Array<{ canonical_player_id: string; full_name: string | null; vor: number | null }>;
  reason_code: string;
}

export interface BenchUtility {
  canonical_player_id: string;
  full_name: string | null;
  position: string;
  horizon: Horizon;
  starter_replacement_value: number | null; // max damage this bench player prevents
  multi_slot_coverage: number;
  bye_coverage_slots: string[];
  bench_utility_grade: "HIGH" | "MODERATE" | "LOW" | "DEAD_WEIGHT";
}

/** roster-level fragility — component vector, not one opaque number (spec §8, §9). */
export interface RosterFragility {
  horizon: Horizon;
  worst_starter_dependency: number | null;
  expected_one_loss_damage: number | null;
  top3_weighted_dependency: number | null;
  tail_dependency_p90: number | null;
  single_points_of_failure: string[]; // canonical_player_ids
  /** interpretation label derived from the components — components always retained. */
  profile: "RESILIENT" | "CONCENTRATED_FRAGILITY" | "DISTRIBUTED_FRAGILITY" | "FRAGILE_BOTH";
  min_slot_value_retained_after_any_one_loss: number | null;
}

export interface HorizonView {
  horizon: Horizon;
  starter_quality_vor_total: number | null;
  baseline_lineup_value: number | null;
  depth_quality: PositionHealth[];
  fragility: RosterFragility;
  player_dependency: PlayerDependency[];
  quality_surplus: QualitySurplus[];
  bench_utility: BenchUtility[];
  contingency_scenarios: ContingencyScenario[];
  degradation: RosterHealthDegradation;
}

export interface TeamRosterHealth {
  roster_health_version: string;
  lineage: RosterHealthLineage;
  team_id: string;
  roster_id: number;
  manager_slug: string;
  manager_display_name: string | null;
  team_name: string | null;
  is_vacant: boolean;

  weekly: HorizonView;
  rest_of_season: HorizonView;

  /** IR trapped capacity/value (horizon-free — a structural + ROS-value fact). */
  ir_burden: { trapped_ros_vor: number | null; ir_slots_used: number; ir_slots_available: number };
  /** bye exposure within the reliable schedule horizon only (spec §16). */
  bye_exposure: { current_week_starters_on_bye: string[]; near_term_shared_bye_weeks: number[] };

  /** league-relative percentiles (same league / snapshot / scoring / horizon). */
  league_relative: {
    weekly: Record<string, number | null>;
    rest_of_season: Record<string, number | null>;
  };

  explanations: Array<{ code: string; message: string; evidence: Record<string, number | string | null> }>;
  degradation: RosterHealthDegradation;
}

export interface RosterHealthLeagueContext {
  roster_health_version: string;
  lineage: RosterHealthLineage;
  league_slug: string;
  season: number;
  week: number;
  teams: TeamRosterHealth[]; // ascending roster_id
  roster_index: Record<number, number>;
  manager_index: Record<string, number>;
  warnings: string[];
}

/* -------------------- snapshot health-delta (spec §19, §20) -------------------- */

export type RosterHealthChangeType =
  | "STARTER_QUALITY_INCREASED"
  | "STARTER_QUALITY_DECREASED"
  | "DEPTH_QUALITY_IMPROVED"
  | "DEPTH_QUALITY_WORSENED"
  | "FRAGILITY_INCREASED"
  | "FRAGILITY_DECREASED"
  | "NEW_SINGLE_POINT_OF_FAILURE"
  | "SINGLE_POINT_OF_FAILURE_RESOLVED"
  | "QUALITY_SURPLUS_GAINED"
  | "QUALITY_SURPLUS_LOST"
  | "CONCENTRATION_INCREASED"
  | "CONCENTRATION_DECREASED";

export interface RosterHealthChange {
  type: RosterHealthChangeType;
  horizon: Horizon;
  slot_key: string | null;
  before: number | string | null;
  after: number | string | null;
  delta: number | null;
}

export interface RosterHealthDelta {
  roster_health_version: string;
  team_id: string;
  before: { league_snapshot_id: string | null; projection_lineage: RosterHealthLineage["projection_lineage"] };
  after: { league_snapshot_id: string | null; projection_lineage: RosterHealthLineage["projection_lineage"] };
  /** set when the two states' projection/scoring basis differs — the diff is still emitted, flagged. */
  comparison_degradation: RosterHealthDegradationReason[];
  changes: RosterHealthChange[];
  /** purely descriptive summary — NEVER "this was a good move" (spec §19). */
  summary: string;
}
