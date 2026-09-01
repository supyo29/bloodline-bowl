/**
 * GET /api/leagues/:leagueSlug/projections — Layer 2. The Layer-1 football
 * projection translated through THIS league's actual Sleeper scoring settings
 * (via the shared `calculateFantasyPoints` engine), plus value-over-replacement,
 * tiers and positional scarcity derived from the league's real lineup config.
 *
 * Keyed by league_id + scoring_hash. Two managers in this league see identical
 * numbers here — manager context lives at
 * `/api/leagues/:leagueSlug/managers/:managerSlug/projections`.
 *
 * Query params: `position`, `limit`.
 */

import { SleeperError } from "@/lib/sleeper/client";
import { leagueContext } from "@/lib/leagues/resolve";
import { resolveLeagueRoute } from "@/lib/leagues/api";
import { buildLeagueResponse, loadLeagueConfig, PROJECTION_IDENTITY } from "@/lib/projections/service";
import { cacheHeader, errorResponse, handleOptions, jsonResponse } from "@/lib/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const POSITIONS = new Set(["QB", "RB", "WR", "TE", "K", "DEF"]);

export async function GET(
  request: Request,
  { params }: { params: Promise<{ leagueSlug: string }> },
): Promise<Response> {
  const resolved = await resolveLeagueRoute(params);
  if (!resolved.ok) return resolved.response;
  const { league } = resolved;

  const search = new URL(request.url).searchParams;
  const position = search.get("position");
  if (position && !POSITIONS.has(position.toUpperCase())) {
    return errorResponse(400, "invalid_query_parameter", "position must be one of QB, RB, WR, TE, K, DEF");
  }
  const limitRaw = search.get("limit");
  if (limitRaw && !/^\d{1,4}$/.test(limitRaw)) {
    return errorResponse(400, "invalid_query_parameter", "limit must be a positive integer");
  }

  try {
    const cfg = await loadLeagueConfig(league.league_slug, league.league_id);
    const response = await buildLeagueResponse(cfg, {
      position,
      limit: limitRaw ? Number.parseInt(limitRaw, 10) : undefined,
    });
    return jsonResponse(
      { context: leagueContext(league), identity: PROJECTION_IDENTITY, ...response },
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
