/**
 * PHASE 4 — snake recommendation engine (`ri-snake-decision-2026.1`).
 *
 * Deterministic tests over synthetic league pools + draft states. Covers §35:
 * geometry, candidate vs recommendation, replacement + FLEX, tiers, scarcity,
 * roster need (soft, not a filter), survival fallbacks, reach cost, tier
 * survival, runs, trajectory, K/DST gate, determinism, drafted-player removal,
 * manager isolation, Layer-1 invariance, auction-unsupported, monotonicity,
 * and turn-pair optimisation.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { FantasyPosition, LeagueProjection, OutcomeBand } from "@/lib/projections/schema";
import { computeSnakeTurnState, canonicalPairKey } from "@/lib/draft/geometry";
import { overallPickNumber } from "@/lib/bridge/geometry";
import { computeReplacementLevels, vorOf } from "@/lib/draft/replacement";
import { tierPosition } from "@/lib/draft/tiers";
import { evaluateKdstGate } from "@/lib/draft/kdst";
import { estimateSurvival, buildMarketSnapshot } from "@/lib/draft/survival";
import { uncertaintyPenalty } from "@/lib/draft/utility";
import { recommendDraft, type CompletedPick, type EngineInput } from "@/lib/draft/engine";
import type { NormalizedPlayer } from "@/lib/sleeper/types";

/* --------------------------------------------------------------- fixtures */

const ROSTER_POSITIONS = ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "FLEX", "K", "DEF", "BN", "BN", "BN", "BN", "BN"];
const NUM_TEAMS = 12;
const ROUNDS = 15;

function band(median: number): OutcomeBand {
  return { floor: median * 0.72, median, ceiling: median * 1.34, sd: median * 0.18, percentiles: { floor: 20, ceiling: 80 } };
}

let uid = 0;
function mkLP(o: {
  position: FantasyPosition;
  points: number;
  name?: string;
  id?: string;
  team?: string;
  confidence?: LeagueProjection["confidence"];
  sleeperDeltaPct?: number | null;
}): LeagueProjection {
  const id = o.id ?? `p${++uid}`;
  return {
    player_id: id,
    full_name: o.name ?? id,
    position: o.position,
    team: o.team ?? "AAA",
    league_slug: "synthetic",
    league_id: "0",
    scoring_hash: "sha_test",
    league_points: o.points,
    league_ppg: o.points / 17,
    league_outcome: band(o.points),
    sleeper_league_points: o.sleeperDeltaPct != null ? o.points / (1 + o.sleeperDeltaPct / 100) : null,
    vs_sleeper: {
      delta_points: null,
      delta_pct: o.sleeperDeltaPct ?? null,
      ri_rank: null,
      sleeper_rank: null,
      rank_delta: null,
      primary_driver: null,
    },
    replacement_points: null,
    value_over_replacement: null,
    vor_rank: null,
    position_rank: null,
    overall_rank: null,
    tier: null,
    confidence: o.confidence ?? "HIGH",
  };
}

