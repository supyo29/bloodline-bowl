/**
 * Injury -> Opportunity Propagation Intelligence — the ONE canonical
 * translation from a loaded model into the shared
 * `OpportunityPropagationIntelligenceLineage` shape
 * (`lib/canonical/lineage.ts`). Mirrors `lib/player-role-intelligence/
 * lineage.ts`'s `buildRoleOpportunityIntelligenceLineage()` exactly -- no
 * consumer should hand-assemble this shape from a loaded model's manifest
 * itself.
 */

import { loadOpportunityPropagationModel } from "./read";
import type { OpportunityPropagationIntelligenceLineage } from "@/lib/canonical/lineage";
import type { ScenarioSupportLevel, OpportunityPropagationModel } from "./schema";

export function buildOpportunityPropagationIntelligenceLineage(
  model?: OpportunityPropagationModel | null,
  scenarioSupport: ScenarioSupportLevel = "CALIBRATED",
): OpportunityPropagationIntelligenceLineage | null {
  const source = model === undefined ? loadOpportunityPropagationModel() : model;
  if (!source) return null;
  const m = source.manifest;
  return {
    version: m.opportunity_propagation_version,
    model_tag: m.model_tag,
    schema_version: m.schema_version,
    season: m.season,
    through_week: m.through_week,
    generated_at: m.generated_at,
    role_opportunity_version: m.role_opportunity_dependency.role_opportunity_version,
    scenario_support: scenarioSupport,
  };
}
