/**
 * GET /api/history — factual season-by-season history, following Sleeper's
 * `previous_league_id` lineage. Champions/runner-ups are only ever read from
 * actual bracket results, never inferred from regular-season standings.
 */

import { getNflState } from "@/lib/sleeper/client";
import { resolveLeagueId } from "@/lib/sleeper/service";
import { buildLeagueHistory } from "@/lib/analytics/history";
import { buildMetadata } from "@/lib/analytics/types";
import { parseLeagueSelector } from "@/lib/analytics/query";
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
  const leagueSelectorResult = parseLeagueSelector(
    new URL(request.url).searchParams.get("league"),
  );
  if ("error" in leagueSelectorResult) {
    return errorResponse(
      400,
      "invalid_query_parameter",
      leagueSelectorResult.error,
    );
  }
  const leagueId = resolveLeagueId(leagueSelectorResult.value);

  try {
    const nflState = await getNflState().catch(() => null);
    const currentSeason =
      nflState?.season ?? new Date().getFullYear().toString();

    const { seasons, warnings } = await buildLeagueHistory(
      leagueId,
      currentSeason,
    );

    const metadata = buildMetadata({
      league_id: leagueId,
      season: currentSeason,
      sources: [{ name: "Sleeper", type: "league_data" }],
      data_freshness: { current_season: "5m", past_seasons: "24h" },
      warnings,
    });

    return jsonResponse(
      { seasons, metadata },
      { headers: { "Cache-Control": cacheHeader(300, 900) } },
    );
  } catch (error) {
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
