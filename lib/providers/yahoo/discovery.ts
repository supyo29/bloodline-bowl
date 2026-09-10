/**
 * Read-only Yahoo Fantasy discovery + probes.
 *
 * Nothing here writes to Yahoo. Every function returns a typed, sanitized
 * result and never throws on an API error (fail-closed).
 *
 *   verifyAuthenticatedAccess  — GET /users;use_login=1/games  (proves the token works)
 *   discoverUserLeagues        — GET /users;use_login=1/games;game_codes=nfl/leagues
 *   probeLeague                — GET /league/{key}/metadata     (validate a known league id)
 *   readOnlyLeagueProbe        — metadata/settings/standings/scoreboard/teams/draft/transactions
 */

import { YahooApiError, type YahooFantasyClient } from "./client";
import { YAHOO_NFL_GAME_CODE } from "./config";
import { buildLeagueKey } from "./games";
import {
  asNumber,
  asString,
  collectionEntries,
  fantasyContent,
  mergeLeadingObjects,
  unwrap,
} from "./parse";

export interface AuthenticatedIdentity {
  ok: boolean;
  /** Opaque Yahoo account id — not a secret, but not surfaced beyond diagnostics. */
  yahoo_guid: string | null;
  nfl_seasons_seen: number[];
  detail: string;
}

export async function verifyAuthenticatedAccess(
  client: YahooFantasyClient,
): Promise<AuthenticatedIdentity> {
  try {
    const { data } = await client.get("/users;use_login=1/games;game_codes=" + YAHOO_NFL_GAME_CODE);
    const fc = fantasyContent(data);
    const users = collectionEntries(fc?.users);
    const user = users.length > 0 ? mergeLeadingObjects(unwrap(users[0], "user")) : {};
    const guid = asString(user.guid);
    const seasons = new Set<number>();
    for (const g of collectionEntries((user as Record<string, unknown>).games)) {
      const s = asNumber(mergeLeadingObjects(unwrap(g, "game")).season);
      if (s) seasons.add(s);
    }
    return {
      ok: true,
      yahoo_guid: guid,
      nfl_seasons_seen: [...seasons].sort((a, b) => a - b),
      detail: "Authenticated Yahoo Fantasy access confirmed.",
    };
  } catch (err) {
    return {
      ok: false,
      yahoo_guid: null,
      nfl_seasons_seen: [],
      detail: err instanceof YahooApiError ? `${err.kind}: ${err.message}` : String(err),
    };
  }
}

export interface DiscoveredLeague {
  league_key: string;
  league_id: string;
  name: string;
  season: number | null;
  num_teams: number | null;
  current_week: number | null;
  draft_status: string | null;
  scoring_type: string | null;
  url: string | null;
}

function parseLeagueNode(node: unknown): DiscoveredLeague | null {
  const m = mergeLeadingObjects(unwrap(node, "league"));
  const league_key = asString(m.league_key);
  const league_id = asString(m.league_id);
  const name = asString(m.name);
  if (!league_key || !league_id || !name) return null;
  return {
    league_key,
    league_id,
    name,
    season: asNumber(m.season),
    num_teams: asNumber(m.num_teams),
    current_week: asNumber(m.current_week),
    draft_status: asString(m.draft_status),
    scoring_type: asString(m.scoring_type),
    url: asString(m.url),
  };
}

export type DiscoverResult =
  | { ok: true; leagues: DiscoveredLeague[] }
  | { ok: false; kind: YahooApiError["kind"] | "MALFORMED"; detail: string };

export async function discoverUserLeagues(
  client: YahooFantasyClient,
  season: number,
): Promise<DiscoverResult> {
  try {
    const { data } = await client.get(
      `/users;use_login=1/games;game_codes=${YAHOO_NFL_GAME_CODE};seasons=${season}/leagues`,
    );
    const fc = fantasyContent(data);
    const users = collectionEntries(fc?.users);
    const leagues: DiscoveredLeague[] = [];
    for (const u of users) {
      const user = mergeLeadingObjects(unwrap(u, "user"));
      for (const g of collectionEntries((user as Record<string, unknown>).games)) {
        const game = mergeLeadingObjects(unwrap(g, "game"));
        for (const l of collectionEntries((game as Record<string, unknown>).leagues)) {
          const parsed = parseLeagueNode(l);
          if (parsed) leagues.push(parsed);
        }
      }
    }
    return { ok: true, leagues };
  } catch (err) {
    if (err instanceof YahooApiError) return { ok: false, kind: err.kind, detail: err.message };
    return { ok: false, kind: "MALFORMED", detail: String(err) };
  }
}

