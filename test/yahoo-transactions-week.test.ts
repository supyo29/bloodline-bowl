import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { NoCrosswalk, PlayerCrosswalk } from "../lib/canonical/players";
import { clearGameKeyCache } from "../lib/providers/yahoo/games";
import { InMemoryYahooTokenStore, type YahooToken } from "../lib/providers/yahoo/oauth";
import { YahooProvider } from "../lib/providers/yahoo/provider";
import type { ProviderLeagueContext } from "../lib/providers/types";
import {
  rawLeagueMetadata,
  rawStandings,
  rawTransactionsPage,
  ROGERS_PARK_LEAGUE_KEY,
} from "./fixtures/yahoo-raw";

const ENV = {
  YAHOO_CLIENT_ID: "id",
  YAHOO_CLIENT_SECRET: "secret",
  YAHOO_REDIRECT_URI: "https://x/api/yahoo/oauth/callback",
} as unknown as NodeJS.ProcessEnv;

const gamesBody = {
  fantasy_content: {
    games: { "0": { game: [{ game_key: "471", game_id: "471", code: "nfl", season: "2026" }] }, count: 1 },
  },
};

function connectedStore(): InMemoryYahooTokenStore {
  const store = new InMemoryYahooTokenStore();
  void store.set({
    access_token: "ACCESS",
    refresh_token: "REFRESH",
    token_type: "bearer",
    scope: "fspt-r",
    expires_at: Date.now() + 3_600_000,
    yahoo_guid: "GUID",
  } satisfies YahooToken);
  return store;
}

async function ctx(): Promise<ProviderLeagueContext> {
  return {
    league_slug: "rogers-park",
    external_league_id: "287140",
    season: 2026,
    crosswalk: await PlayerCrosswalk.create(NoCrosswalk),
  };
}

function playersBody() {
  const rows = [
    { key: "471.p.33040", id: "33040", name: "Josh Allen", team: "BUF", pos: "QB" },
    { key: "471.p.28392", id: "28392", name: "Derrick Henry", team: "BAL", pos: "RB" },
  ];
  return {
    fantasy_content: {
      players: {
        ...Object.fromEntries(rows.map((p, i) => [
          String(i),
          {
            player: [[
              { player_key: p.key },
              { player_id: p.id },
              { name: { full: p.name, first: p.name.split(" ")[0], last: p.name.split(" ").slice(1).join(" ") } },
              { editorial_team_abbr: p.team },
              { display_position: p.pos },
              { eligible_positions: [{ position: p.pos }] },
            ]],
          },
        ])),
        count: rows.length,
      },
    },
  };
}

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  clearGameKeyCache();
});

describe("Yahoo transaction week semantics", () => {
  it("returns recent transactions with an explicit warning when Yahoo cannot apply a fantasy-week filter", async () => {
    const page = rawTransactionsPage([
      {
        key: `${ROGERS_PARK_LEAGUE_KEY}.tr.53`,
        id: "53",
        type: "add/drop",
        ts: 1_758_657_346,
        adds: [{ key: "471.p.33040", dest: `${ROGERS_PARK_LEAGUE_KEY}.t.1` }],
        drops: [{ key: "471.p.28392", src: `${ROGERS_PARK_LEAGUE_KEY}.t.1` }],
      },
    ]);

    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      let data: unknown;
      if (url.includes("/games;")) data = gamesBody;
      else if (url.includes("/metadata")) data = rawLeagueMetadata;
      else if (url.includes("/standings")) data = rawStandings;
      else if (url.includes("/transactions")) data = page;
      else if (url.includes("/players;player_keys=")) data = playersBody();
      else return new Response("not found", { status: 404 });
      return new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const provider = new YahooProvider({ env: ENV, tokenStore: connectedStore() });
    const result = await provider.getTransactions(await ctx(), { week: 3, limit: 25 });

    assert.ok(result.data);
    assert.equal(result.data!.length, 1, "unsupported week filtering must not fabricate an empty feed");
    assert.equal(result.data![0]?.fantasy_week, null);
    assert.ok(result.warnings.some((w) => w.code === "week_transactions_unavailable"));
  });
});
