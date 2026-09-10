/**
 * Dynamic NFL game-key resolution.
 *
 * Yahoo league keys are `{game_key}.l.{league_id}` and the `game_key` is
 * SEASON-SPECIFIC (2024 NFL = 449, 2025 = 461, 2026 = TBD by Yahoo). It is
 * NEVER hard-coded here. It is resolved from:
 *
 *   GET /games;game_codes=nfl;seasons=2026
 *
 * and cached for the lifetime of the serverless instance (it is stable season
 * metadata). `YAHOO_GAME_KEY` may override for offline dev but a live
 * resolution always wins and is validated against the requested season.
 */

import { YahooApiError, type YahooFantasyClient } from "./client";
import { YAHOO_NFL_GAME_CODE } from "./config";
import {
  asNumber,
  asString,
  collectionEntries,
  fantasyContent,
  mergeLeadingObjects,
  unwrap,
} from "./parse";

export interface ResolvedGame {
  game_key: string;
  game_id: string;
  code: string;
  season: number;
  /** True when this came from the live API (vs an operator override). */
  live: boolean;
}

export type GameKeyResult =
  | { ok: true; game: ResolvedGame }
  | {
      ok: false;
      kind: "NOT_FOUND" | "WRONG_SEASON" | "MALFORMED" | "API_ERROR";
      detail: string;
      /** For `API_ERROR`: the underlying `YahooApiError.kind` (e.g. "FORBIDDEN"). */
      api_error_kind?: string;
      /** For `API_ERROR`: the raw classified error, for taxonomy mapping. Not serialized. */
      error?: unknown;
    };

const cache = new Map<string, ResolvedGame>();

export function clearGameKeyCache(): void {
  cache.clear();
}

/** Parse the `/games;game_codes=nfl;seasons=<season>` response body. */
export function parseGamesResponse(body: unknown, season: number): GameKeyResult {
  const fc = fantasyContent(body);
  const gamesNode = fc?.games;
  if (!fc || gamesNode === undefined) {
    return { ok: false, kind: "MALFORMED", detail: "Response had no fantasy_content.games." };
  }
  for (const entry of collectionEntries(gamesNode)) {
    const merged = mergeLeadingObjects(unwrap(entry, "game"));
    const code = asString(merged.code);
    const gameSeason = asNumber(merged.season);
    const gameKey = asString(merged.game_key);
    const gameId = asString(merged.game_id);
    if (code !== YAHOO_NFL_GAME_CODE) continue;
    if (gameSeason !== season) {
      return {
        ok: false,
        kind: "WRONG_SEASON",
        detail: `Yahoo returned NFL game for season ${gameSeason ?? "?"}, expected ${season}.`,
      };
    }
    if (!gameKey || !gameId) {
      return { ok: false, kind: "MALFORMED", detail: "NFL game entry lacked game_key/game_id." };
    }
    return {
      ok: true,
      game: { game_key: gameKey, game_id: gameId, code, season, live: true },
    };
  }
  return {
    ok: false,
    kind: "NOT_FOUND",
    detail: `No NFL game found for season ${season} in the Yahoo response.`,
  };
}

export async function resolveNflGameKey(
  client: YahooFantasyClient,
  season: number,
  opts: { forceRefresh?: boolean; overrideKey?: string | null } = {},
): Promise<GameKeyResult> {
  const cacheKey = `nfl:${season}`;
  if (!opts.forceRefresh) {
    const hit = cache.get(cacheKey);
    if (hit) return { ok: true, game: hit };
  }

  let body: unknown;
  try {
    body = (await client.get(`/games;game_codes=${YAHOO_NFL_GAME_CODE};seasons=${season}`)).data;
  } catch (err) {
    if (err instanceof YahooApiError) {
      // Fall back to an explicit operator override ONLY if the live call failed.
      if (opts.overrideKey) {
        const game: ResolvedGame = {
          game_key: opts.overrideKey,
          game_id: opts.overrideKey,
          code: YAHOO_NFL_GAME_CODE,
          season,
          live: false,
        };
        return { ok: true, game };
      }
      return {
        ok: false,
        kind: "API_ERROR",
        detail: `Yahoo Fantasy API ${err.kind} (HTTP ${err.httpStatus ?? "?"}) resolving the ${season} NFL game key.`,
        api_error_kind: err.kind,
        error: err,
      };
    }
    return {
      ok: false,
      kind: "API_ERROR",
      detail: err instanceof Error ? err.message : String(err),
      error: err,
    };
  }

  const parsed = parseGamesResponse(body, season);
  if (parsed.ok) cache.set(cacheKey, parsed.game);
  return parsed;
}

/** `{game_key}.l.{leagueId}` — only ever built from a resolved game key. */
export function buildLeagueKey(gameKey: string, leagueId: string): string {
  return `${gameKey}.l.${leagueId}`;
}
