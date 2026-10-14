/**
 * Permanent Yahoo token lifecycle: refresh, rotation, cross-instance concurrency, adoption, persistence, fail-closed, isolation, health.
 * Hermetic: a fake Yahoo token endpoint (strict rotation: a refresh token is single-use) and an in-memory CAS store.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { getValidAccessToken, InMemoryYahooTokenStore, REFRESH_SKEW_MS, __resetYahooLifecycle, getYahooLifecycleRecord, type YahooToken, type YahooTokenStore, type YahooVersionedToken } from "@/lib/providers/yahoo/oauth";
import { getYahooConnectionHealth } from "@/lib/providers/yahoo/health";
import type { YahooConfig } from "@/lib/providers/yahoo/config";

const CFG: YahooConfig = { client_id: "cid", client_secret: "csecret", redirect_uri: "https://x/cb", scope: "fspt-r", game_key_override: null };
const tok = (n: number, expiresInMs: number): YahooToken => ({ access_token: `AT-${n}-secretvalue`, refresh_token: `RT-${n}-secretvalue`, token_type: "bearer", scope: "fspt-r", expires_at: Date.now() + expiresInMs, yahoo_guid: "G" });
const noSleep = async () => {};

/** Fake Yahoo: strict single-use rotating refresh tokens. */
function fakeYahoo(initialRt: string, opts: { strict?: boolean; fail?: "network" | "invalid_grant" | "500" } = {}) {
  let n = 0; let valid = initialRt; const posts: string[] = []; const seen: string[] = [];
  const fetchImpl = (async (_u: unknown, init?: RequestInit) => {
    const body = new URLSearchParams(String(init?.body)); posts.push(init?.method ?? "?"); seen.push(body.get("refresh_token") ?? "");
    await new Promise((r) => setTimeout(r, 5));
    if (opts.fail === "network") throw new Error("socket hang up");
    if (opts.fail === "500") return new Response("{}", { status: 500 });
    if (opts.fail === "invalid_grant" || (opts.strict !== false && body.get("refresh_token") !== valid)) return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
    n += 1; valid = `RT-new${n}-secretvalue`;
    return new Response(JSON.stringify({ access_token: `AT-new${n}-secretvalue`, refresh_token: valid, expires_in: 3600, token_type: "bearer" }), { status: 200 });
  }) as typeof fetch;
  return { fetchImpl, posts, seen, get count() { return n; } };
}
const mk = async (expiresInMs: number, id = "maclin") => { const s = new InMemoryYahooTokenStore(id); (s as unknown as { set(t: YahooToken): Promise<void> }).set(tok(0, expiresInMs)); return s; };

test("1 - a valid token is used as-is: no refresh, no store write", async () => {
  __resetYahooLifecycle(); const s = await mk(30 * 60_000); const y = fakeYahoo("RT-0-secretvalue");
  const r = await getValidAccessToken(CFG, s, { fetchImpl: y.fetchImpl });
  assert.equal(r.status, "OK"); assert.equal(y.posts.length, 0); assert.equal((await s.getVersioned())!.seq, 0);
});

test("2 - an expiring token refreshes once; BOTH rotated tokens are persisted atomically; the next call uses them", async () => {
  __resetYahooLifecycle(); const s = await mk(REFRESH_SKEW_MS - 1000); const y = fakeYahoo("RT-0-secretvalue");
  const r = await getValidAccessToken(CFG, s, { fetchImpl: y.fetchImpl });
  assert.equal(r.status, "OK"); assert.equal(r.access_token, "AT-new1-secretvalue"); assert.equal(y.count, 1);
  const v = (await s.getVersioned())!; assert.equal(v.seq, 1); assert.equal(v.token.access_token, "AT-new1-secretvalue"); assert.equal(v.token.refresh_token, "RT-new1-secretvalue");
  const again = await getValidAccessToken(CFG, s, { fetchImpl: y.fetchImpl }); assert.equal(again.access_token, "AT-new1-secretvalue"); assert.equal(y.count, 1, "fresh token reused");
});

test("3 - an EXPIRED token refreshes transparently (no manual step)", async () => {
  __resetYahooLifecycle(); const s = await mk(-60_000); const y = fakeYahoo("RT-0-secretvalue");
  assert.equal((await getValidAccessToken(CFG, s, { fetchImpl: y.fetchImpl })).status, "OK"); assert.equal(y.count, 1);
});

