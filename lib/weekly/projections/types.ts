/**
 * ProjectionProvider — the seam the weekly analytics depend on.
 *
 * Analytics NEVER import a concrete projection source. They ask a
 * `ProjectionProvider` for a `WeeklyProjectionBatch` of canonical-player-keyed
 * projections in a league's scoring. If no source can serve a week, the batch
 * is `PROJECTIONS_UNAVAILABLE` — projections are `null`, never 0.
 */

import type { PlayerCrosswalk } from "@/lib/canonical/players";
import type { CanonicalLeague } from "@/lib/canonical/schema";
import type { WeeklyProjection, WeeklyProjectionBatch } from "../schema";

export interface ProjectionRequest {
  league: Pick<CanonicalLeague, "league_slug" | "season" | "raw_scoring" | "scoring_rules">;
  week: number;
  /** Resolve provider player ids -> canonical ids consistently with the rest of the app. */
  crosswalk: PlayerCrosswalk;
  /** Canonical player ids the caller needs a projection for (roster + candidate pool). */
  canonical_player_ids: string[];
  /** Include a rest-of-season points estimate when the source supports one. */
  want_rest_of_season?: boolean;
}

export interface ProjectionProvider {
  readonly name: string;
  readonly model_version: string;
  /** Weekly projections for the requested players, in the league's scoring. */
  getWeeklyProjections(req: ProjectionRequest): Promise<WeeklyProjectionBatch>;
}

export type { WeeklyProjection, WeeklyProjectionBatch };
