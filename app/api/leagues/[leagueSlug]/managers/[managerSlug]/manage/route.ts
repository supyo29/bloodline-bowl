/**
 * GET /api/leagues/:leagueSlug/managers/:managerSlug/manage
 *
 * Phase 2 — ONE manager's Team-State plus the relevant opponent + league
 * context, from the SAME single canonical snapshot the league-level `/manage`
 * surface uses. Factual structural state only — no recommendations.
 */

import { buildLeagueManagementContext } from "@/lib/team-state";
import { managerContext } from "@/lib/leagues/resolve";
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
  const { manager } = resolved;

  const result = await buildLeagueManagementContext(manager.league_slug);
  if (!result.ok || !result.context) {
    return errorResponse(result.status, result.code ?? "team_state_unavailable", result.detail);
  }
  const ctx = result.context;

  // Resolve the requested manager inside the built context (same generic
  // resolver the /api/context surface uses — never a fallback pick).
  const myTeam = ctx.teams.find(
    (t) =>
      t.identity.roster_id === manager.roster_id ||
      t.identity.manager_slug.toLowerCase() === manager.manager_slug.toLowerCase() ||
      t.identity.provider_owner_id === manager.sleeper_user_id,
  );
  if (!myTeam) {
    return errorResponse(
      404,
      "manager_not_in_league",
      `Manager "${manager.manager_slug}" resolved but has no Team-State in "${manager.league_slug}".`,
    );
  }

  const oppRosterId = myTeam.matchup?.opponent_roster_id ?? null;
  const opponent = oppRosterId != null ? ctx.teams[ctx.roster_index[oppRosterId] ?? -1] ?? null : null;

  return jsonResponse(
    {
      context: managerContext(manager),
      state_source: result.state_source ?? "LEGACY_LIVE_PATH",
      ...(result.fallback_reason ? { fallback_reason: result.fallback_reason } : {}),
      version: ctx.version,
      lineage: myTeam.lineage,
      league: ctx.league,
      manager_state: myTeam,
      opponent_state: opponent,
      league_position_summary: ctx.league_position_summary,
      matchup_pairs: ctx.matchup_pairs,
    },
    {
      headers: {
        "Cache-Control": cacheHeader(30, 120),
        "X-Bridge-Context": `manager:${manager.league_slug}/${manager.manager_slug}`,
      },
    },
  );
}

export async function OPTIONS(): Promise<Response> {
  return handleOptions();
}
