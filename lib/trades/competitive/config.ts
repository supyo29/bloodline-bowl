/**
 * Competitive Trade Intelligence — configuration (Checkpoint B).
 *
 * Every threshold lives here, never inline. All bands are on the
 * `edge_score` scale (a within-position z-score difference, scarcity-weighted)
 * — i.e. "how many position-standard-deviations apart are our valuation and
 * the market's".
 */

import type { DraftAnchorState, MarketReadiness, OwnerContextReadiness, StarterImportance, ValueConfidence } from "./schema";

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

/* ======================================================================== */
/* Checkpoint C — owner perception / reservation / acceptance config          */
/* ======================================================================== */

export interface OwnerPerceptionConfig {
  /** owner-perceived-value component caps (z units) — no component dominates */
  perceived_component_caps: {
    draft_anchor: number;
    starter_importance: number;
    recent_salience: number;
    name_salience: number;
  };
  /** per-anchor-state base weight, decayed by meaningful games */
  draft_anchor_base_weight: Record<DraftAnchorState, number>;
  /** personal-anchor decay per meaningful game — DELIBERATELY < the season-maturity
   * lambda (a manager stays attached longer than the market re-prices). HEURISTIC. */
  draft_anchor_decay_lambda: number;
  /** draft_reach_delta (z) thresholds → anchor state */
  anchor_state_thresholds: { strong: number; moderate: number; weak: number };
  /** z gain applied per unit of positive draft reach */
  draft_reach_gain: number;
  /** starter-importance → reservation adjustment (z) */
  starter_importance_reservation: Record<StarterImportance, number>;
  /** z per "missing startable option" at the position after losing the player */
  positional_scarcity_cost_per_gap: number;
  /** z discount per surplus startable option beyond need+1 (≤ 0 applied) */
  surplus_discount_per_extra: number;
  /** replacement-cost: weekly-points lineup loss → z (divide by this) */
  replacement_points_to_z: number;
  /** bundle: extra reservation as a fraction of the combined lineup loss beyond the summed individual losses */
  bundle_nonadditivity_gain: number;
  /** acceptance bands on internal_score */
  acceptance_bands: { high: number; moderate: number; low: number };
  /** acceptance component weights */
  acceptance_weights: {
    perceived_surplus: number;
    need_relief: number;
    roster_slot_pressure: number;
    structure_fit: number;
    market_trajectory: number;
  };
  /** z penalty per forced drop of a startable-quality player */
  slot_pressure_per_forced_drop: number;
  /** readiness → owner-perception confidence ceiling */
  readiness_confidence_ceiling: Record<OwnerContextReadiness, ValueConfidence>;
}

export const DEFAULT_OWNER_PERCEPTION_CONFIG: OwnerPerceptionConfig = deepFreeze({
  perceived_component_caps: { draft_anchor: 0.55, starter_importance: 0.5, recent_salience: 0.4, name_salience: 0.25 },
  draft_anchor_base_weight: {
    STRONG_ANCHOR: 0.9,
    MODERATE_ANCHOR: 0.6,
    WEAK_ANCHOR: 0.3,
    MINIMAL_ANCHOR: 0.1,
    UNKNOWN: 0,
  },
  draft_anchor_decay_lambda: 0.09, // slower than the season-maturity lambdas (0.08–0.5)
  anchor_state_thresholds: { strong: 0.9, moderate: 0.35, weak: -0.35 },
  draft_reach_gain: 0.35,
  starter_importance_reservation: {
    LOCKED_STARTER: 0.9,
    REGULAR_STARTER: 0.5,
    FLEX_STARTER: 0.25,
    ROTATIONAL: 0.05,
    BENCH_DEPTH: -0.15,
    IR: -0.35,
    UNKNOWN: 0,
  },
  positional_scarcity_cost_per_gap: 0.5,
  surplus_discount_per_extra: -0.28,
  replacement_points_to_z: 6,
  bundle_nonadditivity_gain: 0.4,
  acceptance_bands: { high: 0.5, moderate: 0.0, low: -0.6 },
  acceptance_weights: {
    perceived_surplus: 1.0,
    need_relief: 0.7,
    roster_slot_pressure: 1.0,
    structure_fit: 0.4,
    market_trajectory: 0.2,
  },
  slot_pressure_per_forced_drop: -0.5,
  readiness_confidence_ceiling: {
    FULL_OWNER_CONTEXT: "MEDIUM", // never HIGH — heuristic acceptance, thin trade history
    PARTIAL_OWNER_CONTEXT: "LOW",
    GLOBAL_MARKET_ONLY: "LOW",
    STALE: "LOW",
    UNAVAILABLE: "VERY_LOW",
  },
});

export type PartialOwnerPerceptionConfig = { [K in keyof OwnerPerceptionConfig]?: Partial<OwnerPerceptionConfig[K]> };

export function resolveOwnerPerceptionConfig(override?: PartialOwnerPerceptionConfig): OwnerPerceptionConfig {
  const d = DEFAULT_OWNER_PERCEPTION_CONFIG;
  if (!override) return d;
  return deepFreeze({
    perceived_component_caps: { ...d.perceived_component_caps, ...(override.perceived_component_caps ?? {}) },
    draft_anchor_base_weight: { ...d.draft_anchor_base_weight, ...(override.draft_anchor_base_weight ?? {}) },
    draft_anchor_decay_lambda: (override.draft_anchor_decay_lambda as number) ?? d.draft_anchor_decay_lambda,
    anchor_state_thresholds: { ...d.anchor_state_thresholds, ...(override.anchor_state_thresholds ?? {}) },
    draft_reach_gain: (override.draft_reach_gain as number) ?? d.draft_reach_gain,
    starter_importance_reservation: { ...d.starter_importance_reservation, ...(override.starter_importance_reservation ?? {}) },
    positional_scarcity_cost_per_gap: (override.positional_scarcity_cost_per_gap as number) ?? d.positional_scarcity_cost_per_gap,
    surplus_discount_per_extra: (override.surplus_discount_per_extra as number) ?? d.surplus_discount_per_extra,
    replacement_points_to_z: (override.replacement_points_to_z as number) ?? d.replacement_points_to_z,
    bundle_nonadditivity_gain: (override.bundle_nonadditivity_gain as number) ?? d.bundle_nonadditivity_gain,
    acceptance_bands: { ...d.acceptance_bands, ...(override.acceptance_bands ?? {}) },
    acceptance_weights: { ...d.acceptance_weights, ...(override.acceptance_weights ?? {}) },
    slot_pressure_per_forced_drop: (override.slot_pressure_per_forced_drop as number) ?? d.slot_pressure_per_forced_drop,
    readiness_confidence_ceiling: { ...d.readiness_confidence_ceiling, ...(override.readiness_confidence_ceiling ?? {}) },
  });
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
