/**
 * Player Role & Opportunity Intelligence — TypeScript read contract
 * (Phase 2, Checkpoint D).
 *
 * READ-ONLY. Never runs R, never recomputes a statistic. Reads the versioned
 * CSV/JSON artifacts published by `analysis/player_role/serve_role_intelligence.R`
 * into `lib/player-role-intelligence/data/`. Mirrors `lib/football-intel/schema.ts`'s
 * conventions, but this is a DISTINCT analytical product with its own
 * version/model-tag identity -- see `docs/PLAYER_ROLE_OPPORTUNITY_PHASE_2_CHECKPOINT_D.md`.
 *
 * Deployment state is SHARED_CONTEXT everywhere (Checkpoint D spec §27):
 * available for descriptive/analytical consumption, never eligible to
 * change a production numeric recommendation.
 */

export const ROLE_INTELLIGENCE_CONTRACT_VERSION = "player-role-intelligence-read-2026.1";

export type Confidence = "HIGH" | "MEDIUM" | "LOW" | "INSUFFICIENT_SAMPLE";
export type Trend = "EXPANDING" | "STABLE" | "CONTRACTING" | "UNCERTAIN";
export type EvidenceState = "OBSERVED" | "TENTATIVE" | "INSUFFICIENT_SAMPLE";
export type Discontinuity = "NONE" | "TEAM_CHANGE" | "POSITION_CHANGE" | "ROOKIE_OR_NO_PRIOR_SEASON" | "NO_PRIOR_EVIDENCE_THIS_METRIC";
export type RoleLevel = "MINIMAL" | "ROTATIONAL" | "REGULAR" | "FEATURED" | "PRIMARY";
export type RouteEvidenceTag = "ROUTE_CORROBORATION_AVAILABLE" | "ROUTE_CORROBORATION_UNAVAILABLE";
export type RoleIntelligenceFeatureFamilyStatus = "AVAILABLE_CURRENT" | "AVAILABLE_WITH_LAG" | "UNAVAILABLE";
export type RoleDomain = "PARTICIPATION" | "RECEIVING" | "RUSHING" | "HIGH_VALUE" | "RETURNS";

export interface WeekCompletion {
  latest_week: number;
  week_state: "PARTIAL" | "COMPLETE";
  games_completed_in_latest_week: number;
  games_scheduled_in_latest_week: number;
  latest_completed_game_date: string | null;
}

/**
 * One dimension's full horizon decomposition -- latest/recent/season/prior
 * plus change detection and confidence. Never collapsed into a single
 * number; a consumer can always answer "why" from these fields alone
 * (Checkpoint D spec §8).
 */
export interface DimensionProfile {
  latest: number | null;
  recent: number | null;
  season: number | null;
  prior: number | null;
  prior_role_confidence: Confidence;
  discontinuity: Discontinuity;
  n_games_season: number;
  opportunity_total: number;
  delta_latest_vs_recent: number | null;
  trend_latest_vs_recent: Trend;
  trend_latest_vs_season: Trend;
  trend_recent_vs_prior: Trend;
  evidence_state: EvidenceState;
  confidence: Confidence;
}

export interface PlayerRoleProfile {
  identity: {
    gsis_id: string;
    sleeper_id: string | null;
    full_name: string;
    position: string;
    team: string;
    opponent: string | null;
  };
  as_of: { season: number; through_week: number };
  /** `null` for positions where participation is not a meaningful dimension (Checkpoint C spec §7). */
  participation: DimensionProfile | null;
  receiving: {
    target_share: DimensionProfile;
    position_group_target_share: DimensionProfile | null;
    air_yards_share: DimensionProfile;
    /** NEVER fabricated: null latest + INSUFFICIENT_SAMPLE confidence whenever the current period's route source is lagged/unavailable. */
    route_participation: DimensionProfile;
    corroboration_count: number;
  } | null;
  rushing: {
    rush_share: DimensionProfile;
    position_group_rush_share: DimensionProfile | null;
    corroboration_count: number;
  } | null;
  high_value: {
    rz_target_share: DimensionProfile | null;
    rz_carry_share: DimensionProfile | null;
    goal_line_carries_latest: number | null;
    third_down_targets_latest: number | null;
    two_minute_targets_latest: number | null;
  } | null;
  /** ALWAYS present, structurally separate from offense -- a return-only player never reads as an offensive contributor. */
  returns: {
    kick_return_role: DimensionProfile;
    punt_return_role: DimensionProfile;
  };
  role_state: {
    role_level: RoleLevel | null;
    role_trend: Trend;
    evidence_state: EvidenceState;
  };
  source_availability: { route_evidence: RouteEvidenceTag };
  schema_version: string;
}

export interface RoleChangeEvent {
  gsis_id: string;
  full_name: string;
  season: number;
  through_week: number;
  domain: RoleDomain;
  dimension: string;
  trend: Trend;
  evidence_state: EvidenceState;
  confidence: Confidence;
  latest: number | null;
  baseline_recent: number | null;
  baseline_season: number | null;
  baseline_prior: number | null;
  delta: number | null;
  n_games_season: number;
  opportunity_total: number;
}

export interface RoleIntelligenceFeatureFamilyAvailability {
  family: string;
  source: string;
  status: RoleIntelligenceFeatureFamilyStatus;
  through_week: number | null;
}

export interface RoleOpportunityManifest {
  role_opportunity_model_tag: string;
  /** `roi:<season>:w<week>:<12 hex>` -- content-deterministic (generated_at excluded), see Checkpoint D report. */
  role_opportunity_version: string;
  feature_schema_version: string;
  substrate_schema_version: string;
  season: number;
  through_week: number;
  generated_at: string;
  week_completion: WeekCompletion;
  source_cutoffs: Record<string, number>;
  source_availability: RoleIntelligenceFeatureFamilyAvailability[];
  model_configuration: {
    recency_method: string;
    recency_halflife_games: number;
    prior_methodology: string;
    confidence_methodology_version: string;
    confidence_methodology_note?: string;
    min_share_delta: number;
    min_opportunity_for_trend: number;
    role_level_calibration_basis: Record<string, string>;
    confidence_calibration_scope: string;
  };
  /** SHARED_CONTEXT today (Checkpoint D spec §27) -- descriptive/analytical consumption only. */
  deployment_state: "SHARED_CONTEXT" | "SHADOW_ONLY";
  eligible_to_influence_production: false;
  known_unavailable_feature_families: string[];
  row_counts: { profiles: number; change_events: number };
  dependencies: { substrate: string; substrate_schema_version: string };
}
