/**
 * Phase 8 — Football Intelligence CERTIFICATION evidence, Book-Ready by construction. For each evaluated feature family x position it states the
 * ACTUAL lifecycle state (never "low confidence"), the chronology-safe out-of-sample improvement over the production-like baseline with its
 * uncertainty, decision regret, calibration, why it failed (which pre-registered gate), whether the 2025 holdout was opened, the prospective
 * evidence status, and the rollback contract. Descriptive only; nothing here can influence a recommendation.
 */
import { loadFiCertification, type FiCertificationCandidate } from "@/lib/weekly/start-sit-fi/certification";
import { unitFor } from "../units";
import { phaseRef } from "../phase-namespaces";
import type { Component, EvidenceBlock, TemporalIdentity } from "../schema";
import { PHASE7, mk as mkRaw } from "../common";

export const FI_CERTIFICATION_SURFACE = "fi-recertification"; export const FI_CERTIFICATION_TOPIC = "fi.certification";
const BUILT_IN = phaseRef("INTELLIGENCE_MODERNIZATION_PHASE", "8");
const ROLLBACK = "config-only: remove the family from deployment_contract.family_positions (or set it back to SHADOW_ONLY). No data migration; the production baseline path is unchanged and returns the exact baseline when any gate is off.";
const cat = (key: string, value: string | number, note?: string): Component => ({ key, value, unit: typeof value === "number" ? unitFor("fi.cert.count") : unitFor("category"), ...(note ? { note } : {}) });

