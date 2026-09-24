/**
 * YahooProvider — live READY path + degraded-state contract, deterministic.
 *
 * `YahooProvider` builds its own `YahooFantasyClient` internally (no injected
 * `fetchImpl`), so this stubs the global `fetch` for the duration of each test
 * — the same boundary a real deployment crosses, just routed to fixtures
 * instead of the network. Proves:
 *   - the full getLeagueState() READY path end-to-end (game-key resolution ->
 *     league-key build -> accessibility probe -> fetch/flatten -> canonical
 *     conversion) against Rogers Park's shape,
 *   - the honest degraded paths this phase added: FORBIDDEN (Maclin-style),
 *     game-key resolution failure, and league-identity mismatch,
 *   - Rogers Park and a Maclin-style forbidden league never contaminate each
 *     other's result.
 */

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { YahooProvider } from "../lib/providers/yahoo/provider";
import { clearGameKeyCache } from "../lib/providers/yahoo/games";
import { InMemoryYahooTokenStore, type YahooToken } from "../lib/providers/yahoo/oauth";
import { PlayerCrosswalk, NoCrosswalk } from "../lib/canonical/players";
import type { ProviderLeagueContext } from "../lib/providers/types";
import {
  rawDraftResults,
  rawLeagueMetadata,
  rawLeagueSettings,
  rawStandings,
  rawTeamRoster,
  ROGERS_PARK_LEAGUE_KEY,
} from "./fixtures/yahoo-raw";

const ENV = {
  YAHOO_CLIENT_ID: "id",
  YAHOO_CLIENT_SECRET: "secret",
  YAHOO_REDIRECT_URI: "https://x/api/yahoo/oauth/callback",
} as unknown as NodeJS.ProcessEnv;

function connectedStore(): InMemoryYahooTokenStore {
  const s = new InMemoryYahooTokenStore();
  void s.set({
    access_token: "ACCESS-1",
    refresh_token: "REFRESH-1",
    token_type: "bearer",
    scope: "fspt-r",
    expires_at: Date.now() + 3_600_000,
    yahoo_guid: "GUID",
  } satisfies YahooToken);
  return s;
}

const gamesBody = {
  fantasy_content: {
    games: { "0": { game: [{ game_key: "471", game_id: "471", code: "nfl", season: "2026" }] }, count: 1 },
  },
};

/** Route a URL to canned JSON by substring match on the request path. */
function stubFetch(routes: (url: string) => unknown): void {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const data = routes(url);
    if (data === undefined) return new Response("not found", { status: 404 });
    if (data instanceof Response) return data;
    return new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  // resolveNflGameKey caches by season at module scope — clear it so one
  // test's successful resolution can't mask the next test's failure fixture.
  clearGameKeyCache();
});

/**
 * With `NoCrosswalk` (no real crosswalk rows backing this test), every player
 * legitimately resolves as "unresolved identity" — real, honest data, just
 * flagged, so the status is PARTIAL rather than READY. Assert it's one of the
 * two "has real data" states, never a degraded/empty one.
 */
function assertHasRealData(status: string): void {
  assert.ok(status === "READY" || status === "PARTIAL", `expected READY or PARTIAL, got ${status}`);
}

async function ctxFor(slug: string, externalId: string): Promise<ProviderLeagueContext> {
  return {
    league_slug: slug,
    external_league_id: externalId,
    season: 2026,
    crosswalk: await PlayerCrosswalk.create(NoCrosswalk),
  };
}

/** Every Yahoo resource Rogers Park's getLeagueState() needs, wired to fixtures. */
function rogersParkRoutes(url: string): unknown {
  const t1 = `${ROGERS_PARK_LEAGUE_KEY}.t.1`;
  const t2 = `${ROGERS_PARK_LEAGUE_KEY}.t.2`;
  if (url.includes("/games;")) return gamesBody;
  if (url.includes("/league/") && url.includes("/metadata")) return rawLeagueMetadata;
  if (url.includes("/settings")) return rawLeagueSettings;
  if (url.includes("/standings")) return rawStandings;
  if (url.includes(`/team/${t1}/roster`)) {
    return rawTeamRoster(t1, [{ key: "471.p.33040", id: "33040", name: "Josh Allen", team: "BUF", pos: "QB", slot: "QB" }]);
  }
  if (url.includes(`/team/${t2}/roster`)) {
    return rawTeamRoster(t2, [{ key: "471.p.28392", id: "28392", name: "Derrick Henry", team: "BAL", pos: "RB", slot: "RB" }]);
  }
  if (url.includes("/draftresults")) return rawDraftResults;
  return undefined;
}

