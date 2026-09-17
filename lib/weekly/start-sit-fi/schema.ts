/**
 * Phase 4 — Football Intelligence → Start/Sit translation contract.
 *
 * A dedicated, deterministic, versioned, confidence-aware, ABLATABLE layer
 * between the certified Phase 3 FI artifact and the weekly lineup decision.
 * It never scatters FI logic elsewhere; it never re-derives an FI statistic;
 * it never imports recommendation code into Phase 3.
 *
 * DEPLOYMENT: SHADOW_ONLY (see `start_sit_model.json.deployment`). The backtest
 * showed FI adds no start/sit decision value over the production (RotoWire-
 * backed) baseline for any position — the matchup/pace/efficiency information
 * is already priced into the weekly projection (double-counting, spec §11).
 * This layer therefore computes a comparison but does NOT alter production
 * lineup or start/sit output. It is retained frozen so Phase 5 can consume the
 * contract and the negative finding without a remodel.
 */

export const START_SIT_FI_CONTRACT_VERSION = "start-sit-fi-2026.1";

/** Structured, deterministic reason codes (spec §25). */
export type StartSitFiReasonCode =
  | "BASELINE_PROJECTION_EDGE"
  | "FI_SUCCESS_RATE_ADVANTAGE"
  | "FI_PASS_EFFICIENCY_ADVANTAGE"
  | "FI_RUSH_MATCHUP_ADVANTAGE"
  | "FI_PACE_ADVANTAGE"
  | "FI_EXPLOSIVE_PASS_ADVANTAGE"
  | "FI_USAGE_STABLE"
  | "FI_USAGE_RISK"
  | "FI_OPPONENT_DEFENSE_STRONG"
  | "FI_OPPONENT_DEFENSE_WEAK"
  | "FI_LOW_CONFIDENCE"
  | "FI_NOT_PREDICTIVE"
  | "FI_DESCRIPTIVE_CONTEXT"
  | "FI_UNAVAILABLE"
  | "FI_PRIOR_SEASON_ONLY"
  | "FI_BELOW_TIE_BREAK_GATE"
  | "FI_SHADOW_ONLY";

export interface FiFamilyContribution {
  family: string;
  /** the Phase 3 predictive_status this family carried. */
  routing: "PREDICTIVE" | "WEAKLY_PREDICTIVE" | "NOT_PREDICTIVE" | "DESCRIPTIVE_ONLY" | "UNVALIDATED";
  /** raw Phase 3 value used (percentile / modeled / interaction signal). */
  fi_value: number | null;
  fi_confidence: "HIGH" | "MEDIUM" | "LOW" | "INSUFFICIENT_SAMPLE" | null;
  /** confidence weight actually applied (0 for ineligible routing). */
  confidence_weight: number;
  /** points contribution AFTER routing + confidence + standardization. 0 for ineligible. */
  points_contribution: number;
}

export interface StartSitFiAdjustment {
  canonical_player_id: string;
  position: string;
  nfl_team: string | null;
  opponent: string | null;
  baseline_projection: number | null;
  /** Σ eligible family contributions, before the per-player cap. */
  raw_expected_adjustment: number;
  /** after the documented cap (fraction of |baseline|). */
  expected_adjustment: number;
  /** always 0 in v1 — floor/ceiling adjustments did not validate. */
  floor_adjustment: number;
  ceiling_adjustment: number;
  adjusted_projection: number | null;
  /** min FI confidence across contributing families. */
  decision_confidence: "HIGH" | "MEDIUM" | "LOW" | "INSUFFICIENT_SAMPLE";
  contributions: FiFamilyContribution[];
  reason_codes: StartSitFiReasonCode[];
  warnings: string[];
  /** true when the FI snapshot's season < the request season (2025 prior for a 2026 week). */
  fi_prior_season_only: boolean;
  fi_available: boolean;
}

export interface StartSitFiLineage {
  start_sit_model_version: string;
  /** @deprecated derived from `shadow_football_intelligence.lineage.version` -- kept for API compatibility, never independently recomputed. */
  football_intelligence_version: string | null;
  /** @deprecated derived from `shadow_football_intelligence.lineage.data_cutoff` -- kept for API compatibility, never independently recomputed. */
  football_intel_data_cutoff: Record<string, number> | null;
  baseline_projection_version: string;
  decision_generated_at: string;
  deployment: "SHADOW_ONLY" | "PRODUCTION";
  contract_version: string;
}

export interface StartSitShadowComparison {
  lineage: StartSitFiLineage;
  /**
   * Intelligence Modernization Phase 1. Two SEPARATELY TYPED lineages so no
   * consumer can confuse "FI was evaluated" with "FI influenced the
   * production decision":
   *   - `production_recommendation_lineage` -- what actually determined the
   *     production Start/Sit output (baseline projection provider, canonical
   *     league/scoring state, lineup optimizer). This is `ctx.lineage`
   *     exactly as production sees it -- `football_intelligence` on it is
   *     always `null`, because production never consults FI.
   *   - `shadow_football_intelligence` -- FI's own lineage (if a snapshot is
   *     published) plus the canonical readiness assessment for this shadow
   *     evaluation, and whether it was even eligible to influence
   *     production right now (it never is, in Phase 1).
   */
  production_recommendation_lineage: import("@/lib/canonical/lineage").RecommendationLineage;
  shadow_football_intelligence: {
    lineage: import("@/lib/canonical/lineage").FootballIntelligenceLineage | null;
    readiness: import("@/lib/canonical/recommendation-readiness").RecommendationReadiness;
    eligible_to_influence_production: boolean;
  };
  /** per-player adjustments (all positions; ineligible ones are all-zero). */
  adjustments: StartSitFiAdjustment[];
  baseline_lineup_total: number | null;
  fi_lineup_total: number | null;
  /** entering/leaving the starting lineup under the FI-adjusted projection. */
  lineup_differs: boolean;
  lineup_deltas: Array<{ in: string; out: string | null; slot: string }>;
  /** per pairwise close call: did the FI-adjusted pick differ, and its evidence. */
  start_sit_deltas: Array<{
    slot: string | null;
    baseline_start: string;
    fi_start: string;
    baseline_edge: number | null;
    fi_edge: number | null;
    changed: boolean;
    inside_tie_break_gate: boolean;
    reason_codes: StartSitFiReasonCode[];
  }>;
  notes: string[];
}
