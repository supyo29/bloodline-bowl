/**
 * GET /api/managers — factual manager career profiles, identified by
 * Sleeper's stable `user_id` across every linked season. No skill grades.
 *
 * Query: ?user_id=... (single profile) — otherwise returns every manager.
 * `all_time` is implied: a manager's career always spans every discovered
 * season, since Sleeper's lineage is the only season-linking mechanism
 * available.
 */

import { SleeperError, getNflState } from "@/lib/sleeper/client";
import { resolveLeagueId } from "@/lib/sleeper/service";
import { buildLeagueHistory } from "@/lib/analytics/history";
import { buildManagerProfiles } from "@/lib/analytics/managers";
import { buildMetadata } from "@/lib/analytics/types";
import { parseUserId } from "@/lib/analytics/query";
import { cacheHeader, errorResponse, handleOptions, jsonResponse } from "@/lib/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(request: Request): Promise<Response> {
  const leagueId = resolveLeagueId();
  const params = new URL(request.url).searchParams;

  try {
    const userIdResult = parseUserId(params.get("user_id"));
    if ("error" in userIdResult) {
      return errorResponse(400, "invalid_query_parameter", userIdResult.error);
    }

    const nflState = await getNflState().catch(() => null);
    const currentSeason = nflState?.season ?? new Date().getFullYear().toString();

    const { seasons, warnings: historyWarnings } = await buildLeagueHistory(
      leagueId,
      currentSeason,
    );
    const { profiles, warnings: managerWarnings } = await buildManagerProfiles(
      seasons,
      currentSeason,
    );

    const warnings = [...historyWarnings, ...managerWarnings];
    let result = profiles;
    if (userIdResult.value !== null) {
      const userId = userIdResult.value;
      result = profiles.filter((p) => p.user_id === userId);
      if (result.length === 0) {
        return errorResponse(
          404,
          "manager_not_found",
          `No manager with user_id ${userId} was found in this league's history.`,
        );
      }
    }

    const metadata = buildMetadata({
      league_id: leagueId,
      season: currentSeason,
      sources: [{ name: "Sleeper", type: "league_data" }],
      data_freshness: { managers: "5m (current season), 24h (past seasons)" },
      warnings,
    });

    return jsonResponse(
      { managers: result, metadata },
      { headers: { "Cache-Control": cacheHeader(300, 900) } },
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
