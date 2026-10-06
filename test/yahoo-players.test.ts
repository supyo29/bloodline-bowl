/**
 * Yahoo player pool (free agents / waivers / rostered): pagination, labeling,
 * ownership fallback, and diagnostics — deterministic, no network.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { YahooApiError, YahooFantasyClient, extractYahooErrorMessage } from "../lib/providers/yahoo/client";
import { InMemoryYahooTokenStore } from "../lib/providers/yahoo/oauth";
import {
  buildPlayersPath,
  fetchPlayerPool,
  fetchPlayersWithOwnership,
  parseYahooPoolPlayer,
  sanitizePosition,
} from "../lib/providers/yahoo/players";

const LK = "471.l.287140";
const CONFIG = { client_id: "id", client_secret: "secret", redirect_uri: "https://x/cb", scope: "fspt-r", game_key_override: null };

function client(handler: (url: string) => { status?: number; body: unknown }): { c: YahooFantasyClient; urls: string[] } {
  const store = new InMemoryYahooTokenStore();
  void store.set({ access_token: "A", refresh_token: "R", token_type: "bearer", scope: "fspt-r", expires_at: Date.now() + 3_600_000, yahoo_guid: "G" });
  const urls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    urls.push(url);
    const { status = 200, body } = handler(url);
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  }) as typeof fetch;
  return { c: new YahooFantasyClient({ config: CONFIG, store, fetchImpl }), urls };
}

function playerNode(id: number, opts: { pos?: string; own?: { type: string; waiver_date?: string; owner?: string }; injury?: string } = {}) {
  const meta = [
    { player_key: `471.p.${id}` },
    { player_id: String(id) },
    { name: { full: `Player ${id}`, first: "Player", last: String(id) } },
    { editorial_team_abbr: "CHI" },
    { bye_weeks: { week: "7" } },
    { status: opts.injury ?? "" },
    { display_position: opts.pos ?? "RB" },
    { eligible_positions: [{ position: opts.pos ?? "RB" }, { position: "W/R/T" }] },
  ];
  return opts.own
    ? { player: [meta, { ownership: { ownership_type: opts.own.type, waiver_date: opts.own.waiver_date, owner_team_key: opts.own.owner } }] }
    : { player: [meta] };
}

function page(nodes: unknown[]) {
  const players: Record<string, unknown> = { count: nodes.length };
  nodes.forEach((n, i) => (players[String(i)] = n));
  return { fantasy_content: { league: [{ league_key: LK }, { players }] } };
}

/** A pool of `total` players served in Yahoo-style pages. */
function pooled(total: number, mk: (id: number) => unknown = (id) => playerNode(id)) {
  return (url: string) => {
    const start = Number(/start=(\d+)/.exec(url)?.[1]);
    const count = Math.min(25, Number(/count=(\d+)/.exec(url)?.[1]));
    const nodes: unknown[] = [];
    for (let i = start; i < Math.min(total, start + count); i++) nodes.push(mk(1000 + i));
    return { body: page(nodes) };
  };
}

describe("buildPlayersPath", () => {
  it("builds a status/position/search/paging path and appends ownership", () => {
    assert.equal(
      buildPlayersPath(LK, { status: "FA", position: "RB", start: 25, count: 25 }, false),
      `/league/${LK}/players;status=FA;position=RB;start=25;count=25;sort=OR`,
    );
    assert.match(buildPlayersPath(LK, { status: "W", search: "Bijan Robinson", start: 0, count: 25 }, true), /search=Bijan%20Robinson;.*\/ownership$/);
  });
  it("sanitizes positions", () => {
    assert.equal(sanitizePosition("rb"), "RB");
    assert.equal(sanitizePosition("RB;status=T"), null);
  });
});

describe("parseYahooPoolPlayer", () => {
  it("maps Yahoo fields, keeps injury status separate from availability, reads waiver_date", () => {
    const p = parseYahooPoolPlayer(playerNode(7, { injury: "Q", own: { type: "waivers", waiver_date: "2026-10-08" } }), "W")!;
    assert.equal(p.player_id, "7");
    assert.equal(p.status, "W");
    assert.equal(p.availability, "waivers");
    assert.equal(p.injury_status, "Q");
    assert.equal(p.waiver_clear_date, "2026-10-08");
    assert.equal(p.bye_week, 7);
    assert.deepEqual(p.eligible_positions, ["RB", "W/R/T"]);
    assert.equal(p.first_name, "Player");
  });
  it("does not fabricate a waiver date", () => {
    assert.equal(parseYahooPoolPlayer(playerNode(8), "FA")!.waiver_clear_date, null);
  });
});

