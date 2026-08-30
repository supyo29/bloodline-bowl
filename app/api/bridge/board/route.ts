/**
 * GET /api/bridge/board?league=<key>
 *
 * One-league draft board for the interactive Bridge at `/bridge`. Resolves a
 * single Bridge profile and returns that league's identity, live rules, scoring
 * identity hash, draft feed, and ranked available-player pool. Never merges or
 * references another league.
 *
 * Query parameters:
 *   league        Bridge league key / registry key / alias. Required-ish:
 *                 defaults to the Bridge default league when omitted.
 *   ranking       "sleeper" (default) or "custom".
 *   slot          1-based draft slot override (user-confirmed).
 *   pool_limit    1..700, caps the ranked pool.
 */

import { SleeperError } from "@/lib/sleeper/client";
import {
  buildBridgeBoard,
  BOARD_POOL_LIMIT,
  type BridgeBoardResponse,
} from "@/lib/bridge/board";
import {
  DEFAULT_BRIDGE_LEAGUE_KEY,
  findBridgeProfile,
  knownBridgeSelectors,
} from "@/lib/bridge/profiles";
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
  const params = new URL(request.url).searchParams;

  const rawLeague = params.get("league") ?? DEFAULT_BRIDGE_LEAGUE_KEY;
  const profile = findBridgeProfile(rawLeague);
  if (!profile) {
    return errorResponse(
      400,
      "invalid_query_parameter",
      `league must resolve to a Bridge profile (one of: ${knownBridgeSelectors().join(", ")}).`,
    );
  }

  const rankingParam = params.get("ranking");
  if (rankingParam && !["sleeper", "custom"].includes(rankingParam)) {
    return errorResponse(
      400,
      "invalid_query_parameter",
      'ranking must be "sleeper" or "custom".',
    );
  }
  // The board endpoint itself only ships Sleeper ordering; the client re-ranks
  // with its own stored custom file. "custom" here just labels the response.
  const rankingSource =
    rankingParam === "custom" ? "custom_upload" : "sleeper_search_rank";

  let slotOverride: number | null = null;
  const rawSlot = params.get("slot");
  if (rawSlot != null && rawSlot !== "") {
    if (!/^\d{1,2}$/.test(rawSlot)) {
      return errorResponse(400, "invalid_query_parameter", "slot must be 1-99.");
    }
    slotOverride = Number.parseInt(rawSlot, 10);
    if (slotOverride < 1 || slotOverride > 99) {
      return errorResponse(400, "invalid_query_parameter", "slot must be 1-99.");
    }
  }

  const rawPoolLimit = params.get("pool_limit");
  if (rawPoolLimit != null && !/^\d{1,4}$/.test(rawPoolLimit)) {
    return errorResponse(
      400,
      "invalid_query_parameter",
      `pool_limit must be between 1 and ${BOARD_POOL_LIMIT}.`,
    );
  }

  try {
    const board: BridgeBoardResponse = await buildBridgeBoard(
      profile.league_key,
      { rankingSource, slotOverride },
    );

    return jsonResponse(board, {
      headers: {
        "Cache-Control": cacheHeader(5, 15),
        "X-Bridge-League": board.league_identity.league_key,
        "X-Bridge-Draft-Status": board.draft_feed.status,
      },
    });
  } catch (error) {
    if (error instanceof SleeperError) {
      if (error.status === 404) {
        return errorResponse(404, "league_not_found", error.message);
      }
      if (error.status === 429) {
        return errorResponse(
          429,
          "sleeper_rate_limited",
          "Sleeper rate-limited this request. Try again shortly.",
        );
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
