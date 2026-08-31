/**
 * League + manager routing — deterministic tests (no network).
 *
 * Proves the identity-separation contract without hitting Sleeper:
 *   - league slug resolution + "no silent fallback" on the path form
 *   - manager registry / slug normalization
 *   - the recommendation engine is roster-driven and traceable (two synthetic
 *     rosters -> two different recommendation sets + two different used_roster_id)
 *   - response context object shape
 *   - invalid-league HTTP handlers 404 without a network call
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  findRegisteredManager,
  findRegisteredManagerByUserId,
  listRegisteredManagers,
  managerSlugFromUsername,
} from "../lib/leagues/managers";
import {
  leagueContext,
  managerContext,
  resolveLeagueForQuery,
  resolveLeagueStrict,
  type ResolvedManager,
} from "../lib/leagues/resolve";
import { buildManagerRecommendations } from "../lib/leagues/manager-draft";
import type { NormalizedPlayer } from "../lib/sleeper/types";

/* ------------------------------------------------------------ manager registry */

describe("manager registry: canonical identity, never inferred from a name", () => {
  it("resolves the three known managers by slug and by exact username", () => {
    for (const [key, expectSlug, expectUser, expectId] of [
      ["supyo29", "supyo29", "Supyo29", "1308955807408230400"],
      ["Supyo29", "supyo29", "Supyo29", "1308955807408230400"],
      ["bijimac", "bijimac", "BijiMac", "1395574107612942336"],
      ["BijiMac", "bijimac", "BijiMac", "1395574107612942336"],
      ["darthmarker", "darthmarker", "DarthMarker", "1265419589680910336"],
      ["DARTHMARKER", "darthmarker", "DarthMarker", "1265419589680910336"],
    ] as const) {
      const m = findRegisteredManager(key);
      assert.ok(m, `expected to resolve ${key}`);
      assert.equal(m.manager_slug, expectSlug);
      assert.equal(m.sleeper_username, expectUser);
      assert.equal(m.sleeper_user_id, expectId);
    }
  });

  it("does not resolve human labels as identity", () => {
    assert.equal(findRegisteredManager("John"), null);
    assert.equal(findRegisteredManager("Biji"), null);
    assert.equal(findRegisteredManager("Mark"), null);
    assert.equal(findRegisteredManager(""), null);
    assert.equal(findRegisteredManager(null), null);
  });

  it("resolves by Sleeper user_id", () => {
    assert.equal(
      findRegisteredManagerByUserId("1395574107612942336")?.manager_slug,
      "bijimac",
    );
    assert.equal(findRegisteredManagerByUserId("0"), null);
  });

  it("normalizes any username to a stable lowercase slug", () => {
    assert.equal(managerSlugFromUsername("Supyo29"), "supyo29");
    assert.equal(managerSlugFromUsername("Some User!!"), "some-user");
    assert.equal(managerSlugFromUsername("keep_me-1"), "keep_me-1");
  });

  it("lists exactly the three registered managers", () => {
    assert.deepEqual(
      listRegisteredManagers().map((m) => m.manager_slug).sort(),
      ["bijimac", "darthmarker", "supyo29"],
    );
  });
});

/* -------------------------------------------------------------- league resolve */

