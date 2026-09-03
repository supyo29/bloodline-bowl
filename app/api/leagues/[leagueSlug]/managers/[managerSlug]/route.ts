/**
 * GET /api/leagues/:leagueSlug/managers/:managerSlug
 *
 * ONE manager's identity + roster context inside ONE league. Everything here is
 * keyed off the verified `roster_id` / `sleeper_user_id` — never the first
 * roster, never a default. An unresolved or non-member manager is an explicit
 * non-200 (see lib/leagues/resolve.ts).
 */

import {
  SleeperError,
  getLeague,
  getLeagueRosters,
  getPlayerIndex,
  slimPlayer,
} from "@/lib/sleeper/client";
import {
  buildRosterComposition,
  buildSlotCoverage,
} from "@/lib/analytics/roster";
import { managerContext } from "@/lib/leagues/resolve";
import { resolveManagerRoute } from "@/lib/leagues/api";
import { managerCapabilityUrls } from "@/lib/discovery";
import { cacheHeader, errorResponse, handleOptions, jsonResponse } from "@/lib/http";
import type { NormalizedPlayer } from "@/lib/sleeper/types";

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
    const [leagueRaw, rosters, playerIndex] = await Promise.all([
      getLeague(league.league_id),
      getLeagueRosters(league.league_id),
      getPlayerIndex(),
    ]);

    const rosterPositions = leagueRaw.roster_positions ?? [];
    const roster = rosters.find((r) => r.roster_id === manager.roster_id);

    const resolveIds = (ids: string[] | null | undefined): NormalizedPlayer[] =>
      (ids ?? [])
        .filter((id): id is string => typeof id === "string" && id !== "0")
        .map((id) => playerIndex.get(id) ?? slimPlayer(id, undefined));

    const allPlayers = resolveIds(roster?.players);
    const starterIds = new Set((roster?.starters ?? []).filter((id) => id !== "0"));
    const taxiIds = new Set(roster?.taxi ?? []);
    const reserveIds = new Set(roster?.reserve ?? []);
    const starters = allPlayers.filter((p) => starterIds.has(p.player_id));
    const taxi = allPlayers.filter((p) => taxiIds.has(p.player_id));
    const reserve = allPlayers.filter((p) => reserveIds.has(p.player_id));
    const bench = allPlayers.filter(
      (p) =>
        !starterIds.has(p.player_id) &&
        !taxiIds.has(p.player_id) &&
        !reserveIds.has(p.player_id),
    );

    return jsonResponse(
      {
        context: managerContext(manager),
        canonical_urls: {
          manager: `/api/leagues/${manager.league_slug}/managers/${manager.manager_slug}`,
          league: `/api/leagues/${manager.league_slug}`,
          ...managerCapabilityUrls(manager.league_slug, manager.manager_slug),
        },
        capabilities_note:
          "canonical_urls covers every manager-specific and league-wide capability reachable from this identity. " +
          "Routes containing {week}: substitute the current NFL week (see league_state -> state.current_week). " +
          "Start at /api/ai for the full service map.",
        discovery: {
          ai: "/api/ai",
          league: `/api/leagues/${manager.league_slug}`,
          league_managers: `/api/leagues/${manager.league_slug}/managers`,
        },
        manager: {
          manager_slug: manager.manager_slug,
          requested_slug: manager.requested_slug,
          sleeper_username: manager.sleeper_username,
          sleeper_user_id: manager.sleeper_user_id,
          display_name: manager.display_name,
          team_name: manager.team_name,
          registered: manager.registered,
          is_co_owner: manager.is_co_owner,
          league_slug: manager.league_slug,
          league_id: manager.league_id,
          roster_id: manager.roster_id,
          draft_slot: manager.draft_slot,
          draft_id: manager.draft_id,
          draft_status: manager.draft_status,
        },
        roster: {
          player_count: allPlayers.length,
          players: allPlayers,
          starters,
          bench,
          taxi,
          reserve,
          composition: buildRosterComposition(
            allPlayers,
            starters,
            bench,
            taxi,
            reserve,
            rosterPositions.length,
          ),
          slot_coverage: buildSlotCoverage(allPlayers, rosterPositions),
        },
      },
      {
        headers: {
          "Cache-Control": cacheHeader(60, 300),
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
