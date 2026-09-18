/**
 * GET /api/yahoo/leagues/{leagueId}
 *
 * Validate and read one Yahoo league by its numeric id (e.g. 287140). The full
 * `{game_key}.l.{id}` key is built ONLY from the dynamically resolved game key.
 * `{leagueId}` may also be a registry slug (e.g. `rogers-park`).
 *
 * Read-only. Returns league metadata + a settings/standings/scoreboard/teams/
 * draft/transactions reachability probe. Never returns tokens.
 */

import { loadYahooSession } from "@/lib/providers/yahoo/session";
import { resolveNflGameKey } from "@/lib/providers/yahoo/games";
import { probeLeague, readOnlyLeagueProbe, probeUserTeams } from "@/lib/providers/yahoo/discovery";
import { YAHOO_TARGET_SEASON } from "@/lib/providers/yahoo/config";
import { findLeagueTarget } from "@/lib/leagues/registry";
import { cacheHeader, errorResponse, handleOptions, jsonResponse } from "@/lib/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ leagueId: string }> },
): Promise<Response> {
  const { leagueId: raw } = await params;
  const fromRegistry = findLeagueTarget(raw);
  const leagueId = fromRegistry?.provider === "yahoo" ? fromRegistry.external_league_id : raw;

  if (!/^\d+$/.test(leagueId)) {
    return errorResponse(400, "yahoo_invalid_league_id", `"${raw}" is not a Yahoo league id or a known Yahoo registry slug.`);
  }

  const session = await loadYahooSession();
  if (session.state !== "READY" || !session.client) {
    return jsonResponse(
      { provider: "yahoo", status: session.state, detail: session.detail },
      { status: session.state === "NOT_CONFIGURED" ? 503 : 409, headers: { "Cache-Control": "no-store" } },
    );
  }

  const gameKeyResult = await resolveNflGameKey(session.client, YAHOO_TARGET_SEASON, {
    overrideKey: session.config?.game_key_override ?? null,
  });
  if (!gameKeyResult.ok) {
    return jsonResponse(
      { provider: "yahoo", status: "GAME_KEY_UNRESOLVED", detail: `${gameKeyResult.kind}: ${gameKeyResult.detail}` },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }

  const probe = await probeLeague(session.client, gameKeyResult.game.game_key, leagueId);
  if (!probe.accessible) {
    return jsonResponse(
      {
        provider: "yahoo",
        status: "LEAGUE_INACCESSIBLE",
        league_key: probe.league_key,
        error_kind: probe.error_kind,
        detail: probe.detail,
      },
      { status: probe.error_kind === "FORBIDDEN" || probe.error_kind === "NOT_FOUND" ? 403 : 502, headers: { "Cache-Control": "no-store" } },
    );
  }

  const [subResources, teams] = await Promise.all([
    readOnlyLeagueProbe(session.client, probe.league_key),
    probeUserTeams(session.client, probe.league_key),
  ]);

  return jsonResponse(
    {
      provider: "yahoo",
      status: "READY",
      game_key: gameKeyResult.game.game_key,
      registry_slug: fromRegistry?.key ?? null,
      expected_name: fromRegistry?.display_name ?? null,
      name_matches: fromRegistry ? probe.league!.name === fromRegistry.display_name : null,
      league: probe.league,
      sub_resource_probe: subResources,
      user_teams: teams,
    },
    { headers: { "Cache-Control": cacheHeader(60, 300) } },
  );
}

export async function OPTIONS(): Promise<Response> {
  return handleOptions();
}
