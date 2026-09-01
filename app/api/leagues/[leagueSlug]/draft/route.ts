/**
 * GET /api/leagues/:leagueSlug/draft
 *
 * Canonical path form of `/api/draft?league=...`. Same underlying
 * `buildDraftBundle` — league-wide draft state only (board, picks, available
 * players, per-team budgets/needs). For personalized draft data use
 * `/api/leagues/:leagueSlug/managers/:managerSlug/draft`.
 *
 * Query params match `/api/draft`: `available_limit`, `position`.
 */

import { SleeperError } from "@/lib/sleeper/client";
import {
  buildDraftBundle,
  getAllowedPositions,
  parseDraftQuery,
} from "@/lib/sleeper/draft-service";
import { leagueContext } from "@/lib/leagues/resolve";
import { resolveLeagueRoute } from "@/lib/leagues/api";
import { errorResponse, handleOptions, jsonResponse } from "@/lib/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ leagueSlug: string }> },
): Promise<Response> {
  const resolved = await resolveLeagueRoute(params);
  if (!resolved.ok) return resolved.response;
  const { league } = resolved;
  const searchParams = new URL(request.url).searchParams;

  try {
    const allowedPositions = await getAllowedPositions(league.league_id);
    const parsed = parseDraftQuery(searchParams, allowedPositions);
    if ("error" in parsed) {
      return errorResponse(400, "invalid_query_parameter", parsed.error);
    }

    const { response } = await buildDraftBundle(league.league_id, parsed.query);

    return jsonResponse(
      { context: leagueContext(league), ...response },
      {
        headers: {
          // LIVE DRAFT-ROOM ENDPOINT — always `no-store` (see the manager draft
          // route). Live pick state must not be edge-cached during the draft.
          "Cache-Control": "no-store",
          "X-Bridge-Context": `league:${league.league_slug}`,
          "X-Draft-Status": response.draft?.status ?? "none",
        },
      },
    );
  } catch (error) {
    if (error instanceof SleeperError) {
      if (error.status === 404) {
        return errorResponse(
          404,
          "league_not_found",
          `Sleeper has no league with id ${league.league_id}.`,
        );
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
