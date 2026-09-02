/**
 * Waiver / add-drop engine — deterministic (PART XVI).
 *
 *  - a rostered player never appears as available
 *  - a crosswalk mismatch never creates false availability
 *  - add/drop net value is calculated
 *  - a candidate is rejected when the drop cost exceeds the add value
 *  - positional need affects the recommendation
 *  - bye coverage affects the recommendation
 *  - duplicate provider identities resolve to the same canonical player
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildWaiverRecommendations } from "../lib/weekly/waivers";
import { buildLeagueAvailability } from "../lib/weekly/availability";
import { player, proj, roster, weeklyContext, STD_CONSTRAINTS } from "./fixtures/weekly";
import type { CanonicalLeagueSnapshot } from "../lib/canonical/schema";

const FILLER = ["f1", "f2", "f3", "f4", "f5", "f6"].map((id) => player(id, "WR", { name: `Filler ${id}` }));
const ME = [
  player("qb1", "QB"), player("rb1", "RB"), player("rb2", "RB"),
  player("wr1", "WR"), player("wr2", "WR"), player("te1", "TE"),
  player("k1", "K"), player("def1", "DEF"),
  player("rbBench", "RB", { name: "Weak Bench RB" }),
  ...FILLER,
];
const MY_ROSTER = roster("team:test-league:1",
  ["qb1", "rb1", "rb2", "wr1", "wr2", "te1", "rbBench", "k1", "def1"],
  ["rbBench", "f1", "f2", "f3", "f4", "f5", "f6"]); // 15 rostered — at the size limit

const MY_PROJS = [
  proj("qb1", "QB", 20), proj("rb1", "RB", 16), proj("rb2", "RB", 12),
  proj("wr1", "WR", 15), proj("wr2", "WR", 13), proj("te1", "TE", 10),
  proj("k1", "K", 8), proj("def1", "DEF", 7), proj("rbBench", "RB", 4, { rest_of_season_points: 48 }),
  ...FILLER.map((p) => proj(p.canonical_player_id, "WR", 8.5, { rest_of_season_points: 100 })),
];

describe("waiver availability: never a rostered player", () => {
  it("a rostered player is classified rostered, never free_agent", () => {
    const ctx = weeklyContext({
      myRoster: MY_ROSTER, players: ME, projections: MY_PROJS,
      freeAgents: [player("faRb", "RB")], faProjections: [proj("faRb", "RB", 11)],
    });
    const res = buildWaiverRecommendations(ctx);
    for (const rec of res.recommendations) {
      assert.ok(!MY_ROSTER.all_players.includes(rec.add_player_id), `${rec.add_name} is rostered!`);
    }
    assert.ok(ctx.availability.free_agents.every((fa) => !MY_ROSTER.all_players.includes(fa.canonical_player_id)));
  });

  it("a free agent whose provider id matches an UNRESOLVED rostered id is excluded", () => {
    const faDupe = player("player:sleeper:9999", "RB", { name: "Ambiguous" });
    faDupe.identifiers = { sleeper_id: "9999" };
    const snapshot = {
      league: { league_slug: "test-league" },
      rosters: [{ canonical_team_id: "team:test-league:2", all_players: [], canonical_roster_id: "roster:x" }],
      players: [],
      unresolved_players: [{ provider: "sleeper", provider_player_id: "9999", observed_name: "Mystery RB", observed_position: "RB", observed_team: null, reason: "no match" }],
    } as unknown as CanonicalLeagueSnapshot;
    const av = buildLeagueAvailability({
      snapshot,
      manager_team_id: "team:test-league:1",
      week: 1,
      candidates: [faDupe],
      startable_positions: new Set(["RB"]),
    });
    assert.equal(av.free_agents.length, 0, "must not offer a player matching an unresolved rostered id");
    assert.equal(av.players[0]!.ownership, "rostered_other");
  });

  it("an unresolved candidate identity is never offered as a free agent", () => {
    const bad = player("player:unresolved:abc", "WR");
    bad.resolution = { method: "unresolved", confidence: "none", note: "no id, no name" };
    const av = buildLeagueAvailability({
      snapshot: { league: { league_slug: "l" }, rosters: [], players: [], unresolved_players: [] } as unknown as CanonicalLeagueSnapshot,
      manager_team_id: "team:l:1",
      week: 1,
      candidates: [bad],
      startable_positions: new Set(["WR"]),
    });
    assert.equal(av.free_agents.length, 0);
    assert.equal(av.players[0]!.ownership, "locked_ineligible");
  });
});

describe("waiver add/drop economics", () => {
  it("a clear RB upgrade over the weak bench RB is recommended with a positive net and the right drop", () => {
    const ctx = weeklyContext({
      myRoster: MY_ROSTER, players: ME, projections: MY_PROJS,
      freeAgents: [player("faRb", "RB", { name: "Startable FA RB" })],
      faProjections: [proj("faRb", "RB", 13, { rest_of_season_points: 150 })],
    });
    const res = buildWaiverRecommendations(ctx);
    const rec = res.recommendations.find((r) => r.add_name === "Startable FA RB");
    assert.ok(rec, "should recommend the startable FA RB");
    assert.ok(rec.net_roster_gain > 0);
    assert.equal(rec.drop_player_id, "rbBench"); // drops the weakest rosterable player
    assert.ok(["HIGH", "MEDIUM"].includes(rec.priority));
  });

  it("DO_NOT_ADD when the free agent is worse than the required drop", () => {
    const ctx = weeklyContext({
      myRoster: MY_ROSTER, players: ME, projections: MY_PROJS,
      freeAgents: [player("faScrub", "WR", { name: "Wire Scrub" })],
      faProjections: [proj("faScrub", "WR", 3, { rest_of_season_points: 20 })],
    });
    const res = buildWaiverRecommendations(ctx);
    assert.ok(!res.recommendations.some((r) => r.add_name === "Wire Scrub"));
    assert.ok(res.do_not_add.some((d) => d.add_name === "Wire Scrub"));
  });

  it("does not manufacture activity — a strong roster with a thin wire yields no recommendation", () => {
    const strongRoster = roster("team:test-league:1",
      ["qb1", "rb1", "rb2", "wr1", "wr2", "te1", "wrX", "k1", "def1"], ["wrX"]);
    const players = [...ME.filter((p) => p.canonical_player_id !== "rbBench"), player("wrX", "WR")];
    const projs = [...MY_PROJS.filter((p) => p.canonical_player_id !== "rbBench"), proj("wrX", "WR", 12, { rest_of_season_points: 140 })];
    const ctx = weeklyContext({
      myRoster: strongRoster, players, projections: projs,
      freeAgents: [player("faMeh", "WR")], faProjections: [proj("faMeh", "WR", 6, { rest_of_season_points: 60 })],
    });
    const res = buildWaiverRecommendations(ctx);
    assert.equal(res.recommendations.length, 0);
  });
});

describe("waiver context signals", () => {
  it("positional need lifts a candidate's priority", () => {
    // Roster has only ONE usable WR -> WR need. FA WR that clears replacement should be HIGH/MEDIUM.
    const thinWr = roster("team:test-league:1",
      ["qb1", "rb1", "rb2", "wr1", "wrGap", "te1", "rb1b", "k1", "def1"], ["rb1b"]);
    const players = [
      player("qb1", "QB"), player("rb1", "RB"), player("rb2", "RB"), player("wr1", "WR"),
      player("wrGap", "WR", { name: "Empty WR2" }), player("te1", "TE"), player("k1", "K"), player("def1", "DEF"),
      player("rb1b", "RB"),
    ];
    const projs = [
      proj("qb1", "QB", 20), proj("rb1", "RB", 16), proj("rb2", "RB", 13), proj("wr1", "WR", 16),
      proj("wrGap", "WR", 3, { rest_of_season_points: 25 }), proj("te1", "TE", 10), proj("k1", "K", 8),
      proj("def1", "DEF", 7), proj("rb1b", "RB", 8),
    ];
    const ctx = weeklyContext({
      myRoster: thinWr, players, projections: projs,
      freeAgents: [player("faWr", "WR", { name: "Real WR2" })],
      faProjections: [proj("faWr", "WR", 12, { rest_of_season_points: 150 })],
      // pretend the needs engine flagged WR weak
    });
    ctx.positional_needs = [{ position: "WR", have_startable: 1, need: 2, current_best_points: 16, gap_vs_replacement: 8, severity: "weak" }];
    const res = buildWaiverRecommendations(ctx);
    const rec = res.recommendations.find((r) => r.add_name === "Real WR2")!;
    assert.ok(rec);
    assert.ok(rec.score.components.some((c) => c.key === "positional_scarcity" && (c.raw ?? 0) > 0));
  });

  it("bye coverage: a starter on bye at a position lifts a same-position FA that plays", () => {
    const ctx = weeklyContext({
      myRoster: MY_ROSTER, players: ME, projections: MY_PROJS,
      freeAgents: [player("faTe", "TE", { name: "Bye Fill TE" })],
      faProjections: [proj("faTe", "TE", 8, { rest_of_season_points: 90 })],
    });
    ctx.byes.starters_on_bye_this_week = ["te1"];
    const res = buildWaiverRecommendations(ctx);
    const rec = res.recommendations.find((r) => r.add_name === "Bye Fill TE")!;
    assert.ok(rec);
    assert.ok(rec.bye_coverage_impact > 0);
    assert.ok(rec.score.components.some((c) => c.key === "bye_coverage" && (c.raw ?? 0) > 0));
  });
});

describe("waiver starter impact is COUNTERFACTUAL (optimizer-driven), not weakestFlex()", () => {
  it("the classic weakestFlex failure: mandatory RB2 projects 7, FLEX projects 11, candidate WR projects 10 -> NOT a starter upgrade", () => {
    // Starters: QB RB RB WR WR TE FLEX K DEF. rb2 (mandatory RB2 slot) = 7,
    // the FLEX is filled by a 11-pt WR. A 10-pt FA WR does NOT enter the optimal
    // lineup (it beats neither the 11 FLEX nor either 13/12 WR), so the honest
    // counterfactual gain is 0 even though it "beats the weakest flex-eligible
    // starter" (rb2 at 7).
    const players = [
      player("qb1", "QB"), player("rb1", "RB"), player("rb2", "RB"),
      player("wr1", "WR"), player("wr2", "WR"), player("te1", "TE"),
      player("flexWr", "WR", { name: "FLEX WR" }), player("k1", "K"), player("def1", "DEF"),
      ...["b1", "b2", "b3", "b4", "b5", "b6"].map((id) => player(id, "RB")),
    ];
    const R = roster("team:test-league:1",
      ["qb1", "rb1", "rb2", "wr1", "wr2", "te1", "flexWr", "k1", "def1"],
      ["b1", "b2", "b3", "b4", "b5", "b6"]);
    const P = [
      proj("qb1", "QB", 20), proj("rb1", "RB", 16), proj("rb2", "RB", 7),
      proj("wr1", "WR", 13), proj("wr2", "WR", 12), proj("te1", "TE", 10),
      proj("flexWr", "WR", 11), proj("k1", "K", 8), proj("def1", "DEF", 7),
      ...["b1", "b2", "b3", "b4", "b5", "b6"].map((id) => proj(id, "RB", 4)),
    ];
    const ctx = weeklyContext({
      myRoster: R, players, projections: P,
      freeAgents: [player("faWr", "WR", { name: "Candidate WR 10" })],
      faProjections: [proj("faWr", "WR", 10, { rest_of_season_points: 120 })],
    });
    const res = buildWaiverRecommendations(ctx);
    const rec = res.recommendations.find((r) => r.add_name === "Candidate WR 10");
    const dna = res.do_not_add.find((d) => d.add_name === "Candidate WR 10");
    // Either it's DO_NOT_ADD, or it's recommended but starter_impact ~ 0.
    if (rec) assert.ok((rec.starter_impact ?? 0) < 0.5, `starter_impact should be ~0, got ${rec.starter_impact}`);
    else assert.ok(dna, "should be evaluated (recommended-with-0-impact or DO_NOT_ADD)");
  });

  it("a genuine FLEX upgrade IS detected via the optimizer counterfactual", () => {
    const players = [
      player("qb1", "QB"), player("rb1", "RB"), player("rb2", "RB"),
      player("wr1", "WR"), player("wr2", "WR"), player("te1", "TE"),
      player("flexWk", "WR", { name: "Weak FLEX" }), player("k1", "K"), player("def1", "DEF"),
      ...["b1", "b2", "b3", "b4", "b5", "b6"].map((id) => player(id, "RB")),
    ];
    const R = roster("team:test-league:1",
      ["qb1", "rb1", "rb2", "wr1", "wr2", "te1", "flexWk", "k1", "def1"],
      ["b1", "b2", "b3", "b4", "b5", "b6"]);
    const P = [
      proj("qb1", "QB", 20), proj("rb1", "RB", 16), proj("rb2", "RB", 13),
      proj("wr1", "WR", 15), proj("wr2", "WR", 14), proj("te1", "TE", 11),
      proj("flexWk", "WR", 6), proj("k1", "K", 8), proj("def1", "DEF", 7),
      ...["b1", "b2", "b3", "b4", "b5", "b6"].map((id) => proj(id, "RB", 4)),
    ];
    const ctx = weeklyContext({
      myRoster: R, players, projections: P,
      freeAgents: [player("faWr", "WR", { name: "Real FLEX WR" })],
      faProjections: [proj("faWr", "WR", 13, { rest_of_season_points: 150 })],
    });
    const res = buildWaiverRecommendations(ctx);
    const rec = res.recommendations.find((r) => r.add_name === "Real FLEX WR")!;
    assert.ok(rec, "genuine FLEX upgrade should be recommended");
    assert.equal(rec.starter_impact_status, "RESOLVED");
    assert.ok((rec.starter_impact ?? 0) >= 4, `counterfactual gain should be ~+7 (13 - 6), got ${rec.starter_impact}`);
    assert.ok(rec.drop_player_id != null, "a drop is required (roster is full)");
  });
});

describe("active vs reserve roster capacity", () => {
  const base = () => {
    const players = [
      player("qb1", "QB"), player("rb1", "RB"), player("rb2", "RB"),
      player("wr1", "WR"), player("wr2", "WR"), player("te1", "TE"),
      player("fx", "RB"), player("k1", "K"), player("def1", "DEF"),
      player("bn1", "RB"), player("bn2", "WR"), player("bn3", "WR"), player("bn4", "TE"), player("bn5", "RB"),
      player("hurt", "RB", { name: "Hurt Guy", injury: "IR" }),
    ];
    const P = [
      proj("qb1", "QB", 20), proj("rb1", "RB", 16), proj("rb2", "RB", 12), proj("wr1", "WR", 14),
      proj("wr2", "WR", 12), proj("te1", "TE", 10), proj("fx", "RB", 9), proj("k1", "K", 8), proj("def1", "DEF", 7),
      proj("bn1", "RB", 6), proj("bn2", "WR", 6), proj("bn3", "WR", 5), proj("bn4", "TE", 5), proj("bn5", "RB", 4),
      proj("hurt", "RB", 0, { projection_status: "out", expected_availability: 0.03 }),
    ];
    return { players, P };
  };

  it("full active roster (14) + empty IR slot -> a healthy add STILL requires a drop", () => {
    const { players, P } = base();
    const R = roster("team:test-league:1",
      ["qb1", "rb1", "rb2", "wr1", "wr2", "te1", "fx", "k1", "def1"],
      ["bn1", "bn2", "bn3", "bn4", "bn5"]); // 14 active, 0 on IR (IR slot empty)
    const ctx = weeklyContext({
      myRoster: R, players, projections: P,
      freeAgents: [player("faRb", "RB", { name: "Add RB" })],
      faProjections: [proj("faRb", "RB", 13, { rest_of_season_points: 150 })],
    });
    const res = buildWaiverRecommendations(ctx);
    assert.equal(res.roster_has_open_spot, false, "empty IR slot is NOT an open active spot");
    const rec = res.recommendations.find((r) => r.add_name === "Add RB");
    if (rec) assert.ok(rec.drop_player_id != null, "healthy add needs a drop despite the empty IR slot");
  });

  it("genuinely open bench slot -> no drop required", () => {
    const { players, P } = base();
    const R = roster("team:test-league:1",
      ["qb1", "rb1", "rb2", "wr1", "wr2", "te1", "fx", "k1", "def1"],
      ["bn1", "bn2", "bn3"]); // 12 active, cap 14 -> 2 open bench seats
    const ctx = weeklyContext({
      myRoster: R, players, projections: P,
      freeAgents: [player("faRb", "RB", { name: "Add RB" })],
      faProjections: [proj("faRb", "RB", 13, { rest_of_season_points: 150 })],
    });
    const res = buildWaiverRecommendations(ctx);
    assert.equal(res.roster_has_open_spot, true);
    const rec = res.recommendations.find((r) => r.add_name === "Add RB")!;
    assert.equal(rec.drop_player_id, null);
    assert.equal(rec.drop_cost, 0);
  });

  it("full active roster + IR slot occupied -> still needs a drop, and the IR player is not the drop", () => {
    const { players, P } = base();
    const R = roster("team:test-league:1",
      ["qb1", "rb1", "rb2", "wr1", "wr2", "te1", "fx", "k1", "def1"],
      ["bn1", "bn2", "bn3", "bn4", "bn5"], { ir: ["hurt"] }); // 14 active + 1 IR
    const ctx = weeklyContext({
      myRoster: R, players, projections: P,
      freeAgents: [player("faRb", "RB", { name: "Add RB" })],
      faProjections: [proj("faRb", "RB", 13, { rest_of_season_points: 150 })],
    });
    const res = buildWaiverRecommendations(ctx);
    assert.equal(res.roster_has_open_spot, false);
    const rec = res.recommendations.find((r) => r.add_name === "Add RB");
    if (rec) {
      assert.ok(rec.drop_player_id != null);
      assert.notEqual(rec.drop_player_id, "hurt", "the IR player is not an active-roster drop candidate");
    }
  });
});

describe("waiver counterfactual inherits UNKNOWN-vs-zero semantics (issue 4)", () => {
  it("an UNKNOWN starter in the baseline optimal lineup -> starter_impact UNRESOLVED, not a fake gain", () => {
    // te1 (the only TE) has NO projection -> the baseline optimal lineup has an
    // UNKNOWN starter -> baseline.optimal_total is null -> the counterfactual
    // cannot be computed for ANY candidate.
    const players = [
      player("qb1", "QB"), player("rb1", "RB"), player("rb2", "RB"),
      player("wr1", "WR"), player("wr2", "WR"), player("te1", "TE"),
      player("fx", "RB"), player("k1", "K"), player("def1", "DEF"),
      ...["b1", "b2", "b3", "b4", "b5"].map((id) => player(id, "RB")),
    ];
    const P = [
      proj("qb1", "QB", 20), proj("rb1", "RB", 16), proj("rb2", "RB", 12), proj("wr1", "WR", 14),
      proj("wr2", "WR", 12), /* te1: NO projection */ proj("fx", "RB", 9), proj("k1", "K", 8), proj("def1", "DEF", 7),
      ...["b1", "b2", "b3", "b4", "b5"].map((id) => proj(id, "RB", 5)),
    ];
    const R = roster("team:test-league:1",
      ["qb1", "rb1", "rb2", "wr1", "wr2", "te1", "fx", "k1", "def1"],
      ["b1", "b2", "b3", "b4", "b5"]);
    const ctx = weeklyContext({
      myRoster: R, players, projections: P,
      freeAgents: [player("faRb", "RB", { name: "Wire RB" })],
      faProjections: [proj("faRb", "RB", 13, { rest_of_season_points: 150 })],
    });
    const res = buildWaiverRecommendations(ctx);
    const evald =
      res.recommendations.find((r) => r.add_name === "Wire RB") ??
      res.do_not_add.find((d) => d.add_name === "Wire RB");
    assert.ok(evald, "candidate should still be evaluated");
    const rec = res.recommendations.find((r) => r.add_name === "Wire RB");
    if (rec) {
      assert.equal(rec.starter_impact, null, "no fabricated starter gain off an UNKNOWN baseline");
      assert.equal(rec.starter_impact_status, "UNRESOLVED");
      assert.equal(rec.confidence, "LOW");
      assert.ok(rec.priority !== "HIGH");
    }
  });
});

describe("duplicate provider identity -> one canonical player", () => {
  it("the same gsis-mapped player from two providers is one free agent, not two", () => {
    const p = player("player:gsis:00-0033280", "RB", { name: "Christian McCaffrey" });
    p.identifiers = { gsis_id: "00-0033280", sleeper_id: "4034", yahoo_id: "31883" };
    const av = buildLeagueAvailability({
      snapshot: { league: { league_slug: "l" }, rosters: [], players: [], unresolved_players: [] } as unknown as CanonicalLeagueSnapshot,
      manager_team_id: "team:l:1",
      week: 1,
      candidates: [p, p], // same canonical id twice
      startable_positions: new Set(["RB"]),
    });
    const faIds = new Set(av.free_agents.map((x) => x.canonical_player_id));
    assert.equal(faIds.size, 1);
  });
});
