/**
 * Trade Engine — Phase 3A: calibration statistics.
 *
 * Generic, reusable statistical machinery consumed by the calibration test
 * suite (`test/trade-engine-phase3-calibration.test.ts`) and available for a
 * future calibration report generator. Nothing here is trade-specific — it
 * operates on plain arrays of numbers (or `null` for missing) produced by
 * running `evaluateTrade` over a calibration scenario set.
 *
 * No production weight in `TradeConfig` is set from this module's output.
 * Per the Phase 3 calibration gate, a signal is only a weight CANDIDATE once
 * an ablation run over a real dataset shows incremental value; until then it
 * stays diagnostic-only (weight 0).
 */

const round4 = (v: number): number => Math.round(v * 10000) / 10000;

/* -------------------------------------------------------------------------- */
/* Distribution                                                                */
/* -------------------------------------------------------------------------- */

export interface Distribution {
  n: number;
  missing: number;
  missing_frequency: number;
  zero_count: number;
  zero_frequency: number;
  mean: number | null;
  median: number | null;
  std_dev: number | null;
  min: number | null;
  max: number | null;
  p10: number | null;
  p25: number | null;
  p75: number | null;
  p90: number | null;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 1) return sorted[0]!;
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo]!;
  const frac = idx - lo;
  return sorted[lo]! * (1 - frac) + sorted[hi]! * frac;
}

/** Describe the distribution of one signal across a calibration scenario set. `null`/`undefined` entries are missing, not zero. */
export function describeDistribution(values: Array<number | null | undefined>): Distribution {
  const n = values.length;
  const present = values.filter((v): v is number => v != null && Number.isFinite(v));
  const missing = n - present.length;
  const zero = present.filter((v) => v === 0).length;
  if (present.length === 0) {
    return {
      n, missing, missing_frequency: n > 0 ? 1 : 0, zero_count: 0, zero_frequency: 0,
      mean: null, median: null, std_dev: null, min: null, max: null, p10: null, p25: null, p75: null, p90: null,
    };
  }
  const sorted = [...present].sort((a, b) => a - b);
  const mean = present.reduce((s, v) => s + v, 0) / present.length;
  const variance = present.reduce((s, v) => s + (v - mean) ** 2, 0) / present.length;
  return {
    n,
    missing,
    missing_frequency: round4(missing / n),
    zero_count: zero,
    zero_frequency: round4(zero / present.length),
    mean: round4(mean),
    median: round4(percentile(sorted, 50)),
    std_dev: round4(Math.sqrt(variance)),
    min: round4(sorted[0]!),
    max: round4(sorted.at(-1)!),
    p10: round4(percentile(sorted, 10)),
    p25: round4(percentile(sorted, 25)),
    p75: round4(percentile(sorted, 75)),
    p90: round4(percentile(sorted, 90)),
  };
}

/* -------------------------------------------------------------------------- */
/* Correlation                                                                 */
/* -------------------------------------------------------------------------- */

/** Pairwise-complete Pearson correlation. Returns null with < 3 complete pairs (undefined / degenerate). */
export function pearson(x: Array<number | null | undefined>, y: Array<number | null | undefined>): number | null {
  const pairs: Array<[number, number]> = [];
  for (let i = 0; i < Math.min(x.length, y.length); i += 1) {
    const a = x[i];
    const b = y[i];
    if (a != null && b != null && Number.isFinite(a) && Number.isFinite(b)) pairs.push([a, b]);
  }
  if (pairs.length < 3) return null;
  const mx = pairs.reduce((s, [a]) => s + a, 0) / pairs.length;
  const my = pairs.reduce((s, [, b]) => s + b, 0) / pairs.length;
  let cov = 0, vx = 0, vy = 0;
  for (const [a, b] of pairs) {
    cov += (a - mx) * (b - my);
    vx += (a - mx) ** 2;
    vy += (b - my) ** 2;
  }
  if (vx === 0 || vy === 0) return null; // no variance -> undefined correlation, not 0
  return round4(cov / Math.sqrt(vx * vy));
}

/** Spearman rank correlation (Pearson on ranks, average-rank tie handling). */
export function spearman(x: Array<number | null | undefined>, y: Array<number | null | undefined>): number | null {
  const pairs: Array<[number, number]> = [];
  for (let i = 0; i < Math.min(x.length, y.length); i += 1) {
    const a = x[i];
    const b = y[i];
    if (a != null && b != null && Number.isFinite(a) && Number.isFinite(b)) pairs.push([a, b]);
  }
  if (pairs.length < 3) return null;
  const rank = (vals: number[]): number[] => {
    const order = vals.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]);
    const ranks = new Array(vals.length).fill(0);
    let i = 0;
    while (i < order.length) {
      let j = i;
      while (j + 1 < order.length && order[j + 1]![0] === order[i]![0]) j += 1;
      const avgRank = (i + j) / 2 + 1;
      for (let k = i; k <= j; k += 1) ranks[order[k]![1]] = avgRank;
      i = j + 1;
    }
    return ranks;
  };
  const rx = rank(pairs.map((p) => p[0]));
  const ry = rank(pairs.map((p) => p[1]));
  return pearson(rx, ry);
}

export type OverlapLevel = "HIGH" | "MODERATE" | "LOW" | "NONE";

export interface OverlapEntry {
  a: string;
  b: string;
  overlap: OverlapLevel;
  reason: string;
}

