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

/** The five predicates a week must satisfy to count (Phase 3.5A; auditable per week). */
export const EVIDENCE_PREDICATES = [
  "NFL_WEEK_COMPLETE",
  "FI_ASOF_AVAILABLE",
  "CURRENT_SEASON_FI_AVAILABLE",
  "ACTUALS_AVAILABLE",
  "PRODUCTION_BASELINE_AVAILABLE",
] as const;
export type EvidencePredicate = (typeof EVIDENCE_PREDICATES)[number];

export interface WeekEvidence {
  week: number;
  predicates: Record<EvidencePredicate, boolean>;
  counts: boolean;
  /** why each failing predicate failed (empty when the week counts). */
  reasons: string[];
  detail?: { games_scheduled: number | null; games_completed: number | null; live_captured_records: number };
}

export interface ReevaluationManifest {
  /** present on manifests produced by the Phase 3.5A gate; absence => legacy, untrusted. */
  evidence_gate_version?: string;
  week_evidence?: WeekEvidence[];
  candidate_weeks?: number[];
  rejected_weeks?: Array<{ week: number; reasons: string[] }>;
  post_lock_observations?: number;
  nfl_reality?: unknown;
  capture_summary_available?: boolean;
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
  // Phase 3.5A: the count is never trusted on its own. Every listed week must be
  // backed by per-week evidence in which ALL five predicates are true. A legacy
  // manifest (no per-week evidence) can never open the gate.
  if (!weekEvidenceSupportsCount(man)) return false;
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

/** true iff every week in `completed_fi_week_list` has per-week evidence with all predicates true (and no duplicates). */
export function weekEvidenceSupportsCount(man: ReevaluationManifest): boolean {
  const list = man.completed_fi_week_list ?? [];
  if (list.length === 0) return true; // nothing claimed; nothing to substantiate
  if (!man.evidence_gate_version || !Array.isArray(man.week_evidence)) return false;
  if (new Set(list).size !== list.length || man.completed_fi_weeks !== list.length) return false;
  return list.every((w) => {
    const e = man.week_evidence!.find((x) => x.week === w);
    return !!e && e.counts === true && EVIDENCE_PREDICATES.every((p) => e.predicates?.[p] === true);
  });
}
