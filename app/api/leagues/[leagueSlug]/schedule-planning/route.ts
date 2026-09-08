/**
 * GET /api/leagues/:leagueSlug/schedule-planning
 *
 * Phase 7 — Schedule & Forward Planning Intelligence (Scope 3, SHARED_CONTEXT)
 * for EVERY manager: bye exposure, future legal-lineup coverage, weekly
 * projected-lineup vector, future roster-health pressure, regular-season
 * schedule-context vectors, playoff planning context — derived from ONE
 * canonical snapshot + ONE weekly batch + ONE ROS signal + ONE full-season
 * schedule fetch (0 extra provider reads per manager / per week).
 *
 * NOT a recommendation — no trade/waiver/lineup/start-sit/matchup score changes.
 * STRUCTURE confidence (schedule-grounded) is kept separate from VALUE
 * confidence (projection-driven) on every week-level output.
 */

import { buildSchedulePlanningContext } from "@/lib/schedule-planning";
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
    const context = await buildSchedulePlanningContext(league.league_slug);
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
      "schedule_planning_unavailable",
      err instanceof Error ? err.message : String(err),
    );
  }
}

export async function OPTIONS(): Promise<Response> {
  return handleOptions();
}