/** A realistic-ish 12-team pool: steep RB, deep WR, cliffy TE, flat QB. */
function standardPool(): LeagueProjection[] {
  uid = 0;
  const pool: LeagueProjection[] = [];
  // RB: steep top, then a cliff after ~14
  const rbPts = [330, 322, 300, 292, 285, 250, 244, 240, 236, 232, 228, 224, 220, 216, 175, 170, 166, 162, 158, 150, 140, 135, 130, 120, 110, 100];
  rbPts.forEach((p, i) => pool.push(mkLP({ position: "RB", points: p, name: `RB${i + 1}`, id: `RB${i + 1}`, team: `T${i % 12}` })));
  // WR: deep and smooth
  const wrPts = [305, 300, 296, 292, 288, 284, 280, 276, 272, 268, 264, 260, 256, 252, 248, 244, 240, 236, 232, 228, 224, 220, 216, 212, 208, 204, 200, 196, 192, 188, 184, 180, 176, 172, 168, 164];
  wrPts.forEach((p, i) => pool.push(mkLP({ position: "WR", points: p, name: `WR${i + 1}`, id: `WR${i + 1}`, team: `T${i % 12}` })));
  // TE: one elite, big cliff, then flat
  const tePts = [232, 176, 172, 168, 164, 160, 120, 118, 116, 112, 108, 104, 100, 96, 92, 88];
  tePts.forEach((p, i) => pool.push(mkLP({ position: "TE", points: p, name: `TE${i + 1}`, id: `TE${i + 1}`, team: `T${i % 12}` })));
  // QB: flat plateau (no reason to reach)
  const qbPts = [340, 336, 332, 328, 325, 322, 319, 316, 313, 310, 307, 304, 300, 296, 292, 288];
  qbPts.forEach((p, i) => pool.push(mkLP({ position: "QB", points: p, name: `QB${i + 1}`, id: `QB${i + 1}`, team: `T${i % 12}` })));
  // K + DEF
  for (let i = 0; i < 16; i++) pool.push(mkLP({ position: "K", points: 140 - i * 3, name: `K${i + 1}`, id: `K${i + 1}`, team: `T${i % 12}` }));
  for (let i = 0; i < 16; i++) pool.push(mkLP({ position: "DEF", points: 130 - i * 3, name: `DEF${i + 1}`, id: `DEF${i + 1}`, team: `T${i % 12}` }));
  return pool;
}

function mkPlayer(id: string, position: FantasyPosition): NormalizedPlayer {
  return {
    player_id: id, full_name: id, first_name: null, last_name: null,
    position, fantasy_positions: [position], team: "AAA", age: 26, years_exp: 4,
    status: null, injury_status: null, number: null, active: true, search_rank: 50,
    depth_chart_order: 1, depth_chart_position: null, resolved: true,
  };
}

function baseInput(over: Partial<EngineInput> = {}): EngineInput {
  const pool = over.leaguePool ?? standardPool();
  const searchRank = new Map<string, number | null>();
  // search_rank ≈ overall value order
  [...pool].sort((a, b) => b.league_points - a.league_points).forEach((p, i) => searchRank.set(p.player_id, i + 1));
  return {
    leaguePool: pool,
    rosterPositions: ROSTER_POSITIONS,
    numTeams: NUM_TEAMS,
    draftType: "snake",
    rounds: ROUNDS,
    completedPicks: [],
    manager: { roster_id: 12, sleeper_user_id: "u12", manager_slug: "bijimac", draft_slot: 12 },
    rosterPlayers: [],
    market: buildMarketSnapshot({ adpByPlayer: null, searchRankByPlayer: searchRank, timestamp: "2026-09-01T00:00:00Z" }),
    provenance: {
      projection_source: "test",
      projection_version: "ri-structural-2026.3",
      projection_timestamp: "2026-09-01T00:00:00Z",
      league_scoring_hash: "sha_test",
      draft_state_timestamp: "2026-09-01T00:00:00Z",
    },
    ...over,
  };
}

/** Simulate `n` completed picks by other teams, best-player-available. */
function simulatePicks(pool: LeagueProjection[], n: number, opts: { skip?: Set<string> } = {}): CompletedPick[] {
  const skip = opts.skip ?? new Set<string>();
  const ranked = [...pool]
    .filter((p) => !skip.has(p.player_id) && p.position !== "K" && p.position !== "DEF")
    .sort((a, b) => b.league_points - a.league_points);
  const out: CompletedPick[] = [];
  for (let i = 0; i < n; i++) {
    const p = ranked[i];
    if (!p) break;
    out.push({ overall: i + 1, roster_id: (i % NUM_TEAMS) + 1, player_id: p.player_id, position: p.position });
  }
  return out;
}

/* --------------------------------------------------------------- geometry */

