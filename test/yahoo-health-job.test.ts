import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemoryYahooTokenStore, __resetYahooLifecycle, type YahooToken } from "@/lib/providers/yahoo/oauth";
import { runYahooHealthJob, HEALTH_JOB_REFRESH_WINDOW_MS } from "@/lib/providers/yahoo/health-job";

const tok = (n: number, ms: number): YahooToken => ({ access_token: `AT-${n}-secretvalue`, refresh_token: `RT-${n}-secretvalue`, token_type: "bearer", scope: "fspt-r", expires_at: Date.now() + ms, yahoo_guid: `G${n}` });
function env(): () => void {
  const keep = { ...process.env }; Object.assign(process.env, { YAHOO_CLIENT_ID: "cid", YAHOO_CLIENT_SECRET: "csecret", YAHOO_REDIRECT_URI: "https://x/cb", YAHOO_TOKEN_ENCRYPTION_KEY: "b".repeat(64) });
  return () => { for (const k of ["YAHOO_CLIENT_ID", "YAHOO_CLIENT_SECRET", "YAHOO_REDIRECT_URI", "YAHOO_TOKEN_ENCRYPTION_KEY"]) { if (keep[k] === undefined) delete process.env[k]; else process.env[k] = keep[k]; } };
}
function yahoo() {
  const log: Array<{ method: string; url: string }> = [];
  const fetchImpl = (async (u: unknown, init?: RequestInit) => {
    const url = String(u); log.push({ method: init?.method ?? "GET", url });
    if (url.includes("login.yahoo.com")) return new Response(JSON.stringify({ access_token: "AT-job-secretvalue", refresh_token: "RT-job-secretvalue", expires_in: 3600, token_type: "bearer" }), { status: 200 });
    return new Response(JSON.stringify({ fantasy_content: { users: { 0: { user: [{ guid: "G" }, { games: {} }] }, count: 1 } } }), { status: 200 });
  }) as typeof fetch;
  return { fetchImpl, log };
}

test("health job: refreshes ONLY the connection inside the window, probes both read-only, never POSTs except the token endpoint, never leaks", async () => {
  __resetYahooLifecycle(); const restore = env();
  try {
    const maclin = new InMemoryYahooTokenStore("maclin"); await maclin.set(tok(1, HEALTH_JOB_REFRESH_WINDOW_MS - 60_000)); // expiring -> refresh
    const primary = new InMemoryYahooTokenStore("primary"); await primary.set(tok(2, 55 * 60_000)); // fresh -> must NOT refresh
    const stores: Record<string, InMemoryYahooTokenStore> = { maclin, primary }; const y = yahoo();
    const res = await runYahooHealthJob({ store: (id) => stores[id] ?? null, fetchImpl: y.fetchImpl, connections: ["maclin", "primary"] });
    assert.ok(res.every((r) => r.ok && r.probe === "OK"));
    assert.equal(res.find((r) => r.connection_id === "maclin")!.refreshed_by_job, true); assert.equal(res.find((r) => r.connection_id === "primary")!.refreshed_by_job, false);
    const posts = y.log.filter((c) => c.method !== "GET"); assert.equal(posts.length, 1, "exactly one refresh (maclin only)"); assert.ok(posts[0]!.url.includes("login.yahoo.com"));
    assert.ok(y.log.filter((c) => c.method === "GET").every((c) => c.url.includes("fantasysports.yahooapis.com")), "probes are GETs to the Fantasy API");
    assert.equal((await primary.getVersioned())!.seq, 0, "primary untouched");
    const wire = JSON.stringify(res); for (const secret of ["secretvalue", "csecret", "Bearer"]) assert.ok(!wire.includes(secret), `leaked ${secret}`);
  } finally { restore(); }
});

test("health job: a dead credential is reported (ok=false, reauth), the other connection still succeeds", async () => {
  __resetYahooLifecycle(); const restore = env();
  try {
    const bad = new InMemoryYahooTokenStore("maclin"); await bad.set(tok(1, -1000)); const good = new InMemoryYahooTokenStore("primary"); await good.set(tok(2, 55 * 60_000));
    const stores: Record<string, InMemoryYahooTokenStore> = { maclin: bad, primary: good };
    const fetchImpl = (async (u: unknown) => String(u).includes("login.yahoo.com") ? new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }) : new Response(JSON.stringify({ fantasy_content: { users: {} } }), { status: 200 })) as typeof fetch;
    const res = await runYahooHealthJob({ store: (id) => stores[id] ?? null, fetchImpl, connections: ["maclin", "primary"] });
    const m = res.find((r) => r.connection_id === "maclin")!; assert.equal(m.ok, false); assert.equal(m.health?.reauthorization_required, true); assert.equal(res.find((r) => r.connection_id === "primary")!.ok, true);
  } finally { restore(); }
});
