/**
 * GET /api/leagues/:leagueSlug/managers/:managerSlug/snapshot
 *
 * The personalized snapshot: compact SHARED league state (identity, draft
 * status, standings) composed with ONE manager's personalized state (roster,
 * roster id, draft slot, picks, positional needs, recommendations).
 *
 * A draft-night hand-off document — a client can paste one permanent URL and
 * get the correct league AND the correct manager every time.
 */

import {
  SleeperError,
  getLeague,
  getLeagueRosters,
  getLeagueUsers,
} from "@/lib/sleeper/client";
import { computeStandings } from "@/lib/analytics/standings";
import { buildManagerDraftContext } from "@/lib/leagues/manager-draft";
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

  try {
    const [draftContext, leagueRaw, rosters, users] = await Promise.all([
      buildManagerDraftContext(manager, {
        availableLimit: 60,
        recommendationCount: 12,
      }),
      getLeague(manager.league_id),
      getLeagueRosters(manager.league_id),
      getLeagueUsers(manager.league_id),
    ]);

    const rc = draftContext.manager.recommendation_context;
    if (
      rc.used_roster_id !== manager.roster_id ||
      rc.used_sleeper_user_id !== manager.sleeper_user_id
    ) {
      return errorResponse(
        500,
        "manager_context_mismatch",
        "Recommendation engine resolved a different manager than the request.",
      );
    }

    const standings = computeStandings(rosters, users, new Map(), []);

    return jsonResponse(
      {
        context: managerContext(manager),
        snapshot_scope: "manager",
        league: {
          league_slug: manager.league_slug,
          league_id: manager.league_id,
          name: leagueRaw.name,
          season: leagueRaw.season,
          status: leagueRaw.status,
          team_count: leagueRaw.total_rosters,
          roster_positions: leagueRaw.roster_positions ?? [],
        },
        draft: draftContext.draft,
        standings,
        board: draftContext.board,
        available_players: draftContext.available_players.slice(0, 30),
        manager: draftContext.manager,
      },
      {
        headers: {
          "Cache-Control":
            draftContext.draft.status === "drafting"
              ? cacheHeader(5, 15)
              : cacheHeader(30, 120),
          "X-Bridge-Context": `manager:${manager.league_slug}/${manager.manager_slug}`,
        },
      },
    );
  } catch (error) {
    if (error instanceof SleeperError) {
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
