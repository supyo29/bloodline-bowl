/**
 * GET /api/standings — factual standings plus straightforward derived weekly
 * statistics (average, median, standard deviation, high/low counts). No luck
 * modeling, no power rankings, no strength grades.
 *
 * Query: ?season=2026
 */

import { SleeperError, getNflState } from "@/lib/sleeper/client";
import { resolveLeagueId } from "@/lib/sleeper/service";
import { traverseLeagueLineage } from "@/lib/analytics/lineage";
import { allWeeks, loadSeasonData } from "@/lib/analytics/season-data";
import { assignRegularSeasonFinish, computeStandings } from "@/lib/analytics/standings";
import { buildMetadata } from "@/lib/analytics/types";
import { parseSeason } from "@/lib/analytics/query";
import { cacheHeader, errorResponse, handleOptions, jsonResponse } from "@/lib/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(request: Request): Promise<Response> {
  const leagueId = resolveLeagueId();
  const params = new URL(request.url).searchParams;

  try {
    const nflState = await getNflState().catch(() => null);
    const currentSeason = nflState?.season ?? new Date().getFullYear().toString();

    const seasonResult = parseSeason(params.get("season"), currentSeason);
    if ("error" in seasonResult) {
      return errorResponse(400, "invalid_query_parameter", seasonResult.error);
    }
    const season = seasonResult.value;
    const isCurrentSeason = season === currentSeason;
    const revalidate = isCurrentSeason ? 60 : 24 * 60 * 60;

    let targetLeagueId = leagueId;
    const warnings: string[] = [];
    if (!isCurrentSeason) {
      const lineage = await traverseLeagueLineage(leagueId);
      warnings.push(...lineage.warnings);
      const match = lineage.seasons.find((entry) => entry.league.season === season);
      if (!match) {
        return errorResponse(
          404,
          "season_not_found",
          `No linked season ${season} was found in this league's history.`,
        );
      }
      targetLeagueId = match.league.league_id;
    }

    const seasonData = await loadSeasonData(targetLeagueId, {
      revalidate,
      weeks: allWeeks(),
    });
    warnings.push(...seasonData.warnings);

    const standings = assignRegularSeasonFinish(
      computeStandings(
        seasonData.rosters,
        seasonData.users,
        seasonData.matchupsByWeek,
        seasonData.winnersBracket,
      ),
    );

    if (standings.every((s) => s.games_played === 0)) {
      warnings.push(`No games have been played yet in ${season}; all records are 0-0-0.`);
    }

    const metadata = buildMetadata({
      league_id: leagueId,
      season,
      sources: [{ name: "Sleeper", type: "league_data" }],
      data_freshness: { standings: isCurrentSeason ? "1m" : "24h" },
      warnings,
    });

    return jsonResponse(
      { standings, metadata },
      {
        headers: {
          "Cache-Control": isCurrentSeason
            ? cacheHeader(60, 300)
            : cacheHeader(3600, 86400),
        },
      },
    );
  } catch (error) {
    if (error instanceof SleeperError) {
      return errorResponse(502, "sleeper_upstream_error", error.message);
    }
    return errorResponse(
      500,
      "internal_error",
      error instanceof Error ? error.message : "Unknown error",
    );
  }
}

export async function OPTIONS(): Promise<Response> {
  return handleOptions();
}
