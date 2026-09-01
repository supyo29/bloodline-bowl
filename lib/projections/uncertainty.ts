/**
 * Uncertainty + confidence for Layer-1 projections.
 *
 * Two distinct axes, kept separate:
 *   - OUTCOME BAND (floor/median/ceiling, P20/P50/P80): how wide is the range of
 *     plausible seasons? Driven by role volatility, TD variance, availability
 *     variance. A boom/bust WR3 has a wide band but can still be LOW confidence.
 *   - CONFIDENCE (HIGH/MEDIUM/LOW/VERY_LOW): how much do we trust the median?
 *     Driven by sample size, role certainty, rookie/team-change/injury flags,
 *     and (added later, in compare.ts) external-source disagreement.
 *
 * Percentiles are analytic by default (fast, deterministic). An optional bounded
 * Monte Carlo (`monteCarloBand`) resamples the big levers with the obvious
 * correlations respected — it is NOT run in the default build path.
 */

import type { PlayerProjection, ProjectionConfidence } from "./schema";

const P_FLOOR = 20;
const P_CEIL = 80;

/** z-scores for P20 / P80 of a normal. */
const Z80 = 0.8416;

/**
 * Coefficient of variation of season points by position, decomposed into a
 * volume part (fairly stable) and a scoring/TD part (volatile). These are
 * league-neutral (PPR) and calibrated to multi-year season-point dispersion,
 * not to any external projection.
 */
const POSITION_CV: Record<string, { base: number; rookie: number; thin_role: number }> = {
  QB: { base: 0.18, rookie: 0.30, thin_role: 0.10 },
  RB: { base: 0.26, rookie: 0.34, thin_role: 0.14 },
  WR: { base: 0.28, rookie: 0.36, thin_role: 0.16 },
  TE: { base: 0.30, rookie: 0.38, thin_role: 0.16 },
  K: { base: 0.16, rookie: 0.18, thin_role: 0.04 },
  DEF: { base: 0.24, rookie: 0.24, thin_role: 0.04 },
};

interface BandInput {
  position: string;
  median: number;
  is_rookie: boolean;
  snap_share: number | null;
  td_points: number | null;
  expected_games: number;
  games_if_healthy: number;
}

/**
 * Analytic outcome band. Widened by rookie status, thin/uncertain role, high TD
 * dependence, and games-missed risk. Floor is additionally dragged toward 0 by
 * availability risk (a hurt player scores nothing those weeks).
 */
export function analyticBand(input: BandInput): {
  floor: number;
  median: number;
  ceiling: number;
  sd: number;
  percentiles: { floor: number; ceiling: number };
} {
  const cv = POSITION_CV[input.position] ?? POSITION_CV.WR!;
  let rel = cv.base;

  if (input.is_rookie) rel = cv.rookie;

  // Uncertain role (mid snap share) widens; locked-in starter narrows.
  const snap = input.snap_share ?? 0.5;
  if (snap > 0 && snap < 0.55) rel += cv.thin_role * (0.55 - snap) * 2;
  if (snap >= 0.8) rel -= cv.thin_role * 0.5;

  // TD-dependence: fraction of points from TDs above a normal share widens.
  const tdFrac = input.median > 0 ? (input.td_points ?? 0) / input.median : 0;
  if (tdFrac > 0.28) rel += (tdFrac - 0.28) * 0.5;

  rel = Math.max(0.08, Math.min(0.55, rel));
  const sd = rel * input.median;

  // Availability: extra downside only (missed games), scaled by games at risk.
  const gamesRisk = Math.max(0, input.games_if_healthy - input.expected_games);
  const availDrag = input.median * (gamesRisk / input.games_if_healthy) * 0.6;

  const ceiling = input.median + Z80 * sd;
  const floor = Math.max(0, input.median - Z80 * sd - availDrag);

  return {
    floor: r1(floor),
    median: r1(input.median),
    ceiling: r1(ceiling),
    sd: r1(sd),
    percentiles: { floor: P_FLOOR, ceiling: P_CEIL },
  };
}

/* --------------------------------------------------------------- confidence */

interface ConfidenceInput {
  position: string;
  sample_seasons: number;
  effective_sample: number; // games-weighted
  is_rookie: boolean;
  team_changed: boolean;
  injury_flagged: boolean;
  snap_share: number | null;
  role_locked: boolean; // depth_chart_order === 1 or demonstrated heavy usage
  /** filled by compare.ts once the Sleeper benchmark is attached; 0..1, 0 = agree */
  source_disagreement?: number;
}