export interface LeagueProbe {
  requested_league_id: string;
  league_key: string;
  accessible: boolean;
  /** Present only when accessible. */
  league: DiscoveredLeague | null;
  /** Yahoo error classification when not accessible. */
  error_kind: string | null;
  detail: string;
}

export async function probeLeague(
  client: YahooFantasyClient,
  gameKey: string,
  leagueId: string,
): Promise<LeagueProbe> {
  const league_key = buildLeagueKey(gameKey, leagueId);
  try {
    const { data } = await client.get(`/league/${league_key}/metadata`);
    const fc = fantasyContent(data);
    const leagueNode = collectionEntries(fc?.leagues)[0] ?? fc?.league;
    const parsed = leagueNode ? parseLeagueNode(leagueNode) : null;
    if (!parsed) {
      return {
        requested_league_id: leagueId,
        league_key,
        accessible: false,
        league: null,
        error_kind: "MALFORMED",
        detail: "League metadata response could not be parsed.",
      };
    }
    return {
      requested_league_id: leagueId,
      league_key,
      accessible: true,
      league: parsed,
      error_kind: null,
      detail: `Yahoo confirms league "${parsed.name}".`,
    };
  } catch (err) {
    const kind = err instanceof YahooApiError ? err.kind : "NETWORK";
    return {
      requested_league_id: leagueId,
      league_key,
      accessible: false,
      league: null,
      error_kind: kind,
      detail:
        kind === "FORBIDDEN" || kind === "NOT_FOUND"
          ? "The authenticated Yahoo account cannot access this league (expected if a different account owns it)."
          : err instanceof Error
            ? err.message
            : String(err),
    };
  }
}

/** One read-only sub-resource probe result. */
export interface SubResourceProbe {
  resource: string;
  ok: boolean;
  http_status: number | null;
  error_kind: string | null;
  /** A tiny shape hint for fixture design — counts only, never raw payload. */
  note: string;
}

const LEAGUE_SUBRESOURCES = [
  "metadata",
  "settings",
  "standings",
  "scoreboard",
  "teams",
  "draftresults",
  "transactions",
] as const;

export async function readOnlyLeagueProbe(
  client: YahooFantasyClient,
  leagueKey: string,
): Promise<SubResourceProbe[]> {
  const out: SubResourceProbe[] = [];
  for (const resource of LEAGUE_SUBRESOURCES) {
    try {
      const { data, meta } = await client.get(`/league/${leagueKey}/${resource}`);
      const fc = fantasyContent(data);
      const topKeys = fc ? Object.keys(fc) : [];
      out.push({
        resource,
        ok: true,
        http_status: meta.http_status,
        error_kind: null,
        note: `fantasy_content keys: ${topKeys.join(", ") || "(none)"}`,
      });
    } catch (err) {
      out.push({
        resource,
        ok: false,
        http_status: err instanceof YahooApiError ? err.httpStatus : null,
        error_kind: err instanceof YahooApiError ? err.kind : "NETWORK",
        note: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return out;
}

/** Team-key + roster reachability for the authenticated user's own team. */
export async function probeUserTeams(
  client: YahooFantasyClient,
  leagueKey: string,
): Promise<{ ok: boolean; team_keys: string[]; roster_readable: boolean; detail: string }> {
  try {
    const { data } = await client.get(`/users;use_login=1/games;game_codes=${YAHOO_NFL_GAME_CODE}/teams`);
    const fc = fantasyContent(data);
    const teamKeys: string[] = [];
    const users = collectionEntries(fc?.users);
    for (const u of users) {
      const user = mergeLeadingObjects(unwrap(u, "user"));
      for (const g of collectionEntries((user as Record<string, unknown>).games)) {
        const game = mergeLeadingObjects(unwrap(g, "game"));
        for (const t of collectionEntries((game as Record<string, unknown>).teams)) {
          const key = asString(mergeLeadingObjects(unwrap(t, "team")).team_key);
          if (key && key.startsWith(leagueKey)) teamKeys.push(key);
        }
      }
    }
    let roster_readable = false;
    if (teamKeys[0]) {
      try {
        await client.get(`/team/${teamKeys[0]}/roster`);
        roster_readable = true;
      } catch {
        roster_readable = false;
      }
    }
    return {
      ok: true,
      team_keys: teamKeys,
      roster_readable,
      detail: teamKeys.length
        ? `Found ${teamKeys.length} team(s) for the authenticated user in this league.`
        : "The authenticated user owns no team in this league.",
    };
  } catch (err) {
    return {
      ok: false,
      team_keys: [],
      roster_readable: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}
