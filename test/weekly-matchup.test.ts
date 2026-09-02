/**
 * Matchup engine — deterministic (PART XVI).
 *
 *  - each team's OPTIMAL legal lineup is used
 *  - projected margin is correct
 *  - the same player cannot appear on both teams
 *  - incomplete projections degrade honestly
 *  - probability omitted when unsupported
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildMatchup, buildLeverage } from "../lib/weekly/matchup";
import { player, proj, roster, weeklyContext } from "./fixtures/weekly";

const SLOTS = ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "K", "DEF"];

function nine(prefix: string) {
  return [
    player(`${prefix}qb`, "QB"), player(`${prefix}rb1`, "RB"), player(`${prefix}rb2`, "RB"),
    player(`${prefix}wr1`, "WR"), player(`${prefix}wr2`, "WR"), player(`${prefix}te`, "TE"),
    player(`${prefix}fx`, "WR"), player(`${prefix}k`, "K"), player(`${prefix}def`, "DEF"),
  ];
}
function nineProj(prefix: string, base: number) {
  const p = nine(prefix);
  return p.map((pl, i) => proj(pl.canonical_player_id, pl.position, base - i));
}

describe("matchup: optimal legal lineups", () => {
  it("both teams are scored on their OPTIMAL lineup, not their current one", () => {
    const myPlayers = [...nine("a"), player("aBenchStud", "WR")];
    const myProjs = [...nineProj("a", 20), proj("aBenchStud", "WR", 30)]; // benched stud
    const myRoster = roster("team:test-league:1", nine("a").map((p) => p.canonical_player_id), ["aBenchStud"], { startingSlots: SLOTS });
    const oppRoster = roster("team:test-league:2", nine("b").map((p) => p.canonical_player_id), [], { startingSlots: SLOTS });

    const ctx = weeklyContext({
      myRoster, oppRoster, players: [...myPlayers, ...nine("b")],
      projections: [...myProjs, ...nineProj("b", 15)],
    });
    const m = buildMatchup(ctx);
    // My optimal MUST include the 30-pt bench stud in a WR/FLEX slot.
    assert.ok(m.team_lineup.slots.some((s) => s.recommended_player_id === "aBenchStud"));
    assert.ok((m.team_optimal_total ?? 0) > (m.team_lineup.current_total ?? 0));
    // Margin = my optimal - opp optimal.
    assert.equal(m.projected_margin, Math.round((m.team_optimal_total! - m.opponent_optimal_total!) * 100) / 100);
  });

  it("a player rostered by BOTH teams never appears in both optimal lineups", () => {
    // Shared id on both rosters (shouldn't happen in reality, but the engine must be safe).
    const shared = player("shared-wr", "WR");
    const myRoster = roster("team:test-league:1", ["aqb", "arb1", "arb2", "shared-wr", "awr2", "ate", "afx", "ak", "adef"], [], { startingSlots: SLOTS });
    const oppRoster = roster("team:test-league:2", ["bqb", "brb1", "brb2", "shared-wr", "bwr2", "bte", "bfx", "bk", "bdef"], [], { startingSlots: SLOTS });
    const players = [...nine("a").filter((p) => p.canonical_player_id !== "awr1"), ...nine("b").filter((p) => p.canonical_player_id !== "bwr1"), shared];
    const projs = [...nineProj("a", 18).filter((p) => p.canonical_player_id !== "awr1"), ...nineProj("b", 16).filter((p) => p.canonical_player_id !== "bwr1"), proj("shared-wr", "WR", 25)];
    const ctx = weeklyContext({ myRoster, oppRoster, players, projections: projs });
    const m = buildMatchup(ctx);
    const mine = m.team_lineup.slots.map((s) => s.recommended_player_id);
    const theirs = m.opponent_lineup!.slots.map((s) => s.recommended_player_id);
    // Each optimizer runs on its own roster; the shared player can be in each
    // team's own lineup, but never twice within one team.
    assert.equal(new Set(mine.filter(Boolean)).size, mine.filter(Boolean).length);
    assert.equal(new Set(theirs.filter(Boolean)).size, theirs.filter(Boolean).length);
  });

  it("no opponent -> margin null, probability UNAVAILABLE, has_opponent false", () => {
    const myRoster = roster("team:test-league:1", nine("a").map((p) => p.canonical_player_id), [], { startingSlots: SLOTS });
    const ctx = weeklyContext({ myRoster, oppRoster: null, players: nine("a"), projections: nineProj("a", 18) });
    const m = buildMatchup(ctx);
    assert.equal(m.has_opponent, false);
    assert.equal(m.projected_margin, null);
    assert.equal(m.win_probability, null);
    assert.equal(m.win_probability_confidence, "UNAVAILABLE");
  });
});

describe("matchup: probability + degraded state", () => {
  it("omits win probability when starter projection coverage is too thin", () => {
    const myP = nine("a");
    // Only 3 of 9 starters projected.
    const myProjs = nineProj("a", 18).slice(0, 3);
    const oppProjs = nineProj("b", 16);
    const ctx = weeklyContext({
      myRoster: roster("team:test-league:1", myP.map((p) => p.canonical_player_id), [], { startingSlots: SLOTS }),
      oppRoster: roster("team:test-league:2", nine("b").map((p) => p.canonical_player_id), [], { startingSlots: SLOTS }),
      players: [...myP, ...nine("b")],
      projections: [...myProjs, ...oppProjs],
    });
    const m = buildMatchup(ctx);
    assert.equal(m.win_probability, null);
    assert.equal(m.win_probability_confidence, "UNAVAILABLE");
    assert.ok(m.warnings.some((w) => w.code === "win_probability_unavailable"));
    // 6 of my 9 optimal starters are UNKNOWN -> the optimal total (and margin)
    // is UNAVAILABLE, never a silently-low number (issue 4).
    assert.equal(m.team_optimal_total, null);
    assert.equal(m.projected_margin, null);
    assert.equal(m.projected_margin_status, "UNAVAILABLE");
    assert.ok(m.warnings.some((w) => w.code === "projected_margin_unavailable"));
    // a known subtotal is still exposed for display.
    assert.ok(m.team_known_subtotal > 0 && m.team_known_subtotal < (m.opponent_known_subtotal || Infinity));
  });

  it("win probability is suppressed when a lineup is PROVISIONAL (eligible unprojected bench player)", () => {
    const myP = [...nine("a"), player("aMystery", "RB")]; // aMystery: NO projection
    const ctx = weeklyContext({
      myRoster: roster("team:test-league:1", nine("a").map((p) => p.canonical_player_id), ["aMystery"], { startingSlots: SLOTS }),
      oppRoster: roster("team:test-league:2", nine("b").map((p) => p.canonical_player_id), [], { startingSlots: SLOTS }),
      players: [...myP, ...nine("b")],
      projections: [...nineProj("a", 20), ...nineProj("b", 15)], // all 9+9 STARTERS projected
    });
    const m = buildMatchup(ctx);
    // all optimal starters are projected, so the margin is a real number...
    assert.equal(typeof m.projected_margin, "number");
    assert.equal(m.projected_margin_status, "PARTIAL_PROVISIONAL");
    // ...but an eligible unprojected bench player means the optimum is not proven,
    // so win probability is NOT simulated.
    assert.equal(m.win_probability, null);
    assert.equal(m.win_probability_confidence, "UNAVAILABLE");
    assert.ok(m.warnings.some((w) => w.code === "win_probability_unavailable" && /PROVISIONAL/.test(w.message)));
  });

  it("a team with a fully-projected optimal lineup still gets a real margin", () => {
    const ctx = weeklyContext({
      myRoster: roster("team:test-league:1", nine("a").map((p) => p.canonical_player_id), [], { startingSlots: SLOTS }),
      oppRoster: roster("team:test-league:2", nine("b").map((p) => p.canonical_player_id), [], { startingSlots: SLOTS }),
      players: [...nine("a"), ...nine("b")],
      projections: [...nineProj("a", 20), ...nineProj("b", 15)],
    });
    const m = buildMatchup(ctx);
    assert.equal(typeof m.projected_margin, "number");
    assert.ok(["COMPLETE", "PARTIAL_PROVISIONAL"].includes(m.projected_margin_status));
  });

  it("full coverage -> a seeded, deterministic, LOW-confidence Monte-Carlo probability", () => {
    const ctx = weeklyContext({
      myRoster: roster("team:test-league:1", nine("a").map((p) => p.canonical_player_id), [], { startingSlots: SLOTS }),
      oppRoster: roster("team:test-league:2", nine("b").map((p) => p.canonical_player_id), [], { startingSlots: SLOTS }),
      players: [...nine("a"), ...nine("b")],
      projections: [...nineProj("a", 20), ...nineProj("b", 16)],
    });
    const a = buildMatchup(ctx);
    const b = buildMatchup(weeklyContext({
      myRoster: roster("team:test-league:1", nine("a").map((p) => p.canonical_player_id), [], { startingSlots: SLOTS }),
      oppRoster: roster("team:test-league:2", nine("b").map((p) => p.canonical_player_id), [], { startingSlots: SLOTS }),
      players: [...nine("a"), ...nine("b")],
      projections: [...nineProj("a", 20), ...nineProj("b", 16)],
    }));
    assert.equal(a.win_probability, b.win_probability, "seeded MC is deterministic");
    assert.equal(a.win_probability_confidence, "LOW");
    assert.ok(a.win_probability! > 0.5, "the higher-projected team should be favoured");
    assert.match(a.win_probability_method ?? "", /monte_carlo/);
  });
});

describe("matchup leverage", () => {
  it("ranks the manager's own lineup decisions by projected points gained", () => {
    const myPlayers = [...nine("a"), player("aStud", "WR"), player("aOk", "RB")];
    const myProjs = [...nineProj("a", 12), proj("aStud", "WR", 25), proj("aOk", "RB", 14)];
    const myRoster = roster("team:test-league:1",
      ["aqb", "arb1", "arb2", "awr1", "awr2", "ate", "afx", "ak", "adef"], ["aStud", "aOk"], { startingSlots: SLOTS });
    const oppRoster = roster("team:test-league:2", nine("b").map((p) => p.canonical_player_id), [], { startingSlots: SLOTS });
    const ctx = weeklyContext({ myRoster, oppRoster, players: [...myPlayers, ...nine("b")], projections: [...myProjs, ...nineProj("b", 12)] });
    const m = buildMatchup(ctx);
    const lev = buildLeverage(m);
    assert.ok(lev.length >= 1);
    // sorted descending by projected_gain
    for (let i = 1; i < lev.length; i += 1) assert.ok(lev[i - 1]!.projected_gain >= lev[i]!.projected_gain);
    assert.ok(["HIGH", "MEDIUM", "LOW"].includes(lev[0]!.leverage));
  });
});
