/**
 * Thin glue between the canonical path routes and the single resolver in
 * `lib/leagues/resolve.ts`. Every `/api/leagues/*` handler funnels through here
 * so error shapes, diagnostics, and the "no silent fallback" contract are
 * enforced in exactly one place.
 */

import { errorResponse } from "@/lib/http";
import type { NextResponse } from "next/server";
import {
  resolveLeagueStrict,
  resolveManagerInLeague,
  type ResolvedLeague,
  type ResolvedManager,
} from "./resolve";

/** Log the resolved identity for live-draft debugging. No secrets. */
export function logResolution(
  scope: "league" | "manager",
  data: Record<string, unknown>,
): void {
  try {
    console.info(`[bridge:resolve] ${JSON.stringify({ scope, ...data })}`);
  } catch {
    /* logging must never break a request */
  }
}

export type LeagueRouteResult =
  | { ok: true; league: ResolvedLeague }
  | { ok: false; response: NextResponse };

export async function resolveLeagueRoute(
  params: Promise<{ leagueSlug: string }>,
): Promise<LeagueRouteResult> {
  const { leagueSlug } = await params;
  const resolution = resolveLeagueStrict(leagueSlug);
  if (!resolution.ok) {
    return {
      ok: false,
      response: errorResponse(
        resolution.status,
        resolution.code,
        resolution.detail,
      ),
    };
  }
  logResolution("league", {
    league_slug: resolution.league.league_slug,
    league_id: resolution.league.league_id,
  });
  return { ok: true, league: resolution.league };
}

export type ManagerRouteResult =
  | { ok: true; league: ResolvedLeague; manager: ResolvedManager }
  | { ok: false; response: NextResponse };

export async function resolveManagerRoute(
  params: Promise<{ leagueSlug: string; managerSlug: string }>,
): Promise<ManagerRouteResult> {
  const { leagueSlug, managerSlug } = await params;

  const leagueResolution = resolveLeagueStrict(leagueSlug);
  if (!leagueResolution.ok) {
    return {
      ok: false,
      response: errorResponse(
        leagueResolution.status,
        leagueResolution.code,
        leagueResolution.detail,
      ),
    };
  }

  const managerResolution = await resolveManagerInLeague(
    leagueResolution.league,
    managerSlug,
  );
  if (!managerResolution.ok) {
    logResolution("manager", {
      league_slug: leagueResolution.league.league_slug,
      requested_manager: managerSlug,
      outcome: managerResolution.code,
    });
    return {
      ok: false,
      response: errorResponse(
        managerResolution.status,
        managerResolution.code,
        managerResolution.detail,
      ),
    };
  }

  logResolution("manager", {
    league_slug: managerResolution.manager.league_slug,
    league_id: managerResolution.manager.league_id,
    manager_slug: managerResolution.manager.manager_slug,
    sleeper_username: managerResolution.manager.sleeper_username,
    sleeper_user_id: managerResolution.manager.sleeper_user_id,
    roster_id: managerResolution.manager.roster_id,
    draft_slot: managerResolution.manager.draft_slot,
    draft_id: managerResolution.manager.draft_id,
  });

  return {
    ok: true,
    league: leagueResolution.league,
    manager: managerResolution.manager,
  };
}
