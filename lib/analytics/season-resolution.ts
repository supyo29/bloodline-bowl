/**
 * Resolves a requested `?season=` to the actual Sleeper `league_id` that
 * season lived under.
 *
 * Sleeper issues a new `league_id` every season and links backward via
 * `previous_league_id`, so "give me 2025 data for this league" means walking
 * that chain to find the season whose `league.season === "2025"` — the
 * current league id is only correct for the current season. Using the
 * current-season league id to fetch a historical season's data would silently
 * apply that season's scoring settings/roster shape to historical stats,
 * which is exactly the contamination this bridge must not produce.
 *
 * This was previously duplicated (with slightly different shapes) inline in
 * `/api/matchups` and `/api/transactions`; both now share this one
 * implementation, and it backs the new historical scoring/lineup endpoints.
 */

import { traverseLeagueLineage } from "./lineage";
import type { RawLeague } from "@/lib/sleeper/types";

export interface SeasonResolutionResult {
  league: RawLeague;
  /** True when the resolved league is the caller's default/current one. */
  isCurrentSeason: boolean;
  warnings: string[];
}

export type SeasonResolutionOutcome =
  | { ok: true; result: SeasonResolutionResult }
  | { ok: false; error: string; status: 404 | 502 };

/**
 * @param defaultLeagueId The league id `resolveLeagueId()` returned for the
 *   caller's `?league=` selector — used directly when `season` matches the
 *   current season, so the common case makes no extra Sleeper calls.
 * @param season The requested season, e.g. "2025".
 * @param currentSeason The live current season (from `/state/nfl` or the
 *   default league's own `.season`), used to decide whether a lineage walk is
 *   even necessary.
 */
export async function resolveSeasonLeagueId(
  defaultLeagueId: string,
  season: string,
  currentSeason: string,
  currentLeague?: RawLeague,
): Promise<SeasonResolutionOutcome> {
  if (season === currentSeason && currentLeague) {
    return {
      ok: true,
      result: { league: currentLeague, isCurrentSeason: true, warnings: [] },
    };
  }

  const lineage = await traverseLeagueLineage(defaultLeagueId);
  if (lineage.seasons.length === 0) {
    return {
      ok: false,
      error: `Could not walk this league's season history: ${lineage.warnings.join(" ")}`,
      status: 502,
    };
  }

  const match = lineage.seasons.find((entry) => entry.league.season === season);
  if (!match) {
    const known = lineage.seasons.map((entry) => entry.league.season).join(", ");
    return {
      ok: false,
      error: `No linked season "${season}" was found in this league's history. Known seasons: ${known}.`,
      status: 404,
    };
  }

  return {
    ok: true,
    result: {
      league: match.league,
      isCurrentSeason: match.league.season === currentSeason,
      warnings: lineage.warnings,
    },
  };
}
