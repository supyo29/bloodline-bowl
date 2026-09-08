/**
 * GET /api/leagues/:leagueSlug/roster-health
 *
 * Phase 6 — Roster Health Intelligence (Scope 3, SHARED_CONTEXT) for EVERY
 * manager, derived from ONE canonical snapshot + ONE weekly projection batch +
 * ONE ROS signal (0 extra provider reads per manager). Evaluative roster
 * quality / fragility / depth / player-dependency / quality-surplus. NOT a
 * recommendation — no trade/waiver/lineup/start-sit/matchup score changes.
 */

import { buildRosterHealthContext } from "@/lib/roster-health";
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

  try {
    const context = await buildRosterHealthContext(league.league_slug);
    return jsonResponse(
      { context: leagueContext(league), ...context },
      {
        headers: {
          "Cache-Control": cacheHeader(30, 120),
          "X-Bridge-Context": `league:${league.league_slug}`,
        },
      },
    );
  } catch (err) {
    return errorResponse(
      502,
      "roster_health_unavailable",
      err instanceof Error ? err.message : String(err),
    );
  }
}

export async function OPTIONS(): Promise<Response> {
  return handleOptions();
}
