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
import { resolveSeasonLeagueId } from "@/lib/analytics/season-resolution";
import { buildWeekMatchupFacts } from "@/lib/analytics/matchups";
import { buildMetadata } from "@/lib/analytics/types";
import {
  parseLeagueSelector,
  parseRosterId,
  parseSeason,
  parseWeek,
} from "@/lib/analytics/query";
import {
  cacheHeader,
  errorResponse,
  handleOptions,
  jsonResponse,
} from "@/lib/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;

  try {
    const leagueSelectorResult = parseLeagueSelector(params.get("league"));
    if ("error" in leagueSelectorResult) {
      return errorResponse(
        400,
        "invalid_query_parameter",
        leagueSelectorResult.error,
      );
    }
    const leagueId = resolveLeagueId(leagueSelectorResult.value);

    const nflState = await getNflState().catch(() => null);
    const currentSeason =
      nflState?.season ?? new Date().getFullYear().toString();
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
      return errorResponse(
        400,
        "invalid_query_parameter",
        rosterIdResult.error,
      );
    }

    const season = seasonResult.value;
    const week = weekResult.value ?? currentWeek;

    const resolution = await resolveSeasonLeagueId(leagueId, season, currentSeason);
    if (!resolution.ok) {
      return errorResponse(
        resolution.status,
        resolution.status === 404 ? "season_not_found" : "sleeper_upstream_error",
        resolution.error,
      );
    }
    const { league: resolvedLeague, isCurrentSeason, warnings: lineageWarnings } = resolution.result;
    const targetLeagueId = resolvedLeague.league_id;
    if (resolvedLeague.season !== season) {
      return errorResponse(
        502,
        "season_mismatch",
        `Resolved league ${targetLeagueId} reports season ${resolvedLeague.season}, not the requested ${season}.`,
      );
    }
    const revalidate = isCurrentSeason ? 60 : 24 * 60 * 60;
    const warnings: string[] = [...lineageWarnings];

    const [rosters, users, rawMatchups] = await Promise.all([
      getLeagueRosters(targetLeagueId, { revalidate }),
      getLeagueUsers(targetLeagueId, { revalidate }),
      getMatchups(targetLeagueId, week, { revalidate }),
    ]);
    const usersById = new Map(users.map((u) => [u.user_id, u]));

    let matchups = buildWeekMatchupFacts(
      season,
      week,
      rawMatchups,
      rosters,
      usersById,
    );
    if (rosterIdResult.value !== null) {
      const rosterId = rosterIdResult.value;
      matchups = matchups.filter((m) => m.team.roster_id === rosterId);
    }

    if (rawMatchups.length === 0) {
      warnings.push(
        `No matchup data is available for week ${week} of ${season} yet.`,
      );
    }

    const metadata = buildMetadata({
      league_id: targetLeagueId,
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
