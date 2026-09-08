/**
 * Phase 4 remediation Part C — dormant 2026 re-certification reader.
 *
 * The heavy lifting (locate 2026 FI snapshots, build decision data, train a
 * candidate, evaluate, ablate, verdict) is the R pipeline
 * `analysis/football_intel_startsit/reevaluate.R`. This module only READS the
 * machine-readable manifest it emits and exposes the eligibility gate + the
 * deployment-lifecycle status to TypeScript. It never trains, never promotes.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const MANIFEST_PATH = join(process.cwd(), "lib", "weekly", "data", "start_sit_reevaluation_manifest.json");

/** Repository convention for the re-evaluation lifecycle status. */
export type ReevaluationStatus =
  | "NOT_ELIGIBLE"
  | "ELIGIBLE"
  | "RUNNING"
  | "PASSED"
  | "FAILED";

export interface ReevaluationManifest {
  current_model_version: string;
  deployment: string;
  season: number;
  /** completed 2026 NFL weeks with a genuine current-season FI snapshot (never the prior-only one). */
  completed_fi_weeks: number;
  /** which weeks specifically (integers). */
  completed_fi_week_list: number[];
  minimum_weeks_required: number;
  preferred_weeks: number;
  /** each included week must satisfy every one of these to count. */
  per_week_requirements: string[];
  reevaluation_eligible: boolean;
  reevaluation_status: ReevaluationStatus;
  not_eligible_reason: string | null;
  last_evaluated_through_week: number | null;
  next_candidate_version: string;
  /** milestone cadence (documented, machine-readable). */
  cadence: { first_check_week: number; second_check_week: number; thereafter_every_weeks: number };
  /** live shadow decisions captured so far (Part C "shadow accumulation"). */
  live_captured_decisions: number;
  historically_reconstructed_decisions: number;
  generated_at: string;
  /** the R command that regenerates this + runs the gate. */
  refresh_command: string;
  /** the FI snapshot the gate saw, and whether it is genuine current-season. */
  fi_snapshot_seen?: string | null;
  fi_snapshot_is_current_season?: boolean;
  /** set by reevaluate.R after a run. */
  candidate_version_evaluated?: string;
  per_position_verdict?: Array<{ position: string; verdict: string }>;
}

let cached: ReevaluationManifest | null | undefined;

export function loadReevaluationManifest(force = false): ReevaluationManifest | null {
  if (!force && cached !== undefined) return cached;
  if (!existsSync(MANIFEST_PATH)) {
    cached = null;
    return null;
  }
  cached = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as ReevaluationManifest;
  return cached;
}

export function __resetReevaluationCache(): void {
  cached = undefined;
}

/** the current re-evaluation status, derived defensively. */
export function reevaluationStatus(m?: ReevaluationManifest | null): ReevaluationStatus {
  const man = m ?? loadReevaluationManifest();
  if (!man) return "NOT_ELIGIBLE";
  if (man.reevaluation_status === "PASSED" || man.reevaluation_status === "FAILED") return man.reevaluation_status;
  if (man.reevaluation_status === "RUNNING") return "RUNNING";
  return isEligible(man) ? "ELIGIBLE" : "NOT_ELIGIBLE";
}

/**
 * The evidence gate. ELIGIBLE requires: >= minimum genuine current-season FI
 * weeks, each satisfying the per-week requirements (recorded true by the R
 * pipeline in `completed_fi_week_list`). The prior-only snapshot never counts.
 */
export function isEligible(m?: ReevaluationManifest | null): boolean {
  const man = m ?? loadReevaluationManifest();
  if (!man) return false;
  return (
    man.season === 2026 &&
    man.completed_fi_weeks >= man.minimum_weeks_required &&
    man.completed_fi_week_list.length >= man.minimum_weeks_required &&
    man.reevaluation_eligible === true
  );
}

/** next candidate version — 2026.1 is immutable; the next is 2026.N+1. */
export function nextCandidateVersion(current: string): string {
  const m = current.match(/^(.*?-)(\d{4})\.(\d+)$/);
  if (!m) return `${current}.next`;
  return `${m[1]}${m[2]}.${Number(m[3]) + 1}`;
}
