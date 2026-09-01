/**
 * PHASE 1 — available-player pool integrity.
 *
 * Deterministic, fixture-only. Proves the authoritative eligibility predicate
 * and that every draft-pool path agrees on it.
 *
 *   Eligible(p)      = supported_position ∧ active!==false ∧ has_current_nfl_team
 *   EligibleDEF(p)   = valid_defense_entity ∧ active!==false ∧ has_current_nfl_team
 *   Available(p, D)  = Eligible(p) ∧ player_id(p) ∉ DraftedPlayerIds(D)
 *
 * No player name is referenced by the implementation or by these assertions —
 * the fixtures demonstrate the structural rule.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { NormalizedPlayer } from "../lib/sleeper/types";
import type { PlayerIndex } from "../lib/sleeper/client";
import {
  eligibilityOf,
  isCurrentlyDraftable,
  SUPPORTED_FANTASY_POSITIONS,
} from "../lib/sleeper/eligibility";
import {
  buildAvailablePlayers,
  buildAvailablePlayerPool,
} from "../lib/sleeper/draft";
import { buildManagerRecommendations } from "../lib/leagues/manager-draft";

/* ------------------------------------------------------------- fixtures */

function mk(over: Partial<NormalizedPlayer> & { player_id: string }): NormalizedPlayer {
  // `pick(key, default)` respects an EXPLICITLY-passed value (incl. null),
  // unlike `??` — so `mk({ team: null })` really means teamless.
  const pick = <K extends keyof NormalizedPlayer>(
    key: K,
    fallback: NormalizedPlayer[K],
  ): NormalizedPlayer[K] => (key in over ? (over[key] as NormalizedPlayer[K]) : fallback);
  const position = pick("position", "RB");
  return {
    player_id: over.player_id,
    full_name: pick("full_name", `Player ${over.player_id}`),
    first_name: pick("first_name", null),
    last_name: pick("last_name", null),
    position,
    fantasy_positions: pick("fantasy_positions", position ? [position] : []),
    team: pick("team", "KC"),
    age: pick("age", 25),
    years_exp: pick("years_exp", 3),
    status: pick("status", "Active"),
    injury_status: pick("injury_status", null),
    number: pick("number", null),
    active: pick("active", true),
    search_rank: pick("search_rank", 100),
    depth_chart_order: pick("depth_chart_order", 1),
    depth_chart_position: pick("depth_chart_position", null),
    resolved: pick("resolved", true),
  };
}

const ROSTER_POSITIONS = [
  "QB", "QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "FLEX", "K", "DEF",
  "BN", "BN", "BN", "BN", "BN",
];

