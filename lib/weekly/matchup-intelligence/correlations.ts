/**
 * Phase 5 — 2-factor residual dependence model (DIAGNOSTIC only).
 *
 * `analysis/football_intel_matchup/fit_correlations.R` measured real residual
 * dependence — same-team QB↔WR ≈ 0.31, QB↔TE ≈ 0.26, same-game QB↔QB ≈ 0.19,
 * DST↔opposing-QB ≈ −0.36. But `calibration_backtest.R` showed the 2-factor
 * model adds NO incremental win-probability calibration value (Brier −0.0002).
 *
 * So this model is loaded and exposed as a `dependence_diagnostics` block +
 * used for the theoretical sanity checks and (shadow) leverage on stacked
 * lineups — it is NEVER in the headline win probability (spec §6, §28).
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const PATH = join(process.cwd(), "lib", "weekly", "data", "matchup_correlation_model.json");

export interface CorrelationModel {
  correlation_model_version: string;
  structure: string;
  team_passing_factor: {
    qb_loading: number;
    catcher_loadings: Record<string, number>;
  };
  game_scoring_factor: {
    qb_qb_residual_corr: number;
    qb_loading: number;
    dst_oppqb_corr: number;
  };
  deployment: string;
  note: string;
}

let cached: CorrelationModel | null | undefined;
export function loadCorrelationModel(force = false): CorrelationModel | null {
  if (!force && cached !== undefined) return cached;
  cached = existsSync(PATH) ? (JSON.parse(readFileSync(PATH, "utf8")) as CorrelationModel) : null;
  return cached;
}
export function __resetCorrelationModelCache(): void {
  cached = undefined;
}

/** loading of a player on the team-passing latent factor (QB=1, WR/TE from the model, else 0). */
export function teamPassingLoading(position: string, isQb: boolean, model: CorrelationModel | null): number {
  if (isQb) return model?.team_passing_factor.qb_loading ?? 1;
  const l = model?.team_passing_factor.catcher_loadings[position];
  return typeof l === "number" && Math.abs(l) >= 0.1 ? l : 0; // ignore negligible (RB ≈ 0.05)
}

/** loading of the QB on the shared game-scoring factor. */
export function gameScoringLoading(isQb: boolean, model: CorrelationModel | null): number {
  return isQb ? (model?.game_scoring_factor.qb_loading ?? 0) : 0;
}

/** DST correlation with the OPPOSING team's passing factor (strongly negative). */
export function dstOpposingLoading(position: string, model: CorrelationModel | null): number {
  return position === "DEF" ? (model?.game_scoring_factor.dst_oppqb_corr ?? 0) : 0;
}
