/** Phase 3 report: calibration, sharpness, proper scores and tail behaviour for models A/B/C/D, by position / tier / fingerprint, plus error-class attribution. Pure. */
import { createHash } from "node:crypto";
import { calibration, type CalibrationStats, type Scored } from "./dist";
import { DECOMP6_KEYS } from "./decompose";
import type { DistributionRow, ModelId } from "./analysis";

const r4 = (v: number): number => Math.round(v * 1e4) / 1e4;
export const MODELS: readonly ModelId[] = ["A", "B", "C", "D"];
export const MODEL_LABELS: Record<ModelId, string> = { A: "Production baseline (normal median/sd = production floor/ceiling heuristic)", B: "Baseline mean + Phase-3 distribution shape", C: "Environment-derived mean + recalibrated Phase-3 distribution", D: "Phase-2 role mean shift + Phase-3 shape (research only)" };

/** One row per (season, week, player, scoring fingerprint); Sleeper only — the same football outcome under the same scoring is never counted twice. */
export function dedupeDist(rows: readonly DistributionRow[], opts: { includeYahoo?: boolean } = {}): DistributionRow[] {
  const seen = new Map<string, DistributionRow>();
  for (const r of [...rows].sort((a, b) => (a.league_slug < b.league_slug ? -1 : 1))) { if (!opts.includeYahoo && r.provider !== "sleeper") continue; const k = `${r.season}|${r.week}|${r.gsis_id ?? r.canonical_player_id}|${r.scoring_fingerprint}`; if (!seen.has(k)) seen.set(k, r); }
  return [...seen.values()];
}
export interface ModelStats { n: number; mean_accuracy: { mae: number | null; rmse: number | null; bias: number | null }; calibration: CalibrationStats; mean_interval_score_60: number | null; mean_interval_score_80: number | null }
export function modelStats(rows: readonly DistributionRow[], m: ModelId): ModelStats {
  const n = rows.length; const errs = rows.map((r) => r.actual_fantasy_points - r.models[m].mean);
  const sc: Scored[] = rows.map((r) => ({ actual: r.actual_fantasy_points, quantiles: r.models[m].quantiles, pit: r.models[m].scores.pit }));
  const avg = (f: (r: DistributionRow) => number) => (n ? r4(rows.reduce((s, r) => s + f(r), 0) / n) : null);
  return { n, mean_accuracy: { mae: n ? r4(errs.reduce((s, e) => s + Math.abs(e), 0) / n) : null, rmse: n ? r4(Math.sqrt(errs.reduce((s, e) => s + e * e, 0) / n)) : null, bias: n ? r4(errs.reduce((s, e) => s + e, 0) / n) : null }, calibration: calibration(sc), mean_interval_score_60: avg((r) => r.models[m].scores.interval_score_60), mean_interval_score_80: avg((r) => r.models[m].scores.interval_score_80) };
}
const all = (rows: readonly DistributionRow[]) => Object.fromEntries(MODELS.map((m) => [m, modelStats(rows, m)])) as Record<ModelId, ModelStats>;

export interface TailRow { threshold: number; n: number; inside_p10_p90: Record<ModelId, number | null>; inside_p5_p95: Record<ModelId, number | null>; mean_pit: Record<ModelId, number | null>; mean_miss_inside_distribution_C: number | null }
export function tailReport(rows: readonly DistributionRow[], threshold: number): TailRow {
  const big = rows.filter((r) => Math.abs(r.projection_error) >= threshold); const n = big.length;
  const frac = (m: ModelId, f: (r: DistributionRow) => boolean) => (n ? r4(big.filter((r) => f(r)).length / n) : null);
  return { threshold, n, inside_p10_p90: Object.fromEntries(MODELS.map((m) => [m, frac(m, (r) => r.models[m].scores.inside_p10_p90)])) as TailRow["inside_p10_p90"], inside_p5_p95: Object.fromEntries(MODELS.map((m) => [m, frac(m, (r) => r.models[m].scores.inside_p5_p95)])) as TailRow["inside_p5_p95"], mean_pit: Object.fromEntries(MODELS.map((m) => [m, n ? r4(big.reduce((s, r) => s + r.models[m].scores.pit, 0) / n) : null])) as TailRow["mean_pit"], mean_miss_inside_distribution_C: frac("C", (r) => r.models.C.scores.inside_p10_p90) };
}
export interface Attribution { n: number; mean_abs: Record<string, number | null>; share_sq_error: Record<string, number | null>; mean_signed: Record<string, number | null> }
export function attribution(rows: readonly DistributionRow[]): Attribution {
  const d = rows.filter((r) => r.decomposition6).map((r) => r.decomposition6!); const n = d.length;
  const keys = ["total_error", ...DECOMP6_KEYS] as const;
  const sumSq = DECOMP6_KEYS.reduce((s, k) => s + d.reduce((a, x) => a + x[k] ** 2, 0), 0);
  return { n, mean_abs: Object.fromEntries(keys.map((k) => [k, n ? r4(d.reduce((s, x) => s + Math.abs(x[k]), 0) / n) : null])), mean_signed: Object.fromEntries(keys.map((k) => [k, n ? r4(d.reduce((s, x) => s + x[k], 0) / n) : null])), share_sq_error: Object.fromEntries(DECOMP6_KEYS.map((k) => [k, sumSq ? r4(d.reduce((a, x) => a + x[k] ** 2, 0) / sumSq) : null])) };
}
const seg = (rows: readonly DistributionRow[], key: (r: DistributionRow) => string) => { const g = new Map<string, DistributionRow[]>(); for (const r of rows) (g.get(key(r)) ?? g.set(key(r), []).get(key(r))!).push(r); return Object.fromEntries([...g.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => [k, all(v)])); };
const magBucket = (b: number): string => (b < 5 ? "<5" : b < 10 ? "5-10" : b < 15 ? "10-15" : ">=15");

