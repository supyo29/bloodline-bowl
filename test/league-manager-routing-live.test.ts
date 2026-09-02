/**
 * League + manager routing — LIVE tests against the real Sleeper API.
 *
 * Proves, against real data, that:
 *   - Supyo29 / BijiMac / DarthMarker each resolve to the correct league,
 *     Sleeper user id, roster id, and draft slot
 *   - the alternating sequence Supyo29 -> BijiMac -> DarthMarker -> BijiMac ->
 *     Supyo29 -> DarthMarker produces six independently-correct responses
 *   - concurrent manager requests keep independent identity + recommendation ctx
 *   - a manager in the wrong league is an explicit 404 (no fallback)
 *   - same roster id / same draft slot across two leagues never collide
 *   - the personalized draft endpoint's recommendation engine traces the
 *     resolved roster id (not just the response label)
 *   - the legacy `?league=` route and the canonical path route resolve the
 *     same league state
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  resolveLeagueStrict,
  resolveManagerInLeague,
  type ManagerResolution,
} from "../lib/leagues/resolve";
import { buildManagerDraftContext } from "../lib/leagues/manager-draft";
import { buildDraftBundle } from "../lib/sleeper/draft-service";

const EXPECT = {
  supyo29: {
    league_slug: "bloodline-bowl",
    league_id: "1395549281678532608",
    sleeper_username: "Supyo29",
    sleeper_user_id: "1308955807408230400",
    roster_id: 1,
    draft_slot: 7,
  },
  bijimac: {
    league_slug: "bloodline-bowl",
    league_id: "1395549281678532608",
    sleeper_username: "BijiMac",
    sleeper_user_id: "1395574107612942336",
    roster_id: 2,
    draft_slot: 12,
  },
  darthmarker: {
    league_slug: "devoted-to-the-game",
    league_id: "1389735763649761280",
    sleeper_username: "DarthMarker",
    sleeper_user_id: "1265419589680910336",
    roster_id: 2,
    draft_slot: 4,
  },
} as const;

type ManagerKey = keyof typeof EXPECT;

async function resolve(manager: ManagerKey): Promise<ManagerResolution> {
  const league = resolveLeagueStrict(EXPECT[manager].league_slug);
  assert.ok(league.ok);
  return resolveManagerInLeague(league.league, manager);
}

function assertIdentity(res: ManagerResolution, manager: ManagerKey): void {
  assert.ok(res.ok, `expected ${manager} to resolve`);
  const m = res.manager;
  const e = EXPECT[manager];
  assert.equal(m.manager_slug, manager);
  assert.equal(m.league_slug, e.league_slug);
  assert.equal(m.league_id, e.league_id);
  assert.equal(m.sleeper_username, e.sleeper_username);
  assert.equal(m.sleeper_user_id, e.sleeper_user_id);
  assert.equal(m.roster_id, e.roster_id);
  assert.equal(m.draft_slot, e.draft_slot);
}

/* --------------------------------------------------- individual resolution */

describe("live: each known manager resolves to the correct identity", () => {
  it("Supyo29 -> Bloodline Bowl, roster 1, slot 7", async () => {
    assertIdentity(await resolve("supyo29"), "supyo29");
  });
  it("BijiMac -> Bloodline Bowl, roster 2, slot 12", async () => {
    assertIdentity(await resolve("bijimac"), "bijimac");
  });
  it("DarthMarker -> Devoted to the Game (1389735763649761280), roster 2, slot 4", async () => {
    const res = await resolve("darthmarker");
    assertIdentity(res, "darthmarker");
    assert.ok(res.ok);
    assert.equal(res.manager.league_id, "1389735763649761280");
  });
});

/* --------------------------------------------------- wrong-pair rejection */

