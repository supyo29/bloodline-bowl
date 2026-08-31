/**
 * GET /api/leagues/:leagueSlug/managers/:managerSlug/draft
 *
 * The personalized draft endpoint. Composes the SHARED league draft state
 * (board / picks / available players — reused, not recomputed per manager) with
 * ONE manager's personalized state: roster, roster id, draft slot, picks,
 * positional needs, and recommendations.
 *
 * The `manager.recommendation_context` block echoes the exact roster id /
 * user id / roster composition the recommendation engine reasoned over, so a
 * client can verify personalization is genuinely roster-driven — not merely
 * labelled correctly.
 *
 * Query params: `available_limit` (1..1000), `recommendations` (1..50).
 */

import { SleeperError } from "@/lib/sleeper/client";
import { buildManagerDraftContext } from "@/lib/leagues/manager-draft";
import { managerContext } from "@/lib/leagues/resolve";
import { resolveManagerRoute } from "@/lib/leagues/api";
import { cacheHeader, errorResponse, handleOptions, jsonResponse } from "@/lib/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

function parsePositiveInt(
  raw: string | null,
  { min, max, fallback }: { min: number; max: number; fallback: number },
): number | { error: string } {
  if (raw === null || raw === "") return fallback;
  if (!/^\d{1,5}$/.test(raw)) return { error: "must be a positive integer" };
  const n = Number.parseInt(raw, 10);
  if (n < min || n > max) return { error: `must be between ${min} and ${max}` };
  return n;
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ leagueSlug: string; managerSlug: string }> },
): Promise<Response> {
  const resolved = await resolveManagerRoute(params);
  if (!resolved.ok) return resolved.response;
  const { manager } = resolved;

  const search = new URL(request.url).searchParams;
  const availableLimit = parsePositiveInt(search.get("available_limit"), {
    min: 1,
    max: 1000,
    fallback: 300,
  });
  if (typeof availableLimit !== "number") {
    return errorResponse(
      400,
      "invalid_query_parameter",
      `available_limit ${availableLimit.error}`,
    );
  }
  const recommendationCount = parsePositiveInt(search.get("recommendations"), {
    min: 1,
    max: 50,
    fallback: 12,
  });
  if (typeof recommendationCount !== "number") {
    return errorResponse(
      400,
      "invalid_query_parameter",
      `recommendations ${recommendationCount.error}`,
    );
  }

  try {
    const draftContext = await buildManagerDraftContext(manager, {
      availableLimit,
      recommendationCount,
    });

    // Fail-closed sanity: the engine's identity MUST equal the resolved manager.
    const rc = draftContext.manager.recommendation_context;
    if (
      rc.used_roster_id !== manager.roster_id ||
      rc.used_sleeper_user_id !== manager.sleeper_user_id ||
      rc.used_manager_slug !== manager.manager_slug
    ) {
      return errorResponse(
        500,
        "manager_context_mismatch",
        `Recommendation engine resolved a different manager (${rc.used_manager_slug}/${rc.used_roster_id}) than the request (${manager.manager_slug}/${manager.roster_id}).`,
      );
    }

    return jsonResponse(
      { context: managerContext(manager), ...draftContext },
      {
        headers: {
          "Cache-Control":
            draftContext.draft.status === "drafting"
              ? cacheHeader(5, 15)
              : cacheHeader(30, 120),
          "X-Bridge-Context": `manager:${manager.league_slug}/${manager.manager_slug}`,
          "X-Draft-Status": draftContext.draft.status ?? "none",
        },
      },
    );
  } catch (error) {
    if (error instanceof SleeperError) {
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
