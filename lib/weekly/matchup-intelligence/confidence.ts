/**
 * Phase 5 — structured degradation / confidence vector (spec §11, §19).
 * Not one arbitrary label — a list of reasons + a derived overall grade.
 */
import type { DegradationVector, DegradationReason } from "./schema";

export interface DegradationInput {
  team_unknown_starters: number;
  opp_unknown_starters: number;
  team_missing_projection: number;
  opp_missing_projection: number;
  team_incomplete: boolean;
  opp_incomplete: boolean;
  questionable_starters: number;
  uncalibrated_positions: string[];
  correlation_available: boolean;
  game_context_available: boolean;
  fi_prior_only: boolean;
  non_pregame: boolean;
  opponent_view: "PLAUSIBLE" | "SUBMITTED" | "ASSUMED_OPTIMAL";
  distribution_model_present: boolean;
  sim_se: number;
  baseline_provenance_degraded: boolean;
}

export function buildDegradation(i: DegradationInput): DegradationVector {
  const reasons: DegradationReason[] = [];
  if (!i.distribution_model_present) reasons.push("DISTRIBUTION_MODEL_UNAVAILABLE");
  if (i.team_missing_projection + i.opp_missing_projection > 0) reasons.push("MISSING_PROJECTION");
  if (i.team_unknown_starters + i.opp_unknown_starters > 0) reasons.push("UNKNOWN_STARTER");
  if (i.team_incomplete || i.opp_incomplete) reasons.push("INCOMPLETE_LINEUP");
  if (i.questionable_starters > 0) reasons.push("QUESTIONABLE_ROLE");
  if (i.uncalibrated_positions.length > 0) reasons.push("UNCALIBRATED_POSITION");
  if (!i.correlation_available) reasons.push("CORRELATION_UNAVAILABLE");
  if (!i.game_context_available) reasons.push("GAME_CONTEXT_UNAVAILABLE");
  if (i.fi_prior_only) reasons.push("PRIOR_ONLY_FI");
  if (i.non_pregame) reasons.push("NON_PREGAME_STATE");
  if (i.opponent_view !== "SUBMITTED") reasons.push("OPPONENT_LINEUP_ASSUMED");
  if (i.opp_incomplete) reasons.push("OPPONENT_LINEUP_INCOMPLETE");
  if (i.baseline_provenance_degraded) reasons.push("BASELINE_PROVENANCE_DEGRADED");
  if (i.sim_se >= 0.01) reasons.push("SIMULATION_WIDE");

  // overall = floor of the components. A distribution model + full coverage +
  // calibrated positions + a SUBMITTED opponent is the only path to HIGH.
  let overall: DegradationVector["overall"] = "HIGH";
  const hard = ["DISTRIBUTION_MODEL_UNAVAILABLE", "INCOMPLETE_LINEUP", "UNKNOWN_STARTER"] as const;
  const medium = ["MISSING_PROJECTION", "UNCALIBRATED_POSITION", "NON_PREGAME_STATE", "OPPONENT_LINEUP_INCOMPLETE"] as const;
  if (reasons.some((r) => hard.includes(r as (typeof hard)[number]))) overall = "INSUFFICIENT";
  else if (reasons.some((r) => medium.includes(r as (typeof medium)[number]))) overall = "LOW";
  else if (reasons.length > 0) overall = "MEDIUM";
  // v1: the current live FI snapshot is a prior; even a clean matchup tops out
  // at MEDIUM while the distribution model itself has never been prod-certified.
  if (overall === "HIGH") overall = "MEDIUM";

  return {
    reasons,
    overall,
    detail: {
      team_unknown_starters: i.team_unknown_starters,
      opp_unknown_starters: i.opp_unknown_starters,
      questionable_starters: i.questionable_starters,
      uncalibrated_positions: i.uncalibrated_positions.join(",") || null,
      correlation_available: i.correlation_available,
      game_context_available: i.game_context_available,
      opponent_view: i.opponent_view,
      sim_se: Math.round(i.sim_se * 1e4) / 1e4,
      baseline_provenance_degraded: i.baseline_provenance_degraded,
    },
  };
}
