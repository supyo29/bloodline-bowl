/**
 * GET /api/leagues/:leagueSlug
 *
 * Canonical league overview. Reuses the exact `/api/league` payload builder and
 * adds an AI-facing `context` object plus a live-verified `manager_routes`
 * table (every roster's owner -> canonical manager URL). League-wide data only.
 */

import { SleeperError, getLeagueUsers } from "@/lib/sleeper/client";
import { buildLeagueBundle } from "@/lib/sleeper/service";
import { leagueContext } from "@/lib/leagues/resolve";
import {
  findRegisteredManagerByUserId,
  managerSlugFromUsername,
} from "@/lib/leagues/managers";
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
    const [{ response, complete }, users] = await Promise.all([
      buildLeagueBundle(league.league_id),
      getLeagueUsers(league.league_id).catch(() => []),
    ]);

    const usersById = new Map(users.map((u) => [u.user_id, u]));

    const manager_routes = response.teams
      .filter((team) => team.manager.user_id)
      .map((team) => {
        const userId = team.manager.user_id as string;
        const registered = findRegisteredManagerByUserId(userId);
        const sleeperUser = usersById.get(userId);
        const slug =
          registered?.manager_slug ??
          managerSlugFromUsername(
            sleeperUser?.display_name ?? team.manager.display_name ?? userId,
          );
        return {
          roster_id: team.roster_id,
          manager_slug: slug,
          sleeper_user_id: userId,
          display_name: team.manager.display_name,
          registered: Boolean(registered),
          url: `/api/leagues/${league.league_slug}/managers/${slug}`,
        };
      })
      .sort((a, b) => a.roster_id - b.roster_id);

    return jsonResponse(
      {
        context: leagueContext(league),
        canonical_urls: {
          draft: `/api/leagues/${league.league_slug}/draft`,
          snapshot: `/api/leagues/${league.league_slug}/snapshot`,
          scoring: `/api/leagues/${league.league_slug}/scoring`,
          managers: `/api/leagues/${league.league_slug}/managers`,
          projections: `/api/leagues/${league.league_slug}/projections`,
          state: `/api/league/${league.league_slug}/state`,
          transactions: `/api/transactions/${league.league_slug}`,
          history_template: `/api/history/${league.league_slug}/week/{week}`,
        },
        discovery: {
          ai: "/api/ai",
          manager_route_template: `/api/leagues/${league.league_slug}/managers/{managerSlug}`,
          note: "Descend to a manager for personalized roster / draft / weekly-intelligence data. Start at /api/ai for the full capability map.",
        },
        manager_routes,
        league: response,
      },
      {
        headers: {
          "Cache-Control": complete
            ? cacheHeader(300, 900)
            : cacheHeader(60, 300),
          "X-Bridge-Context": `league:${league.league_slug}`,
          "X-Bloodline-Complete": complete ? "true" : "partial",
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
