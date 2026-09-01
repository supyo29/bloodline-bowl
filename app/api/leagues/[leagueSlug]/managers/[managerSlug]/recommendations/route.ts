/**
 * GET /api/leagues/:leagueSlug/managers/:managerSlug/recommendations
 *
 * PHASE 4 — the snake-draft RECOMMENDATION engine (`ri-snake-decision-2026.1`).
 *
 * Distinct from `.../draft` (raw draft state + a best-available candidate list):
 * this endpoint answers "who should THIS manager draft NOW, accounting for what
 * is lost by waiting" — turn geometry, tier cliffs, survival, reach cost,
 * roster-construction risk, and (on the snake turn) two-pick optimisation.
 *
 * SNAKE_ONLY: an auction draft returns `error: "UNSUPPORTED_MODE"` with
 * `auction_engine_status: "UNSUPPORTED_2026"` — never snake logic on an auction.
 */

import { SleeperError } from "@/lib/sleeper/client";
import { resolveManagerRoute } from "@/lib/leagues/api";
import { managerContext } from "@/lib/leagues/resolve";
import { buildManagerRecommendationResponse } from "@/lib/draft/service";
import { cacheHeader, errorResponse, handleOptions, jsonResponse } from "@/lib/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ leagueSlug: string; managerSlug: string }> },
): Promise<Response> {
  const resolved = await resolveManagerRoute(params);
  if (!resolved.ok) return resolved.response;
  const { manager } = resolved;

  try {
    const result = await buildManagerRecommendationResponse(manager);

    // §33 — auction: explicit unsupported-mode response, HTTP 200 so a client
    // can render the readiness block rather than treating it as an error.
    if ("error" in result) {
      return jsonResponse(
        { context: managerContext(manager), ...result },
        { status: 200, headers: { "Cache-Control": cacheHeader(30, 120), "X-Draft-Engine": "SNAKE_ONLY/unsupported" } },
      );
    }

    // §31 fail-closed: the engine's identity MUST equal the resolved manager.
    const mc = result.manager_context;
    if (
      mc.used_roster_id !== manager.roster_id ||
      mc.used_sleeper_user_id !== manager.sleeper_user_id ||
      mc.used_manager_slug !== manager.manager_slug
    ) {
      return errorResponse(
        500,
        "manager_context_mismatch",
        `Recommendation engine reasoned over ${mc.used_manager_slug}/${mc.used_roster_id}, not the requested ${manager.manager_slug}/${manager.roster_id}.`,
      );
    }

    return jsonResponse(
      { context: managerContext(manager), ...result },
      {
        headers: {
          "Cache-Control":
            result.readiness.snake_engine_status === "READY"
              ? cacheHeader(15, 60)
              : cacheHeader(30, 120),
          "X-Bridge-Context": `manager:${manager.league_slug}/${manager.manager_slug}`,
          "X-Draft-Engine": `SNAKE_ONLY/${result.readiness.snake_engine_status}`,
          "X-Recommendation-Version": result.recommendation_model_version,
        },
      },
    );
  } catch (error) {
    if (error instanceof SleeperError) {
      if (error.status === 429) {
        return errorResponse(429, "sleeper_rate_limited", "Sleeper rate-limited this request. Try again shortly.");
      }
      return errorResponse(502, "sleeper_upstream_error", error.message);
    }
    return errorResponse(500, "internal_error", error instanceof Error ? error.message : "Unknown error");
  }
}

export async function OPTIONS(): Promise<Response> {
  return handleOptions();
}
