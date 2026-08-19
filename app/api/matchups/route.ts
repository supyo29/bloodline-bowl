/**
 * GET /api/matchups — factual weekly matchup results, including a weekly
 * score rank. No "fortunate"/"unfortunate" labeling — just the numbers.
 *
 * Query: ?season=2026 ?week=3 ?roster_id=2
 */

import {
  SleeperError,
  getLeagueRosters,
  getLeagueUsers,
  getMatchups,
  getNflState,
} from "@/lib/sleeper/client";
import { resolveLeagueId } from "@/lib/sleeper/service";
import { traverseLeagueLineage } from "@/lib/analytics/lineage";
import { buildWeekMatchupFacts } from "@/lib/analytics/matchups";
import { buildMetadata } from "@/lib/analytics/types";
import { parseRosterId, parseSeason, parseWeek } from "@/lib/analytics/query";
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
    const currentWeek = nflState?.week && nflState.week > 0 ? nflState.week : 1;

    const seasonResult = parseSeason(params.get("season"), currentSeason);
    if ("error" in seasonResult) {
      return errorResponse(400, "invalid_query_parameter", seasonResult.error);
    }
    const weekResult = parseWeek(params.get("week"));
    if ("error" in weekResult) {
      return errorResponse(400, "invalid_query_parameter", weekResult.error);
    }
    const rosterIdResult = parseRosterId(params.get("roster_id"));
    if ("error" in rosterIdResult) {
      return errorResponse(400, "invalid_query_parameter", rosterIdResult.error);
    }

    const season = seasonResult.value;
    const isCurrentSeason = season === currentSeason;
    const revalidate = isCurrentSeason ? 60 : 24 * 60 * 60;
    const week = weekResult.value ?? currentWeek;

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

    const [rosters, users, rawMatchups] = await Promise.all([
      getLeagueRosters(targetLeagueId, { revalidate }),
      getLeagueUsers(targetLeagueId, { revalidate }),
      getMatchups(targetLeagueId, week, { revalidate }),
    ]);
    const usersById = new Map(users.map((u) => [u.user_id, u]));

    let matchups = buildWeekMatchupFacts(season, week, rawMatchups, rosters, usersById);
    if (rosterIdResult.value !== null) {
      const rosterId = rosterIdResult.value;
      matchups = matchups.filter((m) => m.team.roster_id === rosterId);
    }

    if (rawMatchups.length === 0) {
      warnings.push(`No matchup data is available for week ${week} of ${season} yet.`);
    }

    const metadata = buildMetadata({
      league_id: leagueId,
      season,
      sources: [{ name: "Sleeper", type: "matchup_data" }],
      data_freshness: { matchups: isCurrentSeason ? "1m" : "24h" },
      warnings,
    });

    return jsonResponse(
      { week, matchups, metadata },
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
