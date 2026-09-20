/** Phase 3.5C — Opportunity Propagation evidence. CONDITIONAL scenario output only — never an unconditional projection. */
import { evaluateOpportunityPropagationScenario } from "@/lib/opportunity-propagation-intelligence/scenario";
import { loadOpportunityPropagationModel } from "@/lib/opportunity-propagation-intelligence/read";
import { buildOpportunityPropagationIntelligenceLineage } from "@/lib/opportunity-propagation-intelligence/lineage";
import { loadRoleOpportunitySnapshot } from "@/lib/player-role-intelligence/read";
import { analysisClassFor, confidenceFor, sampleSupportFor } from "../vocabulary";
import { classifyIdentity } from "../identity";
import { unitFor } from "../units";
import { phaseRef } from "../phase-namespaces";
import type { Component, EvidenceBlock, TemporalIdentity } from "../schema";
import { PHASE7, refreshLag, mk, notAvailable, type QueryContext } from "../common";

const SURFACE = "opportunity-propagation";
const BUILT_IN = phaseRef("INTELLIGENCE_MODERNIZATION_PHASE", "3");
const DEPLOYMENT = { state: "SHADOW_ONLY", may_influence_production: false } as const;

export interface OppQuery { team: string; season: number; week: number; unavailable_player_ids: string[]; candidate_player_ids?: string[] }

