/**
 * PHASE 2 — production invariants for the ri-structural-2026.2 calibration.
 *
 * Deterministic proofs (no network) that the Phase 2 change:
 *   - reduces expected games monotonically and never increases them (§attrition)
 *   - keeps expected games non-decreasing in availability (§monotonicity)
 *   - never raises the RB/WR age multiplier (§age direction)
 *   - keeps the opportunity shade in (0, 1] and non-increasing (§opportunity)
 *   - preserves team-volume conservation (§conservation)
 *   - keeps Layer 1 league-scoring-neutral (§layer invariance)
 *   - keeps RI_STANDALONE independent of the Sleeper benchmark (§independence)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  CALIBRATION_V1,
  CALIBRATION_V2,
  GAMES_ATTRITION_HAIRCUT,
  AVAILABILITY_FLOOR,
  ageMultiplier,
  ageMultiplierV1,
  opportunityAgeShade,
  expectedSeasonGames,
} from "@/lib/projections/baselines";
import { buildBaseProjections, buildLeagueProjections, clearProjectionCaches } from "@/lib/projections/build";
import type { NormalizedPlayer } from "@/lib/sleeper/types";
import type { SeasonActuals, PlayerSeasonActual } from "@/lib/projections/actuals";
import type { FantasyPosition } from "@/lib/projections/schema";

/* ------------------------------------------------------------- §attrition + §monotonicity */

describe("expected-games: attrition direction and monotonicity", () => {
  const AVAILS = Array.from({ length: 101 }, (_, i) => i / 100); // 0.00 .. 1.00

  it("v2 expected games <= v1 for every availability (no floor edge case)", () => {
    for (const a of AVAILS) {
      const g1 = expectedSeasonGames(a, CALIBRATION_V1);
      const g2 = expectedSeasonGames(a, CALIBRATION_V2);
      assert.ok(g2 <= g1 + 1e-9, `avail ${a}: v2 ${g2} > v1 ${g1}`);
    }
  });

  it("the max(1, …) clamp never binds given the v2 availability floor", () => {
    // 17 * AVAILABILITY_FLOOR - haircut must exceed 1.
    assert.ok(17 * AVAILABILITY_FLOOR - GAMES_ATTRITION_HAIRCUT > 1);
    for (const a of AVAILS) {
      const raw = 17 * Math.max(0.4, Math.min(0.985, Math.max(AVAILABILITY_FLOOR, Math.min(0.985, a)))) - GAMES_ATTRITION_HAIRCUT;
      assert.ok(raw >= 1, `raw games ${raw} < 1 at avail ${a}`);
    }
  });

  it("expected games is non-decreasing in availability, under both calibrations", () => {
    for (const cal of [CALIBRATION_V1, CALIBRATION_V2]) {
      let prev = -Infinity;
      for (const a of AVAILS) {
        const g = expectedSeasonGames(a, cal);
        assert.ok(g >= prev - 1e-9, `${cal.id}: games decreased at avail ${a}`);
        prev = g;
      }
    }
  });

  it("the RB age penalty only ever lowers expected games", () => {
    for (const a of [0.5, 0.7, 0.85, 0.95]) {
      assert.ok(expectedSeasonGames(a, CALIBRATION_V2, 0.04) <= expectedSeasonGames(a, CALIBRATION_V2, 0));
    }
  });
});

/* ------------------------------------------------------------- §age direction */

