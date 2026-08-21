/**
 * GET /api/snapshot — compact, AI-friendly current-state view, composed from
 * `/api/league`, `/api/draft`, `/api/scoring`, and this analytics layer.
 * Not a concatenation of every route's full payload — only the facts most
 * useful for "analyze my league" style questions.
 */

import { SleeperError } from "@/lib/sleeper/client";
import { resolveLeagueId } from "@/lib/sleeper/service";
import { buildSnapshot } from "@/lib/analytics/snapshot";
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
    const { snapshot, warnings } = await buildSnapshot(leagueId);

    const metadata = buildMetadata({
      league_id: leagueId,
      season: snapshot.league.season,
      sources: [
        { name: "Sleeper", type: "league_data" },
        { name: "Sleeper", type: "matchup_data" },
        { name: "Sleeper", type: "transaction_data" },
      ],
      data_freshness: {
        standings: "1m",
        current_matchups: "1m",
        recent_transactions: "1m",
        draft: "5s (while drafting)",
      },
      warnings,
    });

    return jsonResponse(
      { ...snapshot, metadata },
      { headers: { "Cache-Control": cacheHeader(30, 60) } },
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