describe("league resolution: path form REQUIRES a slug, never falls back", () => {
  it("resolves registered slugs", () => {
    const bb = resolveLeagueStrict("bloodline-bowl");
    assert.ok(bb.ok);
    assert.equal(bb.league.league_id, "1395549281678532608");
    assert.equal(bb.league.registered, true);

    const dv = resolveLeagueStrict("devoted-to-the-game");
    assert.ok(dv.ok);
    assert.equal(dv.league.league_id, "1389735763649761280");
  });

  it("accepts a raw numeric Sleeper id (unregistered)", () => {
    const r = resolveLeagueStrict("1389735763649761280");
    assert.ok(r.ok);
    assert.equal(r.league.league_id, "1389735763649761280");
    assert.equal(r.league.registered, false);
  });

  it("404s an unknown slug — NO fallback to Bloodline Bowl", () => {
    const r = resolveLeagueStrict("not-a-real-league");
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.status, 404);
    assert.equal(r.ok === false && r.code, "league_not_found");
  });

  it("400s an empty slug on the path form", () => {
    const r = resolveLeagueStrict("");
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.status, 400);
  });

  it("query form keeps the legacy default fallback for backward compat", () => {
    assert.equal(resolveLeagueForQuery(null).league_slug, "bloodline-bowl");
    assert.equal(resolveLeagueForQuery("").league_slug, "bloodline-bowl");
    assert.equal(
      resolveLeagueForQuery("devoted-to-the-game").league_id,
      "1389735763649761280",
    );
    // Both forms share the SAME registry lookup for a known slug.
    const strict = resolveLeagueStrict("devoted-to-the-game");
    assert.ok(strict.ok);
    assert.equal(
      resolveLeagueForQuery("devoted-to-the-game").league_id,
      strict.league.league_id,
    );
  });
});

/* ------------------------------------------------------- context object shape */

describe("response context: a client can see which league/manager was resolved", () => {
  it("league context", () => {
    const r = resolveLeagueStrict("bloodline-bowl");
    assert.ok(r.ok);
    const ctx = leagueContext(r.league);
    assert.deepEqual(ctx, {
      scope: "league",
      league_slug: "bloodline-bowl",
      league_id: "1395549281678532608",
      registered: true,
      canonical_url: "/api/leagues/bloodline-bowl",
    });
  });

  it("manager context echoes the full resolved identity", () => {
    const manager: ResolvedManager = {
      manager_slug: "bijimac",
      requested_slug: "BijiMac",
      sleeper_username: "BijiMac",
      sleeper_user_id: "1395574107612942336",
      display_name: "BijiMac",
      team_name: null,
      league_slug: "bloodline-bowl",
      league_id: "1395549281678532608",
      roster_id: 2,
      draft_slot: 12,
      draft_id: "1395549282349617152",
      draft_status: "pre_draft",
      is_co_owner: false,
      registered: true,
    };
    const ctx = managerContext(manager);
    assert.equal(ctx.scope, "manager");
    assert.equal(ctx.manager_slug, "bijimac");
    assert.equal(ctx.sleeper_username, "BijiMac");
    assert.equal(ctx.sleeper_user_id, "1395574107612942336");
    assert.equal(ctx.roster_id, 2);
    assert.equal(ctx.draft_slot, 12);
    assert.equal(
      ctx.canonical_url,
      "/api/leagues/bloodline-bowl/managers/bijimac",
    );
  });
});

/* --------------------------------------------- recommendation-context isolation */

function player(
  id: string,
  position: string,
  searchRank: number,
): NormalizedPlayer {
  return {
    player_id: id,
    full_name: `Player ${id}`,
    first_name: null,
    last_name: null,
    position,
    fantasy_positions: [position],
    team: "FA",
    age: null,
    years_exp: null,
    status: null,
    injury_status: null,
    number: null,
    active: true,
    search_rank: searchRank,
    resolved: true,
  };
}

const ROSTER_POSITIONS = [
  "QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "K", "DEF", "BN", "BN",
];

const POOL: NormalizedPlayer[] = [
  player("qb-a", "QB", 1),
  player("rb-a", "RB", 2),
  player("rb-b", "RB", 3),
  player("wr-a", "WR", 4),
  player("wr-b", "WR", 5),
  player("te-a", "TE", 6),
  player("k-a", "K", 7),
  player("def-a", "DEF", 8),
];