describe("age multiplier: v2 never raises RB/WR vs v1", () => {
  it("ageMultiplier(v2) <= ageMultiplierV1 for RB and WR at every age 21-40", () => {
    for (const pos of ["RB", "WR"] as const) {
      for (let age = 21; age <= 40; age += 0.5) {
        const v1 = ageMultiplierV1(pos, age);
        const v2 = ageMultiplier(pos, age);
        assert.ok(v2 <= v1 + 1e-9, `${pos} age ${age}: v2 ${v2} > v1 ${v1}`);
      }
    }
  });

  it("v2 is strictly lower than v1 in the newly-affected decline ranges", () => {
    assert.ok(ageMultiplier("RB", 27) < ageMultiplierV1("RB", 27));
    assert.ok(ageMultiplier("WR", 30) < ageMultiplierV1("WR", 30));
    assert.ok(ageMultiplier("WR", 32) < ageMultiplierV1("WR", 32));
  });

  it("QB and TE curves are unchanged", () => {
    for (let age = 22; age <= 40; age += 1) {
      assert.equal(ageMultiplier("QB", age), ageMultiplierV1("QB", age));
      assert.equal(ageMultiplier("TE", age), ageMultiplierV1("TE", age));
    }
  });

  it("age multiplier is non-increasing past the peak for RB/WR (v2)", () => {
    for (const [pos, peak] of [["RB", 25], ["WR", 27]] as const) {
      let prev = Infinity;
      for (let age = peak; age <= 40; age += 0.5) {
        const m = ageMultiplier(pos, age);
        assert.ok(m <= prev + 1e-9, `${pos} age ${age}`);
        prev = m;
      }
    }
  });
});

/* ------------------------------------------------------------- §opportunity shade */

describe("opportunity age shade: bounded and never increases opportunity", () => {
  it("opportunityAgeShade is in (0, 1] for every position/age", () => {
    for (const pos of ["QB", "RB", "WR", "TE"] as const) {
      for (let age = 20; age <= 42; age += 0.5) {
        const s = opportunityAgeShade(pos, age);
        assert.ok(s > 0 && s <= 1 + 1e-9, `${pos} age ${age}: shade ${s}`);
      }
    }
  });

  it("is exactly 1 below age 30 and non-increasing at/after 30", () => {
    for (const pos of ["RB", "WR", "TE"] as const) {
      for (let age = 20; age < 30; age += 0.5) assert.equal(opportunityAgeShade(pos, age), 1);
      let prev = 1;
      for (let age = 30; age <= 42; age += 0.5) {
        const s = opportunityAgeShade(pos, age);
        assert.ok(s <= prev + 1e-9, `${pos} age ${age}`);
        prev = s;
      }
    }
  });

  it("QB shade stays 1 through the QB age plateau (<=36)", () => {
    for (let age = 30; age <= 36; age += 1) assert.equal(opportunityAgeShade("QB", age), 1);
  });

  it("the v1 profile shade is 1 for non-RB and in (0,1] for RB", () => {
    for (let age = 21; age <= 34; age += 1) {
      assert.equal(CALIBRATION_V1.opportunityShade("WR", age), 1);
      const rb = CALIBRATION_V1.opportunityShade("RB", age);
      assert.ok(rb > 0 && rb <= 1 + 1e-9);
    }
  });
});

/* ------------------------------------------------------------- fixtures for build-level invariants */

function player(o: Partial<NormalizedPlayer> & { player_id: string; position: FantasyPosition }): NormalizedPlayer {
  return {
    player_id: o.player_id, full_name: o.full_name ?? o.player_id, first_name: null, last_name: null,
    position: o.position, fantasy_positions: [o.position], team: o.team ?? "KC",
    age: o.age ?? 26, years_exp: o.years_exp ?? 4, status: null, injury_status: null, number: null,
    active: true, search_rank: o.search_rank ?? 50, depth_chart_order: o.depth_chart_order ?? 1,
    depth_chart_position: null, resolved: true,
  };
}
function seasonRow(o: Partial<PlayerSeasonActual> & { player_id: string; season: number }): PlayerSeasonActual {
  return {
    player_id: o.player_id, season: o.season, position: o.position ?? "WR", team: o.team ?? "KC",
    gp: o.gp ?? 17, gs: o.gs ?? 17, off_snp: o.off_snp ?? 900, tm_off_snp: o.tm_off_snp ?? 1000,
    snap_share: 0.9,
    pass_att: o.pass_att ?? 0, pass_cmp: o.pass_cmp ?? 0, pass_yd: o.pass_yd ?? 0, pass_td: o.pass_td ?? 0,
    pass_int: o.pass_int ?? 0, pass_rz_att: o.pass_rz_att ?? 0,
    rush_att: o.rush_att ?? 0, rush_yd: o.rush_yd ?? 0, rush_td: o.rush_td ?? 0, rush_rz_att: o.rush_rz_att ?? 0, g2g_att: 0,
    targets: o.targets ?? 0, rec: o.rec ?? 0, rec_yd: o.rec_yd ?? 0, rec_td: o.rec_td ?? 0, rec_air_yd: 0, rec_rz_tgt: o.rec_rz_tgt ?? 0,
    fum_lost: 0, fgm: 0, fga: 0, fgm_yds: 0, xpm: 0, xpa: 0,
    def_sack: 0, def_int: 0, def_fum_rec: 0, def_td: 0, def_safety: 0, pts_ppr: o.pts_ppr ?? 0,
  };
}