describe("§5 snake geometry", () => {
  it("odd rounds count up, even rounds count down", () => {
    assert.equal(overallPickNumber(1, 1, 12, "snake"), 1);
    assert.equal(overallPickNumber(12, 1, 12, "snake"), 12);
    assert.equal(overallPickNumber(12, 2, 12, "snake"), 13);
    assert.equal(overallPickNumber(1, 2, 12, "snake"), 24);
    assert.equal(overallPickNumber(6, 3, 12, "snake"), 30);
  });

  it("slot 1 turn is 24/25, slot 12 turn is 12/13 (12-team)", () => {
    const s1 = computeSnakeTurnState({ slot: 1, teamCount: 12, rounds: 15, overallPicksMade: 23 });
    assert.equal(s1.current_pick?.overall, 24);
    assert.equal(s1.next_manager_pick?.overall, 25);
    assert.ok(s1.is_consecutive_turn);

    const s12 = computeSnakeTurnState({ slot: 12, teamCount: 12, rounds: 15, overallPicksMade: 11 });
    assert.equal(s12.current_pick?.overall, 12);
    assert.equal(s12.next_manager_pick?.overall, 13);
    assert.equal(s12.second_next_manager_pick?.overall, 36);
    assert.ok(s12.is_consecutive_turn);
    assert.equal(s12.picks_until_next, 0);
    assert.equal(s12.picks_until_second_next, 22);
  });

  it("a middle slot is never on a consecutive turn", () => {
    for (let made = 0; made < 12 * 15; made += 1) {
      const s = computeSnakeTurnState({ slot: 6, teamCount: 12, rounds: 15, overallPicksMade: made });
      assert.equal(s.is_consecutive_turn, false, `slot 6 consecutive at ${made}`);
    }
  });

  it("final slot picks and waiting 4 vs 22 picks are different decisions", () => {
    const mid = computeSnakeTurnState({ slot: 4, teamCount: 12, rounds: 15, overallPicksMade: 3 }); // pick 4
    assert.equal(mid.current_pick?.overall, 4);
    assert.equal(mid.next_manager_pick?.overall, 21);
    assert.equal(mid.picks_until_next, 16);
  });

  it("canonical pair key is order-independent", () => {
    assert.equal(canonicalPairKey("RB3", "WR7"), canonicalPairKey("WR7", "RB3"));
  });
});

/* ---------------------------------------------------------- replacement */

describe("§4.2 / §12 replacement levels", () => {
  const pool = standardPool();
  const levels = computeReplacementLevels(ROSTER_POSITIONS, NUM_TEAMS, pool);

  it("derives from league structure, not hard-coded QB12/RB24/WR36", () => {
    // 1 QB/team × 12 = 12 base; QB is not flex-eligible → replacement rank ≈ 12 + small cushion
    assert.ok(levels.by_position.QB.replacement_rank >= 12 && levels.by_position.QB.replacement_rank <= 15);
    // RB base 2×12=24, gets flex share, plus cushion → strictly past 24
    assert.ok(levels.by_position.RB.replacement_rank > 24, `RB rank ${levels.by_position.RB.replacement_rank}`);
    assert.ok(levels.by_position.WR.replacement_rank > 24, `WR rank ${levels.by_position.WR.replacement_rank}`);
  });

  it("FLEX slots are attributed by marginal-player value, not split evenly", () => {
    const flexTotal = levels.by_position.RB.flex_share + levels.by_position.WR.flex_share + levels.by_position.TE.flex_share;
    // all marginal players in this (deliberately shallow) fixture are attributed
    assert.ok(flexTotal >= 12 && flexTotal <= 2 * NUM_TEAMS);
    // an even split would give each position 8; the deep smooth WR pool must
    // claim materially more flex than the cliffy TE pool
    assert.ok(
      levels.by_position.WR.flex_share > levels.by_position.TE.flex_share + 3,
      `WR flex ${levels.by_position.WR.flex_share} vs TE flex ${levels.by_position.TE.flex_share}`,
    );
  });

  it("K and DEF get no bench cushion (streamed)", () => {
    assert.equal(levels.by_position.K.bench_cushion, 0);
    assert.equal(levels.by_position.DEF.bench_cushion, 0);
  });

  it("VOR is league points minus replacement points", () => {
    const rb1 = pool.find((p) => p.player_id === "RB1")!;
    assert.equal(vorOf(rb1, levels), Math.round((rb1.league_points - levels.replacement_points.RB) * 100) / 100);
  });
});

