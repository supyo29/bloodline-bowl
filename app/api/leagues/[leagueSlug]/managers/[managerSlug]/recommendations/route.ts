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
import { logResolution, resolveManagerRoute } from "@/lib/leagues/api";
import { managerContext } from "@/lib/leagues/resolve";
import { buildManagerRecommendationResponse } from "@/lib/draft/service";
import { cacheHeader, errorResponse, handleOptions, jsonResponse } from "@/lib/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * REHEARSAL-ONLY mock-draft override (opt-in, never on production).
 *
 * `?draft_id=<sleeper mock draft id>` points the Bloodline engine at a standalone
 * Sleeper mock draft's live pick state. `?slot=<1..32>` sets this manager's slot
 * when the mock has no draft_order entry for them (default 7 for supyo29). The
 * override is honoured ONLY when `VERCEL_ENV !== "production"` (i.e. on preview /
 * local), so it cannot change real production behaviour even if this code ships.
 * No `draft_id` ⇒ identical to before.
 */
function parseMockOverride(
  url: string,
):
  | { ok: true; mock: { draftId: string; requestedSlot: number | null } | undefined }
  | { ok: false; response: Response } {
  const search = new URL(url).searchParams;
  const rawDraftId = search.get("draft_id");
  if (rawDraftId === null || rawDraftId === "") return { ok: true, mock: undefined };

  if (process.env.VERCEL_ENV === "production") {
    return {
      ok: false,
      response: errorResponse(
        403,
        "mock_override_disabled",
        "The ?draft_id mock-draft override is a rehearsal-only capability and is disabled on production. Use a preview deployment.",
      ),
    };
  }
  if (!/^\d{1,25}$/.test(rawDraftId)) {
    return {
      ok: false,
      response: errorResponse(400, "invalid_draft_id", "draft_id must be a numeric Sleeper draft id."),
    };
  }

  let requestedSlot: number | null = null;
  const rawSlot = search.get("slot");
  if (rawSlot !== null && rawSlot !== "") {
    if (!/^\d{1,2}$/.test(rawSlot) || Number(rawSlot) < 1 || Number(rawSlot) > 32) {
      return {
        ok: false,
        response: errorResponse(400, "invalid_slot", "slot must be an integer from 1 to 32."),
      };
    }
    requestedSlot = Number(rawSlot);
  }

  return { ok: true, mock: { draftId: rawDraftId, requestedSlot } };
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ leagueSlug: string; managerSlug: string }> },
): Promise<Response> {
  const resolved = await resolveManagerRoute(params);
  if (!resolved.ok) return resolved.response;
  const { manager } = resolved;

  const parsedMock = parseMockOverride(request.url);
  if (!parsedMock.ok) return parsedMock.response;
  const mock = parsedMock.mock;
  if (mock) {
    logResolution("manager", {
      league_slug: manager.league_slug,
      manager_slug: manager.manager_slug,
      mock_draft_override: mock.draftId,
      mock_requested_slot: mock.requestedSlot,
    });
  }

  try {
    const result = await buildManagerRecommendationResponse(manager, { mockDraft: mock });

    // §33 — auction: explicit unsupported-mode response, HTTP 200 so a client
    // can render the readiness block rather than treating it as an error.
    if ("error" in result) {
      return jsonResponse(
        { context: managerContext(manager), ...result },
        {
          status: 200,
          headers: {
            "Cache-Control": cacheHeader(30, 120),
            "X-Draft-Engine": "SNAKE_ONLY/unsupported",
            ...(mock ? { "X-Mock-Draft-Override": mock.draftId } : {}),
          },
        },
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
          // A mock rehearsal state must never be cached as if it were the real draft.
          "Cache-Control": mock
            ? "no-store"
            : result.readiness.snake_engine_status === "READY"
              ? cacheHeader(15, 60)
              : cacheHeader(30, 120),
          "X-Bridge-Context": `manager:${manager.league_slug}/${manager.manager_slug}`,
          "X-Draft-Engine": `SNAKE_ONLY/${result.readiness.snake_engine_status}`,
          "X-Recommendation-Version": result.recommendation_model_version,
          ...(mock ? { "X-Mock-Draft-Override": mock.draftId } : {}),
        },
      },
    );
  } catch (error) {
    if (error instanceof SleeperError) {
      // A bad mock draft id surfaces as an explicit 404 — it never silently
      // reverts to the real Bloodline draft.
      if (mock && error.status === 404) {
        return errorResponse(
          404,
          "mock_draft_not_found",
          error.message ||
            `No Sleeper draft with id ${mock.draftId}. The mock-draft override does not fall back to the real Bloodline draft.`,
        );
      }
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
