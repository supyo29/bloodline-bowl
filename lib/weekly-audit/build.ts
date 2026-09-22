/**
 * Phase 9 — the weekly audit composer. AUDIT FIRST. CALIBRATE SECOND. NEVER AUTO-TUNE PRODUCTION: nothing in this
 * file writes a model weight, coefficient, threshold or deployment state; the only writes anywhere in Phase 9 are
 * insert-only, idempotent evidence rows (outcomes, the audit record, freshness history).
 *
 * Runs read-only against captures UNLESS `write: true` AND the week is `WEEK_COMPLETE` — an incomplete week can be
 * previewed (every section still computes, all reasoning is honest) but its outcomes/audit record are NEVER
 * persisted, so an in-progress week can never be silently "finalized" (Step 3/5).
 *
 * One partial-failure component never erases another (Step 46): each section carries its OWN `ComponentStatus`.
 */
import { loadNflSeasonCompletion } from "@/lib/canonical/nfl-reality-frontier";
import { assessIntelligenceFreshness } from "@/lib/canonical/intelligence-freshness";
import { loadFootballIntelligence } from "@/lib/football-intel";
import { buildFootballIntelligenceLineage } from "@/lib/football-intel/lineage";
import { loadFiCertification } from "@/lib/weekly/start-sit-fi/certification";
import { loadReevaluationManifest } from "@/lib/weekly/start-sit-fi/reevaluation";
import { determineWeekClosure } from "./week-closure";
import { evidenceDigest, auditId } from "./identity";
import { loadWeekActuals } from "./scoring-actuals";
import { buildStartSitOutcomes, calibrateStartSit, type StartSitCaptureRow } from "./outcomes-startsit";
import { buildMatchup2Outcomes, type Matchup2CaptureRow } from "./outcomes-matchup2";
import { buildWaiver2Outcomes, type Waiver2CaptureRow } from "./outcomes-waiver2";
import { runDataQualityChecks } from "./data-quality";
import { errorStats } from "./calibration";
import { fiRetestProgress, matchup2EvidenceGate, waiver2EvidenceGate } from "./gates";
import {
  defaultWeeklyAuditRest, readStartSitCaptures, readMatchup2Captures, readWaiver2Captures,
  readStartSitOutcomes, readMatchup2Outcomes, readWaiver2Outcomes,
  writeStartSitOutcomes, writeMatchup2Outcomes, writeWaiver2Outcomes, writeWeeklyModelAudit, writeFreshnessHistory,
} from "@/lib/persistence/supabase/weekly-audit-store";
import type { WeeklyModelAudit, ComponentResult, DataQualityFinding, ProjectionCalibration, ProjectionErrorRow } from "./contract";
import { WEEKLY_AUDIT_SCHEMA_VERSION } from "./contract";
import type { ShadowOutcomeRecord } from "@/lib/weekly/start-sit-fi/capture";
import type { Matchup2Outcome } from "@/lib/matchup2/capture";
import type { WaiverOutcome } from "@/lib/waiver2/capture";
const SEVERE_MISS_POINTS = 8;

export interface BuildWeeklyAuditInput {
  season: number;
  week: number;
  /** the league whose raw_scoring settings back every scoring_fingerprint referenced this week (Phase 6: outcomes score by the LEAGUE's own contract). */
  rawScoringByFingerprint: ReadonlyMap<string, Record<string, number>>;
  /** persist outcomes + the audit record. Ignored (forced false) unless the week is WEEK_COMPLETE. */
  write?: boolean;
  now?: number;
}

const ready = <T>(data: T): ComponentResult<T> => ({ status: "READY", data });
const skipped = <T>(detail: string): ComponentResult<T> => ({ status: "SKIPPED_WEEK_NOT_COMPLETE", detail, data: null });
const unavailable = <T>(detail: string): ComponentResult<T> => ({ status: "SOURCE_UNAVAILABLE", detail, data: null });
const notApplicable = <T>(detail: string): ComponentResult<T> => ({ status: "NOT_APPLICABLE", detail, data: null });

