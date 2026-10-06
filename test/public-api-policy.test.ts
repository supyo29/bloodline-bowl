/**
 * Public fantasy-API policy + proxy: deterministic, no network.
 * (Unit tests prove the app-layer policy only — Vercel Deployment Protection is
 * infrastructure and is validated separately against the live domain.)
 */

import assert from "node:assert/strict";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, it } from "node:test";
import { NextRequest } from "next/server";

import { PREFIX_RULES, PUBLIC_API_POLICY, classifyPath, decide } from "../lib/public-api/policy";
import { RATE_LIMITS, resetRateLimits } from "../lib/public-api/rate-limit";
import { proxy, config } from "../proxy";

const BASE = "https://bridge.test";
const req = (method: string, path: string, headers: Record<string, string> = {}) =>
  new NextRequest(`${BASE}${path}`, { method, headers });

function routeTemplates(dir = "app/api", prefix = "/api"): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...routeTemplates(p, `${prefix}/${name.replace(/^\[(\w+)\]$/, ":$1")}`));
    else if (name === "route.ts") out.push(prefix);
  }
  return out;
}

beforeEach(() => resetRateLimits());

describe("policy table", () => {
  it("classifies EVERY app/api route file exactly (no unclassified route can ship public by accident)", () => {
    const files = new Set(routeTemplates().filter((t) => !PREFIX_RULES.some((r) => t.startsWith(r.prefix))));
    const table = new Set(PUBLIC_API_POLICY.map((e) => e.template));
    assert.deepEqual([...files].filter((t) => !table.has(t)), [], "route files missing from the policy");
    assert.deepEqual([...table].filter((t) => !files.has(t)), [], "policy entries with no route file");
    assert.equal(table.size, PUBLIC_API_POLICY.length, "duplicate template in policy");
  });

  it("every /api/cron route (prefix rule) rejects an unauthenticated call itself — before doing any work", async () => {
    const cron = routeTemplates().filter((t) => t.startsWith("/api/cron/"));
    assert.ok(cron.length >= 9);
    delete process.env.CRON_SECRET;
    for (const t of cron) {
      assert.equal(classifyPath(t)?.access, "self-guarded");
      const mod = (await import(`../app${t}/route`)) as { GET: (r: Request) => Promise<Response> };
      for (const headers of [{} as Record<string, string>, { authorization: "Bearer not-the-secret" }]) {
        const res = await mod.GET(new Request(`${BASE}${t}`, { headers }));
        assert.ok(res.status === 401 || res.status === 403, `${t} answered ${res.status} to an unauthenticated call`);
      }
    }
  });

  it("static segments outrank params (draft/debug vs draft/:leagueSlug)", () => {
    assert.equal(classifyPath("/api/draft/debug")?.template, "/api/draft/debug");
    assert.equal(classifyPath("/api/draft/bloodline-bowl")?.template, "/api/draft/:leagueSlug");
  });
});

describe("anonymous read access — both providers share one policy", () => {
  const sleeper = [
    "/api/providers", "/api/health", "/api/league/bloodline-bowl/state", "/api/leagues/bloodline-bowl",
    "/api/leagues/bloodline-bowl/managers", "/api/leagues/bloodline-bowl/draft", "/api/leagues/bloodline-bowl/snapshot",
    "/api/leagues/bloodline-bowl/managers/someone/snapshot", "/api/transactions/bloodline-bowl", "/api/standings",
    "/api/matchups", "/api/roster-analysis", "/api/history/bloodline-bowl/week/3", "/api/draft", "/api/lineups",
    "/api/waivers/bloodline-bowl/someone/week/5", "/api/player-availability", "/api/context/bloodline-bowl/someone",
  ];
  const yahoo = [
    "/api/yahoo/status", "/api/yahoo/leagues/rogers-park", "/api/yahoo/leagues/287140",
    "/api/yahoo/leagues/rogers-park/players/available", "/api/yahoo/leagues/rogers-park/provider-availability",
    "/api/league/rogers-park/state", "/api/transactions/rogers-park",
  ];
  for (const path of [...sleeper, ...yahoo]) {
    it(`GET ${path} is public with CORS`, () => {
      const d = decide("GET", path);
      assert.equal(d.kind, "pass", path);
      assert.equal(d.kind === "pass" && d.cors, true);
    });
  }

  it("canonical league routes decide identically for a Sleeper slug and a Yahoo slug", () => {
    for (const tmpl of ["/api/league/{s}/state", "/api/transactions/{s}", "/api/history/{s}/week/2"]) {
      const a = decide("GET", tmpl.replace("{s}", "bloodline-bowl"));
      const b = decide("GET", tmpl.replace("{s}", "rogers-park"));
      assert.deepEqual(a, b, tmpl);
    }
  });

  it("Yahoo league routes only serve REGISTERED leagues (no arbitrary league ids on the shared token)", () => {
    assert.equal(decide("GET", "/api/yahoo/leagues/99999999").kind, "deny");
    assert.equal(decide("GET", "/api/yahoo/leagues/not-a-league/players/available").kind, "deny");
    assert.equal(decide("GET", "/api/yahoo/leagues/maclin-on-chicks-xvi").kind, "pass");
    // a Sleeper slug is not a Yahoo league
    assert.equal(decide("GET", "/api/yahoo/leagues/bloodline-bowl").kind, "deny");
  });
});

