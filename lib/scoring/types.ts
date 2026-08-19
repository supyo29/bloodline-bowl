/**
 * Types for the scoring-analysis endpoints (`GET /api/scoring`,
 * `POST /api/scoring/calculate`).
 */

/** The scoring categories the label catalog sorts Sleeper's keys into. */
export type ScoringCategory =
  | "passing"
  | "rushing"
  | "receiving"
  | "turnovers"
  | "kicking"
  | "defense"
  | "special_teams"
  | "bonuses"
  | "other";

export interface ScoringCatalogEntry {
  label: string;
  category: ScoringCategory;
}

/** A single Sleeper scoring key, normalized with a readable label. */
export interface NormalizedScoringRule {
  key: string;
  label: string;
  category: ScoringCategory;
  points: number;
}

export interface ScoringBreakdownEntry {
  stat: string;
  label: string;
  category: ScoringCategory;
  value: number;
  multiplier: number;
  points: number;
}

/** A stat line: Sleeper stat key -> raw stat total (e.g. `{ pass_yd: 300 }`). */
export type StatLine = Record<string, number>;

export interface CalculationResult {
  fantasy_points: number;
  breakdown: ScoringBreakdownEntry[];
  warnings: string[];
}

export interface ArchetypeResult {
  description: string;
  stats: StatLine;
  fantasy_points: number;
  breakdown: ScoringBreakdownEntry[];
}

export type ArchetypeKey =
  | "pocket_qb"
  | "rushing_qb"
  | "workhorse_rb"
  | "receiving_rb"
  | "volume_wr"
  | "big_play_wr"
  | "typical_te"
  | "elite_te_game";

export interface SensitivityScenario {
  description: string;
  /** What changed, expressed as a scoring-key delta. */
  adjustment: { key: string; delta: number };
  /** Fantasy-point change per archetype, positive or negative. */
  changes: Record<ArchetypeKey, number>;
}

export type SensitivityKey =
  | "pass_td_plus_1"
  | "interception_penalty_minus_1"
  | "reception_plus_0_5"
  | "rush_td_plus_1"
  | "rec_td_plus_1";

export type DiagnosticSeverity = "informational" | "notable" | "strong";

export interface ScoringDiagnostic {
  id: string;
  severity: DiagnosticSeverity;
  message: string;
}

export interface ScoringClassification {
  /** Reception-value tier, derived from the `rec` key alone. */
  base: "standard" | "half_ppr" | "full_ppr" | "custom_ppr";
  /** Only rules actually present are listed; nothing is assumed. */
  features: string[];
}

/** Nullable numeric fields: `null` means the underlying Sleeper key is unset. */
export interface DerivedPassing {
  pass_yd_value: number | null;
  points_per_25_pass_yards: number | null;
  points_per_100_pass_yards: number | null;
  passing_td_value: number | null;
  interception_penalty: number | null;
  two_point_conversion_value: number | null;
  sack_taken_penalty: number | null;
}

export interface DerivedRushing {
  rush_yd_value: number | null;
  points_per_10_rush_yards: number | null;
  points_per_100_rush_yards: number | null;
  rushing_td_value: number | null;
  two_point_conversion_value: number | null;
}

export interface DerivedReceiving {
  reception_value: number | null;
  rec_yd_value: number | null;
  points_per_10_receiving_yards: number | null;
  points_per_100_receiving_yards: number | null;
  receiving_td_value: number | null;
  two_point_conversion_value: number | null;
  /** Present only when Sleeper's TE-premium key is configured. */
  te_premium_bonus: number | null;
}

export interface DerivedTurnovers {
  interception_thrown_penalty: number | null;
  fumble_lost_penalty: number | null;
  /** A fumble that was NOT lost; some leagues still penalize it slightly. */
  fumble_penalty_no_loss: number | null;
}

export interface DerivedKicking {
  extra_point_made: number | null;
  extra_point_missed: number | null;
  field_goal_missed: number | null;
  /** Sleeper's flat "any distance" field-goal key, when configured. */
  field_goal_made_flat: number | null;
  /** Only the distance tiers that are actually nonzero. */
  field_goal_distance_tiers: Record<string, number>;
  /** True when distance tiers are all zero/absent and only the flat key scores. */
  uses_flat_scoring: boolean;
}

export interface DerivedDefense {
  sack: number | null;
  interception: number | null;
  fumble_recovery: number | null;
  forced_fumble: number | null;
  safety: number | null;
  blocked_kick: number | null;
  defensive_touchdown: number | null;
  points_allowed_scoring_model: "per_point_penalty" | "tiered_bonus" | "none";
  points_allowed_per_point: number | null;
  /** Only the tiers that are actually nonzero. */
  points_allowed_tiers: Record<string, number>;
}

export interface DerivedBonuses {
  passing_two_point_conversion: number | null;
  rushing_two_point_conversion: number | null;
  receiving_two_point_conversion: number | null;
  /** Any `bonus_*` scoring key present with a nonzero value. */
  big_play_bonuses: Record<string, number>;
}

export interface ScoringResponse {
  generated_at: string;
  source: "Sleeper";
  league_id: string;

  league: {
    name: string;
    season: string;
    roster_positions: string[];
  };

  scoring: {
    /** Sleeper's untouched `scoring_settings` object. */
    raw: Record<string, number>;
    normalized: NormalizedScoringRule[];
  };

  derived: {
    passing: DerivedPassing;
    rushing: DerivedRushing;
    receiving: DerivedReceiving;
    turnovers: DerivedTurnovers;
    kicking: DerivedKicking;
    defense: DerivedDefense;
    bonuses: DerivedBonuses;
  };

  comparisons: {
    td_values: {
      passing: number | null;
      rushing: number | null;
      receiving: number | null;
    };
    yardage_equivalencies: {
      "100_pass_yards": number | null;
      "100_rush_yards": number | null;
      "100_receiving_yards": number | null;
    };
    ratios: {
      rushing_td_to_passing_td: number | null;
      receiving_td_to_passing_td: number | null;
      rush_yard_to_pass_yard_value: number | null;
      receiving_yard_to_pass_yard_value: number | null;
    };
  };

  classification: ScoringClassification;

  archetype_examples: Record<ArchetypeKey, ArchetypeResult>;

  sensitivity: Record<SensitivityKey, SensitivityScenario>;

  diagnostics: ScoringDiagnostic[];

  /** Stable, deterministic rule set for applying this scoring to external stats. */
  scoring_engine: {
    version: 1;
    rules: Record<string, { points: number; category: ScoringCategory }>;
  };

  metadata: {
    rule_count: number;
    warnings: string[];
  };
}
