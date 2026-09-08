/**
 * Phase 5 — per-player residual distribution sampler.
 *
 * Reads the versioned `matchup_distribution_model.json` (produced by
 * `analysis/football_intel_matchup/fit_distributions.R`) — a chronology-safe,
 * OOS-calibrated model per position: a mean-bias correction, an sd model
 * (const / cv / bucket / linear / sqrt), a marginal family (empirical
 * standardized-residual grid, or normal_clamp), and a validated injury-widen
 * factor. Deterministic given (proj, rng).
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const MODEL_PATH = join(process.cwd(), "lib", "weekly", "data", "matchup_distribution_model.json");

interface SdParams {
  kind: "const" | "cv" | "bucket" | "linear" | "sqrt";
  s?: number;
  cv?: number;
  breaks?: number[];
  sd?: number[];
  a?: number;
  b?: number;
}
interface PositionModel {
  position: string;
  sd_model: string;
  marginal: "empirical" | "normal_clamp" | "mixture";
  sd_params: SdParams;
  mean_bias_correction: number;
  z_grid: number[] | null;
  bust_weight: number;
  injury_widen_factor: number;
  empirical_resid_sd: number;
  weeklyband_cv_sd_at_mean: number;
  calibration: { pit_ks: number; pi80_cov: number; pi50_cov: number };
}
export interface DistributionModel {
  distribution_model_version: string;
  matchup_model_version: string;
  archetype: string;
  positions: Record<string, PositionModel>;
  deployment: string;
}

let cached: DistributionModel | null | undefined;
export function loadDistributionModel(force = false): DistributionModel | null {
  if (!force && cached !== undefined) return cached;
  cached = existsSync(MODEL_PATH) ? (JSON.parse(readFileSync(MODEL_PATH, "utf8")) as DistributionModel) : null;
  return cached;
}
export function __resetDistributionModelCache(): void {
  cached = undefined;
}

const num = (v: unknown, d = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : d);

function sdFn(sp: SdParams): (proj: number) => number {
  switch (sp.kind) {
    case "const":
      return () => Math.max(1, num(sp.s, 4));
    case "cv":
      return (p) => Math.max(2, Math.abs(p) * num(sp.cv, 0.45));
    case "linear":
      return (p) => Math.max(2, num(sp.a) + num(sp.b) * p);
    case "sqrt":
      return (p) => Math.max(2, num(sp.a) + num(sp.b) * Math.sqrt(Math.max(p, 0)));
    case "bucket": {
      const br = (sp.breaks ?? []).map((x) => num(x));
      const sv = (sp.sd ?? []).map((x) => num(x, NaN));
      const fallback = sv.filter(Number.isFinite).sort((a, b) => a - b)[Math.floor(sv.length / 2)] ?? 6;
      return (p) => {
        let i = 0;
        while (i < br.length - 1 && p > br[i + 1]!) i += 1;
        const v = sv[i];
        return v != null && Number.isFinite(v) ? v : fallback;
      };
    }
    default:
      return () => 6;
  }
}

/** inverse-CDF of the empirical standardized-residual grid (51 evenly-spaced quantiles). */
function invZ(grid: number[], u: number): number {
  const n = grid.length;
  const x = Math.min(0.999999, Math.max(1e-6, u)) * (n - 1);
  const lo = Math.floor(x);
  const hi = Math.min(n - 1, lo + 1);
  const frac = x - lo;
  return grid[lo]! * (1 - frac) + grid[hi]! * frac;
}

export interface PlayerSampler {
  position: string;
  /** mean actually used = projection + bias correction. */
  meanFor(proj: number): number;
  sdFor(proj: number, questionable: boolean): number;
  /** one draw from the calibrated marginal. */
  draw(proj: number, questionable: boolean, rng: () => number): number;
  calibrated: boolean;
}

/** a rough Box–Muller from a uniform stream (kept local for determinism control). */
function normal(rng: () => number): number {
  const u1 = Math.max(1e-12, rng());
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

export function playerSampler(position: string, model: DistributionModel | null): PlayerSampler {
  const pm = model?.positions[position] ?? null;
  const bias = num(pm?.mean_bias_correction, 0);
  const sfn = pm ? sdFn(pm.sd_params) : (p: number) => Math.max(2, Math.abs(p) * 0.45);
  const widen = num(pm?.injury_widen_factor, 1);
  const grid = pm?.z_grid ?? null;
  const family = pm?.marginal ?? "normal_clamp";
  const bustW = num(pm?.bust_weight, 0);

  return {
    position,
    calibrated: pm != null,
    meanFor: (proj) => proj + bias,
    sdFor: (proj, q) => sfn(proj + bias) * (q ? widen : 1),
    draw: (proj, q, rng) => {
      const mu = proj + bias;
      const sd = sfn(mu) * (q ? widen : 1);
      if (!grid || family === "normal_clamp") return Math.max(0, mu + sd * normal(rng));
      if (family === "mixture" && bustW > 0 && rng() < bustW) {
        return Math.max(0, 0.3 + 0.4 * normal(rng));
      }
      return Math.max(0, mu + sd * invZ(grid, rng()));
    },
  };
}