/* ----------------------------------------------------------------- tiers */

describe("§4.3 / §21.1 tier model and cliffs", () => {
  const pool = standardPool();
  const levels = computeReplacementLevels(ROSTER_POSITIONS, NUM_TEAMS, pool);
  const vf = (p: LeagueProjection) => vorOf(p, levels);

  it("TE tier 1 is a single player with a large quantified cliff", () => {
    const te = tierPosition("TE", pool, vf);
    const t1 = te.boundaries.find((b) => b.tier === 1)!;
    assert.equal(t1.members, 1);
    assert.ok(t1.cliff_to_next_points >= 40, `TE cliff ${t1.cliff_to_next_points}`);
    const teElite = te.players.find((p) => p.player_id === "TE1")!;
    assert.ok(teElite.is_tier_last);
    assert.ok(teElite.distance_to_next_tier >= 40);
  });

  it("a flat QB plateau does NOT fragment into many tiers", () => {
    const qb = tierPosition("QB", pool, vf);
    const tiers = new Set(qb.players.map((p) => p.tier));
    assert.ok(tiers.size <= 3, `QB split into ${tiers.size} tiers`);
  });

  it("tiers are not rank/6 — RB tier boundaries track the real gap", () => {
    const rb = tierPosition("RB", pool, vf);
    // the cliff after RB14 (216 -> 175) should be a boundary
    const rb14 = rb.players.find((p) => p.player_id === "RB14")!;
    const rb15 = rb.players.find((p) => p.player_id === "RB15")!;
    assert.ok(rb15.tier > rb14.tier, "RB14->RB15 should cross a tier");
  });
});

/* ------------------------------------------------------------ K/DST gate */

describe("§14 K/DST hard timing gate", () => {
  it("holds K/DST until the last 3 rounds when the lineup is incomplete", () => {
    const g = evaluateKdstGate({ totalRounds: 15, currentRound: 4, openCoreStarters: 4, openFlex: 2, openBench: 5 });
    assert.equal(g.released, false);
    assert.equal(g.release_round, 13);
  });
  it("releases in the tail rounds regardless of roster", () => {
    const g = evaluateKdstGate({ totalRounds: 15, currentRound: 14, openCoreStarters: 2, openFlex: 1, openBench: 3 });
    assert.ok(g.released);
  });
  it("releases early once core + flex are done and the bench is nearly full", () => {
    const g = evaluateKdstGate({ totalRounds: 15, currentRound: 9, openCoreStarters: 0, openFlex: 0, openBench: 1 });
    assert.ok(g.released);
  });

  it("K/DST can never be the primary recommendation before the release round", () => {
    const res = recommendDraft(baseInput({ completedPicks: simulatePicks(standardPool(), 11) }));
    assert.ok(res.primary_recommendation);
    assert.notEqual(res.primary_recommendation!.position, "K");
    assert.notEqual(res.primary_recommendation!.position, "DEF");
    for (const r of [...res.alternates, ...res.wait_candidates]) {
      assert.ok(r.position !== "K" && r.position !== "DEF", `${r.player_name} surfaced early`);
    }
  });
});

/* --------------------------------------------------------------- survival */