test("4 - 25 simultaneous callers on one instance cause exactly ONE Yahoo refresh and ONE rotation", async () => {
  __resetYahooLifecycle(); const s = await mk(-1000); const y = fakeYahoo("RT-0-secretvalue");
  const rs = await Promise.all(Array.from({ length: 25 }, () => getValidAccessToken(CFG, s, { fetchImpl: y.fetchImpl })));
  assert.ok(rs.every((r) => r.status === "OK" && r.access_token === "AT-new1-secretvalue")); assert.equal(y.posts.length, 1); assert.equal((await s.getVersioned())!.seq, 1);
});

test("5 - TWO INSTANCES, strict single-use rotation: the loser gets invalid_grant, ADOPTS the winner's token, nobody needs reauthorization", async () => {
  __resetYahooLifecycle(); const s = await mk(-1000); const y = fakeYahoo("RT-0-secretvalue", { strict: true });
  const [a, b] = await Promise.all([
    getValidAccessToken(CFG, s, { fetchImpl: y.fetchImpl, inflightMap: new Map(), sleep: noSleep }),
    getValidAccessToken(CFG, s, { fetchImpl: y.fetchImpl, inflightMap: new Map(), sleep: noSleep }),
  ]);
  assert.equal(a.status, "OK"); assert.equal(b.status, "OK"); assert.equal(a.access_token, b.access_token, "both instances converge on ONE token");
  assert.equal(a.reauthorization_required ?? false, false); assert.equal(getYahooLifecycleRecord("maclin").reauthorization_required, false);
  assert.equal((await s.getVersioned())!.seq, 1, "exactly one rotation persisted");
  assert.equal((await s.getVersioned())!.token.refresh_token, "RT-new1-secretvalue");
});

test("6 - TWO INSTANCES, lenient Yahoo (both refreshes succeed): CAS lets exactly one persist; the other adopts the stored token", async () => {
  __resetYahooLifecycle(); const s = await mk(-1000); const y = fakeYahoo("RT-0-secretvalue", { strict: false });
  const [a, b] = await Promise.all([
    getValidAccessToken(CFG, s, { fetchImpl: y.fetchImpl, inflightMap: new Map(), sleep: noSleep }),
    getValidAccessToken(CFG, s, { fetchImpl: y.fetchImpl, inflightMap: new Map(), sleep: noSleep }),
  ]);
  assert.equal(y.count, 2, "both really refreshed at Yahoo"); const v = (await s.getVersioned())!;
  assert.equal(v.seq, 1, "only ONE rotation persisted (the other lost the CAS)");
  assert.equal(a.access_token, v.token.access_token); assert.equal(b.access_token, v.token.access_token, "loser serves the stored (winner's) token");
});

test("7 - a persistence failure after Yahoo rotated is retried; transient failure recovers with the rotation saved", async () => {
  __resetYahooLifecycle(); const inner = await mk(-1000); let fails = 2;
  const flaky: YahooTokenStore = Object.assign(Object.create(inner), { connection_id: "maclin", backend: "memory", get: () => inner.get(), set: (t: YahooToken) => inner.set(t), clear: () => inner.clear(), getVersioned: () => inner.getVersioned(), rotate: async (e: number, t: YahooToken) => { if (fails-- > 0) throw new Error("db down"); return inner.rotate(e, t); } });
  const y = fakeYahoo("RT-0-secretvalue");
  const r = await getValidAccessToken(CFG, flaky, { fetchImpl: y.fetchImpl, sleep: noSleep });
  assert.equal(r.status, "OK"); assert.equal((await inner.getVersioned())!.token.refresh_token, "RT-new1-secretvalue"); assert.equal(y.count, 1);
});

