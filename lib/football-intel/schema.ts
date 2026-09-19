/**
 * Football Intelligence Engine — TypeScript read contract (Phase 3, spec §24).
 *
 * READ-ONLY. This module never runs R, never recomputes a statistic. It reads
 * the versioned CSV/JSON artifacts published by
 * `analysis/football_intel/build_snapshot.R` into `lib/football-intel/data/`.
 *
 * Phase 3 does NOT wire this into Team-State or any recommendation engine
 * (spec §32). The contract is defined + tested here; consumption is Phase 4+.
 * The fact/evaluation boundary of Team-State is untouched.
 */

export const FOOTBALL_INTEL_CONTRACT_VERSION = "football-intel-read-2026.1";

/** Every published numeric field is exactly one of these (spec guardrail 5). */
export type OutputClass = "OBSERVED" | "MODELED" | "DESCRIPTIVE_ONLY";

export type Confidence = "HIGH" | "MEDIUM" | "LOW" | "INSUFFICIENT_SAMPLE";

export type TrendDirection = "improving" | "deteriorating" | "stable" | "uncertain";

/**
 * Walk-forward validation verdict (spec §19, §31, guardrail 4). A
 * NOT_PREDICTIVE rating is still published as an honest opponent-adjusted
 * summary of what happened, but MUST NOT be presented as a forecast.
 */
export type PredictiveStatus =
  | "PREDICTIVE"
  | "WEAKLY_PREDICTIVE"
  | "NOT_PREDICTIVE"
  | "DESCRIPTIVE_TENDENCY"
  | "UNVALIDATED";

/** COMPLETE only when every scheduled REG game for `latest_week` has a final
 * result; anything else, including zero completed games, is PARTIAL. Derived
 * from schedule/result data by `FI$compute_week_completion()` in
 * `analysis/football_intel/config.R` -- never from calendar date. */
export interface FootballIntelligenceWeekCompletion {
  latest_week: number;
  week_state: "PARTIAL" | "COMPLETE";
  games_completed_in_latest_week: number;
  games_scheduled_in_latest_week: number;
  latest_completed_game_date: string | null;
}

export interface FootballIntelligenceManifest {
  football_intelligence_version: string; // fi:<season>:w<week>:<12 hex>
  model_tag: string;
  feature_schema_version: number;
  generated_at: string;
  season: number;
  through_week: number;
  /**
   * Present on every manifest built after the daily-refresh partial-week
   * upgrade. Optional (not `undefined`-unsafe to read, but genuinely absent)
   * on any manifest frozen before that change -- never fabricate this when
   * it's missing.
   */
  week_completion?: FootballIntelligenceWeekCompletion;
  /** per-source max NFL week actually ingested for `season` (spec §3, guardrail 2). */
  data_cutoff: Record<string, number>;
  seasons_used: { prior: number[]; current: number };
  model_versions: Record<string, string>;
  source_versions: Record<string, string>;
  config: Record<string, number>;
  files: string[];
  output_classes: OutputClass[];
  determinism: string;
  notes: string[];
}

/** One MODELED team-unit rating with its full explainability decomposition (spec §26). */
export interface TeamMetricRating {
  team: string;
  side: "offense" | "defense";
  metric: string;
  output_class: OutputClass;
  predictive_status: PredictiveStatus;
  raw: number | null;
  /** opponent-adjusted, prior-informed, recency-weighted, shrunk. Deviation from league mean. */
  modeled: number | null;
  league_mean: number | null;
  league_percentile: number | null;
  n_obs_effective: number | null;
  prior_mean: number | null;
  prior_n_seasons: number | null;
  prior_discount: number | null;
  prior_weight: number | null;
  recent_weight: number | null;
  shrunk_to_league: number | null;
  std_error: number | null;
  confidence: Confidence;
  trend: {
    current_level: number | null;
    recent_level: number | null;
    direction: TrendDirection;
    magnitude: number | null;
    confidence: Confidence;
  };
}

export interface TeamProfile {
  team: string;
  season: number;
  through_week: number;
  offense: Record<string, TeamMetricRating>;
  defense: Record<string, TeamMetricRating>;
}

export interface PlayerUsageMetric {
  metric: string;
  output_class: OutputClass;
  observed: number | null;
  modeled: number | null;
  position_mean: number | null;
  prior_season: number | null;
  prior_weight: number | null;
  recent_weight: number | null;
  confidence: Confidence;
}

export interface PlayerUsageProfile {
  gsis_id: string;
  sleeper_id: string | null;
  pfr_id: string | null;
  full_name: string | null;
  position: string | null;
  nfl_team: string | null;
  season: number;
  through_week: number;
  games: number | null;
  eff_games: number | null;
  last_week: number | null;
  metrics: Record<string, PlayerUsageMetric>;
  /** set when the join key could not be resolved to any published row. */
  resolution?: "UNRESOLVED";
}

export interface CoverageAllowedRating {
  team: string;
  position: "RB" | "WR" | "TE";
  metric: string;
  output_class: OutputClass;
  raw: number | null;
  modeled: number | null;
  league_percentile: number | null;
  prior_mean: number | null;
  confidence: Confidence;
}

export interface ContextualMatchupFeature {
  feature: string;
  season: number;
  through_week: number;
  offense_team: string | null;
  defense_team: string | null;
  offense_rating: number | null;
  defense_rating: number | null;
  offense_percentile: number | null;
  defense_percentile: number | null;
  /** in [-1, 1]; POSITIVE favors the offense on that axis. NOT fantasy points (spec §16). */
  interaction_signal: number | null;
  /** e.g. "off:PREDICTIVE|def:NOT_PREDICTIVE" — confidence is capped at LOW when either side is NOT_PREDICTIVE. */
  predictive_status: string;
  confidence: Confidence;
  output_class: OutputClass;
  availability?: "NOT_AVAILABLE";
}

export interface FtnDescriptive {
  team: string;
  metric: string;
  value: number | null;
  n_plays: number | null;
  availability: string;
  output_class: "DESCRIPTIVE_ONLY";
  source_coverage: string;
  season_bounds: string;
}


/**
 * One receiver-week FTN progression bucket. DESCRIPTIVE_ONLY: this describes
 * the read on which an actual target was thrown. It does not infer the full
 * unthrown receiver progression on the play.
 */
export type ReceiverReadBucket =
  | "FIRST_READ"
  | "SECOND_READ"
  | "THIRD_PLUS_READ"
  | "CHECKDOWN"
  | "DESIGNED"
  | "SCRAMBLE_DRILL"
  | "OTHER";

export interface ReceiverProgressionRow {
  season: number;
  week: number;
  team: string;
  opponent: string;
  gsis_id: string;
  sleeper_id: string | null;
  full_name: string | null;
  passer_gsis_id: string | null;
  bucket: ReceiverReadBucket;
  targets: number;
  target_read_share: number | null;
  receptions: number;
  receiving_yards: number;
  yards_per_target: number | null;
  air_yards: number | null;
  adot: number | null;
  yac: number | null;
  epa_per_target: number | null;
  success_rate: number | null;
  first_down_rate: number | null;
  explosive_rate: number | null;
  receiving_tds: number;
  td_rate: number | null;
  targets_eligible: number;
  targets_charted_read: number;
  read_coverage_rate: number | null;
  output_class: "DESCRIPTIVE_ONLY";
  source: "nflverse_ftn" | string;
  read_semantics: string;
}