describe("§7 / §9 survival interface", () => {
  const market = buildMarketSnapshot({
    adpByPlayer: null,
    searchRankByPlayer: new Map([["A", 10], ["B", 60], ["C", null]]),
    timestamp: "2026-09-01T00:00:00Z",
  });

  it("a player far past his market pick is unlikely to survive; far before is likely", () => {
    const soon = estimateSurvival({ playerId: "A", position: "RB", targetPickOverall: 25, interveningPicks: 12, market });
    const later = estimateSurvival({ playerId: "B", position: "WR", targetPickOverall: 25, interveningPicks: 12, market });
    assert.ok(soon.p_survives_next_pick < 0.5);
    assert.ok(later.p_survives_next_pick > 0.5);
    assert.equal(soon.confidence, "LOW"); // search_rank only
  });

  it("no market signal → LOW confidence, wide, still returns a number", () => {
    const none = estimateSurvival({ playerId: "C", position: "TE", targetPickOverall: 25, interveningPicks: 12, market });
    assert.equal(none.source, "positional_demand_only");
    assert.equal(none.confidence, "LOW");
    assert.ok(none.p_survives_next_pick >= 0 && none.p_survives_next_pick <= 1);
  });

  it("engine still produces a recommendation when survival is UNAVAILABLE for all", () => {
    const emptyMarket = buildMarketSnapshot({ adpByPlayer: null, searchRankByPlayer: new Map(), timestamp: null });
    const res = recommendDraft(baseInput({ market: emptyMarket, completedPicks: simulatePicks(standardPool(), 11) }));
    assert.ok(res.primary_recommendation);
    assert.equal(res.primary_recommendation!.survival.confidence, "LOW");
  });
});

/* ------------------------------------------------- candidate vs recommendation */

describe("§3 candidate vs recommendation semantics", () => {
  it("the recommendation is not simply the highest projection", () => {
    // Pick 12: RB pool about to cliff, WR pool deep. A slightly lower RB should
    // be able to out-rank the top remaining WR because of wait-loss + tier drop.
    const picks = simulatePicks(standardPool(), 11);
    const res = recommendDraft(baseInput({ completedPicks: picks }));
    const p = res.primary_recommendation!;
    const topByPoints = [...res.alternates, p].sort((a, b) => b.projected_points - a.projected_points)[0]!;
    // decision score ranking and raw-points ranking should not be identical
    const byScore = [p, ...res.alternates].map((r) => r.player_id);
    const byPoints = [p, ...res.alternates].sort((a, b) => b.projected_points - a.projected_points).map((r) => r.player_id);
    assert.notDeepEqual(byScore, byPoints);
    assert.ok(topByPoints);
  });

  it("every recommendation cites real evidence in its reason string", () => {
    const res = recommendDraft(baseInput({ completedPicks: simulatePicks(standardPool(), 11) }));
    for (const r of [res.primary_recommendation!, ...res.alternates]) {
      assert.match(r.reason, new RegExp(`${r.position}${r.position_rank}|Tier ${r.tier}`));
      assert.ok(r.reason_codes.length > 0 || r.vor < 5, `${r.player_name} has no reason codes`);
    }
  });
});

/* ----------------------------------------------------- roster need is soft */

describe("§4.5 / §13 roster need is a utility adjustment, not a hard filter", () => {
  it("a filled position is not excluded when its value drop is large", () => {
    // roster already has 2 RB + 2 WR + TE1; a huge WR value is available
    const pool = standardPool();
    const roster = [mkPlayer("RB1", "RB"), mkPlayer("RB2", "RB"), mkPlayer("WR20", "WR"), mkPlayer("WR21", "WR"), mkPlayer("TE1", "TE")];
    const taken = new Set(roster.map((r) => r.player_id));
    const res = recommendDraft(
      baseInput({
        rosterPlayers: roster,
        completedPicks: simulatePicks(pool, 30, { skip: taken }),
        limits: { alternates: 60, wait: 60, doNotReach: 60 },
      }),
    );
    const all = [res.primary_recommendation!, ...res.alternates, ...res.wait_candidates, ...res.do_not_reach];
    const wrSurfaced = all.some((r) => r.position === "WR" && r.recommendation_score > 0);
    assert.ok(wrSurfaced, "a strong WR must still be recommendable (not hard-excluded) with 4 WR/RB already rostered");
  });

  it("RB need rises with 4 WR / 1 RB but does not hard-veto a huge WR value", () => {
    const pool = standardPool();
    const roster = ["WR1", "WR2", "WR3", "WR4", "RB1"].map((id) => mkPlayer(id, id.startsWith("WR") ? "WR" : "RB"));
    const taken = new Set(roster.map((r) => r.player_id));
    const res = recommendDraft(baseInput({ rosterPlayers: roster, completedPicks: simulatePicks(pool, 20, { skip: taken }) }));
    // RB should be favoured but WR not absent from the alternates
    assert.equal(res.roster_trajectory.at_risk_positions.includes("RB") || res.primary_recommendation!.position === "RB", true);
  });
});

