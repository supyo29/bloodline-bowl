/**
 * PHASE 6 — roster-construction / trajectory validation
 * (`trajectory_analysis_version: ri-snake-trajectory-2026.1`) + the
 * `ri-snake-decision-2026.2` defect fix (positional-advantage damping +
 * required-slot desperation) discovered in Phase 6 simulation.
 *
 * Deterministic. Covers §50: optimal starter/FLEX assignment, bench discount,
 * starter completion, recovery cost, trajectory state, bounded trajectory
 * adjustment, same-position concentration, QB/TE over-draft protection, K/DST
 * gate, hard/soft gate separation, deterministic recommendations.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { FantasyPosition, LeagueProjection, OutcomeBand } from "@/lib/projections/schema";
import {
  assignOptimalRoster,
  computeRosterUtility,
  leagueMedianStarterVor,
  starterSlotsOf,
} from "@/lib/draft/roster-utility";
import { computeReplacementLevels, vorOf } from "@/lib/draft/replacement";
import { positionRecoveryCost, computeTrajectoryRisk } from "@/lib/draft/recovery";
import { positionalAdvantageDamp, computeRosterNeedState } from "@/lib/draft/need";
import { recommendDraft, type CompletedPick, type EngineInput } from "@/lib/draft/engine";
import { buildMarketSnapshot } from "@/lib/draft/survival";
import { RECOMMENDATION_MODEL_VERSION } from "@/lib/draft/schema";
import type { NormalizedPlayer } from "@/lib/sleeper/types";

const ROSTER_POSITIONS = ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "FLEX", "K", "DEF", "BN", "BN", "BN", "BN", "BN"];
const SLOTS = starterSlotsOf(ROSTER_POSITIONS);

function band(m: number): OutcomeBand {
  return { floor: m * 0.75, median: m, ceiling: m * 1.25, sd: m * 0.15, percentiles: { floor: 20, ceiling: 80 } };
}
let uid = 0;
function lp(position: FantasyPosition, points: number, id?: string): LeagueProjection {
  const pid = id ?? `${position}_${++uid}`;
  return {
    player_id: pid, full_name: pid, position, team: "AAA",
    league_slug: "t", league_id: "0", scoring_hash: "h",
    league_points: points, league_ppg: points / 17, league_outcome: band(points),
    sleeper_league_points: null,
    vs_sleeper: { delta_points: null, delta_pct: null, ri_rank: null, sleeper_rank: null, rank_delta: null, primary_driver: null },
    replacement_points: null, value_over_replacement: null, vor_rank: null, position_rank: null, overall_rank: null, tier: null,
    confidence: "HIGH",
  };
}
function mkRosterPlayer(id: string, position: FantasyPosition): NormalizedPlayer {
  return {
    player_id: id, full_name: id, first_name: null, last_name: null, position,
    fantasy_positions: [position], team: null, age: 26, years_exp: 4, status: null,
    injury_status: null, number: null, active: true, search_rank: null,
    depth_chart_order: null, depth_chart_position: null, resolved: true,
  };
}

/** deep synthetic league pool, all 6 positions. */
function pool(): LeagueProjection[] {
  uid = 0;
  const out: LeagueProjection[] = [];
  const spec: Array<[FantasyPosition, number, number, number]> = [
    ["QB", 30, 360, 5], ["RB", 60, 320, 4.5], ["WR", 70, 300, 3.2], ["TE", 30, 230, 5.5], ["K", 20, 130, 2.5], ["DEF", 20, 120, 2.8],
  ];
  for (const [p, n, top, dec] of spec) for (let i = 0; i < n; i++) out.push(lp(p, Math.max(10, top - i * dec), `${p}${i + 1}`));
  return out;
}

/* --------------------------------------------------------- §6 assignment */