export function fiCertificationEvidence(o: { family?: string; position?: string } = {}): EvidenceBlock[] {
  const cert = loadFiCertification();
  const temporal: TemporalIdentity = { season: 2026, week: null, through_week: null, as_of: null, generated_at: null, source_cutoff: null, point_kind: "CUMULATIVE", as_of_kind: "RETROSPECTIVE_RECONSTRUCTION", week_state: null, snapshot_id: null, player_team_temporal_identity: PHASE7 };
  const id = cert ? `${cert.certification_version}|${cert.criteria_version}` : "unavailable";
  const base = { surface: FI_CERTIFICATION_SURFACE, topic: FI_CERTIFICATION_TOPIC, subject: { kind: "LEAGUE" as const, id: "football-intelligence-start-sit", league_slug: "football-intelligence-start-sit" }, deployment: { state: "SHADOW_ONLY" as const, may_influence_production: false }, temporal,
    freshness: { as_of: null, through_week: null, generated_at: null }, lineage: { surface_version: cert?.certification_version ?? null, content_identity: id, canonical: { criteria_version: cert?.criteria_version ?? null, lane: cert?.lane ?? null, baseline: cert?.baseline.primary ?? null }, depends_on: [] as EvidenceBlock["lineage"]["depends_on"] },
    source: { built_in: BUILT_IN, source_data: "analysis/football_intel_phase8 walk-forward evaluation over the as-of decision dataset (2021-2025), pre-registered criteria, holdout sealed" },
    predictive: { source_status: "DESCRIPTIVE_ONLY", class: "DESCRIPTIVE_ONLY" as const }, origin: { source_class: "DERIVED_FROM_STATE", analysis_class: "DESCRIPTIVE" as const },
    limitations: ["Certification evidence is RECONSTRUCTED_CHRONOLOGY_SAFE against a RECONSTRUCTED_PRODUCTION_LIKE baseline (Sleeper weekly projection history) — not TRUE_AS_OF and not the historical production output.", "Consumer scope is START_SIT only; a state here says nothing about Waivers, Trades, Matchup, FAAB or roster valuation.", "A CERTIFICATION_FAILED family stays SHADOW_ONLY in production; it can be re-tested only with new evidence."] };
  if (!cert) return [mkRaw({ ...base, metric: "certification.summary", availability: { state: "UNAVAILABLE", reason: "fi_certification_2026.1.json not present" }, origin: { source_class: "UNAVAILABLE", analysis_class: "UNAVAILABLE" } } as never, ["summary"])];
  const cs = cert.candidates.filter((c) => (!o.family || c.family === o.family) && (!o.position || c.position === o.position));
  const out: EvidenceBlock[] = [];
  const stateBlock = (c: FiCertificationCandidate) => mkRaw({ ...base, subject: { ...base.subject, id: `${c.position}:${c.family}` }, metric: "certification.state", availability: { state: "AVAILABLE" }, value: String(c.evaluated_state), unit: unitFor("category"), category: { raw: String(c.evaluated_state), normalized: String(c.evaluated_state), mapping_status: "VERIFIED" },
    components: [cat("start_state", c.start_state), cat("verdict_reason", c.verdict_reason), cat("failed_gates", c.failed_gates.join(", ") || "none"), cat("production_state", c.production_state), cat("holdout", c.holdout.opened ? "opened" : "sealed (not opened)", c.holdout.reason)],
    limitations: [...base.limitations, `Highest state reachable from historical evidence alone: ${c.highest_state_reachable_from_evidence}. PRODUCTION_ELIGIBLE additionally needs the prospective gate (>= ${c.prospective.required_weeks} qualifying 2026 weeks and >= ${c.prospective.required_decisions} live-captured decisions; currently ${c.prospective.qualifying_weeks} / ${c.prospective.live_captured_decisions}).`] } as never, ["state", c.position, c.family]);
  if (!o.family && !o.position) {
    out.push(mkRaw({ ...base, metric: "certification.summary", availability: { state: "AVAILABLE" }, value: cert.candidates.length, unit: unitFor("fi.cert.count"),
      components: [...Object.entries(cert.summary).map(([k, v]) => cat(`state.${k}`, v)), cat("holdout", cert.holdout_opened ? "opened" : "sealed (no candidate passed development)"), cat("criteria_version", cert.criteria_version), cat("lane", cert.lane), cat("baseline_primary", cert.baseline.primary),
        cat("baseline_mae_primary", Number(cert.baseline.integrity.mae_sleeper.toFixed(3)), "fantasy-point MAE of the production-like baseline (dev seasons)"), cat("baseline_mae_naive", Number(cert.baseline.integrity.mae_trailing.toFixed(3)), "fantasy-point MAE of the naive trailing control (context only)")],
      limitations: [...base.limitations, "No family earned PRODUCTION_ELIGIBLE; production Start/Sit is unchanged and FI remains SHADOW_ONLY."] } as never, ["summary"]));
    for (const c of cs) out.push(stateBlock(c));
    for (const n of cert.not_evaluated) out.push(mkRaw({ ...base, subject: { ...base.subject, id: `not-evaluated:${n.family}` }, metric: "certification.not_evaluated", availability: { state: "AVAILABLE" }, value: n.state, unit: unitFor("category"), category: { raw: n.state, normalized: n.state, mapping_status: "VERIFIED" }, components: [cat("family", n.family), cat("reason", n.reason)], limitations: base.limitations } as never, ["ne", n.family]));
    return out;
  }
  for (const c of cs) {
    const sub = { ...base.subject, id: `${c.position}:${c.family}` }; const B = { ...base, subject: sub };
    out.push(stateBlock(c));
    out.push(mkRaw({ ...B, metric: "certification.mae_improvement", availability: { state: "AVAILABLE" }, value: c.mae_improvement, unit: unitFor("fi.cert.points"), components: [cat("ci90_lower", c.mae_improvement_ci90[0]), cat("ci90_upper", c.mae_improvement_ci90[1]), cat("baseline_mae", c.mae_baseline), cat("candidate_mae", c.mae_candidate), cat("bh_q", c.bh_q, "Benjamini-Hochberg q across 30 tests"), cat("minimum_effect", 0.03, "pre-registered")], limitations: [...base.limitations, "positive = the family made the baseline more accurate; the pre-registered minimum meaningful effect is +0.03 fantasy points."] } as never, ["mae", c.position, c.family]));
    if (c.decision) out.push(mkRaw({ ...B, metric: "certification.decision_regret", availability: { state: "AVAILABLE" }, value: c.decision.mean_regret_improvement_per_pair, unit: unitFor("fi.cert.points"), components: [cat("tau", c.tau ?? "n/a"), cat("reversals", c.decision.reversals), cat("reversal_win_rate", c.decision.reversal_win_rate ?? "n/a"), cat("ci90_lower", c.decision.lo), cat("ci90_upper", c.decision.hi), cat("severe_miss_rate", c.decision.severe_miss_rate ?? "n/a"), cat("large_win_rate", c.decision.large_win_rate ?? "n/a"), cat("pct_reversals_improved", c.decision.pct_reversals_improved ?? "n/a"), cat("pct_reversals_worsened", c.decision.pct_reversals_worsened ?? "n/a")], limitations: [...base.limitations, "regret improvement = actual points of the FI pick minus the baseline pick, averaged over close-call pairs (|baseline edge| < tau)."] } as never, ["regret", c.position, c.family]));
    else out.push(mkRaw({ ...B, metric: "certification.decision_regret", availability: { state: "UNAVAILABLE", reason: "fewer than 100 close-call reversals: the family barely moves any decision" }, origin: { source_class: "UNAVAILABLE", analysis_class: "UNAVAILABLE" } } as never, ["regret", c.position, c.family]));
    out.push(mkRaw({ ...B, metric: "certification.calibration", availability: c.calibration.slope == null ? { state: "UNAVAILABLE", reason: "adjustment has no variance" } : { state: "AVAILABLE" }, ...(c.calibration.slope == null ? { origin: { source_class: "UNAVAILABLE", analysis_class: "UNAVAILABLE" } } : { value: c.calibration.slope, unit: unitFor("fi.cert.ratio") }), components: [cat("ci90_lower", c.calibration.lo ?? "n/a"), cat("ci90_upper", c.calibration.hi ?? "n/a"), cat("quintile_spearman", c.calibration.spearman ?? "n/a"), cat("required_slope_range", "0.5 to 1.5 with CI lower bound > 0")], limitations: [...base.limitations, "slope of realised residual on predicted adjustment; ~1 means the adjustment magnitude is empirically meaningful."] } as never, ["calib", c.position, c.family]));
    out.push(mkRaw({ ...B, metric: "certification.rollback_contract", availability: { state: "AVAILABLE" }, value: "CONFIG_ONLY_NO_MIGRATION", unit: unitFor("category"), category: { raw: "CONFIG_ONLY_NO_MIGRATION", normalized: "CONFIG_ONLY_NO_MIGRATION", mapping_status: "VERIFIED" }, components: [cat("contract", ROLLBACK)], limitations: base.limitations } as never, ["rollback", c.position, c.family]));
  }
  return out;
}