export function confidenceBucket(input: ConfidenceInput): {
  bucket: ProjectionConfidence;
  score: number;
  reasons: string[];
} {
  const reasons: string[] = [];
  let score = 0.5;

  // Sample size (the dominant term).
  if (input.effective_sample >= 30) {
    score += 0.22;
    reasons.push("3+ effective seasons of history");
  } else if (input.effective_sample >= 15) {
    score += 0.1;
    reasons.push("~1.5 effective seasons of history");
  } else if (input.effective_sample >= 6) {
    score -= 0.05;
    reasons.push("thin history (<1 full season effective)");
  } else {
    score -= 0.22;
    reasons.push("little or no NFL history");
  }

  if (input.is_rookie) {
    score -= 0.2;
    reasons.push("rookie — projected from prior, not NFL production");
  }
  if (input.team_changed) {
    score -= 0.08;
    reasons.push("changed teams — role/environment uncertain");
  }
  if (input.injury_flagged) {
    score -= 0.1;
    reasons.push("carrying an injury designation");
  }

  const snap = input.snap_share ?? 0;
  if (input.role_locked || snap >= 0.8) {
    score += 0.12;
    reasons.push("locked-in every-down role");
  } else if (snap > 0 && snap < 0.5) {
    score -= 0.1;
    reasons.push("committee / rotational role");
  }

  if (input.source_disagreement != null) {
    if (input.source_disagreement >= 0.35) {
      score -= 0.12;
      reasons.push("large disagreement with external benchmark");
    } else if (input.source_disagreement <= 0.1) {
      score += 0.05;
      reasons.push("agrees with external benchmark");
    }
  }

  score = Math.max(0.02, Math.min(0.98, score));

  const bucket: ProjectionConfidence =
    score >= 0.72 ? "HIGH" : score >= 0.5 ? "MEDIUM" : score >= 0.3 ? "LOW" : "VERY_LOW";

  return { bucket, score: r2(score), reasons };
}

/* ------------------------------------------------------- optional Monte Carlo */

/**
 * Bounded Monte Carlo for a single player, respecting the obvious correlations.
 * NOT part of the default build (the analytic band is). Exposed for the audit
 * script and for spot-checking that the analytic band is not wildly off.
 *
 * Correlations honoured:
 *   - availability gates every counting stat in the same draw
 *   - a single "efficiency environment" latent nudges yards & TDs together
 *   - TD count is Poisson-ish around its expectation (its own extra variance)
 */
export function monteCarloBand(
  proj: PlayerProjection,
  draws = 2000,
  seed = 12345,
): { floor: number; median: number; ceiling: number; sd: number } {
  const rand = mulberry32(seed);
  const s = proj.stats;
  const gih = proj.availability.games_if_healthy || 17;
  const availP = proj.availability.availability_probability;

  const baseYards =
    (s.pass_yd ?? 0) * 0.04 + (s.rush_yd ?? 0) * 0.1 + (s.rec_yd ?? 0) * 0.1;
  const baseRec = (s.rec ?? 0) * 1;
  const tdExp =
    (s.pass_td ?? 0) * 4 + (s.rush_td ?? 0) * 6 + (s.rec_td ?? 0) * 6;
  const negPts = (s.pass_int ?? 0) * -1 + (s.fum_lost ?? 0) * -2;

  const samples: number[] = [];
  for (let i = 0; i < draws; i++) {
    // games available this sim
    let games = 0;
    for (let g = 0; g < gih; g++) if (rand() < availP) games++;
    const gFrac = games / gih;

    // efficiency environment latent (mean 1, sd ~0.12), shared by yards+TD
    const env = 1 + gaussian(rand) * 0.12;
    // per-game noise on volume
    const volNoise = 1 + gaussian(rand) * (0.06 / Math.sqrt(Math.max(1, games)));

    const yards = baseYards * gFrac * env * volNoise;
    const rec = baseRec * gFrac * volNoise;
    // TD: scale expectation, then Poisson draw around it
    const tdLambdaPts = tdExp * gFrac * env;
    const tdPts = poissonScaledPoints(tdLambdaPts, rand);
    const neg = negPts * gFrac * volNoise;

    samples.push(yards + rec + tdPts + neg);
  }
  samples.sort((a, b) => a - b);
  const q = (p: number) => samples[Math.min(samples.length - 1, Math.floor(p * samples.length))]!;
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  const sd = Math.sqrt(samples.reduce((a, b) => a + (b - mean) ** 2, 0) / samples.length);
  return { floor: r1(q(0.2)), median: r1(q(0.5)), ceiling: r1(q(0.8)), sd: r1(sd) };
}

/* ---------------------------------------------------------------- utilities */

function mulberry32(a: number): () => number {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gaussian(rand: () => number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rand();
  while (v === 0) v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
/** Points from a Poisson-distributed TD count whose expected *points* are lambdaPts. */
function poissonScaledPoints(lambdaPts: number, rand: () => number): number {
  if (lambdaPts <= 0) return 0;
  // assume ~6 pts/TD average to recover a count lambda, draw, rescale
  const perTd = 6;
  const lambda = lambdaPts / perTd;
  let k = 0;
  let p = 1;
  const L = Math.exp(-lambda);
  do {
    k++;
    p *= rand();
  } while (p > L);
  return (k - 1) * perTd;
}
function r1(v: number): number { return Math.round(v * 10) / 10; }
function r2(v: number): number { return Math.round(v * 100) / 100; }
