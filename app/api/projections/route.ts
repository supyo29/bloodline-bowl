/**
 * GET /api/projections — Layer 1, scoring-neutral Roster Intel football
 * projections for the 2026 season. Identical for every league and every
 * manager. Each player carries a `vs_sleeper` block: Sleeper is a BENCHMARK,
 * never a model input.
 *
 * Query params: `position` (QB|RB|WR|TE), `limit` (1..2000).
 */

import { SleeperError } from "@/lib/sleeper/client";
import { buildBaseListResponse, PROJECTION_IDENTITY } from "@/lib/projections/service";
import { cacheHeader, errorResponse, handleOptions, jsonResponse } from "@/lib/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const POSITIONS = new Set(["QB", "RB", "WR", "TE", "K", "DEF"]);

export async function GET(request: Request): Promise<Response> {
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
    const response = await buildBaseListResponse({
      position,
      limit: limitRaw ? Number.parseInt(limitRaw, 10) : undefined,
    });
    return jsonResponse(
      { identity: PROJECTION_IDENTITY, ...response },
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