describe("§6 optimal starter / FLEX assignment", () => {
  it("fills base slots with the top players, FLEX with the next best RB/WR/TE", () => {
    const roster = [
      lp("QB", 300, "qb"), lp("RB", 280, "rb1"), lp("RB", 260, "rb2"), lp("RB", 240, "rb3"),
      lp("WR", 270, "wr1"), lp("WR", 250, "wr2"), lp("WR", 200, "wr3"),
      lp("TE", 180, "te1"), lp("K", 120, "k"), lp("DEF", 110, "def"),
      lp("RB", 100, "rb4"),
    ];
    const a = assignOptimalRoster(roster, SLOTS);
    assert.deepEqual(a.starters.RB?.map((p) => p.player_id), ["rb1", "rb2"]);
    assert.deepEqual(a.starters.WR?.map((p) => p.player_id), ["wr1", "wr2"]);
    // FLEX = the 2 best of {rb3 240, wr3 200, ...} → rb3, wr3
    assert.deepEqual(a.flex.map((p) => p.player_id).sort(), ["rb3", "wr3"]);
    assert.ok(a.bench.some((p) => p.player_id === "rb4"));
    assert.equal(a.open_flex, 0);
    assert.equal(Object.values(a.open_slots).reduce((x, y) => x + (y ?? 0), 0), 0);
  });

  it("reports open slots when a required position is unfilled", () => {
    const a = assignOptimalRoster([lp("QB", 300), lp("RB", 280), lp("WR", 270)], SLOTS);
    assert.equal(a.open_slots.RB, 1); // needs 2, has 1
    assert.equal(a.open_slots.TE, 1);
    assert.equal(a.open_slots.K, 1);
    assert.equal(a.open_slots.DEF, 1);
    assert.equal(a.open_flex, 2);
  });
});

/* --------------------------------------------------------- §5/§21 utility */

describe("§5 roster utility + §21 bench discount", () => {
  const p = pool();
  const levels = computeReplacementLevels(ROSTER_POSITIONS, 12, p);
  const medians = leagueMedianStarterVor(p, SLOTS, 12, levels);

  it("a bench player's VOR counts less than the same VOR in a starting slot", () => {
    const starterRoster = [
      lp("QB", 340), lp("RB", 300), lp("RB", 290), lp("WR", 280), lp("WR", 270), lp("TE", 200),
      lp("RB", 260), lp("WR", 250), lp("K", 120), lp("DEF", 110),
    ];
    const benchRoster = [...starterRoster, lp("WR", 240, "benchwr")];
    const uStart = computeRosterUtility(assignOptimalRoster(starterRoster, SLOTS), levels, medians);
    const uBench = computeRosterUtility(assignOptimalRoster(benchRoster, SLOTS), levels, medians);
    const benchWrVor = vorOf(lp("WR", 240, "x"), levels);
    // adding a bench WR raises utility by << its full VOR
    assert.ok(uBench.utility - uStart.utility < benchWrVor, "bench VOR was counted at full weight");
    assert.ok(uBench.utility - uStart.utility > 0, "bench depth should still add something");
  });

  it("an incomplete roster is penalised for every open required starter slot", () => {
    const complete = computeRosterUtility(assignOptimalRoster([
      lp("QB", 340), lp("RB", 300), lp("RB", 290), lp("WR", 280), lp("WR", 270), lp("TE", 200),
      lp("RB", 260), lp("WR", 250), lp("K", 120), lp("DEF", 110),
    ], SLOTS), levels, medians);
    const missingKDef = computeRosterUtility(assignOptimalRoster([
      lp("QB", 340), lp("RB", 300), lp("RB", 290), lp("WR", 280), lp("WR", 270), lp("TE", 200),
      lp("RB", 260), lp("WR", 250),
    ], SLOTS), levels, medians);
    assert.equal(complete.open_starter_slots, 0);
    assert.equal(missingKDef.open_starter_slots, 2);
    assert.ok(missingKDef.starter_completion_penalty > 0);
    assert.ok(missingKDef.utility < complete.utility);
  });
});

/* --------------------------------------------------------- §9 recovery cost */

