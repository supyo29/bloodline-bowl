/**
 * Phase 8 — read-only access to the committed FI certification evidence (`lib/weekly/data/fi_certification_2026.1.json`),
 * produced by `analysis/football_intel_phase8/{evaluate,finalize}.R` under pre-registered criteria.
 *
 * This file never mutates deployment state. A family x position without a record is `SHADOW_ONLY`.
 * Only `PRODUCTION_ELIGIBLE` / `PRODUCTION_ACTIVE` evidence may back an activation (defence in depth: even if
 * someone flips the deployment config, an uncertified family stays blocked by the gate).
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { DeploymentState } from "./deployment";

export interface FiCertificationCandidate {
  position: string; family: string;
  start_state: DeploymentState; evaluable_state: DeploymentState; evaluated_state: DeploymentState | "PENDING_HOLDOUT";
  verdict_reason: string; failed_gates: string[]; amendment_a1_applied: boolean; tau: number | null;
  mae_baseline: number; mae_candidate: number; mae_improvement: number; mae_improvement_ci90: [number, number]; bh_q: number;
  adjustment_abs_mean: number; adjustment_abs_p95: number; adjustment_abs_max: number;
  decision: null | { pairs_in_region: number; reversals: number; mean_regret_improvement_per_pair: number; lo: number; hi: number; reversal_win_rate: number | null; mean_delta_per_reversal: number | null; median_delta_per_reversal: number | null; pct_reversals_improved: number | null; pct_reversals_worsened: number | null; severe_miss_rate: number | null; large_win_rate: number | null };
  calibration: { slope: number | null; lo: number | null; hi: number | null; spearman: number | null; buckets: number[] | null };
  holdout: { opened: boolean; reason?: string };
  prospective: { qualifying_weeks: number; live_captured_decisions: number; required_weeks: number; required_decisions: number; met: boolean };
  highest_state_reachable_from_evidence: string; production_state: DeploymentState;
}
export interface FiCertification {
  certification_version: string; criteria_version: string; lane: string; consumer_scope: string; holdout_opened: boolean;
  baseline: { primary: string; naive_control: string; integrity: { rows: number; mae_sleeper: number; mae_trailing: number }; primary_is_stronger_than_naive: boolean };
  summary: Record<string, number>; candidates: FiCertificationCandidate[];
  not_evaluated: Array<{ family: string; reason: string; state: DeploymentState }>;
  served_bundles_nongating: Record<string, { families: string[]; mae_delta: number; lo: number; hi: number; gating: boolean }>;
}

const PATH = join(process.cwd(), "lib", "weekly", "data", "fi_certification_2026.1.json");
let cached: FiCertification | null | undefined;
export function loadFiCertification(force = false): FiCertification | null {
  if (!force && cached !== undefined) return cached;
  cached = existsSync(PATH) ? (JSON.parse(readFileSync(PATH, "utf8")) as FiCertification) : null;
  return cached;
}
export function __resetFiCertificationCache(): void { cached = undefined; }

/** Certified lifecycle state for one family x position. Anything not evaluated is SHADOW_ONLY. */
export function fiCertifiedState(family: string, position: string, cert: FiCertification | null = loadFiCertification()): DeploymentState {
  const c = cert?.candidates.find((x) => x.family === family && x.position === position);
  if (!c) return "SHADOW_ONLY";
  return c.evaluated_state === "PENDING_HOLDOUT" ? "RESEARCH_ELIGIBLE" : c.evaluated_state;
}
/** Only these certified states can back an activation. */
export function certificationAllowsActivation(state: DeploymentState): boolean {
  return state === "PRODUCTION_ELIGIBLE" || state === "PRODUCTION_ACTIVE";
}
