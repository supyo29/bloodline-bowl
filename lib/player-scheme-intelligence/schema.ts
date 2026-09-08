/**
 * Player x Scheme Interaction Intelligence — TypeScript read contract (Phase 9).
 *
 * READ-ONLY. This module never runs R, never recomputes a statistic. It reads
 * the versioned artifacts published by the Phase 9 R pipeline into
 * `lib/player-scheme-intelligence/data/`.
 *
 * ADDITIVE ONLY (spec §1, §44). Phase 9 is NOT wired into Team-State, the
 * production projection, lineup, Start/Sit, waivers, trades, Matchup
 * Intelligence, Roster Health, Schedule Planning, or the Orchestrator ACTION
 * policy. Two lanes:
 *   - SHARED_DESCRIPTIVE : validated observable tendency/profile calculations,
 *                          served + consumable as football CONTEXT.
 *   - SHADOW_PREDICTIVE  : any player x scheme matchup EFFECT on fantasy value
 *                          stays SHADOW_ONLY (numeric_fantasy_adjustment = 0)
 *                          until incremental OOS value beyond the production
 *                          baseline is certified separately (spec §24, §35).
 */

export const PLAYER_SCHEME_CONTRACT_VERSION = "player-scheme-read-2026.1";
export const PLAYER_SCHEME_MODEL_TAG = "player-scheme-intelligence-2026.1";

/** Where the underlying source stands relative to the current season (spec §3). */
export type AvailabilityState =
  | "LIVE_CURRENT"
  | "HISTORICAL_CURRENT_THROUGH_2025"
  | "PRIOR_ONLY"
  | "POSTSEASON_ONLY"
  | "UNAVAILABLE";

/** Could this feature genuinely have been known before the game? (spec §31) */
export type LiveClass = "LIVE_CAPABLE" | "RETROSPECTIVE_ONLY" | "PRIOR_ONLY_CURRENT_SEASON";

/** Every published numeric field is exactly one of these (aligns with FI guardrail 5). */
export type OutputClass = "OBSERVED" | "MODELED" | "DESCRIPTIVE_ONLY";

/** Sample / evidence support for a split or interaction (spec §26). */
export type EvidenceClass = "STRONG" | "MODERATE" | "WEAK" | "INSUFFICIENT";

/** Walk-forward validation state of a predictive interaction (spec §30, §35). */
export type ValidationStatus =
  | "SHARED_DESCRIPTIVE" // observable tendency, not a forecast
  | "SHADOW_PREDICTIVE" // predictive estimate, SHADOW_ONLY, no production influence
  | "OOS_VALIDATED_SHADOW" // beats baseline OOS but still shadow pending integration decision
  | "NULL_FINDING" // no incremental value after baseline control -> adjustment 0
  | "UNVALIDATED";

export type DepthBin = "BEHIND_LOS" | "SHORT" | "INTERMEDIATE" | "DEEP";
export type FieldThird = "LEFT" | "MIDDLE" | "RIGHT";

export interface PsiSourceLineage {
  source: string;
  availability_state: AvailabilityState;
  live_class: LiveClass;
  data_cutoff: Record<string, number>; // per-source max NFL (season*100+week) ingested
  seasons_used: number[];
  as_of_season: number;
  as_of_week: number;
  /** true when the profile is a prior-season profile shown in the current season with no current update. */
  prior_only_current_season: boolean;
}

/** One cell of a QB (or defense-allowed) depth x field-third matrix (spec §4, §18, §38). */
export interface SpatialCell {
  depth_bin: DepthBin;
  field_third: FieldThird;
  attempts: number | null;
  attempt_share: number | null; // share of the entity's charted attempts
  completions: number | null;
  completion_pct: number | null;
  air_yards: number | null;
  yards_per_attempt: number | null;
  epa_per_attempt: number | null;
  success_rate: number | null;
  td_rate: number | null;
  int_rate: number | null;
  explosive_rate: number | null;
  first_down_rate: number | null;
  yac: number | null;
  evidence_class: EvidenceClass;
  output_class: OutputClass;
}

/** Detailed QB depth/location/tendency profile (spec §4, §5, §6, §7, §8, §32). */
export interface QBSpatialProfile {
  gsis_id: string;
  full_name: string | null;
  nfl_team: string | null;
  window: "career" | "recent" | "current_team";
  /** raw machine-readable matrix — 12 cells, visual-ready (spec §38). */
  matrix: SpatialCell[];
  directional: {
    left_pct: number | null;
    middle_pct: number | null;
    right_pct: number | null;
    behind_los_pct: number | null;
    short_pct: number | null;
    intermediate_pct: number | null;
    deep_pct: number | null;
    deep_left_pct: number | null;
    deep_middle_pct: number | null;
    deep_right_pct: number | null;
  };
  /** each directional field's deviation from the league QB baseline, in percentage points. */
  vs_league_baseline: Record<string, number | null>;
  pressure_profile?: SplitProfile[]; // pressured / clean / blitz / non-blitz
  coverage_profile?: SplitProfile[]; // man / zone / coverage family (PRIOR_ONLY)
  concept_profile?: SplitProfile[]; // shotgun/UC/pistol/PA/motion/RPO/screen/OOP (DESCRIPTIVE_ONLY)
  stability?: {
    metric: string;
    career_value: number | null;
    recent_value: number | null;
    cross_season_sd: number | null;
    breakpoint_flags: string[]; // e.g. "team_change:2025", "oc_change:2024"
  }[];
  lineage: PsiSourceLineage;
  resolution?: "UNRESOLVED";
}