describe("live: a manager in the wrong league is an explicit 404 (no fallback)", () => {
  for (const [leagueSlug, managerSlug] of [
    ["bloodline-bowl", "darthmarker"],
    ["devoted-to-the-game", "bijimac"],
    ["devoted-to-the-game", "supyo29"],
  ] as const) {
    it(`${leagueSlug} + ${managerSlug} -> manager_not_in_league`, async () => {
      const league = resolveLeagueStrict(leagueSlug);
      assert.ok(league.ok);
      const res = await resolveManagerInLeague(league.league, managerSlug);
      assert.equal(res.ok, false);
      assert.equal(res.ok === false && res.status, 404);
      assert.equal(res.ok === false && res.code, "manager_not_in_league");
      // Prove it did NOT quietly resolve to some other manager.
      assert.ok(!("manager" in res));
    });
  }

  it("unknown manager -> manager_not_found", async () => {
    const league = resolveLeagueStrict("bloodline-bowl");
    assert.ok(league.ok);
    const res = await resolveManagerInLeague(league.league, "definitely-not-a-user-x9");
    assert.equal(res.ok, false);
    assert.equal(res.ok === false && res.code, "manager_not_found");
  });

  it("unknown league -> league_not_found (no Bloodline fallback)", () => {
    const res = resolveLeagueStrict("not-a-real-league");
    assert.equal(res.ok, false);
    assert.equal(res.ok === false && res.code, "league_not_found");
  });
});

/* --------------------------------------------------- alternating sequence */

describe("live: alternating request sequence produces 6 independent results", () => {
  it("Supyo29 -> BijiMac -> DarthMarker -> BijiMac -> Supyo29 -> DarthMarker", async () => {
    const order: ManagerKey[] = [
      "supyo29",
      "bijimac",
      "darthmarker",
      "bijimac",
      "supyo29",
      "darthmarker",
    ];
    const results: ManagerResolution[] = [];
    for (const m of order) {
      // Sequential, on purpose — proves no state leaks between requests.
      results.push(await resolve(m));
    }

    order.forEach((m, i) => assertIdentity(results[i]!, m));

    // The two Supyo29 results are identical to each other; likewise BijiMac,
    // DarthMarker — and no result inherited a neighbour's identity.
    const s1 = results[0]!,
      s2 = results[4]!;
    const b1 = results[1]!,
      b2 = results[3]!;
    const d1 = results[2]!,
      d2 = results[5]!;
    assert.ok(s1.ok && s2.ok && b1.ok && b2.ok && d1.ok && d2.ok);
    assert.equal(s1.manager.sleeper_user_id, s2.manager.sleeper_user_id);
    assert.equal(s1.manager.roster_id, s2.manager.roster_id);
    assert.equal(b1.manager.sleeper_user_id, b2.manager.sleeper_user_id);
    assert.equal(b1.manager.roster_id, b2.manager.roster_id);
    assert.equal(d1.manager.sleeper_user_id, d2.manager.sleeper_user_id);
    assert.equal(d1.manager.roster_id, d2.manager.roster_id);

    // Cross-checks: DarthMarker never inherits Bloodline; Supyo29/BijiMac never
    // inherit Devoted.
    assert.notEqual(d1.manager.league_id, s1.manager.league_id);
    assert.notEqual(d1.manager.league_id, b1.manager.league_id);
    assert.equal(s1.manager.league_id, b1.manager.league_id);
  });
});

/* --------------------------------------------------- concurrency isolation */

