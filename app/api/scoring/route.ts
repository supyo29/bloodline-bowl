/**
 * GET /api/scoring — normalized Bloodline Bowl scoring rules plus derived
 * metrics, archetype examples, sensitivity analysis, and diagnostics, built for
 * an AI to assess scoring balance without manually reading raw Sleeper keys.
 */

import { SleeperError } from "@/lib/sleeper/client";
import { resolveLeagueId } from "@/lib/sleeper/service";
import { buildScoringBundle } from "@/lib/scoring/scoring-service";
import { parseLeagueSelector } from "@/lib/analytics/query";
import {
  cacheHeader,
  errorResponse,
  handleOptions,
  jsonResponse,
} from "@/lib/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Scoring settings change rarely (commissioner action only), so this can cache
// about as long as /api/league's core resources.
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

  try {
    const response = await buildScoringBundle(
      resolveLeagueId(leagueSelectorResult.value),
    );

    return jsonResponse(response, {
      headers: {
        "Cache-Control": cacheHeader(
          CACHE_MAX_AGE_SECONDS,
          STALE_WHILE_REVALIDATE_SECONDS,
        ),
      },
    });
  } catch (error) {
    if (error instanceof SleeperError) {
      if (error.status === 404) {
        return errorResponse(404, "league_not_found", error.message);
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
