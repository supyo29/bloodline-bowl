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
import { weeklyBand } from "../lib/weekly/uncertainty";
import type { RosterConstraints } from "../lib/weekly/schema";
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
    assert.ok(r.optimal_total != null && r.current_total != null && r.projected_points_gained != null);
    assert.ok(r.lineup_efficiency! < 1);
    assert.equal(r.points_left_on_bench, Math.round((r.optimal_total - r.current_total) * 100) / 100);
    assert.ok(r.projected_points_gained > 0);
  });
});

describe("lineup: actions come from the STARTER SET, not slot permutations (issue 3)", () => {
  // A(RB 10) and B(RB 11) are both started; the optimizer may assign them to
  // RB2 / FLEX in either order. Under the old per-slot filter that produced a
  // phantom "+1 start B over A". The starter set {A,B,...} is unchanged.
  const permPlayers = [
    player("qb1", "QB"), player("A", "RB"), player("B", "RB"),
    player("wr1", "WR"), player("wr2", "WR"), player("te1", "TE"),
    player("k1", "K"), player("def1", "DEF"), player("bnRb", "RB"),
  ];
  const permProjs = [
    proj("qb1", "QB", 20), proj("A", "RB", 10), proj("B", "RB", 11),
    proj("wr1", "WR", 14), proj("wr2", "WR", 12), proj("te1", "TE", 9),
    proj("k1", "K", 8), proj("def1", "DEF", 7), proj("bnRb", "RB", 3),
  ];

  it("RB/FLEX permutation of the same starters -> 0 changes, 0 gain", () => {
    // current RB1=A(10), RB2=B(11), FLEX=bnRb(3). The optimizer may re-order A/B
    // between the two RB slots (equal total). Old per-slot code emitted a phantom
    // "+1 start B over A"; the starter set {qb1,A,B,wr1,wr2,te1,bnRb,k1,def1} is
    // unchanged, so there is no move.
    const r = buildOptimalLineup({
      week: 1,
      roster: roster("team:t:1", ["qb1", "A", "B", "wr1", "wr2", "te1", "bnRb", "k1", "def1"], [], { startingSlots: STD_CONSTRAINTS.starting_slots }),
      constraints: STD_CONSTRAINTS,
      players: new Map(permPlayers.map((p) => [p.canonical_player_id, p])),
      projections: batch(permProjs, permPlayers),
    });
    assert.equal(r.changes_recommended.length, 0, "no starter-set change");
    assert.equal(r.projected_points_gained, 0);
    assert.ok(r.slots.every((s) => !s.is_starter_set_change));
  });

  it("two duplicate WR slots swapping occupants -> 0 changes", () => {
    const players = [
      player("qb1", "QB"), player("rb1", "RB"), player("rb2", "RB"),
      player("W1", "WR"), player("W2", "WR"), player("te1", "TE"),
      player("rb3", "RB"), player("k1", "K"), player("def1", "DEF"),
    ];
    const projs = [
      proj("qb1", "QB", 20), proj("rb1", "RB", 15), proj("rb2", "RB", 12),
      proj("W1", "WR", 15), proj("W2", "WR", 12), proj("te1", "TE", 9),
      proj("rb3", "RB", 8), proj("k1", "K", 8), proj("def1", "DEF", 7),
    ];
    // current WR1=W2, WR2=W1 (swapped vs a points-sort)
    const r = buildOptimalLineup({
      week: 1,
      roster: roster("team:t:1", ["qb1", "rb1", "rb2", "W2", "W1", "te1", "rb3", "k1", "def1"], [], { startingSlots: STD_CONSTRAINTS.starting_slots }),
      constraints: STD_CONSTRAINTS,
      players: new Map(players.map((p) => [p.canonical_player_id, p])),
      projections: batch(projs, players),
    });
    assert.equal(r.changes_recommended.length, 0);
    assert.equal(r.projected_points_gained, 0);
  });

  it("a genuine bench->starter upgrade is exactly ONE change", () => {
    const r = run(["qb1", "rb1", "rb2", "wr1", "wr2", "te1", "rb3", "k1", "def1"], ["qb2", "wr3", "te2"]);
    // wr3(10) beats rb3(9) for FLEX
    assert.equal(r.changes_recommended.length, 1);
    assert.equal(r.changes_recommended[0]!.in, "wr3");
    assert.equal(r.changes_recommended[0]!.out, "rb3");
    assert.ok(r.projected_points_gained! > 0);
    assert.equal(r.projected_points_gained, Math.round((r.optimal_total! - r.current_total!) * 100) / 100);
  });

  it("two genuine simultaneous starter-set changes", () => {
    const players = [...PLAYERS, player("benchWR", "WR"), player("benchRB", "RB")];
    const projs = [...PROJS, proj("benchWR", "WR", 22), proj("benchRB", "RB", 19)];
    // current starts wr2(14) and rb2(12); bench studs beat both.
    const r = buildOptimalLineup({
      week: 1,
      roster: roster("team:t:1", ["qb1", "rb1", "rb2", "wr1", "wr2", "te1", "rb3", "k1", "def1"], ["benchWR", "benchRB"], { startingSlots: STD_CONSTRAINTS.starting_slots }),
      constraints: STD_CONSTRAINTS,
      players: new Map(players.map((p) => [p.canonical_player_id, p])),
      projections: batch(projs, players),
    });
    const ins = new Set(r.changes_recommended.map((c) => c.in));
    assert.ok(ins.has("benchWR") && ins.has("benchRB"));
    assert.equal(r.changes_recommended.length, 2);
    const entering = new Set(r.slots.filter((s) => s.is_starter_set_change).map((s) => s.recommended_player_id));
    assert.deepEqual([...entering].sort(), ["benchRB", "benchWR"]);
  });

  it("equal-projection tie: optimizer reassigns slots but the starter set is identical -> 0 changes", () => {
    const players = [
      player("qb1", "QB"), player("R1", "RB"), player("R2", "RB"),
      player("wr1", "WR"), player("wr2", "WR"), player("te1", "TE"),
      player("R3", "RB"), player("k1", "K"), player("def1", "DEF"),
    ];
    const projs = [
      proj("qb1", "QB", 20), proj("R1", "RB", 10), proj("R2", "RB", 10),
      proj("wr1", "WR", 14), proj("wr2", "WR", 12), proj("te1", "TE", 9),
      proj("R3", "RB", 10), proj("k1", "K", 8), proj("def1", "DEF", 7),
    ];
    const r = buildOptimalLineup({
      week: 1,
      roster: roster("team:t:1", ["qb1", "R1", "R2", "wr1", "wr2", "te1", "R3", "k1", "def1"], [], { startingSlots: STD_CONSTRAINTS.starting_slots }),
      constraints: STD_CONSTRAINTS,
      players: new Map(players.map((p) => [p.canonical_player_id, p])),
      projections: batch(projs, players),
    });
    assert.equal(r.changes_recommended.length, 0);
    assert.equal(r.projected_points_gained, 0);
  });
});

