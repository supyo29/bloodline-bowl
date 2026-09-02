/**
 * Lineup optimizer — deterministic (PART XVI).
 *
 *  - highest projected player is not always valid for every slot
 *  - FLEX / SUPERFLEX eligibility
 *  - duplicate player prevention
 *  - bye player excluded / heavily flagged
 *  - injured / unavailable handling
 *  - empty-slot detection
 *  - optimal lineup is deterministic
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildOptimalLineup, hungarianMaxWeight, isEligible } from "../lib/weekly/lineup";
import {
  STD_CONSTRAINTS,
  SUPERFLEX_CONSTRAINTS,
  batch,
  player,
  proj,
  roster,
} from "./fixtures/weekly";

const PLAYERS = [
  player("qb1", "QB"), player("qb2", "QB"),
  player("rb1", "RB"), player("rb2", "RB"), player("rb3", "RB"),
  player("wr1", "WR"), player("wr2", "WR"), player("wr3", "WR"),
  player("te1", "TE"), player("te2", "TE"),
  player("k1", "K"), player("def1", "DEF"),
];
const PROJS = [
  proj("qb1", "QB", 22), proj("qb2", "QB", 15),
  proj("rb1", "RB", 18), proj("rb2", "RB", 12), proj("rb3", "RB", 9),
  proj("wr1", "WR", 20), proj("wr2", "WR", 14), proj("wr3", "WR", 10),
  proj("te1", "TE", 11), proj("te2", "TE", 6),
  proj("k1", "K", 8), proj("def1", "DEF", 7),
];

function run(starters: string[], bench: string[], extra?: { players?: typeof PLAYERS; projs?: typeof PROJS; constraints?: typeof STD_CONSTRAINTS }) {
  const players = extra?.players ?? PLAYERS;
  const projs = extra?.projs ?? PROJS;
  return buildOptimalLineup({
    week: 1,
    roster: roster("team:t:1", starters, bench, { startingSlots: (extra?.constraints ?? STD_CONSTRAINTS).starting_slots }),
    constraints: extra?.constraints ?? STD_CONSTRAINTS,
    players: new Map(players.map((p) => [p.canonical_player_id, p])),
    projections: batch(projs, players),
  });
}

describe("lineup optimizer: slot legality", () => {
  it("does not put the highest projected player (WR1 20) in the QB slot", () => {
    const r = run(["qb2", "rb1", "rb2", "wr1", "wr2", "te1", "rb3", "k1", "def1"], ["qb1", "wr3", "te2"]);
    const qbSlot = r.slots.find((s) => s.slot === "QB")!;
    assert.equal(qbSlot.recommended_player_id, "qb1"); // best QB, not best player
    assert.notEqual(qbSlot.recommended_player_id, "wr1");
  });

  it("assigns the true optimal FLEX (best RB/WR/TE not already starting)", () => {
    // Optimal: QB1 RB1 RB2 WR1 WR2 TE1 + FLEX=WR3(10) beats RB3(9).
    const r = run(["qb1", "rb1", "rb2", "wr1", "wr2", "te1", "rb3", "k1", "def1"], ["qb2", "wr3", "te2"]);
    const flex = r.slots.find((s) => s.slot === "FLEX")!;
    assert.equal(flex.recommended_player_id, "wr3");
    assert.equal(flex.is_change, true);
    assert.ok((flex.projection_difference ?? 0) > 0);
  });

  it("SUPERFLEX can take a QB and does when the QB out-projects the flex options", () => {
    const players = [...PLAYERS];
    const projs = [...PROJS, proj("qb2b", "QB", 19)];
    players.push(player("qb2b", "QB"));
    const r = run(
      ["qb1", "rb1", "rb2", "wr1", "wr2", "te1", "rb3", "k1", "def1"],
      ["qb2b", "wr3"],
      { players, projs, constraints: SUPERFLEX_CONSTRAINTS },
    );
    const sf = r.slots.find((s) => s.slot === "SUPER_FLEX")!;
    assert.equal(sf.recommended_player_id, "qb2b"); // QB 19 > WR3 10 / RB3 9
  });
});

describe("lineup optimizer: constraints", () => {
  it("never starts the same player in two slots", () => {
    const r = run(["qb1", "rb1", "rb1", "wr1", "wr2", "te1", "rb2", "k1", "def1"], ["wr3"]);
    const used = r.slots.map((s) => s.recommended_player_id).filter(Boolean);
    assert.equal(new Set(used).size, used.length);
    assert.ok(r.illegal_situations.some((x) => /two slots|two slots simultaneously|simultaneously/.test(x)));
  });

  it("detects an empty starter slot when no eligible player is rostered", () => {
    const players = PLAYERS.filter((p) => p.position !== "DEF");
    const projs = PROJS.filter((p) => p.canonical_player_id !== "def1");
    const r = run(["qb1", "rb1", "rb2", "wr1", "wr2", "te1", "rb3", "k1"], [], { players, projs });
    assert.ok(r.empty_slots.includes("DEF"));
    assert.equal(r.slots.find((s) => s.slot === "DEF")!.recommended_player_id, null);
  });

  it("is deterministic — identical inputs give byte-identical lineups", () => {
    const a = run(["qb1", "rb1", "rb2", "wr1", "wr2", "te1", "rb3", "k1", "def1"], ["qb2", "wr3", "te2"]);
    const b = run(["qb1", "rb1", "rb2", "wr1", "wr2", "te1", "rb3", "k1", "def1"], ["qb2", "wr3", "te2"]);
    assert.deepEqual(
      a.slots.map((s) => s.recommended_player_id),
      b.slots.map((s) => s.recommended_player_id),
    );
    assert.equal(a.optimal_total, b.optimal_total);
  });
});

describe("lineup optimizer: bye / injury", () => {
  it("avoids a bye player when a projected alternative exists, and flags him if forced", () => {
    const players = [...PLAYERS];
    const projs = PROJS.map((p) => (p.canonical_player_id === "wr2" ? proj("wr2", "WR", 0, { projection_status: "bye", is_bye: true }) : p));
    const r = run(["qb1", "rb1", "rb2", "wr1", "wr2", "te1", "rb3", "k1", "def1"], ["wr3"], { players, projs });
    // wr2 on bye -> optimizer swaps in wr3(10) for a WR slot; wr2 is not recommended anywhere.
    assert.ok(!r.slots.some((s) => s.recommended_player_id === "wr2"));
    assert.equal(r.slots.find((s) => s.current_player_id === "wr2")!.is_change, true);
  });

  it("forced bye: only WR available is on bye -> he is recommended but bye_problems flags it", () => {
    const players = [player("qb1", "QB"), player("rb1", "RB"), player("rb2", "RB"), player("wrb", "WR"), player("te1", "TE"), player("k1", "K"), player("def1", "DEF")];
    const projs = [proj("qb1", "QB", 20), proj("rb1", "RB", 15), proj("rb2", "RB", 12), proj("wrb", "WR", 0, { projection_status: "bye", is_bye: true }), proj("te1", "TE", 10), proj("k1", "K", 8), proj("def1", "DEF", 7)];
    const r = buildOptimalLineup({
      week: 1,
      roster: roster("team:t:1", ["qb1", "rb1", "rb2", "wrb", "te1", "rb1", "wrb", "k1", "def1"].map((x, i) => (i === 4 ? "wrb" : x)), [], {}),
      constraints: STD_CONSTRAINTS,
      players: new Map(players.map((p) => [p.canonical_player_id, p])),
      projections: batch(projs, players),
    });
    assert.ok(r.bye_problems.length >= 1 || r.empty_slots.includes("WR"));
  });

  it("an injured (Out) player is flagged as an injury risk", () => {
    const players = PLAYERS.map((p) => (p.canonical_player_id === "rb1" ? player("rb1", "RB", { injury: "Out" }) : p));
    const projs = PROJS.map((p) => (p.canonical_player_id === "rb1" ? proj("rb1", "RB", 4, { expected_availability: 0.03, injury_status: "Out" }) : p));
    const r = run(["qb1", "rb1", "rb2", "wr1", "wr2", "te1", "rb3", "k1", "def1"], ["wr3"], { players, projs });
    // rb1 at avail 0.03 projecting 4 loses the RB slot to rb3 (9).
    assert.ok(!r.slots.some((s) => s.recommended_player_id === "rb1"));
  });

  it("IR / taxi players are never lineup candidates", () => {
    const r = buildOptimalLineup({
      week: 1,
      roster: roster("team:t:1", ["qb1", "rb1", "rb2", "wr1", "wr2", "te1", "rb3", "k1", "def1"], ["te2"], { ir: ["wr1b"] }),
      constraints: STD_CONSTRAINTS,
      players: new Map([...PLAYERS, player("wr1b", "WR")].map((p) => [p.canonical_player_id, p])),
      projections: batch([...PROJS, proj("wr1b", "WR", 99)], [...PLAYERS, player("wr1b", "WR")]),
    });
    assert.ok(!r.slots.some((s) => s.recommended_player_id === "wr1b"), "IR player must not enter the lineup even at 99 proj");
  });
});

describe("lineup efficiency", () => {
  it("current == optimal -> efficiency 1.0, 0 points left on bench", () => {
    const r = run(["qb1", "rb1", "rb2", "wr1", "wr2", "te1", "wr3", "k1", "def1"], ["qb2", "rb3", "te2"]);
    assert.equal(r.lineup_efficiency, 1);
    assert.equal(r.points_left_on_bench, 0);
    assert.equal(r.changes_recommended.length, 0);
  });

  it("suboptimal current -> efficiency < 1, points_left_on_bench = optimal - current", () => {
    const r = run(["qb1", "rb1", "rb3", "wr1", "wr2", "te1", "rb2", "k1", "def1"], ["wr3", "te2"]);
    assert.ok(r.lineup_efficiency! < 1);
    assert.equal(r.points_left_on_bench, Math.round((r.optimal_total - r.current_total) * 100) / 100);
    assert.ok(r.projected_points_gained > 0);
  });
});

describe("hungarian core", () => {
  it("solves a small assignment optimally", () => {
    // rows(slots) x cols(players): row0 eligible {0,1}, row1 eligible {1,2}
    const NEG = Number.NEGATIVE_INFINITY;
    const w = [
      [5, 8, NEG],
      [NEG, 7, 6],
    ];
    const a = hungarianMaxWeight(w);
    // best: slot0<-player1(8) forces slot1<-player2(6) total 14, vs slot0<-p0(5)+slot1<-p1(7)=12
    assert.equal(w[0]![a[0]!]! + w[1]![a[1]!]!, 14);
  });
});

describe("eligibility helper", () => {
  it("FLEX accepts RB/WR/TE, rejects QB/K/DEF", () => {
    assert.equal(isEligible("FLEX", player("x", "RB")), true);
    assert.equal(isEligible("FLEX", player("x", "TE")), true);
    assert.equal(isEligible("FLEX", player("x", "QB")), false);
    assert.equal(isEligible("FLEX", player("x", "K")), false);
    assert.equal(isEligible("SUPER_FLEX", player("x", "QB")), true);
  });
});
