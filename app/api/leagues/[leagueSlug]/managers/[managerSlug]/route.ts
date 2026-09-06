/**
 * GET /api/leagues/:leagueSlug/managers/:managerSlug
 *
 * ONE manager's identity + roster context inside ONE league. Everything here is
 * keyed off the verified `roster_id` / `sleeper_user_id` — never the first
 * roster, never a default. An unresolved or non-member manager is an explicit
 * non-200 (see lib/leagues/resolve.ts).
 *
 * Phase 1C: the roster SPLIT (starters / bench / IR / taxi) + roster settings
 * come from the ONE canonical live read — canonical owns "which player is in
 * which slot", so this surface can never disagree with weekly / trade / state.
 * `getPlayerIndex` remains ONLY as provider ENRICHMENT: it adds the Sleeper
 * per-player bio (`age`, `years_exp`, `search_rank`, `depth_chart_*`) that the
 * canonical model does not carry. It does not re-derive any canonical fact.
 */

import { SleeperError, getPlayerIndex, slimPlayer } from "@/lib/sleeper/client";
import { buildCanonicalLeagueState } from "@/lib/canonical/state";
import { runInLeagueStateScope } from "@/lib/canonical/request-scope";
import { reconstructRosterPositions } from "@/lib/canonical/compat/scoring-inputs";
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
    return await runInLeagueStateScope(async () => {
    const [state, playerIndex] = await Promise.all([
      buildCanonicalLeagueState(league.league_slug),
      getPlayerIndex(),
    ]);
    const snapshot = state.snapshot;
    if (
      !snapshot ||
      snapshot.live_provider_status === "PROVIDER_ERROR" ||
      snapshot.league.team_count === 0
    ) {
      return errorResponse(
        502,
        "sleeper_upstream_error",
        state.detail ?? "Canonical league state is unavailable.",
      );
    }

    const rosterPositions = reconstructRosterPositions(snapshot.league.roster_settings);
    const canonicalTeam = snapshot.teams.find(
      (t) => Number(t.provider_team_id) === manager.roster_id,
    );
    const roster = canonicalTeam
      ? snapshot.rosters.find((r) => r.canonical_team_id === canonicalTeam.canonical_team_id)
      : undefined;
    const playerById = new Map(snapshot.players.map((p) => [p.canonical_player_id, p]));

    // Canonical owns the SPLIT. `getPlayerIndex` only enriches each id with the
    // provider bio (slimPlayer is the honest stub when Sleeper lacks the id).
    const toNormalized = (cids: string[]): NormalizedPlayer[] =>
      cids
        .map((cid) => {
          const p = playerById.get(cid);
          const sid =
            p?.identifiers.sleeper_id ??
            (cid.startsWith("player:sleeper:") ? cid.slice("player:sleeper:".length) : null);
          return sid ? (playerIndex.get(sid) ?? slimPlayer(sid, undefined)) : null;
        })
        .filter((p): p is NormalizedPlayer => p !== null);

    const allPlayers = toNormalized(roster?.all_players ?? []);
    const starters = toNormalized(roster?.starters ?? []);
    const bench = toNormalized(roster?.bench ?? []);
    const taxi = toNormalized(roster?.taxi ?? []);
    const reserve = toNormalized(roster?.ir ?? []);

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
    });
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