export async function buildWeeklyModelAudit(input: BuildWeeklyAuditInput): Promise<WeeklyModelAudit> {
  const now = input.now ?? Date.now();
  const nowIso = new Date(now).toISOString();
  const completion = await loadNflSeasonCompletion(input.season).catch(() => null);
  const closure = determineWeekClosure(input.season, input.week, completion);
  const rest = defaultWeeklyAuditRest();
  const canWrite = !!input.write && closure.status === "WEEK_COMPLETE" && !!rest;

  // ---- FI freshness (always attempted; independent of week closure) ----------------------------------------
  const fi = loadFootballIntelligence();
  const fiLineage = buildFootballIntelligenceLineage(fi);
  let sourceReadiness: ComponentResult<{ family: string; status: string; lag_classification: string }[]> = unavailable("FI manifest unavailable");
  let freshnessRecorded = false;
  if (fiLineage) {
    const snapshot = { league_snapshot_id: "audit", snapshot_schema_version: 3, content_hash: "audit", generated_at: nowIso, provider: "sleeper", league_slug: "audit", league_id: "0", season: input.season, week: input.week, scoring_fingerprint: null, roster_fingerprint: null, player_data_version: null, crosswalk_version: null };
    const assessment = assessIntelligenceFreshness({ lineage: { snapshot, projections: [], football_intelligence: fiLineage, engine_versions: {} } as never, operation: "ANALYSIS_ONLY", now });
    sourceReadiness = ready(assessment.feature_families.map((f) => ({ family: f.family, status: f.availability, lag_classification: f.lag_classification })));
    if (canWrite && rest) { const w = await writeFreshnessHistory(rest, { season: input.season, week: input.week, fi_version: fiLineage.version, overall_status: assessment.overall_status, family_statuses: assessment.feature_families, nfl_reality: assessment.nfl_reality }); freshnessRecorded = w.inserted > 0 || w.duplicate > 0; }
  }

  const dq: DataQualityFinding[] = [];
  const limitations: string[] = [];
  const scoringFingerprints = new Set<string>();

  // If the week is not complete, every outcome-dependent section is SKIPPED, honestly, and NOTHING is written.
  if (closure.status !== "WEEK_COMPLETE") {
    const s = `week ${input.week} is ${closure.status} (${closure.reason}) — outcome ingestion refused (Step 3/5: no incomplete week is finalized)`;
    const skippedAll = skipped<never>(s) as never;
    const digest = evidenceDigest({ fi_version: fiLineage?.version ?? null, scoring_fingerprints: [], startsit_capture_ids: [], startsit_outcome_sources: [], matchup2_capture_ids: [], matchup2_outcome_sources: [], waiver2_capture_ids: [], waiver2_outcome_sources: [], certification_version: null });
    return {
      audit_id: auditId(input.season, input.week, digest), season: input.season, week: input.week, audit_schema_version: WEEKLY_AUDIT_SCHEMA_VERSION, evidence_digest: digest,
      status: closure.status, severity: "INFO", generated_at: nowIso, week_closure: closure, source_readiness: sourceReadiness, freshness_history_recorded: freshnessRecorded,
      projection_calibration: skippedAll, start_sit: skippedAll, fi_weekly_calibration: skippedAll, matchup2: skippedAll, waiver2: skippedAll,
      role_changes: notApplicable("Phase 9 role-change audit reads current vs a persisted prior snapshot; not attempted for an incomplete week"),
      prior_current_disagreements: notApplicable("requires a completed week's evidence"), defense_shifts: notApplicable("requires a completed week's evidence"), offense_shifts: notApplicable("requires a completed week's evidence"),
      injury_opportunity: notApplicable("requires a completed week's evidence"),
      data_quality: dq, research_candidates: [], fi_recertification_progress: [], limitations: [s],
      lineage: { fi_version: fiLineage?.version ?? null, scoring_fingerprints: [], temporal_data_version: null, sources: ["nfl-reality-frontier", "football-intel"] },
    };
  }

  // ---- week is complete: fetch captures (read-only) --------------------------------------------------------
  const [ssRows, m2Rows, w2Rows] = rest
    ? await Promise.all([readStartSitCaptures(rest, input.season, input.week), readMatchup2Captures(rest, input.season, input.week), readWaiver2Captures(rest, input.season, input.week)])
    : [[], [], []];

  const ssCaptures = ssRows as unknown as StartSitCaptureRow[];
  const m2Captures = m2Rows as unknown as Matchup2CaptureRow[];
  const w2Captures = w2Rows as unknown as Waiver2CaptureRow[];
  for (const c of [...ssCaptures, ...m2Captures, ...w2Captures]) if (c.scoring_fingerprint) scoringFingerprints.add(c.scoring_fingerprint);

  const dqAll = runDataQualityChecks([...ssCaptures, ...m2Captures, ...w2Captures] as never, input.season, input.week, new Set(ssCaptures.filter((c) => c.capture_kind === "LIVE_CAPTURED").map((c) => c.capture_id)), now);
  dq.push(...dqAll.findings);
  const ssClean = ssCaptures.filter((c) => !dqAll.excludeIds.has(c.capture_id));
  const m2Clean = m2Captures.filter((c) => !dqAll.excludeIds.has(c.capture_id));
  const w2Clean = w2Captures.filter((c) => !dqAll.excludeIds.has(c.capture_id));

  const actuals = await loadWeekActuals(input.season, input.week).catch(() => null);
  let startSit: ComponentResult<{ decisions: ReturnType<typeof buildStartSitOutcomes>["decisions"]; calibration: ReturnType<typeof calibrateStartSit> }> = unavailable("no Start/Sit captures for this week");
  let projCal: ComponentResult<ProjectionCalibration> = unavailable("no Start/Sit captures for this week");
  const startSitOutcomeRows: ShadowOutcomeRecord[] = [];

  if (!actuals) {
    startSit = unavailable("actual weekly stats source unavailable");
    projCal = unavailable("actual weekly stats source unavailable");
  } else if (ssClean.length) {
    const { outcomeRows, decisions } = buildStartSitOutcomes(ssClean, actuals, input.rawScoringByFingerprint);
    startSitOutcomeRows.push(...outcomeRows);
    const contribByCapture = new Map(ssClean.map((c) => [c.capture_id, c.record.adjustments]));
    const kindOf = (id: string) => ssClean.find((c) => c.capture_id === id)?.capture_kind ?? "HISTORICALLY_RECONSTRUCTED";
    startSit = ready({ decisions, calibration: calibrateStartSit(decisions, kindOf, contribByCapture) });

    // Projection calibration (Step 22): reuses the SAME baseline_projection already captured per player — no separate projection snapshot is invented.
    const rows: ProjectionErrorRow[] = []; let excludedMissing = 0, excludedKdst = 0;
    for (const cap of ssClean) {
      const rawScoring = cap.scoring_fingerprint ? input.rawScoringByFingerprint.get(cap.scoring_fingerprint) : undefined;
      if (!rawScoring) continue;
      for (const a of cap.record.adjustments as unknown as Array<{ canonical_player_id: string; position: string; baseline_projection: number | null }>) {
        if (a.baseline_projection == null) { excludedMissing++; continue; }
        const outcome = startSitOutcomeRows.find((o) => o.capture_id === cap.capture_id)?.actual_fantasy_points[a.canonical_player_id];
        if (outcome == null) { excludedMissing++; continue; }
        if (a.position === "K" || a.position === "DEF") excludedKdst++; // K/DST is provider-standard-points, not comparable to a rescored baseline — excluded from calibration, never silently mixed in
        else rows.push({ canonical_player_id: a.canonical_player_id, position: a.position, signed_error: Math.round((outcome - a.baseline_projection) * 100) / 100, abs_error: Math.round(Math.abs(outcome - a.baseline_projection) * 100) / 100, baseline_version: "sleeper-weekly-rotowire", availability_status: null });
      }
    }
    const byPos: ProjectionCalibration["by_position"] = {};
    for (const pos of new Set(rows.map((r) => r.position))) { const es = errorStats(rows.filter((r) => r.position === pos).map((r) => ({ predicted: 0, actual: r.signed_error }))); if (es) byPos[pos] = { n: es.n, mae: es.mae, rmse: es.rmse, signed_bias: es.signed_bias }; }
    projCal = ready({ by_position: byPos, severe_misses: rows.filter((r) => r.abs_error >= SEVERE_MISS_POINTS).map((r) => ({ canonical_player_id: r.canonical_player_id, position: r.position, abs_error: r.abs_error })), severe_miss_threshold_points: SEVERE_MISS_POINTS, rows_evaluated: rows.length, rows_excluded_missing_actual: excludedMissing, rows_excluded_kdst_unsupported: excludedKdst });
  }

  // ---- Matchup2 ----------------------------------------------------------------------------------------------
  let matchup2Result: ComponentResult<{ captures_evaluated: number; outcomes_attached: number; by_family: ReturnType<typeof buildMatchup2Outcomes>["by_family"]; gate: unknown }> = unavailable("no Matchup2 captures for this week");
  const m2OutcomeRows: Matchup2Outcome[] = [];
  if (actuals && m2Clean.length) {
    const { outcomeRows, by_family } = buildMatchup2Outcomes(m2Clean, actuals, input.rawScoringByFingerprint, () => null);
    m2OutcomeRows.push(...outcomeRows);
    const gate = matchup2EvidenceGate(m2Clean as never, outcomeRows.map((o) => ({ capture_id: o.capture_id })));
    matchup2Result = ready({ captures_evaluated: m2Clean.length, outcomes_attached: outcomeRows.length, by_family, gate });
  }

  // ---- Waiver2 -----------------------------------------------------------------------------------------------
  let waiver2Result: ComponentResult<{ recommendations_evaluated: number; executed: number; not_executed: number; claimed_by_other_manager: number; market_findings: Array<{ capture_id: string; claim_result: string; winning_bid: number | null }>; performance_findings: Array<{ capture_id: string; realized_points_started: number | null; role_share_change: number | null }>; gate: unknown }> = unavailable("no Waiver2 captures for this week, or no transaction source available");
  const w2OutcomeRows: WaiverOutcome[] = [];
  if (w2Clean.length) {
    const findings = buildWaiver2Outcomes(w2Clean, new Map(), () => null); // transactions/roster-map are wired by the caller (cron/script) when available; empty map => every finding is UNKNOWN/NOT_SUBMITTED, never fabricated
    w2OutcomeRows.push(...findings.map((f) => f.outcome));
    const gate = waiver2EvidenceGate(w2Clean as never, findings.map((f) => ({ capture_id: f.outcome.capture_id })));
    waiver2Result = ready({ recommendations_evaluated: findings.length, executed: findings.filter((f) => f.executed).length, not_executed: findings.filter((f) => !f.executed && !f.claimed_by_other).length, claimed_by_other_manager: findings.filter((f) => f.claimed_by_other).length,
      market_findings: findings.map((f) => ({ capture_id: f.capture_id, claim_result: f.outcome.claim_result, winning_bid: f.outcome.winning_bid })),
      performance_findings: findings.map((f) => ({ capture_id: f.capture_id, realized_points_started: f.outcome.realized.candidate_points_started, role_share_change: f.outcome.realized.role_share_change })), gate });
    limitations.push("Waiver2 `realized.*` performance fields (points started, role-share change, roster survival) require multi-week roster tracking beyond a single completed week and are left null, never fabricated.");
  }

  // ---- Phase 8 FI retest monitoring (never promotes) ----------------------------------------------------------
  const cert = loadFiCertification();
  const reeval = loadReevaluationManifest(true);
  const qualifyingWeeks = reeval?.completed_fi_week_list.length ?? 0;
  const progress = fiRetestProgress(cert, qualifyingWeeks, new Map());

  // ---- write (only when WEEK_COMPLETE and explicitly requested) -----------------------------------------------
  if (canWrite && rest) {
    const [ssExisting, m2Existing, w2Existing] = await Promise.all([
      readStartSitOutcomes(rest, ssClean.map((c) => c.capture_id)), readMatchup2Outcomes(rest, m2Clean.map((c) => c.capture_id)), readWaiver2Outcomes(rest, w2Clean.map((c) => c.capture_id)),
    ]);
    void ssExisting; void m2Existing; void w2Existing; // insertIgnoreDuplicates itself is the idempotency guard; existing reads are for the write summary the caller may log
    if (startSitOutcomeRows.length) await writeStartSitOutcomes(rest, startSitOutcomeRows);
    if (m2OutcomeRows.length) await writeMatchup2Outcomes(rest, m2OutcomeRows);
    if (w2OutcomeRows.length) await writeWaiver2Outcomes(rest, w2OutcomeRows);
  }

  const missingOutcomes = startSit.status === "READY" && startSit.data!.decisions.some((d) => d.winner === "UNEVALUABLE");
  const status = missingOutcomes ? "WEEK_COMPLETE_WITH_MISSING_OUTCOMES" : "WEEK_COMPLETE";
  const severity = dq.some((f) => f.severity === "BLOCKING_DATA_QUALITY") ? "BLOCKING_DATA_QUALITY" : dq.some((f) => f.severity === "INVESTIGATE") ? "INVESTIGATE" : dq.length ? "WATCH" : "INFO";

  const digest = evidenceDigest({
    fi_version: fiLineage?.version ?? null, scoring_fingerprints: [...scoringFingerprints],
    startsit_capture_ids: ssClean.map((c) => c.capture_id), startsit_outcome_sources: startSitOutcomeRows.map((o) => o.source),
    matchup2_capture_ids: m2Clean.map((c) => c.capture_id), matchup2_outcome_sources: m2OutcomeRows.map((o) => o.source),
    waiver2_capture_ids: w2Clean.map((c) => c.capture_id), waiver2_outcome_sources: w2OutcomeRows.map((o) => o.source),
    certification_version: cert?.certification_version ?? null,
  });

  const audit: WeeklyModelAudit = {
    audit_id: auditId(input.season, input.week, digest), season: input.season, week: input.week, audit_schema_version: WEEKLY_AUDIT_SCHEMA_VERSION, evidence_digest: digest,
    status, severity, generated_at: nowIso, week_closure: closure, source_readiness: sourceReadiness, freshness_history_recorded: freshnessRecorded,
    projection_calibration: projCal, start_sit: startSit as never, fi_weekly_calibration: ready({ by_family_position: progress }), matchup2: matchup2Result, waiver2: waiver2Result,
    role_changes: notApplicable("Role-change audit needs a persisted prior-week Role snapshot; only the current Role profile is served today (see Phase 9 limitations)."),
    prior_current_disagreements: notApplicable("Requires a persisted history of prior-vs-current values across weeks; not yet accumulated."),
    defense_shifts: notApplicable("Requires a persisted week-over-week FI defense-profile history; only the current snapshot is served today."),
    offense_shifts: notApplicable("Requires a persisted week-over-week FI offense-profile history; only the current snapshot is served today."),
    injury_opportunity: notApplicable("Requires the Opportunity Propagation Intelligence output for this week joined to real injury-status transitions; not wired in this pass."),
    data_quality: dq, research_candidates: [], fi_recertification_progress: progress, limitations,
    lineage: { fi_version: fiLineage?.version ?? null, scoring_fingerprints: [...scoringFingerprints], temporal_data_version: null, sources: ["startsit-captures", "matchup2-captures", "waiver2 shadow captures", "sleeper-weekly-stats", "nfl-reality-frontier", "football-intel", "fi-certification"] },
  };

  if (canWrite && rest) await writeWeeklyModelAudit(rest, audit);
  return audit;
}
