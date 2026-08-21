/**
 * GET /api/transactions — normalized trades, waivers, free-agent moves, and
 * drops. No trade evaluation — only what moved and between whom.
 *
 * Query: ?season=2026 ?week=5 ?type=trade ?manager=<user_id> ?roster_id=3
 */

import {
  SleeperError,
  getLeagueRosters,
  getLeagueTransactions,
  getLeagueUsers,
  getNflState,
  getPlayerIndex,
} from "@/lib/sleeper/client";
import { resolveLeagueId } from "@/lib/sleeper/service";
import { normalizeTransaction } from "@/lib/analytics/transactions";
import { traverseLeagueLineage } from "@/lib/analytics/lineage";
import { buildMetadata } from "@/lib/analytics/types";
import { allWeeks } from "@/lib/analytics/season-data";
import {
  parseLeagueSelector,
  parseRosterId,
  parseSeason,
  parseTransactionType,
  parseUserId,
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

    const seasonResult = parseSeason(params.get("season"), currentSeason);
    if ("error" in seasonResult) {
      return errorResponse(400, "invalid_query_parameter", seasonResult.error);
    }
    const weekResult = parseWeek(params.get("week"));
    if ("error" in weekResult) {
      return errorResponse(400, "invalid_query_parameter", weekResult.error);
    }
    const typeResult = parseTransactionType(params.get("type"));
    if ("error" in typeResult) {
      return errorResponse(400, "invalid_query_parameter", typeResult.error);
    }
    const rosterIdResult = parseRosterId(params.get("roster_id"));
    if ("error" in rosterIdResult) {
      return errorResponse(
        400,
        "invalid_query_parameter",
        rosterIdResult.error,
      );
    }
    const managerResult = parseUserId(params.get("manager"));
    if ("error" in managerResult) {
      return errorResponse(400, "invalid_query_parameter", managerResult.error);
    }

    const season = seasonResult.value;
    const isCurrentSeason = season === currentSeason;
    const revalidate = isCurrentSeason ? 60 : 24 * 60 * 60;

    // Sleeper assigns a new league_id each season; resolve the requested
    // season to its actual league_id by walking the same lineage /api/history
    // uses, rather than silently reusing the current league_id for a season
    // that never had it.
    let targetLeagueId = leagueId;
    const warnings: string[] = [];
    if (!isCurrentSeason) {
      const lineage = await traverseLeagueLineage(leagueId);
      warnings.push(...lineage.warnings);
      const match = lineage.seasons.find(
        (entry) => entry.league.season === season,
      );
      if (!match) {
        return errorResponse(
          404,
          "season_not_found",
          `No linked season ${season} was found in this league's history.`,
        );
      }
      targetLeagueId = match.league.league_id;
    }

    const weeks = weekResult.value !== null ? [weekResult.value] : allWeeks();

    const [rosters, users, playerIndex] = await Promise.all([
      getLeagueRosters(targetLeagueId, { revalidate }),
      getLeagueUsers(targetLeagueId, { revalidate }),
      getPlayerIndex(),
    ]);
    const rostersById = new Map(rosters.map((r) => [r.roster_id, r]));
    const usersById = new Map(users.map((u) => [u.user_id, u]));

    const weekResults = await Promise.all(
      weeks.map(async (week) => {
        try {
          return await getLeagueTransactions(targetLeagueId, week, {
            revalidate,
          });
        } catch (error) {
          warnings.push(
            `Could not load week ${week} transactions: ${
              error instanceof SleeperError || error instanceof Error
                ? error.message
                : String(error)
            }`,
          );
          return [];
        }
      }),
    );

    let transactions = weekResults
      .flat()
      .filter((t) => t.status === "complete")
      .map((t) =>
        normalizeTransaction(t, season, playerIndex, rostersById, usersById),
      );

    if (typeResult.value !== null) {
      transactions = transactions.filter((t) => t.type === typeResult.value);
    }
    if (rosterIdResult.value !== null) {
      const rosterId = rosterIdResult.value;
      transactions = transactions.filter((t) =>
        t.rosters_involved.includes(rosterId),
      );
    }
    if (managerResult.value !== null) {
      const managerId = managerResult.value;
      const managerRosterIds = new Set(
        rosters.filter((r) => r.owner_id === managerId).map((r) => r.roster_id),
      );
      transactions = transactions.filter((t) =>
        t.rosters_involved.some((id) => managerRosterIds.has(id)),
      );
    }

    transactions.sort((a, b) =>
      (b.created_at ?? "").localeCompare(a.created_at ?? ""),
    );

    const metadata = buildMetadata({
      league_id: leagueId,
      season,
      sources: [{ name: "Sleeper", type: "transaction_data" }],
      data_freshness: { transactions: isCurrentSeason ? "1m" : "24h" },
      warnings,
    });

    return jsonResponse(
      { transactions, count: transactions.length, metadata },
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