describe("YahooProvider.getLeagueState — Rogers Park READY path", () => {
  it("produces a real, populated canonical bundle — no yahoo_fetch_unimplemented, no zeros", async () => {
    stubFetch(rogersParkRoutes);
    const provider = new YahooProvider({ env: ENV, tokenStore: connectedStore() });
    const res = await provider.getLeagueState(await ctxFor("rogers-park", "287140"));

    assertHasRealData(res.status);
    assert.ok(res.data, "expected a populated bundle, not null");
    const bundle = res.data!;
    assert.equal(bundle.league.name, "Rogers Park");
    assert.equal(bundle.league.season, 2026);
    assert.equal(bundle.league.team_count, 10);
    assert.equal(bundle.league.current_week, 3);
    assert.notEqual(bundle.league.current_week, 0);
    assert.equal(bundle.teams.length, 2);
    assert.notEqual(bundle.teams.length, 0);
    assert.equal(bundle.managers.length, 2);
    assert.equal(bundle.rosters.length, 2);
    assert.ok(bundle.rosters.every((r) => r.all_players.length > 0));
    assert.equal(bundle.players.length, 2);
    assert.equal(bundle.draft_picks.length, 2);
    assert.ok(!res.warnings.some((w) => w.code === "yahoo_fetch_unimplemented"));
    // Scoring settings are genuinely mapped, not opaque Yahoo ids.
    assert.equal(bundle.league.raw_scoring.pass_td, 6);
    assert.ok(bundle.league.scoring_fingerprint);
  });

  it("getManagers / getStandings / getRosters / getDraftResults all resolve from the same live read", async () => {
    stubFetch(rogersParkRoutes);
    const provider = new YahooProvider({ env: ENV, tokenStore: connectedStore() });
    const ctx = await ctxFor("rogers-park", "287140");
    const [managers, standings, rosters, draft] = await Promise.all([
      provider.getManagers(ctx),
      provider.getStandings(ctx),
      provider.getRosters(ctx),
      provider.getDraftResults(ctx),
    ]);
    assertHasRealData(managers.status);
    assert.equal(managers.data!.length, 2);
    assertHasRealData(standings.status);
    assert.equal(standings.data!.length, 2);
    assertHasRealData(rosters.status);
    assert.equal(rosters.data!.length, 2);
    assertHasRealData(draft.status);
    assert.equal(draft.data!.length, 2);
  });
});

describe("YahooProvider.getLeagueState — degraded paths never fabricate", () => {
  it("FORBIDDEN (Maclin-style): the connected account cannot access this league", async () => {
    stubFetch((url) => {
      if (url.includes("/games;")) return gamesBody;
      if (url.includes("/metadata")) return new Response("forbidden", { status: 403 });
      return undefined;
    });
    const provider = new YahooProvider({ env: ENV, tokenStore: connectedStore() });
    const res = await provider.getLeagueState(await ctxFor("maclin-on-chicks-xvi", "82713"));
    assert.equal(res.data, null);
    assert.equal(res.status, "AUTH_REQUIRED");
    assert.equal(res.warnings[0]?.code, "yahoo_league_inaccessible");
  });

  it("game key resolution failure fails closed rather than guessing a game key", async () => {
    stubFetch((url) => {
      if (url.includes("/games;")) return new Response("server error", { status: 500 });
      return undefined;
    });
    const provider = new YahooProvider({ env: ENV, tokenStore: connectedStore() });
    const res = await provider.getLeagueState(await ctxFor("rogers-park", "287140"));
    assert.equal(res.data, null);
    assert.equal(res.status, "PROVIDER_ERROR");
  });

  it("league-identity mismatch: Yahoo returning a different league id is refused, not substituted", async () => {
    stubFetch((url) => {
      if (url.includes("/games;")) return gamesBody;
      if (url.includes("/metadata")) {
        return {
          fantasy_content: {
            leagues: { "0": { league: [{ league_key: "471.l.999999", league_id: "999999", name: "Some Other League", season: "2026", num_teams: 8 }] }, count: 1 },
          },
        };
      }
      return undefined;
    });
    const provider = new YahooProvider({ env: ENV, tokenStore: connectedStore() });
    const res = await provider.getLeagueState(await ctxFor("rogers-park", "287140"));
    assert.equal(res.data, null);
    assert.equal(res.status, "PROVIDER_ERROR");
    assert.equal(res.warnings[0]?.code, "yahoo_league_identity_mismatch");
  });

  it("Rogers Park READY and Maclin FORBIDDEN are independent — one never contaminates the other", async () => {
    stubFetch((url) => {
      if (url.includes("/games;")) return gamesBody;
      if (url.includes("/league/") && url.includes("287140") && url.includes("/metadata")) {
        return { fantasy_content: { leagues: { "0": { league: [{ league_key: "471.l.287140", league_id: "287140", name: "Rogers Park", season: "2026", num_teams: 10 }] } }, count: 1 } };
      }
      if (url.includes("82713")) return new Response("forbidden", { status: 403 });
      return rogersParkRoutes(url);
    });
    const provider = new YahooProvider({ env: ENV, tokenStore: connectedStore() });
    const [rp, mc] = await Promise.all([
      provider.getLeagueState(await ctxFor("rogers-park", "287140")),
      provider.getLeagueState(await ctxFor("maclin-on-chicks-xvi", "82713")),
    ]);
    assertHasRealData(rp.status);
    assert.equal(rp.data!.league.name, "Rogers Park");
    assert.equal(mc.status, "AUTH_REQUIRED");
    assert.equal(mc.data, null);
  });
});
