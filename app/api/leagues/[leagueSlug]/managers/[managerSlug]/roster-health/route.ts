/**
 * GET /api/leagues/:leagueSlug/managers/:managerSlug/roster-health
 *
 * Phase 6 — one manager's slice of the league-wide Roster Health context.
 * Same single-read derivation; league-relative percentiles are still computed
 * across all 12 teams (spec §16). SHARED_CONTEXT — not a recommendation.
 */

import { buildRosterHealthContext } from "@/lib/roster-health";
import { resolveManagerRoute } from "@/lib/leagues/api";
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
  const { league, manager } = resolved;

  try {
    const context = await buildRosterHealthContext(league.league_slug);
    const idx = context.roster_index[manager.roster_id];
    const team = idx != null ? context.teams[idx] : context.teams.find((t) => t.manager_slug === manager.manager_slug);
    if (!team) {
      return errorResponse(404, "manager_roster_health_not_found", `No roster-health for roster_id ${manager.roster_id}.`);
    }
    return jsonResponse(
      {
        roster_health_version: context.roster_health_version,
        lineage: context.lineage,
        league_slug: context.league_slug,
        season: context.season,
        week: context.week,
        team,
        warnings: context.warnings,
      },
      {
        headers: {
          "Cache-Control": cacheHeader(30, 120),
          "X-Bridge-Context": `manager:${manager.manager_slug}`,
        },
      },
    );
  } catch (err) {
    return errorResponse(502, "roster_health_unavailable", err instanceof Error ? err.message : String(err));
  }
}

export async function OPTIONS(): Promise<Response> {
  return handleOptions();
}