describe("method safety", () => {
  const readRoutes = [
    "/api/providers", "/api/league/bloodline-bowl/state", "/api/league/rogers-park/state",
    "/api/yahoo/status", "/api/yahoo/leagues/rogers-park", "/api/yahoo/leagues/rogers-park/players/available",
    "/api/yahoo/leagues/rogers-park/provider-availability", "/api/transactions/rogers-park",
  ];
  for (const path of readRoutes) {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      it(`${method} ${path} -> 405`, () => {
        const d = decide(method, path);
        assert.equal(d.kind, "deny");
        assert.equal(d.kind === "deny" && d.status, 405);
        const res = proxy(req(method, path));
        assert.equal(res.status, 405);
        assert.match(res.headers.get("allow") ?? "", /GET/);
      });
    }
  }

  it("stateless compute routes allow POST only (GET/PUT/DELETE denied)", () => {
    assert.equal(decide("POST", "/api/trades/analyze").kind, "pass");
    assert.equal(decide("POST", "/api/scoring/calculate").kind, "pass");
    for (const m of ["GET", "PUT", "PATCH", "DELETE"]) assert.equal(decide(m, "/api/trades/analyze").kind, "deny");
  });
});

describe("sensitive routes stay protected", () => {
  it("cron / refresh / Yahoo OAuth + diagnostics / account discovery are never public-read (no CORS, own guard)", () => {
    for (const path of [
      "/api/cron/capture", "/api/refresh", "/api/yahoo/auth/start", "/api/yahoo/diagnostics",
      "/api/yahoo/oauth/callback", "/api/yahoo/leagues",
    ]) {
      const d = decide("GET", path);
      assert.equal(d.kind, "pass", path);
      assert.equal(d.kind === "pass" && d.cors, false, `${path} must not get public CORS`);
      assert.notEqual(classifyPath(path)?.access, "public-read", path);
    }
  });

  it("unknown / token-ish / env-ish API paths are denied by default", () => {
    for (const path of ["/api/env", "/api/yahoo/tokens", "/api/yahoo/token", "/api/admin", "/api/secrets", "/api/vercel/deploy", "/api/yahoo/leagues/rogers-park/tokens"]) {
      assert.equal(decide("GET", path).kind, "deny", path);
      assert.equal(proxy(req("GET", path)).status, 404, path);
    }
  });

  it("GET /api/yahoo/leagues (account-wide discovery) needs the operator secret", async () => {
    const { GET } = await import("../app/api/yahoo/leagues/route");
    delete process.env.REFRESH_SECRET;
    assert.equal((await GET(new Request(`${BASE}/api/yahoo/leagues`))).status, 401);
    process.env.REFRESH_SECRET = "s3cret-for-test";
    assert.equal((await GET(new Request(`${BASE}/api/yahoo/leagues`, { headers: { authorization: "Bearer wrong" } }))).status, 401);
    delete process.env.REFRESH_SECRET;
  });

  it("GET /api/health is public and minimal; ?deep=1 (internal ops surface) needs the operator secret", async () => {
    const { GET } = await import("../app/api/health/route");
    delete process.env.REFRESH_SECRET;
    const bare = await GET(new Request(`${BASE}/api/health`));
    assert.equal(bare.status, 200);
    const body = (await bare.json()) as Record<string, unknown>;
    assert.equal(body.ok, true);
    assert.ok(!("persistence" in body) && !("flags" in body));
    assert.equal((await GET(new Request(`${BASE}/api/health?deep=1`))).status, 401);
    process.env.REFRESH_SECRET = "s3cret-for-test";
    assert.equal((await GET(new Request(`${BASE}/api/health?deep=1`, { headers: { authorization: "Bearer nope" } }))).status, 401);
    delete process.env.REFRESH_SECRET;
  });

  it("public Yahoo responses never contain configured credentials", async () => {
    const secrets = { YAHOO_CLIENT_ID: "CID-LEAK-CHECK", YAHOO_CLIENT_SECRET: "CSECRET-LEAK-CHECK", YAHOO_REDIRECT_URI: "https://x/api/yahoo/oauth/callback", YAHOO_TOKEN_ENCRYPTION_KEY: "ENCKEY-LEAK-CHECK" };
    Object.assign(process.env, secrets);
    try {
      const { GET: status } = await import("../app/api/yahoo/status/route");
      const { GET: league } = await import("../app/api/yahoo/leagues/[leagueId]/route");
      const { GET: avail } = await import("../app/api/yahoo/leagues/[leagueId]/players/available/route");
      const bodies = [
        await (await status(new Request(`${BASE}/api/yahoo/status`))).text(),
        await (await league(new Request(`${BASE}/api/yahoo/leagues/rogers-park`), { params: Promise.resolve({ leagueId: "rogers-park" }) })).text(),
        await (await avail(new Request(`${BASE}/api/yahoo/leagues/rogers-park/players/available`), { params: Promise.resolve({ leagueId: "rogers-park" }) })).text(),
      ];
      for (const b of bodies) for (const v of Object.values(secrets)) {
        if (v.startsWith("https://")) continue;
        assert.ok(!b.includes(v), `response leaked ${v}`);
      }
      // No token fields and no real bearer value ("Bearer <REFRESH_SECRET>" is a documented placeholder).
      for (const b of bodies) assert.ok(!/"(access|refresh)_token"\s*:|Bearer\s+[A-Za-z0-9._~+/-]{8,}/i.test(b), "token material in response");
    } finally {
      for (const k of Object.keys(secrets)) delete process.env[k];
    }
  });
});

