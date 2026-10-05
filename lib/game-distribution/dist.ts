/** Distribution statistics and proper scoring rules (deterministic, hand-verifiable). */
export const QUANTILE_LEVELS = [0.05, 0.1, 0.16, 0.2, 0.25, 0.5, 0.75, 0.8, 0.84, 0.9, 0.95] as const;
export type QKey = `p${number}`;
export const qKey = (p: number): string => `p${Math.round(p * 100)}`;
export const PROB_THRESHOLDS = [5, 10, 15, 20, 25] as const;
const r4 = (v: number): number => Math.round(v * 1e4) / 1e4;

/** type-7 (linear interpolation) quantile of an ASCENDING-sorted array. */
export function quantileSorted(sorted: ArrayLike<number>, p: number): number {
  const n = sorted.length; if (!n) return NaN; if (n === 1) return sorted[0]!;
  const h = (n - 1) * p, lo = Math.floor(h), hi = Math.ceil(h);
  return sorted[lo]! + (h - lo) * (sorted[hi]! - sorted[lo]!);
}
export interface DistSummary { n: number; mean: number; sd: number; quantiles: Record<string, number>; prob_ge: Record<string, number>; floor: number; ceiling: number }
export function summarize(points: ArrayLike<number>): DistSummary {
  const n = points.length; const sorted = Float64Array.from(points as ArrayLike<number>).sort();
  let sum = 0; for (let i = 0; i < n; i++) sum += sorted[i]!; const mean = sum / n;
  let ss = 0; for (let i = 0; i < n; i++) ss += (sorted[i]! - mean) ** 2;
  const q: Record<string, number> = {}; for (const p of QUANTILE_LEVELS) q[qKey(p)] = r4(quantileSorted(sorted, p));
  const pg: Record<string, number> = {}; for (const t of PROB_THRESHOLDS) { let c = 0; for (let i = 0; i < n; i++) if (sorted[i]! >= t) c++; pg[`ge${t}`] = r4(c / n); }
  return { n, mean: r4(mean), sd: r4(Math.sqrt(ss / Math.max(1, n - 1))), quantiles: q, prob_ge: pg, floor: q.p20!, ceiling: q.p80! };
}

/** Pinball (quantile) loss at level tau: proper scoring rule for a quantile forecast. */
export const pinball = (y: number, q: number, tau: number): number => (y >= q ? tau * (y - q) : (1 - tau) * (q - y));
/** Mean pinball over the standard levels — 2x this approximates CRPS on the quantile grid. */
export function meanPinball(y: number, quantiles: Record<string, number>): number {
  let s = 0; for (const p of QUANTILE_LEVELS) s += pinball(y, quantiles[qKey(p)]!, p); return s / QUANTILE_LEVELS.length;
}
/** Gneiting–Raftery interval score for a central (1-alpha) interval [l,u]: width + penalty for misses (proper). Lower is better. */
export const intervalScore = (y: number, l: number, u: number, alpha: number): number => (u - l) + (y < l ? (2 / alpha) * (l - y) : 0) + (y > u ? (2 / alpha) * (y - u) : 0);

export interface IntervalSpec { name: string; lo: number; hi: number; nominal: number }
export const INTERVALS: readonly IntervalSpec[] = [
  { name: "50% (P25-P75)", lo: 0.25, hi: 0.75, nominal: 0.5 },
  { name: "60% (P20-P80) = production floor/ceiling definition", lo: 0.2, hi: 0.8, nominal: 0.6 },
  { name: "68% (P16-P84)", lo: 0.16, hi: 0.84, nominal: 0.68 },
  { name: "80% (P10-P90)", lo: 0.1, hi: 0.9, nominal: 0.8 },
];
export interface Scored { actual: number; quantiles: Record<string, number>; /** randomized PIT of the actual under the forecast distribution (unbiased at point masses) */ pit?: number }
export interface CalibrationStats {
  /** coverage by randomized PIT: P(lo <= u <= hi); the unbiased calibration measure when the distribution has a point mass (e.g. DNP = 0 points) */
  pit_intervals: Array<{ name: string; nominal: number; observed: number | null; calibration_error: number | null }> | null;
  pit_mean: number | null;
  n: number; mean_pinball: number | null; crps_approx: number | null;
  intervals: Array<{ name: string; nominal: number; observed: number | null; calibration_error: number | null; mean_width: number | null; mean_interval_score: number | null }>;
  exceed_p90: number | null; below_p10: number | null; exceed_p95: number | null; below_p05: number | null;
}
export function calibration(rows: readonly Scored[]): CalibrationStats {
  const n = rows.length; if (!n) return { pit_intervals: null, pit_mean: null, n: 0, mean_pinball: null, crps_approx: null, intervals: INTERVALS.map((i) => ({ name: i.name, nominal: i.nominal, observed: null, calibration_error: null, mean_width: null, mean_interval_score: null })), exceed_p90: null, below_p10: null, exceed_p95: null, below_p05: null };
  const mp = rows.reduce((s, r) => s + meanPinball(r.actual, r.quantiles), 0) / n;
  const intervals = INTERVALS.map((it) => {
    let inside = 0, w = 0, isc = 0;
    for (const r of rows) { const l = r.quantiles[qKey(it.lo)]!, u = r.quantiles[qKey(it.hi)]!; if (r.actual >= l && r.actual <= u) inside++; w += u - l; isc += intervalScore(r.actual, l, u, 1 - it.nominal); }
    return { name: it.name, nominal: it.nominal, observed: r4(inside / n), calibration_error: r4(inside / n - it.nominal), mean_width: r4(w / n), mean_interval_score: r4(isc / n) };
  });
  const frac = (f: (r: Scored) => boolean) => r4(rows.filter(f).length / n);
  const hasPit = rows.every((r) => typeof r.pit === "number");
  const pit_intervals = hasPit ? INTERVALS.map((it) => { const c = rows.filter((r) => r.pit! >= it.lo && r.pit! <= it.hi).length / n; return { name: it.name, nominal: it.nominal, observed: r4(c), calibration_error: r4(c - it.nominal) }; }) : null;
  return { pit_intervals, pit_mean: hasPit ? r4(rows.reduce((s, r) => s + r.pit!, 0) / n) : null, n, mean_pinball: r4(mp), crps_approx: r4(2 * mp), intervals,
    exceed_p90: frac((r) => r.actual > r.quantiles.p90!), below_p10: frac((r) => r.actual < r.quantiles.p10!), exceed_p95: frac((r) => r.actual > r.quantiles.p95!), below_p05: frac((r) => r.actual < r.quantiles.p5!) };
}

