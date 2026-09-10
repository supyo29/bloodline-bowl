/**
 * Dynamic NFL game-key resolution + live league discovery — deterministic.
 * Yahoo's real (weird) `fantasy_content` array/object hybrid is reproduced in
 * the fixtures below; NO game key is hard-coded in the implementation.
 */

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import {
  buildLeagueKey,
  clearGameKeyCache,
  parseGamesResponse,
  resolveNflGameKey,
  type GameKeyResult,
} from "../lib/providers/yahoo/games";
import { discoverUserLeagues, probeLeague } from "../lib/providers/yahoo/discovery";
import { YahooApiError } from "../lib/providers/yahoo/client";

afterEach(() => clearGameKeyCache());

/** Minimal stand-in for YahooFantasyClient.get. */
function fakeClient(routes: Record<string, unknown> | ((path: string) => unknown)) {
  return {
    tokenBackend: "memory",
    async get(path: string) {
      const resolver = typeof routes === "function" ? routes : (p: string) => routes[p];
      const data = resolver(path);
      if (data instanceof Error) throw data;
      if (data === undefined) throw new YahooApiError("NOT_FOUND", `no fixture for ${path}`, 404, path);
      return { data, meta: { resource_path: path, http_status: 200, duration_ms: 1, refreshed: false, request_id: null } };
    },
  } as unknown as import("../lib/providers/yahoo/client").YahooFantasyClient;
}

const gamesBody = (season: string, gameKey = "999") => ({
  fantasy_content: {
    games: {
      "0": { game: [{ game_key: gameKey, game_id: gameKey, name: "Football", code: "nfl", type: "full", season }] },
      count: 1,
    },
  },
});

describe("parseGamesResponse", () => {
  it("resolves the NFL game key for the requested season", () => {
    const r = parseGamesResponse(gamesBody("2026", "1010"), 2026);
    assert.equal(r.ok, true);
    assert.equal((r as Extract<GameKeyResult, { ok: true }>).game.game_key, "1010");
    assert.equal((r as Extract<GameKeyResult, { ok: true }>).game.season, 2026);
    assert.equal((r as Extract<GameKeyResult, { ok: true }>).game.live, true);
  });

  it("rejects a response for the wrong season", () => {
    const r = parseGamesResponse(gamesBody("2025"), 2026);
    assert.equal(r.ok, false);
    assert.equal((r as Extract<GameKeyResult, { ok: false }>).kind, "WRONG_SEASON");
  });

  it("rejects when no NFL game is present", () => {
    const r = parseGamesResponse({ fantasy_content: { games: { count: 0 } } }, 2026);
    assert.equal(r.ok, false);
    assert.equal((r as Extract<GameKeyResult, { ok: false }>).kind, "NOT_FOUND");
  });

  it("rejects a body with no fantasy_content", () => {
    assert.equal(parseGamesResponse({}, 2026).ok, false);
  });
});

describe("resolveNflGameKey", () => {
  it("resolves dynamically from the live call and caches it", async () => {
    let calls = 0;
    const client = fakeClient((p) => {
      if (p.includes("/games;game_codes=nfl;seasons=2026")) {
        calls += 1;
        return gamesBody("2026", "1234");
      }
      return undefined;
    });
    const first = await resolveNflGameKey(client, 2026);
    assert.equal(first.ok && first.game.game_key, "1234");
    const second = await resolveNflGameKey(client, 2026);
    assert.equal(second.ok && second.game.game_key, "1234");
    assert.equal(calls, 1, "second call served from cache");
  });

  it("does NOT fall back to an override when the live call succeeds", async () => {
    const client = fakeClient(() => gamesBody("2026", "live-key"));
    const r = await resolveNflGameKey(client, 2026, { overrideKey: "operator-key" });
    assert.equal(r.ok && r.game.game_key, "live-key");
    assert.equal(r.ok && r.game.live, true);
  });

  it("falls back to an operator override ONLY when the live call fails", async () => {
    const client = fakeClient(() => new YahooApiError("SERVER", "yahoo down", 503, "/games"));
    const r = await resolveNflGameKey(client, 2026, { overrideKey: "operator-key" });
    assert.equal(r.ok && r.game.game_key, "operator-key");
    assert.equal(r.ok && r.game.live, false);
  });

  it("reports API_ERROR (not a guess) when the live call fails with no override", async () => {
    const client = fakeClient(() => new YahooApiError("SERVER", "yahoo down", 503, "/games"));
    const r = await resolveNflGameKey(client, 2026);
    assert.equal(r.ok, false);
    assert.equal((r as Extract<GameKeyResult, { ok: false }>).kind, "API_ERROR");
  });
});