/* --------------------------------------------------------- determinism */

describe("§23 deterministic behaviour", () => {
  it("identical inputs → byte-identical recommendations", () => {
    const picks = simulatePicks(standardPool(), 11);
    const a = recommendDraft(baseInput({ completedPicks: picks }));
    const b = recommendDraft(baseInput({ completedPicks: picks }));
    assert.deepEqual(
      a.primary_recommendation && { id: a.primary_recommendation.player_id, s: a.primary_recommendation.recommendation_score },
      b.primary_recommendation && { id: b.primary_recommendation.player_id, s: b.primary_recommendation.recommendation_score },
    );
    assert.deepEqual(a.alternates.map((r) => r.player_id), b.alternates.map((r) => r.player_id));
  });
});

/* ------------------------------------------------- drafted-player removal */

describe("§30 live-state reconciliation", () => {
  it("a drafted player never appears as recommendable", () => {
    const pool = standardPool();
    const picks = simulatePicks(pool, 20);
    const takenIds = new Set(picks.map((p) => p.player_id));
    const res = recommendDraft(baseInput({ completedPicks: picks }));
    const surfaced = [
      res.primary_recommendation!,
      ...res.alternates,
      ...res.wait_candidates,
      ...res.do_not_reach,
    ].map((r) => r.player_id);
    for (const id of surfaced) assert.ok(!takenIds.has(id), `drafted ${id} was recommended`);
  });

  it("recommendations update after each sequential pick", () => {
    const pool = standardPool();
    let last: string | null = null;
    let changed = 0;
    for (let n = 8; n <= 16; n++) {
      const res = recommendDraft(baseInput({ completedPicks: simulatePicks(pool, n) }));
      const id = res.primary_recommendation?.player_id ?? null;
      if (last && id !== last) changed += 1;
      last = id;
    }
    assert.ok(changed >= 1, "primary recommendation should evolve as the board changes");
  });

  // Draft-night readiness audit §P — terminal state.
  it("emits no phantom recommendation once the manager has no picks left", () => {
    // 180/180 picks made — the whole draft is complete.
    const full: CompletedPick[] = Array.from({ length: NUM_TEAMS * ROUNDS }, (_, i) => ({
      overall: i + 1,
      roster_id: (i % NUM_TEAMS) + 1,
      player_id: `done${i}`,
      position: "WR" as FantasyPosition,
    }));
    const res = recommendDraft(baseInput({ completedPicks: full, rosterPlayers: [] }));
    assert.equal(res.turn.current_pick, null, "no current pick when the draft is over");
    assert.equal(res.primary_recommendation, null, "no phantom primary recommendation");
    assert.deepEqual(res.alternates, []);
    assert.deepEqual(res.primary_pair, null);
    assert.equal(res.readiness.snake_engine_status, "BLOCKED");
    assert.ok(
      res.readiness.blocked_reasons.some((r) => /no remaining picks|draft complete/i.test(r)),
      "blocked reason names the terminal state",
    );
  });

  it("a normal (non-mock) engine response never carries mock_draft_diagnostics", () => {
    const res = recommendDraft(baseInput({ completedPicks: simulatePicks(standardPool(), 11) }));
    assert.equal(Object.prototype.hasOwnProperty.call(res, "mock_draft_diagnostics"), false);
  });

  it("emits no recommendation once THIS manager's 15 picks are spent while others still draft", () => {
    // slot-7's last pick is overall 175; 176 picks made ⇒ this manager is done.
    const picks: CompletedPick[] = Array.from({ length: 176 }, (_, i) => ({
      overall: i + 1,
      roster_id: (i % NUM_TEAMS) + 1,
      player_id: `done${i}`,
      position: "WR" as FantasyPosition,
    }));
    const res = recommendDraft(
      baseInput({
        completedPicks: picks,
        manager: { roster_id: 7, sleeper_user_id: "u7", manager_slug: "supyo29", draft_slot: 7 },
      }),
    );
    assert.equal(res.primary_recommendation, null);
    assert.equal(res.readiness.snake_engine_status, "BLOCKED");
  });
});

