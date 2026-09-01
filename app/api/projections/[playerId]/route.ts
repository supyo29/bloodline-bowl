/**
 * GET /api/projections/:playerId — one player's Layer-1 football projection
 * with the full opportunity / efficiency / TD / availability breakdown and the
 * Sleeper benchmark comparison.
 */

import { SleeperError } from "@/lib/sleeper/client";
import { buildSinglePlayerResponse, PROJECTION_IDENTITY } from "@/lib/projections/service";
import { cacheHeader, errorResponse, handleOptions, jsonResponse } from "@/lib/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ playerId: string }> },
): Promise<Response> {
  const { playerId } = await params;
  if (!/^[A-Za-z0-9_-]{1,20}$/.test(playerId)) {
    return errorResponse(400, "invalid_path_parameter", "playerId is not a valid Sleeper id");
  }

  try {
    const result = await buildSinglePlayerResponse(playerId);
    if (!result.ok) {
      return errorResponse(404, "projection_not_found", `No 2026 projection for player ${playerId}. The projection pool covers active QB/RB/WR/TE on an NFL roster.`);
    }
    return jsonResponse(
      { identity: PROJECTION_IDENTITY, meta: result.meta, projection: result.projection, vs_sleeper: result.vs_sleeper },
      { headers: { "Cache-Control": cacheHeader(600, 1800) } },
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
