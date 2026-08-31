/**
 * GET /api/leagues/:leagueSlug/scoring
 *
 * Canonical path form of `/api/scoring?league=...`. Same `buildScoringBundle`.
 * League-wide scoring rules — shared, safe to reuse across managers.
 */

import { SleeperError } from "@/lib/sleeper/client";
import { buildScoringBundle } from "@/lib/scoring/scoring-service";
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
    const response = await buildScoringBundle(league.league_id);
    return jsonResponse(
      { context: leagueContext(league), ...response },
      {
        headers: {
          "Cache-Control": cacheHeader(300, 900),
          "X-Bridge-Context": `league:${league.league_slug}`,
        },
      },
    );
  } catch (error) {
    if (error instanceof SleeperError) {
      if (error.status === 404) {
        return errorResponse(404, "league_not_found", error.message);
      }
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
