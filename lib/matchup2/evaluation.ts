/**
 * Phase 5 — out-of-sample EVIDENCE for each interaction family, from two chronology-safe walk-forward studies against the SAME production-like
 * baseline: Phase 9 Tier D (7 families) and the Phase 5 study (6 new families, analysis/matchup2/evaluate_phase5.R). A component's predictive
 * class is DERIVED from this evidence: a family with no PREDICTIVE_INCREMENTAL result is contextual evidence, whatever its registry candidacy.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { playerSchemeInteractions } from "@/lib/player-scheme-intelligence/read";
import type { Position } from "./contract";

export interface EvalRow { study: "PHASE9_TIER_D" | "PHASE5_WALKFORWARD"; family: string; position: string; n_test: number | null; delta_mae_vs_baseline: number | null; p_value: number | null; fdr_reject: boolean | null; status: string }
const MAP: Record<string, Partial<Record<Position, string>>> = {
  "coverage.man_zone": { QB: "qb_coverage", WR: "wr_man_zone", TE: "te_man_zone", RB: "rb_man_zone_receiving" }, "area.pass_depth_third": { QB: "qb_spatial", WR: "wr_spatial", TE: "te_spatial" },
  "explosive.area": { WR: "wr_explosive_area", TE: "te_explosive_area" }, "pressure.qb_response": { QB: "qb_pressure" }, "run.direction": { RB: "rb_direction" }, "run.gap": { RB: "rb_run_gap" }, "run.box": { RB: "rb_box" },
};
let cached: EvalRow[] | null = null;
export function evaluationRows(): EvalRow[] {
  if (cached) return cached;
  const rows: EvalRow[] = playerSchemeInteractions().map((r) => ({ study: "PHASE9_TIER_D", family: r.family, position: r.position, n_test: r.n_test_rows, delta_mae_vs_baseline: r.delta_mae_vs_production_like_baseline, p_value: r.p_value, fdr_reject: r.fdr_reject, status: r.validation_status }));
  const p = join(process.cwd(), "lib", "matchup2", "data", "walkforward_results.json");
  if (existsSync(p)) { const j = JSON.parse(readFileSync(p, "utf8")) as { rows: Array<{ family: string; position: string; n_test: number | null; delta_mae_vs_b1: number | null; p_value: number | null; fdr_reject: boolean | null; class: string }> }; for (const r of j.rows) rows.push({ study: "PHASE5_WALKFORWARD", family: r.family, position: r.position, n_test: r.n_test, delta_mae_vs_baseline: r.delta_mae_vs_b1, p_value: r.p_value, fdr_reject: r.fdr_reject, status: r.class }); }
  return (cached = rows);
}
export function __resetEvaluationCache(): void { cached = null; }
export const evaluationFor = (registryFamily: string, position: Position | "TEAM"): EvalRow | null => { const f = position === "TEAM" ? undefined : MAP[registryFamily]?.[position]; return f ? evaluationRows().find((r) => r.family === f) ?? null : null; };
export const anyPredictiveIncremental = (): boolean => evaluationRows().some((r) => r.status === "PREDICTIVE_INCREMENTAL");
export function evaluationLine(r: EvalRow): string { const d = r.delta_mae_vs_baseline; return `out-of-sample (${r.study === "PHASE5_WALKFORWARD" ? "Phase 5" : "Phase 9 Tier D"} walk-forward vs the production-like baseline, n=${r.n_test}): ${r.family} = ${r.status}${d != null ? `, ΔMAE ${d >= 0 ? "+" : ""}${d.toFixed(4)} fantasy points` : ""}${r.p_value != null ? `, p=${r.p_value.toFixed(3)}` : ""} — ${r.status === "PREDICTIVE_INCREMENTAL" ? "incremental value shown" : "no incremental predictive value beyond the baseline"}`; }
