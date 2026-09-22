/**
 * Phase 9 — Weekly Model Audit evidence, Book-Ready by construction. Reads the immutable, already-generated
 * `bridge_weekly_model_audit` record for one (season, week) and exposes it section by section. This is a READER
 * ONLY: it never runs `buildWeeklyModelAudit()` itself (that is the cron job's job) and it never writes anything.
 * A missing audit is UNAVAILABLE, never a fabricated "not yet run" guess dressed as data.
 */
import type { WeeklyModelAudit } from "@/lib/weekly-audit/contract";
import { unitFor } from "../units";
import { phaseRef } from "../phase-namespaces";
import type { Component, EvidenceBlock, TemporalIdentity } from "../schema";
import { PHASE7, mk as mkRaw } from "../common";

export const WEEKLY_AUDIT_SURFACE = "weekly-model-audit"; export const WEEKLY_AUDIT_TOPIC = "audit.weekly_model";
const BUILT_IN = phaseRef("INTELLIGENCE_MODERNIZATION_PHASE", "9");
const cat = (key: string, value: string | number, note?: string): Component => ({ key, value, unit: typeof value === "number" ? unitFor("audit.count") : unitFor("category"), ...(note ? { note } : {}) });

export function weeklyAuditEvidence(audit: WeeklyModelAudit | null, o: { section?: string } = {}): EvidenceBlock[] {
  const temporal: TemporalIdentity = { season: audit?.season ?? null, week: audit?.week ?? null, through_week: null, as_of: audit?.generated_at ?? null, generated_at: audit?.generated_at ?? null, source_cutoff: null, point_kind: "POINT_IN_TIME_STATE", as_of_kind: "PUBLISHED_STATE", week_state: audit?.week_closure.status === "WEEK_COMPLETE" ? "COMPLETE" : "PARTIAL", snapshot_id: audit?.audit_id ?? null, player_team_temporal_identity: PHASE7 };
  const base = { surface: WEEKLY_AUDIT_SURFACE, topic: WEEKLY_AUDIT_TOPIC, subject: { kind: "LEAGUE" as const, id: "weekly-model-audit", league_slug: "weekly-model-audit" }, deployment: { state: "SHARED_DESCRIPTIVE" as const, may_influence_production: false }, temporal,
    freshness: { as_of: audit?.generated_at ?? null, through_week: null, generated_at: audit?.generated_at ?? null },
    lineage: { surface_version: `wa:v${audit?.audit_schema_version ?? 1}`, content_identity: audit?.audit_id ?? "unavailable", canonical: { evidence_digest: audit?.evidence_digest ?? null, fi_version: audit?.lineage.fi_version ?? null }, depends_on: [] as EvidenceBlock["lineage"]["depends_on"] },
    source: { built_in: BUILT_IN, source_data: "bridge_weekly_model_audit (immutable, one row per season/week/evidence_digest), composed from Start/Sit, Matchup2, Waiver2 and FI evidence" },
    predictive: { source_status: "DESCRIPTIVE_ONLY", class: "DESCRIPTIVE_ONLY" as const }, origin: { source_class: "DERIVED_FROM_STATE", analysis_class: "DESCRIPTIVE" as const },
    limitations: ["Observational and evaluative only: nothing here can or does change a production recommendation, model weight, threshold or deployment state.", "A CERTIFICATION_FAILED Football Intelligence family stays failed regardless of this week's evidence; only a separate, explicit re-certification task can change that."] };
  if (!audit) return [mkRaw({ ...base, metric: "audit.status", availability: { state: "UNAVAILABLE", reason: "no weekly audit has been generated for this season/week yet" }, origin: { source_class: "UNAVAILABLE", analysis_class: "UNAVAILABLE" } } as never, ["status"])];

  const out: EvidenceBlock[] = [];
  out.push(mkRaw({ ...base, metric: "audit.status", availability: { state: "AVAILABLE" }, value: audit.status, unit: unitFor("category"), category: { raw: audit.status, normalized: audit.status, mapping_status: "VERIFIED" },
    components: [cat("severity", audit.severity), cat("week_closure_status", audit.week_closure.status, audit.week_closure.reason), cat("data_quality_findings", audit.data_quality.length), cat("freshness_history_recorded", String(audit.freshness_history_recorded))] } as never, ["status"]));

  if (o.section && o.section !== "status") {
    const sections: Record<string, () => void> = {
      projection_calibration: () => { const c = audit.projection_calibration; out.push(mkRaw({ ...base, metric: "audit.projection_calibration", availability: c.status === "READY" ? { state: "AVAILABLE" } : { state: "UNAVAILABLE", reason: c.detail ?? c.status }, ...(c.status === "READY" ? { value: c.data!.rows_evaluated, unit: unitFor("audit.count") } : {}), components: c.data ? Object.entries(c.data.by_position).map(([pos, s]) => cat(`mae.${pos}`, s.mae)) : [], limitations: base.limitations } as never, ["proj"])); },
      start_sit: () => { const c = audit.start_sit; out.push(mkRaw({ ...base, metric: "audit.start_sit_calibration", availability: c.status === "READY" ? { state: "AVAILABLE" } : { state: "UNAVAILABLE", reason: c.detail ?? c.status }, ...(c.status === "READY" ? { value: c.data!.calibration.decisions_evaluated, unit: unitFor("audit.count") } : {}), components: c.data ? [cat("reversals", c.data.calibration.reversals), cat("reversals_helped", c.data.calibration.reversals_helped), cat("reversals_hurt", c.data.calibration.reversals_hurt), cat("mean_baseline_regret", c.data.calibration.mean_baseline_regret ?? 0), cat("mean_fi_regret", c.data.calibration.mean_fi_regret ?? 0)] : [], limitations: base.limitations } as never, ["ss"])); },
      matchup2: () => { const c = audit.matchup2; out.push(mkRaw({ ...base, metric: "audit.matchup2", availability: c.status === "READY" ? { state: "AVAILABLE" } : { state: "UNAVAILABLE", reason: c.detail ?? c.status }, ...(c.status === "READY" ? { value: c.data!.captures_evaluated, unit: unitFor("audit.count") } : {}), components: c.data ? c.data.by_family.map((f) => cat(`family.${f.family}`, f.aligned, `${f.aligned}/${f.n} aligned`)) : [], limitations: base.limitations } as never, ["m2"])); },
      waiver2: () => { const c = audit.waiver2; out.push(mkRaw({ ...base, metric: "audit.waiver2", availability: c.status === "READY" ? { state: "AVAILABLE" } : { state: "UNAVAILABLE", reason: c.detail ?? c.status }, ...(c.status === "READY" ? { value: c.data!.recommendations_evaluated, unit: unitFor("audit.count") } : {}), components: c.data ? [cat("executed", c.data.executed), cat("not_executed", c.data.not_executed), cat("claimed_by_other_manager", c.data.claimed_by_other_manager)] : [], limitations: base.limitations } as never, ["w2"])); },
      fi_recertification: () => { for (const p of audit.fi_recertification_progress) out.push(mkRaw({ ...base, subject: { ...base.subject, id: `${p.position}:${p.family}` }, metric: "audit.fi_recertification_progress", availability: { state: "AVAILABLE" }, value: p.retest_signal, unit: unitFor("category"), category: { raw: p.retest_signal, normalized: p.retest_signal, mapping_status: "VERIFIED" }, components: [cat("certification_state", p.certification_state), cat("qualifying_weeks", p.qualifying_weeks), cat("required_weeks", p.required_weeks), cat("live_decisions", p.live_decisions), cat("required_decisions", p.required_decisions)], limitations: base.limitations } as never, ["fi", p.position, p.family])); },
      data_quality: () => { for (const f of audit.data_quality) out.push(mkRaw({ ...base, subject: { ...base.subject, id: f.scope }, metric: "audit.data_quality_finding", availability: { state: "AVAILABLE" }, value: f.code, unit: unitFor("category"), category: { raw: f.code, normalized: f.code, mapping_status: "VERIFIED" }, components: [cat("severity", f.severity), cat("rows_excluded", f.rows_excluded)], limitations: [...base.limitations, f.detail] } as never, ["dq", f.scope])); },
    };
    sections[o.section]?.();
    return out;
  }
  out.push(mkRaw({ ...base, metric: "audit.limitations", availability: { state: "AVAILABLE" }, value: audit.limitations.length, unit: unitFor("audit.count"), components: audit.limitations.map((l, i) => cat(`limitation.${i}`, l)), limitations: base.limitations } as never, ["lims"]));
  return out;
}
