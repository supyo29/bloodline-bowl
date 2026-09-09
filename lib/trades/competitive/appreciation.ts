/**
 * Competitive Trade Intelligence — MARKET APPRECIATION POTENTIAL
 * (Checkpoint F, §10–§16).
 *
 * Appreciation potential answers: "How likely is this player's MARKET price to
 * move TOWARD our private valuation if the current evidence continues?" It is
 * NOT a guarantee and it is NOT our private value. It is a separate, explicitly
 * speculative signal (§30 — never counted as guaranteed value downstream).
 *
 * §14 — the Checkpoint B.5 market-correction state is CONSUMED here, not
 * recomputed. CORRECTED ⇒ MARKET_ALREADY_CORRECTED; OVERSHOT ⇒ DEPRECIATION_RISK.
 *
 * §13 — a large private↔market gap at VERY_LOW confidence or REVIEW_REQUIRED
 * data quality resolves to REVIEW_REQUIRED, never HIGH.
 *
 * §55–§56 — evidence maturity gates certainty: with preseason-only / early
 * evidence, appreciation cannot be HIGH.
 */

import type { CompetitiveTradeEvaluationContext } from "./eval-context";
import { resolveCompetitiveFConfig, type CompetitiveFConfig, type PartialCompetitiveFConfig } from "./config";
import type {
  AppreciationCatalyst,
  AppreciationClassification,
  AppreciationInvalidation,
  MarketAppreciation,
  MarketCorrectionStatus,
  MarketTrajectory,
  ValueConfidence,
} from "./schema";

const CONF_RANK: Record<ValueConfidence, number> = { VERY_LOW: 0, LOW: 1, MEDIUM: 2, HIGH: 3 };

export interface BuildAppreciationInput {
  ec: CompetitiveTradeEvaluationContext;
  canonical_player_id: string;
  config?: PartialCompetitiveFConfig;
}

