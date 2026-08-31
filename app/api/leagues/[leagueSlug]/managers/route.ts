/**
 * GET /api/leagues/:leagueSlug/managers
 *
 * Every manager in the league, live from Sleeper, with the canonical
 * manager-scoped URLs. Routing/identity metadata only — no secrets.
 */

import {
  SleeperError,
  getLeagueDrafts,
  getLeagueRosters,
  getLeagueUsers,
} from "@/lib/sleeper/client";
import { selectActiveDraft } from "@/lib/sleeper/draft";
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
    const [rosters, users, drafts] = await Promise.all([
      getLeagueRosters(league.league_id),
      getLeagueUsers(league.league_id),
      getLeagueDrafts(league.league_id).catch(() => []),
    ]);
    const usersById = new Map(users.map((u) => [u.user_id, u]));
    const draft = selectActiveDraft(drafts);
    const draftOrder = draft?.draft_order ?? {};

    const managers = rosters
      .map((roster) => {
        const userId = roster.owner_id;
        if (!userId) {
          return {
            roster_id: roster.roster_id,
            vacant: true,
            manager_slug: null,
            url: null,
          };
        }
        const registered = findRegisteredManagerByUserId(userId);
        const user = usersById.get(userId);
        const slug =
          registered?.manager_slug ??
          managerSlugFromUsername(user?.display_name ?? userId);
        return {
          roster_id: roster.roster_id,
          vacant: false,
          manager_slug: slug,
          sleeper_username: registered?.sleeper_username ?? null,
          sleeper_user_id: userId,
          display_name: user?.display_name ?? null,
          team_name: (user?.metadata?.team_name as string | undefined) ?? null,
          draft_slot:
            typeof draftOrder[userId] === "number" ? draftOrder[userId] : null,
          registered: Boolean(registered),
          co_owner_user_ids: roster.co_owners ?? [],
          url: `/api/leagues/${league.league_slug}/managers/${slug}`,
          draft_url: `/api/leagues/${league.league_slug}/managers/${slug}/draft`,
          snapshot_url: `/api/leagues/${league.league_slug}/managers/${slug}/snapshot`,
        };
      })
      .sort((a, b) => a.roster_id - b.roster_id);

    return jsonResponse(
      {
        context: leagueContext(league),
        draft_id: draft?.draft_id ?? null,
        managers,
      },
      {
        headers: {
          "Cache-Control": cacheHeader(120, 600),
          "X-Bridge-Context": `league:${league.league_slug}`,
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
