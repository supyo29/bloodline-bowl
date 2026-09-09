/**
 * Competitive Trade Intelligence — dynamic market edge + anomaly safeguards
 * (Checkpoint B.5).
 *
 * Layers time-awareness onto a Checkpoint-B `MarketEdge`:
 *   - compares PRIVATE FORWARD VALUE against the CURRENT MARKET PROXY
 *     (not just RI-ROS vs Sleeper-ROS), while retaining B's Sleeper-ROS source;
 *   - exposes `edge_vs_preseason_market` AND `edge_vs_current_market` (§43);
 *   - classifies market correction (§44);
 *   - fails closed on temporal-horizon mismatch (§4);
 *   - anomaly safeguards: an extreme edge unsupported by confidence becomes
 *     `quality_status: REVIEW_REQUIRED`, not an automatic STRONG_BUY (§31–§33).
 */

import type { CompetitiveTradeConfig } from "./config";
import type { CompetitiveMarketCalibration } from "./calibration";
import type {
  MarketCorrectionStatus,
  MarketEdge,
  MarketEdgeDirection,
  MarketEdgeReasonCode,
  MarketState,
  PrivateForwardValue,
  QualityStatus,
  TemporalContext,
  ValueConfidence,
} from "./schema";

const CONF_LEVEL: Record<ValueConfidence, number> = { HIGH: 3, MEDIUM: 2, LOW: 1, VERY_LOW: 0 };
const LEVEL_CONF: ValueConfidence[] = ["VERY_LOW", "LOW", "MEDIUM", "HIGH"];

export interface ApplyDynamicMarketInput {
  base_edge: MarketEdge;
  private_forward: PrivateForwardValue;
  market_state: MarketState;
  temporal: TemporalContext;
  config: CompetitiveTradeConfig;
  calibration: CompetitiveMarketCalibration;
  /** how the private prior's time horizon is defined (fail-closed check) */
  private_horizon: "ROS_WEEKLY_RATE" | "FULL_SEASON" | "UNKNOWN";
  market_horizon: "ROS_WEEKLY_RATE" | "FULL_SEASON" | "UNKNOWN";
  /** as-of weeks for the two sides (staleness check) */
  private_as_of_week: number;
  market_as_of_week: number;
  /** flags surfaced from the current-season evidence */
  evidence_flags?: { weak_schedule_inflation?: boolean; touchdown_mirage_risk?: boolean };
}

