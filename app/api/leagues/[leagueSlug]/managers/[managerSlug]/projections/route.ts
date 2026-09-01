/**
 * GET /api/leagues/:leagueSlug/managers/:managerSlug/projections — Layer 3.
 *
 * Need-weighted projection value for ONE resolved manager's current roster in
 * ONE league. The response separates:
 *   - `projection` roots (football + league) are unchanged from Layers 1/2
 *   - `manager_context` — the resolved identity the engine actually used
 *   - each value row carries `contextual_value`, `roster_fit`, `need_multiplier`
 *     and a `projection_edge` block (RI vs Sleeper, informational only).
 *
 * Cache key includes league_id + scoring_hash + sleeper_user_id + draft/roster
 * state. roster_id is NEVER the key (not globally unique across leagues).
 *
 * Query param: `limit` (1..1000).
 */

import { SleeperError } from "@/lib/sleeper/client";
import { managerContext } from "@/lib/leagues/resolve";
import { resolveManagerRoute } from "@/lib/leagues/api";
import { buildManagerProjectionResponse, PROJECTION_IDENTITY } from "@/lib/projections/service";
import { cacheHeader, errorResponse, handleOptions, jsonResponse } from "@/lib/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ leagueSlug: string; managerSlug: string }> },
): Promise<Response> {
  const resolved = await resolveManagerRoute(params);
  if (!resolved.ok) return resolved.response;
  const { manager } = resolved;

  const limitRaw = new URL(request.url).searchParams.get("limit");
  if (limitRaw && !/^\d{1,4}$/.test(limitRaw)) {
    return errorResponse(400, "invalid_query_parameter", "limit must be a positive integer");
  }

  try {
    const response = await buildManagerProjectionResponse(
      {
        league_slug: manager.league_slug,
        league_id: manager.league_id,
        sleeper_user_id: manager.sleeper_user_id,
        roster_id: manager.roster_id,
        draft_id: manager.draft_id,
      },
      { limit: limitRaw ? Number.parseInt(limitRaw, 10) : undefined },
    );
    return jsonResponse(
      { context: managerContext(manager), identity: PROJECTION_IDENTITY, manager_context: response.manager, ...response },
      {
        headers: {
          "Cache-Control": cacheHeader(120, 600),
          "X-Bridge-Context": `manager:${manager.league_slug}/${manager.manager_slug}`,
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
