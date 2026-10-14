/**
 * Strict Yahoo READ-ONLY / NO-REFRESH mode (live-certification safety). The current access token may be used for GETs; refresh is impossible by construction: the refresh endpoint is never
 * called, the token store is never written, nothing but GET is issued. Normal production refresh behavior is unchanged.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { YahooApiError, YahooFantasyClient } from "../lib/providers/yahoo/client";
import { InMemoryYahooTokenStore } from "../lib/providers/yahoo/oauth";
import { NoRefreshTokenStore, YahooReadOnlyViolation } from "../lib/providers/yahoo/read-only-auth";
import { YahooProvider } from "../lib/providers/yahoo/provider";
import { loadYahooMarketSnapshot, defaultYahooMarketIO, yahooProviderFactory, __clearYahooMarketMemo } from "../lib/market-state/yahoo-load";
import { CONFIG, makeWorldIO, makeWorldClient, standardWorld } from "./fixtures/yahoo-market-world";

const SECRET = "ACCESS-TOKEN-SECRET-VALUE";
const rec = (status = 200) => { const calls: Array<{ url: string; method: string; auth: string | null }> = []; const fetchImpl = (async (u: string | URL | Request, init?: RequestInit) => { calls.push({ url: String(u), method: init?.method ?? "GET", auth: new Headers(init?.headers).get("authorization") }); return new Response(status === 200 ? JSON.stringify({ fantasy_content: {} }) : "{}", { status }); }) as typeof fetch; return { calls, fetchImpl }; };
const cli = (store: NoRefreshTokenStore, fetchImpl: typeof fetch) => new YahooFantasyClient({ config: CONFIG, store, fetchImpl, readOnly: true });
const TOKEN_URL = /login\.yahoo\.com|get_token/;

describe("read-only client", () => {
  it("a VALID token works: one GET with the bearer, no POST, no refresh, no token-store write", async () => {
    const st = new NoRefreshTokenStore("maclin", SECRET, Date.now() + 3_600_000), { calls, fetchImpl } = rec();
    const r = await cli(st, fetchImpl).get("/league/470.l.1/settings");
    assert.equal(r.meta.refreshed, false); assert.equal(calls.length, 1); assert.equal(calls[0]!.method, "GET"); assert.equal(calls[0]!.auth, `Bearer ${SECRET}`); assert.ok(!TOKEN_URL.test(calls[0]!.url)); assert.equal(st.writeAttempts, 0);
  });
  it("an EXPIRED token fails with AUTH_REFRESH_REQUIRED_READ_ONLY and makes NO request at all (no refresh, no GET)", async () => {
    const st = new NoRefreshTokenStore("maclin", SECRET, Date.now() - 1000), { calls, fetchImpl } = rec();
    await assert.rejects(() => cli(st, fetchImpl).get("/x"), (e: unknown) => e instanceof YahooApiError && e.kind === "AUTH_REFRESH_REQUIRED_READ_ONLY");
    assert.equal(calls.length, 0); assert.equal(st.writeAttempts, 0);
  });
  it("a token about to lapse (inside the margin) is treated as expired", async () => {
    const st = new NoRefreshTokenStore("maclin", SECRET, Date.now() + 2_000), { calls, fetchImpl } = rec();
    await assert.rejects(() => cli(st, fetchImpl).get("/x"), (e: unknown) => (e as YahooApiError).kind === "AUTH_REFRESH_REQUIRED_READ_ONLY"); assert.equal(calls.length, 0);
  });
  it("a Yahoo 401 fails with AUTH_REFRESH_REQUIRED_READ_ONLY after exactly ONE GET: no retry, no refresh endpoint, no POST, no write", async () => {
    const st = new NoRefreshTokenStore("maclin", SECRET, Date.now() + 3_600_000), { calls, fetchImpl } = rec(401);
    await assert.rejects(() => cli(st, fetchImpl).get("/x"), (e: unknown) => e instanceof YahooApiError && e.kind === "AUTH_REFRESH_REQUIRED_READ_ONLY" && e.httpStatus === 401);
    assert.equal(calls.length, 1); assert.ok(calls.every((c) => c.method === "GET" && !TOKEN_URL.test(c.url))); assert.equal(st.writeAttempts, 0);
  });
  it("other Yahoo errors keep their own kind (a 500 is not misreported as an auth problem)", async () => {
    const st = new NoRefreshTokenStore("maclin", SECRET, Date.now() + 3_600_000), { fetchImpl } = rec(500);
    await assert.rejects(() => cli(st, fetchImpl).get("/x"), (e: unknown) => (e as YahooApiError).kind === "SERVER");
  });
  it("the read-only code path contains no refresh, no token-store write and no POST (static)", () => {
    const src = readFileSync("lib/providers/yahoo/client.ts", "utf8"); const a = src.indexOf("async #getReadOnly"), b = src.indexOf("async #send");
    const body = src.slice(a, b); assert.ok(a > 0 && b > a);
    assert.doesNotMatch(body, /getValidAccessToken|refreshAccessToken|\.set\(|\.clear\(|POST|YAHOO_OAUTH_TOKEN_URL/);
  });
});

describe("NoRefreshTokenStore", () => {
  it("set() and clear() throw and are counted; the access token never appears in string / JSON forms", async () => {
    const st = new NoRefreshTokenStore("primary", SECRET, Date.now() + 1e6);
    await assert.rejects(() => st.set(), YahooReadOnlyViolation); await assert.rejects(() => st.clear(), YahooReadOnlyViolation); assert.equal(st.writeAttempts, 2);
    assert.ok(!JSON.stringify(st).includes(SECRET)); assert.ok(!String(st).includes(SECRET)); assert.equal((await st.get())!.refresh_token, "", "no refresh token exists in this store");
  });
});

describe("read-only provider and loader", () => {
  it("YahooProvider readOnly needs an explicit token store (a durable store is never resolved)", () => assert.throws(() => new YahooProvider({ readOnly: true, connectionId: "maclin" }), /requires an explicit tokenStore/));
  it("an expired token degrades the provider with AUTH_REFRESH_REQUIRED_READ_ONLY, with no OAuth app credentials and no network", async () => {
    const st = new NoRefreshTokenStore("maclin", SECRET, Date.now() - 1000); const p = new YahooProvider({ readOnly: true, connectionId: "maclin", tokenStore: st, env: {} as NodeJS.ProcessEnv });
    const r = await p.openReadHandle({ league_slug: "maclin-on-chicks-xvi", external_league_id: "82713", season: 2026 });
    assert.equal(r.data, null); assert.equal(r.warnings[0]!.code, "AUTH_REFRESH_REQUIRED_READ_ONLY"); assert.equal(st.writeAttempts, 0);
  });
  it("the Market State loader reports it visibly (blocked snapshot naming the code) and fabricates nothing", async () => {
    __clearYahooMarketMemo(); const orig = yahooProviderFactory.create;
    try {
      yahooProviderFactory.create = (cid: string) => new YahooProvider({ readOnly: true, connectionId: cid, tokenStore: new NoRefreshTokenStore(cid, SECRET, Date.now() - 1000), env: {} as NodeJS.ProcessEnv });
      const s = await loadYahooMarketSnapshot("maclin-on-chicks-xvi", { week: 6, noMemo: true }, defaultYahooMarketIO);
      assert.equal(s.readiness.pool_actionable, false); assert.equal(s.players.length, 0); assert.match(s.sources.universe.detail ?? "", /AUTH_REFRESH_REQUIRED_READ_ONLY/);
    } finally { yahooProviderFactory.create = orig; }
  });
  it("the REAL loader over a scripted league with the strict client: full snapshot, GET only, never the token endpoint, zero token-store writes", async () => {
    __clearYahooMarketMemo(); const st = new NoRefreshTokenStore("primary", SECRET, Date.now() + 3_600_000); const w = standardWorld(); w.ownedTeamKeys = ["471.l.287140.t.1"]; w.pendingClaims = [];
    const wio = makeWorldIO(w, { readOnlyStore: st }); const s = await loadYahooMarketSnapshot("rogers-park", { week: 6, noMemo: true }, wio.io);
    assert.equal(s.readiness.pool_actionable, true); assert.ok(s.counts.AVAILABLE_FREE_AGENT > 0); assert.equal(s.pending_claim_visibility!.status, "AVAILABLE");
    assert.ok(wio.requests.length > 10); assert.deepEqual([...new Set(wio.requests.map((r) => r.method))], ["GET"]); assert.ok(wio.requests.every((r) => !TOKEN_URL.test(r.url))); assert.equal(st.writeAttempts, 0);
  });
});

describe("normal production refresh behavior is UNCHANGED", () => {
  it("a non-read-only client with an expired token refreshes once via the token endpoint (POST), persists the rotated token (store.set), then GETs with the new token", async () => {
    const w = standardWorld(); w.token = { expires_at: Date.now() - 1000 }; const wc = makeWorldClient(w);
    await wc.client.get("/league/471.l.287140/settings");
    assert.equal(wc.refreshes(), 1); const posts = wc.requests.filter((r) => r.method === "POST"); assert.equal(posts.length, 1); assert.match(posts[0]!.url, TOKEN_URL);
    assert.equal((await wc.store.get())!.access_token, "A2", "the rotated token was persisted");
    assert.ok(wc.requests.some((r) => r.method === "GET" && /settings/.test(r.url)));
  });
  it("a non-read-only client still retries ONCE after a 401 (refresh-then-retry)", async () => {
    const store = new InMemoryYahooTokenStore("t"); await store.set({ access_token: "OLD", refresh_token: "R", token_type: "bearer", scope: "fspt-r", expires_at: Date.now() + 3_600_000, yahoo_guid: "G" });
    let n = 0; const calls: string[] = []; const fetchImpl = (async (u: string | URL | Request, init?: RequestInit) => { calls.push(`${init?.method ?? "GET"} ${String(u).slice(0, 40)}`); if (TOKEN_URL.test(String(u))) return new Response(JSON.stringify({ access_token: "NEW", refresh_token: "R2", token_type: "bearer", expires_in: 3600 }), { status: 200 }); n += 1; return n === 1 ? new Response("{}", { status: 401 }) : new Response(JSON.stringify({ fantasy_content: {} }), { status: 200 }); }) as typeof fetch;
    const r = await new YahooFantasyClient({ config: CONFIG, store, fetchImpl }).get("/x"); assert.equal(r.meta.refreshed, true); assert.equal(calls.filter((c) => c.startsWith("POST")).length, 1);
  });
});