export function applyDynamicMarketToEdge(input: ApplyDynamicMarketInput): MarketEdge {
  const { base_edge, private_forward, market_state, temporal, config, calibration } = input;
  const codes = new Set<MarketEdgeReasonCode>(base_edge.reason_codes);
  const reasons = [...base_edge.reasons];

  const scarcity = config.position_scarcity_weight[base_edge.position] ?? config.default_scarcity_weight;
  const pfZ = private_forward.projected_ros_value.normalized_value;
  const proxyZ = market_state.current_market_proxy.normalized_value;
  const preseasonZ = market_state.preseason_market_prior.normalized_value;

  // ---- temporal-comparability fail-closed (§4) ----
  const horizonMismatch =
    input.private_horizon !== input.market_horizon &&
    !(input.private_horizon === "UNKNOWN" || input.market_horizon === "UNKNOWN");
  const staleGap = Math.abs(input.private_as_of_week - input.market_as_of_week);
  if (horizonMismatch) {
    codes.add("PRIVATE_MARKET_HORIZON_MISMATCH");
    codes.add("TEMPORAL_BASIS_MISMATCH");
    reasons.unshift(
      `Private horizon (${input.private_horizon}) and market horizon (${input.market_horizon}) are not comparable — edge withheld.`,
    );
    return {
      ...base_edge,
      direction: "INSUFFICIENT_DATA",
      edge_score: null,
      actionable_edge: null,
      confidence: "VERY_LOW",
      quality_status: "REVIEW_REQUIRED",
      edge_vs_preseason_market: null,
      edge_vs_current_market: null,
      market_correction: "UNKNOWN",
      market_trajectory: market_state.market_trajectory,
      temporal,
      reason_codes: [...codes],
      reasons,
    };
  }
  if (staleGap >= 3) {
    codes.add("STALE_MARKET_HORIZON");
    reasons.push(`market data is ${staleGap} weeks behind the private valuation as-of week — confidence reduced`);
  }

  // ---- the two edges (§43) ----
  const edgeVsPreseason =
    pfZ != null && preseasonZ != null ? round4((pfZ - preseasonZ) * scarcity) : base_edge.edge_score;
  const edgeVsCurrent =
    pfZ != null && proxyZ != null ? round4((pfZ - proxyZ) * scarcity) : base_edge.edge_score;

  // B.5 primary comparison is vs the CURRENT market proxy
  const primary = edgeVsCurrent;
  if (primary == null) {
    return {
      ...base_edge,
      quality_status: "CAUTION",
      edge_vs_preseason_market: edgeVsPreseason ?? null,
      edge_vs_current_market: null,
      market_correction: "UNKNOWN",
      market_trajectory: market_state.market_trajectory,
      temporal,
      reason_codes: [...codes.add("ROS_NORMALIZATION_UNAVAILABLE")],
      reasons,
    };
  }

  // ---- confidence: worst of private-forward and market-state, adjusted ----
  let level = Math.min(CONF_LEVEL[private_forward.confidence], CONF_LEVEL[market_state.confidence]);

  // multi-source corroboration (§33): role evidence + opponent-adjusted + RI/Sleeper disagreement all agree
  const corroborators: string[] = [];
  const buySide = primary > 0;
  if ((buySide && (private_forward.current_role_signal ?? 0) > 0.3) || (!buySide && (private_forward.current_role_signal ?? 0) < -0.3)) {
    corroborators.push("current role signal");
  }
  const oaResid = private_forward.opponent_adjusted_signal;
  if (oaResid != null && ((buySide && oaResid > 2) || (!buySide && oaResid < -2))) corroborators.push("opponent-adjusted performance");
  if (base_edge.reason_codes.includes("RI_SLEEPER_DISAGREEMENT_CORROBORATES")) corroborators.push("RI↔Sleeper disagreement");
  if (corroborators.length >= 2) {
    level = Math.min(3, level + 1);
    codes.add("MULTI_SOURCE_CORROBORATION");
    reasons.push(`independent evidence agrees on direction: ${corroborators.join(", ")}`);
  }

  // usage vs scoring breakout (§28–§30)
  if (base_edge.position !== "QB") {
    if (private_forward.breakout_credibility === "SUPPORTED" || private_forward.breakout_credibility === "HIGH_CONFIDENCE") {
      codes.add("USAGE_BREAKOUT_SUPPORTS_PRIVATE");
    }
  }
  if (market_state.market_trajectory === "RISING_FAST" && (private_forward.current_role_signal ?? 0) < 0.3) {
    codes.add("SCORING_BREAKOUT_MOVES_MARKET");
    reasons.push("market is rising fast on scoreboard results not matched by an opportunity change — sell-high setup");
  }
  if (base_edge.reason_codes.includes("OPPONENT_ADJUSTED_OUTPERFORMANCE") || (oaResid != null && oaResid > 3)) codes.add("OPPONENT_ADJUSTED_OUTPERFORMANCE");

  // readiness reasons
  if (temporal.evidence_readiness === "PRESEASON_ONLY") codes.add("PRESEASON_PRIOR_DOMINATES");
  if (temporal.evidence_readiness === "EARLY_SEASON") codes.add("CURRENT_SEASON_EVIDENCE_THIN");
  if (temporal.evidence_readiness === "PARTIAL_CURRENT") codes.add("CURRENT_SEASON_EVIDENCE_MATURING");

  // evidence flags
  if (input.evidence_flags?.weak_schedule_inflation) {
    codes.add("WEAK_SCHEDULE_INFLATION");
    reasons.push("realized production is inflated by an easy schedule to date");
  }
  if (input.evidence_flags?.touchdown_mirage_risk) {
    codes.add("TOUCHDOWN_MIRAGE_RISK");
    reasons.push("high scoring on thin opportunity — touchdown-driven, not role-driven");
  }

  // never HIGH conviction on default priors (§59) or a week-# fallback
  if (calibration.status !== "CALIBRATED") level = Math.min(level, 2);
  if (temporal.games_source === "WEEK_NUMBER_FALLBACK") level = Math.min(level, 2);

  const confidence = LEVEL_CONF[Math.max(0, Math.min(3, level))]!;

  // ---- anomaly safeguards (§31–§33) ----
  const mag = Math.abs(primary);
  let quality: QualityStatus = "NORMAL";
  if (mag >= calibration.confidence_thresholds.review_required_edge && CONF_LEVEL[confidence] < CONF_LEVEL.MEDIUM) {
    quality = "REVIEW_REQUIRED";
    codes.add("PRIVATE_MARKET_DIVERGENCE_EXTREME");
    codes.add("REVIEW_REQUIRED_UNSUPPORTED_CONVICTION");
    reasons.unshift(
      `Edge magnitude ${mag.toFixed(2)} is extreme but confidence is only ${confidence} — flagged for review, not promoted to high conviction (possible source/model anomaly).`,
    );
    if (temporal.evidence_readiness === "PRESEASON_ONLY" || temporal.evidence_readiness === "EARLY_SEASON") {
      codes.add("INSUFFICIENT_CURRENT_EVIDENCE");
    }
  } else if (mag >= calibration.confidence_thresholds.caution_edge && CONF_LEVEL[confidence] < CONF_LEVEL.MEDIUM) {
    quality = "CAUTION";
  }
  if (base_edge.lineage.dispersion >= config.market_dispersion_downgrade_at * 1.5) {
    codes.add("SOURCE_DISAGREEMENT_EXTREME");
    quality = quality === "NORMAL" ? "CAUTION" : quality;
  }

  // ---- direction from the CURRENT-market edge, with confidence + quality caps ----
  let direction: MarketEdgeDirection;
  if (mag < config.edge_bands.fair_band) {
    direction = "FAIR";
  } else {
    const strong = mag >= config.edge_bands.strong_band;
    const directional = mag >= config.edge_bands.directional_band;
    const cap = config.max_direction_by_confidence[confidence];
    if (strong && cap === "STRONG" && quality !== "REVIEW_REQUIRED") direction = buySide ? "STRONG_BUY" : "STRONG_SELL";
    else if (directional || strong) direction = buySide ? "BUY" : "SELL";
    else direction = "FAIR";
    if (quality === "REVIEW_REQUIRED" && (direction === "STRONG_BUY" || direction === "STRONG_SELL")) {
      direction = buySide ? "BUY" : "SELL";
    }
  }

  // ---- market correction (§44) ----
  const correction = classifyCorrection(edgeVsPreseason ?? null, edgeVsCurrent ?? null);
  applyCorrectionCode(correction, codes);
  if (correction === "MARKET_CORRECTED") {
    reasons.push("the market has moved to our earlier private view — the original edge is largely gone");
  } else if (correction === "MARKET_OVERSHOT") {
    reasons.push("the market has moved PAST our private forward value — direction flips vs the preseason edge");
  }
  if (market_state.market_trajectory === "RISING_FAST" || market_state.market_trajectory === "RISING") codes.add("MARKET_TRAJECTORY_RISING");
  if (market_state.market_trajectory === "FALLING_FAST" || market_state.market_trajectory === "FALLING") codes.add("MARKET_TRAJECTORY_FALLING");

  const actionable = round4(primary * config.confidence_actionability[confidence]);

  return {
    ...base_edge,
    market_value: base_edge.market_value, // retain Checkpoint B Sleeper-ROS source/lineage
    direction,
    edge_score: primary,
    actionable_edge: actionable,
    confidence,
    quality_status: quality,
    edge_vs_preseason_market: edgeVsPreseason ?? null,
    edge_vs_current_market: edgeVsCurrent ?? null,
    market_correction: correction,
    market_trajectory: market_state.market_trajectory,
    temporal,
    reason_codes: [...codes],
    reasons,
  };
}