// One record per class of interest.
const F = {
  qb: mk({ player_id: "qb-ok", position: "QB", team: "BUF", search_rank: 3 }),
  rb: mk({ player_id: "rb-ok", position: "RB", team: "SF", search_rank: 5 }),
  wr: mk({ player_id: "wr-ok", position: "WR", team: "CIN", search_rank: 2 }),
  te: mk({ player_id: "te-ok", position: "TE", team: "KC", search_rank: 8 }),
  k: mk({ player_id: "k-ok", position: "K", team: "BAL", search_rank: 140 }),
  def: mk({
    player_id: "DET", full_name: "Detroit Lions", first_name: "Detroit",
    last_name: "Lions", position: "DEF", fantasy_positions: ["DEF"], team: "DET",
    search_rank: null, status: null,
  }),
  // Stale: real fantasy position, still active:true, but no NFL team (retired).
  staleQb: mk({ player_id: "qb-stale", position: "QB", team: null, active: true, status: "Active", search_rank: 74 }),
  staleWr: mk({ player_id: "wr-stale", position: "WR", team: null, active: true, status: "Injured Reserve", search_rank: 92 }),
  staleK: mk({ player_id: "k-stale", position: "K", team: null, active: true, search_rank: 222 }),
  // Explicitly deactivated by Sleeper.
  inactive: mk({ player_id: "rb-inactive", position: "RB", team: "CHI", active: false, status: "Inactive" }),
  // In-season IR player: legitimately still on a roster -> must stay eligible.
  injuredStarter: mk({ player_id: "wr-ir", position: "WR", team: "MIA", active: true, status: "Injured Reserve", injury_status: "IR" }),
  // Rookie on a team -> must stay eligible.
  rookie: mk({ player_id: "wr-rook", position: "WR", team: "LV", years_exp: 0, age: 22, depth_chart_order: 3 }),
  // Unsupported position (IDP) -> fail closed.
  idp: mk({ player_id: "lb-1", position: "LB", fantasy_positions: ["LB"], team: "GB" }),
  // Malformed: no position at all.
  malformedNoPos: mk({ player_id: "bad-1", position: null, fantasy_positions: [], team: "KC" }),
  // Malformed: unresolved record (id not in Sleeper DB).
  malformedUnresolved: mk({ player_id: "bad-2", position: "RB", team: "KC", resolved: false }),
  // DEF-shaped but no team -> fail closed via the DEF branch.
  defNoTeam: mk({ player_id: "def-bad", position: "DEF", fantasy_positions: ["DEF"], team: null }),
};

function indexOf(players: NormalizedPlayer[]): PlayerIndex {
  return new Map(players.map((p) => [p.player_id, p]));
}

/* ------------------------------------------------------------- predicate */

describe("eligibilityOf — the authoritative predicate", () => {
  it("accepts a normal active QB/RB/WR/TE/K on an NFL team", () => {
    for (const p of [F.qb, F.rb, F.wr, F.te, F.k]) {
      const v = eligibilityOf(p);
      assert.equal(v.eligible, true, `${p.player_id} should be eligible`);
      assert.equal(v.reason, "eligible");
      assert.equal(v.is_defense, false);
    }
  });

  it("accepts a valid team defense via an explicit DEF branch", () => {
    const v = eligibilityOf(F.def);
    assert.equal(v.eligible, true);
    assert.equal(v.is_defense, true);
    assert.equal(v.reason, "eligible");
  });

  it("STALE PLAYER: supported position + active:true + team:null is NOT eligible (missing_team)", () => {
    for (const p of [F.staleQb, F.staleWr, F.staleK]) {
      const v = eligibilityOf(p);
      assert.equal(v.eligible, false, `${p.player_id} must be excluded`);
      assert.equal(v.reason, "missing_team");
    }
  });

  it("INACTIVE: active:false is excluded even with a team", () => {
    const v = eligibilityOf(F.inactive);
    assert.equal(v.eligible, false);
    assert.equal(v.reason, "inactive");
  });

  it("does NOT over-filter: in-season IR player with a team stays eligible", () => {
    assert.equal(isCurrentlyDraftable(F.injuredStarter), true);
  });

  it("does NOT over-filter: a rostered rookie on a team stays eligible", () => {
    assert.equal(isCurrentlyDraftable(F.rookie), true);
  });

  it("fails closed on unsupported positions (IDP)", () => {
    assert.equal(eligibilityOf(F.idp).reason, "unsupported_position");
  });

  it("fails closed on malformed records without throwing", () => {
    assert.equal(eligibilityOf(F.malformedNoPos).reason, "malformed");
    assert.equal(eligibilityOf(F.malformedUnresolved).reason, "malformed");
    assert.equal(eligibilityOf(null).reason, "malformed");
    assert.equal(eligibilityOf(undefined).reason, "malformed");
    // @ts-expect-error — deliberately hostile input
    assert.equal(eligibilityOf(42).reason, "malformed");
    // @ts-expect-error — deliberately hostile input
    assert.equal(eligibilityOf({}).reason, "malformed");
  });

  it("fails closed on a DEF-shaped record with no team", () => {
    const v = eligibilityOf(F.defNoTeam);
    assert.equal(v.eligible, false);
    assert.equal(v.is_defense, true);
    assert.equal(v.reason, "missing_team");
  });

  it("supported set is exactly QB/RB/WR/TE/K/DEF", () => {
    assert.deepEqual([...SUPPORTED_FANTASY_POSITIONS].sort(), ["DEF", "K", "QB", "RB", "TE", "WR"]);
  });

  it("NO NAME HARDCODING: eligibility depends only on structure, not identity", () => {
    const legendName = mk({ player_id: "x1", full_name: "Tom Brady", position: "QB", team: "TB", active: true });
    const nobodyName = mk({ player_id: "x2", full_name: "Completely Made Up Person", position: "QB", team: null, active: true });
    // A "famous retired" name on a team is eligible; an unknown name off a team is not.
    assert.equal(isCurrentlyDraftable(legendName), true);
    assert.equal(isCurrentlyDraftable(nobodyName), false);
  });
});