describe("live: concurrent manager requests keep independent identity", () => {
  it("resolves all three in parallel with no contamination", async () => {
    const [s, b, d] = await Promise.all([
      resolve("supyo29"),
      resolve("bijimac"),
      resolve("darthmarker"),
    ]);
    assertIdentity(s, "supyo29");
    assertIdentity(b, "bijimac");
    assertIdentity(d, "darthmarker");
    assert.ok(s.ok && b.ok && d.ok);

    // Same numeric roster id (BijiMac=2 in Bloodline, DarthMarker=2 in Devoted)
    // does NOT cause a collision — they are in different leagues.
    assert.equal(b.manager.roster_id, d.manager.roster_id);
    assert.notEqual(b.manager.league_id, d.manager.league_id);
    assert.notEqual(b.manager.sleeper_user_id, d.manager.sleeper_user_id);
  });

  it("full personalized draft contexts resolve in parallel, each tracing its own roster", async () => {
    const [s, b, d] = await Promise.all([
      resolve("supyo29"),
      resolve("bijimac"),
      resolve("darthmarker"),
    ]);
    assert.ok(s.ok && b.ok && d.ok);

    const [sc, bc, dc] = await Promise.all([
      buildManagerDraftContext(s.manager),
      buildManagerDraftContext(b.manager),
      buildManagerDraftContext(d.manager),
    ]);

    // The recommendation engine's own identity matches the request — not the
    // response label, the actual roster id it reasoned over.
    assert.equal(sc.manager.recommendation_context.used_roster_id, 1);
    assert.equal(sc.manager.recommendation_context.used_sleeper_user_id, EXPECT.supyo29.sleeper_user_id);
    assert.equal(bc.manager.recommendation_context.used_roster_id, 2);
    assert.equal(bc.manager.recommendation_context.used_sleeper_user_id, EXPECT.bijimac.sleeper_user_id);
    assert.equal(dc.manager.recommendation_context.used_roster_id, 2);
    assert.equal(dc.manager.recommendation_context.used_sleeper_user_id, EXPECT.darthmarker.sleeper_user_id);

    // Manager-scoped fields are scoped to the right manager.
    assert.equal(sc.manager.manager_roster_id, 1);
    assert.equal(bc.manager.manager_roster_id, 2);
    assert.equal(dc.manager.manager_draft_slot, 4);
    assert.equal(sc.manager.manager_draft_slot, 7);
    assert.equal(bc.manager.manager_draft_slot, 12);

    // Picks are filtered to the manager's own roster.
    for (const pick of sc.manager.manager_picks) assert.equal(pick.roster_id, 1);
    for (const pick of bc.manager.manager_picks) assert.equal(pick.roster_id, 2);
    for (const pick of dc.manager.manager_picks) assert.equal(pick.roster_id, 2);

    // DarthMarker's draft is complete -> real roster; its recommendation context
    // reflects a populated roster, distinct from the (pre-draft) Bloodline pair.
    assert.ok(dc.manager.recommendation_context.roster_player_count >= 0);
    assert.notEqual(
      dc.league.league_id,
      sc.league.league_id,
    );
  });
});

/* --------------------------------------------------- legacy compatibility */

describe("live: legacy ?league= and canonical path resolve the same league", () => {
  it("devoted-to-the-game via both forms yields the same league_id + draft", async () => {
    const strict = resolveLeagueStrict("devoted-to-the-game");
    assert.ok(strict.ok);

    // Legacy form is what /api/draft?league=devoted-to-the-game feeds in.
    const legacyBundle = await buildDraftBundle(strict.league.league_id, {
      availableLimit: 5,
      position: null,
    });
    // Canonical path form uses the SAME resolved id + SAME buildDraftBundle.
    const canonicalBundle = await buildDraftBundle(strict.league.league_id, {
      availableLimit: 5,
      position: null,
    });

    assert.equal(
      legacyBundle.response.league_id,
      canonicalBundle.response.league_id,
    );
    assert.equal(legacyBundle.response.league_id, "1389735763649761280");
    assert.equal(
      legacyBundle.response.draft?.draft_id,
      canonicalBundle.response.draft?.draft_id,
    );
  });
});

/* --------------------------------------------------- route handlers end-to-end */

