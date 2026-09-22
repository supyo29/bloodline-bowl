/**
 * Phase 9 Steps 22-35 — calibration math. Pure, deterministic, unit-tested against hand-computed fixtures
 * (Step 62). Rounds to 4 dp to absorb IEEE-754 noise, matching the convention used throughout `lib/scoring`.
 */
const r4 = (v: number): number => Math.round(v * 10_000) / 10_000;

export interface ErrorStats { n: number; mae: number; rmse: number; signed_bias: number }
/** `signed_bias` = mean(actual - predicted): positive means the model under-projects on average. */
export function errorStats(pairs: ReadonlyArray<{ predicted: number; actual: number }>): ErrorStats | null {
  if (!pairs.length) return null;
  let sumAbs = 0, sumSq = 0, sumSigned = 0;
  for (const { predicted, actual } of pairs) { const e = actual - predicted; sumAbs += Math.abs(e); sumSq += e * e; sumSigned += e; }
  return { n: pairs.length, mae: r4(sumAbs / pairs.length), rmse: r4(Math.sqrt(sumSq / pairs.length)), signed_bias: r4(sumSigned / pairs.length) };
}

/** Buckets `xs` by `edge()` into named ranges (Step 32 decision-difficulty / Step 30 windows use the same primitive). */
export function bucketBy<T>(xs: readonly T[], edge: (x: T) => number, boundaries: ReadonlyArray<{ label: string; max: number }>): Record<string, T[]> {
  const out: Record<string, T[]> = Object.fromEntries(boundaries.map((b) => [b.label, []]));
  for (const x of xs) { const e = Math.abs(edge(x)); const b = boundaries.find((bb) => e < bb.max) ?? boundaries[boundaries.length - 1]!; out[b.label]!.push(x); }
  return out;
}
export const STARTSIT_DIFFICULTY_BUCKETS = [{ label: "very_close", max: 1 }, { label: "close", max: 2 }, { label: "moderate", max: 5 }, { label: "obvious", max: Infinity }] as const;

/**
 * Rolling window mean over dated points, sorted ascending by `at`; `windowSize` = number of most-recent points
 * (not calendar days). Deterministic given the same input list (Step 30 — stable, documented windows, never
 * chosen after seeing results).
 */
export function rollingMean(points: ReadonlyArray<{ at: string; value: number }>, windowSize: number): number | null {
  const sorted = [...points].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  const tail = sorted.slice(-windowSize);
  if (!tail.length) return null;
  return r4(tail.reduce((s, p) => s + p.value, 0) / tail.length);
}

export interface DriftAssessment { drifting: boolean; current: number; reference: number; delta: number; threshold: number; note: string }
/**
 * Step 35 — process-control style drift: flags only when `current` moves beyond `reference ± thresholdSD * sd`
 * (a z-like band on the historical distribution), never on a single-week point estimate alone. `sd` must come
 * from the caller's own rolling history (never invented); `sd <= 0` (fewer than 2 historical points) means
 * "not enough history to assess drift" — reported as `drifting: false`, never guessed.
 */
export function assessDrift(current: number, referenceMean: number, referenceSd: number, thresholdSd = 2): DriftAssessment {
  if (referenceSd <= 0) return { drifting: false, current: r4(current), reference: r4(referenceMean), delta: r4(current - referenceMean), threshold: thresholdSd, note: "insufficient history to establish a reference SD" };
  const delta = current - referenceMean;
  const drifting = Math.abs(delta) > thresholdSd * referenceSd;
  return { drifting, current: r4(current), reference: r4(referenceMean), delta: r4(delta), threshold: thresholdSd, note: drifting ? `|Δ| ${r4(Math.abs(delta))} exceeds ${thresholdSd}×SD (${r4(thresholdSd * referenceSd)})` : "within normal historical variation" };
}

/** Step 33 — confidence-bin reliability: mean |error| per confidence label. A useful confidence system shows LOW >= MEDIUM >= HIGH mean error. */
export function calibrationByConfidence<T>(rows: readonly T[], confidenceOf: (x: T) => string | null, absErrorOf: (x: T) => number | null): Record<string, { n: number; mean_abs_error: number | null }> {
  const by = new Map<string, number[]>();
  for (const x of rows) { const c = confidenceOf(x) ?? "UNKNOWN"; const e = absErrorOf(x); if (e == null) continue; (by.get(c) ?? by.set(c, []).get(c)!).push(e); }
  return Object.fromEntries([...by.entries()].map(([c, es]) => [c, { n: es.length, mean_abs_error: es.length ? r4(es.reduce((a, b) => a + b, 0) / es.length) : null }]));
}