/* ------------------------------------------------ shared /api/draft pool */

describe("buildAvailablePlayerPool — shared pool", () => {
  const allPlayers = Object.values(F);
  const pool = () =>
    buildAvailablePlayerPool({
      playerIndex: indexOf(allPlayers),
      takenPlayerIds: new Set<string>(),
      rosterPositions: ROSTER_POSITIONS,
      limit: 1000,
    });

  it("STALE PLAYER never enters the pool", () => {
    const ids = new Set(pool().players.map((p) => p.player_id));
    assert.ok(!ids.has("qb-stale"));
    assert.ok(!ids.has("wr-stale"));
    assert.ok(!ids.has("k-stale"));
  });

  it("DEF EXCEPTION: the valid defense is in the pool", () => {
    assert.ok(pool().players.some((p) => p.player_id === "DET"));
  });

  it("inactive / malformed / IDP / teamless-DEF never enter the pool", () => {
    const ids = new Set(pool().players.map((p) => p.player_id));
    for (const bad of ["rb-inactive", "bad-1", "bad-2", "lb-1", "def-bad"]) {
      assert.ok(!ids.has(bad), `${bad} must be excluded`);
    }
  });

  it("legitimate players (incl. IR + rookie) remain available", () => {
    const ids = new Set(pool().players.map((p) => p.player_id));
    for (const ok of ["qb-ok", "rb-ok", "wr-ok", "te-ok", "k-ok", "DET", "wr-ir", "wr-rook"]) {
      assert.ok(ids.has(ok), `${ok} must be available`);
    }
  });

  it("DRAFTED PLAYER: an eligible player whose id is taken is excluded; an undrafted one stays", () => {
    const drafted = new Set(["rb-ok"]);
    const players = buildAvailablePlayerPool({
      playerIndex: indexOf(allPlayers),
      takenPlayerIds: drafted,
      rosterPositions: ROSTER_POSITIONS,
      limit: 1000,
    }).players;
    const ids = new Set(players.map((p) => p.player_id));
    assert.ok(!ids.has("rb-ok"), "drafted player excluded");
    assert.ok(ids.has("wr-ok"), "undrafted eligible player stays");
  });

  it("exposes aggregated integrity diagnostics with per-reason counts", () => {
    const d = pool().diagnostics;
    // 3 stale skill players (qb/wr/k) + 1 DEF-shaped record with no team.
    assert.equal(d.excluded_by_reason.missing_team, 4);
    assert.equal(d.excluded_by_reason.inactive, 1);
    assert.equal(d.excluded_by_reason.malformed, 2);
    // IDP is excluded from the POOL (proven elsewhere) but not counted here —
    // it is never a candidate for a standard-lineup league, so counting it would
    // bury the real contamination signal.
    assert.equal(d.excluded_by_reason.unsupported_position, 0);
    assert.equal(d.eligible_player_count + d.excluded_player_count, d.player_pool_total);
    assert.equal(d.already_drafted_count, 0);
    assert.equal(
      d.stale_or_invalid_player_count,
      d.excluded_by_reason.missing_team +
        d.excluded_by_reason.inactive +
        d.excluded_by_reason.malformed,
    );
  });

  it("the back-compat array shim returns the same players", () => {
    const arr = buildAvailablePlayers({
      playerIndex: indexOf(allPlayers),
      takenPlayerIds: new Set<string>(),
      rosterPositions: ROSTER_POSITIONS,
      limit: 1000,
    });
    assert.deepEqual(
      arr.map((p) => p.player_id).sort(),
      pool().players.map((p) => p.player_id).sort(),
    );
  });
});