/** Inverse standard normal CDF (Acklam) — used ONLY to express the production normal floor/ceiling heuristic as a distribution (model A). */
export function normInv(p: number): number {
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425; let q: number;
  if (p < pl) { q = Math.sqrt(-2 * Math.log(p)); return (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1); }
  if (p > 1 - pl) { q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1); }
  q = p - 0.5; const r = q * q;
  return (((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q / (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1);
}
/** Quantiles of the production heuristic: normal(median, sd = |median| * weekly CV) with the production lower clamp at 0 (lib/weekly/uncertainty.ts). */
export function normalQuantiles(median: number, sd: number): Record<string, number> {
  const q: Record<string, number> = {}; for (const p of QUANTILE_LEVELS) q[qKey(p)] = r4(median >= 0 ? Math.max(0, median + normInv(p) * sd) : median + normInv(p) * sd); return q;
}

/** Nominal levels at which the recalibration map is tabulated (piecewise-linear between knots). */
export const RECAL_KNOTS = [0, 0.01, 0.02, 0.05, 0.1, 0.16, 0.2, 0.25, 0.3, 0.4, 0.5, 0.6, 0.7, 0.75, 0.8, 0.84, 0.9, 0.95, 0.98, 0.99, 1] as const;
/** Randomized PIT of an actual under simulated draws (randomization only breaks ties at point masses, e.g. the mass at 0 points; seeded => reproducible). */
export function pit(draws: ArrayLike<number>, actual: number, u: number): number {
  let lt = 0, eq = 0; const n = draws.length; for (let i = 0; i < n; i++) { const d = draws[i]!; if (d < actual - 1e-9) lt++; else if (Math.abs(d - actual) <= 1e-9) eq++; }
  return (lt + u * eq) / n;
}
/** map[p] = empirical p-quantile of the PIT sample: the simulated level that the actual stays under with probability p. */
export function recalibrationMap(pits: readonly number[]): number[] {
  const s = [...pits].sort((a, b) => a - b); if (s.length < 30) return RECAL_KNOTS.map((k) => k);
  return RECAL_KNOTS.map((k) => (k <= 0 ? 0 : k >= 1 ? 1 : quantileSorted(s, k)));
}
export function mapLevel(map: readonly number[], p: number): number {
  for (let i = 1; i < RECAL_KNOTS.length; i++) if (p <= RECAL_KNOTS[i]!) { const a = RECAL_KNOTS[i - 1]!, b = RECAL_KNOTS[i]!; const t = b === a ? 0 : (p - a) / (b - a); return map[i - 1]! + t * (map[i]! - map[i - 1]!); }
  return 1;
}
/** Summary whose quantiles are read at the recalibrated simulated levels (mean/sd stay the raw simulated moments). */
export function summarizeRecalibrated(points: ArrayLike<number>, map: readonly number[] | null): DistSummary {
  const base = summarize(points); if (!map) return base;
  const sorted = Float64Array.from(points as ArrayLike<number>).sort();
  const q: Record<string, number> = {}; for (const p of QUANTILE_LEVELS) q[qKey(p)] = r4(quantileSorted(sorted, Math.min(1, Math.max(0, mapLevel(map, p)))));
  return { ...base, quantiles: q, floor: q.p20!, ceiling: q.p80! };
}

/** Inverse of mapLevel: the nominal level p whose recalibrated simulated level equals u (monotone search). */
export function inverseLevel(map: readonly number[], u: number): number {
  let lo = 0, hi = 1; for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if (mapLevel(map, mid) < u) lo = mid; else hi = mid; } return (lo + hi) / 2;
}
/** Randomized PIT of y under the PRODUCTION heuristic: normal(median, sd) clamped at 0 for a non-negative median (atom at 0 gets a uniform share). */
export function pitNormalClamped(y: number, median: number, sd: number, u: number): number {
  if (sd <= 0) return u;
  const cdf = (x: number) => 0.5 * (1 + erf((x - median) / (sd * Math.SQRT2)));
  if (median >= 0 && y <= 0) return u * cdf(0);
  return cdf(y);
}
function erf(x: number): number { const t = 1 / (1 + 0.3275911 * Math.abs(x)); const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return x >= 0 ? y : -y; }