function classifyCorrection(preseasonEdge: number | null, currentEdge: number | null): MarketCorrectionStatus {
  if (preseasonEdge == null || currentEdge == null) return "UNKNOWN";
  if (Math.abs(preseasonEdge) < 0.35) return "UNKNOWN"; // no meaningful preseason edge to correct
  // sign flip ⇒ overshoot
  if (Math.sign(preseasonEdge) !== 0 && Math.sign(currentEdge) !== 0 && Math.sign(preseasonEdge) !== Math.sign(currentEdge)) {
    return "MARKET_OVERSHOT";
  }
  const shrink = 1 - Math.abs(currentEdge) / Math.abs(preseasonEdge);
  if (shrink >= 0.66) return "MARKET_CORRECTED";
  if (shrink >= 0.25) return "MARKET_PARTIALLY_CORRECTED";
  return "MARKET_NOT_CORRECTED";
}

function applyCorrectionCode(c: MarketCorrectionStatus, codes: Set<MarketEdgeReasonCode>): void {
  if (c === "MARKET_CORRECTED") codes.add("MARKET_CORRECTED");
  if (c === "MARKET_PARTIALLY_CORRECTED") codes.add("MARKET_PARTIALLY_CORRECTED");
  if (c === "MARKET_NOT_CORRECTED") codes.add("MARKET_NOT_CORRECTED");
  if (c === "MARKET_OVERSHOT") codes.add("MARKET_OVERSHOT");
}

function round4(v: number): number {
  const r = Math.round(v * 10000) / 10000;
  return r === 0 ? 0 : r;
}