/* ---------------------------------------- cross-path consistency ------- */

describe("cross-path eligibility consistency", () => {
  const allPlayers = Object.values(F);

  it("the shared pool and manager recommendation filter agree for every fixture", () => {
    const sharedEligibleIds = new Set(
      buildAvailablePlayerPool({
        playerIndex: indexOf(allPlayers),
        takenPlayerIds: new Set<string>(),
        rosterPositions: ROSTER_POSITIONS,
        limit: 1000,
      }).players.map((p) => p.player_id),
    );

    // Manager recommendations: empty roster -> "wanted" covers many positions,
    // but the eligibility gate is position-independent, so run with a full
    // roster (wantedSet empty => pure best-available) to isolate eligibility.
    const fullRoster: NormalizedPlayer[] = [
      mk({ player_id: "r1", position: "QB", team: "KC" }),
      mk({ player_id: "r2", position: "QB", team: "KC" }),
      mk({ player_id: "r3", position: "RB", team: "KC" }),
      mk({ player_id: "r4", position: "RB", team: "KC" }),
      mk({ player_id: "r5", position: "WR", team: "KC" }),
      mk({ player_id: "r6", position: "WR", team: "KC" }),
      mk({ player_id: "r7", position: "TE", team: "KC" }),
      mk({ player_id: "r8", position: "RB", team: "KC" }),
      mk({ player_id: "r9", position: "WR", team: "KC" }),
      mk({ player_id: "r10", position: "K", team: "KC" }),
      mk({ player_id: "r11", position: "DEF", fantasy_positions: ["DEF"], team: "KC" }),
    ];

    const { recommendations } = buildManagerRecommendations({
      manager: { manager_slug: "m", sleeper_user_id: "u", roster_id: 1, draft_slot: 1 },
      rosterPlayers: fullRoster,
      rosterPositions: ROSTER_POSITIONS,
      availablePlayers: allPlayers, // deliberately hand it the RAW list incl. stale
      count: 100,
    });
    const recIds = new Set(recommendations.map((r) => r.player_id));

    // Every stale/invalid fixture the shared pool rejects, the recommendation
    // filter must also reject — even when handed the unfiltered list.
    for (const p of allPlayers) {
      const inShared = sharedEligibleIds.has(p.player_id);
      const inRecs = recIds.has(p.player_id);
      assert.equal(
        inRecs,
        inShared,
        `${p.player_id}: shared pool ${inShared} vs manager recs ${inRecs}`,
      );
    }
  });

  it("isCurrentlyDraftable matches the shared pool's membership for every fixture", () => {
    const poolIds = new Set(
      buildAvailablePlayerPool({
        playerIndex: indexOf(allPlayers),
        takenPlayerIds: new Set<string>(),
        rosterPositions: ROSTER_POSITIONS,
        limit: 1000,
      }).players.map((p) => p.player_id),
    );
    for (const p of allPlayers) {
      // pool membership also requires a league-draftable position; every fixture
      // here IS league-draftable except the IDP LB.
      const expected = isCurrentlyDraftable(p) && p.player_id !== "lb-1";
      assert.equal(poolIds.has(p.player_id), expected, `${p.player_id}`);
    }
  });
});
