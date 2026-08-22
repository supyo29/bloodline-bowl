/**
 * GET /api/player-availability — historical (or current) weekly player
 * availability evidence: was this player actually available to their fantasy
 * manager, and what does Sleeper's own data actually support saying about
 * why not. See lib/analytics/historical-availability.ts for the full source
 * audit, classification logic, and confidence semantics.
 *
 * Query: ?league=devoted-to-the-game&season=2025[&week=4][&player_id=...]
 *        [&manager_id=...][&roster_id=...]
 *
 * `season` is required and validated against this league's actual lineage —
 * exactly the same historical-resolution contract as /api/player-weekly and
 * /api/lineups. Requesting a season this league never had returns 404, never
 * a silent fallback to the current season.
 *
 * IMPORTANT: this endpoint does not, and will never, report historical
 * injury designations, official inactive lists, or practice statuses —
 * Sleeper's public API has no historical archive for any of those. A zero
 * fantasy score is not evidence of injury. A missed game without
 * authoritative status evidence is not automatically an injury. See
 * `coverage.field_support` on every response for exactly which evidence
 * dimensions are available, partial, or unsupported.
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
import { getStatsProvider } from "@/lib/stats/provider";
import { buildMetadata } from "@/lib/analytics/types";
import {
  parseLeagueSelector,
  parseRosterId,
  parseSeason,
  parseUserId,
  parseWeek,
  parsePlayerId,
} from "@/lib/analytics/query";
import {
  cacheHeader,
  errorResponse,
  handleOptions,
  jsonResponse,
} from "@/lib/http";
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
  const playerIdResult = parsePlayerId(params.get("player_id"));
  if ("error" in playerIdResult) {
    return errorResponse(400, "invalid_query_parameter", playerIdResult.error);
  }
  const managerIdResult = parseUserId(params.get("manager_id"));
  if ("error" in managerIdResult) {
    return errorResponse(400, "invalid_query_parameter", managerIdResult.error);
  }
  const rosterIdResult = parseRosterId(params.get("roster_id"));
  if ("error" in rosterIdResult) {
    return errorResponse(400, "invalid_query_parameter", rosterIdResult.error);
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
    const missingWeeks: number[] = [];

    await Promise.all(
      weeks.map(async (week) => {
        try {
          const rows = await getMatchups(leagueId, week, { revalidate });
          if (rows.length === 0) missingWeeks.push(week);
          matchupsByWeek.set(week, rows);
        } catch (error) {
          missingWeeks.push(week);
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

    const { records, coverage, unresolvedPlayerIds } = buildAvailabilityRecords({
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

    let filtered = records;
    if (playerIdResult.value !== null) {
      filtered = filtered.filter((r) => r.player_id === playerIdResult.value);
    }
    if (managerIdResult.value !== null) {
      filtered = filtered.filter((r) => r.manager_id === managerIdResult.value);
    }
    if (rosterIdResult.value !== null) {
      filtered = filtered.filter((r) => r.roster_id === rosterIdResult.value);
    }

    const metadata = buildMetadata({
      league_id: leagueId,
      season,
      sources: [
        { name: "Sleeper", type: "nfl_weekly_stats" },
        { name: "Sleeper", type: "matchup_lineups" },
        { name: "Sleeper", type: "rosters_snapshot" },
      ],
      data_freshness: {
        player_availability: isCurrentSeason ? "1m" : "24h (historical, immutable)",
      },
      warnings,
    });

    return jsonResponse(
      {
        league_selector: leagueSelector,
        league_id: leagueId,
        season,
        weeks: weeksWithData,
        missing_weeks: missingWeeks,
        source_summary: {
          participation_evidence: "sleeper_weekly_stats (gp, gms_active)",
          bye_week_evidence: "sleeper_weekly_stats (team-defense gp rows)",
          roster_context_evidence: "sleeper_matchups + sleeper_rosters",
          reserve_evidence: "sleeper_rosters (season-end snapshot only)",
          injury_evidence: "none (unsupported — see coverage.field_support)",
        },
        coverage: {
          ...coverage,
          field_support: AVAILABILITY_FIELD_SUPPORT,
        },
        record_count: filtered.length,
        unresolved_players: unresolvedPlayerIds,
        records: filtered,
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