describe("§9/§36 recovery cost + §45 monotonicity", () => {
  const cand = (points: number[], surv: number) =>
    points.map((pt, i) => ({ player_id: `c${i}`, league_points: pt, vor: pt - 100, p_survives_next_pick: surv }));

  it("better future availability never increases recovery cost", () => {
    const next = cand([200, 180, 160], 0.9);
    const secondHigh = cand([200, 180, 160], 0.9); // likely to survive
    const secondLow = cand([200, 180, 160], 0.1); // likely gone
    const rcHigh = positionRecoveryCost("RB", 210, 110, next, secondHigh);
    const rcLow = positionRecoveryCost("RB", 210, 110, next, secondLow);
    assert.ok(rcHigh.recovery_cost_points <= rcLow.recovery_cost_points + 1e-6);
  });

  it("larger expected future value drop never reduces recovery cost", () => {
    const shallow = positionRecoveryCost("WR", 210, 110, cand([205, 200], 0.5), cand([200, 195], 0.5));
    const steep = positionRecoveryCost("WR", 210, 110, cand([150, 140], 0.5), cand([120, 110], 0.5));
    assert.ok(steep.recovery_cost_points >= shallow.recovery_cost_points - 1e-6);
  });

  it("trajectory risk is bounded [0,1] and rises with more at-risk positions", () => {
    const low = computeTrajectoryRisk({
      trajectory: { open_starters: {}, open_flex: 0, starter_completion_risk: 0.1, flex_completion_risk: 0, position_concentration: 0.2, bench_balance: 0.9, at_risk_positions: [] },
      recoveryCostByPosition: {}, typicalRecoveryCostVor: 20,
    });
    const high = computeTrajectoryRisk({
      trajectory: { open_starters: { RB: 2, TE: 1 }, open_flex: 2, starter_completion_risk: 0.85, flex_completion_risk: 0.7, position_concentration: 2.2, bench_balance: 0.2, at_risk_positions: ["RB", "TE"] },
      recoveryCostByPosition: { RB: 60, TE: 45 }, typicalRecoveryCostVor: 20,
    });
    assert.ok(low.trajectory_risk >= 0 && low.trajectory_risk <= 1);
    assert.ok(high.trajectory_risk >= 0 && high.trajectory_risk <= 1);
    assert.ok(high.trajectory_risk > low.trajectory_risk);
  });
});

/* ------------------------------------------------ §12 / 2026.2 defect fix */