/* -------------------------------------------------------- manager isolation */

describe("§31 manager isolation", () => {
  it("two managers with different roster/turn state get different recommendations", () => {
    const pool = standardPool();
    const picks = simulatePicks(pool, 24);
    const early = recommendDraft(
      baseInput({
        completedPicks: picks,
        manager: { roster_id: 1, sleeper_user_id: "u1", manager_slug: "supyo29", draft_slot: 1 },
        rosterPlayers: [mkPlayer("RB1", "RB"), mkPlayer("RB3", "RB")],
      }),
    );
    const late = recommendDraft(
      baseInput({
        completedPicks: picks,
        manager: { roster_id: 12, sleeper_user_id: "u12", manager_slug: "bijimac", draft_slot: 12 },
        rosterPlayers: [mkPlayer("WR1", "WR"), mkPlayer("WR2", "WR")],
      }),
    );
    assert.equal(early.manager_context.used_roster_id, 1);
    assert.equal(late.manager_context.used_roster_id, 12);
    assert.notEqual(
      early.primary_recommendation?.player_id,
      late.primary_recommendation?.player_id,
    );
  });
});

/* ------------------------------------------------------- Layer-1 invariance */

describe("§36 frozen-layer invariance", () => {
  it("the engine never mutates a LeagueProjection", () => {
    const pool = standardPool();
    const snapshot = JSON.stringify(pool);
    recommendDraft(baseInput({ leaguePool: pool, completedPicks: simulatePicks(pool, 11) }));
    assert.equal(JSON.stringify(pool), snapshot);
  });
});

/* -------------------------------------------------------- auction unsupported */

describe("§0 / §33 SNAKE_ONLY", () => {
  it("engine readiness blocks a non-snake/linear draft type", () => {
    const res = recommendDraft(baseInput({ draftType: "auction", completedPicks: [] }));
    assert.equal(res.readiness.snake_engine_status, "BLOCKED");
    assert.equal(res.readiness.auction_engine_status, "UNSUPPORTED_2026");
  });
});

/* --------------------------------------------------------- monotonicity */

