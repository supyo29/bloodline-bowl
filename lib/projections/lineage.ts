/**
 * Projection lineage for the SEASON model (`ri-structural-2026.3`).
 *
 * Emitted on every season-projection response so a consumer never has to infer
 * "which model produced this number" from unrelated fields. Distinct from the
 * weekly provider's lineage (`sleeper-weekly-rotowire`) — the two are never
 * merged.
 */

import type { ProjectionLineageEntry } from "@/lib/canonical/lineage";
import { PROJECTION_MODEL_VERSION } from "./schema";

export function seasonProjectionLineage(
  generatedAt: string,
  scoringFingerprint: string | null,
): ProjectionLineageEntry[] {
  return [
    {
      role: "season_ordinal",
      source: "roster_intel_season",
      model_version: PROJECTION_MODEL_VERSION,
      generated_at: generatedAt,
      scoring_fingerprint: scoringFingerprint,
      status: "READY",
    },
  ];
}
