/**
 * Trust / debug view (System Trust Audit §13, §14).
 *
 * Assembles a machine-readable evidence trace from an `OrchestratorResult` +
 * its `ManagementAnalysisContext`, answering: **which models contributed to
 * this answer, in what role, and with what production authority?**
 *
 * AUDIT-ONLY. This is a read of state the Orchestrator already produced — it
 * runs no model, changes no output, exposes no secret. It is surfaced through
 * `?include_trace=1` on the manager endpoint.
 */

import type { ManagementAnalysisContext } from "./context";
import type { OrchestratorResult, SpecialistUsage } from "./schema";

export type UtilizationRole =
  | "USED_FOR_ACTION"
  | "USED_AS_CONTEXT"
  | "SHADOW_CONTEXT_ONLY"
  | "NOT_USED"
  | "FAILED"
  | "UNAVAILABLE";

export interface ComponentTrace {
  component: string;
  model_version: string | null;
  used: boolean;
  role: UtilizationRole;
  production_influence: boolean;
  reason: string;
}

export interface EvidenceStep {
  originating_component: string;
  component_version: string | null;
  utilization_role: UtilizationRole;
  source_metric: string;
  source_value: string | number | boolean | null;
  horizon: string | null;
  confidence: string | null;
  degradation: string[] | null;
  reason_code: string | null;
}

export interface OrchestratorTrace {
  league_snapshot_id: string | null;
  scoring_fingerprint: string | null;
  manager_slug: string;
  orchestrator_version: string;
  orchestrator_deployment: string;
  verdict: string;
  /** which models contributed to THIS answer. */
  components: Record<string, ComponentTrace>;
  /** per-condition provenance chain. */
  condition_traces: Array<{ code: string; disposition: string; materiality: string; urgency: string; steps: EvidenceStep[] }>;
  /** per-action provenance chain (primary + secondary + suppressed). */
  action_traces: Array<{
    action_class: string;
    role: "PRIMARY" | "SECONDARY" | "SUPPRESSED";
    target_condition: string;
    originating_specialist: string;
    expected_effect: { value: number | null; unit: string; source: string } | null;
    urgency: string;
    confidence: string;
    cost_band: string;
    reason_codes: string[];
    suppression_reasons: string[];
    steps: EvidenceStep[];
  }>;
  /** the shared-context assembly health. */
  assembly: {
    canonical_provider_reads: number;
    snapshot_ids_seen: string[];
    snapshot_coherent: boolean;
    stage_ms: Record<string, number>;
    missing_specialists: string[];
  };
  /** forbidden-influence assertion for this result — shadow evidence never drove an action. */
  forbidden_influence_ok: boolean;
}

const PRODUCTION_INFLUENCE: Record<string, boolean> = {
  canonical: true,
  team_state: false, // structural facts, not a recommendation score
  weekly_engine: true,
  football_intelligence: false,
  start_sit_shadow: false,
  matchup_shadow: false,
  roster_health: false,
  schedule_planning: false,
  strategy: false,
};

function roleReason(role: SpecialistUsage, comp: string): string {
  switch (role) {
    case "USED_FOR_ACTION":
      return "produced a concrete remedy that became a surfaced action";
    case "USED_AS_CONTEXT":
      return "supplied condition / materiality / urgency evidence, not a remedy";
    case "SHADOW_CONTEXT_ONLY":
      return "SHADOW_ONLY — surfaced as a diagnostic / WATCH item; architecturally barred from driving an ACTION";
    case "NOT_USED":
      return comp === "start_sit_shadow" || comp === "matchup_shadow" ? "no shadow disagreement worth surfacing this run" : "not relevant to this manager this run";
    case "UNAVAILABLE":
      return "specialist unavailable / failed to build for this request";
    default:
      return "";
  }
}

function toRole(u: SpecialistUsage): UtilizationRole {
  return u as UtilizationRole;
}

