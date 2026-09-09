/**
 * Competitive Trade Intelligence — calibration artifact contract (Checkpoint B.5).
 *
 * The TypeScript layer NEVER runs R. It consumes a frozen, versioned artifact
 * (`lib/trades/data/competitive_market_calibration.json`) produced by
 * `analysis/competitive_market_calibration.R`. If that file is absent or its
 * status is not `CALIBRATED`, the layer falls back to DOCUMENTED default priors
 * — labelled `DEFAULT_PRIOR`, never silently.
 *
 *   R backtest  →  competitive_market_calibration.json  →  this loader  →  temporal.ts
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import type {
  CalibrationStatus,
  RecencyFamily,
  SeasonMaturityFamily,
} from "./schema";

export const COMPETITIVE_MARKET_CALIBRATION_VERSION = "ri-competitive-market-cal-2026.1" as const;

export interface CurveParams {
  family: SeasonMaturityFamily | RecencyFamily;
  /** family-specific params: EXPONENTIAL_SATURATION → {lambda}; LOGISTIC → {k, midpoint}; LINEAR_CAPPED → {slope, cap}; EXPONENTIAL_DECAY → {half_life_games} */
  params: Record<string, number>;
  /** ceiling on the produced weight (season maturity can never fully erase the prior) */
  max_weight?: number;
}

export interface PositionMetricCalibration {
  season_maturity: CurveParams;
  recency: CurveParams;
}

export interface CompetitiveMarketCalibration {
  version: string;
  status: CalibrationStatus;
  generated_at: string | null;
  training_seasons: number[];
  validation_seasons: number[];
  sample_sizes: Record<string, number>;
  /** [position][metric_family] → curves; "*" is the fallback */
  by_position_metric: Record<string, Record<string, PositionMetricCalibration>>;
  /**
   * How much market perception vs private forward value should weight each
   * evidence family. Market reacts to RESULT; private reacts to ROLE.
   */
  performance_market_weights: Record<string, number>; // family → weight for the market proxy
  private_evidence_weights: Record<string, number>; // family → weight for private forward value
  confidence_thresholds: {
    /** |edge_score| beyond this with confidence < MEDIUM ⇒ REVIEW_REQUIRED */
    review_required_edge: number;
    /** |edge_score| beyond this at any confidence ⇒ CAUTION */
    caution_edge: number;
  };
  metrics: Record<string, number>;
  notes: string[];
}

/**
 * DOCUMENTED default priors. Conservative, centralized, versioned, replaceable.
 * These are NOT calibrated values — `status: "DEFAULT_PRIOR"` says so. The
 * shapes/parameters encode the qualitative claims in the Checkpoint B.5 spec:
 *   - RB role stabilizes faster than WR efficiency (larger lambda for RB/ROLE)
 *   - one game must not erase the prior (max_weight caps well below 1)
 *   - recency: ~4-game half-life default, position-varied
 */
