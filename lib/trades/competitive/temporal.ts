/**
 * Competitive Trade Intelligence — season maturity + within-season recency
 * (Checkpoint B.5). Pure; deterministic from calibrated (or default-prior)
 * parameters. No I/O.
 *
 * TWO SEPARATE mechanisms (spec §11):
 *   season maturity — how much 2026 evidence replaces the preseason prior, as a
 *                     NONLINEAR function of MEANINGFUL GAMES OBSERVED (not week #).
 *   recency         — among 2026 observations, how much recent games outweigh
 *                     older ones. A different function, different parameters.
 */

import type {
  CurveParams,
  PositionMetricCalibration,
  CompetitiveMarketCalibration,
} from "./calibration";
import { resolveCurves } from "./calibration";
import type {
  EvidenceReadiness,
  RecencyFamily,
  SeasonMaturityFamily,
  TemporalContext,
} from "./schema";

/* ----------------------------------------------------- season maturity w(g) */

/**
 * `w(g)` ∈ [0, max_weight] — weight on current-season evidence given `g`
 * meaningful games observed. Monotonic non-decreasing in `g`, nonlinear,
 * capped below 1 so the preseason prior is never fully erased.
 */
export function seasonMaturityWeight(gamesObserved: number, curve: CurveParams): number {
  const g = Math.max(0, gamesObserved);
  const cap = clamp01(curve.max_weight ?? 0.9);
  let w: number;
  switch (curve.family as SeasonMaturityFamily) {
    case "LOGISTIC": {
      const k = curve.params.k ?? 0.6;
      const mid = curve.params.midpoint ?? 4;
      w = 1 / (1 + Math.exp(-k * (g - mid)));
      // renormalize so g=0 → ~0
      const w0 = 1 / (1 + Math.exp(-k * (0 - mid)));
      w = (w - w0) / (1 - w0);
      break;
    }
    case "LINEAR_CAPPED": {
      const slope = curve.params.slope ?? 0.12;
      w = slope * g;
      break;
    }
    case "EXPONENTIAL_SATURATION":
    default: {
      const lambda = curve.params.lambda ?? 0.28;
      w = 1 - Math.exp(-lambda * g);
      break;
    }
  }
  if (!Number.isFinite(w)) return 0;
  return clamp(w, 0, 1) * cap;
}

/* ------------------------------------------------ within-season recency r(a) */

/** `r(age_games)` ∈ (0, 1] — weight for an observation `age` games old. */
export function recencyWeight(ageGames: number, curve: CurveParams): number {
  const a = Math.max(0, ageGames);
  switch (curve.family as RecencyFamily) {
    case "LINEAR_DECAY": {
      const span = curve.params.span_games ?? 8;
      return clamp(1 - a / span, 0.05, 1);
    }
    case "UNIFORM":
      return 1;
    case "EXPONENTIAL_DECAY":
    default: {
      const hl = curve.params.half_life_games ?? 4;
      return Math.pow(0.5, a / Math.max(0.5, hl));
    }
  }
}

/**
 * Recency-weighted mean of a game series (most recent last). Returns null on an
 * empty series. `valueOf` extracts the metric from each game.
 */
export function recencyWeightedMean<T>(
  series: T[],
  valueOf: (g: T) => number | null,
  curve: CurveParams,
): number | null {
  if (series.length === 0) return null;
  let num = 0;
  let den = 0;
  for (let i = 0; i < series.length; i += 1) {
    const v = valueOf(series[i]!);
    if (v == null || !Number.isFinite(v)) continue;
    const age = series.length - 1 - i;
    const w = recencyWeight(age, curve);
    num += w * v;
    den += w;
  }
  return den > 0 ? num / den : null;
}

/* --------------------------------------------------------- temporal context */

export interface BuildTemporalContextInput {
  as_of_week: number;
  season: number;
  /** meaningful games the player was actually in a real role (preferred over week #) */
  meaningful_games_observed: number | null;
  games_source: TemporalContext["games_source"];
  position: string;
  /** which evidence family the caller is weighting (drives which curve) */
  metric_family: string;
  calibration: CompetitiveMarketCalibration;
  /** total remaining games in the fantasy horizon (for readiness reasons) */
  remaining_games?: number | null;
}

const EARLY_SEASON_GAMES = 3;
const PARTIAL_CURRENT_GAMES = 6;

export function buildTemporalContext(input: BuildTemporalContextInput): TemporalContext {
  const curves: PositionMetricCalibration = resolveCurves(input.calibration, input.position, input.metric_family);
  const reasons: string[] = [];

  let games = input.meaningful_games_observed;
  if (games == null) {
    // fall back to week number, but flag it and discount
    games = Math.max(0, input.as_of_week - 1);
    reasons.push("meaningful-games count unavailable — fell back to (week − 1); confidence reduced");
  }

  const smWeight = seasonMaturityWeight(games, curves.season_maturity);

  let readiness: EvidenceReadiness;
  if (games <= 0) {
    readiness = "PRESEASON_ONLY";
    reasons.push("no meaningful games observed — preseason prior fully governs");
  } else if (games < EARLY_SEASON_GAMES) {
    readiness = "EARLY_SEASON";
    reasons.push(`only ${games} meaningful game(s) — current-season evidence is thin (season_maturity_weight ${smWeight.toFixed(2)})`);
  } else if (games < PARTIAL_CURRENT_GAMES) {
    readiness = "PARTIAL_CURRENT";
    reasons.push(`${games} meaningful games — current-season evidence maturing (season_maturity_weight ${smWeight.toFixed(2)})`);
  } else {
    readiness = "CURRENT";
  }

  const halfLife = curves.recency.params.half_life_games ?? 4;

  return {
    as_of_week: input.as_of_week,
    season: input.season,
    meaningful_games_observed: games,
    games_source: input.games_source,
    season_maturity_weight: round4(smWeight),
    season_maturity_family: curves.season_maturity.family as SeasonMaturityFamily,
    recency_half_life_games: halfLife,
    recency_family: curves.recency.family as RecencyFamily,
    evidence_readiness: readiness,
    calibration_status: input.calibration.status,
    reasons,
  };
}

/**
 * Blend a current-season signal into a prior using the season-maturity weight.
 * `w·current + (1−w)·prior`. Returns the prior unchanged when `current` is null.
 */
export function blendWithPrior(prior: number | null, current: number | null, weight: number): number | null {
  if (prior == null && current == null) return null;
  if (current == null) return prior;
  if (prior == null) return current;
  const w = clamp01(weight);
  return w * current + (1 - w) * prior;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
function clamp01(v: number): number {
  return clamp(v, 0, 1);
}
function round4(v: number): number {
  const r = Math.round(v * 10000) / 10000;
  return r === 0 ? 0 : r;
}