describe("ri-snake-decision-2026.2 — positional-advantage damping", () => {
  it("version bumped to 2026.2", () => {
    assert.equal(RECOMMENDATION_MODEL_VERSION, "ri-snake-decision-2026.2");
  });

  it("damp is 1.0 for a 1st QB / 2nd RB and drops once a position is roster-maxed", () => {
    const emptyState = computeRosterNeedState([], ROSTER_POSITIONS);
    assert.equal(positionalAdvantageDamp(emptyState, "QB", ROSTER_POSITIONS), 1);
    assert.equal(positionalAdvantageDamp(emptyState, "RB", ROSTER_POSITIONS), 1);

    // QB useful capacity = 1 base + 0 flex + 1 bench allowance = 2
    const twoQb = computeRosterNeedState([mkRosterPlayer("q1", "QB"), mkRosterPlayer("q2", "QB")], ROSTER_POSITIONS);
    assert.ok(positionalAdvantageDamp(twoQb, "QB", ROSTER_POSITIONS) < 0.5);

    // RB useful capacity = 2 base + 2 flex + 1 = 5 — a 4th RB is still full weight
    const fourRb = computeRosterNeedState(["a", "b", "c", "d"].map((i) => mkRosterPlayer(i, "RB")), ROSTER_POSITIONS);
    assert.equal(positionalAdvantageDamp(fourRb, "RB", ROSTER_POSITIONS), 1);
    const sixRb = computeRosterNeedState(["a", "b", "c", "d", "e", "f"].map((i) => mkRosterPlayer(i, "RB")), ROSTER_POSITIONS);
    assert.ok(positionalAdvantageDamp(sixRb, "RB", ROSTER_POSITIONS) < 0.5);
  });

  it("the engine no longer recommends a 3rd QB over a startable skill player", () => {
    const p = pool();
    // manager already has QB + QB, needs RB/WR still
    const roster = [mkRosterPlayer("QB1", "QB"), mkRosterPlayer("QB2", "QB"), mkRosterPlayer("WR1", "WR")];
    const taken = new Set(roster.map((r) => r.player_id));
    const searchRank = new Map(p.map((x, i) => [x.player_id, i + 1] as const));
    const completed: CompletedPick[] = [...p]
      .filter((x) => !taken.has(x.player_id) && x.position !== "K" && x.position !== "DEF")
      .sort((a, b) => b.league_points - a.league_points)
      .slice(0, 60)
      .map((x, i) => ({ overall: i + 1, roster_id: (i % 12) + 1, player_id: x.player_id, position: x.position }));
    const input: EngineInput = {
      leaguePool: p, rosterPositions: ROSTER_POSITIONS, numTeams: 12, draftType: "snake", rounds: 15,
      completedPicks: completed,
      manager: { roster_id: 7, sleeper_user_id: "u7", manager_slug: "m7", draft_slot: 7 },
      rosterPlayers: roster,
      market: buildMarketSnapshot({ adpByPlayer: null, searchRankByPlayer: searchRank, timestamp: "t" }),
      provenance: { projection_source: "t", projection_version: "v", projection_timestamp: "t", league_scoring_hash: "h", draft_state_timestamp: "t" },
    };
    const res = recommendDraft(input);
    assert.ok(res.primary_recommendation);
    assert.notEqual(res.primary_recommendation!.position, "QB", `engine recommended a 3rd QB: ${res.primary_recommendation!.player_name}`);
  });

  it("required-slot desperation: on the last pick, an unfilled required starter beats a redundant bench player", () => {
    const p = pool();
    // Roster with EVERY slot filled except K, at round 15 (own_picks_made 14,
    // picksRemaining 1) — one open required slot, one pick left → desperation.
    const roster = [
      "QB1", "RB1", "RB2", "WR1", "WR2", "TE1", "RB3", "WR3", "RB4", "WR4", "QB2", "TE2", "RB5", "DEF1",
    ].map((id) => mkRosterPlayer(id, id.startsWith("QB") ? "QB" : id.startsWith("RB") ? "RB" : id.startsWith("WR") ? "WR" : id.startsWith("TE") ? "TE" : "DEF"));
    const taken = new Set(roster.map((r) => r.player_id));
    const searchRank = new Map(p.map((x, i) => [x.player_id, i + 1] as const));
    // opponents fill overalls 1..(15*12 - manager's 15) so the manager's own
    // pick history reads as 14 completed (this is the round-15 pick).
    const others = [...p].filter((x) => !taken.has(x.player_id)).sort((a, b) => (searchRank.get(a.player_id) ?? 9e3) - (searchRank.get(b.player_id) ?? 9e3));
    let oi = 0;
    const completed: CompletedPick[] = [];
    for (let overall = 1; overall <= 168; overall++) {
      // slot 7 owns overalls 7,18,31,42,55,66,79,90,103,114,127,138,151,162
      const slot7Owns = new Set([7, 18, 31, 42, 55, 66, 79, 90, 103, 114, 127, 138, 151, 162]);
      if (slot7Owns.has(overall)) continue;
      const x = others[oi++];
      if (!x) break;
      completed.push({ overall, roster_id: (overall % 12) + 1, player_id: x.player_id, position: x.position });
    }
    const input: EngineInput = {
      leaguePool: p, rosterPositions: ROSTER_POSITIONS, numTeams: 12, draftType: "snake", rounds: 15,
      completedPicks: completed,
      manager: { roster_id: 7, sleeper_user_id: "u7", manager_slug: "m7", draft_slot: 7 },
      rosterPlayers: roster,
      market: buildMarketSnapshot({ adpByPlayer: null, searchRankByPlayer: searchRank, timestamp: "t" }),
      provenance: { projection_source: "t", projection_version: "v", projection_timestamp: "t", league_scoring_hash: "h", draft_state_timestamp: "t" },
    };
    const res = recommendDraft(input);
    assert.ok(res.primary_recommendation);
    assert.equal(res.primary_recommendation!.position, "K", `expected K on the last pick with K unfilled, got ${res.primary_recommendation!.position}`);
  });
});

/* --------------------------------------- §31 K/DEF coverage-based readiness */

