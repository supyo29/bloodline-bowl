/**
 * /api/ai/compact — every advertised URL must be absolute and concrete so a
 * browsing agent that only opens verbatim URLs can traverse the bridge.
 * The NFL-state read is allowed to fail (offline CI): weekly URLs are then
 * omitted with a stated reason, never emitted with a placeholder.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { PRODUCTION_BASE_URL, discoveryLeagues, discoveryManagers } from "../lib/discovery";
import { decide } from "../lib/public-api/policy";

function collectStrings(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => collectStrings(x, out));
  else if (v && typeof v === "object") Object.values(v).forEach((x) => collectStrings(x, out));
  return out;
}

describe("/api/ai/compact", () => {
  it("lists only absolute, placeholder-free URLs for every league and manager", async () => {
    const { GET } = await import("../app/api/ai/compact/route");
    const res = await GET();
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
    const raw = await res.text();
    assert.ok(raw.length < 16_000, `compact index should stay small (got ${raw.length} bytes)`);
    const body = JSON.parse(raw);

    const urls = collectStrings(body).filter((s) => s.includes("/api/") || s.endsWith(".txt") || s.endsWith("/ai"));
    assert.ok(urls.length > 0);
    for (const u of urls) {
      assert.ok(u.startsWith(`${PRODUCTION_BASE_URL}/`), `not absolute: ${u}`);
      assert.ok(!/[{}]/.test(u), `template placeholder leaked: ${u}`);
      assert.ok(!u.includes("/week/null"), `null week leaked: ${u}`);
    }

    assert.equal(body.links.full_contract, `${PRODUCTION_BASE_URL}/api/ai`);
    assert.deepEqual(body.leagues.map((l: { league_slug: string }) => l.league_slug), discoveryLeagues().map((l) => l.league_slug));
    assert.equal(body.managers.length, discoveryManagers().length);

    if (body.current_week.week == null) {
      for (const m of body.managers) assert.equal(m.weekly_intelligence_url, undefined);
    } else {
      for (const m of body.managers) {
        assert.equal(m.weekly_intelligence_url, `${PRODUCTION_BASE_URL}/api/intelligence/${m.league_slug}/${m.manager_slug}/week/${body.current_week.week}`);
      }
    }
  });

  it("is public read-only through the proxy policy", () => {
    assert.equal(decide("GET", "/api/ai/compact").kind, "pass");
    assert.equal(decide("POST", "/api/ai/compact").kind, "deny");
  });

  it("is linked from /api/ai and /api/health", async () => {
    const ai = await (await (await import("../app/api/ai/route")).GET()).json();
    assert.equal(ai.start_here.compact_index, `${PRODUCTION_BASE_URL}/api/ai/compact`);
    assert.equal(ai.start_here.ai_discovery, "/api/ai");
    const health = await (await (await import("../app/api/health/route")).GET(new Request("http://x/api/health"))).json();
    assert.equal(health.discovery.contract, `${PRODUCTION_BASE_URL}/api/ai`);
    assert.equal(health.ok, true);
  });
});
