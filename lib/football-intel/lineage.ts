/**
 * Football Intelligence — the ONE canonical translation from a loaded FI
 * snapshot into the shared `FootballIntelligenceLineage` shape
 * (`lib/canonical/lineage.ts`). No consumer should read
 * `loadFootballIntelligence().manifest` and hand-assemble this shape itself
 * -- that would create as many slightly-different ideas of "FI identity" as
 * there are call sites, exactly the failure mode Intelligence Modernization
 * Phase 1 exists to prevent.
 *
 * Pure: takes an already-loaded `FootballIntelligence | null` (or omit the
 * argument to load the current published snapshot). Never fabricates a
 * field -- `week_completion` is `null` when the manifest predates it, and
 * the whole result is `null` when no snapshot is loaded/published at all.
 */

import { loadFootballIntelligence, type FootballIntelligence } from "./read";
import type { FootballIntelligenceLineage } from "@/lib/canonical/lineage";

export function buildFootballIntelligenceLineage(
  fi?: FootballIntelligence | null,
): FootballIntelligenceLineage | null {
  const source = fi === undefined ? loadFootballIntelligence() : fi;
  if (!source) return null;
  const m = source.manifest;
  return {
    version: m.football_intelligence_version,
    model_tag: m.model_tag,
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
    data_cutoff: { ...m.data_cutoff },
    output_classes: [...m.output_classes],
    generated_at: m.generated_at,
  };
}