/** A generic tendency + efficiency split (pressure, coverage, route, box, concept). */
export interface SplitProfile {
  dimension: string; // "pressure" | "coverage" | "route" | "box" | "concept"
  bucket: string; // "PRESSURED" | "MAN" | "SLANT" | "HEAVY_BOX" | ...
  /** how OFTEN — the tendency (spec §5, §33). */
  usage_share: number | null;
  /** how WELL — the efficiency (kept distinct from usage). */
  epa: number | null;
  success_rate: number | null;
  completion_pct: number | null; // pass dimensions
  yards_per: number | null;
  explosive_rate: number | null;
  turnover_rate: number | null;
  sample: number | null;
  evidence_class: EvidenceClass;
  output_class: OutputClass;
}

/** Position-specific usage/efficiency tendencies for any skill player (spec §10-15, §21, §32). */
export interface PlayerTendencyProfile {
  gsis_id: string;
  full_name: string | null;
  position: "QB" | "RB" | "WR" | "TE" | string;
  nfl_team: string | null;
  window: "career" | "recent" | "current_team";
  field_area_matrix?: SpatialCell[]; // WR/TE/RB target matrix, RB rush matrix
  route_profile?: SplitProfile[]; // PRIOR_ONLY
  coverage_profile?: SplitProfile[]; // PRIOR_ONLY
  box_profile?: SplitProfile[]; // RB only, PRIOR_ONLY
  archetype_vector: Record<string, number | null>; // always shipped (spec §21)
  archetype_label: string | null; // optional; null when clusters unstable
  lineage: PsiSourceLineage;
  resolution?: "UNRESOLVED";
}

/** Opponent defensive behavior / vulnerability profile (spec §17, §18, §22, §32). */
export interface DefenseSchemeProfile {
  team: string;
  window: "career" | "recent" | "current_scheme_era";
  pass_defense: Record<string, number | null>;
  run_defense: Record<string, number | null>;
  /** allowed-target grid on the SAME depth x field-third definitions (spec §18). */
  vulnerability_map: SpatialCell[];
  man_zone_historical?: { man_rate: number | null; zone_rate: number | null; evidence_class: EvidenceClass };
  coverage_family_historical?: SplitProfile[];
  pressure_profile?: { pressure_rate: number | null; blitz_rate: number | null; pressure_without_blitz_rate: number | null };
  archetype_vector: Record<string, number | null>;
  archetype_label: string | null;
  scheme_era: { season: number; coordinator: string | null; changed_from_prior: boolean };
  lineage: PsiSourceLineage;
  resolution?: "UNRESOLVED";
}

/** Historical / model-estimated interaction between a player profile and an opponent profile (spec §23-30, §32-35). */
export interface PlayerSchemeInteraction {
  gsis_id: string;
  full_name: string | null;
  position: string;
  opponent: string;
  season: number;
  week: number;
  observed_profile_ref: string; // points at the QBSpatialProfile / PlayerTendencyProfile used
  opponent_profile_ref: string;
  interaction: {
    target: string; // one of PSI$INTERACTION_TARGETS — a RESIDUAL, never raw fantasy
    direction: "favorable" | "unfavorable" | "neutral";
    estimated_effect: number | null; // in the target's residual units
    uncertainty: number | null; // posterior / bootstrap SD
    sample_support: number | null; // opponent-games behind the estimate
    evidence_class: EvidenceClass;
    /** HARD default 0 in 2026.1 regardless of estimate (spec §24, §35). */
    numeric_fantasy_adjustment: 0 | number;
    beyond_baseline: boolean | null; // does it survive production-baseline control? (spec §24)
    validation_status: ValidationStatus;
  };
  /** every clause maps to a structured field above (spec §34). */
  explanation: string;
  lineage: PsiSourceLineage;
  availability?: "NOT_AVAILABLE";
}

export interface PlayerSchemeManifest {
  player_scheme_version: string; // psi:<season>:w<week>:<12 hex>
  model_tag: string;
  feature_schema_version: number;
  generated_at: string;
  current_season: number;
  as_of_week: number;
  data_cutoff: Record<string, number>;
  seasons_used: number[];
  model_versions: Record<string, string>;
  source_versions: Record<string, string>;
  deployment: string; // "SHARED_DESCRIPTIVE + SHADOW_PREDICTIVE"
  fantasy_adjustment_enabled: false;
  files: string[];
  notes: string[];
}
