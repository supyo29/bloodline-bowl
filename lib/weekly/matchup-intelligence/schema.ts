/**
 * Phase 5 — Matchup Intelligence contract (SHADOW_ONLY, Scope 2).
 *
 * Calibrated score distributions + win probability + a structured
 * degradation/confidence vector + scenario explanations, computed alongside
 * the untouched production `buildMatchup`. NO Phase 5 output alters production
 * lineup selection, `buildOptimalLineup`, `maxSlotMatching`, Start/Sit, trades,
 * or waivers. There is no `MAX_WIN_PROBABILITY` objective.
 *
 * Backtest verdict (docs/TEAM_MANAGEMENT_PHASE_5.md):
 *   - the calibrated marginal model materially fixes the current MC's
 *     overconfidence (cal slope 0.66 -> 1.08; Brier -0.0035, logloss -0.016)
 *   - the 2-factor dependence adds NO incremental calibration value -> it is a
 *     DIAGNOSTIC only, never in the headline win probability.
 */

export const MATCHUP_INTELLIGENCE_CONTRACT_VERSION = "matchup-intelligence-2026.1";

export type MatchupDeploymentState =
  | "SHADOW_ONLY"
  | "RESEARCH_ELIGIBLE"
  | "CERTIFICATION_PASSED"
  | "PRODUCTION_ELIGIBLE"
  | "PRODUCTION_ACTIVE"
  | "CERTIFICATION_FAILED";

export interface ScoreDistribution {
  expected: number;
  sd: number;
  p10: number;
  p25: number;
  median: number;
  p75: number;
  p90: number;
}

export type DegradationReason =
  | "MISSING_PROJECTION"
  | "UNKNOWN_STARTER"
  | "INCOMPLETE_LINEUP"
  | "QUESTIONABLE_ROLE"
  | "CORRELATION_UNAVAILABLE"
  | "GAME_CONTEXT_UNAVAILABLE"
  | "PRIOR_ONLY_FI"
  | "NON_PREGAME_STATE"
  | "INSUFFICIENT_POSITION_SAMPLE"
  | "UNCALIBRATED_POSITION"
  | "OPPONENT_LINEUP_ASSUMED"
  | "OPPONENT_LINEUP_INCOMPLETE"
  | "BASELINE_PROVENANCE_DEGRADED"
  | "DISTRIBUTION_MODEL_UNAVAILABLE"
  | "SIMULATION_WIDE";

export interface DegradationVector {
  reasons: DegradationReason[];
  /** derived: floor of the component severities. */
  overall: "HIGH" | "MEDIUM" | "LOW" | "INSUFFICIENT";
  /** structured per-component detail for downstream consumers. */
  detail: Record<string, string | number | boolean | null>;
}

export interface MatchupLineage {
  matchup_model_version: string;
  distribution_model_version: string | null;
  correlation_model_version: string | null;
  projection_lineage: { model_version: string; source: string };
  football_intelligence_version: string | null; // "not_used" in v1
  league_snapshot_id: string | null;
  scoring_fingerprint: string | null;
  sim_seed: number;
  sim_seed_identity: string;
  sim_count: number;
  sim_win_probability_se: number;
  opponent_view: "PLAUSIBLE" | "SUBMITTED" | "ASSUMED_OPTIMAL";
  deployment: MatchupDeploymentState;
  contract_version: string;
  generated_at: string;
}

export interface ScenarioExplanation {
  code: string;
  message: string;
  /** the actual simulator inputs this explanation maps to (spec §22, §24). */
  evidence: Record<string, number | string | null>;
}

export interface LeverageDiagnostic {
  slot: string;
  current_player_id: string;
  alternative_player_id: string;
  expected_point_diff: number;
  variance_diff: number | null;
  correlation_diff: number | null;
  baseline_win_probability: number;
  alternative_win_probability: number;
  delta_win_probability: number;
  model_confidence: DegradationVector["overall"];
  resolution: "OK" | "UNRESOLVED";
}

export interface MatchupIntelligence {
  week: number;
  team_id: string;
  opponent_team_id: string | null;
  has_opponent: boolean;

  team_score: ScoreDistribution | null;
  opponent_score: ScoreDistribution | null;
  margin: ScoreDistribution | null;

  /** whole-percent for display; full precision retained internally. */
  win_probability: number | null;
  win_probability_pct: number | null;
  win_probability_interval: { low: number; high: number } | null; // ± MC SE
  tie_probability: number | null;
  expected_margin: number | null;
  upset_probability: number | null; // P(win | expected_margin < 0)
  blowout_probability: number | null; // P(|margin| > 25)

  confidence: DegradationVector;

  /** DIAGNOSTIC — the 2-factor dependence was rejected for headline WP. */
  dependence_diagnostics: {
    win_probability_with_dependence: number | null;
    delta_vs_independent: number | null;
    correlation_model: string | null;
    note: string;
  } | null;

  explanations: ScenarioExplanation[];

  /** SHADOW diagnostic only — never alters production lineup selection. */
  leverage_diagnostics: LeverageDiagnostic[];

  lineage: MatchupLineage;
  warnings: string[];
}