export function buildMarketAppreciation(input: BuildAppreciationInput): MarketAppreciation {
  const { ec, canonical_player_id: pid } = input;
  const cfg: CompetitiveFConfig = resolveCompetitiveFConfig(input.config);
  const A = cfg.appreciation;

  const player = ec.ctx.players_by_id.get(pid);
  const edge = ec.dynamic_edges.get(pid) ?? ec.market_table.edges.by_player.get(pid) ?? null;
  const name = player?.full_name ?? edge?.name ?? pid;
  const position = player?.position ?? edge?.position ?? "UNKNOWN";
  const reasons: string[] = [];

  if (!edge || edge.direction === "INSUFFICIENT_DATA") {
    return unknown(pid, name, position, "no usable market edge for this player");
  }

  const gap = edge.edge_vs_current_market ?? edge.edge_score ?? null;
  const correction: MarketCorrectionStatus = edge.market_correction ?? "UNKNOWN";
  const trajectory: MarketTrajectory = edge.market_trajectory ?? "UNKNOWN";
  const readiness = edge.temporal?.evidence_readiness ?? "UNAVAILABLE";
  const quality = edge.quality_status ?? "NORMAL";
  const rc = new Set(edge.reason_codes);

  // ---- confidence in the gap being real + directional ----
  let confRank = CONF_RANK[edge.confidence];
  if (quality === "REVIEW_REQUIRED") confRank = 0;
  else if (quality === "CAUTION") confRank = Math.max(0, confRank - 1);
  if (readiness === "PRESEASON_ONLY") confRank = Math.min(confRank, 1);
  else if (readiness === "EARLY_SEASON") confRank = Math.min(confRank, 2);
  if (rc.has("SOURCE_DISAGREEMENT_EXTREME") || rc.has("PRIVATE_MARKET_DIVERGENCE_EXTREME")) confRank = Math.max(0, confRank - 1);
  const confidence = (["VERY_LOW", "LOW", "MEDIUM", "HIGH"] as ValueConfidence[])[Math.max(0, Math.min(3, confRank))]!;

  // ---- catalysts (§15) ----
  const catalysts: AppreciationCatalyst[] = [];
  if (rc.has("USAGE_BREAKOUT_SUPPORTS_PRIVATE")) catalysts.push("ROLE_EXPANSION");
  if (rc.has("OPPONENT_ADJUSTED_OUTPERFORMANCE") || rc.has("MULTI_SOURCE_CORROBORATION")) catalysts.push("USAGE_PERSISTENCE");
  if (rc.has("SCORING_BREAKOUT_MOVES_MARKET")) catalysts.push("TOUCHDOWN_REGRESSION_UPWARD");
  if (correction === "MARKET_NOT_CORRECTED" && (gap ?? 0) > A.min_material_gap) catalysts.push("MARKET_NOT_YET_CORRECTED");
  if (rc.has("RI_SLEEPER_DISAGREEMENT_CORROBORATES")) catalysts.push("PUBLIC_PROJECTION_LAG");
  if (trajectory === "RISING" || trajectory === "RISING_FAST") catalysts.push("USAGE_PERSISTENCE");
  const uniqueCatalysts = [...new Set(catalysts)];

  // ---- invalidation conditions (§16) ----
  const invalidation: AppreciationInvalidation[] = [];
  if (catalysts.includes("ROLE_EXPANSION")) invalidation.push("ROLE_SHRINKS", "USAGE_SPIKE_PROVES_TEMPORARY");
  if (rc.has("TOUCHDOWN_MIRAGE_RISK")) invalidation.push("USAGE_SPIKE_PROVES_TEMPORARY");
  if (rc.has("WEAK_SCHEDULE_INFLATION")) invalidation.push("USAGE_SPIKE_PROVES_TEMPORARY");
  if (correction === "MARKET_PARTIALLY_CORRECTED") invalidation.push("PUBLIC_MARKET_ALREADY_REPRICES");
  if (confidence === "VERY_LOW" || confidence === "LOW") invalidation.push("MODEL_DISAGREEMENT_REMAINS_EXTREME");
  const invalidationUnique = [...new Set(invalidation)];

  // ---- classification ----
  let classification: AppreciationClassification;
  const materialGap = (gap ?? 0) >= A.min_material_gap;
  const bigGap = (gap ?? 0) >= A.high_gap;

  if (gap == null) {
    classification = "UNKNOWN";
  } else if (bigGap && (confidence === "VERY_LOW" || quality === "REVIEW_REQUIRED")) {
    // §13
    classification = "REVIEW_REQUIRED";
    reasons.push("large private↔market gap not supported by confidence / data quality → REVIEW_REQUIRED, not an appreciation call");
  } else if (correction === "MARKET_CORRECTED") {
    classification = "MARKET_ALREADY_CORRECTED"; // §14
  } else if (correction === "MARKET_OVERSHOT" || gap < -A.min_material_gap || trajectory === "FALLING_FAST") {
    classification = "DEPRECIATION_RISK"; // §14 / trajectory
  } else if (!materialGap) {
    classification = "LIMITED_APPRECIATION_POTENTIAL";
  } else if (
    bigGap &&
    uniqueCatalysts.length >= A.catalysts_for_high &&
    CONF_RANK[confidence] >= 2 &&
    readiness !== "PRESEASON_ONLY" &&
    readiness !== "EARLY_SEASON"
  ) {
    classification = "HIGH_APPRECIATION_POTENTIAL";
  } else if (uniqueCatalysts.length >= A.catalysts_for_moderate && CONF_RANK[confidence] >= 1) {
    classification = "MODERATE_APPRECIATION_POTENTIAL";
  } else {
    classification = "LIMITED_APPRECIATION_POTENTIAL";
  }

  // §55–§56 — maturity ceiling
  if (
    (classification === "HIGH_APPRECIATION_POTENTIAL" || classification === "MODERATE_APPRECIATION_POTENTIAL") &&
    (readiness === "PRESEASON_ONLY" || readiness === "EARLY_SEASON")
  ) {
    if (classification === "HIGH_APPRECIATION_POTENTIAL") classification = "MODERATE_APPRECIATION_POTENTIAL";
    else classification = "LIMITED_APPRECIATION_POTENTIAL";
    reasons.push(`evidence is ${readiness.toLowerCase().replace("_", " ")} — appreciation certainty is capped this early in the season (§55)`);
  }

  reasons.unshift(
    `${name}: private↔current-market gap ${gap == null ? "n/a" : gap.toFixed(2)} (normalized), Checkpoint B.5 correction state ${correction}, trajectory ${trajectory}, evidence ${readiness}. Appreciation ${classification} at ${confidence} confidence — SPECULATIVE, never counted as guaranteed value (§30).`,
  );

  return {
    canonical_player_id: pid,
    name,
    position,
    classification,
    private_market_gap: gap == null ? null : Math.round(gap * 10000) / 10000,
    market_correction_state: correction,
    market_trajectory: trajectory,
    evidence_readiness: readiness,
    confidence,
    catalysts: uniqueCatalysts,
    invalidation_conditions: invalidationUnique,
    is_speculative: true,
    reasons,
  };
}

function unknown(pid: string, name: string, position: string, why: string): MarketAppreciation {
  return {
    canonical_player_id: pid,
    name,
    position,
    classification: "UNKNOWN",
    private_market_gap: null,
    market_correction_state: "UNKNOWN",
    market_trajectory: "UNKNOWN",
    evidence_readiness: "UNAVAILABLE",
    confidence: "VERY_LOW",
    catalysts: [],
    invalidation_conditions: [],
    is_speculative: true,
    reasons: [why],
  };
}

export function appreciationIsTrustworthy(a: MarketAppreciation): boolean {
  return (
    (a.classification === "HIGH_APPRECIATION_POTENTIAL" || a.classification === "MODERATE_APPRECIATION_POTENTIAL") &&
    (a.confidence === "MEDIUM" || a.confidence === "HIGH")
  );
}
