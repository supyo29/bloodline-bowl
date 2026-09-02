/**
 * Production-equivalent smoke tests for the Post-Draft Foundation routes.
 *
 * Hits the real Sleeper API (guarded by an online probe — skips cleanly
 * offline). Yahoo routes are exercised in their expected pre-auth state.
 * Persistence is NOT required: routes fall back to live reads and report an
 * explicit NOT_CONFIGURED / NOT_CAPTURED state.
 */

import assert from "node:assert/strict";
import { before, describe, it } from "node:test";

import type { CanonicalLeagueSnapshot } from "../lib/canonical/schema";
import type { ManagerContext } from "../lib/canonical/manager-context";

let online = false;
before(async () => {
  try {
    const res = await fetch("https://api.sleeper.app/v1/state/nfl", { signal: AbortSignal.timeout(5000) });
    online = res.ok;
  } catch {
    online = false;
  }
});

interface RouteModule {
  GET: (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;
}
interface NoArgRouteModule {
  GET: () => Promise<Response>;
}

async function callRoute<T>(
  mod: string,
  params: Record<string, string>,
  query = "",
): Promise<{ status: number; body: T }> {
  const { GET } = (await import(mod)) as RouteModule;
  const res = await GET(new Request(`https://x${query}`), { params: Promise.resolve(params) });
  return { status: res.status, body: (await res.json()) as T };
}

/* ------------------------------------------------------------- /api/providers */

interface ProvidersBody {
  providers: Record<string, { status: string; authentication: string }>;
  persistence: { backend: string; status: string };
  leagues: Array<{ league_slug: string; provider: string; config_status: string }>;
}

describe("smoke: GET /api/providers", () => {
  it("reports sleeper + yahoo with real statuses", async () => {
    const { GET } = (await import("../app/api/providers/route")) as NoArgRouteModule;
    const res = await GET();
    assert.equal(res.status, 200);
    const body = (await res.json()) as ProvidersBody;
    assert.ok(body.providers.sleeper);
    assert.equal(body.providers.yahoo?.authentication, "OAUTH");
    assert.ok(["NOT_CONFIGURED", "AUTH_REQUIRED", "READY"].includes(body.providers.yahoo!.status));
    assert.ok(["none", "supabase"].includes(body.persistence.backend));
    const slugs = body.leagues.map((l) => l.league_slug);
    assert.ok(slugs.includes("bloodline-bowl"));
    assert.ok(slugs.includes("maclin-on-chicks-xvi"));
    assert.ok(slugs.includes("rogers-park"));
    for (const slug of ["maclin-on-chicks-xvi", "rogers-park"]) {
      const y = body.leagues.find((l) => l.league_slug === slug)!;
      assert.equal(y.provider, "yahoo");
      assert.equal(y.config_status, "AWAITING_CREDENTIALS");
    }
  });
});

/* ------------------------------------------------- /api/league/{league}/state */

interface StateBody {
  live_provider_status: string;
  error?: string;
  state: CanonicalLeagueSnapshot;
}

describe("smoke: GET /api/league/{league}/state", () => {
  it("bloodline-bowl returns canonical state from Sleeper", async (t) => {
    if (!online) return t.skip("Sleeper offline");
    const { status, body } = await callRoute<StateBody>("../app/api/league/[league]/state/route", { league: "bloodline-bowl" });
    assert.equal(status, 200);
    assert.equal(body.state.league.league_slug, "bloodline-bowl");
    assert.equal(body.state.league.provenance.provider, "sleeper");
    assert.equal(body.state.schema_version, 1);
    assert.ok(Array.isArray(body.state.teams));
    assert.ok(["READY", "PARTIAL"].includes(body.live_provider_status));
  });

  it("devoted-to-the-game returns its OWN state (isolation)", async (t) => {
    if (!online) return t.skip("Sleeper offline");
    const { body } = await callRoute<StateBody>("../app/api/league/[league]/state/route", { league: "devoted-to-the-game" });
    assert.equal(body.state.league.league_slug, "devoted-to-the-game");
    assert.ok(body.state.teams.every((tm) => tm.canonical_team_id.startsWith("team:devoted-to-the-game:")));
  });

  it("maclin-on-chicks-xvi returns an explicit Yahoo pre-auth state, not fabricated data", async () => {
    const { body } = await callRoute<StateBody>("../app/api/league/[league]/state/route", { league: "maclin-on-chicks-xvi" });
    assert.ok(["NOT_CONFIGURED", "AUTH_REQUIRED"].includes(body.live_provider_status));
    assert.equal(body.state.teams.length, 0);
  });

  it("an unknown league is a clean 404", async () => {
    const { status, body } = await callRoute<StateBody>("../app/api/league/[league]/state/route", { league: "nope-not-real" });
    assert.equal(status, 404);
    assert.equal(body.error, "league_not_found");
  });
});

/* --------------------------------------------- /api/context/{league}/{manager} */

interface ContextBody {
  error?: string;
  context: { league_slug: string; manager_slug: string };
  manager_context: ManagerContext;
}

describe("smoke: GET /api/context/{league}/{manager}", () => {
  for (const [league, manager] of [
    ["bloodline-bowl", "supyo29"],
    ["bloodline-bowl", "BijiMac"],
    ["devoted-to-the-game", "DarthMarker"],
  ] as const) {
    it(`${manager} @ ${league} resolves generically`, async (t) => {
      if (!online) return t.skip("Sleeper offline");
      const { status, body } = await callRoute<ContextBody>("../app/api/context/[league]/[manager]/route", { league, manager });
      assert.equal(status, 200, JSON.stringify(body).slice(0, 200));
      assert.equal(body.context.league_slug, league);
      assert.equal(body.context.manager_slug.toLowerCase(), manager.toLowerCase());
      assert.ok(body.manager_context.team.canonical_team_id.startsWith(`team:${league}:`));
      assert.ok(Array.isArray(body.manager_context.roster.starters));
    });
  }

  it("a non-member manager is 404, never a fallback", async (t) => {
    if (!online) return t.skip("Sleeper offline");
    const { status, body } = await callRoute<ContextBody>("../app/api/context/[league]/[manager]/route", {
      league: "bloodline-bowl",
      manager: "darthmarker",
    });
    assert.equal(status, 404);
    assert.equal(body.error, "manager_not_in_league");
  });
});

/* ------------------------------------------------- /api/transactions/{league} */

interface TxnBody {
  source: string;
  status?: string;
  league_slug: string;
  transactions: unknown[];
}

describe("smoke: GET /api/transactions/{league}", () => {
  it("bloodline-bowl returns canonical transactions (live fallback if ledger empty)", async (t) => {
    if (!online) return t.skip("Sleeper offline");
    const { status, body } = await callRoute<TxnBody>("../app/api/transactions/[league]/route", { league: "bloodline-bowl" });
    assert.equal(status, 200);
    assert.ok(["ledger", "live_provider"].includes(body.source));
    assert.ok(Array.isArray(body.transactions));
    assert.equal(body.league_slug, "bloodline-bowl");
  });

  it("maclin (Yahoo) reports AUTH_REQUIRED rather than serving fabricated transactions", async () => {
    const { body } = await callRoute<TxnBody>("../app/api/transactions/[league]/route", { league: "maclin-on-chicks-xvi" });
    assert.equal(body.transactions.length, 0);
    assert.ok(body.source === "unavailable" || body.status === "AUTH_REQUIRED");
  });
});

/* ------------------------------------------- /api/history/{league}/week/{week} */

describe("smoke: GET /api/history/{league}/week/{week}", () => {
  it("returns an explicit persistence/capture state, never an empty success", async () => {
    const { status, body } = await callRoute<{ status: string }>(
      "../app/api/history/[league]/week/[week]/route",
      { league: "bloodline-bowl", week: "1" },
    );
    assert.equal(status, 200);
    assert.ok(["PERSISTENCE_NOT_CONFIGURED", "NOT_CAPTURED", "READY"].includes(body.status));
  });
});

/* --------------------------------------------------- Yahoo auth (pre-auth) */

describe("smoke: Yahoo auth routes in pre-auth state", () => {
  it("/api/auth/yahoo/status reports configured=false with missing env named", async () => {
    const { GET } = (await import("../app/api/auth/yahoo/status/route")) as NoArgRouteModule;
    const res = await GET();
    const body = (await res.json()) as { configured: boolean; missing_env: string[] };
    assert.equal(body.configured, false);
    assert.ok(body.missing_env.includes("YAHOO_CLIENT_ID"));
  });

  it("/api/auth/yahoo/connect returns NOT_CONFIGURED (503), not a broken redirect", async () => {
    const { GET } = (await import("../app/api/auth/yahoo/connect/route")) as NoArgRouteModule;
    const res = await GET();
    assert.equal(res.status, 503);
    const body = (await res.json()) as { status: string };
    assert.equal(body.status, "NOT_CONFIGURED");
  });
});
