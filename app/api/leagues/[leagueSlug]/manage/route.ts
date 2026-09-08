/**
 * GET /api/leagues/:leagueSlug/manage
 *
 * Phase 2 — the shared Team-State / Management Context for EVERY manager in the
 * league, derived from ONE canonical snapshot (one provider read). Factual
 * structural state only — no recommendations. Additive surface; nothing else
 * changes.
 */

import { buildLeagueManagementContext } from "@/lib/team-state";
import { leagueContext } from "@/lib/leagues/resolve";
import { resolveLeagueRoute } from "@/lib/leagues/api";
import { cacheHeader, errorResponse, handleOptions, jsonResponse } from "@/lib/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ leagueSlug: string }> },
): Promise<Response> {
  const resolved = await resolveLeagueRoute(params);
  if (!resolved.ok) return resolved.response;
  const { league } = resolved;

  const result = await buildLeagueManagementContext(league.league_slug);
  if (!result.ok || !result.context) {
    return errorResponse(result.status, result.code ?? "team_state_unavailable", result.detail);
  }

  return jsonResponse(
    {
      context: leagueContext(league),
      state_source: result.state_source ?? "LEGACY_LIVE_PATH",
      ...(result.fallback_reason ? { fallback_reason: result.fallback_reason } : {}),
      ...result.context,
    },
    {
      headers: {
        "Cache-Control": cacheHeader(30, 120),
        "X-Bridge-Context": `league:${league.league_slug}`,
      },
    },
  );
}

export async function OPTIONS(): Promise<Response> {
  return handleOptions();
}
