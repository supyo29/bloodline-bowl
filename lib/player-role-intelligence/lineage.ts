/**
 * Role & Opportunity Intelligence — the ONE canonical translation from a
 * loaded snapshot into the shared `RoleOpportunityIntelligenceLineage` shape
 * (`lib/canonical/lineage.ts`). Mirrors `lib/football-intel/lineage.ts`'s
 * `buildFootballIntelligenceLineage()` exactly -- no consumer should
 * hand-assemble this shape from `loadRoleOpportunitySnapshot().manifest`
 * itself.
 *
 * Pure: takes an already-loaded `RoleOpportunitySnapshot | null` (or omit
 * the argument to load the current published snapshot). Never fabricates a
 * field -- the whole result is `null` when no snapshot is published at all.
 */

import { loadRoleOpportunitySnapshot, type RoleOpportunitySnapshot } from "./read";
import type { RoleOpportunityIntelligenceLineage } from "@/lib/canonical/lineage";

export function buildRoleOpportunityIntelligenceLineage(
  snapshot?: RoleOpportunitySnapshot | null,
): RoleOpportunityIntelligenceLineage | null {
  const source = snapshot === undefined ? loadRoleOpportunitySnapshot() : snapshot;
  if (!source) return null;
  const m = source.manifest;
  return {
    version: m.role_opportunity_version,
    model_tag: m.role_opportunity_model_tag,
    feature_schema_version: m.feature_schema_version,
    season: m.season,
    through_week: m.through_week,
    week_completion: m.week_completion
      ? {
          latest_week: m.week_completion.latest_week,
          week_state: m.week_completion.week_state,
          games_completed_in_latest_week: m.week_completion.games_completed_in_latest_week,
          games_scheduled_in_latest_week: m.week_completion.games_scheduled_in_latest_week,
          latest_completed_game_date: m.week_completion.latest_completed_game_date,
        }
      : null,
    data_cutoff: { ...m.source_cutoffs },
    substrate_schema_version: m.substrate_schema_version,
    generated_at: m.generated_at,
  };
}
