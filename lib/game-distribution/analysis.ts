/**
 * Phase 3 analysis: joins Phase-1 ledger cases and Phase-2 role analysis rows to the simulated football outcome distributions, then scores four
 * SHADOW models against the actual fantasy score with proper scoring rules:
 *   A  production baseline: normal(median, sd) — the production floor/ceiling heuristic expressed as a distribution (lib/weekly/uncertainty.ts)
 *   B  baseline mean + Phase-3 distribution SHAPE (raw simulated quantiles rescaled to the baseline mean; no environment mean used)
 *   C  environment-derived mean + recalibrated Phase-3 distribution (the simulation as-is, PIT-recalibrated on prior-season weeks)
 *   D  Phase-2 role mean shift + Phase-3 shape (research comparison only)
 * All SHADOW_ONLY. One football simulation per player-game; each league fingerprint translates the same simulated stat lines.
 */
import { createHash } from "node:crypto";
import { QUANTILE_LEVELS, inverseLevel, meanPinball, normalQuantiles, pit, pitNormalClamped, qKey, summarize, summarizeRecalibrated, intervalScore, INTERVALS } from "./dist";
import { linearCoefficients, scoreStats, N_STATS } from "./fast-score";
import { mulberry32, seedFrom } from "./rng";
import { GAME_DISTRIBUTION_MODEL_VERSION, type CalibrationPriors } from "./priors";
import type { GameSimResult, PlayerSim } from "./simulate";
import type { RoleAnalysisRow } from "@/lib/role-calibration/analysis";
import type { RolePosition } from "@/lib/role-calibration/types";
import { WEEKLY_POSITION_CV } from "@/lib/weekly/uncertainty";

export const SHADOW_ONLY = "SHADOW_ONLY" as const;
const r4 = (v: number): number => Math.round(v * 1e4) / 1e4;
export type ModelId = "A" | "B" | "C" | "D";
export interface ModelDist { mean: number; median: number; quantiles: Record<string, number>; sd: number; scores: { mean_pinball: number; interval_score_60: number; interval_score_80: number; pit: number; inside_60: boolean; inside_80: boolean; inside_p10_p90: boolean; inside_p5_p95: boolean; above_p90: boolean; below_p10: boolean } }
export interface CaseExtra { case_id: string; projected_std_dev: number | null; projected_floor: number | null; projected_ceiling: number | null; projection_artifact_kind: string | null }

export interface DistributionRow {
  da_id: string; model_version: string; mode: typeof SHADOW_ONLY;
  case_id: string; evidence_digest: string; season: number; week: number; league_slug: string; provider: string; scoring_fingerprint: string;
  position: RolePosition; canonical_player_id: string; gsis_id: string | null; sleeper_id: string | null; player_name: string | null; nfl_team: string | null;
  baseline_projection: number; actual_fantasy_points: number; projection_error: number;
  sim: { sims: number; seed: number; pool_key: string; confidence: string; sim_mean: number; p_zero: number };
  models: Record<ModelId, ModelDist>;
  mean_miss_5: boolean; mean_miss_8: boolean; mean_miss_10: boolean;
  labels: RoleAnalysisRow["labels"]; eval_populations: RoleAnalysisRow["eval_populations"] & { distribution_eval: boolean };
  exclusion_reasons: string[];
  decomposition6: import("./decompose").Decomp6 | null;
}

function shapeTransform(points: Float64Array, baselineMean: number, simMean: number): Float64Array {
  const out = new Float64Array(points.length);
  if (simMean >= 1) { const k = baselineMean / simMean; for (let i = 0; i < points.length; i++) out[i] = Math.max(0, points[i]! * k); }
  else { const d = baselineMean - simMean; for (let i = 0; i < points.length; i++) out[i] = Math.max(0, points[i]! + d); }
  return out;
}
function scoreDist(actual: number, quantiles: Record<string, number>, pitV: number): ModelDist["scores"] {
  const q = quantiles;
  const inside = (lo: string, hi: string) => actual >= q[lo]! && actual <= q[hi]!;
  return { mean_pinball: r4(meanPinball(actual, q)), interval_score_60: r4(intervalScore(actual, q.p20!, q.p80!, 0.4)), interval_score_80: r4(intervalScore(actual, q.p10!, q.p90!, 0.2)), pit: r4(pitV), inside_60: inside("p20", "p80"), inside_80: inside("p10", "p90"), inside_p10_p90: inside("p10", "p90"), inside_p5_p95: inside("p5", "p95"), above_p90: actual > q.p90!, below_p10: actual < q.p10! };
}
function modelFrom(actual: number, draws: Float64Array, recalMap: number[] | null, u: number, meanOverride?: number): ModelDist {
  const s = recalMap ? summarizeRecalibrated(draws, recalMap) : summarize(draws);
  const rawPit = pit(draws, actual, u);
  return { mean: meanOverride ?? s.mean, median: s.quantiles.p50!, quantiles: s.quantiles, sd: s.sd, scores: scoreDist(actual, s.quantiles, recalMap ? inverseLevel(recalMap, rawPit) : rawPit) };
}

