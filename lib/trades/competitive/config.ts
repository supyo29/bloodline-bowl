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
  /** Checkpoint D §36 — reservation-price sanity bounds */
  reservation_sanity: {
    /** total surplus discount cannot exceed this magnitude (z) */
    max_surplus_discount: number;
    /** for a positively-perceived bundle, reservation stays ≥ this fraction of Σ perceived */
    floor_fraction_of_perceived: number;
    /** absolute z floor — reservation never falls below this regardless of perceived value */
    absolute_floor_z: number;
  };
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
  reservation_sanity: {
    max_surplus_discount: 0.6,
    floor_fraction_of_perceived: 0.5,
    absolute_floor_z: -0.75,
  },
});

export type PartialOwnerPerceptionConfig = { [K in keyof OwnerPerceptionConfig]?: Partial<OwnerPerceptionConfig[K]> };

/* ---- Checkpoint D: opponent threat / competitive externality / result ---- */

export interface CompetitiveDConfig {
  threat: {
    /** projected-strength composite weights */
    starter_vor_weight: number;
    bench_vor_weight: number;
    /** balance penalty per position with no startable option */
    balance_penalty_per_hole: number;
    /** results-vs-projection season-maturity: results_weight = 1 − exp(−lambda·weeksPlayed) */
    results_maturity_lambda: number;
    /** cap on results_weight so a hot record never fully overrides projected strength */
    results_weight_cap: number;
    /** blended-strength z thresholds → threat band */
    band_thresholds: { elite: number; high: number; moderate: number };
    /** contender-band thresholds on league strength percentile */
    contender_thresholds: { top: number; contender: number; mid: number };
  };
  externality: {
    /** opponent starter-points delta → cost weight */
    starter_gain_weight: number;
    /** opponent depth/bench delta → cost weight */
    depth_gain_weight: number;
    /** threat band → externality multiplier */
    threat_band_multiplier: Record<"LOW" | "MODERATE" | "HIGH" | "ELITE", number>;
    /** weakness-repair → externality multiplier */
    weakness_repair_multiplier: Record<
      "CRITICAL_WEAKNESS_REPAIRED" | "HIGH_NEED_REPAIRED" | "STARTER_HOLE_FILLED" | "DEPTH_ADDED" | "SURPLUS_REINFORCED" | "NONE",
      number
    >;
    /** relative-strength multiplier: 1 + relative_strength_weight·max(0, their_z − our_z) */
    relative_strength_weight: number;
  };
  result: {
    /** minimum our-private-gain (weekly pts) for a trade to clear stage 3 */
    min_our_gain: number;
    /** our-gain below this ⇒ MARGINAL even if positive */
    marginal_our_gain: number;
    /** acceptance likelihood at/above this is "feasible" (actionable) */
    min_acceptance: "VERY_LOW" | "LOW" | "MODERATE" | "HIGH";
    /** market-edge bonus = min(cap, market_edge_bonus_weight·net_actionable_edge) */
    market_edge_bonus_weight: number;
    market_edge_bonus_cap: number;
    /** externality is capped at this fraction of |our_private_gain| so our gain always dominates (§15, §30) */
    externality_cap_fraction_of_our_gain: number;
    /** extra externality headroom (weekly pts) allowed against a HIGH/ELITE threat so a rival-strengthening deal with weak our-gain can still be rejected (§31) */
    elite_threat_extra_cap: number;
    high_threat_extra_cap: number;
    /** absolute externality cap regardless of our gain */
    externality_abs_cap: number;
    /** uncertainty penalty per confidence band below HIGH */
    uncertainty_penalty_per_band: number;
    /** competitive_result.score thresholds → classification */
    classification_thresholds: { strong_buy: number; buy: number; acceptable: number; marginal: number };
  };
}

export const DEFAULT_COMPETITIVE_D_CONFIG: CompetitiveDConfig = deepFreeze({
  threat: {
    starter_vor_weight: 0.35,
    bench_vor_weight: 0.15,
    balance_penalty_per_hole: 0.4,
    results_maturity_lambda: 0.16, // slower than season-maturity: record informs threat gradually
    results_weight_cap: 0.6, // record never more than 60% of the blend
    band_thresholds: { elite: 1.0, high: 0.35, moderate: -0.35 },
    contender_thresholds: { top: 0.85, contender: 0.6, mid: 0.35 },
  },
  externality: {
    starter_gain_weight: 1.0,
    depth_gain_weight: 0.35,
    threat_band_multiplier: { LOW: 0.35, MODERATE: 0.7, HIGH: 1.15, ELITE: 1.6 },
    weakness_repair_multiplier: {
      CRITICAL_WEAKNESS_REPAIRED: 1.7,
      HIGH_NEED_REPAIRED: 1.35,
      STARTER_HOLE_FILLED: 1.15,
      DEPTH_ADDED: 0.8,
      SURPLUS_REINFORCED: 0.55,
      NONE: 1.0,
    },
    relative_strength_weight: 0.4,
  },
  result: {
    min_our_gain: 0.25,
    marginal_our_gain: 1.0,
    min_acceptance: "LOW",
    market_edge_bonus_weight: 0.5,
    market_edge_bonus_cap: 1.5,
    externality_cap_fraction_of_our_gain: 0.7,
    elite_threat_extra_cap: 1.5,
    high_threat_extra_cap: 0.8,
    externality_abs_cap: 6.0,
    uncertainty_penalty_per_band: 0.35,
    classification_thresholds: { strong_buy: 4.0, buy: 1.75, acceptable: 0.5, marginal: -0.5 },
  },
});

export type PartialCompetitiveDConfig = {
  threat?: Partial<CompetitiveDConfig["threat"]>;
  externality?: Partial<CompetitiveDConfig["externality"]>;
  result?: Partial<CompetitiveDConfig["result"]>;
};

export function resolveCompetitiveDConfig(override?: PartialCompetitiveDConfig): CompetitiveDConfig {
  const d = DEFAULT_COMPETITIVE_D_CONFIG;
  if (!override) return d;
  return deepFreeze({
    threat: { ...d.threat, ...(override.threat ?? {}) },
    externality: { ...d.externality, ...(override.externality ?? {}) },
    result: { ...d.result, ...(override.result ?? {}) },
  });
}

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
    reservation_sanity: { ...d.reservation_sanity, ...(override.reservation_sanity ?? {}) },
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