export function buildOrchestratorTrace(mac: ManagementAnalysisContext, result: OrchestratorResult): OrchestratorTrace {
  const components: Record<string, ComponentTrace> = {};
  for (const [name, s] of Object.entries(result.lineage.specialists)) {
    components[name] = {
      component: name,
      model_version: s.version,
      used: s.usage === "USED_FOR_ACTION" || s.usage === "USED_AS_CONTEXT" || s.usage === "SHADOW_CONTEXT_ONLY",
      role: toRole(s.usage),
      production_influence: (PRODUCTION_INFLUENCE[name] ?? false) && (s.usage === "USED_FOR_ACTION"),
      reason: roleReason(s.usage, name),
    };
  }

  const compVersion = (specialist: string): string | null => {
    const map: Record<string, string> = {
      lineup: "weekly_engine",
      start_sit: "weekly_engine",
      matchup: "weekly_engine",
      waiver: "weekly_engine",
      team_state: "team_state",
      roster_health: "roster_health",
      schedule_planning: "schedule_planning",
      strategy: "strategy",
      start_sit_shadow: "start_sit_shadow",
      matchup_shadow: "matchup_shadow",
      aggregate: "orchestrator",
    };
    const key = map[specialist] ?? specialist;
    if (key === "orchestrator") return result.orchestrator_version;
    return components[key]?.model_version ?? null;
  };
  const compRole = (specialist: string): UtilizationRole => {
    const map: Record<string, string> = { lineup: "weekly_engine", start_sit: "weekly_engine", matchup: "weekly_engine", waiver: "weekly_engine" };
    const key = map[specialist] ?? specialist;
    if (specialist === "start_sit_shadow" || specialist === "matchup_shadow") return "SHADOW_CONTEXT_ONLY";
    return (components[key]?.role ?? "USED_AS_CONTEXT") as UtilizationRole;
  };

  const stepFrom = (specialist: string, fact: string, data: Record<string, unknown>): EvidenceStep => {
    const metricKey = Object.keys(data)[0] ?? fact;
    return {
      originating_component: specialist,
      component_version: compVersion(specialist),
      utilization_role: compRole(specialist),
      source_metric: metricKey,
      source_value: (data[metricKey] as string | number | boolean | null) ?? null,
      horizon: null,
      confidence: null,
      degradation: null,
      reason_code: null,
    };
  };

  const condition_traces = result.current_conditions.concat(result.future_watch_items).map((c) => ({
    code: c.code,
    disposition: c.disposition,
    materiality: c.materiality,
    urgency: c.urgency,
    steps: c.evidence.map((e) => {
      const s = stepFrom(e.specialist, e.fact, e.data);
      s.horizon = c.horizon;
      s.reason_code = c.suppression_reasons[0] ?? null;
      return s;
    }),
  }));

  const traceAction = (a: OrchestratorResult["primary_action"], role: "PRIMARY" | "SECONDARY" | "SUPPRESSED", suppression: string[] = []) => {
    if (!a) return null;
    return {
      action_class: a.action_class,
      role,
      target_condition: a.target_condition,
      originating_specialist: a.originating_specialist,
      expected_effect: a.dimensions.expected_weekly_effect
        ? { value: a.dimensions.expected_weekly_effect.value, unit: a.dimensions.expected_weekly_effect.unit, source: a.dimensions.expected_weekly_effect.source }
        : null,
      urgency: a.dimensions.urgency,
      confidence: a.dimensions.confidence,
      cost_band: a.dimensions.cost.band,
      reason_codes: a.reason_codes,
      suppression_reasons: suppression,
      steps: a.explanation_chain.map((e) => {
        const s = stepFrom(e.specialist, e.fact, e.data);
        s.confidence = a.dimensions.confidence;
        s.horizon = a.dimensions.expected_weekly_effect?.horizon ?? null;
        return s;
      }),
    };
  };

  const action_traces = [
    traceAction(result.primary_action, "PRIMARY"),
    ...result.secondary_actions.map((a) => traceAction(a, "SECONDARY")),
    ...result.suppressed_actions.map((s) => traceAction(s.action, "SUPPRESSED", s.reasons)),
  ].filter((x): x is NonNullable<typeof x> => x !== null);

  // forbidden-influence assertion: no surfaced action rests solely on shadow evidence
  const forbidden_influence_ok = [result.primary_action, ...result.secondary_actions].filter(Boolean).every((a) => {
    const sources = new Set(a!.explanation_chain.map((e) => e.specialist));
    sources.add(a!.originating_specialist);
    return [...sources].some((s) => s !== "start_sit_shadow" && s !== "matchup_shadow");
  });

  return {
    league_snapshot_id: result.lineage.league_snapshot_id,
    scoring_fingerprint: result.lineage.scoring_fingerprint,
    manager_slug: result.manager_slug,
    orchestrator_version: result.orchestrator_version,
    orchestrator_deployment: result.lineage.deployment,
    verdict: result.verdict,
    components,
    condition_traces,
    action_traces,
    assembly: {
      canonical_provider_reads: mac.metrics.canonical_provider_reads,
      snapshot_ids_seen: mac.metrics.snapshot_ids_seen,
      snapshot_coherent: mac.metrics.snapshot_coherent,
      stage_ms: mac.metrics.ms,
      missing_specialists: result.degradation.missing_specialists,
    },
    forbidden_influence_ok,
  };
}
