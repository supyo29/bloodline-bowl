/**
 * P0 — LIVE DRAFT-ROOM CACHE / TRANSPORT.
 *
 * The real Bloodline recommendation endpoint stays `DEGRADED` all draft (Layer 1
 * has no K/DEF projections). Cache policy must NOT be keyed to engine readiness:
 * every successful draft-room response is `Cache-Control: no-store` so a stale
 * edge object can never surface a drafted player, the wrong pick count, or the
 * wrong turn under a 120-second pick clock.
 *
 * Deterministic source-guards + live behaviour against the real pre-draft league.
 * Requires network access (same as the other `*-live` suites).
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const RECS_ROUTE = "app/api/leagues/[leagueSlug]/managers/[managerSlug]/recommendations/route.ts";
const MGR_DRAFT_ROUTE = "app/api/leagues/[leagueSlug]/managers/[managerSlug]/draft/route.ts";
const LEAGUE_DRAFT_ROUTE = "app/api/leagues/[leagueSlug]/draft/route.ts";

const LEAGUE = "bloodline-bowl";
const MANAGER = "supyo29";
const REAL_DRAFT_ID = "1395549282349617152";
const SLOT7 = [7, 18, 31, 42, 55, 66, 79, 90, 103, 114, 127, 138, 151, 162, 175];

/* -------------------------------------------------- deterministic source-guards */