export const DEFAULT_COMPETITIVE_MARKET_CALIBRATION: CompetitiveMarketCalibration = deepFreeze({
  version: COMPETITIVE_MARKET_CALIBRATION_VERSION,
  status: "DEFAULT_PRIOR",
  generated_at: null,
  training_seasons: [],
  validation_seasons: [],
  sample_sizes: {},
  by_position_metric: {
    "*": {
      "*": {
        season_maturity: { family: "EXPONENTIAL_SATURATION", params: { lambda: 0.28 }, max_weight: 0.85 },
        recency: { family: "EXPONENTIAL_DECAY", params: { half_life_games: 4 } },
      },
      ROLE: {
        season_maturity: { family: "EXPONENTIAL_SATURATION", params: { lambda: 0.42 }, max_weight: 0.9 },
        recency: { family: "EXPONENTIAL_DECAY", params: { half_life_games: 5 } },
      },
      EFFICIENCY: {
        season_maturity: { family: "EXPONENTIAL_SATURATION", params: { lambda: 0.16 }, max_weight: 0.7 },
        recency: { family: "EXPONENTIAL_DECAY", params: { half_life_games: 6 } },
      },
      RESULT: {
        season_maturity: { family: "EXPONENTIAL_SATURATION", params: { lambda: 0.22 }, max_weight: 0.8 },
        recency: { family: "EXPONENTIAL_DECAY", params: { half_life_games: 3 } },
      },
    },
    RB: {
      ROLE: {
        season_maturity: { family: "EXPONENTIAL_SATURATION", params: { lambda: 0.5 }, max_weight: 0.9 },
        recency: { family: "EXPONENTIAL_DECAY", params: { half_life_games: 4 } },
      },
    },
    WR: {
      EFFICIENCY: {
        season_maturity: { family: "EXPONENTIAL_SATURATION", params: { lambda: 0.13 }, max_weight: 0.65 },
        recency: { family: "EXPONENTIAL_DECAY", params: { half_life_games: 7 } },
      },
    },
    QB: {
      "*": {
        season_maturity: { family: "EXPONENTIAL_SATURATION", params: { lambda: 0.3 }, max_weight: 0.8 },
        recency: { family: "EXPONENTIAL_DECAY", params: { half_life_games: 5 } },
      },
    },
  },
  performance_market_weights: { RESULT: 0.55, ROLE: 0.2, EFFICIENCY: 0.15, CONTEXT: 0.1 },
  private_evidence_weights: { ROLE: 0.45, EFFICIENCY: 0.25, CONTEXT: 0.2, RESULT: 0.1 },
  confidence_thresholds: { review_required_edge: 1.75, caution_edge: 1.2 },
  metrics: {},
  notes: [
    "DEFAULT_PRIOR — not fitted to historical outcomes. Parameters encode qualitative priors only.",
    "Replace by running analysis/competitive_market_calibration.R and committing its artifact.",
  ],
});

let cached: CompetitiveMarketCalibration | null | undefined;

/** Load the calibration artifact; falls back to DEFAULT_PRIOR when absent/invalid. */
export function loadCompetitiveMarketCalibration(
  fileOverride?: string,
): CompetitiveMarketCalibration {
  if (fileOverride === undefined && cached !== undefined) return cached ?? DEFAULT_COMPETITIVE_MARKET_CALIBRATION;
  const file =
    fileOverride ??
    path.join(process.cwd(), "lib", "trades", "data", "competitive_market_calibration.json");
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<CompetitiveMarketCalibration>;
    if (!raw || typeof raw !== "object" || !raw.status || !raw.by_position_metric) {
      if (fileOverride === undefined) cached = null;
      return DEFAULT_COMPETITIVE_MARKET_CALIBRATION;
    }
    const merged: CompetitiveMarketCalibration = {
      ...DEFAULT_COMPETITIVE_MARKET_CALIBRATION,
      ...raw,
      confidence_thresholds: {
        ...DEFAULT_COMPETITIVE_MARKET_CALIBRATION.confidence_thresholds,
        ...(raw.confidence_thresholds ?? {}),
      },
    } as CompetitiveMarketCalibration;
    if (fileOverride === undefined) cached = merged;
    return merged;
  } catch {
    if (fileOverride === undefined) cached = null;
    return DEFAULT_COMPETITIVE_MARKET_CALIBRATION;
  }
}

/** Resolve the curves for a position+metric-family with `*` fallbacks. */
export function resolveCurves(
  cal: CompetitiveMarketCalibration,
  position: string,
  family: string,
): PositionMetricCalibration {
  const pos = cal.by_position_metric[position] ?? cal.by_position_metric["*"] ?? {};
  return (
    pos[family] ??
    pos["*"] ??
    cal.by_position_metric["*"]?.[family] ??
    cal.by_position_metric["*"]?.["*"] ??
    DEFAULT_COMPETITIVE_MARKET_CALIBRATION.by_position_metric["*"]!["*"]!
  );
}

function deepFreeze<T>(obj: T): T {
  if (obj && typeof obj === "object" && !Object.isFrozen(obj)) {
    for (const v of Object.values(obj as Record<string, unknown>)) deepFreeze(v);
    Object.freeze(obj);
  }
  return obj;
}
