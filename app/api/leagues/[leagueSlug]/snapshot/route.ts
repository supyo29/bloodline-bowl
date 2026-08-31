/**
 * GET /api/leagues/:leagueSlug/snapshot
 *
 * Canonical path form of `/api/snapshot?league=...`. Same `buildSnapshot`
 * builder — the compact league-wide state view. League data only.
 */

import { SleeperError } from "@/lib/sleeper/client";
import { buildSnapshot } from "@/lib/analytics/snapshot";
import { buildMetadata } from "@/lib/analytics/types";
import { leagueContext } from "@/lib/leagues/resolve";
import { resolveLeagueRoute } from "@/lib/leagues/api";
import { cacheHeader, errorResponse, handleOptions, jsonResponse } from "@/lib/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ leagueSlug: string }> },
): Promise<Response> {
  const resolved = await resolveLeagueRoute(params);
  if (!resolved.ok) return resolved.response;
  const { league } = resolved;

  try {
    const { snapshot, warnings } = await buildSnapshot(league.league_id);
    const metadata = buildMetadata({
      league_id: league.league_id,
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
      { context: leagueContext(league), ...snapshot, metadata },
      {
        headers: {
          "Cache-Control": cacheHeader(30, 60),
          "X-Bridge-Context": `league:${league.league_slug}`,
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