describe("lineup: UNKNOWN vs VERIFIED_ZERO inside the optimizer (issue 4)", () => {
  it("an UNKNOWN current starter + a projected bench player -> NO fabricated numeric gain", () => {
    const players = [
      player("qb1", "QB"), player("rb1", "RB"), player("hurtRB", "RB"),
      player("wr1", "WR"), player("wr2", "WR"), player("te1", "TE"),
      player("wr3", "WR"), player("k1", "K"), player("def1", "DEF"),
      player("benchRB", "RB"),
    ];
    // hurtRB (a current starter) has NO projection entry at all -> UNKNOWN.
    const projs = [
      proj("qb1", "QB", 20), proj("rb1", "RB", 15),
      proj("wr1", "WR", 14), proj("wr2", "WR", 12), proj("te1", "TE", 9),
      proj("wr3", "WR", 8), proj("k1", "K", 8), proj("def1", "DEF", 7),
      proj("benchRB", "RB", 8),
    ];
    const r = buildOptimalLineup({
      week: 1,
      roster: roster("team:t:1", ["qb1", "rb1", "hurtRB", "wr1", "wr2", "te1", "wr3", "k1", "def1"], ["benchRB"], { startingSlots: STD_CONSTRAINTS.starting_slots }),
      constraints: STD_CONSTRAINTS,
      players: new Map(players.map((p) => [p.canonical_player_id, p])),
      projections: batch(projs, players),
    });
    // benchRB may be the provisional pick, but the swap hinges on an UNKNOWN
    // value -> it is UNRESOLVED, never a confident numeric change.
    assert.ok(!r.changes_recommended.some((c) => c.in === "benchRB"), "no fabricated numeric change");
    assert.ok(r.unresolved_decisions.some((u) => u.candidate_player_id === "benchRB"));
    assert.equal(r.current_total, null, "current total unavailable — an UNKNOWN starter cannot be a numeric 0");
    assert.equal(r.projected_points_gained, null, "no fabricated gain");
    assert.equal(r.optimality_status, "PROVISIONAL");
    assert.ok(r.unprojected_starters.includes("hurtRB"));
  });

  it("an UNKNOWN bench candidate never fabricates an upgrade", () => {
    const players = [...PLAYERS, player("mysteryRB", "RB")];
    const projs = [...PROJS]; // mysteryRB has NO projection
    const r = buildOptimalLineup({
      week: 1,
      roster: roster("team:t:1", ["qb1", "rb1", "rb2", "wr1", "wr2", "te1", "wr3", "k1", "def1"], ["mysteryRB", "rb3"], { startingSlots: STD_CONSTRAINTS.starting_slots }),
      constraints: STD_CONSTRAINTS,
      players: new Map(players.map((p) => [p.canonical_player_id, p])),
      projections: batch([...projs, proj("wr3", "WR", 10)], players),
    });
    assert.ok(!r.changes_recommended.some((c) => c.in === "mysteryRB"));
    assert.ok(!r.slots.some((s) => s.recommended_player_id === "mysteryRB"), "unknown bench player is not started over knowns");
    // optimal starters are all known -> the total is a real number...
    assert.notEqual(r.optimal_total, null);
    assert.equal(r.optimal_total, r.known_optimal_subtotal);
    // ...but optimality is PROVISIONAL because a rosterable RB has no projection.
    assert.equal(r.optimality_status, "PROVISIONAL");
  });

  it("a VERIFIED_ZERO (schedule-proven bye) is a valid numeric 0, not UNKNOWN", () => {
    const players = [player("qb1", "QB"), player("rb1", "RB"), player("rb2", "RB"), player("wrBye", "WR"), player("te1", "TE"), player("k1", "K"), player("def1", "DEF"), player("rb3", "RB")];
    const projs = [
      proj("qb1", "QB", 20), proj("rb1", "RB", 15), proj("rb2", "RB", 12),
      proj("wrBye", "WR", 0, { projection_status: "bye", is_bye: true }),
      proj("te1", "TE", 10), proj("k1", "K", 8), proj("def1", "DEF", 7), proj("rb3", "RB", 9),
    ];
    // only one WR on the roster -> the bye player must take the WR slot at 0.
    const r = buildOptimalLineup({
      week: 1,
      roster: roster("team:t:1", ["qb1", "rb1", "rb2", "wrBye", "wrBye", "te1", "rb3", "k1", "def1"].map((x, i) => (i === 4 ? "wrBye" : x)), [], { startingSlots: STD_CONSTRAINTS.starting_slots }),
      constraints: STD_CONSTRAINTS,
      players: new Map(players.map((p) => [p.canonical_player_id, p])),
      projections: batch(projs, players),
    });
    const byeSlot = r.slots.find((s) => s.recommended_player_id === "wrBye");
    assert.ok(byeSlot, "the bye player is still fielded (a real 0 beats an empty slot)");
    assert.equal(byeSlot!.recommended_projected, 0);
    assert.equal(byeSlot!.recommended_projection_state, "VERIFIED_ZERO");
    assert.notEqual(r.optimal_total, null, "a verified-zero starter does NOT null the total");
    assert.ok(r.bye_problems.some((b) => b.canonical_player_id === "wrBye"));
  });

  it("RB/WR/FLEX chain: a change pairs the entrant with the ACTUAL leaver, not the slot incumbent who slides to FLEX", () => {
    const players = [
      player("qb1", "QB"), player("A", "RB"), player("B", "RB"),
      player("wr1", "WR"), player("wr2", "WR"), player("te1", "TE"),
      player("C", "WR"), player("k1", "K"), player("def1", "DEF"),
      player("D", "RB"),
    ];
    const projs = [
      proj("qb1", "QB", 20), proj("A", "RB", 10), proj("B", "RB", 9),
      proj("wr1", "WR", 16), proj("wr2", "WR", 14), proj("te1", "TE", 11),
      proj("C", "WR", 8), proj("k1", "K", 8), proj("def1", "DEF", 7),
      proj("D", "RB", 15),
    ];
    // current: RB1=A, RB2=B, FLEX=C(8). Optimal: D(15) enters; A & B stay
    // starters (one to FLEX); C(8) is the only one who actually leaves.
    const r = buildOptimalLineup({
      week: 1,
      roster: roster("team:t:1", ["qb1", "A", "B", "wr1", "wr2", "te1", "C", "k1", "def1"], ["D"], { startingSlots: STD_CONSTRAINTS.starting_slots }),
      constraints: STD_CONSTRAINTS,
      players: new Map(players.map((p) => [p.canonical_player_id, p])),
      projections: batch(projs, players),
    });
    assert.equal(r.changes_recommended.length, 1);
    assert.equal(r.changes_recommended[0]!.in, "D");
    assert.equal(r.changes_recommended[0]!.out, "C", "the leaver is C, NOT the RB-slot incumbent A/B");
    const optimalStarters = new Set(r.slots.map((s) => s.recommended_player_id));
    assert.ok(optimalStarters.has("A") && optimalStarters.has("B"), "A and B are still starters");
    assert.ok(!r.changes_recommended.some((c) => c.out === "A" || c.out === "B"));
  });

  it("a fully-projected lineup is COMPLETE and behaves exactly as before", () => {
    const r = run(["qb1", "rb1", "rb2", "wr1", "wr2", "te1", "wr3", "k1", "def1"], ["qb2", "rb3", "te2"]);
    assert.equal(r.optimality_status, "COMPLETE");
    assert.equal(r.provisional_reason, null);
    assert.notEqual(r.optimal_total, null);
    assert.notEqual(r.current_total, null);
    assert.equal(r.unresolved_decisions.length, 0);
  });
});

