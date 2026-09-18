/**
 * End-to-end read-only Yahoo verification, composed from the primitives in
 * games.ts / discovery.ts. Backs GET /api/yahoo/leagues and the deeper
 * POST /api/yahoo/diagnostics. Never writes to Yahoo; never throws.
 */

import { YAHOO_TARGET_SEASON } from "./config";
import type { YahooFantasyClient } from "./client";
import { buildLeagueKey, resolveNflGameKey } from "./games";
import {
  discoverUserLeagues,
  probeLeague,
  readOnlyLeagueProbe,
  probeUserTeams,
  verifyAuthenticatedAccess,
  type DiscoveredLeague,
  type LeagueProbe,
  type SubResourceProbe,
} from "./discovery";
import { getLeagueRegistry } from "@/lib/leagues/registry";

export interface ConfiguredLeagueResult extends LeagueProbe {
  league_slug: string;
  expected_name: string;
  name_matches: boolean | null;
}

export interface YahooLeagueDiscoveryReport {
  generated_at: string;
  season: number;
  authenticated: boolean;
  authenticated_detail: string;
  yahoo_guid: string | null;
  game_key: string | null;
  game_key_live: boolean;
  game_key_detail: string;
  discovered_leagues: DiscoveredLeague[];
  configured_leagues: ConfiguredLeagueResult[];
}

/** The registry's Yahoo entries: slug + numeric id + expected display name. */
function configuredYahooLeagues(): Array<{ slug: string; id: string; name: string }> {
  return getLeagueRegistry()
    .targets.filter((t) => t.provider === "yahoo")
    .map((t) => ({ slug: t.key, id: t.external_league_id, name: t.display_name }));
}

export async function runLeagueDiscovery(
  client: YahooFantasyClient,
  opts: { season?: number; overrideKey?: string | null; forceRefresh?: boolean } = {},
): Promise<YahooLeagueDiscoveryReport> {
  const season = opts.season ?? YAHOO_TARGET_SEASON;
  const identity = await verifyAuthenticatedAccess(client);

  const gameKeyResult = await resolveNflGameKey(client, season, {
    overrideKey: opts.overrideKey ?? null,
    forceRefresh: opts.forceRefresh,
  });
  const gameKey = gameKeyResult.ok ? gameKeyResult.game.game_key : null;

  const discovered = gameKey ? await discoverUserLeagues(client, season) : { ok: false as const, kind: "MALFORMED" as const, detail: "no game key" };

  const configured: ConfiguredLeagueResult[] = [];
  if (gameKey) {
    for (const entry of configuredYahooLeagues()) {
      const probe = await probeLeague(client, gameKey, entry.id);
      configured.push({
        ...probe,
        league_slug: entry.slug,
        expected_name: entry.name,
        name_matches: probe.league ? probe.league.name === entry.name : null,
      });
    }
  }

  return {
    generated_at: new Date().toISOString(),
    season,
    authenticated: identity.ok,
    authenticated_detail: identity.detail,
    yahoo_guid: identity.yahoo_guid,
    game_key: gameKey,
    game_key_live: gameKeyResult.ok ? gameKeyResult.game.live : false,
    game_key_detail: gameKeyResult.ok
      ? `Resolved NFL ${season} game key ${gameKeyResult.game.game_key} (game_id ${gameKeyResult.game.game_id}).`
      : `${gameKeyResult.kind}: ${gameKeyResult.detail}`,
    discovered_leagues: discovered.ok ? discovered.leagues : [],
    configured_leagues: configured,
  };
}

export interface YahooDeepProbe {
  discovery: YahooLeagueDiscoveryReport;
  league_probes: Array<{
    league_slug: string;
    league_key: string;
    accessible: boolean;
    sub_resources: SubResourceProbe[];
    teams: Awaited<ReturnType<typeof probeUserTeams>> | null;
  }>;
}

export async function runDeepProbe(
  client: YahooFantasyClient,
  opts: { season?: number; overrideKey?: string | null } = {},
): Promise<YahooDeepProbe> {
  const discovery = await runLeagueDiscovery(client, opts);
  const league_probes: YahooDeepProbe["league_probes"] = [];

  for (const cfg of discovery.configured_leagues) {
    if (!cfg.accessible) {
      league_probes.push({
        league_slug: cfg.league_slug,
        league_key: cfg.league_key,
        accessible: false,
        sub_resources: [],
        teams: null,
      });
      continue;
    }
    const sub = await readOnlyLeagueProbe(client, cfg.league_key);
    const teams = await probeUserTeams(client, cfg.league_key);
    league_probes.push({
      league_slug: cfg.league_slug,
      league_key: cfg.league_key,
      accessible: true,
      sub_resources: sub,
      teams,
    });
  }

  return { discovery, league_probes };
}

export { buildLeagueKey };
