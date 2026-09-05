/**
 * Trade Engine — Phase 6F: strategic preference model.
 *
 * Builds `StrategicTradeAssessment` for ONE participant of an already
 * canonically-evaluated trade (`ParticipantTradeResult`, Phase 1/2's own
 * output — never a new valuation). Every component reuses an existing,
 * already-audited signal: `starter_points_delta` (Phase 1), and Phase 2's
 * `ros_usable_value` / `playoff_window` / `bye_coverage` / `usable_depth` /
 * `roster_fragility` components. Nothing here recomputes roster value.
 *
 * Core Phase 6 Invariant, enforced here: strategic context changes WHICH good
 * trade a manager prefers; it can NEVER turn a fundamentally bad trade good.
 * Enforcement points:
 *   1. Every component is individually capped (`COMPONENT_CAP`).
 *   2. The summed adjustment is capped again, relative to the trade's own
 *      |base_utility_delta| (`capStrategicAdjustment`).
 *   3. `strategic_acceptance` can be promoted from `base_acceptance` by AT
 *      MOST one band, and `HARD_REJECT` can never be promoted at all
 *      (`promotionCeiling`) — a -8 base trade for a 2-7 team stays rejected
 *      no matter how large a raw strategic score would otherwise result.
 */

import type { ParticipantTradeResult } from "../schema";
import type { ManagerStrategicProfile, StrategicAdjustmentComponents, StrategicRecommendation, StrategicTradeAssessment } from "./types";
import {
  BYE_URGENCY_WEIGHT,
  CEILING_FLOOR_PREFERENCE_WEIGHT,
  COMPONENT_CAP,
  DEPTH_FRAGILITY_WEIGHT,
  DEPTH_USABLE_WEIGHT,
  IMMEDIATE_NEED_WEIGHT,
  PLAYOFF_SCHEDULE_ADJUSTMENT_CAP,
  PLAYOFF_SCHEDULE_ELIGIBLE_STATUSES,
  PLAYOFF_SCHEDULE_WEIGHT_BY_STATUS,
  PROMOTION_MIN_ADJUSTMENT,
  SHORT_HORIZON_WEIGHT,
  acceptanceRank,
  capStrategicAdjustment,
  promotionCeiling,
} from "./config";

function clampComponent(x: number): number {
  return Math.max(-COMPONENT_CAP, Math.min(COMPONENT_CAP, x));
}

