/**
 * GET /api/lineups — historical (or current) weekly roster ownership and
 * starter snapshots, one row per roster-player-week. See
 * lib/analytics/historical-lineups.ts for slot-mapping methodology.
 *
 * Query: ?league=devoted-to-the-game&season=2025[&week=4]
 *
 * `season` is required and validated against this league's actual lineage,
 * exactly like `/api/player-weekly` — never a silent fallback to the current
 * season's roster shape.
 */

import {
  SleeperError,
  getLeagueRosters,
  getLeagueUsers,
  getMatchups,
  getNflState,
  getPlayerIndex,
} from "@/lib/sleeper/client";
import { resolveLeagueId } from "@/lib/sleeper/service";
import { resolveSeasonLeagueId } from "@/lib/analytics/season-resolution";
import { buildLineupRows } from "@/lib/analytics/historical-lineups";
import { buildMetadata } from "@/lib/analytics/types";
import { parseLeagueSelector, parseSeason, parseWeek } from "@/lib/analytics/query";
import { cacheHeader, errorResponse, handleOptions, jsonResponse } from "@/lib/http";
import type { RawMatchup } from "@/lib/sleeper/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_WEEK = 18;

function describeError(error: unknown): string {
  return error instanceof SleeperError || error instanceof Error ? error.message : String(error);
}

export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;

  const leagueSelectorResult = parseLeagueSelector(params.get("league"));
  if ("error" in leagueSelectorResult) {
    return errorResponse(400, "invalid_query_parameter", leagueSelectorResult.error);
  }
  const leagueSelector = params.get("league") ?? "bloodline-bowl";
  const defaultLeagueId = resolveLeagueId(leagueSelectorResult.value);

  try {
    const nflState = await getNflState().catch(() => null);
    const currentSeason = nflState?.season ?? new Date().getFullYear().toString();

    const seasonResult = parseSeason(params.get("season"), currentSeason);
    if ("error" in seasonResult) {
      return errorResponse(400, "invalid_query_parameter", seasonResult.error);
    }
    const weekResult = parseWeek(params.get("week"));
    if ("error" in weekResult) {
      return errorResponse(400, "invalid_query_parameter", weekResult.error);
    }
    const season = seasonResult.value;

    const resolution = await resolveSeasonLeagueId(defaultLeagueId, season, currentSeason);
    if (!resolution.ok) {
      return errorResponse(
        resolution.status,
        resolution.status === 404 ? "season_not_found" : "sleeper_upstream_error",
        resolution.error,
      );
    }
    const { league, isCurrentSeason, warnings: lineageWarnings } = resolution.result;
    const leagueId = league.league_id;
    if (league.season !== season) {
      return errorResponse(
        502,
        "season_mismatch",
        `Resolved league ${leagueId} reports season ${league.season}, not the requested ${season}.`,
      );
    }

    const revalidate = isCurrentSeason ? 60 : 24 * 60 * 60;
    const weeks = weekResult.value !== null ? [weekResult.value] : Array.from({ length: MAX_WEEK }, (_, i) => i + 1);
    const rosterPositions = league.roster_positions ?? [];

    const warnings: string[] = [...lineageWarnings];
    const [rosters, users, playerIndex] = await Promise.all([
      getLeagueRosters(leagueId, { revalidate }),
      getLeagueUsers(leagueId, { revalidate }),
      getPlayerIndex(),
    ]);

    const missingWeeks: number[] = [];
    const rosterCountByWeek: Record<number, number> = {};
    const allRows = [];
    const unresolvedAll = new Set<string>();
    let weeksReturned: number[] = [];

    for (const week of weeks) {
      let matchups: RawMatchup[] = [];
      try {
        matchups = await getMatchups(leagueId, week, { revalidate });
      } catch (error) {
        missingWeeks.push(week);
        warnings.push(`Could not load week ${week} matchups: ${describeError(error)}`);
        continue;
      }
      if (matchups.length === 0) {
        missingWeeks.push(week);
        continue;
      }

      rosterCountByWeek[week] = new Set(matchups.map((m) => m.roster_id)).size;

      const { rows, unresolvedPlayerIds } = buildLineupRows({
        leagueSelector,
        leagueId,
        season,
        week,
        matchups,
        rosters,
        users,
        rosterPositions,
        playerIndex,
      });
      allRows.push(...rows);
      for (const id of unresolvedPlayerIds) unresolvedAll.add(id);
    }

    weeksReturned = weeks.filter((w) => rosterCountByWeek[w] !== undefined);

    const metadata = buildMetadata({
      league_id: leagueId,
      season,
      sources: [{ name: "Sleeper", type: "matchup_roster_snapshot" }],
      data_freshness: { lineups: isCurrentSeason ? "1m" : "24h (historical, immutable)" },
      warnings,
    });

    return jsonResponse(
      {
        league_selector: leagueSelector,
        league_id: leagueId,
        season,
        weeks_returned: weeksReturned,
        missing_weeks: missingWeeks,
        roster_count_by_week: rosterCountByWeek,
        row_count: allRows.length,
        unresolved_players: [...unresolvedAll].sort(),
        starter_source: "sleeper_matchup_starters_array",
        roster_source: "sleeper_matchup_players_array",
        lineups: allRows,
        metadata: { ...metadata, cache_seconds: isCurrentSeason ? 60 : 86400 },
      },
      {
        headers: {
          "Cache-Control": isCurrentSeason ? cacheHeader(60, 300) : cacheHeader(86400, 172800),
        },
      },
    );
  } catch (error) {
    if (error instanceof SleeperError) {
      return errorResponse(502, "sleeper_upstream_error", error.message);
    }
    return errorResponse(500, "internal_error", error instanceof Error ? error.message : "Unknown error");
  }
}

export async function OPTIONS(): Promise<Response> {
  return handleOptions();
}
