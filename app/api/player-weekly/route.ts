/**
 * GET /api/player-weekly — historical (or current) weekly player fantasy
 * scoring, one row per player-week, scored with the resolved league's own
 * settings for that exact season. See lib/analytics/historical-scoring.ts
 * for the two-source scoring methodology.
 *
 * Query: ?league=devoted-to-the-game&season=2025[&week=4]
 *
 * `season` is required and validated against this league's actual lineage —
 * requesting a season this league never had returns 404, never a silent
 * fallback to the current season's league/scoring.
 */

import {
  SleeperError,
  getMatchups,
  getNflState,
  getPlayerIndex,
} from "@/lib/sleeper/client";
import { resolveLeagueId } from "@/lib/sleeper/service";
import { resolveSeasonLeagueId } from "@/lib/analytics/season-resolution";
import { buildPlayerWeeklyRows } from "@/lib/analytics/historical-scoring";
import {
  reconcileWeek,
  summarizeReconciliation,
} from "@/lib/analytics/reconciliation";
import { getStatsProvider } from "@/lib/stats/provider";
import { buildMetadata } from "@/lib/analytics/types";
import {
  parseLeagueSelector,
  parseSeason,
  parseWeek,
} from "@/lib/analytics/query";
import {
  cacheHeader,
  errorResponse,
  handleOptions,
  jsonResponse,
} from "@/lib/http";
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
    return errorResponse(
      400,
      "invalid_query_parameter",
      leagueSelectorResult.error,
    );
  }
  const leagueSelector = params.get("league") ?? "bloodline-bowl";
  const defaultLeagueId = resolveLeagueId(leagueSelectorResult.value);

  try {
    const nflState = await getNflState().catch(() => null);
    const currentSeason =
      nflState?.season ?? new Date().getFullYear().toString();

    const seasonResult = parseSeason(params.get("season"), currentSeason);
    if ("error" in seasonResult) {
      return errorResponse(400, "invalid_query_parameter", seasonResult.error);
    }
    const weekResult = parseWeek(params.get("week"));
    if ("error" in weekResult) {
      return errorResponse(400, "invalid_query_parameter", weekResult.error);
    }
    const season = seasonResult.value;

    const resolution = await resolveSeasonLeagueId(
      defaultLeagueId,
      season,
      currentSeason,
    );
    if (!resolution.ok) {
      return errorResponse(
        resolution.status,
        resolution.status === 404
          ? "season_not_found"
          : "sleeper_upstream_error",
        resolution.error,
      );
    }
    const {
      league,
      isCurrentSeason,
      warnings: lineageWarnings,
    } = resolution.result;
    const leagueId = league.league_id;
    // Explicit safety check per Phase 5: never let a resolved league's season
    // silently disagree with what was requested.
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

    const matchupsByWeek = new Map<number, RawMatchup[]>();
    const missingWeeks: number[] = [];
    await Promise.all(
      weeks.map(async (week) => {
        try {
          const rows = await getMatchups(leagueId, week, { revalidate });
          if (rows.length === 0) missingWeeks.push(week);
          matchupsByWeek.set(week, rows);
        } catch (error) {
          missingWeeks.push(week);
          warnings.push(
            `Could not load week ${week} matchups: ${describeError(error)}`,
          );
          matchupsByWeek.set(week, []);
        }
      }),
    );

    const generatedAt = new Date().toISOString();
    const allRows = [];
    const unresolvedAll = new Set<string>();
    const reconciliationResults = [];

    for (const week of weeks) {
      const matchups = matchupsByWeek.get(week) ?? [];
      if (matchups.length === 0) continue;

      let statLines = null;
      if (provider.isAvailable()) {
        try {
          statLines = await provider.getWeeklyStats(season, week);
        } catch (error) {
          warnings.push(
            `Could not load raw stats for week ${week}: ${describeError(error)}`,
          );
        }
      }

      const { rows, unresolvedPlayerIds } = buildPlayerWeeklyRows({
        leagueSelector,
        leagueId,
        season,
        week,
        matchups,
        statLines,
        scoringSettings: league.scoring_settings ?? {},
        playerIndex,
        generatedAt,
        rosterPositions: league.roster_positions ?? [],
      });

      allRows.push(...rows);
      for (const id of unresolvedPlayerIds) unresolvedAll.add(id);
      reconciliationResults.push(...reconcileWeek(week, matchups, rows));
    }

    const weeksReturned = weeks.filter(
      (w) => (matchupsByWeek.get(w)?.length ?? 0) > 0,
    );
    const reconciliation = summarizeReconciliation(reconciliationResults);
    if (reconciliation.status === "discrepancies_found") {
      warnings.push(
        `Reconciliation found ${reconciliation.rosters_checked - reconciliation.rosters_within_tolerance} roster-week(s) where summed starter points differ from the matchup total by more than ${reconciliation.max_absolute_difference} points.`,
      );
    }

    const metadata = buildMetadata({
      league_id: leagueId,
      season,
      sources: [
        { name: "Sleeper", type: "matchup_scored_points" },
        { name: "Sleeper", type: "nfl_statistics" },
      ],
      data_freshness: {
        player_weekly: isCurrentSeason ? "1m" : "24h (historical, immutable)",
      },
      warnings,
    });

    return jsonResponse(
      {
        league_selector: leagueSelector,
        league_id: leagueId,
        season,
        weeks_returned: weeksReturned,
        missing_weeks: missingWeeks,
        row_count: allRows.length,
        unresolved_players: [...unresolvedAll].sort(),
        scoring_method: "sleeper_matchup_points_primary_with_raw_stat_fallback",
        scoring_settings_provenance: {
          source_league_id: leagueId,
          source_season: league.season,
          note: "Rostered players use Sleeper's own matchup-scored points for this exact league/season. Unrostered players are scored locally from raw stats using this same resolved league's scoring_settings — never the current season's.",
        },
        reconciliation,
        players: allRows,
        metadata: { ...metadata, cache_seconds: isCurrentSeason ? 60 : 86400 },
      },
      {
        headers: {
          "Cache-Control": isCurrentSeason
            ? cacheHeader(60, 300)
            : cacheHeader(86400, 172800),
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