const TEAMS = ["KC", "BUF", "CIN", "SF", "DAL", "MIA"];
const ROSTER_POS = ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "BN", "BN"];

function fixtureUniverse() {
  const players: NormalizedPlayer[] = [];
  for (const team of TEAMS) {
    players.push(player({ player_id: `${team}_qb`, position: "QB", team, depth_chart_order: 1 }));
    for (let i = 1; i <= 3; i++) players.push(player({ player_id: `${team}_rb${i}`, position: "RB", team, depth_chart_order: i, age: 24 + i }));
    for (let i = 1; i <= 4; i++) players.push(player({ player_id: `${team}_wr${i}`, position: "WR", team, depth_chart_order: i, age: 25 + i }));
    players.push(player({ player_id: `${team}_te`, position: "TE", team, depth_chart_order: 1, age: 28 }));
  }
  const playerIndex = new Map(players.map((p) => [p.player_id, p]));

  const seasons: SeasonActuals[] = [2023, 2024, 2025].map((season) => {
    const rows = new Map<string, PlayerSeasonActual>();
    const team_totals = new Map<string, ReturnType<typeof teamTotal>>();
    for (const team of TEAMS) {
      rows.set(`${team}_qb`, seasonRow({ player_id: `${team}_qb`, season, position: "QB", pass_att: 560, pass_cmp: 370, pass_yd: 4100, pass_td: 27, pass_int: 11, pass_rz_att: 62, rush_att: 40, rush_yd: 180, rush_td: 2, rush_rz_att: 8, pts_ppr: 300 }));
      for (let i = 1; i <= 3; i++) {
        const sc = [1, 0.5, 0.2][i - 1]!;
        rows.set(`${team}_rb${i}`, seasonRow({ player_id: `${team}_rb${i}`, season, position: "RB", rush_att: Math.round(240 * sc), rush_yd: Math.round(1050 * sc), rush_td: Math.round(9 * sc), rush_rz_att: Math.round(42 * sc), targets: Math.round(52 * sc), rec: Math.round(40 * sc), rec_yd: Math.round(320 * sc), rec_rz_tgt: Math.round(5 * sc), pts_ppr: Math.round(240 * sc) }));
      }
      for (let i = 1; i <= 4; i++) {
        const sc = [1, 0.72, 0.45, 0.22][i - 1]!;
        rows.set(`${team}_wr${i}`, seasonRow({ player_id: `${team}_wr${i}`, season, position: "WR", targets: Math.round(150 * sc), rec: Math.round(100 * sc), rec_yd: Math.round(1350 * sc), rec_td: Math.round(9 * sc), rec_rz_tgt: Math.round(18 * sc), pts_ppr: Math.round(260 * sc) }));
      }
      rows.set(`${team}_te`, seasonRow({ player_id: `${team}_te`, season, position: "TE", targets: 82, rec: 58, rec_yd: 640, rec_td: 5, rec_rz_tgt: 11, pts_ppr: 140 }));
      team_totals.set(team, teamTotal());
    }
    return { season, players: rows, team_totals };
  });
  return { playerIndex, seasons };
}
function teamTotal() {
  return { pass_att: 590, rush_att: 430, targets: 555, pass_td: 30, rush_td: 15, rec_td: 30, plays: 1020, authoritative: true };
}

