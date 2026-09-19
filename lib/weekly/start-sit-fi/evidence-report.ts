/**
 * Phase 3.5A -- research/diagnostic evidence report for the Start/Sit FI shadow model.
 *
 * Read-only. Never trains, never promotes, never reports OUTCOME metrics for samples whose
 * outcomes are not complete, and never blends evidence classes: every count is keyed by
 * capture class.
 */
import { loadStartSitModel } from "./translate";
import { fiMayInfluenceProduction, anyFiProductionInfluence, deploymentContract } from "./deployment";
import { loadReevaluationManifest } from "./reevaluation";
import { getShadowCaptureStore, getCaptureHealth, emptySummary, type CaptureSummary } from "./capture";
import { installDefaultCaptureStore } from "./capture-runtime";

export const EVIDENCE_REPORT_VERSION = "startsit-evidence-report-2026.1";

export async function buildStartSitEvidenceReport() {
  installDefaultCaptureStore();
  const model = loadStartSitModel();
  const manifest = loadReevaluationManifest(true);
  const store = getShadowCaptureStore();
  const capture: CaptureSummary = store.summary
    ? await store.summary().catch((e) => emptySummary(store.kind, store.durable, false, e instanceof Error ? e.message : String(e)))
    : emptySummary(store.kind, store.durable, false, "store has no summary()");
  const positions = ["QB", "RB", "WR", "TE"];
  return {
    report_version: EVIDENCE_REPORT_VERSION,
    generated_at: new Date().toISOString(),
    scope: "RESEARCH/DIAGNOSTIC ONLY -- no outcome metrics are reported; nothing here changes deployment state.",
    model: {
      version: model?.start_sit_model_version ?? null,
      deployment: deploymentContract(model).deployment,
      fi_may_influence_production: Object.fromEntries(positions.map((p) => [p, fiMayInfluenceProduction(model, p)])),
      any_fi_production_influence: anyFiProductionInfluence(model),
      football_intelligence_version_trained_on: model?.football_intelligence_version ?? null,
    },
    evidence_gate: manifest && {
      gate_version: manifest.evidence_gate_version ?? "LEGACY(untrusted)",
      status: manifest.reevaluation_status,
      qualifying_weeks: manifest.completed_fi_week_list,
      minimum_weeks: manifest.minimum_weeks_required,
      preferred_weeks: manifest.preferred_weeks,
      reason: manifest.not_eligible_reason,
      rejected_weeks: manifest.rejected_weeks ?? [],
      nfl_reality: manifest.nfl_reality ?? null,
      manifest_generated_at: manifest.generated_at,
    },
    capture_store: {
      kind: store.kind,
      durable: store.durable,
      summary_available: capture.available,
      error: capture.error ?? null,
      process_health: getCaptureHealth(),
    },
    evidence_by_class: {
      totals_by_kind: capture.totals_by_kind,
      live_captured_by_week: capture.live_captured_by_week,
      by_week_kind: capture.by_week_kind,
      by_model_version: capture.by_model_version,
      by_fi_version: capture.by_fi_version,
      by_scoring_fingerprint: capture.by_scoring_fingerprint,
      /** valid pre-kickoff evidence only (LIVE_CAPTURED). */
      per_position_valid_live: capture.by_position,
      outcomes_attached: capture.outcomes_attached,
    },
    outcome_metrics: "WITHHELD -- reported only once a class has complete actuals AND passes the evidence gate",
  };
}

/** The slim file the R evidence gate reads (`outputs/startsit-2026/shadow_capture_summary.json`). */
export function gateSummary(report: Awaited<ReturnType<typeof buildStartSitEvidenceReport>>) {
  const t = report.evidence_by_class.totals_by_kind;
  return {
    available: report.capture_store.summary_available && report.capture_store.durable,
    store_kind: report.capture_store.kind,
    generated_at: report.generated_at,
    live_captured_by_week: report.evidence_by_class.live_captured_by_week,
    live_captured_total: t.LIVE_CAPTURED ?? 0,
    post_lock_total: t.LIVE_POST_LOCK ?? 0,
    unverified_total: t.LIVE_UNVERIFIED ?? 0,
    reconstructed_total: t.HISTORICALLY_RECONSTRUCTED ?? 0,
  };
}
