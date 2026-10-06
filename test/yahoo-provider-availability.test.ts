/**
 * YahooProvider availability integration: capabilities, getFreeAgents /
 * getWaiverPlayers / getAvailablePlayers, and getWaiverState — deterministic,
 * Yahoo responses mocked at the global `fetch` boundary.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, describe, it } from "node:test";

import { YahooProvider } from "../lib/providers/yahoo/provider";
import { clearGameKeyCache } from "../lib/providers/yahoo/games";
import { InMemoryYahooTokenStore } from "../lib/providers/yahoo/oauth";
import { PlayerCrosswalk, NoCrosswalk } from "../lib/canonical/players";
import type { ProviderLeagueContext } from "../lib/providers/types";
import { rawLeagueMetadata, ROGERS_PARK_LEAGUE_KEY } from "./fixtures/yahoo-raw";

const ENV = {
  YAHOO_CLIENT_ID: "id",
  YAHOO_CLIENT_SECRET: "secret",
  YAHOO_REDIRECT_URI: "https://x/api/yahoo/oauth/callback",
} as unknown as NodeJS.ProcessEnv;

function store(): InMemoryYahooTokenStore {
  const s = new InMemoryYahooTokenStore();
  void s.set({ access_token: "ACCESS-SECRET", refresh_token: "REFRESH-SECRET", token_type: "bearer", scope: "fspt-r", expires_at: Date.now() + 3_600_000, yahoo_guid: "G" });
  return s;
}

const gamesBody = {
  fantasy_content: { games: { "0": { game: [{ game_key: "471", game_id: "471", code: "nfl", season: "2026" }] }, count: 1 } },
};

type Own = { type: string; date?: string; owner?: string };
function pnode(id: number, name: string, pos: string, injury: string, own?: Own) {
  const meta = [
    { player_key: `471.p.${id}` },
    { player_id: String(id) },
    { name: { full: name, first: name.split(" ")[0], last: name.split(" ")[1] } },
    { editorial_team_abbr: "CHI" },
    { bye_weeks: { week: "7" } },
    { status: injury },
    { display_position: pos },
    { eligible_positions: [{ position: pos }, { position: "W/R/T" }] },
  ];
  return { player: own ? [meta, { ownership: { ownership_type: own.type, waiver_date: own.date, owner_team_key: own.owner } }] : [meta] };
}
function page(nodes: unknown[]) {
  const players: Record<string, unknown> = { count: nodes.length };
  nodes.forEach((n, i) => (players[String(i)] = n));
  return { fantasy_content: { league: [{ league_key: ROGERS_PARK_LEAGUE_KEY }, { players }] } };
}

const POOLS: Record<string, unknown[]> = {
  FA: [pnode(1, "Free Agent", "RB", "Q")],
  W: [pnode(2, "Wait Ver", "WR", "IR", { type: "waivers", date: "2026-10-07" }), pnode(3, "Wait Two", "TE", "", { type: "waivers", date: "2026-10-07" })],
  T: [pnode(4, "Roster Guy", "RB", "", { type: "team", owner: `${ROGERS_PARK_LEAGUE_KEY}.t.7` })],
};

const urls: string[] = [];
function stub(opts: { poolOverride?: (code: string, start: number) => unknown[] | Response } = {}): void {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    urls.push(url);
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
    if (url.includes("/games;")) return json(gamesBody);
    if (url.includes("/metadata")) return json(rawLeagueMetadata);
    const m = /\/players;status=(FA|W|T);.*start=(\d+);count=(\d+)/.exec(url);
    if (m) {
      const [, code, start] = m as unknown as [string, string, string];
      const over = opts.poolOverride?.(code, Number(start));
      if (over instanceof Response) return over;
      return json(page(over ?? (Number(start) === 0 ? (POOLS[code] ?? []) : [])));
    }
    return new Response("nope", { status: 404 });
  }) as typeof fetch;
}

const original = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = original;
  clearGameKeyCache();
  urls.length = 0;
});

async function ctx(): Promise<ProviderLeagueContext> {
  return { league_slug: "rogers-park", external_league_id: "287140", season: 2026, crosswalk: await PlayerCrosswalk.create(NoCrosswalk) };
}
const provider = () => new YahooProvider({ env: ENV, tokenStore: store() });

describe("capabilities", () => {
  it("advertises free-agent and waiver support", () => {
    const c = new YahooProvider({ env: ENV }).capabilities();
    assert.equal(c.free_agents, true);
    assert.equal(c.waivers, true);
  });
});

describe("provider-level retrieval", () => {
  it("getFreeAgents queries only status=FA through the shared pool module", async () => {
    stub();
    const r = await provider().getFreeAgents(await ctx());
    assert.equal(r.status, "READY");
    assert.deepEqual(r.data!.players.map((p) => [p.player_id, p.status, p.availability]), [["1", "FA", "free_agent"]]);
    assert.ok(urls.some((u) => u.includes("/players;status=FA;")));
    assert.ok(!urls.some((u) => u.includes("status=W;") || u.includes("status=T;")));
  });

  it("getWaiverPlayers returns W with the waiver clear date and keeps injury separate", async () => {
    stub();
    const r = await provider().getWaiverPlayers(await ctx());
    const [a, b] = r.data!.players;
    assert.equal(a!.availability, "waivers");
    assert.equal(a!.waiver_clear_date, "2026-10-07");
    assert.equal(a!.injury_status, "IR"); // injury designation, NOT availability
    assert.equal(a!.status, "W");
    assert.equal(b!.injury_status, null);
    assert.ok(urls.some((u) => u.includes("status=W;") && u.includes("/ownership")));
  });

  it("available = FA + W (never rostered), with per-pool completeness metadata", async () => {
    stub();
    const r = await provider().getAvailablePlayers(await ctx(), { status: "available", all: true });
    assert.deepEqual(r.data!.players.map((p) => p.player_id).sort(), ["1", "2", "3"]);
    assert.equal(r.data!.complete, true);
    assert.equal(r.data!.pools.length, 2);
  });

  it("count-limited reads are flagged incomplete via warning", async () => {
    stub({ poolOverride: (code) => (code === "W" ? Array.from({ length: 25 }, (_, i) => pnode(100 + i, `P${i} X`, "WR", "", { type: "waivers", date: "2026-10-07" })) : []) });
    const r = await provider().getWaiverPlayers(await ctx(), { count: 25 });
    assert.equal(r.data!.complete, false);
    assert.ok(r.warnings.some((w) => w.code === "yahoo_pool_incomplete"));
  });
});

describe("getWaiverState", () => {
  it("distinguishes free_agent / waiver / rostered and preserves ids, dates, owner, injury", async () => {
    stub();
    const r = await provider().getWaiverState(await ctx());
    assert.ok(r.data);
    const byId = new Map(r.data!.players.map((p) => [p.provider_player_id, p]));
    assert.equal(byId.get("1")!.ownership, "free_agent");
    assert.equal(byId.get("1")!.waiver_clears_at, null);
    assert.equal(byId.get("1")!.injury_status, "Q"); // Q is injury, still a free agent
    assert.equal(byId.get("2")!.ownership, "waiver");
    assert.equal(byId.get("2")!.waiver_clears_at, "2026-10-07");
    assert.equal(byId.get("2")!.injury_status, "IR");
    assert.equal(byId.get("4")!.ownership, "rostered");
    assert.equal(byId.get("4")!.canonical_team_id, "team:rogers-park:7");
    assert.equal(byId.get("4")!.waiver_clears_at, null);
    assert.equal(r.data!.canonical_league_id, "league:rogers-park");
    assert.ok(!r.warnings.some((w) => w.code === "free_agent_pool_not_materialized"));
    assert.ok(!r.warnings.some((w) => w.code === "yahoo_pool_incomplete"));
  });

  it("is PARTIAL with yahoo_pool_incomplete when a pool hits the safety limit", async () => {
    // Endless full pages for W -> the safety limit stops the crawl.
    stub({ poolOverride: (code) => (code === "W" ? Array.from({ length: 25 }, (_, i) => pnode(1000 + i, `Q${i} Z`, "WR", "", { type: "waivers", date: "2026-10-07" })) : undefined as never) });
    const r = await provider().getWaiverState(await ctx());
    assert.equal(r.status, "PARTIAL");
    assert.ok(r.warnings.some((w) => w.code === "yahoo_pool_incomplete"));
  });
});

describe("error propagation", () => {
  it("maps a Yahoo 400 to a degraded result without leaking credentials", async () => {
    stub({ poolOverride: () => new Response(JSON.stringify({ error: { description: "Invalid status filter" } }), { status: 400 }) });
    const r = await provider().getFreeAgents(await ctx());
    assert.equal(r.data, null);
    assert.equal(r.status, "PROVIDER_ERROR");
    const blob = JSON.stringify(r);
    assert.ok(blob.includes("400"));
    assert.ok(!/ACCESS-SECRET|REFRESH-SECRET|Bearer/.test(blob));
  });

  it("without OAuth env, availability calls return NOT_CONFIGURED with null data", async () => {
    const p = new YahooProvider({ env: {} as NodeJS.ProcessEnv });
    for (const res of [await p.getFreeAgents(await ctx()), await p.getWaiverPlayers(await ctx()), await p.getWaiverState(await ctx())]) {
      assert.equal(res.data, null);
      assert.equal(res.status, "NOT_CONFIGURED");
    }
  });
});

describe("code reuse / route unchanged", () => {
  it("provider delegates paging to players.ts and holds no Yahoo paging/parsing logic", () => {
    const src = readFileSync("lib/providers/yahoo/provider.ts", "utf8");
    assert.match(src, /from "\.\/players"/);
    assert.ok(!/start=|count=|;status=|buildPlayersPath|YAHOO_PLAYERS_MAX_PAGES|parseYahooPoolPlayer/.test(src));
  });

  it("the /players/available route still consumes players.ts directly and exports GET", () => {
    const src = readFileSync("app/api/yahoo/leagues/[leagueId]/players/available/route.ts", "utf8");
    assert.match(src, /fetchPlayerPool/);
    assert.match(src, /fetchPlayersWithOwnership/);
    assert.match(src, /export async function GET/);
    assert.ok(!/providers\/yahoo\/provider/.test(src));
  });
});