/**
 * STATIC, documented conceptual-overlap classification between Phase 1/2
 * components — an audit artifact, not derived from data. Empirical correlation
 * (see `pearson`/`spearman` over a calibration run) should be read ALONGSIDE
 * this, never as a substitute for it — correlation can be low by fixture
 * accident while conceptual overlap is genuinely high, and vice versa.
 */
export const CONCEPTUAL_OVERLAP_MATRIX: OverlapEntry[] = [
  { a: "starter_points", b: "starter_vor", overlap: "HIGH", reason: "VOR delta ≈ points delta whenever the replacement level is unchanged (the Phase 1 audit's D2 finding) — this is WHY starter_vor's composite weight is 0." },
  { a: "starter_points", b: "ros_usable_value", overlap: "HIGH", reason: "the current fantasy week is included in ros_usable_value_delta by design, so a starter-points win this week is partially re-counted in the ROS regular-season delta." },
  { a: "bench_value", b: "usable_depth", overlap: "HIGH", reason: "both are non-starter value proxies over largely the same bench population (Σ positive VOR vs. capped usable-backup counts)." },
  { a: "usable_depth", b: "roster_fragility", overlap: "MODERATE", reason: "share the same per-position inputs (viable_starters, usable_backups); constructed to move in opposite directions by design but not statistically independent." },
  { a: "replacement_cliff", b: "roster_fragility", overlap: "HIGH", reason: "fragility_score's no_cover term is directly built FROM replacement_cliff — one is a component of the other, not two independent signals." },
  { a: "replacement_context", b: "starter_vor", overlap: "MODERATE", reason: "both describe 'value over what is realistically available', at different points in the pipeline (post-trade backup vs. league replacement line)." },
  { a: "replacement_context", b: "starter_points", overlap: "MODERATE", reason: "'how much of the outgoing production is replaceable' overlaps what the Phase 1 optimizer already re-prices when it reshuffles the lineup." },
  { a: "bye_coverage", b: "ros_usable_value", overlap: "MODERATE", reason: "a solved bye hole mechanically raises the same weekly optimal totals that feed ros_usable_value_delta in that week." },
  { a: "consolidation_effect", b: "usable_depth", overlap: "LOW", reason: "consolidation is a concentration (HHI) measure over ROS weekly means; usable_depth counts slot-eligible backups above replacement — related population, different question, and consolidation is never composite-weighted." },
  { a: "interaction_residual", b: "ros_usable_value", overlap: "NONE", reason: "the residual is defined as the gap between the authoritative total and the sum of per-player attributions — it does not feed back into the total it is measured against." },
];

/* -------------------------------------------------------------------------- */
/* Ablation                                                                    */
/* -------------------------------------------------------------------------- */

export interface AblationScenario<T> {
  name: string;
  expected_direction: "POSITIVE" | "NEGATIVE" | "NEUTRAL";
  input: T;
}

export interface AblationOutcome {
  scenario: string;
  full_value: number;
  ablated_value: number;
  full_direction_correct: boolean;
  ablated_direction_correct: boolean;
}

export interface AblationResult {
  signal: string;
  outcomes: AblationOutcome[];
  full_directional_accuracy: number;
  ablated_directional_accuracy: number;
  /** full_directional_accuracy - ablated_directional_accuracy; positive = the signal is pulling its weight */
  incremental_directional_value: number;
  /** Spearman correlation between the full-model and ablated-model rankings across scenarios */
  ranking_stability: number | null;
}

function directionMatches(value: number, expected: AblationScenario<unknown>["expected_direction"], neutralBand = 0.5): boolean {
  if (expected === "POSITIVE") return value > neutralBand;
  if (expected === "NEGATIVE") return value < -neutralBand;
  return Math.abs(value) <= neutralBand;
}

/**
 * Run one signal's ablation: evaluate `fullValueFn` (composite WITH the
 * signal) and `ablatedValueFn` (composite WITHOUT it) over every scenario,
 * and compare directional accuracy + ranking stability.
 *
 * A signal earns "incremental value" only if `incremental_directional_value`
 * is materially positive (the full model is MORE often directionally correct
 * than the ablated one) — matching the Phase 3 calibration gate. A signal that
 * shows zero or negative incremental value must stay at weight 0.
 */
export function runAblation<T>(
  signal: string,
  scenarios: Array<AblationScenario<T>>,
  fullValueFn: (input: T) => number,
  ablatedValueFn: (input: T) => number,
): AblationResult {
  const outcomes: AblationOutcome[] = scenarios.map((s) => {
    const full = fullValueFn(s.input);
    const ablated = ablatedValueFn(s.input);
    return {
      scenario: s.name,
      full_value: full,
      ablated_value: ablated,
      full_direction_correct: directionMatches(full, s.expected_direction),
      ablated_direction_correct: directionMatches(ablated, s.expected_direction),
    };
  });
  const acc = (key: "full_direction_correct" | "ablated_direction_correct") =>
    outcomes.length > 0 ? outcomes.filter((o) => o[key]).length / outcomes.length : 0;
  const fullAcc = acc("full_direction_correct");
  const ablatedAcc = acc("ablated_direction_correct");
  return {
    signal,
    outcomes,
    full_directional_accuracy: round4(fullAcc),
    ablated_directional_accuracy: round4(ablatedAcc),
    incremental_directional_value: round4(fullAcc - ablatedAcc),
    ranking_stability: spearman(outcomes.map((o) => o.full_value), outcomes.map((o) => o.ablated_value)),
  };
}
