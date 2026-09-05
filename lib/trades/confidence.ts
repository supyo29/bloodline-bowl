/**
 * Trade Engine — Phase 3C: uncertainty and confidence.
 *
 * Confidence reflects DATA QUALITY, not whether the model "likes" the trade —
 * a highly confident result can still be close to neutral, and a low-
 * confidence result can still carry a large expected value. The two are kept
 * as separate fields everywhere in Phase 3; nothing here folds uncertainty
 * into a value penalty.
 *
 * Every input is a REAL, already-computed degradation signal from Phase 1/2/3
 * (projection coverage, ROS coverage, schedule verification, unresolved
 * identities, player-intelligence availability, and disagreement between the
 * three acceptance layers) — never a fabricated "trust score".
 */

import type { TradeDiagnostic } from "./schema";
import type { AcceptanceClass } from "./schema";

export type ConfidenceLevel = "HIGH" | "MEDIUM" | "LOW" | "DEGRADED";

export interface ConfidenceInputs {
  /** Phase 1/2 projection batch status for the current week */
  projections_status: "READY" | "PROJECTIONS_PARTIAL" | "PROJECTIONS_UNAVAILABLE";
  /** rostered players (before+after) with no ROS signal, on this participant's rosters */
  ros_uncovered_count: number;
  roster_size: number;
  /** unresolved player identities anywhere in the league snapshot */
  unresolved_player_count: number;
  ros_schedule_status: "READY" | "PARTIAL" | "UNAVAILABLE";
  /** transferred players whose player-intelligence volatility/availability is UNKNOWN */
  intelligence_unknown_count: number;
  /**
   * Audit D3 fix: transferred players whose `VolatilityIntelligence.ros_confidence`
   * (the underlying RI-vs-external model's own self-reported confidence) is
   * `LOW`. This is a real, already-computed signal that was previously captured
   * on `PlayerIntelligence` but never consulted anywhere — a `LOW`
   * `ros_confidence` on a small `disagreement_pct` used to read identically to
   * a `HIGH`-confidence one. Now it degrades confidence the same way an
   * unresolved/unknown intelligence signal does.
   */
  low_ros_confidence_count: number;
  transferred_player_count: number;
  /** true when Phase 1 / Phase 2 / Phase 3-shadow acceptance are not all equal */
  model_disagreement: boolean;
}

export interface ConfidenceResult {
  level: ConfidenceLevel;
  reasons: string[];
  inputs: ConfidenceInputs;
}

const round2 = (v: number): number => Math.round(v * 100) / 100;

export function classifyConfidence(inputs: ConfidenceInputs): ConfidenceResult {
  const reasons: string[] = [];
  let score = 0; // higher = more confident; degraded floor below

  if (inputs.projections_status === "PROJECTIONS_UNAVAILABLE") {
    reasons.push("current-week projections are unavailable");
    return { level: "DEGRADED", reasons, inputs };
  }
  if (inputs.projections_status === "PROJECTIONS_PARTIAL") {
    reasons.push("current-week projections are partial");
    score -= 1;
  }

  const rosCoverage = inputs.roster_size > 0 ? 1 - inputs.ros_uncovered_count / inputs.roster_size : 1;
  if (rosCoverage < 0.7) {
    reasons.push(`ROS coverage is low (${round2(rosCoverage * 100)}% of rostered players have a rest-of-season signal)`);
    score -= 2;
  } else if (rosCoverage < 0.95) {
    reasons.push(`ROS coverage is partial (${round2(rosCoverage * 100)}%)`);
    score -= 1;
  }

  if (inputs.ros_schedule_status === "UNAVAILABLE") {
    reasons.push("no authoritative NFL schedule was available — bye/ROS effects are not modeled");
    score -= 2;
  } else if (inputs.ros_schedule_status === "PARTIAL") {
    reasons.push("the NFL schedule was only partially verified across the ROS window");
    score -= 1;
  }

  if (inputs.unresolved_player_count > 0) {
    reasons.push(`${inputs.unresolved_player_count} player identity/identities in this league could not be resolved`);
    score -= 1;
  }

  const intelUnknownFrac = inputs.transferred_player_count > 0 ? inputs.intelligence_unknown_count / inputs.transferred_player_count : 0;
  if (intelUnknownFrac > 0.5) {
    reasons.push("volatility/availability signal is unknown for most transferred players");
    score -= 1;
  }

  const lowRosConfidenceFrac = inputs.transferred_player_count > 0 ? inputs.low_ros_confidence_count / inputs.transferred_player_count : 0;
  if (lowRosConfidenceFrac > 0.5) {
    reasons.push("the underlying rest-of-season model itself reports LOW confidence for most transferred players");
    score -= 1;
  }

  if (inputs.model_disagreement) {
    reasons.push("Phase 1, Phase 2 and/or Phase 3 acceptance classes disagree");
    score -= 1;
  }

  let level: ConfidenceLevel;
  if (score <= -4) level = "DEGRADED";
  else if (score <= -2) level = "LOW";
  else if (score < 0) level = "MEDIUM";
  else level = "HIGH"; // score === 0 -> every input was complete and current

  if (reasons.length === 0) reasons.push("all inputs are complete and current");

  return { level, reasons, inputs };
}

/** true iff the three acceptance classes are not all identical (null entries ignored). */
export function detectModelDisagreement(...acceptances: Array<AcceptanceClass | null>): boolean {
  const present = acceptances.filter((a): a is AcceptanceClass => a != null);
  return new Set(present).size > 1;
}

export interface ValuationRange {
  estimate: number;
  low: number;
  high: number;
  /** what the band is derived from — never implies a rigorous statistical CI unless it is one */
  basis: "std_dev_heuristic" | "single_point_no_band";
}

/**
 * A defensible, non-statistical `valuation_range` around a point estimate,
 * widened by available volatility evidence (weekly std_dev as a fraction of the
 * estimate). This is explicitly NOT a confidence interval — see `basis`.
 */
export function buildValuationRange(estimate: number, relativeVolatility: number | null): ValuationRange {
  if (relativeVolatility == null || relativeVolatility <= 0) {
    return { estimate: round2(estimate), low: round2(estimate), high: round2(estimate), basis: "single_point_no_band" };
  }
  const halfWidth = Math.abs(estimate) * relativeVolatility + Math.abs(relativeVolatility) * 1.5;
  return {
    estimate: round2(estimate),
    low: round2(estimate - halfWidth),
    high: round2(estimate + halfWidth),
    basis: "std_dev_heuristic",
  };
}

export function highDisagreementDiagnostic(): TradeDiagnostic {
  return {
    code: "MODEL_DISAGREEMENT_HIGH",
    message: "Phase 1, Phase 2 and/or Phase 3-shadow acceptance classes disagree for this participant — see divergence reasons.",
    severity: "info",
  };
}