describe("lineup: Yahoo slot labels + sparse roster slots (Codex re-review)", () => {
  it("a Yahoo flex label (W/R/T) is eligible for RB/WR/TE and is actually filled", () => {
    assert.equal(isEligible("W/R/T", player("x", "RB")), true);
    assert.equal(isEligible("W/R/T", player("x", "TE")), true);
    assert.equal(isEligible("Q/W/R/T", player("x", "QB")), true);
    assert.equal(isEligible("W/R/T", player("x", "K")), false);

    const yahooConstraints: RosterConstraints = {
      ...STD_CONSTRAINTS,
      starting_slots: ["QB", "RB", "RB", "WR", "WR", "TE", "W/R/T", "K", "DEF"],
      slot_requirements: { QB: 1, RB: 2, WR: 2, TE: 1, "W/R/T": 1, K: 1, DEF: 1 },
      flex_positions: ["RB", "WR", "TE"],
      flex_slots: 1,
    };
    const players = [
      player("qb1", "QB"), player("rb1", "RB"), player("rb2", "RB"),
      player("wr1", "WR"), player("wr2", "WR"), player("te1", "TE"),
      player("wr3", "WR"), player("k1", "K"), player("def1", "DEF"),
    ];
    const projs = [
      proj("qb1", "QB", 20), proj("rb1", "RB", 15), proj("rb2", "RB", 12), proj("wr1", "WR", 14),
      proj("wr2", "WR", 12), proj("te1", "TE", 10), proj("wr3", "WR", 11), proj("k1", "K", 8), proj("def1", "DEF", 7),
    ];
    const r = buildOptimalLineup({
      week: 1,
      roster: roster("team:t:1", ["qb1", "rb1", "rb2", "wr1", "wr2", "te1", "wr3", "k1", "def1"], [], { startingSlots: yahooConstraints.starting_slots }),
      constraints: yahooConstraints,
      players: new Map(players.map((p) => [p.canonical_player_id, p])),
      projections: batch(projs, players),
    });
    const flex = r.slots.find((s) => s.slot === "W/R/T")!;
    assert.equal(flex.recommended_player_id, "wr3", "the W/R/T slot is filled, not left empty");
    assert.ok(!r.empty_slots.includes("W/R/T"));
    assert.notEqual(r.optimal_total, null);
  });

  it("a roster that omits its empty starter-slot entry does not shift later starters (Yahoo)", () => {
    const players = [
      player("qb1", "QB"), player("rb1", "RB"), player("rb2", "RB"),
      player("wr1", "WR"), player("wr2", "WR"), player("te1", "TE"),
      player("k1", "K"), player("def1", "DEF"),
    ];
    const projs = [
      proj("qb1", "QB", 20), proj("rb1", "RB", 15), proj("rb2", "RB", 12),
      proj("wr1", "WR", 14), proj("wr2", "WR", 12), proj("te1", "TE", 10),
      proj("k1", "K", 8), proj("def1", "DEF", 7),
    ];
    // Yahoo-style: NO entry for the unfilled FLEX slot; entries carry their label.
    const sparseRoster = {
      canonical_roster_id: "roster:t:1",
      canonical_team_id: "team:t:1",
      slots: [
        { slot: "QB", slot_index: 0, canonical_player_id: "qb1", is_empty: false },
        { slot: "RB", slot_index: 1, canonical_player_id: "rb1", is_empty: false },
        { slot: "RB", slot_index: 2, canonical_player_id: "rb2", is_empty: false },
        { slot: "WR", slot_index: 3, canonical_player_id: "wr1", is_empty: false },
        { slot: "WR", slot_index: 4, canonical_player_id: "wr2", is_empty: false },
        { slot: "TE", slot_index: 5, canonical_player_id: "te1", is_empty: false },
        { slot: "K", slot_index: 6, canonical_player_id: "k1", is_empty: false },
        { slot: "DEF", slot_index: 7, canonical_player_id: "def1", is_empty: false },
      ],
      starters: ["qb1", "rb1", "rb2", "wr1", "wr2", "te1", "k1", "def1"],
      bench: [],
      ir: [],
      taxi: [],
      all_players: ["qb1", "rb1", "rb2", "wr1", "wr2", "te1", "k1", "def1"],
      provenance: { provider: "sleeper" as const, provider_id: "t", provider_synced_at: null },
    };
    const r = buildOptimalLineup({
      week: 1,
      roster: sparseRoster,
      constraints: STD_CONSTRAINTS,
      players: new Map(players.map((p) => [p.canonical_player_id, p])),
      projections: batch(projs, players),
    });
    // K and DEF are still aligned to their own slots — NOT shifted into FLEX/K.
    assert.equal(r.slots.find((s) => s.slot === "K")!.current_player_id, "k1");
    assert.equal(r.slots.find((s) => s.slot === "DEF")!.current_player_id, "def1");
    assert.equal(r.slots.find((s) => s.slot === "FLEX")!.current_player_id, null, "FLEX is correctly empty");
    assert.equal(r.illegal_situations.length, 0, "no false illegal-lineup alerts from a shifted DEF");
  });
});