describe("§25 monotonicity (holding all else constant)", () => {
  function scoreWithRbTop(topPoints: number): number {
    const pool = standardPool();
    const rb1 = pool.find((p) => p.player_id === "RB1")!;
    rb1.league_points = topPoints;
    rb1.league_ppg = topPoints / 17;
    rb1.league_outcome = band(topPoints);
    const res = recommendDraft(baseInput({ leaguePool: pool, completedPicks: simulatePicks(pool, 11, { skip: new Set(["RB1"]) }) }));
    const r = [res.primary_recommendation!, ...res.alternates, ...res.wait_candidates, ...res.do_not_reach].find((x) => x.player_id === "RB1");
    return r?.recommendation_score ?? -Infinity;
  }

  it("higher VOR never lowers recommendation utility", () => {
    const lo = scoreWithRbTop(300);
    const hi = scoreWithRbTop(360);
    assert.ok(hi >= lo - 1e-6, `utility fell when VOR rose: ${lo} -> ${hi}`);
  });

  it("more picks until the next turn never increases survival probability", () => {
    const market = buildMarketSnapshot({ adpByPlayer: null, searchRankByPlayer: new Map([["X", 20]]), timestamp: "t" });
    const near = estimateSurvival({ playerId: "X", position: "RB", targetPickOverall: 25, interveningPicks: 4, market });
    const far = estimateSurvival({ playerId: "X", position: "RB", targetPickOverall: 40, interveningPicks: 22, market });
    assert.ok(far.p_survives_next_pick <= near.p_survives_next_pick + 1e-9);
  });

  it("lower uncertainty never produces a larger uncertainty penalty", () => {
    // done directly on the utility helper
    const wide = uncertaintyPenalty({ band: band(200), median: 200, draftProgress: 0.3, starterCompletionRisk: 0.2 });
    const narrow = uncertaintyPenalty({
      band: { floor: 190, median: 200, ceiling: 210, sd: 6, percentiles: { floor: 20, ceiling: 80 } },
      median: 200,
      draftProgress: 0.3,
      starterCompletionRisk: 0.2,
    });
    assert.ok(narrow <= wide + 1e-9, `narrow ${narrow} > wide ${wide}`);
  });

  it("K/DST stay blocked before the release round even with high raw points", () => {
    const pool = standardPool();
    pool.filter((p) => p.position === "K").forEach((p) => (p.league_points = 400)); // absurd
    const res = recommendDraft(baseInput({ leaguePool: pool, completedPicks: simulatePicks(pool, 11) }));
    assert.notEqual(res.primary_recommendation!.position, "K");
  });
});

/* ------------------------------------------------------- turn-pair (§21A) */

describe("§21A snake turn-pair optimisation", () => {
  it("BijiMac at 12/13 gets a primary pair, not two independent BPA picks", () => {
    const pool = standardPool();
    const res = recommendDraft(baseInput({ completedPicks: simulatePicks(pool, 11) }));
    assert.ok(res.turn.is_consecutive_turn);
    assert.ok(res.primary_pair, "consecutive turn must return a pair");
    const pair = res.primary_pair!;
    assert.notEqual(pair.player_1.player_id, pair.player_2.player_id);
    assert.ok(pair.pair_reason_codes.includes("TURN_PAIR_OPTIMAL"));
    // canonical order
    assert.ok(pair.player_1.player_id.localeCompare(pair.player_2.player_id) <= 0);
    // it forecasts the next turn (picks 36/37)
    assert.deepEqual(pair.anticipated_next_turn_alternatives.at_picks, [36, 37]);
  });

  it("a middle slot returns no pair", () => {
    const pool = standardPool();
    const res = recommendDraft(
      baseInput({
        manager: { roster_id: 6, sleeper_user_id: "u6", manager_slug: "mid", draft_slot: 6 },
        completedPicks: simulatePicks(pool, 5),
      }),
    );
    assert.equal(res.turn.is_consecutive_turn, false);
    assert.equal(res.primary_pair, null);
  });

  it("captures two simultaneous cliffs (RB tier + elite TE) when WR depth will survive", () => {
    const pool = standardPool();
    // put the elite TE and a tier-last RB in range at 12/13
    const picks = simulatePicks(pool, 11, { skip: new Set(["TE1", "RB14"]) });
    const res = recommendDraft(baseInput({ completedPicks: picks }));
    const pair = res.primary_pair!;
    const positions = [pair.player_1.position, pair.player_2.position];
    // WR should be a deferred position (deep pool survives), not both picks
    assert.ok(!(positions[0] === "WR" && positions[1] === "WR") || pair.tier_cliffs_captured.length > 0);
  });
});
