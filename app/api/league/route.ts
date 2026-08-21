/**
 * GET /api/league — the consolidated, normalized Bloodline Bowl snapshot.
 */

import { SleeperError } from "@/lib/sleeper/client";
import { buildLeagueBundle, resolveLeagueId } from "@/lib/sleeper/service";
import { parseLeagueSelector } from "@/lib/analytics/query";
import {
  cacheHeader,
  errorResponse,
  handleOptions,
  jsonResponse,
} from "@/lib/http";

/** Always run the handler; freshness is managed by CDN cache headers. */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
/** The player-database cold start can take ~10-20s. */
export const maxDuration = 60;

const CACHE_MAX_AGE_SECONDS = 300;
const STALE_WHILE_REVALIDATE_SECONDS = 900;

export async function GET(request: Request): Promise<Response> {
  const leagueSelectorResult = parseLeagueSelector(
    new URL(request.url).searchParams.get("league"),
  );
  if ("error" in leagueSelectorResult) {
    return errorResponse(
      400,
      "invalid_query_parameter",
      leagueSelectorResult.error,
    );
  }
  const leagueId = resolveLeagueId(leagueSelectorResult.value);

  try {
    const { response, complete } = await buildLeagueBundle(leagueId);

    return jsonResponse(response, {
      headers: {
        // Degraded responses get a shorter TTL so a transient upstream failure
        // is not pinned in the CDN for the full window.
        "Cache-Control": complete
          ? cacheHeader(CACHE_MAX_AGE_SECONDS, STALE_WHILE_REVALIDATE_SECONDS)
          : cacheHeader(60, 300),
        "X-Bloodline-Complete": complete ? "true" : "partial",
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
