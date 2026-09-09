/**
 * Competitive Trade Intelligence — PRIVATE forward value (Checkpoint B.5).
 *
 * Physically separate from `market-state.ts` (spec §41): our internal
 * forward-looking valuation must never leak into the estimated public price.
 *
 * `projected_ros_value` = blend( preseason/prior private z , current-season
 * private composite ) using the SEASON-MATURITY weight. The current-season
 * composite is ROLE-weighted (spec §14: our model reacts to opportunity, not
 * scoreboard), with efficiency / opponent-adjusted / context contributions.
 */

import { blendWithPrior } from "./temporal";
import type { CompetitiveMarketCalibration } from "./calibration";
import type { CurrentSeasonEvidence } from "./evidence";
import type {
  NormalizedValue,
  PrivateForwardValue,
  TemporalContext,
  ValueConfidence,
} from "./schema";

const CONF_LEVEL: Record<ValueConfidence, number> = { HIGH: 3, MEDIUM: 2, LOW: 1, VERY_LOW: 0 };
const LEVEL_CONF: ValueConfidence[] = ["VERY_LOW", "LOW", "MEDIUM", "HIGH"];

export interface BuildPrivateForwardInput {
  canonical_player_id: string;
  prior: NormalizedValue; // Checkpoint B private_value (RI ROS weekly VOR, z-scored)
  evidence: CurrentSeasonEvidence;
  temporal: TemporalContext;
  calibration: CompetitiveMarketCalibration;
  remaining_games_expected: number | null;
}

export function buildPrivateForwardValue(input: BuildPrivateForwardInput): PrivateForwardValue {
  const { prior, evidence, temporal } = input;
  const reasons: string[] = [];
  const w = input.calibration.private_evidence_weights;

  // ---- current-season private composite (ROLE-dominant) ----
  let composite: number | null = null;
  let compDen = 0;
  let compNum = 0;
  const add = (v: number | null, weight: number): void => {
    if (v == null || !Number.isFinite(v)) return;
    compNum += weight * v;
    compDen += weight;
  };
  // touchdown-mirage guard (§18, §29, §50): scoreboard results without a role
  // change must not move OUR forward value much — zero the RESULT term and
  // halve the opponent-adjusted term when the mirage flag is set.
  const mirage = evidence.touchdown_mirage_risk;
  add(evidence.role_signal, w.ROLE ?? 0.45);
  add(evidence.efficiency_signal != null ? clampZ(evidence.efficiency_signal / 4) : null, w.EFFICIENCY ?? 0.25);
  add(
    evidence.opponent_adjusted.residual_vs_opponent_expectation != null
      ? clampZ(evidence.opponent_adjusted.residual_vs_opponent_expectation / 8) * (mirage ? 0.5 : 1)
      : null,
    w.CONTEXT ?? 0.2,
  );
  add(mirage ? null : evidence.result_signal != null ? clampZ((evidence.result_signal - 12) / 8) : null, w.RESULT ?? 0.1);
  if (compDen > 0) composite = compNum / compDen;

  // ---- blend into the prior by season maturity ----
  const sm = temporal.season_maturity_weight;
  let blendedZ = prior.normalized_value;
  if (composite != null && prior.normalized_value != null) {
    blendedZ = blendWithPrior(prior.normalized_value, prior.normalized_value + composite, sm);
    // note: composite is a *delta* from the prior expressed in z units
  } else if (composite != null && prior.normalized_value == null) {
    blendedZ = sm * composite;
  }

  if (temporal.evidence_readiness === "PRESEASON_ONLY" || temporal.evidence_readiness === "EARLY_SEASON") {
    reasons.push(`preseason prior dominates the private forward value (season_maturity_weight ${sm.toFixed(2)})`);
  } else if (composite != null) {
    reasons.push(`current-season role/opportunity evidence shifts private forward value by ${(sm * composite).toFixed(2)} z (weight ${sm.toFixed(2)})`);
  }

  if (evidence.touchdown_mirage_risk) reasons.push("touchdown-mirage guard: high scoring with thin role did NOT strongly move private forward value");
  if (evidence.weak_schedule_inflation) reasons.push("weak schedule to date discounted in the private forward value");

  // ---- confidence ----
  let level = CONF_LEVEL[prior.confidence];
  if (temporal.evidence_readiness === "CURRENT" || temporal.evidence_readiness === "PARTIAL_CURRENT") {
    if (evidence.breakout_credibility === "SUPPORTED") level = Math.min(3, level + 1);
    if (evidence.breakout_credibility === "HIGH_CONFIDENCE") level = Math.min(3, level + 1);
  }
  if (temporal.evidence_readiness === "EARLY_SEASON") level = Math.max(0, level - 1);
  if (temporal.games_source === "WEEK_NUMBER_FALLBACK") level = Math.max(0, level - 1);
  if (temporal.calibration_status !== "CALIBRATED") level = Math.min(level, 2); // never HIGH on default priors

  const projected: NormalizedValue = {
    basis: prior.basis,
    raw: prior.raw,
    normalized_value: blendedZ == null ? null : round4(blendedZ),
    percentile: prior.percentile,
    position_rank: prior.position_rank,
    confidence: LEVEL_CONF[level]!,
    as_of: prior.as_of,
    model_version: prior.model_version,
  };

  return {
    canonical_player_id: input.canonical_player_id,
    as_of_week: temporal.as_of_week,
    remaining_games_expected: input.remaining_games_expected,
    prior_value: prior,
    current_role_signal: evidence.role_signal,
    current_efficiency_signal: evidence.efficiency_signal,
    opponent_adjusted_signal: evidence.opponent_adjusted.residual_vs_opponent_expectation,
    projected_ros_value: projected,
    breakout_credibility: evidence.breakout_credibility,
    confidence: LEVEL_CONF[level]!,
    reasons,
  };
}

function clampZ(v: number): number {
  return Math.max(-4, Math.min(4, v));
}
function round4(v: number): number {
  const r = Math.round(v * 10000) / 10000;
  return r === 0 ? 0 : r;
}