export interface BuildDistInput {
  roleRows: readonly RoleAnalysisRow[];
  cases: ReadonlyMap<string, CaseExtra>;
  sims: ReadonlyMap<string, GameSimResult>;          // by gsis team key: see simKey
  simByGsis: ReadonlyMap<string, PlayerSim>;
  priors: CalibrationPriors;
  rawScoringByFingerprint: ReadonlyMap<string, Record<string, number>>;
  decomp6?: (r: RoleAnalysisRow) => import("./decompose").Decomp6 | null;
}

export function buildDistributionAnalysis(inp: BuildDistInput): DistributionRow[] {
  const rows: DistributionRow[] = [];
  const coefCache = new Map<string, Float64Array>();
  for (const r of inp.roleRows) {
    if (r.baseline_projection == null || r.actual_fantasy_points == null || !r.gsis_id) continue;
    const ps = inp.simByGsis.get(r.gsis_id); const raw = inp.rawScoringByFingerprint.get(r.scoring_fingerprint);
    if (!ps || !raw || ps.forecast.confidence === "INSUFFICIENT_SAMPLE") continue;
    const ck = `${r.scoring_fingerprint}|${r.position}`; let coef = coefCache.get(ck); if (!coef) { coef = linearCoefficients(r.position, raw); coefCache.set(ck, coef); }
    const n = ps.stats.length / N_STATS; const pts = new Float64Array(n);
    for (let s = 0; s < n; s++) pts[s] = scoreStats(ps.stats, s * N_STATS, coef);
    const simSum = summarize(pts); const actual = r.actual_fantasy_points, base = r.baseline_projection;
    const extra = inp.cases.get(r.case_id);
    const u = mulberry32(seedFrom("pit", r.case_id))(); // seeded tie-break for randomized PIT
    const recal = inp.priors.recalibration.mapped[r.position] ?? inp.priors.recalibration.mapped.ALL ?? null;
    // A: production heuristic as a distribution
    const sd = extra?.projected_std_dev != null && extra.projected_std_dev > 0 ? extra.projected_std_dev : Math.abs(base) * (WEEKLY_POSITION_CV[r.position] ?? 0.5);
    const aq = normalQuantiles(base, sd); const aPit = pitNormalClamped(actual, base, sd, u);
    const A: ModelDist = { mean: base, median: base, quantiles: aq, sd: r4(sd), scores: scoreDist(actual, aq, aPit) };
    // B: baseline mean, raw simulated shape
    const Bdraws = shapeTransform(pts, base, simSum.mean); const B = modelFrom(actual, Bdraws, null, u, base);
    // C: environment-derived mean, recalibrated
    const C = modelFrom(actual, pts, recal, u, simSum.mean);
    // D: Phase-2 role mean shift, raw shape
    const dMean = r.shadow?.candidate_projection ?? base; const Ddraws = shapeTransform(pts, dMean, simSum.mean); const D = modelFrom(actual, Ddraws, null, u, dMean);
    const err = Math.abs(actual - base); const zeros = pts.reduce((c, v) => c + (v === 0 ? 1 : 0), 0) / n;
    const distEval = r.eval_populations.projection_eval;
    const da_id = `da:${createHash("sha256").update(JSON.stringify([GAME_DISTRIBUTION_MODEL_VERSION, r.case_id, r.evidence_digest, r.forecast_id, ps.pool_key, simSum.mean, simSum.quantiles])).digest("hex").slice(0, 24)}`;
    rows.push({ da_id, model_version: GAME_DISTRIBUTION_MODEL_VERSION, mode: SHADOW_ONLY, case_id: r.case_id, evidence_digest: r.evidence_digest, season: r.season, week: r.week, league_slug: r.league_slug, provider: r.provider, scoring_fingerprint: r.scoring_fingerprint, position: r.position, canonical_player_id: r.canonical_player_id, gsis_id: r.gsis_id, sleeper_id: r.sleeper_id, player_name: r.player_name, nfl_team: r.nfl_team, baseline_projection: base, actual_fantasy_points: actual, projection_error: r4(actual - base),
      sim: { sims: n, seed: seedFrom(GAME_DISTRIBUTION_MODEL_VERSION, r.season, r.week, "game"), pool_key: ps.pool_key, confidence: ps.forecast.confidence, sim_mean: simSum.mean, p_zero: r4(zeros) }, models: { A, B, C, D },
      mean_miss_5: err >= 5, mean_miss_8: err >= 8, mean_miss_10: err >= 10, labels: r.labels, eval_populations: { ...r.eval_populations, distribution_eval: distEval }, exclusion_reasons: r.exclusion_reasons, decomposition6: inp.decomp6 ? inp.decomp6(r) : null });
  }
  return rows;
}
export { INTERVALS, QUANTILE_LEVELS, qKey };
