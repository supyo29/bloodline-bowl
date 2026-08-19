/**
 * GET /api/draft — live draft-night view of the Bloodline Bowl auction.
 *
 * Built for repeated polling during a draft: the draft object and its picks are
 * fetched uncached, while slower-moving league context and the player database
 * are served from existing caches.
 *
 * Query parameters:
 *   available_limit  1..1000, default 300
 *   position         one of the league's draftable positions
 */

import { SleeperError } from "@/lib/sleeper/client";
import {
  buildDraftBundle,
  getAllowedPositions,
  parseDraftQuery,
} from "@/lib/sleeper/draft-service";
import { resolveLeagueId } from "@/lib/sleeper/service";
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
  const leagueId = resolveLeagueId();

  try {
    const allowedPositions = await getAllowedPositions(leagueId);
    const parsed = parseDraftQuery(
      new URL(request.url).searchParams,
      allowedPositions,
    );

    if ("error" in parsed) {
      return errorResponse(400, "invalid_query_parameter", parsed.error);
    }

    const { response, cacheSeconds } = await buildDraftBundle(
      leagueId,
      parsed.query,
    );

    return jsonResponse(response, {
      headers: {
        // Short TTL while drafting, longer once the draft is done.
        "Cache-Control": cacheHeader(cacheSeconds, cacheSeconds * 2),
        "X-Draft-Status": response.draft?.status ?? "none",
      },
    });
  } catch (error) {
    if (error instanceof SleeperError) {
      if (error.status === 404) {
        return errorResponse(
          404,
          "league_not_found",
          `Sleeper has no league with id ${leagueId}.`,
        );
      }
      if (error.status === 504) {
        return errorResponse(504, "sleeper_timeout", error.message);
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
