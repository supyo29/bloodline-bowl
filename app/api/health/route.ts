/**
 * GET /api/health — lightweight liveness probe. Never calls Sleeper.
 */

import { getPlayerCacheStatus } from "@/lib/sleeper/client";
import { resolveLeagueId } from "@/lib/sleeper/service";
import { errorResponse, handleOptions, jsonResponse } from "@/lib/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  try {
    return jsonResponse(
      {
        ok: true,
        service: "bloodline-bowl-sleeper-bridge",
        league_id: resolveLeagueId(),
        timestamp: new Date().toISOString(),
        player_cache: getPlayerCacheStatus(),
      },
      { headers: { "Cache-Control": "no-store" } },
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
