/**
 * Yahoo OAuth connection selection.
 *
 * A single Yahoo OAuth app can hold multiple independently-authorized Yahoo
 * accounts. Tokens are partitioned by `connection_id` in
 * public.bridge_yahoo_connections. Registry entries bind a fantasy league to
 * one of those connection ids.
 *
 * This module is deliberately tiny and pure: it validates only registered
 * Yahoo connection ids, so public routes can never create/read an arbitrary
 * token-store row from a user-supplied query parameter.
 */

import {
  findLeagueTarget,
  listLeagueTargets,
  type RegisteredLeague,
} from "@/lib/leagues/registry";

export const DEFAULT_YAHOO_CONNECTION_ID = "primary";

const CONNECTION_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export interface YahooConnectionBinding {
  connection_id: string;
  league_slugs: string[];
}

export type YahooConnectionSelection =
  | {
      ok: true;
      connection_id: string;
      league_slug: string | null;
      league: RegisteredLeague | null;
    }
  | {
      ok: false;
      status: 400 | 404;
      code: string;
      detail: string;
    };

export function listYahooConnectionBindings(): YahooConnectionBinding[] {
  const byId = new Map<string, string[]>();
  for (const league of listLeagueTargets().filter((t) => t.provider === "yahoo")) {
    const id = league.yahoo_connection_id ?? DEFAULT_YAHOO_CONNECTION_ID;
    const slugs = byId.get(id) ?? [];
    slugs.push(league.key);
    byId.set(id, slugs);
  }
  return [...byId.entries()]
    .map(([connection_id, league_slugs]) => ({
      connection_id,
      league_slugs: league_slugs.sort(),
    }))
    .sort((a, b) => a.connection_id.localeCompare(b.connection_id));
}

export function yahooLeaguesForConnection(connectionId: string): RegisteredLeague[] {
  return listLeagueTargets().filter(
    (t) =>
      t.provider === "yahoo" &&
      (t.yahoo_connection_id ?? DEFAULT_YAHOO_CONNECTION_ID) === connectionId,
  );
}

export function isRegisteredYahooConnectionId(connectionId: string): boolean {
  if (!CONNECTION_ID.test(connectionId)) return false;
  return yahooLeaguesForConnection(connectionId).length > 0;
}

/**
 * Resolve ?league=... or ?connection=...
 *
 * - ?league= is preferred for human-facing OAuth URLs.
 * - ?connection= is useful for diagnostics.
 * - when both are present they must agree.
 * - no selector preserves backward compatibility with the existing primary
 *   Rogers Park connection.
 */
export function resolveYahooConnectionSelection(
  searchParams: URLSearchParams,
): YahooConnectionSelection {
  const requestedLeague = searchParams.get("league")?.trim() || null;
  const requestedConnection = searchParams.get("connection")?.trim() || null;

  let league: RegisteredLeague | null = null;
  if (requestedLeague) {
    const found =
      findLeagueTarget(requestedLeague) ??
      findLeagueTarget(requestedLeague.toLowerCase());
    if (!found) {
      return {
        ok: false,
        status: 404,
        code: "yahoo_league_not_registered",
        detail: `No registered league matches "${requestedLeague}".`,
      };
    }
    if (found.provider !== "yahoo") {
      return {
        ok: false,
        status: 400,
        code: "yahoo_league_wrong_provider",
        detail: `League "${found.key}" uses ${found.provider}, not Yahoo.`,
      };
    }
    league = found;
  }

  const leagueConnection =
    league?.yahoo_connection_id ?? (league ? DEFAULT_YAHOO_CONNECTION_ID : null);

  if (requestedConnection && !isRegisteredYahooConnectionId(requestedConnection)) {
    return {
      ok: false,
      status: 400,
      code: "yahoo_connection_not_registered",
      detail: `Yahoo connection "${requestedConnection}" is not registered.`,
    };
  }

  if (
    requestedConnection &&
    leagueConnection &&
    requestedConnection !== leagueConnection
  ) {
    return {
      ok: false,
      status: 400,
      code: "yahoo_connection_league_mismatch",
      detail:
        `League "${league!.key}" is bound to Yahoo connection "${leagueConnection}", ` +
        `not "${requestedConnection}".`,
    };
  }

  const connectionId =
    requestedConnection ??
    leagueConnection ??
    DEFAULT_YAHOO_CONNECTION_ID;

  if (!isRegisteredYahooConnectionId(connectionId)) {
    return {
      ok: false,
      status: 400,
      code: "yahoo_connection_not_registered",
      detail: `Yahoo connection "${connectionId}" is not registered.`,
    };
  }

  return {
    ok: true,
    connection_id: connectionId,
    league_slug: league?.key ?? null,
    league,
  };
}