describe("recommendation engine is roster-driven and traceable", () => {
  it("two different rosters -> two different recommendation sets + used_roster_id", () => {
    // Manager A has a QB and two RBs already; still needs WR/TE/K/DEF.
    const a = buildManagerRecommendations({
      manager: {
        manager_slug: "manager-a",
        sleeper_user_id: "user-A",
        roster_id: 1,
        draft_slot: 7,
      },
      rosterPlayers: [player("owned-qb", "QB", 50), player("owned-rb1", "RB", 51), player("owned-rb2", "RB", 52)],
      rosterPositions: ROSTER_POSITIONS,
      availablePlayers: POOL,
    });

    // Manager B has two WRs and a TE; still needs QB/RB/K/DEF.
    const b = buildManagerRecommendations({
      manager: {
        manager_slug: "manager-b",
        sleeper_user_id: "user-B",
        roster_id: 2,
        draft_slot: 12,
      },
      rosterPlayers: [player("owned-wr1", "WR", 60), player("owned-wr2", "WR", 61), player("owned-te", "TE", 62)],
      rosterPositions: ROSTER_POSITIONS,
      availablePlayers: POOL,
    });

    // Traceable identity — the engine used each manager's own roster id/user id.
    assert.equal(a.context.used_roster_id, 1);
    assert.equal(a.context.used_sleeper_user_id, "user-A");
    assert.equal(b.context.used_roster_id, 2);
    assert.equal(b.context.used_sleeper_user_id, "user-B");

    // Different roster construction is reflected.
    assert.deepEqual(a.context.roster_position_counts, { QB: 1, RB: 2 });
    assert.deepEqual(b.context.roster_position_counts, { WR: 2, TE: 1 });

    // Different needs -> different recommended positions.
    const aPos = new Set(a.recommendations.map((r) => r.position));
    const bPos = new Set(b.recommendations.map((r) => r.position));
    assert.ok(bPos.has("QB"), "B still needs a QB and should be recommended one");
    assert.ok(!aPos.has("QB"), "A already has a QB, should not be pushed another as a strict need");
    assert.ok(aPos.has("WR"), "A still needs WR");

    // The two recommendation sets are genuinely different.
    assert.notDeepEqual(
      a.recommendations.map((r) => r.player_id),
      b.recommendations.map((r) => r.player_id),
    );

    // Every reason string cites the correct roster id — never the other's.
    for (const rec of a.recommendations) assert.match(rec.reason, /roster 1/);
    for (const rec of b.recommendations) assert.match(rec.reason, /roster 2/);
  });

  it("a full roster falls back to best-available, still tagged to the right roster", () => {
    const full = buildManagerRecommendations({
      manager: {
        manager_slug: "m",
        sleeper_user_id: "u",
        roster_id: 9,
        draft_slot: 3,
      },
      rosterPlayers: [
        player("a", "QB", 1), player("b", "RB", 2), player("c", "RB", 3),
        player("d", "WR", 4), player("e", "WR", 5), player("f", "TE", 6),
        player("g", "RB", 7), player("h", "K", 8), player("i", "DEF", 9),
      ],
      rosterPositions: ROSTER_POSITIONS,
      availablePlayers: POOL,
    });
    assert.equal(full.context.used_roster_id, 9);
    assert.ok(full.recommendations.length > 0);
    for (const rec of full.recommendations) assert.match(rec.reason, /roster 9/);
  });
});

/* --------------------------------------------- invalid-route HTTP (no network) */

describe("invalid path routes return an explicit non-200, no fallback", () => {
  it("unknown league -> 404 with machine code", async () => {
    const { GET } = await import(
      "../app/api/leagues/[leagueSlug]/route"
    );
    const res = await GET(new Request("https://x/api/leagues/not-real"), {
      params: Promise.resolve({ leagueSlug: "not-real" }),
    });
    assert.equal(res.status, 404);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, "league_not_found");
  });

  it("empty league slug -> 400", async () => {
    const { GET } = await import("../app/api/leagues/[leagueSlug]/draft/route");
    const res = await GET(new Request("https://x/api/leagues//draft"), {
      params: Promise.resolve({ leagueSlug: "" }),
    });
    assert.equal(res.status, 400);
  });
});