describe("lineup: multi-player swap pairing (Codex re-review)", () => {
  it("pairs entrants with same-position leavers, and no genuine move disappears", () => {
    const players = [
      player("qb1", "QB"), player("A", "RB"), player("Bx", "WR"),
      player("wr2", "WR"), player("wr3", "WR"), player("te1", "TE"),
      player("Cx", "WR"), player("k1", "K"), player("def1", "DEF"),
      player("D", "RB"), player("E", "WR"),
    ];
    const projs = [
      proj("qb1", "QB", 20), proj("A", "RB", 10), proj("Bx", "WR", 11),
      proj("wr2", "WR", 9), proj("wr3", "WR", 8), proj("te1", "TE", 12),
      proj("Cx", "WR", 8), proj("k1", "K", 8), proj("def1", "DEF", 7),
      proj("D", "RB", 16), proj("E", "WR", 15),
    ];
    // current: RB=A, RB=wr??; keep it simple: RB1=A, RB2=A? no. Use one RB slot
    // A, and Bx/Cx in WR/FLEX. D (RB 16) and E (WR 15) on the bench beat them.
    const r = buildOptimalLineup({
      week: 1,
      roster: roster("team:t:1", ["qb1", "A", "wr2", "Bx", "wr3", "te1", "Cx", "k1", "def1"], ["D", "E"], { startingSlots: STD_CONSTRAINTS.starting_slots }),
      constraints: STD_CONSTRAINTS,
      players: new Map(players.map((p) => [p.canonical_player_id, p])),
      projections: batch(projs, players),
    });
    const ins = r.changes_recommended.map((c) => c.in);
    assert.ok(ins.includes("D") && ins.includes("E"), "both genuine entrants are reported");
    // E (WR) should be paired with a WR leaver, never with A (an RB who stays).
    const eChange = r.changes_recommended.find((c) => c.in === "E")!;
    assert.equal(basePosOf(players, eChange.out), "WR");
    for (const c of r.changes_recommended) {
      assert.notEqual(c.out, "A", "A stays a starter (slides slots) — never a leaver");
    }
    // authoritative aggregate is optimal - current, not a sum of pair deltas.
    assert.equal(r.projected_points_gained, Math.round((r.optimal_total! - r.current_total!) * 100) / 100);
  });

  it("whole-set matching avoids the greedy misfire that emits a negative cross-position swap", () => {
    // Codex counterexample shape: FLEX=C(TE 15.5), WR2=B(10); bench D(RB 16),
    // E(WR 15). A greedy first-match pairs D<->B (stealing the only WR leaver),
    // leaving E<->C as a misleading "-0.5 WR over TE". Whole-set matching pairs
    // E<->B (+5, WR=WR) and D<->C (+0.5).
    const players = [
      player("qb1", "QB"), player("A", "RB"), player("rb1", "RB"),
      player("E", "WR"), player("wr0", "WR"), player("te0", "TE"),
      player("C", "TE"), player("k1", "K"), player("def1", "DEF"),
      player("D", "RB"), player("B", "WR"),
    ];
    const projs = [
      proj("qb1", "QB", 20), proj("A", "RB", 20), proj("rb1", "RB", 18),
      proj("E", "WR", 15), proj("wr0", "WR", 13), proj("te0", "TE", 9),
      proj("C", "TE", 15.5), proj("k1", "K", 8), proj("def1", "DEF", 7),
      proj("D", "RB", 16), proj("B", "WR", 10),
    ];
    // current starters: QB, A, rb1, B(WR), wr0(WR), te0, C(FLEX=TE 15.5), k1, def1.
    // optimal: D(16) takes FLEX (> C's 15.5), E(15) takes a WR slot -> B & C leave.
    // Greedy would pair D<->B then E<->C (-0.5); whole-set matching pairs E<->B.
    const r = buildOptimalLineup({
      week: 1,
      roster: roster("team:t:1", ["qb1", "A", "rb1", "B", "wr0", "te0", "C", "k1", "def1"], ["D", "E"], { startingSlots: STD_CONSTRAINTS.starting_slots }),
      constraints: STD_CONSTRAINTS,
      players: new Map(players.map((p) => [p.canonical_player_id, p])),
      projections: batch(projs, players),
    });
    const dC = r.changes_recommended.find((c) => c.in === "D");
    const eC = r.changes_recommended.find((c) => c.in === "E");
    assert.ok(dC && eC, "both entrants reported");
    // E (WR) must be paired with the WR leaver B — the only same-position match —
    // never left with a cross-position leaver producing a negative "swap".
    assert.equal(eC!.out, "B", "E is paired with same-position leaver B");
    assert.equal(basePosOf(players, eC!.out), "WR");
    assert.ok(eC!.gain > 0, "E's leg is a genuine positive upgrade (15 - 10)");
    assert.ok(r.changes_recommended.every((c) => c.gain > 0), "no misleading negative standalone swap");
    assert.ok(r.changes_recommended.every((c) => c.part_of_reshuffle));
    assert.equal(r.projected_points_gained, Math.round((r.optimal_total! - r.current_total!) * 100) / 100);
  });
});

