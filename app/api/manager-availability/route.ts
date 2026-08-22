/**
 * GET /api/manager-availability — per-manager factual availability counts,
 * built on top of /api/player-availability's evidence. Descriptive only: no
 * injury-response scoring, no "good/bad manager" judgment — see
 * lib/analytics/manager-availability.ts.
 *
 * Query: ?league=devoted-to-the-game&season=2025[&week=4]
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
import {
  AVAILABILITY_FIELD_SUPPORT,
  buildAvailabilityRecords,
} from "@/lib/analytics/historical-availability";
import { summarizeManagerAvailability } from "@/lib/analytics/manager-availability";
import { getStatsProvider } from "@/lib/stats/provider";
import { buildMetadata } from "@/lib/analytics/types";
import { parseLeagueSelector, parseSeason, parseWeek } from "@/lib/analytics/query";
import { cacheHeader, errorResponse, handleOptions, jsonResponse } from "@/lib/http";
import type { PlayerStatLine } from "@/lib/stats/types";
import type { RawMatchup } from "@/lib/sleeper/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_WEEK = 18;

function describeError(error: unknown): string {
  return error instanceof SleeperError || error instanceof Error
    ? error.message
    : String(error);
}

export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;

  const leagueSelectorResult = parseLeagueSelector(params.get("league"));
  if ("error" in leagueSelectorResult) {
    return errorResponse(400, "invalid_query_parameter", leagueSelectorResult.error);
  }
  const leagueSelector = params.get("league") ?? "bloodline-bowl";
  const defaultLeagueId = resolveLeagueId(leagueSelectorResult.value);

  const weekResult = parseWeek(params.get("week"));
  if ("error" in weekResult) {
    return errorResponse(400, "invalid_query_parameter", weekResult.error);
  }

  try {
    const nflState = await getNflState().catch(() => null);
    const currentSeason = nflState?.season ?? new Date().getFullYear().toString();

    const seasonResult = parseSeason(params.get("season"), currentSeason);
    if ("error" in seasonResult) {
      return errorResponse(400, "invalid_query_parameter", seasonResult.error);
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
    const weeks =
      weekResult.value !== null
        ? [weekResult.value]
        : Array.from({ length: MAX_WEEK }, (_, i) => i + 1);

    const warnings: string[] = [...lineageWarnings];
    const playerIndex = await getPlayerIndex();
    const provider = getStatsProvider();

    const [rosters, users] = await Promise.all([
      getLeagueRosters(leagueId, { revalidate }).catch((error) => {
        warnings.push(`Could not load rosters: ${describeError(error)}`);
        return [];
      }),
      getLeagueUsers(leagueId, { revalidate }).catch((error) => {
        warnings.push(`Could not load users: ${describeError(error)}`);
        return [];
      }),
    ]);

    const matchupsByWeek = new Map<number, RawMatchup[]>();
    const statsByWeek = new Map<number, PlayerStatLine[]>();

    await Promise.all(
      weeks.map(async (week) => {
        try {
          matchupsByWeek.set(week, await getMatchups(leagueId, week, { revalidate }));
        } catch (error) {
          warnings.push(`Could not load week ${week} matchups: ${describeError(error)}`);
          matchupsByWeek.set(week, []);
        }
        if (provider.isAvailable()) {
          try {
            statsByWeek.set(week, await provider.getWeeklyStats(season, week));
          } catch (error) {
            warnings.push(`Could not load raw stats for week ${week}: ${describeError(error)}`);
            statsByWeek.set(week, []);
          }
        } else {
          statsByWeek.set(week, []);
        }
      }),
    );

    const weeksWithData = weeks.filter((w) => (matchupsByWeek.get(w)?.length ?? 0) > 0);

    const { records, coverage } = buildAvailabilityRecords({
      leagueSelector,
      leagueId,
      season,
      weeks: weeksWithData,
      matchupsByWeek,
      statsByWeek,
      rosters,
      users,
      rosterPositions: league.roster_positions ?? [],
      playerIndex,
    });

    const { managers, notes } = summarizeManagerAvailability(records, rosters, users);

    const metadata = buildMetadata({
      league_id: leagueId,
      season,
      sources: [
        { name: "Sleeper", type: "nfl_weekly_stats" },
        { name: "Sleeper", type: "matchup_lineups" },
        { name: "Sleeper", type: "rosters_snapshot" },
      ],
      data_freshness: {
        manager_availability: isCurrentSeason ? "1m" : "24h (historical, immutable)",
      },
      warnings: [...warnings, ...notes],
    });

    return jsonResponse(
      {
        league_selector: leagueSelector,
        league_id: leagueId,
        season,
        weeks: weeksWithData,
        coverage: { ...coverage, field_support: AVAILABILITY_FIELD_SUPPORT },
        managers,
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
