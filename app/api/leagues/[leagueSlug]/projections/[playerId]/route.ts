/**
 * GET /api/leagues/:leagueSlug/projections/:playerId — one player under this
 * league's scoring. Returns `football_projection` (Layer 1, scoring-neutral)
 * and `league_projection` (Layer 2: league points, VOR, tier, rank, and the
 * apples-to-apples Sleeper comparison under the same scoring) as distinct
 * objects.
 */

import { SleeperError } from "@/lib/sleeper/client";
import { leagueContext } from "@/lib/leagues/resolve";
import { resolveLeagueRoute } from "@/lib/leagues/api";
import { buildLeaguePlayerResponse, loadLeagueConfig, PROJECTION_IDENTITY } from "@/lib/projections/service";
import { cacheHeader, errorResponse, handleOptions, jsonResponse } from "@/lib/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ leagueSlug: string; playerId: string }> },
): Promise<Response> {
  const { playerId } = await params;
  if (!/^[A-Za-z0-9_-]{1,20}$/.test(playerId)) {
    return errorResponse(400, "invalid_path_parameter", "playerId is not a valid Sleeper id");
  }
  const resolved = await resolveLeagueRoute(params);
  if (!resolved.ok) return resolved.response;
  const { league } = resolved;

  try {
    const cfg = await loadLeagueConfig(league.league_slug, league.league_id);
    const result = await buildLeaguePlayerResponse(cfg, playerId);
    if (!result.ok) {
      return errorResponse(404, "projection_not_found", `No 2026 projection for player ${playerId} in ${league.league_slug}.`);
    }
    return jsonResponse(
      {
        context: leagueContext(league),
        identity: PROJECTION_IDENTITY,
        meta: result.meta,
        scoring_hash: result.scoring_hash,
        football_projection: result.football_projection,
        league_projection: result.league_projection,
      },
      {
        headers: {
          "Cache-Control": cacheHeader(600, 1800),
          "X-Bridge-Context": `league:${league.league_slug}`,
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