describe("K/DEF projection coverage drives readiness (evidence-based, not silent)", () => {
  const mkInput = (over: Partial<EngineInput> = {}): EngineInput => {
    const skillOnly = pool().filter((x) => x.position !== "K" && x.position !== "DEF");
    return {
      leaguePool: skillOnly, rosterPositions: ROSTER_POSITIONS, numTeams: 12, draftType: "snake", rounds: 15,
      completedPicks: [], manager: { roster_id: 7, sleeper_user_id: "u", manager_slug: "m", draft_slot: 7 },
      rosterPlayers: [],
      market: buildMarketSnapshot({ adpByPlayer: null, searchRankByPlayer: new Map(skillOnly.map((x) => [x.player_id, null])), timestamp: "t" }),
      provenance: { projection_source: "t", projection_version: "v", projection_timestamp: "t", league_scoring_hash: "h", draft_state_timestamp: "t" },
      ...over,
    };
  };

  it("DEGRADED when a required position has no coverage (K/DEF absent, no coverage passed)", () => {
    const res = recommendDraft(mkInput());
    assert.equal(res.readiness.snake_engine_status, "DEGRADED");
    assert.ok(res.readiness.degraded_reasons.some((r) => /K has no valid production projection coverage/.test(r)));
    assert.ok(res.readiness.degraded_reasons.some((r) => /DEF has no valid production projection coverage/.test(r)));
    assert.ok(res.warnings.some((w) => /K projection coverage unavailable/.test(w)));
    assert.equal(res.provenance.projection_coverage.K, null);
    assert.equal(res.provenance.projection_coverage.DEF, null);
  });

  it("READY when every required position has coverage (K/DEF rows + coverage versions)", () => {
    const full = pool(); // includes K + DEF rows
    const res = recommendDraft(
      mkInput({
        leaguePool: full,
        projectionCoverage: { QB: "ri-structural-2026.3", RB: "ri-structural-2026.3", WR: "ri-structural-2026.3", TE: "ri-structural-2026.3", K: "ri-kicker-2026.1", DEF: "ri-defense-2026.1" },
        market: buildMarketSnapshot({ adpByPlayer: null, searchRankByPlayer: new Map(full.map((x) => [x.player_id, null])), timestamp: "t" }),
      }),
    );
    assert.equal(res.readiness.snake_engine_status, "READY");
    assert.deepEqual(res.readiness.degraded_reasons, []);
    assert.equal(res.provenance.projection_coverage.K, "ri-kicker-2026.1");
    assert.equal(res.provenance.projection_coverage.DEF, "ri-defense-2026.1");
  });

  it("DEGRADED for exactly the one position whose coverage is null (K source failed)", () => {
    const full = pool();
    const res = recommendDraft(
      mkInput({
        leaguePool: full,
        projectionCoverage: { QB: "ri-structural-2026.3", RB: "ri-structural-2026.3", WR: "ri-structural-2026.3", TE: "ri-structural-2026.3", K: null, DEF: "ri-defense-2026.1" },
        market: buildMarketSnapshot({ adpByPlayer: null, searchRankByPlayer: new Map(full.map((x) => [x.player_id, null])), timestamp: "t" }),
      }),
    );
    assert.equal(res.readiness.snake_engine_status, "DEGRADED");
    assert.ok(res.readiness.degraded_reasons.some((r) => /K has no valid production projection coverage/.test(r)));
    assert.ok(!res.readiness.degraded_reasons.some((r) => /DEF has no valid production projection coverage/.test(r)));
  });
});

/* ------------------------------------------------ §30/§45 determinism */

describe("§30 simulation-frequency independence / §23 determinism", () => {
  it("identical inputs → identical recommendation (no hidden simulation-frequency term)", () => {
    const p = pool();
    const sr = new Map(p.map((x, i) => [x.player_id, i + 1] as const));
    const mk = (): EngineInput => ({
      leaguePool: p, rosterPositions: ROSTER_POSITIONS, numTeams: 12, draftType: "snake", rounds: 15,
      completedPicks: [...p].sort((a, b) => b.league_points - a.league_points).slice(0, 20).map((x, i) => ({ overall: i + 1, roster_id: (i % 12) + 1, player_id: x.player_id, position: x.position })),
      manager: { roster_id: 7, sleeper_user_id: "u", manager_slug: "m", draft_slot: 7 },
      rosterPlayers: [], market: buildMarketSnapshot({ adpByPlayer: null, searchRankByPlayer: sr, timestamp: "t" }),
      provenance: { projection_source: "t", projection_version: "v", projection_timestamp: "t", league_scoring_hash: "h", draft_state_timestamp: "t" },
    });
    const a = recommendDraft(mk());
    const b = recommendDraft(mk());
    assert.equal(a.primary_recommendation?.player_id, b.primary_recommendation?.player_id);
    assert.equal(a.primary_recommendation?.recommendation_score, b.primary_recommendation?.recommendation_score);
  });
});