function basePosOf(players: ReturnType<typeof player>[], id: string | null): string | null {
  if (!id) return null;
  return players.find((p) => p.canonical_player_id === id)?.position ?? null;
}

describe("lineup: UNKNOWN slots are matched jointly, not first-fit (Codex round 10)", () => {
  it("slot order [FLEX, RB] with UNKNOWN candidates [RB, WR] fills BOTH slots", () => {
    const constraints: RosterConstraints = {
      ...STD_CONSTRAINTS,
      starting_slots: ["FLEX", "RB"],
      slot_requirements: { RB: 1, FLEX: 1 },
    };
    const players = [player("uRB", "RB"), player("uWR", "WR")]; // both UNKNOWN (no proj)
    const r = buildOptimalLineup({
      week: 1,
      roster: roster("team:t:1", ["uRB", "uWR"], [], { startingSlots: constraints.starting_slots }),
      constraints,
      players: new Map(players.map((p) => [p.canonical_player_id, p])),
      projections: batch([], players),
    });
    const bySlot = Object.fromEntries(r.slots.map((s) => [s.slot, s.recommended_player_id]));
    assert.ok(bySlot.RB != null, "the RB slot is filled (uRB), not stranded by FLEX taking it first");
    assert.ok(bySlot.FLEX != null, "the FLEX slot is filled");
    assert.notEqual(bySlot.RB, bySlot.FLEX);
    assert.equal(r.empty_slots.length, 0, "no false empty slot");
  });
});

describe("uncertainty: bands stay ordered for negative projections (Codex round 10)", () => {
  it("weeklyBand(-4, WR, 1) returns floor <= -4 <= ceiling with positive sd", () => {
    const b = weeklyBand(-4, "WR", 1);
    assert.ok(b.std_dev > 0, `sd should be from |median|, got ${b.std_dev}`);
    assert.ok(b.floor <= -4, `floor ${b.floor} <= median`);
    assert.ok(b.ceiling >= -4, `ceiling ${b.ceiling} >= median`);
    assert.ok(b.floor <= b.ceiling, "band is ordered");
  });
  it("weeklyBand(0, RB, 1) still floors at 0", () => {
    const b = weeklyBand(0, "RB", 1);
    assert.equal(b.floor, 0);
    assert.ok(b.ceiling >= 0);
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