export function distributionReport(allRows: readonly DistributionRow[]) {
  const pooled = dedupeDist(allRows);
  const primary = pooled.filter((r) => r.eval_populations.distribution_eval);
  const played = primary.filter((r) => r.labels.participated);
  const material = primary.filter((r) => r.baseline_projection >= 3);
  const withContaminated = pooled;
  const fp = Object.fromEntries([...new Set(allRows.map((r) => `${r.provider}|${r.scoring_fingerprint}`))].sort().map((k) => [k, all(dedupeDist(allRows.filter((r) => `${r.provider}|${r.scoring_fingerprint}` === k), { includeYahoo: true }).filter((r) => r.eval_populations.distribution_eval))]));
  return {
    populations: { rows_total: allRows.length, pooled_sleeper_deduped: pooled.length, primary: primary.length, played_only: played.length, material_baseline_ge_3: material.length, injury_contaminated_excluded: pooled.filter((r) => r.labels.injury_contamination).length, dnp_in_primary: primary.filter((r) => !r.labels.participated).length },
    primary: all(primary), played_only: all(played), material: all(material), including_contaminated: all(withContaminated),
    by_position: seg(primary, (r) => r.position), by_position_material: seg(material, (r) => r.position),
    by_role_confidence: seg(primary, (r) => r.sim.confidence), by_projection_magnitude: seg(primary, (r) => magBucket(r.baseline_projection)),
    by_role_trend: seg(primary, (r) => r.labels.role_trend), by_starter_vs_committee: seg(primary, (r) => (r.labels.depth_starter == null ? "UNKNOWN" : r.labels.depth_starter ? "DEPTH_STARTER" : "NOT_DEPTH_STARTER")), by_teammate_absence: seg(primary, (r) => (r.labels.teammate_absence ? "TEAMMATE_ABSENT" : "NO_HARD_ABSENCE")),
    by_scoring_fingerprint: fp,
    tails: [5, 8, 10].map((t) => tailReport(primary, t)), tails_material: [5, 8, 10].map((t) => tailReport(material, t)),
    attribution_all: attribution(primary), attribution_by_position: Object.fromEntries(["QB", "RB", "WR", "TE"].map((p) => [p, attribution(primary.filter((r) => r.position === p))])),
  };
}
export type DistributionReport = ReturnType<typeof distributionReport>;

/** Compact weekly-audit component (composed from the analysis rows; the audit never stores player-level evidence). */
export function distributionAuditComponent(all: readonly DistributionRow[]) {
  const r = distributionReport(all);
  const pick = (s: ModelStats) => ({ n: s.n, mae: s.mean_accuracy.mae, rmse: s.mean_accuracy.rmse, bias: s.mean_accuracy.bias, mean_pinball: s.calibration.mean_pinball, crps_approx: s.calibration.crps_approx, interval_score_60: s.mean_interval_score_60, interval_score_80: s.mean_interval_score_80, coverage_incl: s.calibration.intervals.map((i) => ({ interval: i.name, nominal: i.nominal, observed: i.observed, width: i.mean_width })), coverage_pit: s.calibration.pit_intervals, exceed_p90: s.calibration.exceed_p90, below_p10: s.calibration.below_p10 });
  const models = (m: Record<ModelId, ModelStats>) => Object.fromEntries(MODELS.map((k) => [k, pick(m[k])]));
  return {
    digest: createHash("sha256").update(all.map((x) => x.da_id).sort().join("|")).digest("hex").slice(0, 16),
    mode: "SHADOW_ONLY" as const, populations: r.populations, primary: models(r.primary), material: models(r.material),
    by_position: Object.fromEntries(Object.entries(r.by_position).map(([p, m]) => [p, models(m)])), tails: r.tails, error_attribution: r.attribution_all,
    note: "Projection distribution calibration (Phase 3). Models A/B/C/D are SHADOW_ONLY: production projections, floors and ceilings are unchanged.",
  };
}
export type DistributionAuditComponent = ReturnType<typeof distributionAuditComponent>;
