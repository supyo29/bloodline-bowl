/**
 * Yahoo Market State — the loader over a scripted Yahoo league (real client, real parsing, real pagination, fake transport). Proves complete pagination, the
 * rostered-universe aggregation, every failure mode, freshness/invalidation, connection isolation and that only GET requests are ever issued.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { __clearYahooMarketMemo, loadYahooMarketSnapshot, yahooBindingFor, yahooProviderFactory, defaultYahooMarketIO, YAHOO_MEMO_TTL_MS, YAHOO_STALE_AFTER_MS, invalidateYahooMarket } from "../lib/market-state/yahoo-load";
import { buildFreeAgentPool } from "../lib/market-state/pool";
import { validateMarketSnapshot } from "../lib/market-state/integrity";
import { standardWorld, makeWorldIO, type World, type WPlayer } from "./fixtures/yahoo-market-world";

afterEach(() => __clearYahooMarketMemo());
const NOW = Date.parse("2026-10-14T03:00:00.000Z");
const clock = (ms = NOW) => { let t = ms; return { now: () => new Date(t), advance: (d: number) => { t += d; } }; };
const load = (w: World, o: Parameters<typeof makeWorldIO>[1] = {}, opts: Partial<Parameters<typeof loadYahooMarketSnapshot>[1]> = {}) => { const io = makeWorldIO(w, o); const c = clock(); return { io, c, p: loadYahooMarketSnapshot("rogers-park", { week: 6, now: c.now, noMemo: true, ...opts }, io.io) }; };
const many = (n: number, base: number, pos = "WR"): WPlayer[] => Array.from({ length: n }, (_, i) => ({ id: base + i, name: `Pool ${base + i}`, pos, team: ["LV", "DEN", "GB", "CHI"][i % 4]! }));

describe("complete pagination (Yahoo caps a page at 25 and returns no total)", () => {
  it("reads every page of every pool: 137 free agents + 61 waivers + all rostered players", async () => {
    const w = standardWorld(); w.fa = many(137, 10_000); w.waivers = many(61, 20_000).map((p) => ({ ...p, clear: "2026-10-14" }));
    const { p, io } = load(w); const s = await p;
    assert.equal(s.counts.AVAILABLE_FREE_AGENT, 137); assert.equal(s.counts.ON_WAIVERS, 61);
    assert.ok(s.pool_evidence!.FA!.complete && s.pool_evidence!.W!.complete && s.pool_evidence!.T!.complete);
    assert.ok(s.pool_evidence!.FA!.pages_fetched >= 6 && s.pool_evidence!.W!.pages_fetched >= 3, "FA 137 -> 6 pages, W 61 -> 3 pages");
    assert.equal(s.counts.ROSTERED, w.teams.reduce((n, t) => n + t.roster.length, 0));
    assert.equal(new Set(buildFreeAgentPool(s).members.map((m) => m.provider_player_id)).size, 137);
    assert.ok(io.requests.filter((r) => /status=FA/.test(r.url)).length >= 6);
  });
  it("an exact multiple of the page size is complete, not truncated", async () => {
    const w = standardWorld(); w.fa = many(50, 10_000); const s = await load(w).p;
    assert.equal(s.counts.AVAILABLE_FREE_AGENT, 50); assert.equal(s.pool_evidence!.FA!.complete, true);
  });
  it("a read cut short by the time budget is PARTIAL and says so (never presented as the whole pool)", async () => {
    const w = standardWorld(); w.fa = many(137, 10_000);
    const s = await load(w, {}, { poolTimeBudgetMs: -1 }).p;
    assert.equal(s.pool_evidence!.FA!.complete, false); assert.ok(s.readiness.limitations.includes("PLAYER_UNIVERSE_PARTIAL")); assert.equal(s.readiness.axes!.availability, "PARTIAL");
  });
});

describe("league-wide ownership", () => {
  it("every team's roster is read; the union of rostered players equals Yahoo's rostered pool", async () => {
    const w = standardWorld(); const s = await load(w).p;
    const rostered = s.players.filter((p) => p.status === "ROSTERED"); const expected = w.teams.flatMap((t) => t.roster.map((p) => `471.p.${p.id}`));
    assert.deepEqual(rostered.map((p) => p.provider_player_id).sort(), expected.sort());
    for (const t of w.teams) for (const p of t.roster) assert.equal(rostered.find((r) => r.provider_player_id === `471.p.${p.id}`)!.owner_team_id, `team:rogers-park:${t.id}`);
    assert.equal(s.readiness.limitations.includes("OWNERSHIP_CONFLICT"), false); assert.deepEqual(validateMarketSnapshot(s), []);
  });
  it("no player is simultaneously rostered and available", async () => {
    const w = standardWorld(); w.teams[0]!.roster.push({ id: 5001, name: "Tre Tucker", pos: "WR", team: "LV", slot: "BN" }); // also listed as a free agent
    const s = await load(w).p;
    const ids = s.players.filter((p) => p.provider_player_id === "471.p.5001"); assert.equal(ids.length, 1); assert.equal(ids[0]!.status, "UNKNOWN_AVAILABILITY");
    assert.equal(s.players.filter((p) => p.status === "AVAILABLE_FREE_AGENT" && s.players.some((q) => q.provider_player_id === p.provider_player_id && q.status === "ROSTERED")).length, 0);
  });
  it("a roster read that fails degrades ROSTERED ownership to Yahoo's rostered pool, visibly (ROSTER_STATE_PARTIAL)", async () => {
    const w = standardWorld(); w.fail = { ".t.3/roster": { status: 500 } };
    const s = await load(w).p;
    assert.ok(s.readiness.limitations.includes("ROSTER_STATE_PARTIAL")); assert.equal(s.sources.rosters.status, "PARTIAL");
    const kelce = s.players.find((p) => p.provider_player_id === "471.p.3002")!; assert.equal(kelce.status, "ROSTERED"); assert.equal(kelce.owner_team_id, "team:rogers-park:3");
    assert.equal(s.readiness.pool_actionable, true);
  });
  it("a rostered-pool player that no roster lists (unknown player id) is UNKNOWN, never a free agent", async () => {
    const w = standardWorld(); w.tOnly = [{ id: 8888, name: "Ghost Player", pos: "WR", team: "SF", owner: 3 }];
    const s = await load(w).p; const g = s.players.find((p) => p.provider_player_id === "471.p.8888")!;
    assert.equal(g.status, "UNKNOWN_AVAILABILITY"); assert.equal(g.reason, "OWNERSHIP_CONFLICT"); assert.ok(s.readiness.limitations.includes("OWNERSHIP_CONFLICT"));
  });
  it("rows Yahoo lists in the waiver pool while its ownership says a team holds them are conflicts, not waiver players", async () => {
    const w = standardWorld(); w.rosteredInWaiverPool = [{ id: 7777, name: "Held Back", pos: "RB", team: "TB", owner: 2 }];
    const s = await load(w).p; assert.equal(s.players.some((p) => p.provider_player_id === "471.p.7777" && p.status === "ON_WAIVERS"), false);
    assert.ok(s.readiness.limitations.includes("OWNERSHIP_CONFLICT"));
  });
});

describe("K, D/ST and the waiver / free-agent distinction on real parsing", () => {
  it("kickers and defenses (with alias team codes) are verified available; FA and W stay distinct", async () => {
    const s = await load(standardWorld()).p; const pool = buildFreeAgentPool(s);
    const names = (xs: { full_name: string | null }[]) => xs.map((x) => x.full_name).sort();
    assert.deepEqual(names(pool.members.filter((m) => m.position === "K" || m.position === "DEF")), ["Brandon McManus", "Jacksonville", "Washington"]);
    assert.deepEqual(names(pool.claimable.filter((m) => m.position === "K" || m.position === "DEF")), ["Chicago", "Younghoe Koo"]);
    assert.equal(pool.members.find((m) => m.full_name === "Washington")!.canonical_player_id, "defense:nfl:was"); assert.equal(pool.members.find((m) => m.full_name === "Jacksonville")!.canonical_player_id, "defense:nfl:jax");
    assert.ok(pool.claimable.every((m) => m.status === "ON_WAIVERS" && m.waiver_clears_on === "2026-10-14" && m.eligible_to_add === false));
  });
  it("injury designations are caveats, never availability", async () => {
    const s = await load(standardWorld()).p; const q = s.players.find((p) => p.full_name === "Jordan Addison")!;
    assert.equal(q.status, "AVAILABLE_FREE_AGENT"); assert.ok(q.caveats.includes("INJURY_DESIGNATION_PRESENT")); assert.equal(q.injury_status, "Q");
  });
  it("the whole league can be on waivers (Tuesday-night shape): FA pool empty, every unrostered player claimable", async () => {
    const w = standardWorld(); w.waivers = [...w.waivers, ...w.fa.map((p) => ({ ...p, clear: "2026-10-14" }))]; w.fa = [];
    const s = await load(w).p; assert.equal(s.counts.AVAILABLE_FREE_AGENT, 0); assert.ok(s.counts.ON_WAIVERS >= 11);
    assert.equal(s.readiness.pool_actionable, true, "an empty FA pool is a real Yahoo state, not an absence of data"); assert.equal(buildFreeAgentPool(s).claimable.length, s.counts.ON_WAIVERS);
  });
});

describe("acquisition rules, FAAB / priority, pending claims", () => {
  it("settings are preserved verbatim; waiver_time parsed; FAAB balances come from the standings", async () => {
    const w = standardWorld(); w.settings = { uses_faab: "1", waiver_type: "FAAB", waiver_rule: "gametime", waiver_time: "2", max_weekly_adds: "3", extra: { faab_min_bid: "0", trade_end_date: "2026-11-20" } }; w.teams[0]!.faab = 87; w.teams[1]!.faab = 100;
    const s = await load(w).p; const r = s.acquisition.rules;
    assert.equal(r.system, "FAAB"); assert.equal(r.waiver_clear_days, 2); assert.equal(r.provider_raw!.waiver_rule, "gametime"); assert.equal(r.provider_raw!.faab_min_bid, "0"); assert.equal(r.provider_raw!.trade_end_date, "2026-11-20"); assert.deepEqual(r.add_limits, { season: null, weekly: 3 });
    assert.equal(s.acquisition.teams.find((t) => t.team_id === "team:rogers-park:1")!.faab_remaining, 87);
  });
  it("a missing acquisition setting (no waiver_time) is a LIMITATION: the pool is still served", async () => {
    const w = standardWorld(); w.settings = { waiver_time: null }; const s = await load(w).p;
    assert.ok(s.readiness.limitations.includes("WAIVER_RULES_PARTIAL")); assert.equal(s.readiness.pool_actionable, true); assert.equal(s.acquisition.rules.waiver_clear_days, null);
  });
  it("account owns NO team -> pending claims UNAVAILABLE with the real reason (and zero extra requests are faked)", async () => {
    const { p, io } = load(standardWorld()); const s = await p;
    assert.equal(s.pending_claim_visibility!.status, "UNAVAILABLE"); assert.match(s.pending_claim_visibility!.reason, /owns no team/); assert.equal(io.requests.some((r) => /type=waiver/.test(r.url)), false);
  });
  it("account OWNS a team -> its pending claims are read (read-only) and that player is not re-recommended", async () => {
    const w = standardWorld(); w.ownedTeamKeys = ["471.l.287140.t.1"]; w.pendingClaims = [{ team: 1, addKey: "471.p.6001", dropKey: "471.p.1002", bid: 4 }];
    const { p, io } = load(w); const s = await p;
    assert.equal(s.pending_claim_visibility!.status, "AVAILABLE"); assert.equal(s.players.find((x) => x.provider_player_id === "471.p.6001")!.status, "WAIVER_CLAIM_PENDING");
    assert.equal(buildFreeAgentPool(s).claimable.some((m) => m.provider_player_id === "471.p.6001"), false); assert.ok(io.requests.every((r) => r.method === "GET"));
  });
  it("a failing pending-claims read is UNAVAILABLE, not 'no claims'", async () => {
    const w = standardWorld(); w.ownedTeamKeys = ["471.l.287140.t.1"]; w.fail = { "type=waiver": { status: 500 } };
    const s = await load(w).p; assert.equal(s.pending_claim_visibility!.status, "UNAVAILABLE"); assert.match(s.pending_claim_visibility!.reason, /failed/);
  });
});

describe("provider failures fail visibly", () => {
  it("expired token + refresh succeeds: reads proceed after exactly one refresh (the only non-GET is the OAuth token call)", async () => {
    const w = standardWorld(); w.token = { expires_at: Date.now() - 1000 };
    const { p, io } = load(w); const s = await p;
    assert.equal(s.readiness.pool_actionable, true); const posts = io.requests.filter((r) => r.method !== "GET");
    assert.ok(posts.every((r) => /login\.yahoo\.com|get_token/.test(r.url)), `non-GET requests: ${JSON.stringify(posts)}`);
  });
  it("a 401 on the pool and a failed refresh -> BLOCKED with the provider error visible; nothing is available", async () => {
    const w = standardWorld(); w.fail = { "/players;": { status: 401 }, "get_token": { status: 400 } };
    const s = await load(w).p; assert.equal(s.readiness.pool_actionable, false); assert.ok(s.readiness.blocks.includes("PLAYER_UNIVERSE_UNAVAILABLE")); assert.equal(s.counts.AVAILABLE_FREE_AGENT, 0);
    assert.match(s.sources.universe.detail ?? "", /PROVIDER_ERROR/);
  });
  it("Yahoo rate-limits the free-agent pool (429): availability PARTIAL, FA empty (not guessed), waivers still verified", async () => {
    const w = standardWorld(); w.fail = { "status=FA": { status: 429 } };
    const s = await load(w).p; assert.equal(s.counts.AVAILABLE_FREE_AGENT, 0); assert.ok(s.counts.ON_WAIVERS > 0); assert.ok(s.readiness.limitations.includes("PLAYER_UNIVERSE_PARTIAL")); assert.match(s.sources.universe.detail ?? "", /FA: RATE_LIMITED/);
  });
  it("player universe entirely down (both FA and W): BLOCKED, PROVIDER_ERROR", async () => {
    const w = standardWorld(); w.fail = { "status=FA": { status: 500 }, "status=W": { status: 500 } };
    const s = await load(w).p; assert.equal(s.readiness.pool_actionable, false); assert.ok(s.readiness.blocks.includes("PROVIDER_ERROR")); assert.equal(s.readiness.axes!.availability, "NOT_READY");
  });
  it("the league cannot be opened (auth / inaccessible): everything is UNAVAILABLE with the reason, no fabricated players", async () => {
    const s = await load(standardWorld(), { openFail: { code: "yahoo_token_unhealthy", detail: "refresh failed" } }).p;
    assert.equal(s.players.length, 0); assert.ok(s.readiness.blocks.includes("PLAYER_UNIVERSE_UNAVAILABLE") && s.readiness.blocks.includes("ROSTER_STATE_UNAVAILABLE")); assert.match(s.sources.universe.detail ?? "", /yahoo_token_unhealthy/);
  });
  it("NFL schedule failure is a LIMITATION (game locks UNKNOWN), pool intact", async () => {
    const s = await load(standardWorld(), { schedule: "fail" }).p; assert.ok(s.readiness.limitations.includes("GAME_LOCK_UNVERIFIABLE")); assert.equal(s.readiness.pool_actionable, true);
  });
  it("standings/teams unreadable: rosters unknowable, but Yahoo's rostered pool still supplies ownership (visibly partial)", async () => {
    const w = standardWorld(); w.fail = { "/standings": { status: 500 } };
    const s = await load(w).p; assert.equal(s.sources.rosters.status, "UNAVAILABLE"); assert.equal(s.players.filter((p) => p.status === "ROSTERED").length, w.teams.flatMap((t) => t.roster).length);
    assert.ok(s.readiness.limitations.includes("ROSTER_STATE_PARTIAL"));
  });
});

describe("freshness and invalidation (Yahoo moves quickly)", () => {
  it("a repeat within the TTL is served from memory; after the TTL an UNCHANGED league is revalidated cheaply and re-stamped", async () => {
    const io = makeWorldIO(standardWorld()); const c = clock();
    const a = await loadYahooMarketSnapshot("rogers-park", { week: 6, now: c.now }, io.io); const n1 = io.requests.length;
    const b = await loadYahooMarketSnapshot("rogers-park", { week: 6, now: c.now }, io.io); assert.equal(io.requests.length, n1, "within TTL: no Yahoo traffic"); assert.equal(a.identities.request_id, b.identities.request_id);
    c.advance(YAHOO_MEMO_TTL_MS + 1000);
    const d = await loadYahooMarketSnapshot("rogers-park", { week: 6, now: c.now }, io.io);
    const extra = io.requests.slice(n1); assert.ok(extra.length <= 3 && extra.every((r) => /transactions/.test(r.url)), `revalidation is one transactions probe: ${extra.map((r) => r.url).join(" | ")}`);
    assert.notEqual(d.identities.request_id, a.identities.request_id); assert.equal(d.identities.market_content_id, a.identities.market_content_id); assert.ok(Date.parse(d.as_of) > Date.parse(a.as_of));
  });
  it("a changed transaction feed (claims processed / adds / drops) forces a full re-read", async () => {
    const w = standardWorld(); const io = makeWorldIO(w); const c = clock();
    await loadYahooMarketSnapshot("rogers-park", { week: 6, now: c.now }, io.io); const n1 = io.requests.length;
    w.txHead = { fantasy_content: { league: [{ league_key: "x" }, { transactions: { "0": { transaction: [{ transaction_key: "t1", type: "add", status: "successful" }] }, count: 1 } }] } };
    w.fa = w.fa.filter((p) => p.id !== 5001); // a free agent was just added by someone
    c.advance(YAHOO_MEMO_TTL_MS + 1000);
    const s = await loadYahooMarketSnapshot("rogers-park", { week: 6, now: c.now }, io.io);
    assert.ok(io.requests.length - n1 > 5, "full re-read"); assert.equal(s.players.some((p) => p.provider_player_id === "471.p.5001"), false);
  });
  it("nothing older than the staleness ceiling is ever served as live: it is re-read, and a stale build blocks", async () => {
    const io = makeWorldIO(standardWorld()); const c = clock();
    await loadYahooMarketSnapshot("rogers-park", { week: 6, now: c.now }, io.io); const n1 = io.requests.length;
    c.advance(YAHOO_STALE_AFTER_MS + 5000);
    await loadYahooMarketSnapshot("rogers-park", { week: 6, now: c.now }, io.io); assert.ok(io.requests.length - n1 > 5, "past the ceiling: a full re-read, not a re-stamp");
  });
  it("explicit invalidation drops the cache (refresh events)", async () => {
    const io = makeWorldIO(standardWorld()); const c = clock();
    await loadYahooMarketSnapshot("rogers-park", { week: 6, now: c.now }, io.io); const n1 = io.requests.length;
    invalidateYahooMarket("rogers-park"); await loadYahooMarketSnapshot("rogers-park", { week: 6, now: c.now }, io.io); assert.ok(io.requests.length - n1 > 5);
  });
  it("snapshot freshness fields expose observed_at, age and state", async () => {
    const s = await load(standardWorld()).p; assert.equal(s.freshness!.state, "FRESH"); assert.ok(s.freshness!.observed_at <= s.as_of); assert.equal(s.freshness!.ttl_ms, YAHOO_STALE_AFTER_MS);
  });
});

describe("connection isolation: a league only ever uses its own registered connection", () => {
  it("the registry binds Maclin -> 'maclin' and Rogers Park -> 'primary'", () => {
    const m = yahooBindingFor("maclin-on-chicks-xvi"), r = yahooBindingFor("rogers-park");
    assert.ok(m.ok && r.ok); if (m.ok && r.ok) { assert.equal(m.connection_id, "maclin"); assert.equal(r.connection_id, "primary"); assert.equal(m.external_league_id, "82713"); assert.equal(r.external_league_id, "287140"); }
    assert.equal(yahooBindingFor("bloodline-bowl").ok, false); assert.equal(yahooBindingFor("nope").ok, false);
  });
  it("the provider is constructed with the league's own connection, and a handle from any other connection is refused", async () => {
    const original = yahooProviderFactory.create; const seen: string[] = [];
    try {
      yahooProviderFactory.create = ((cid: string) => ({ async openReadHandle() { seen.push(cid); return { data: { client: {} as never, leagueKey: "k", gameKey: "471", connectionId: cid }, status: "READY", warnings: [] } as never; } })) as never;
      const a = await defaultYahooMarketIO.open("maclin-on-chicks-xvi"), b = await defaultYahooMarketIO.open("rogers-park");
      assert.ok(a.ok && b.ok); assert.deepEqual(seen, ["maclin", "primary"]);
      // a provider that hands back ANOTHER connection's handle is refused
      yahooProviderFactory.create = (() => ({ async openReadHandle() { return { data: { client: {} as never, leagueKey: "k", gameKey: "471", connectionId: "primary" }, status: "READY", warnings: [] } as never; } })) as never;
      const crossed = await defaultYahooMarketIO.open("maclin-on-chicks-xvi"); assert.equal(crossed.ok, false); if (!crossed.ok) assert.equal(crossed.code, "yahoo_connection_league_mismatch");
    } finally { yahooProviderFactory.create = original; }
  });
});

describe("read-only: only GET requests ever leave the Yahoo market path", () => {
  it("a full load issues GETs only, to league/team/users resources", async () => {
    const w = standardWorld(); w.ownedTeamKeys = ["471.l.287140.t.1"]; w.pendingClaims = [];
    const { p, io } = load(w); await p;
    assert.ok(io.requests.length > 10); assert.deepEqual([...new Set(io.requests.map((r) => r.method))], ["GET"]);
    assert.ok(io.requests.every((r) => /\/(league|team)\/|users;use_login/.test(r.url)), "no resource outside league/team/users");
    assert.ok(io.requests.every((r) => !/;(add|drop|claim|trade|transaction_key|lineup)=/i.test(r.url)));
  });
});