export function opportunityScenarioEvidence(q: OppQuery, _ctx: QueryContext): EvidenceBlock[] {
  const model = loadOpportunityPropagationModel(); const role = loadRoleOpportunitySnapshot();
  const subject = { kind: "MATCHUP" as const, id: `${q.team.toUpperCase()}|w${q.week}|absent:${[...q.unavailable_player_ids].sort().join("+")}`, team: q.team.toUpperCase() };
  const m = model?.manifest;
  const canonical = model ? buildOpportunityPropagationIntelligenceLineage(model) : null;
  const temporal: TemporalIdentity = { season: q.season, week: q.week, through_week: m?.through_week ?? null, as_of: m?.generated_at ?? null, generated_at: m?.generated_at ?? null, source_cutoff: null, point_kind: "SCENARIO", as_of_kind: "SCENARIO_INPUT", week_state: null, snapshot_id: null, player_team_temporal_identity: PHASE7 };
  const base = { surface: SURFACE, topic: "opp.scenario", subject, deployment: DEPLOYMENT, freshness: { as_of: m?.generated_at ?? null, through_week: m?.through_week ?? null, generated_at: m?.generated_at ?? null, refresh_lag_weeks: refreshLag(m?.through_week ?? null) }, temporal, lineage: { surface_version: m?.opportunity_propagation_version ?? null, canonical, depends_on: [{ surface: "role-opportunity", version: m?.role_opportunity_dependency.role_opportunity_version ?? null }] }, source: { artifact: "lib/opportunity-propagation-intelligence/data/*", built_in: BUILT_IN, source_data: "Phase 2 role vectors + 2019-2025 qualified full-game nonparticipation episodes" }, limitations: [] as string[] };
  const res = model && role ? evaluateOpportunityPropagationScenario({ team: q.team.toUpperCase(), season: q.season, week: q.week, unavailable_player_ids: q.unavailable_player_ids, scenario_type: "FULL_GAME_NONPARTICIPATION", ...(q.candidate_player_ids ? { candidate_player_ids: q.candidate_player_ids } : {}) }) : null;
  if (!res) return [notAvailable({ ...base, metric: "*" }, "UNAVAILABLE", "Opportunity Propagation or Role snapshot is not published")];
  if (!res.beneficiaries) return [notAvailable({ ...base, metric: "*", limitations: [res.scenario.support_note] }, "UNAVAILABLE", `scenario unsupported: ${res.scenario.support_note}`, "UNSUPPORTED")];

  const conditional = [{ type: "CONDITIONAL_ON" as const, target: { surface: SURFACE, note: `IF ${q.unavailable_player_ids.join(", ")} is unavailable for the full game — a consumer-supplied scenario, NOT a probability of that absence` } }, { type: "DEPENDS_ON" as const, target: { surface: "role-opportunity", version: res.role_opportunity_version } }];
  const scenarioLims = [`CONDITIONAL scenario: ${res.scenario.support_note}`, "availability_scenario_source is CONSUMER_SUPPLIED; this layer does not estimate the probability that any player is unavailable", ...(res.scenario.support_level !== "CALIBRATED" ? [`support level ${res.scenario.support_level}: degraded/experimental — never calibrated`] : []), "no calibrated uncertainty interval exists (uncertainty_ranges_supported=false); evidence_count and historical_error only"];
  const out: EvidenceBlock[] = [];
  for (const b of res.beneficiaries) {
    const unit = unitFor("opp.role_share");
    const components: Component[] = [
      { key: "observed_pre_scenario_role", label: "Phase 2 observed role (unchanged)", value: b.observed_pre_scenario_role, unit, analysis_class: analysisClassFor("OPP", "PHASE2_OBSERVED_PRE_ROLE"), source_class: "PHASE2_OBSERVED_PRE_ROLE" },
      { key: "expected_delta", value: b.expected_delta, unit: unitFor("role.delta") },
      { key: "inheritance_rate", value: b.evidence.inheritance_rate, unit: unitFor("opp.inheritance_rate"), note: `source ${b.evidence.source}` },
      { key: "pre_event_share_weight", value: b.trace.pre_event_share_weight }, { key: "trend_multiplier", value: b.trace.trend_multiplier }, { key: "position_affinity_multiplier", value: b.trace.position_affinity_multiplier }, { key: "normalized_weight", value: b.trace.normalized_weight },
    ];
    out.push(mk({ ...base, metric: `${b.domain}.${b.dimension}.expected_scenario_role`, subject: { ...subject, id: `${subject.id}|${b.beneficiary_gsis_id}` }, availability: { state: "AVAILABLE" }, value: b.expected_scenario_role, unit,
      origin: { source_class: "CONDITIONAL_SCENARIO", analysis_class: analysisClassFor("OPP", "CONDITIONAL_SCENARIO") },
      model_confidence: confidenceFor("OPP", b.confidence), sample_support: sampleSupportFor("opp.evidence_count", undefined, b.evidence.evidence_count),
      predictive: { source_status: "RESEARCH_ONLY", class: "RESEARCH_ONLY" }, components, relationships: conditional, limitations: scenarioLims,
      history: { class: "UNSUPPORTED", points: [], note: "conditional scenario results are not an observed weekly series; re-evaluating a scenario against a prior Role snapshot is not implemented (the snapshots preserve the inputs that would make it possible)" },
      chart: [{ form: "bar", x: "components.key", y: "components.value", group: "beneficiary" }],
    }, [b.absent_player_id, b.beneficiary_gsis_id, b.domain, b.dimension]));
  }
  for (const v of res.vacated_role ?? []) out.push(mk({ ...base, metric: `${v.domain}.${v.dimension}.vacated_opportunity`, subject: { ...subject, id: `${subject.id}|vacated:${v.absent_player_id}` }, availability: v.vacated_opportunity === null ? { state: "UNAVAILABLE", reason: "absent player has no observed value in this dimension" } : { state: "AVAILABLE" }, ...(v.vacated_opportunity === null ? {} : { value: v.vacated_opportunity, unit: unitFor("opp.vacated_opportunity") }), origin: { source_class: "CONDITIONAL_SCENARIO", analysis_class: "CONDITIONAL" }, predictive: { source_status: "RESEARCH_ONLY", class: "RESEARCH_ONLY" }, relationships: conditional, limitations: scenarioLims }, [v.absent_player_id, v.domain, v.dimension]));
  for (const r of res.residual ?? []) out.push(mk({ ...base, metric: `${r.domain}.${r.dimension}.structural_residual`, subject: { ...subject, id: `${subject.id}|residual:${r.absent_player_id}` }, availability: { state: "AVAILABLE" }, value: r.structural_residual, unit: unitFor("opp.vacated_opportunity"), origin: { source_class: "CONDITIONAL_SCENARIO", analysis_class: "CONDITIONAL" }, predictive: { source_status: "RESEARCH_ONLY", class: "RESEARCH_ONLY" }, relationships: conditional, limitations: [...scenarioLims, "vacated opportunity NOT identified with any candidate beneficiary (residual/unallocated)"] }, [r.absent_player_id, r.domain, r.dimension]));
  return out;
}
export const __identityForTests = classifyIdentity;
