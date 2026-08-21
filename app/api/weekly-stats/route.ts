/**
 * GET /api/weekly-stats — raw NFL weekly stats scored through Bloodline
 * Bowl's own scoring engine, with documented ranks.
 *
 * Query: ?season=2026 ?week=4 ?position=WR ?player_id=...
 */

import {
  SleeperError,
  getLeague,
  getNflState,
  getPlayerIndex,
} from "@/lib/sleeper/client";
import { resolveLeagueId } from "@/lib/sleeper/service";
import { draftablePositions } from "@/lib/sleeper/draft";
import { getStatsProvider } from "@/lib/stats/provider";
import { buildWeeklyPlayerFacts } from "@/lib/analytics/weekly-stats";
import { resolveSeasonLeagueId } from "@/lib/analytics/season-resolution";
import { buildMetadata } from "@/lib/analytics/types";
import {
  parseLeagueSelector,
  parsePlayerId,
  parsePosition,
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
    const defaultLeagueId = resolveLeagueId(leagueSelectorResult.value);

    const defaultLeague = await getLeague(defaultLeagueId);
    const nflState = await getNflState().catch(() => null);
    const currentSeason = nflState?.season ?? defaultLeague.season;
    const currentWeek = nflState?.week && nflState.week > 0 ? nflState.week : 1;

    const seasonResult = parseSeason(params.get("season"), currentSeason);
    if ("error" in seasonResult) {
      return errorResponse(400, "invalid_query_parameter", seasonResult.error);
    }
    const weekResult = parseWeek(params.get("week"));
    if ("error" in weekResult) {
      return errorResponse(400, "invalid_query_parameter", weekResult.error);
    }

    const season = seasonResult.value;

    // Resolve to the ACTUAL league_id for the requested season, so a
    // historical request never scores using the current season's settings —
    // this was previously a real bug: /api/weekly-stats always used
    // `defaultLeagueId`'s scoring_settings regardless of `season`.
    const resolution = await resolveSeasonLeagueId(
      defaultLeagueId,
      season,
      currentSeason,
      defaultLeague,
    );
    if (!resolution.ok) {
      return errorResponse(
        resolution.status,
        resolution.status === 404 ? "season_not_found" : "sleeper_upstream_error",
        resolution.error,
      );
    }
    const { league, isCurrentSeason: resolvedIsCurrentSeason } = resolution.result;
    const leagueId = league.league_id;
    if (league.season !== season) {
      return errorResponse(
        502,
        "season_mismatch",
        `Resolved league ${leagueId} reports season ${league.season}, not the requested ${season}.`,
      );
    }

    const allowedPositions = draftablePositions(league.roster_positions ?? []);
    const positionResult = parsePosition(
      params.get("position"),
      allowedPositions,
    );
    if ("error" in positionResult) {
      return errorResponse(
        400,
        "invalid_query_parameter",
        positionResult.error,
      );
    }
    const playerIdResult = parsePlayerId(params.get("player_id"));
    if ("error" in playerIdResult) {
      return errorResponse(
        400,
        "invalid_query_parameter",
        playerIdResult.error,
      );
    }

    const week = weekResult.value ?? currentWeek;
    const isHistoricalWeek =
      !resolvedIsCurrentSeason || (season === currentSeason && week < currentWeek);

    const provider = getStatsProvider();
    if (!provider.isAvailable()) {
      return jsonResponse(
        {
          season,
          week,
          players: [],
          metadata: buildMetadata({
            league_id: leagueId,
            season,
            sources: [{ name: provider.name, type: "nfl_statistics" }],
            warnings: [
              provider.unavailableReason() ?? "Stats provider unavailable.",
            ],
          }),
        },
        { headers: { "Cache-Control": "no-store" } },
      );
    }

    const [statLines, playerIndex] = await Promise.all([
      provider.getWeeklyStats(season, week),
      getPlayerIndex(),
    ]);

    const { facts, methodology } = buildWeeklyPlayerFacts(
      statLines,
      league.scoring_settings ?? {},
      playerIndex,
    );

    let filtered = facts;
    if (positionResult.value !== null) {
      const wanted = positionResult.value;
      filtered = filtered.filter((f) =>
        f.player.fantasy_positions.includes(wanted),
      );
    }
    if (playerIdResult.value !== null) {
      filtered = filtered.filter(
        (f) => f.player.player_id === playerIdResult.value,
      );
    }

    const warnings: string[] = [];
    if (statLines.length === 0) {
      warnings.push(
        `No weekly stats are available for ${season} week ${week} yet (the games may not have been played).`,
      );
    }

    const metadata = buildMetadata({
      league_id: leagueId,
      season,
      sources: [{ name: provider.name, type: "nfl_statistics" }],
      data_freshness: { weekly_stats: isHistoricalWeek ? "24h" : "5m" },
      warnings,
    });

    return jsonResponse(
      { season, week, methodology, players: filtered, metadata },
      {
        headers: {
          "Cache-Control": isHistoricalWeek
            ? cacheHeader(3600, 86400)
            : cacheHeader(300, 900),
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