const PPR: Record<string, number> = {
  pass_yd: 0.04, pass_td: 4, pass_int: -1, rush_yd: 0.1, rush_td: 6, rec: 1, rec_yd: 0.1, rec_td: 6, fum_lost: -2,
};
const HALF_PPR = { ...PPR, rec: 0.5 };

/* ------------------------------------------------------------- §conservation */

describe("team-volume conservation is preserved under v2", () => {
  it("reconciliation has zero HARD/SOFT residual on the fixture universe (v2)", async () => {
    clearProjectionCaches();
    const base = await buildBaseProjections({
      season: 2026, skipBenchmark: true,
      fixtures: fixtureUniverse(),
    });
    assert.equal(base.reconciliation.hard_misses.length, 0, JSON.stringify(base.reconciliation.hard_misses));
    assert.equal(base.reconciliation.soft_misses.length, 0, JSON.stringify(base.reconciliation.soft_misses));
    assert.ok(base.reconciliation.ok_count > 0);
  });
});

/* ------------------------------------------------------------- §layer invariance */

describe("Layer 1 stays league-scoring-neutral under v2", () => {
  it("the same player's football projection is identical across two leagues", async () => {
    clearProjectionCaches();
    const base = await buildBaseProjections({ season: 2026, skipBenchmark: true, fixtures: fixtureUniverse() });
    const a = buildLeagueProjections(base, { league_slug: "bloodline", league_id: "L1", scoring_settings: PPR, roster_positions: ROSTER_POS, num_teams: 10 });
    const b = buildLeagueProjections(base, { league_slug: "devoted", league_id: "L2", scoring_settings: HALF_PPR, roster_positions: ROSTER_POS, num_teams: 12 });
    for (const pid of ["KC_wr1", "BUF_rb1", "SF_qb", "DAL_te"]) {
      const p1 = base.projections.get(pid)!;
      // Layer 1 object is shared — league scoring only reads it.
      assert.ok(p1.neutral_points > 0);
      const la = a.projections.find((x) => x.player_id === pid)!;
      const lb = b.projections.find((x) => x.player_id === pid)!;
      // half-PPR scores a pass-catcher below full PPR, but the same Layer-1 input.
      assert.ok(la.league_points > 0 && lb.league_points > 0);
      if ((p1.stats.rec ?? 0) > 0) assert.ok(lb.league_points < la.league_points, `${pid}`);
    }
  });
});

/* ------------------------------------------------------------- §Sleeper independence */

describe("RI_STANDALONE is independent of the Sleeper benchmark under v2", () => {
  it("football projections are byte-identical with the benchmark on vs off", async () => {
    const fx = fixtureUniverse();
    const emptyBench = {
      provider: "sleeper" as const, status: "OK" as const, company: null, season: 2026,
      scope: "season" as const, week: null, players_returned: 0, players_usable: 0,
      coverage_by_position: {}, source_updated_at_range: [null, null] as [null, null],
      retrieved_at: "2026-08-01T00:00:00Z", source_schema_version: "x", missing_expected_keys: [],
      warnings: [], projections: new Map(),
    };
    clearProjectionCaches();
    const off = await buildBaseProjections({ season: 2026, skipBenchmark: true, fixtures: fx });
    clearProjectionCaches();
    const on = await buildBaseProjections({ season: 2026, fixtures: { ...fx, benchmark: emptyBench } });

    for (const [pid, p] of off.projections) {
      const q = on.projections.get(pid)!;
      assert.equal(q.neutral_points, p.neutral_points, `${pid} neutral_points`);
      assert.deepEqual(q.stats, p.stats, `${pid} stats`);
      assert.equal(q.availability.expected_games, p.availability.expected_games, `${pid} games`);
    }
  });
});
