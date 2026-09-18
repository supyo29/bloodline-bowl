/**
 * Injury -> Opportunity Propagation Intelligence — public type contract
 * (Phase 3, Checkpoint D).
 *
 * Answers exactly one question: IF a specified RB/WR/TE is unavailable for
 * a full game, how is opportunity expected to redistribute among
 * teammates? Never answers: probability the player misses the game,
 * medical diagnosis, fantasy points, a waiver/start-sit/trade
 * recommendation. Deployment state SHADOW_ONLY,
 * eligible_to_influence_production: false, everywhere, permanently, until
 * a separate certification changes it.
 *
 * Historical training semantics (frozen from Checkpoint B/C, never
 * upgraded here): every historical training event is
 * QUALIFIED_FULL_GAME_NONPARTICIPATION with cause UNKNOWN. A live scenario
 * may be INSTANTIATED by a real injury, but the model itself is all-cause
 * and never estimates medical probability, severity, or play likelihood.
 */

export type SupportedAbsentPosition = "RB" | "WR" | "TE";
export type ScenarioType = "FULL_GAME_NONPARTICIPATION";

/** Which of the frozen hierarchical model's evidence tiers actually backed a given rate lookup -- spec §25's mandatory visibility. */
export type InheritanceEvidenceSource = "TEAM_POSITION_HISTORY" | "POSITION_PRIOR" | "LEAGUE_PRIOR" | "GLOBAL_DEFAULT";

/** Confidence tiers Checkpoint C actually validated -- never HIGH/MEDIUM without recalibration (spec §26). */
export type PropagationConfidence = "LOW" | "INSUFFICIENT_EVIDENCE";

/** Machine-readable scenario support level (spec §19-20) -- never decorative, never hidden in prose only. */
export type ScenarioSupportLevel = "CALIBRATED" | "EXPERIMENTAL_MULTI_ABSENCE" | "UNSUPPORTED_SCENARIO";

export type RoleDomain = "PARTICIPATION" | "RUSHING" | "RECEIVING" | "HIGH_VALUE" | "RETURNS";

export interface SupportedDimension {
  domain: RoleDomain;
  dimension: string;
  positions: SupportedAbsentPosition[] | ("QB" | SupportedAbsentPosition)[];
}

export interface InheritanceRateLeagueRow {
  dimension: string;
  league_rate: number;
  n_league: number;
}
export interface InheritanceRatePositionRow {
  dimension: string;
  position: string;
  position_rate_blended: number;
}
export interface InheritanceRateTeamRow {
  dimension: string;
  team: string;
  position: string;
  team_rate_blended: number;
  n_team: number;
}
export interface PositionRelationshipWeightRow {
  dimension: string;
  same_position_multiplier: number;
}

export interface OpportunityPropagationManifest {
  model_tag: string;
  opportunity_propagation_version: string;
  schema_version: string;
  season: number;
  through_week: number;
  generated_at: string;

  role_opportunity_dependency: {
    role_opportunity_version: string;
    role_opportunity_model_tag: string;
    season: number;
    through_week: number;
  };
  football_intelligence_dependency: null;

  training_window: { start_season: number; end_season: number; onset_single_absence_events: number };
  robustness_window: { start_season: number; end_season: number; note: string };
  forward_diagnostic_window: { season: number; note: string };

  model_method: string;
  model_description: string;

  historical_training_semantics: { event_definition: string; cause: "UNKNOWN"; cause_note: string };

  supported_scenario_type: ScenarioType;
  scenario_semantics: string;
  episode_semantics: string;

  supported_absent_positions: SupportedAbsentPosition[];
  unsupported_absent_positions: Record<string, string>;

  single_absence_support: "CALIBRATED";
  multi_absence_support: "EXPERIMENTAL_MULTI_ABSENCE";
  multi_absence_support_note: string;

  confidence_semantics: { tiers_supported: PropagationConfidence[]; tiers_not_supported: string[]; note: string };
  uncertainty_ranges_supported: false;
  uncertainty_note: string;

  red_zone_support: string;
  red_zone_note: string;

  routes: { historical_feature_capability: string; current_route_availability: string; model_requires_routes: false };

  returns_kept_separate: true;

  deployment_state: "SHADOW_ONLY";
  eligible_to_influence_production: false;
  production_numeric_influence: "PROHIBITED";

  known_limitations: string[];
}

export interface OpportunityPropagationModel {
  manifest: OpportunityPropagationManifest;
  league: InheritanceRateLeagueRow[];
  position: InheritanceRatePositionRow[];
  team: InheritanceRateTeamRow[];
  positionWeights: PositionRelationshipWeightRow[];
  dimensions: SupportedDimension[];
}

/** Scenario input -- canonical stable player IDs only, never fuzzy name matching (spec §12). */
export interface OpportunityPropagationScenarioRequest {
  team: string;
  season: number;
  week: number;
  /** One id = single-absence (CALIBRATED); 2+ = EXPERIMENTAL_MULTI_ABSENCE. */
  unavailable_player_ids: string[];
  scenario_type: ScenarioType;
  /** Explicit candidate beneficiary pool. If omitted, derived from the current Role Intelligence snapshot's same-team RB/WR/TE/QB profiles (never a live roster re-fetch, never fuzzy matching). */
  candidate_player_ids?: string[];
}

export interface EvidenceInfo {
  source: InheritanceEvidenceSource;
  /** Effective training-event count backing the rate actually used (team-level n if TEAM_POSITION_HISTORY, else the position/league count). */
  evidence_count: number;
  inheritance_rate: number;
}

export interface BeneficiaryDomainPrediction {
  /** Which unavailable player this beneficiary row's vacated share came from -- required for multi-absence, where each absent player's vacated share is allocated independently against the shared candidate pool (never summed together). */
  absent_player_id: string;
  domain: RoleDomain;
  dimension: string;
  beneficiary_gsis_id: string;
  beneficiary_position: string;
  /** Phase 2's OWN observed value -- never overwritten, never recalculated (spec §15). */
  observed_pre_scenario_role: number | null;
  /** Phase 3's contingent prediction -- a DIFFERENT concept from observed role (spec §46 hard invariant). */
  expected_scenario_role: number | null;
  /** expected_scenario_role - observed_pre_scenario_role, exactly (spec §16 permanent invariant). */
  expected_delta: number | null;
  confidence: PropagationConfidence;
  evidence: EvidenceInfo;
  /** Model-trace decomposition (spec §22) -- never an opaque final number only. */
  trace: {
    pre_event_share_weight: number;
    trend_multiplier: number;
    position_affinity_multiplier: number;
    normalized_weight: number;
  };
}

export interface VacatedDomainRole {
  absent_player_id: string;
  domain: RoleDomain;
  dimension: string;
  vacated_opportunity: number | null;
}

export interface StructuralResidual {
  absent_player_id: string;
  domain: RoleDomain;
  dimension: string;
  structural_residual: number;
}

export interface OpportunityPropagationScenarioResult {
  scenario: {
    team: string;
    season: number;
    week: number;
    unavailable_player_ids: string[];
    scenario_type: ScenarioType;
    support_level: ScenarioSupportLevel;
    support_note: string;
    availability_scenario_source: "CONSUMER_SUPPLIED";
  };
  /** null for an UNSUPPORTED_SCENARIO result (e.g. a QB in unavailable_player_ids). */
  vacated_role: VacatedDomainRole[] | null;
  beneficiaries: BeneficiaryDomainPrediction[] | null;
  residual: StructuralResidual[] | null;
  opportunity_propagation_version: string;
  role_opportunity_version: string;
}