describe("buildLeagueKey", () => {
  it("is {game_key}.l.{leagueId}", () => {
    assert.equal(buildLeagueKey("1234", "287140"), "1234.l.287140");
    assert.equal(buildLeagueKey("1234", "82713"), "1234.l.82713");
  });
});

const leaguesBody = (leagues: Array<{ key: string; id: string; name: string }>) => ({
  fantasy_content: {
    users: {
      "0": {
        user: [
          { guid: "GUID-USER" },
          {
            games: {
              "0": {
                game: [
                  { game_key: "1234", code: "nfl", season: "2026" },
                  {
                    leagues: {
                      ...Object.fromEntries(
                        leagues.map((l, i) => [
                          String(i),
                          { league: [{ league_key: l.key, league_id: l.id, name: l.name, season: "2026", num_teams: 12, current_week: 1, draft_status: "postdraft", scoring_type: "head" }] },
                        ]),
                      ),
                      count: leagues.length,
                    },
                  },
                ],
              },
              count: 1,
            },
          },
        ],
      },
      count: 1,
    },
  },
});

describe("discoverUserLeagues", () => {
  it("flattens every league the authenticated account belongs to", async () => {
    const client = fakeClient(() =>
      leaguesBody([
        { key: "1234.l.287140", id: "287140", name: "Rogers Park" },
        { key: "1234.l.999999", id: "999999", name: "Some Other League" },
      ]),
    );
    const r = await discoverUserLeagues(client, 2026);
    assert.equal(r.ok, true);
    assert.ok(r.ok);
    assert.deepEqual(
      r.leagues.map((l) => [l.league_id, l.name]),
      [["287140", "Rogers Park"], ["999999", "Some Other League"]],
    );
  });

  it("returns a classified error, not a throw, on an API failure", async () => {
    const client = fakeClient(() => new YahooApiError("FORBIDDEN", "no", 403, "/x"));
    const r = await discoverUserLeagues(client, 2026);
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.kind, "FORBIDDEN");
  });
});

describe("probeLeague — name verification", () => {
  const metaBody = (name: string) => ({
    fantasy_content: {
      leagues: {
        "0": { league: [{ league_key: "1234.l.287140", league_id: "287140", name, season: "2026", num_teams: 12 }] },
        count: 1,
      },
    },
  });

  it("confirms an accessible league and surfaces Yahoo's own name", async () => {
    const client = fakeClient((p) => (p.includes("/league/1234.l.287140/metadata") ? metaBody("Rogers Park") : undefined));
    const probe = await probeLeague(client, "1234", "287140");
    assert.equal(probe.accessible, true);
    assert.equal(probe.league?.name, "Rogers Park");
    assert.equal(probe.league_key, "1234.l.287140");
  });

  it("reports a clean, non-fabricated result when the account cannot access the league", async () => {
    const client = fakeClient(() => new YahooApiError("FORBIDDEN", "not a member", 403, "/league"));
    const probe = await probeLeague(client, "1234", "82713");
    assert.equal(probe.accessible, false);
    assert.equal(probe.league, null);
    assert.equal(probe.error_kind, "FORBIDDEN");
  });
});