describe("draft-room routes: cache policy is unconditional no-store (source-guard)", () => {
  for (const route of [RECS_ROUTE, MGR_DRAFT_ROUTE, LEAGUE_DRAFT_ROUTE]) {
    it(`${route} — success path uses "no-store", never a readiness/status-keyed cache`, () => {
      const src = readFileSync(route, "utf8");
      // no CDN caching primitives anywhere in the file
      assert.equal(/s-maxage/.test(src), false, "no s-maxage");
      assert.equal(/stale-while-revalidate/.test(src), false, "no stale-while-revalidate");
      assert.equal(/cacheHeader\s*\(/.test(src), false, "no cacheHeader() call");
      // the cache header is not conditional on engine/draft status
      assert.equal(
        /snake_engine_status\s*===\s*"READY"\s*\n?\s*\?/.test(src),
        false,
        "cache header not keyed to snake_engine_status",
      );
      assert.equal(
        /draft\.status\s*===\s*"drafting"\s*\n?\s*\?\s*cacheHeader/.test(src),
        false,
        "cache header not keyed to draft.status",
      );
      assert.ok(/"Cache-Control":\s*"no-store"/.test(src), "declares Cache-Control: no-store");
    });
  }
});

describe("real draft state is fetched live (source-guard)", () => {
  it("buildDraftBundle uses the *Live Sleeper helpers for draft/picks/rosters", () => {
    const src = readFileSync("lib/sleeper/draft-service.ts", "utf8");
    assert.ok(/getDraftLive\(/.test(src), "getDraftLive");
    assert.ok(/getDraftPicksLive\(/.test(src), "getDraftPicksLive");
    assert.ok(/getLeagueRostersLive\(/.test(src), "getLeagueRostersLive");
    assert.equal(/getLeagueRosters\(leagueId\)/.test(src), false, "no cached getLeagueRosters(leagueId)");
  });

  it("the recommendation service fetches the manager roster live", () => {
    const src = readFileSync("lib/draft/service.ts", "utf8");
    assert.ok(/getLeagueRostersLive\(manager\.league_id\)/.test(src));
  });

  it("the *Live helpers set cache: no-store", () => {
    const src = readFileSync("lib/sleeper/client.ts", "utf8");
    for (const fn of ["getDraftLive", "getDraftPicksLive", "getLeagueRostersLive"]) {
      const body = src.slice(src.indexOf(`export function ${fn}`));
      assert.ok(/noStore:\s*true/.test(body.slice(0, 260)), `${fn} sets noStore: true`);
    }
    assert.ok(/noStore\b[\s\S]{0,80}cache:\s*"no-store"/.test(src), 'fetchSleeper maps noStore -> cache: "no-store"');
  });
});

/* --------------------------------------------------------- live route behaviour */

async function callRecs(url: string) {
  const { GET } = await import("../app/api/leagues/[leagueSlug]/managers/[managerSlug]/recommendations/route");
  return GET(new Request(url), {
    params: Promise.resolve({ leagueSlug: LEAGUE, managerSlug: MANAGER }),
  });
}
async function callMgrDraft(url: string, managerSlug = MANAGER) {
  const { GET } = await import("../app/api/leagues/[leagueSlug]/managers/[managerSlug]/draft/route");
  return GET(new Request(url), {
    params: Promise.resolve({ leagueSlug: LEAGUE, managerSlug }),
  });
}

describe("LIVE — real recommendation endpoint (DEGRADED) is uncached + identity-correct", () => {
  it("returns 200, Cache-Control: no-store, correct identity/geometry, frozen model", async () => {
    const res = await callRecs(`https://x/api/leagues/${LEAGUE}/managers/${MANAGER}/recommendations`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");

    const body = (await res.json()) as Record<string, unknown>;
    const ctx = body.context as Record<string, unknown>;
    assert.equal(ctx.league_slug, LEAGUE);
    assert.equal(ctx.manager_slug, MANAGER);
    assert.equal(ctx.roster_id, 1);
    assert.equal(ctx.draft_slot, 7);
    assert.equal(ctx.draft_id, REAL_DRAFT_ID);

    const prov = body.provenance as Record<string, unknown>;
    assert.equal(prov.recommendation_model_version, "ri-snake-decision-2026.2");
    assert.equal(prov.projection_version, "ri-structural-2026.3");
    assert.equal(prov.market_consensus_version, "ri-snake-market-2026.1");
    assert.equal(prov.survival_model_version, "ri-snake-survival-2026.1");

    const readiness = body.readiness as Record<string, unknown>;
    assert.equal(readiness.draft_engine_mode, "SNAKE_ONLY");
    // DEGRADED for the documented K/DEF gap, or READY — never keyed to caching.
    assert.ok(["READY", "DEGRADED"].includes(readiness.snake_engine_status as string));
    assert.deepEqual(readiness.blocked_reasons, []);

    assert.equal(Object.prototype.hasOwnProperty.call(body, "mock_draft_diagnostics"), false);
    assert.equal(res.headers.get("x-mock-draft-override"), null);

    const turn = body.turn as Record<string, unknown>;
    assert.equal(turn.team_count, 12);
    assert.equal(turn.rounds, 15);
    assert.equal(turn.slot, 7);
    assert.deepEqual((turn.all_picks as Array<{ overall: number }>).map((p) => p.overall), SLOT7);
    if (turn.overall_picks_made === 0) {
      assert.equal((turn.current_pick as { overall: number }).overall, 7);
      assert.equal((turn.next_manager_pick as { overall: number }).overall, 18);
      assert.equal(turn.own_picks_made, 0);
    }
  });

  it("production gate: ?draft_id= is rejected 403 when VERCEL_ENV=production", async () => {
    const prev = process.env.VERCEL_ENV;
    process.env.VERCEL_ENV = "production";
    try {
      const res = await callRecs(
        `https://x/api/leagues/${LEAGUE}/managers/${MANAGER}/recommendations?draft_id=1396600871957061632&slot=7`,
      );
      assert.equal(res.status, 403);
      const body = (await res.json()) as { error: string };
      assert.equal(body.error, "mock_override_disabled");
    } finally {
      if (prev === undefined) delete process.env.VERCEL_ENV;
      else process.env.VERCEL_ENV = prev;
    }
  });

  it("unknown manager -> 404, no fallback", async () => {
    const { GET } = await import("../app/api/leagues/[leagueSlug]/managers/[managerSlug]/recommendations/route");
    const res = await GET(new Request(`https://x/api/leagues/${LEAGUE}/managers/zzz-not-real/recommendations`), {
      params: Promise.resolve({ leagueSlug: LEAGUE, managerSlug: "zzz-not-real" }),
    });
    assert.equal(res.status, 404);
  });
});

describe("LIVE — real raw K/DEF fallback board is uncached + complete", () => {
  it("pre_draft manager draft board: Cache-Control: no-store, full K & DEF pools", async () => {
    const res = await callMgrDraft(
      `https://x/api/leagues/${LEAGUE}/managers/${MANAGER}/draft?available_limit=1000`,
    );
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");

    const body = (await res.json()) as Record<string, unknown>;
    const draft = body.draft as Record<string, unknown>;
    assert.equal(draft.draft_id, REAL_DRAFT_ID);
    assert.equal(draft.type, "snake");
    assert.equal((body.context as Record<string, unknown>).draft_slot, 7);

    const avail = body.available_players as Array<{ position: string }>;
    const def = avail.filter((p) => p.position === "DEF");
    const k = avail.filter((p) => p.position === "K");
    assert.equal(def.length, 32, "all 32 team defenses visible");
    assert.ok(k.length >= 30, `K pool visible (${k.length})`);
  });

  it("unknown manager on the draft board -> 404", async () => {
    const res = await callMgrDraft(
      `https://x/api/leagues/${LEAGUE}/managers/zzz-not-real/draft`,
      "zzz-not-real",
    );
    assert.equal(res.status, 404);
  });
});
