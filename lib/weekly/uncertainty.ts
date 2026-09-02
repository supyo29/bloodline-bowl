/**
 * Weekly outcome bands + decision confidence.
 *
 * When the projection source gives no distribution (Sleeper weekly projections
 * do not), floor/ceiling are derived from a documented per-position weekly
 * coefficient-of-variation. This is a HEURISTIC, flagged as such on every
 * projection (`uncertainty_source`). It is calibrated to multi-year weekly
 * fantasy-point dispersion, not to any external projection, and is only used to
 * shape floor/ceiling and confidence — never the median.
 */

/** Weekly CV of league points by position (sd / mean), single-game scale. */
export const WEEKLY_POSITION_CV: Record<string, number> = {
  QB: 0.33,
  RB: 0.44,
  WR: 0.48,
  TE: 0.52,
  K: 0.42,
  DEF: 0.58,
  DL: 0.5,
  LB: 0.42,
  DB: 0.5,
  UNKNOWN: 0.5,
};

/** z for the ~20th / ~80th percentile of a normal. */
const Z_BAND = 0.8416;

export interface Band {
  floor: number;
  ceiling: number;
  std_dev: number;
}

/**
 * Analytic floor/ceiling around a weekly median. Availability risk drags the
 * floor toward 0 (a player who does not play scores nothing).
 */
export function weeklyBand(
  median: number,
  position: string,
  expectedAvailability: number,
): Band {
  const cv = WEEKLY_POSITION_CV[position.toUpperCase()] ?? WEEKLY_POSITION_CV.UNKNOWN!;
  // Dispersion from the MAGNITUDE of the projection, so a legitimate negative
  // median (retained as real data) still gets a positive, ordered band.
  const sd = Math.abs(median) * cv;
  let floor = median - Z_BAND * sd;
  const ceiling = median + Z_BAND * sd;
  // Availability haircut on the floor only (toward 0 — a player who doesn't
  // play scores nothing).
  if (expectedAvailability < 1) {
    floor = floor * expectedAvailability;
  }
  // For a non-negative median the floor is clamped at 0; for a negative median
  // keep the true (negative) floor. Always keep floor <= median <= ceiling.
  const clampedFloor = median >= 0 ? Math.max(0, floor) : Math.min(floor, median);
  return {
    floor: Math.round(Math.min(clampedFloor, median) * 100) / 100,
    ceiling: Math.round(Math.max(ceiling, median) * 100) / 100,
    std_dev: Math.round(sd * 100) / 100,
  };
}

/**
 * Decision confidence for a head-to-head (start A over B, add A drop B, …).
 * Responds to projection separation relative to the combined uncertainty and to
 * whether real distribution data was available.
 *
 * A tiny edge is never HIGH: a 0.2-pt difference between two ~12-pt players is
 * LOW no matter how "clean" the inputs look.
 */
export function decisionConfidence(input: {
  edge: number;
  std_dev_a: number | null;
  std_dev_b: number | null;
  /** true when at least one side has no usable projection */
  incomplete: boolean;
  uncertainty_is_heuristic: boolean;
}): "HIGH" | "MEDIUM" | "LOW" {
  if (input.incomplete) return "LOW";
  const combinedSd =
    Math.sqrt((input.std_dev_a ?? 0) ** 2 + (input.std_dev_b ?? 0) ** 2) || 1;
  // Separation in standard-error units.
  const z = Math.abs(input.edge) / combinedSd;
  // Absolute-edge gate so two low-variance players with a 0.3 edge stay LOW.
  const absEdge = Math.abs(input.edge);

  if (z >= 1.0 && absEdge >= 2.5 && !input.uncertainty_is_heuristic) return "HIGH";
  if (z >= 1.1 && absEdge >= 4.5) return "HIGH"; // large, well-separated edge — heuristic SDs still support HIGH
  if (z >= 0.45 && absEdge >= 1.25) return "MEDIUM";
  return "LOW";
}

/** Simple deterministic PRNG (mulberry32) for reproducible Monte Carlo. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box–Muller normal sample from a uniform generator. */
export function sampleNormal(rng: () => number, mean: number, sd: number): number {
  const u1 = Math.max(1e-12, rng());
  const u2 = rng();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return mean + z * sd;
}
