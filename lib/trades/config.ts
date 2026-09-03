/**
 * Trade Engine configuration — every threshold lives HERE, never buried in
 * engine logic. Callers may pass a partial override; `resolveTradeConfig` fills
 * the gaps with these documented defaults.
 *
 * Scale: all thresholds are in **weekly projected fantasy points** (the same
 * unit as `roster_utility_delta`). A `+1.0` roster_utility_delta means the
 * transaction is worth roughly one extra projected point per week to that
 * manager's optimal lineup + usable depth, blended by the component weights
 * below.
 */

import type { AcceptanceClass } from "./schema";

export interface TradeConfig {
  /**
   * Composite `roster_utility_delta` weights. Each component is in weekly points;
   * the composite is their weighted sum.
   *
   *   - `starter_points` — the recomputed optimal-lineup delta. This is the
   *     honest "how many more points will the starting lineup score" number and
   *     is the composite's primary term (weight 1.0).
   *   - `starter_vor` — the starter value-over-replacement delta. It is a
   *     *scarcity lens* on the same lineup change starter_points already
   *     measures, so its DEFAULT weight is 0 (exposed as a component, not summed)
   *     to avoid double-counting the starter improvement. Raise it to fold
   *     positional scarcity into the scalar.
   *   - `bench_value` — Σ positive weekly VOR of non-starters (coarse depth
   *     proxy; small weight).
   *   - `positional_need` — bounded severity-pressure delta over the six base
   *     positions (see evaluate.ts). Nudges rather than dominates.
   */
  weights: {
    starter_points: number;
    starter_vor: number;
    bench_value: number;
    positional_need: number;
  };

  /**
   * Acceptance-class cut points on `roster_utility_delta`, in weekly points.
   * The bands are contiguous and every class is reachable:
   *
   *   delta >= strong_accept    -> STRONG_ACCEPT
   *   delta >= accept           -> ACCEPT
   *   delta >= neutral_floor    -> NEUTRAL       [neutral_floor, accept)
   *   delta >= reluctant_floor  -> RELUCTANT     [reluctant_floor, neutral_floor)
   *   delta >  hard_reject      -> REJECT        (hard_reject, reluctant_floor)
   *   else                      -> HARD_REJECT   delta <= hard_reject
   *
   * Must satisfy strong_accept > accept > neutral_floor > reluctant_floor >
   * hard_reject. For Phase 1 this expresses "does this objectively improve or
   * damage the manager's current modeled roster?", not human psychology.
   */
  thresholds: {
    strong_accept: number;
    accept: number;
    neutral_floor: number;
    reluctant_floor: number;
    hard_reject: number;
  };

  /**
   * Minimum `roster_utility_delta` for a participant to be considered to have
   * received "enough" value for the deal to be rational for them. Exposed on
   * every participant result as `above_acceptance_floor`; later phases let the
   * trade finder search for deals where every manager clears it.
   */
  acceptance_floor: number;

  /** Trade-level viability bands — see `classifyViability` in evaluate.ts. */
  viability: {
    /** every participant's delta must be >= this for HIGH */
    high_min_participant_delta: number;
    /** every participant's delta must be >= this for MODERATE */
    moderate_min_participant_delta: number;
  };
}

export const DEFAULT_TRADE_CONFIG: TradeConfig = {
  weights: {
    starter_points: 1.0,
    starter_vor: 0.0,
    bench_value: 0.25,
    positional_need: 1.0,
  },
  thresholds: {
    strong_accept: 3.0,
    accept: 1.0,
    neutral_floor: -1.0,
    reluctant_floor: -2.0,
    hard_reject: -4.0,
  },
  acceptance_floor: -0.5,
  viability: {
    high_min_participant_delta: 0.5,
    moderate_min_participant_delta: -0.5,
  },
};

export type PartialTradeConfig = {
  weights?: Partial<TradeConfig["weights"]>;
  thresholds?: Partial<TradeConfig["thresholds"]>;
  acceptance_floor?: number;
  viability?: Partial<TradeConfig["viability"]>;
};

export function resolveTradeConfig(override?: PartialTradeConfig): TradeConfig {
  const d = DEFAULT_TRADE_CONFIG;
  const cfg: TradeConfig = {
    weights: { ...d.weights, ...(override?.weights ?? {}) },
    thresholds: { ...d.thresholds, ...(override?.thresholds ?? {}) },
    acceptance_floor: override?.acceptance_floor ?? d.acceptance_floor,
    viability: { ...d.viability, ...(override?.viability ?? {}) },
  };
  assertThresholdOrder(cfg.thresholds);
  return cfg;
}

function assertThresholdOrder(t: TradeConfig["thresholds"]): void {
  const ordered =
    t.strong_accept > t.accept &&
    t.accept > t.neutral_floor &&
    t.neutral_floor > t.reluctant_floor &&
    t.reluctant_floor > t.hard_reject;
  if (!ordered) {
    throw new Error(
      `TradeConfig thresholds must be strictly descending ` +
        `(strong_accept > accept > neutral_floor > reluctant_floor > hard_reject); got ${JSON.stringify(t)}`,
    );
  }
}

/** Map a `roster_utility_delta` (weekly points) to an acceptance class. */
export function classifyAcceptance(delta: number, cfg: TradeConfig): AcceptanceClass {
  const t = cfg.thresholds;
  if (delta >= t.strong_accept) return "STRONG_ACCEPT";
  if (delta >= t.accept) return "ACCEPT";
  if (delta >= t.neutral_floor) return "NEUTRAL";
  if (delta >= t.reluctant_floor) return "RELUCTANT";
  if (delta > t.hard_reject) return "REJECT";
  return "HARD_REJECT";
}
