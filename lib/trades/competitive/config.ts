/**
 * Competitive Trade Intelligence — configuration (Checkpoint B).
 *
 * Every threshold lives here, never inline. All bands are on the
 * `edge_score` scale (a within-position z-score difference, scarcity-weighted)
 * — i.e. "how many position-standard-deviations apart are our valuation and
 * the market's".
 */

import type { MarketReadiness, ValueConfidence } from "./schema";

export interface CompetitiveTradeConfig {
  edge_bands: {
    /** |edge_score| below this ⇒ FAIR. */
    fair_band: number;
    /** |edge_score| at/above this ⇒ BUY / SELL. */
    directional_band: number;
    /** |edge_score| at/above this AND confidence ≥ MEDIUM ⇒ STRONG_BUY / STRONG_SELL. */
    strong_band: number;
  };
  /**
   * Actionability multiplier applied to `edge_score` to produce
   * `actionable_edge` (the ranking key). Enforces the monotonic rule: a
   * HIGH-confidence discrepancy is at least as actionable as an identical
   * VERY_LOW one.
   */
  confidence_actionability: Record<ValueConfidence, number>;
  /**
   * Direction ceiling by confidence — VERY_LOW can never reach STRONG_*, and is
   * labelled speculative.
   */
  max_direction_by_confidence: Record<ValueConfidence, "STRONG" | "DIRECTIONAL" | "FAIR_ONLY">;
  /** Readiness → market-value confidence ceiling. */
  readiness_confidence_ceiling: Record<MarketReadiness, ValueConfidence>;
  /**
   * Cross-source implied-rank dispersion (MAD, in positional ranks) at/above
   * which market confidence is knocked down one band.
   */
  market_dispersion_downgrade_at: number;
  /**
   * Minimum fraction of a position group's players that must have BOTH private
   * and market values for the normalization of that group to be trusted at
   * full confidence.
   */
  min_position_coverage: number;
  /** Age (days) past which a dated market source becomes STALE. */
  stale_after_days: number;
  /**
   * Positional scarcity weights. VOR already encodes replacement scarcity, so
   * these are gentle multipliers (a mispriced RB/TE matters a little more than
   * a mispriced QB in a 1-QB league because the startable pool is thinner).
   */
  position_scarcity_weight: Record<string, number>;
  default_scarcity_weight: number;
  /** RI↔Sleeper stat-level disagreement (fraction) that corroborates an edge. */
  corroborating_disagreement_pct: number;
}

export const DEFAULT_COMPETITIVE_TRADE_CONFIG: CompetitiveTradeConfig = deepFreeze({
  edge_bands: {
    fair_band: 0.35,
    directional_band: 0.6,
    strong_band: 1.2,
  },
  confidence_actionability: {
    HIGH: 1.0,
    MEDIUM: 0.68,
    LOW: 0.4,
    VERY_LOW: 0.2,
  },
  max_direction_by_confidence: {
    HIGH: "STRONG",
    MEDIUM: "STRONG",
    LOW: "DIRECTIONAL",
    VERY_LOW: "DIRECTIONAL", // reachable as BUY/SELL, never STRONG_*; labelled speculative
  },
  readiness_confidence_ceiling: {
    CURRENT: "HIGH",
    PARTIAL: "MEDIUM",
    STALE: "LOW",
    UNAVAILABLE: "VERY_LOW",
  },
  market_dispersion_downgrade_at: 12,
  min_position_coverage: 0.5,
  stale_after_days: 21,
  position_scarcity_weight: {
    QB: 0.9,
    RB: 1.12,
    WR: 1.0,
    TE: 1.15,
    K: 0.7,
    DEF: 0.7,
  },
  default_scarcity_weight: 1.0,
  corroborating_disagreement_pct: 0.15,
});

export type PartialCompetitiveTradeConfig = {
  edge_bands?: Partial<CompetitiveTradeConfig["edge_bands"]>;
  confidence_actionability?: Partial<CompetitiveTradeConfig["confidence_actionability"]>;
  max_direction_by_confidence?: Partial<CompetitiveTradeConfig["max_direction_by_confidence"]>;
  readiness_confidence_ceiling?: Partial<CompetitiveTradeConfig["readiness_confidence_ceiling"]>;
  market_dispersion_downgrade_at?: number;
  min_position_coverage?: number;
  stale_after_days?: number;
  position_scarcity_weight?: Record<string, number>;
  default_scarcity_weight?: number;
  corroborating_disagreement_pct?: number;
};

export function resolveCompetitiveTradeConfig(
  override?: PartialCompetitiveTradeConfig,
): CompetitiveTradeConfig {
  const d = DEFAULT_COMPETITIVE_TRADE_CONFIG;
  const cfg: CompetitiveTradeConfig = {
    edge_bands: { ...d.edge_bands, ...(override?.edge_bands ?? {}) },
    confidence_actionability: { ...d.confidence_actionability, ...(override?.confidence_actionability ?? {}) },
    max_direction_by_confidence: { ...d.max_direction_by_confidence, ...(override?.max_direction_by_confidence ?? {}) },
    readiness_confidence_ceiling: { ...d.readiness_confidence_ceiling, ...(override?.readiness_confidence_ceiling ?? {}) },
    market_dispersion_downgrade_at: override?.market_dispersion_downgrade_at ?? d.market_dispersion_downgrade_at,
    min_position_coverage: override?.min_position_coverage ?? d.min_position_coverage,
    stale_after_days: override?.stale_after_days ?? d.stale_after_days,
    position_scarcity_weight: { ...d.position_scarcity_weight, ...(override?.position_scarcity_weight ?? {}) },
    default_scarcity_weight: override?.default_scarcity_weight ?? d.default_scarcity_weight,
    corroborating_disagreement_pct: override?.corroborating_disagreement_pct ?? d.corroborating_disagreement_pct,
  };
  assertBandOrder(cfg);
  return cfg;
}

function assertBandOrder(cfg: CompetitiveTradeConfig): void {
  const b = cfg.edge_bands;
  if (!(b.strong_band > b.directional_band && b.directional_band > b.fair_band && b.fair_band > 0)) {
    throw new Error(
      `CompetitiveTradeConfig edge_bands must be strong_band > directional_band > fair_band > 0; got ${JSON.stringify(b)}`,
    );
  }
}

function deepFreeze<T>(obj: T): T {
  if (obj && typeof obj === "object" && !Object.isFrozen(obj)) {
    for (const v of Object.values(obj as Record<string, unknown>)) deepFreeze(v);
    Object.freeze(obj);
  }
  return obj;
}