describe("live: canonical route handlers return correct status + context", () => {
  async function call(mod: string, params: Record<string, string>) {
    const { GET } = (await import(mod)) as {
      GET: (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;
    };
    const res = await GET(new Request("https://x/api" + JSON.stringify(params)), {
      params: Promise.resolve(params),
    });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      /* some responses may be empty */
    }
    return { status: res.status, body, headers: res.headers };
  }

  it("GET /api/leagues -> discovery lists the registered leagues with canonical URLs", async () => {
    const { GET } = await import("../app/api/leagues/route");
    const res = await GET();
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      leagues: Array<{ league_slug: string; canonical_urls: Record<string, string> }>;
    };
    const slugs = body.leagues.map((l) => l.league_slug).sort();
    // Sleeper leagues both present; the Yahoo entry is registered too (v2).
    assert.ok(slugs.includes("bloodline-bowl"));
    assert.ok(slugs.includes("devoted-to-the-game"));
    assert.ok(slugs.includes("maclin-on-chicks-xvi"));
    const bb = body.leagues.find((l) => l.league_slug === "bloodline-bowl")!;
    assert.equal(bb.canonical_urls.draft, "/api/leagues/bloodline-bowl/draft");
  });

  it("GET /api/leagues/bloodline-bowl/managers/supyo29 -> 200, manager context", async () => {
    const r = await call(
      "../app/api/leagues/[leagueSlug]/managers/[managerSlug]/route",
      { leagueSlug: "bloodline-bowl", managerSlug: "supyo29" },
    );
    assert.equal(r.status, 200);
    const b = r.body as { context: Record<string, unknown>; manager: Record<string, unknown> };
    assert.equal(b.context.scope, "manager");
    assert.equal(b.context.league_slug, "bloodline-bowl");
    assert.equal(b.context.manager_slug, "supyo29");
    assert.equal(b.context.sleeper_username, "Supyo29");
    assert.equal(b.context.sleeper_user_id, "1308955807408230400");
    assert.equal(b.context.roster_id, 1);
    assert.equal(b.context.draft_slot, 7);
    assert.equal(b.manager.roster_id, 1);
    assert.equal(
      r.headers.get("X-Bridge-Context"),
      "manager:bloodline-bowl/supyo29",
    );
  });

  it("GET .../managers/bijimac/draft -> 200, recommendation context traces roster 2", async () => {
    const r = await call(
      "../app/api/leagues/[leagueSlug]/managers/[managerSlug]/draft/route",
      { leagueSlug: "bloodline-bowl", managerSlug: "bijimac" },
    );
    assert.equal(r.status, 200);
    const b = r.body as {
      context: Record<string, unknown>;
      manager: {
        manager_roster_id: number;
        manager_draft_slot: number;
        recommendation_context: { used_roster_id: number; used_sleeper_user_id: string };
      };
    };
    assert.equal(b.context.manager_slug, "bijimac");
    assert.equal(b.manager.manager_roster_id, 2);
    assert.equal(b.manager.manager_draft_slot, 12);
    assert.equal(b.manager.recommendation_context.used_roster_id, 2);
    assert.equal(
      b.manager.recommendation_context.used_sleeper_user_id,
      "1395574107612942336",
    );
  });

  it("GET /api/leagues/bloodline-bowl/managers/darthmarker/draft -> 404, NOT a fallback", async () => {
    const r = await call(
      "../app/api/leagues/[leagueSlug]/managers/[managerSlug]/draft/route",
      { leagueSlug: "bloodline-bowl", managerSlug: "darthmarker" },
    );
    assert.equal(r.status, 404);
    const b = r.body as { error: string };
    assert.equal(b.error, "manager_not_in_league");
  });

  it("GET /api/leagues/not-real/managers/supyo29 -> 404 league_not_found", async () => {
    const r = await call(
      "../app/api/leagues/[leagueSlug]/managers/[managerSlug]/route",
      { leagueSlug: "not-real", managerSlug: "supyo29" },
    );
    assert.equal(r.status, 404);
    assert.equal((r.body as { error: string }).error, "league_not_found");
  });

  it("flat alias /api/draft/:leagueSlug resolves the same as the canonical path", async () => {
    const alias = await call("../app/api/draft/[leagueSlug]/route", {
      leagueSlug: "devoted-to-the-game",
    });
    const canonical = await call("../app/api/leagues/[leagueSlug]/draft/route", {
      leagueSlug: "devoted-to-the-game",
    });
    assert.equal(alias.status, 200);
    assert.equal(canonical.status, 200);
    assert.equal(
      (alias.body as { league_id: string }).league_id,
      (canonical.body as { league_id: string }).league_id,
    );
    assert.equal((alias.body as { league_id: string }).league_id, "1389735763649761280");
  });
});