describe("proxy: CORS, preflight, rate limiting", () => {
  it("public GET gets wildcard CORS without credentials", () => {
    for (const path of ["/api/providers", "/api/league/bloodline-bowl/state", "/api/league/rogers-park/state"]) {
      const res = proxy(req("GET", path));
      assert.equal(res.headers.get("x-middleware-next"), "1");
      assert.equal(res.headers.get("access-control-allow-origin"), "*");
      assert.equal(res.headers.get("access-control-allow-credentials"), null);
    }
  });

  it("preflight: 204, GET/HEAD/OPTIONS only for read routes, POST for compute routes", () => {
    const r = proxy(req("OPTIONS", "/api/yahoo/leagues/rogers-park/players/available"));
    assert.equal(r.status, 204);
    assert.equal(r.headers.get("access-control-allow-methods"), "GET, HEAD, OPTIONS");
    assert.equal(r.headers.get("access-control-allow-origin"), "*");
    assert.equal(r.headers.get("access-control-allow-credentials"), null);
    assert.equal(proxy(req("OPTIONS", "/api/trades/analyze")).headers.get("access-control-allow-methods"), "POST, OPTIONS");
  });

  it("self-guarded routes get no CORS from the proxy", () => {
    const res = proxy(req("GET", "/api/cron/capture"));
    assert.equal(res.headers.get("access-control-allow-origin"), null);
  });

  it("standard class is generous; expensive Yahoo class returns clean 429 with Retry-After; limits are per-IP and per-class", () => {
    const ip = { "x-forwarded-for": "203.0.113.9" };
    for (let i = 0; i < RATE_LIMITS.expensive.limit; i++) {
      assert.equal(proxy(req("GET", "/api/yahoo/leagues/rogers-park/players/available", ip)).status, 200);
    }
    const blocked = proxy(req("GET", "/api/yahoo/leagues/rogers-park/players/available", ip));
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers.get("retry-after")) >= 1);
    assert.equal(blocked.headers.get("content-type")?.includes("application/json"), true);
    // other IP unaffected; cheap class unaffected for the same IP
    assert.equal(proxy(req("GET", "/api/yahoo/leagues/rogers-park/players/available", { "x-forwarded-for": "198.51.100.1" })).status, 200);
    assert.equal(proxy(req("GET", "/api/providers", ip)).status, 200);
    assert.ok(RATE_LIMITS.standard.limit >= 300);
  });

  it("proxy only runs on /api", () => {
    assert.deepEqual(config.matcher, ["/api/:path*"]);
  });
});
