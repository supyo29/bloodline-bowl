/**
 * Start/Sit — comparative reasoning for a close lineup decision.
 *
 * Not "A projects higher, start A". A small edge is presented as small: a
 * 0.2-pt gap between two ~12-pt players is LOW confidence no matter how clean
 * the inputs look (see `decisionConfidence`). Floor/ceiling/availability edges
 * are shown alongside the projection edge so the manager sees the trade-off.
 */

import { decisionConfidence } from "./uncertainty";
import type { Confidence, WeeklyProjection, WeeklyReplacement } from "./schema";

export interface StartSitComparison {
  slot: string | null;
  start_player_id: string;
  over_player_id: string;
  projection_edge: number | null;
  floor_edge: number | null;
  ceiling_edge: number | null;
  availability_edge: "safer" | "riskier" | "neutral";
  replacement_impact: "positive" | "neutral" | "negative";
  confidence: Confidence;
  recommendation: "START_A" | "START_B" | "TOO_CLOSE";
  reasons: string[];
}

export function compareStartSit(input: {
  slot: string | null;
  a: WeeklyProjection | null;
  b: WeeklyProjection | null;
  a_id: string;
  b_id: string;
  replacement?: WeeklyReplacement;
}): StartSitComparison {
  const { a, b, slot } = input;
  const aPts = a?.projected_points ?? null;
  const bPts = b?.projected_points ?? null;
  const projection_edge = aPts != null && bPts != null ? round1(aPts - bPts) : null;
  const floor_edge = a?.floor_points != null && b?.floor_points != null ? round1(a.floor_points - b.floor_points) : null;
  const ceiling_edge =
    a?.ceiling_points != null && b?.ceiling_points != null ? round1(a.ceiling_points - b.ceiling_points) : null;

  const availA = a?.expected_availability ?? 1;
  const availB = b?.expected_availability ?? 1;
  const availability_edge =
    availA - availB > 0.1 ? "safer" : availB - availA > 0.1 ? "riskier" : "neutral";

  // Replacement impact: does benching the loser cost anything relative to the wire?
  let replacement_impact: StartSitComparison["replacement_impact"] = "neutral";
  if (input.replacement && slot) {
    const rep = input.replacement.by_position[slot]?.replacement_points ?? null;
    if (rep != null && bPts != null) {
      if (bPts - rep > 4) replacement_impact = "negative"; // the sat player is well above waiver — real opportunity cost
      else if (bPts - rep < 0) replacement_impact = "positive";
    }
  }

  const confidence = decisionConfidence({
    edge: projection_edge ?? 0,
    std_dev_a: a?.std_dev ?? null,
    std_dev_b: b?.std_dev ?? null,
    incomplete: aPts == null || bPts == null,
    uncertainty_is_heuristic:
      a?.uncertainty_source === "position_volatility_heuristic" ||
      b?.uncertainty_source === "position_volatility_heuristic",
  });

  let recommendation: StartSitComparison["recommendation"] = "TOO_CLOSE";
  if (projection_edge != null) {
    if (projection_edge >= 0.75 && confidence !== "LOW") recommendation = "START_A";
    else if (projection_edge <= -0.75 && confidence !== "LOW") recommendation = "START_B";
    else if (Math.abs(projection_edge) >= 2.5) recommendation = projection_edge > 0 ? "START_A" : "START_B";
  } else if (aPts != null && bPts == null) recommendation = "START_A";
  else if (bPts != null && aPts == null) recommendation = "START_B";

  const reasons: string[] = [];
  if (projection_edge != null) {
    reasons.push(`Projection edge ${signed(projection_edge)} to ${projection_edge >= 0 ? "A" : "B"}.`);
  } else reasons.push("One side has no projection — decision is low confidence.");
  if (floor_edge != null) reasons.push(`Floor edge ${signed(floor_edge)}.`);
  if (ceiling_edge != null) reasons.push(`Ceiling edge ${signed(ceiling_edge)}.`);
  if (availability_edge !== "neutral") reasons.push(`Availability: A is ${availability_edge}.`);
  if (replacement_impact === "negative") reasons.push("Benching B has real opportunity cost (B is well above the waiver line).");
  if (recommendation === "TOO_CLOSE") reasons.push("Difference is inside the noise — treat as a coin flip.");

  return {
    slot,
    start_player_id: recommendation === "START_B" ? input.b_id : input.a_id,
    over_player_id: recommendation === "START_B" ? input.a_id : input.b_id,
    projection_edge,
    floor_edge,
    ceiling_edge,
    availability_edge,
    replacement_impact,
    confidence,
    recommendation,
    reasons,
  };
}

const round1 = (v: number) => Math.round(v * 10) / 10;
const signed = (v: number) => (v >= 0 ? `+${v.toFixed(1)}` : v.toFixed(1));