test("8 - the store stays DOWN after rotation: the new tokens are held in memory, served, and re-persisted BEFORE any further Yahoo refresh", async () => {
  __resetYahooLifecycle(); const inner = await mk(-1000); let down = true;
  const store: YahooTokenStore = Object.assign(Object.create(inner), { connection_id: "maclin", backend: "memory", get: () => inner.get(), set: (t: YahooToken) => inner.set(t), clear: () => inner.clear(), getVersioned: () => inner.getVersioned(), rotate: async (e: number, t: YahooToken) => { if (down) throw new Error("db down"); return inner.rotate(e, t); } });
  const y = fakeYahoo("RT-0-secretvalue");
  const r1 = await getValidAccessToken(CFG, store, { fetchImpl: y.fetchImpl, sleep: noSleep });
  assert.equal(r1.status, "OK"); assert.equal(getYahooLifecycleRecord("maclin").persist_pending, true); assert.equal(y.count, 1);
  down = false;
  const r2 = await getValidAccessToken(CFG, store, { fetchImpl: y.fetchImpl, sleep: noSleep });
  assert.equal(r2.status, "OK"); assert.equal(y.count, 1, "NO second Yahoo refresh: the held rotation was persisted instead");
  assert.equal((await inner.getVersioned())!.token.refresh_token, "RT-new1-secretvalue"); assert.equal(getYahooLifecycleRecord("maclin").persist_pending, false);
});

test("9 - a genuine invalid_grant (nobody rotated) fails VISIBLY, serves NO token, and flags reauthorization", async () => {
  __resetYahooLifecycle(); const s = await mk(-1000); const y = fakeYahoo("x", { fail: "invalid_grant" });
  const r = await getValidAccessToken(CFG, s, { fetchImpl: y.fetchImpl, sleep: noSleep });
  assert.equal(r.status, "REFRESH_FAILED"); assert.equal(r.access_token, null); assert.equal(r.reauthorization_required, true); assert.equal(r.failure_kind, "INVALID_GRANT");
  const h = await getYahooConnectionHealth("maclin", s); assert.equal(h.status, "REAUTHORIZATION_REQUIRED"); assert.equal(h.reauthorization_required, true); assert.equal(h.last_refresh_failure?.kind, "INVALID_GRANT");
});

test("10 - network / 5xx refresh failures are transient: NO reauthorization flag, NO token served, stored credentials untouched", async () => {
  for (const fail of ["network", "500"] as const) {
    __resetYahooLifecycle(); const s = await mk(-1000); const y = fakeYahoo("RT-0-secretvalue", { fail });
    const r = await getValidAccessToken(CFG, s, { fetchImpl: y.fetchImpl, sleep: noSleep });
    assert.equal(r.status, "REFRESH_FAILED"); assert.equal(r.access_token, null); assert.notEqual(r.reauthorization_required, true);
    const v = (await s.getVersioned())!; assert.equal(v.seq, 0); assert.equal(v.token.refresh_token, "RT-0-secretvalue");
    assert.equal((await getYahooConnectionHealth("maclin", s)).status, "DEGRADED");
  }
});

test("11 - 401 retry: if a sibling already refreshed, the retry ADOPTS the stored fresh token (no second rotation)", async () => {
  __resetYahooLifecycle(); const s = await mk(30 * 60_000); const y = fakeYahoo("RT-0-secretvalue");
  const rejected = (await s.getVersioned())!.token.access_token;
  await s.rotate!(0, tok(7, 3_600_000)); // sibling rotated
  const r = await getValidAccessToken(CFG, s, { forceRefresh: true, rejectedAccessToken: rejected, fetchImpl: y.fetchImpl });
  assert.equal(r.status, "OK"); assert.equal(r.access_token, "AT-7-secretvalue"); assert.equal(y.posts.length, 0);
});

test("12 - 401 retry with the SAME rejected token forces exactly one real refresh", async () => {
  __resetYahooLifecycle(); const s = await mk(30 * 60_000); const y = fakeYahoo("RT-0-secretvalue");
  const rejected = (await s.getVersioned())!.token.access_token;
  const r = await getValidAccessToken(CFG, s, { forceRefresh: true, rejectedAccessToken: rejected, fetchImpl: y.fetchImpl });
  assert.equal(r.access_token, "AT-new1-secretvalue"); assert.equal(y.count, 1);
});

