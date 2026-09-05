/**
 * Trade Engine — Phase 4 search configuration and the durable calibration
 * deferral marker.
 */

/**
 * Audit fix (§6, §54): before this pass, a mode intended to improve the
 * requester (BEST_AVAILABLE, POSITIONAL_NEED, CONSOLIDATE, BUY_PLAYER,
 * SELL_PLAYER, FAIR_TRADES, EASY_TO_ACCEPT) had NO default requester-utility
 * floor — a candidate with negative `my_gain` and an accepting partner could
 * be returned as a "recommendation." `2026.2` adds `requesterUtilityFloor`,
 * a real, enforced default (strictly positive, `> 0`) for every mode; a
 * caller may still relax it via `constraints.minimum_my_utility_delta`
 * (explicit override, never a silent default weakening).
 */
export const TRADE_DISCOVERY_VERSION = "ri-trade-discovery-2026.2" as const;

/**
 * Default minimum requester utility for a mode, before any explicit
 * `constraints.minimum_my_utility_delta` override. `BLOCKBUSTER` still
 * requires a genuine improvement — size alone never substitutes for a
 * positive canonical delta. `buildDiscoveryResult`'s floor check is
 * inclusive (`myUtility < floor` is rejected, `myUtility === floor` survives)
 * to keep a single, simple comparison for both the default and any explicit
 * caller-supplied floor — so the default floor itself is a small epsilon
 * ABOVE zero (half the 2-decimal rounding precision every utility value
 * already carries), not exactly zero, so an exact break-even (0.00) trade is
 * correctly excluded as "not an improvement."
 *
 * Takes no `mode` argument today — every mode shares the same floor — but is
 * kept as a named function (not an inlined constant) so a future per-mode
 * floor can be added at this one call site without touching every caller.
 */
export function requesterUtilityFloor(): number {
  return 0.005;
}

/**
 * Trade-level calibration reopen floor. This is a REOPEN GATE, not automatic
 * permission to activate weights — crossing it means "Phase 3.6 may
 * responsibly re-examine calibration," never "weights auto-activate."
 * Compare against `loadRealHistoricalTradeRecords().total_records`
 * (`lib/trades/historical-loader.ts`).
 */
export const TRADE_CALIBRATION_MIN_REAL_TRADES = 50;

export interface TradeSearchLimits {
  max_partner_count: number;
  max_assets_per_pool: number;
  max_generated_packages: number;
  max_evaluated_candidates: number;
  max_three_team_cycles: number;
  max_results_default: number;
}

export const DEFAULT_SEARCH_LIMITS: TradeSearchLimits = {
  max_partner_count: 6,
  max_assets_per_pool: 4,
  max_generated_packages: 60,
  max_evaluated_candidates: 40,
  max_three_team_cycles: 24,
  max_results_default: 10,
};

/** Per-mode acceptance-floor policy for the OTHER participant(s) — see docs/TRADE_ENGINE_PHASE4.md §Ranking. */
export function partnerAcceptanceFloor(mode: string): "STRONG_ACCEPT" | "ACCEPT" | "NEUTRAL" | "RELUCTANT" {
  switch (mode) {
    case "EASY_TO_ACCEPT":
      return "ACCEPT";
    case "FAIR_TRADES":
      return "NEUTRAL";
    case "BLOCKBUSTER":
      return "RELUCTANT"; // premium packages tolerate a more reluctant partner in exchange for size
    default:
      return "NEUTRAL"; // BEST_AVAILABLE and most other modes: partner must be at least NEUTRAL
  }
}

const ACCEPTANCE_RANK: Record<string, number> = {
  HARD_REJECT: 0,
  REJECT: 1,
  RELUCTANT: 2,
  NEUTRAL: 3,
  ACCEPT: 4,
  STRONG_ACCEPT: 5,
};
export function acceptanceAtLeast(actual: string, floor: string): boolean {
  return (ACCEPTANCE_RANK[actual] ?? -1) >= (ACCEPTANCE_RANK[floor] ?? 99);
}
