/**
 * Phase 9 — the typed Weekly Model Audit contract. AUDIT FIRST. CALIBRATE SECOND. NEVER AUTO-TUNE PRODUCTION.
 *
 * One `WeeklyModelAudit` record answers, for one (season, week): what did the system believe, what happened, where
 * did it miss and why (to the extent evidence supports a cause), and what deserves future research. It NEVER
 * contains a composite grade (Step 48) and it NEVER writes a model weight, threshold or deployment state — every
 * writer in this module is read-only against production config; the only writes are immutable evidence rows.
 */
import type { WeekClosure } from "./week-closure";

export const WEEKLY_AUDIT_SCHEMA_VERSION = 1;
export type AuditStatus = "WEEK_IN_PROGRESS" | "WEEK_COMPLETE" | "WEEK_INCOMPLETE_SOURCE_CONFLICT" | "WEEK_COMPLETE_WITH_MISSING_OUTCOMES";
export type AuditSeverity = "INFO" | "WATCH" | "INVESTIGATE" | "BLOCKING_DATA_QUALITY";
/** One component's own status. A component that could not run never fabricates a result; it reports why. */
export type ComponentStatus = "READY" | "PARTIAL" | "SOURCE_UNAVAILABLE" | "NOT_APPLICABLE" | "SKIPPED_WEEK_NOT_COMPLETE";

export interface ComponentResult<T> {
  status: ComponentStatus;
  detail?: string;
  data: T | null;
}

export interface DataQualityFinding { code: string; severity: AuditSeverity; scope: string; detail: string; rows_excluded: number }

export interface ProjectionErrorRow { canonical_player_id: string; position: string; signed_error: number; abs_error: number; baseline_version: string | null; availability_status: string | null }
export interface ProjectionCalibration {
  by_position: Record<string, { n: number; mae: number; rmse: number; signed_bias: number }>;
  severe_misses: Array<{ canonical_player_id: string; position: string; abs_error: number }>;
  severe_miss_threshold_points: number;
  rows_evaluated: number;
  rows_excluded_missing_actual: number;
  rows_excluded_kdst_unsupported: number;
}

export interface StartSitDecisionOutcome {
  capture_id: string; league_slug: string; manager_slug: string; slot: string;
  baseline_player: string; fi_player: string; reversal: boolean;
  actual_baseline_points: number | null; actual_fi_points: number | null;
  winner: "BASELINE" | "FI" | "TIE" | "UNEVALUABLE"; realized_margin: number | null;
  baseline_regret: number | null; fi_regret: number | null; severe_miss: boolean; reason?: string;
}
export interface StartSitCalibration {
  evidence_class: "LIVE_CAPTURED"; decisions_evaluated: number; decisions_unevaluable: number; reversals: number;
  reversals_helped: number; reversals_hurt: number; mean_baseline_regret: number | null; mean_fi_regret: number | null;
  by_family: Record<string, { adjustment_count: number; reversal_count: number; mean_delta_regret: number | null }>;
  diagnostic_post_lock_decisions: number; diagnostic_reconstructed_decisions: number;
}

export type MatchupMissCategory =
  | "EVIDENCE_ALIGNED_OUTCOME_STRONG" | "EVIDENCE_ALIGNED_OUTCOME_WEAK" | "DIRECTIONAL_MISS" | "PLAYER_ROLE_CHANGED"
  | "INJURY_CONTEXT_CHANGED" | "GAME_SCRIPT_CHANGED" | "SOURCE_STALE" | "SOURCE_MISSING" | "OUTCOME_NOT_MEASURABLE" | "INSUFFICIENT_SAMPLE";
export interface Matchup2FamilyAudit { family: string; claim_kind: string; n: number; aligned: number; misses: Record<MatchupMissCategory, number> }
export interface Matchup2Audit { captures_evaluated: number; outcomes_attached: number; by_family: Matchup2FamilyAudit[]; gate: unknown }

export interface Waiver2Audit {
  recommendations_evaluated: number; executed: number; not_executed: number; claimed_by_other_manager: number;
  market_findings: Array<{ capture_id: string; claim_result: string; winning_bid: number | null }>;
  performance_findings: Array<{ capture_id: string; realized_points_started: number | null; role_share_change: number | null }>;
  gate: unknown;
}

export interface RoleChangeEvent { canonical_player_id: string | null; metric: string; prior: number | null; current: number | null; delta: number | null; classification: "EXPANSION" | "CONTRACTION" | "ONE_WEEK_SPIKE" | "SOURCE_UNAVAILABLE" | "INSUFFICIENT_OPPORTUNITY" }
export interface PriorCurrentDisagreement { subject: string; family: string; prior_value: number | null; current_value: number | null; difference: number | null; sample: number | null; confidence: string | null; source_vintage: string | null; material: boolean }
export interface ProfileShift { team: string; metric: string; prior_percentile: number | null; current_percentile: number | null; delta: number | null; material: boolean }

export interface ResearchCandidate { hypothesis: string; supporting_weeks: number[]; sample: number; observed_effect: string; required_future_evidence: string }
export interface FiRetestProgress { family: string; position: string; certification_state: string; qualifying_weeks: number; live_decisions: number; required_weeks: number; required_decisions: number; retest_signal: "RETEST_NOT_READY" | "RETEST_READY" }

export interface WeeklyModelAudit {
  audit_id: string; season: number; week: number; audit_schema_version: number; evidence_digest: string;
  status: AuditStatus; severity: AuditSeverity; generated_at: string;
  week_closure: WeekClosure;
  source_readiness: ComponentResult<{ family: string; status: string; lag_classification: string }[]>;
  freshness_history_recorded: boolean;
  projection_calibration: ComponentResult<ProjectionCalibration>;
  start_sit: ComponentResult<{ decisions: StartSitDecisionOutcome[]; calibration: StartSitCalibration }>;
  fi_weekly_calibration: ComponentResult<{ by_family_position: FiRetestProgress[] }>;
  matchup2: ComponentResult<Matchup2Audit>;
  waiver2: ComponentResult<Waiver2Audit>;
  role_changes: ComponentResult<RoleChangeEvent[]>;
  prior_current_disagreements: ComponentResult<PriorCurrentDisagreement[]>;
  defense_shifts: ComponentResult<ProfileShift[]>;
  offense_shifts: ComponentResult<ProfileShift[]>;
  injury_opportunity: ComponentResult<{ note: string }>;
  data_quality: DataQualityFinding[];
  research_candidates: ResearchCandidate[];
  fi_recertification_progress: FiRetestProgress[];
  limitations: string[];
  lineage: { fi_version: string | null; scoring_fingerprints: string[]; temporal_data_version: string | null; sources: string[] };
}