test("13 - ISOLATION: refreshing / failing `maclin` never reads, writes or fails `primary`", async () => {
  __resetYahooLifecycle(); const maclin = await mk(-1000, "maclin"); const primary = await mk(30 * 60_000, "primary");
  const before = JSON.stringify(await primary.getVersioned());
  const yBad = fakeYahoo("x", { fail: "invalid_grant" });
  assert.equal((await getValidAccessToken(CFG, maclin, { fetchImpl: yBad.fetchImpl, sleep: noSleep })).status, "REFRESH_FAILED");
  assert.equal((await getValidAccessToken(CFG, primary, { fetchImpl: yBad.fetchImpl })).status, "OK", "primary unaffected");
  assert.equal(JSON.stringify(await primary.getVersioned()), before); assert.equal(yBad.posts.length, 1, "only maclin hit the token endpoint");
  assert.equal(getYahooLifecycleRecord("primary").reauthorization_required, false); assert.equal(getYahooLifecycleRecord("maclin").reauthorization_required, true);
  // concurrent refreshes of BOTH connections use independent single-flights and independent tokens
  __resetYahooLifecycle(); const m2 = await mk(-1000, "maclin"); const p2 = await mk(-1000, "primary"); const y = fakeYahoo("RT-0-secretvalue", { strict: false });
  const [a, b] = await Promise.all([getValidAccessToken(CFG, m2, { fetchImpl: y.fetchImpl }), getValidAccessToken(CFG, p2, { fetchImpl: y.fetchImpl })]);
  assert.equal(y.posts.length, 2); assert.notEqual(a.access_token, b.access_token); assert.equal((await m2.getVersioned())!.seq, 1); assert.equal((await p2.getVersioned())!.seq, 1);
});

test("14 - health is credential-free: no access/refresh token substrings anywhere in the serialized output", async () => {
  __resetYahooLifecycle(); const s = await mk(10 * 60_000); const y = fakeYahoo("RT-0-secretvalue");
  await getValidAccessToken(CFG, s, { fetchImpl: y.fetchImpl, forceRefresh: true });
  const h = JSON.stringify(await getYahooConnectionHealth("maclin", s)); const v = (await s.getVersioned())!;
  for (const secret of [v.token.access_token, v.token.refresh_token, "secretvalue", "csecret", "Bearer"]) assert.ok(!h.includes(secret), `leaked ${secret}`);
  assert.match(h, /"status":"HEALTHY"/); assert.match(h, /"rotation_count":1/);
});

test("15 - health reports NOT_CONNECTED / STORE_UNAVAILABLE honestly", async () => {
  __resetYahooLifecycle(); assert.equal((await getYahooConnectionHealth("primary", new InMemoryYahooTokenStore("primary"))).status, "NOT_CONNECTED");
  const broken = Object.assign(new InMemoryYahooTokenStore("primary"), { getVersioned: async (): Promise<YahooVersionedToken | null> => { throw new Error("x"); } });
  assert.equal((await getYahooConnectionHealth("primary", broken)).status, "STORE_UNAVAILABLE");
});

test("16 - Supabase rotation is ONE guarded UPDATE: row-scoped, seq-guarded, both tokens as ciphertext only; an empty result is CONFLICT", async () => {
  const { SupabaseYahooTokenStore } = await import("@/lib/providers/yahoo/token-store");
  const calls: Array<{ table: string; filter: Record<string, string>; patch: Record<string, unknown> }> = []; let rows: unknown[] = [{ refresh_seq: 5 }];
  const rest = { updateReturning: async (table: string, filter: Record<string, string>, patch: Record<string, unknown>) => { calls.push({ table, filter, patch }); return rows; } };
  const env = { YAHOO_TOKEN_ENCRYPTION_KEY: "a".repeat(64) } as unknown as NodeJS.ProcessEnv;
  const store = new SupabaseYahooTokenStore(rest as never, "maclin", env); const t = tok(9, 3_600_000);
  assert.deepEqual(await store.rotate(4, t), { ok: true, seq: 5 });
  const c = calls[0]!; assert.equal(c.table, "bridge_yahoo_connections"); assert.equal(c.filter.connection_id, "eq.maclin"); assert.equal(c.filter.refresh_seq, "eq.4"); assert.equal(c.patch.refresh_seq, 5);
  const wire = JSON.stringify(c.patch); assert.ok(!wire.includes("secretvalue"), "no plaintext token on the wire");
  assert.ok(c.patch.access_token_encrypted && c.patch.refresh_token_encrypted && c.patch.last_refreshed_at, "BOTH tokens + provenance in the same statement");
  rows = []; assert.deepEqual(await store.rotate(4, t), { ok: false, reason: "CONFLICT" });
});