describe("fetchPlayerPool pagination", () => {
  it("walks across page boundaries until a short page and reports complete", async () => {
    const { c, urls } = client(pooled(137));
    const r = await fetchPlayerPool(c, LK, { status: "FA", start: 0, count: null });
    assert.equal(r.players.length, 137);
    assert.equal(r.complete, true);
    assert.equal(r.stopped_reason, "end_of_pool");
    assert.equal(new Set(r.players.map((p) => p.player_key)).size, 137);
    assert.ok(urls.length >= 6); // 137 players = 6 pages (5 full + 1 short)
    assert.ok(urls.every((u) => u.includes("format=json")));
  });
  it("handles a pool that is an exact multiple of the page size", async () => {
    const { c } = client(pooled(50));
    const r = await fetchPlayerPool(c, LK, { status: "FA", start: 0, count: null });
    assert.equal(r.players.length, 50);
    assert.equal(r.complete, true);
  });
  it("count-limited reads are not complete and expose next_start", async () => {
    const { c } = client(pooled(137));
    const r = await fetchPlayerPool(c, LK, { status: "FA", start: 0, count: 60 });
    assert.equal(r.players.length, 60);
    assert.equal(r.complete, false);
    assert.equal(r.next_start, 60);
    assert.equal(r.stopped_reason, "count_reached");
  });
  it("honors the safety limit and says it is incomplete", async () => {
    const { c } = client(pooled(10_000));
    const r = await fetchPlayerPool(c, LK, { status: "FA", start: 0, count: null, maxPages: 8 });
    assert.equal(r.complete, false);
    assert.equal(r.stopped_reason, "safety_limit");
    assert.equal(r.players.length, 200);
    assert.equal(r.next_start, 200);
  });
  it("drops rows Yahoo's ownership says are rostered inside a W query", async () => {
    const { c } = client(pooled(4, (id) => playerNode(id, { own: { type: id === 1001 ? "team" : "waivers", waiver_date: "2026-10-08" } })));
    const r = await fetchPlayerPool(c, LK, { status: "W", start: 0, count: null, withOwnership: true });
    assert.equal(r.players.length, 3);
    assert.equal(r.dropped_rostered, 1);
    assert.ok(r.players.every((p) => p.availability === "waivers" && p.waiver_clear_date === "2026-10-08"));
  });
  it("falls back without the ownership sub-resource when Yahoo rejects it", async () => {
    const { c, urls } = client((url) => (url.includes("/ownership") ? { status: 400, body: { error: { description: "bad sub-resource" } } } : pooled(3)(url)));
    const r = await fetchPlayerPool(c, LK, { status: "W", start: 0, count: null, withOwnership: true });
    assert.equal(r.players.length, 3);
    assert.equal(r.ownership, "unavailable_fell_back");
    assert.ok(urls.some((u) => u.includes("/ownership")));
  });
});

describe("fetchPlayersWithOwnership", () => {
  it("classifies freeagents / waivers / team", async () => {
    const types = ["freeagents", "waivers", "team"];
    const { c } = client(() => ({
      body: page(types.map((t, i) => playerNode(1 + i, { own: { type: t, owner: t === "team" ? "471.l.287140.t.3" : undefined } }))),
    }));
    const r = await fetchPlayersWithOwnership(c, LK, ["471.p.1", "471.p.2", "471.p.3"]);
    assert.deepEqual(r.players.map((p) => p.status), ["FA", "W", "T"]);
    assert.equal(r.players[2]?.owner_team_key, "471.l.287140.t.3");
  });
});

describe("fetchPlayersWithOwnership unknown ids", () => {
  it("retries per key when Yahoo 400s the batch and reports the unknown key", async () => {
    const { c } = client((url) =>
      url.includes("470.p.999")
        ? { status: 400, body: { error: { description: "Player key 470.p.999 does not exist." } } }
        : { body: page([playerNode(1, { own: { type: "waivers", waiver_date: "2026-10-07" } })]) },
    );
    const r = await fetchPlayersWithOwnership(c, LK, ["471.p.1", "470.p.999"]);
    assert.equal(r.players.length, 1);
    assert.deepEqual(r.unclassified, ["470.p.999"]);
  });
});

describe("diagnostics", () => {
  it("surfaces Yahoo's message, status and path without credentials", async () => {
    const { c } = client(() => ({ status: 400, body: { error: { description: "Invalid status filter" } } }));
    await assert.rejects(
      () => c.get(`/league/${LK}/players;status=ZZ`),
      (e: unknown) => {
        assert.ok(e instanceof YahooApiError);
        assert.equal(e.httpStatus, 400);
        assert.equal(e.yahooMessage, "Invalid status filter");
        assert.equal(e.resourcePath, `/league/${LK}/players;status=ZZ`);
        assert.ok(!JSON.stringify({ ...e }).includes("Bearer"));
        return true;
      },
    );
  });
  it("parses XML error bodies", () => {
    assert.equal(extractYahooErrorMessage("<error><description>You are not allowed</description></error>"), "You are not allowed");
  });
});
