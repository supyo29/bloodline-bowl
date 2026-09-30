/**
 * Projection Calibration Phase 2 — Role & Opportunity calibration contract.
 *
 * OBSERVE, FORECAST (pre-game, point-in-time) AND COMPARE. Nothing here writes a production projection, weight, floor/ceiling,
 * Start/Sit decision, Waiver/Matchup value or scoring behavior. The shadow candidate is SHADOW_ONLY by construction.
 *
 * Observed role  = what happened in a COMPLETED game (from the canonical Role Intelligence substrate).
 * Forecast role  = what Bloodline expected BEFORE that player's kickoff, computed only from strictly-earlier games,
 *                  official injury designations and timestamped depth charts.
 * One football forecast per player-game: league scoring is applied later, per fingerprint.
 */
export const ROLE_FORECAST_VERSION = "role-forecast-2026.1";
export const ROLE_CALIBRATION_ANALYSIS_VERSION = "role-calibration-analysis-2026.1";
export const SHADOW_MODE = "SHADOW_ONLY" as const;

export type RolePosition = "QB" | "RB" | "WR" | "TE";
export const ROLE_POSITIONS: readonly RolePosition[] = ["QB", "RB", "WR", "TE"];

/** Canonical role metrics (the existing Role Intelligence dimensions). Position-aware: a metric that does not apply stays absent (never zero). */
export const ROLE_METRICS = ["snap_share", "target_share", "air_yards_share", "route_participation", "rush_share", "position_group_rush_share", "position_group_target_share", "rz_target_share", "rz_carry_share"] as const;
export type RoleMetricName = (typeof ROLE_METRICS)[number];
/** Which metrics are meaningful per position. */
export const METRICS_BY_POSITION: Record<RolePosition, readonly RoleMetricName[]> = {
  QB: ["snap_share", "rush_share", "rz_carry_share"],
  RB: ["snap_share", "rush_share", "position_group_rush_share", "target_share", "route_participation", "rz_carry_share", "rz_target_share"],
  WR: ["snap_share", "target_share", "air_yards_share", "route_participation", "position_group_target_share", "rz_target_share"],
  TE: ["snap_share", "target_share", "air_yards_share", "route_participation", "position_group_target_share", "rz_target_share"],
};

export type ForecastConfidence = "MEDIUM" | "LOW" | "INSUFFICIENT_SAMPLE";
export type InjuryDesignation = "OUT" | "DOUBTFUL" | "QUESTIONABLE" | "NONE" | "UNKNOWN";
export type CaptureKind = "LIVE_CAPTURED" | "AS_OF_RECONSTRUCTION";

export interface MetricForecast {
  /** the forecast value (EWMA over strictly-earlier games, prior-season history included by recency weighting); null = unavailable */
  value: number | null;
  /** value after teammate-absence redistribution (== value when no absent teammate) */
  value_with_pressure: number | null;
  season_mean: number | null;
  prior: number | null;
  n_games_season: number;
  opportunity_total: number | null;
  prior_conf: string | null;
  discontinuity: string | null;
  confidence: ForecastConfidence;
  prior_season_only: boolean;
}

export interface ExpectedOpportunity {
  carries: number | null; rz_carries: number | null; targets: number | null; rz_targets: number | null;
  dropbacks: number | null; rz_dropbacks: number | null; designed_rushes: number | null; scrambles: number | null;
}
export interface TeamVolumeForecast { team_pass_att: number | null; team_rush_att: number | null; team_rz_pass_att: number | null; team_rz_rush_att: number | null; games_used: number }

export interface TeammateAbsence { gsis_id: string; position: string; designation: InjuryDesignation; p_absent: number; prior_shares: Partial<Record<RoleMetricName, number | null>> }
export interface TeammatePressure {
  absent: TeammateAbsence[];
  support_level: "CALIBRATED" | "EXPERIMENTAL_MULTI_ABSENCE";
  /** per metric: the additive redistribution the propagation model allocates to THIS player */
  deltas: Partial<Record<RoleMetricName, number>>;
  source: string;
}

export interface DepthState { rank: number | null; starter: boolean | null; snapshot_at: string | null }

export interface RoleForecast {
  forecast_id: string;
  forecast_version: string;
  season: number; week: number;
  gsis_id: string | null; sleeper_id: string | null;
  player_name: string | null; nfl_team: string | null; position: RolePosition;
  nfl_game_id: string | null; kickoff_at: string | null;
  capture_kind: CaptureKind;
  /** when this forecast was frozen (live) or the as-of instant it reconstructs (reconstruction) — MUST be strictly before kickoff */
  as_of_at: string;
  /** latest completed-game instant any input used (+ settle allowance); MUST be strictly before kickoff */
  data_cutoff_at: string | null;
  data_cutoff_week: number | null;
  metrics: Partial<Record<RoleMetricName, MetricForecast>>;
  volumes: TeamVolumeForecast;
  opportunity: ExpectedOpportunity;
  opportunity_no_pressure: ExpectedOpportunity;
  availability: { designation: InjuryDesignation; p_absent: number; expected_absent: boolean };
  depth: DepthState;
  teammate_pressure: TeammatePressure | null;
  confidence: ForecastConfidence;
  confidence_score: number;
  prior_season_only: boolean;
  reason_codes: string[];
  provenance: Record<string, unknown>;
}

export const NEUTRAL_EPS = 0.05;