export function assessStrategicTrade(profile: ManagerStrategicProfile, participant: ParticipantTradeResult): StrategicTradeAssessment {
  const reasons: string[] = [];
  const baseUtility = participant.phase2 ? participant.phase2.contextual_utility_delta : participant.roster_utility_delta;
  const baseAcceptance = participant.acceptance;

  // ---- immediate_need_adjustment: current-week starter production, weighted
  // by how much this manager's archetype cares about the current week and by
  // their overall urgency (spec §18/§20/§21).
  const starterDelta = participant.starter_points_delta ?? 0;
  const immediate_need_adjustment = clampComponent(
    IMMEDIATE_NEED_WEIGHT * starterDelta * profile.horizon_weights.CURRENT_WEEK * (0.5 + 0.5 * profile.urgency.score),
  );
  if (Math.abs(immediate_need_adjustment) >= 0.05) {
    reasons.push(`${immediate_need_adjustment > 0 ? "improves" : "costs"} current-week starter production (${starterDelta >= 0 ? "+" : ""}${starterDelta.toFixed(1)} pts), weighted for a ${profile.archetype} team`);
  }

  // ---- short_horizon_adjustment: reuses Phase 2's ROS usable-value delta
  // (already a per-remaining-week equivalent) as the nearest available
  // next-few-weeks signal — spec §20/§21, honestly documented as reusing an
  // existing Phase 2 signal rather than a new next-3-week-specific model.
  const rosUsable = participant.phase2?.components.ros_usable_value ?? 0;
  const short_horizon_adjustment = clampComponent(SHORT_HORIZON_WEIGHT * rosUsable * profile.horizon_weights.NEXT_3_WEEKS);
  if (Math.abs(short_horizon_adjustment) >= 0.05) {
    reasons.push(`${short_horizon_adjustment > 0 ? "improves" : "reduces"} near-term (rest-of-season usable-value) production relevant to a ${profile.archetype} team's planning horizon`);
  }

  // ---- playoff_window_adjustment: reuses Phase 2's AUDITED playoff-window
  // resolution verbatim (spec §24 — "do not duplicate logic"). Gated by
  // playoff-qualification status (spec §27 qualification gate) and capped
  // (spec §26/§29) so a good playoff schedule alone can never dominate.
  const playoffWindow = participant.phase2?.components.playoff_window ?? null;
  let playoff_window_adjustment = 0;
  if (playoffWindow != null && PLAYOFF_SCHEDULE_ELIGIBLE_STATUSES.has(profile.playoff.status)) {
    const weight = PLAYOFF_SCHEDULE_WEIGHT_BY_STATUS[profile.playoff.status] ?? 0;
    const raw = playoffWindow * weight * profile.horizon_weights.FANTASY_PLAYOFFS;
    playoff_window_adjustment = Math.max(-PLAYOFF_SCHEDULE_ADJUSTMENT_CAP, Math.min(PLAYOFF_SCHEDULE_ADJUSTMENT_CAP, raw));
    if (Math.abs(playoff_window_adjustment) >= 0.05) {
      reasons.push(`${playoff_window_adjustment > 0 ? "improves" : "costs"} playoff-week (weeks ${profile.season.playoff_start_week ?? "?"}+) usable value for a ${profile.playoff.status} team`);
    }
  } else if (playoffWindow != null) {
    reasons.push(`playoff-window value exists but is not weighted — ${profile.playoff.status} teams are not gated into playoff-schedule preference (spec §27/§28 qualification gate)`);
  }

  // ---- depth_resilience_adjustment: Phase 2's fragility + usable-depth
  // components, weighted toward longer horizons (a front-runner/contender's
  // ROS/full-season planning) — spec §36.
  const fragility = participant.phase2?.components.roster_fragility ?? 0;
  const usableDepth = participant.phase2?.components.usable_depth ?? 0;
  const longHorizonWeight = profile.horizon_weights.REST_OF_REGULAR_SEASON + profile.horizon_weights.FULL_REMAINING_SEASON;
  const depth_resilience_adjustment = clampComponent((DEPTH_FRAGILITY_WEIGHT * fragility + DEPTH_USABLE_WEIGHT * usableDepth) * longHorizonWeight);
  if (Math.abs(depth_resilience_adjustment) >= 0.05) {
    reasons.push(`${depth_resilience_adjustment > 0 ? "reduces" : "increases"} roster fragility/depth risk, weighted for a ${profile.archetype} team's remaining-season planning`);
  }

  // ---- ceiling/floor preference: structurally zero, see config.ts's
  // documented rationale (spec §35 — no non-Phase-3 volatility evidence).
  const ceiling_preference_adjustment = 0 * CEILING_FLOOR_PREFERENCE_WEIGHT;
  const floor_preference_adjustment = 0 * CEILING_FLOOR_PREFERENCE_WEIGHT;

  // ---- bye_urgency_adjustment: Phase 2's real bye-hole (slot × week)
  // reduction, weighted toward the near-term horizons a bubble/must-win team
  // actually cares about (spec §22/§23).
  const byeCoverage = participant.phase2?.components.bye_coverage ?? 0;
  const nearHorizonWeight = profile.horizon_weights.CURRENT_WEEK + profile.horizon_weights.NEXT_3_WEEKS;
  const bye_urgency_adjustment = clampComponent(BYE_URGENCY_WEIGHT * byeCoverage * nearHorizonWeight);
  if (Math.abs(bye_urgency_adjustment) >= 0.05) {
    reasons.push(`${bye_urgency_adjustment > 0 ? "improves" : "worsens"} bye-week lineup coverage, weighted for near-term urgency`);
  }

  const components: StrategicAdjustmentComponents = {
    immediate_need_adjustment,
    short_horizon_adjustment,
    playoff_window_adjustment,
    depth_resilience_adjustment,
    ceiling_preference_adjustment,
    floor_preference_adjustment,
    bye_urgency_adjustment,
  };

  const rawSum = Object.values(components).reduce((a, b) => a + b, 0);
  const { capped: strategic_adjustment, wasCapped: strategic_adjustment_capped } = capStrategicAdjustment(rawSum, baseUtility);
  if (strategic_adjustment_capped) {
    reasons.push(`strategic adjustment was capped — standings/season context can shift preference but never overwhelm the trade's own roster-economics value`);
  }

  const strategic_trade_score = Math.round((baseUtility + strategic_adjustment) * 100) / 100;

  // ---- rationality floor (spec §32): strategic context may promote
  // acceptance by AT MOST one band, gated by a minimum net-positive
  // adjustment, and HARD_REJECT can never be promoted.
  const ceiling = promotionCeiling(baseAcceptance);
  let strategic_acceptance = baseAcceptance;
  if (strategic_adjustment >= PROMOTION_MIN_ADJUSTMENT && acceptanceRank(ceiling) > acceptanceRank(baseAcceptance)) {
    strategic_acceptance = ceiling;
    reasons.push(`strategic context promoted acceptance from ${baseAcceptance} to ${strategic_acceptance} (net adjustment +${strategic_adjustment.toFixed(2)}) — never beyond the one-band rationality-floor policy`);
  } else if (baseAcceptance === "HARD_REJECT") {
    reasons.push("base trade is HARD_REJECT — strategic context can never promote a hard rejection, regardless of season desperation");
  }

  const strategic_recommendation = recommendationFor(strategic_trade_score, strategic_acceptance, baseAcceptance);

  return {
    base_utility_delta: Math.round(baseUtility * 100) / 100,
    base_acceptance: baseAcceptance,
    components,
    strategic_adjustment: Math.round(strategic_adjustment * 100) / 100,
    strategic_adjustment_capped,
    strategic_trade_score,
    strategic_acceptance,
    strategic_recommendation,
    reasons,
  };
}

function recommendationFor(score: number, strategicAcceptance: string, baseAcceptance: string): StrategicRecommendation {
  if (baseAcceptance === "HARD_REJECT" || baseAcceptance === "REJECT") return "AVOID";
  if (strategicAcceptance === "STRONG_ACCEPT" && score > 0) return "STRONGLY_PRIORITIZE";
  if ((strategicAcceptance === "ACCEPT" || strategicAcceptance === "STRONG_ACCEPT") && score > 0) return "PRIORITIZE";
  if (strategicAcceptance === "NEUTRAL" || (score >= 0 && strategicAcceptance !== "REJECT" && strategicAcceptance !== "HARD_REJECT")) return "CONSIDER";
  return "LOW_PRIORITY";
}
