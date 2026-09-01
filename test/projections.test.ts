/**
 * Deterministic projection-engine tests. No network — everything runs off
 * hand-built fixtures so the layered architecture, scoring translation,
 * replacement/VOR, reconciliation, uncertainty and RI-vs-Sleeper comparison are
 * all provable in isolation.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { NormalizedPlayer } from "@/lib/sleeper/types";
import type { SeasonActuals, PlayerSeasonActual } from "@/lib/projections/actuals";
import { buildBaseProjections, buildLeagueProjections, buildManagerView, clearProjectionCaches } from "@/lib/projections/build";
import { statLineFromProjection, translateStatsToLeague, leagueScoringContext } from "@/lib/projections/league";
import { analyticBand, confidenceBucket } from "@/lib/projections/uncertainty";
import { comparePlayer } from "@/lib/projections/compare";
import { projectCoreForSeason, scoreBacktest, buildBacktestRows, SLEEPER_HISTORICAL_BENCHMARK_STATUS } from "@/lib/projections/backtest";
import type { SleeperProjectionSource } from "@/lib/projections/sleeper";
import { PROJECTION_SCHEMA_VERSION } from "@/lib/projections/schema";

/* --------------------------------------------------------------- fixtures */

function player(p: Partial<NormalizedPlayer> & { player_id: string }): NormalizedPlayer {
  return {
    player_id: p.player_id,
    full_name: p.full_name ?? p.player_id,
    first_name: null,
    last_name: null,
    position: p.position ?? "WR",
    fantasy_positions: [p.position ?? "WR"],
    team: p.team ?? "AAA",
    age: p.age ?? 26,
    years_exp: p.years_exp ?? 4,
    status: null,
    injury_status: p.injury_status ?? null,
    number: null,
    active: true,
    search_rank: p.search_rank ?? 50,
    depth_chart_order: p.depth_chart_order ?? 1,
    depth_chart_position: p.depth_chart_position ?? null,
    resolved: true,
  };
}

function seasonRow(o: Partial<PlayerSeasonActual> & { player_id: string; season: number }): PlayerSeasonActual {
  return {
    player_id: o.player_id, season: o.season, position: o.position ?? "WR", team: o.team ?? "AAA",
    gp: o.gp ?? 17, gs: o.gs ?? 17, off_snp: o.off_snp ?? 900, tm_off_snp: o.tm_off_snp ?? 1000,
    snap_share: o.snap_share ?? 0.9,
    pass_att: o.pass_att ?? 0, pass_cmp: o.pass_cmp ?? 0, pass_yd: o.pass_yd ?? 0, pass_td: o.pass_td ?? 0,
    pass_int: o.pass_int ?? 0, pass_rz_att: o.pass_rz_att ?? 0,
    rush_att: o.rush_att ?? 0, rush_yd: o.rush_yd ?? 0, rush_td: o.rush_td ?? 0, rush_rz_att: o.rush_rz_att ?? 0, g2g_att: o.g2g_att ?? 0,
    targets: o.targets ?? 0, rec: o.rec ?? 0, rec_yd: o.rec_yd ?? 0, rec_td: o.rec_td ?? 0, rec_air_yd: o.rec_air_yd ?? 0, rec_rz_tgt: o.rec_rz_tgt ?? 0,
    fum_lost: o.fum_lost ?? 0,
    fgm: o.fgm ?? 0, fga: o.fga ?? 0, fgm_yds: o.fgm_yds ?? 0, xpm: o.xpm ?? 0, xpa: o.xpa ?? 0,
    def_sack: 0, def_int: 0, def_fum_rec: 0, def_td: 0, def_safety: 0,
    pts_ppr: o.pts_ppr ?? 0,
  };
}

const PLAYERS: NormalizedPlayer[] = [
  player({ player_id: "qb1", full_name: "Test QB", position: "QB", team: "AAA", depth_chart_order: 1 }),
  player({ player_id: "qb2", full_name: "Backup QB", position: "QB", team: "AAA", depth_chart_order: 2, search_rank: 400 }),
  player({ player_id: "rb1", full_name: "Lead RB", position: "RB", team: "AAA", depth_chart_order: 1 }),
  player({ player_id: "rb2", full_name: "Backup RB", position: "RB", team: "AAA", depth_chart_order: 2 }),
  player({ player_id: "wr1", full_name: "Alpha WR", position: "WR", team: "AAA", depth_chart_order: 1 }),
  player({ player_id: "wr2", full_name: "Slot WR", position: "WR", team: "AAA", depth_chart_order: 2 }),
  player({ player_id: "te1", full_name: "Starting TE", position: "TE", team: "AAA", depth_chart_order: 1 }),
  player({ player_id: "rook_wr", full_name: "Rookie WR", position: "WR", team: "AAA", depth_chart_order: 3, years_exp: 0, age: 22 }),
];

// Filler depth on other teams so replacement/VOR pools are not degenerate.
const FILLER_TEAMS = ["BBB", "CCC", "DDD", "EEE"];
for (const team of FILLER_TEAMS) {
  PLAYERS.push(player({ player_id: `${team}_qb`, position: "QB", team, depth_chart_order: 1 }));
  for (let i = 1; i <= 3; i++) PLAYERS.push(player({ player_id: `${team}_rb${i}`, position: "RB", team, depth_chart_order: i }));
  for (let i = 1; i <= 4; i++) PLAYERS.push(player({ player_id: `${team}_wr${i}`, position: "WR", team, depth_chart_order: i }));
  PLAYERS.push(player({ player_id: `${team}_te`, position: "TE", team, depth_chart_order: 1 }));
}

const PLAYER_INDEX = new Map(PLAYERS.map((p) => [p.player_id, p]));

function seasonsFixture(): SeasonActuals[] {
  const years = [2023, 2024, 2025];
  return years.map((season) => {
    const players = new Map<string, PlayerSeasonActual>();
    players.set("qb1", seasonRow({ player_id: "qb1", season, position: "QB", pass_att: 560, pass_cmp: 370, pass_yd: 4200, pass_td: 30, pass_int: 10, pass_rz_att: 70, rush_att: 55, rush_yd: 300, rush_td: 3, rush_rz_att: 12, pts_ppr: 360 }));
    players.set("rb1", seasonRow({ player_id: "rb1", season, position: "RB", rush_att: 260, rush_yd: 1200, rush_td: 10, rush_rz_att: 45, targets: 60, rec: 48, rec_yd: 380, rec_td: 2, rec_rz_tgt: 6, pts_ppr: 270 }));
    players.set("rb2", seasonRow({ player_id: "rb2", season, position: "RB", rush_att: 90, rush_yd: 400, rush_td: 3, rush_rz_att: 12, targets: 25, rec: 20, rec_yd: 150, pts_ppr: 95 }));
    players.set("wr1", seasonRow({ player_id: "wr1", season, position: "WR", targets: 150, rec: 100, rec_yd: 1400, rec_td: 9, rec_rz_tgt: 20, pts_ppr: 290 }));
    players.set("wr2", seasonRow({ player_id: "wr2", season, position: "WR", targets: 95, rec: 65, rec_yd: 720, rec_td: 4, rec_rz_tgt: 9, pts_ppr: 150 }));
    players.set("te1", seasonRow({ player_id: "te1", season, position: "TE", targets: 80, rec: 58, rec_yd: 620, rec_td: 5, rec_rz_tgt: 11, pts_ppr: 140 }));
    const team_totals = new Map([["AAA", {
      pass_att: 590, rush_att: 430, targets: 555, pass_td: 32, rush_td: 16, rec_td: 32, plays: 1020, authoritative: true,
    }]]);
    for (const team of FILLER_TEAMS) {
      players.set(`${team}_qb`, seasonRow({ player_id: `${team}_qb`, season, position: "QB", pass_att: 540, pass_cmp: 350, pass_yd: 3900, pass_td: 24, pass_int: 12, pass_rz_att: 60, rush_att: 30, rush_yd: 120, rush_td: 2, rush_rz_att: 6, pts_ppr: 270 }));
      for (let i = 1; i <= 3; i++) {
        const scale = i === 1 ? 1 : i === 2 ? 0.5 : 0.2;
        players.set(`${team}_rb${i}`, seasonRow({ player_id: `${team}_rb${i}`, season, position: "RB", rush_att: Math.round(230 * scale), rush_yd: Math.round(1000 * scale), rush_td: Math.round(8 * scale), rush_rz_att: Math.round(40 * scale), targets: Math.round(50 * scale), rec: Math.round(38 * scale), rec_yd: Math.round(300 * scale), rec_rz_tgt: Math.round(5 * scale), pts_ppr: Math.round(230 * scale) }));
      }
      for (let i = 1; i <= 4; i++) {
        const scale = [1, 0.72, 0.45, 0.22][i - 1]!;
        players.set(`${team}_wr${i}`, seasonRow({ player_id: `${team}_wr${i}`, season, position: "WR", targets: Math.round(140 * scale), rec: Math.round(92 * scale), rec_yd: Math.round(1200 * scale), rec_td: Math.round(8 * scale), rec_rz_tgt: Math.round(16 * scale), pts_ppr: Math.round(250 * scale) }));
      }
      players.set(`${team}_te`, seasonRow({ player_id: `${team}_te`, season, position: "TE", targets: 75, rec: 52, rec_yd: 560, rec_td: 4, rec_rz_tgt: 9, pts_ppr: 120 }));
      team_totals.set(team, { pass_att: 560, rush_att: 420, targets: 528, pass_td: 26, rush_td: 13, rec_td: 26, plays: 980, authoritative: true });
    }
    return { season, players, team_totals };
  });
}

function benchStats(o: Record<string, number>) {
  const keys = ["gp", "pass_att", "pass_cmp", "pass_yd", "pass_td", "pass_int", "pass_2pt", "rush_att", "rush_yd", "rush_td", "rush_2pt", "targets", "rec", "rec_yd", "rec_td", "rec_2pt", "fum_lost", "fgm_40_49", "fgm_50p", "fgm_yds", "fgmiss_40_49", "fgmiss_50p", "xpm", "xpmiss", "def_sack", "def_int", "def_fum_rec", "def_td", "def_blk_kick"] as const;
  const out = {} as Record<(typeof keys)[number], number | null>;
  for (const k of keys) out[k] = k in o ? o[k]! : null;
  return out;
}

const SLEEPER_BENCH: SleeperProjectionSource = {
  provider: "sleeper", status: "OK", company: "rotowire", season: 2026, scope: "season", week: null,
  players_returned: 3, players_usable: 3,
  coverage_by_position: { WR: 1 }, source_updated_at_range: ["2026-08-01T00:00:00Z", "2026-08-02T00:00:00Z"],
  retrieved_at: "2026-08-15T00:00:00Z", source_schema_version: "keys:100", missing_expected_keys: [], warnings: [],
  projections: new Map([
    ["wr1", {
      player_id: "wr1", full_name: "Alpha WR", position: "WR", team: "AAA", years_exp: 4, is_rookie: false, injury_status: null,
      sleeper_points: { std: 180, half_ppr: 230, ppr: 280 },
      stats: benchStats({ gp: 17, rush_att: 2, rush_yd: 12, rush_td: 0, targets: 160, rec: 108, rec_yd: 1500, rec_td: 10, fum_lost: 1 }),
      raw_stat_keys: [], source_updated_at: "2026-08-01T00:00:00Z",
    }],
  ]),
};

async function buildFixtureBase() {
  clearProjectionCaches();
  return buildBaseProjections({
    season: 2026,
    fixtures: { playerIndex: PLAYER_INDEX, seasons: seasonsFixture(), benchmark: SLEEPER_BENCH },
  });
}

const PPR: Record<string, number> = {
  pass_yd: 0.04, pass_td: 4, pass_int: -1, rush_yd: 0.1, rush_td: 6, rec: 1, rec_yd: 0.1, rec_td: 6, fum_lost: -2,
};
const HALF_PPR = { ...PPR, rec: 0.5 };

/* ------------------------------------------------------------------ tests */

describe("projection schema + base build", () => {
  it("produces a projection per active skill player with the current schema version", async () => {
    const base = await buildFixtureBase();
    assert.equal(base.schema_version, PROJECTION_SCHEMA_VERSION);
    for (const id of ["qb1", "rb1", "wr1", "te1"]) {
      const p = base.projections.get(id);
      assert.ok(p, `missing projection for ${id}`);
      assert.equal(p.schema_version, PROJECTION_SCHEMA_VERSION);
      assert.ok(p.neutral_points > 0);
      assert.ok(p.outcome.floor <= p.outcome.median && p.outcome.median <= p.outcome.ceiling);
      assert.ok(p.availability.expected_games > 0 && p.availability.expected_games <= 17);
    }
  });

  it("gives the starting QB far more pass volume than the backup", async () => {
    const base = await buildFixtureBase();
    const starter = base.projections.get("qb1")!;
    const backup = base.projections.get("qb2")!;
    assert.ok((starter.stats.pass_att ?? 0) > 400);
    assert.ok((backup.stats.pass_att ?? 0) < (starter.stats.pass_att ?? 0) * 0.3);
  });

  it("keeps summed team volume within reconciliation tolerance after normalization", async () => {
    const base = await buildFixtureBase();
    assert.equal(base.reconciliation.hard_misses.length, 0, JSON.stringify(base.reconciliation.hard_misses));
  });

  it("treats Sleeper strictly as a benchmark (role BENCHMARK_ONLY)", async () => {
    const base = await buildFixtureBase();
    assert.equal(base.benchmark.role, "BENCHMARK_ONLY");
    assert.equal(base.benchmark.status, "OK");
    assert.ok(base.benchmark.players_matched >= 1);
  });

  it("degrades without crashing when the benchmark is unavailable", async () => {
    clearProjectionCaches();
    const base = await buildBaseProjections({
      season: 2026, skipBenchmark: true,
      fixtures: { playerIndex: PLAYER_INDEX, seasons: seasonsFixture() },
    });
    assert.equal(base.benchmark.status, "UNAVAILABLE");
    assert.ok(base.projections.get("wr1")!.neutral_points > 0);
    assert.ok(base.warnings.some((w) => /benchmark/i.test(w)));
  });
});

describe("Layer 2 — league scoring translation", () => {
  const ctxPPR = leagueScoringContext("full-ppr", "L1", PPR);

  it("routes a projected stat line through the shared scoring engine", () => {
    const proj = { stats: { ...emptyStats(), rec: 100, rec_yd: 1400, rec_td: 9 }, position: "WR" as const, availability: { games_if_healthy: 17, expected_games: 17, availability_probability: 1, note: null } };
    const r = translateStatsToLeague(proj, ctxPPR);
    // 100*1 + 1400*0.1 + 9*6 = 294
    assert.equal(r.league_points, 294);
  });

  it("scores fewer points in a half-PPR league than full PPR for the same player", async () => {
    const base = await buildFixtureBase();
    const full = buildLeagueProjections(base, { league_slug: "full-ppr", league_id: "L1", scoring_settings: PPR, roster_positions: ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "BN", "BN"], num_teams: 10 });
    const half = buildLeagueProjections(base, { league_slug: "half-ppr", league_id: "L2", scoring_settings: HALF_PPR, roster_positions: ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "BN", "BN"], num_teams: 10 });
    const wrFull = full.projections.find((p) => p.player_id === "wr1")!;
    const wrHalf = half.projections.find((p) => p.player_id === "wr1")!;
    assert.ok(wrHalf.league_points < wrFull.league_points);
    assert.notEqual(full.scoring_hash, half.scoring_hash);
  });

  it("derives replacement level + VOR from the actual lineup config, not hard-coded ranks", async () => {
    const base = await buildFixtureBase();
    const shallow = buildLeagueProjections(base, { league_slug: "a", league_id: "A", scoring_settings: PPR, roster_positions: ["QB", "RB", "WR", "TE", "BN"], num_teams: 8 });
    const deep = buildLeagueProjections(base, { league_slug: "b", league_id: "B", scoring_settings: PPR, roster_positions: ["QB", "RB", "RB", "WR", "WR", "WR", "TE", "FLEX", "FLEX", "BN"], num_teams: 14 });
    assert.notEqual(
      shallow.replacement_levels.replacement_rank.RB,
      deep.replacement_levels.replacement_rank.RB,
    );
    assert.ok(deep.replacement_levels.replacement_rank.RB > shallow.replacement_levels.replacement_rank.RB);
  });

  it("ranks players by VOR with monotonic tiers", async () => {
    const base = await buildFixtureBase();
    const lg = buildLeagueProjections(base, { league_slug: "a", league_id: "A", scoring_settings: PPR, roster_positions: ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "BN"], num_teams: 10 });
    const wrs = lg.projections.filter((p) => p.position === "WR").sort((a, b) => a.position_rank! - b.position_rank!);
    for (let i = 1; i < wrs.length; i++) {
      assert.ok(wrs[i]!.league_points <= wrs[i - 1]!.league_points);
      assert.ok(wrs[i]!.tier! >= wrs[i - 1]!.tier!);
    }
  });
});

describe("Layer separation — two managers, one league", () => {
  it("gives two managers in the same league identical league_points, different contextual_value", async () => {
    const base = await buildFixtureBase();
    const league = buildLeagueProjections(base, { league_slug: "shared", league_id: "SHARED", scoring_settings: PPR, roster_positions: ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "BN", "BN"], num_teams: 10 });

    const posByPlayer = new Map(PLAYERS.map((p) => [p.player_id, p.position as "QB" | "RB" | "WR" | "TE"]));
    const mgrA = buildManagerView(base, league, {
      league_id: "SHARED", sleeper_user_id: "userA", roster_id: 1, draft_id: "d1", draft_state: "drafting",
      owned_player_ids: ["qb1", "rb1", "rb2", "BBB_rb1"], roster_positions: ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "BN", "BN"],
      position_by_player: new Map(PLAYERS.map((p) => [p.player_id, p.position as "QB" | "RB" | "WR" | "TE"])),
    });
    const mgrB = buildManagerView(base, league, {
      league_id: "SHARED", sleeper_user_id: "userB", roster_id: 2, draft_id: "d1", draft_state: "drafting",
      owned_player_ids: ["wr1", "wr2", "te1"], roster_positions: ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "BN", "BN"],
      position_by_player: posByPlayer,
    });

    const lpRb2Before = league.projections.find((p) => p.player_id === "rb2")!.league_points;
    assert.ok(lpRb2Before > 0);

    assert.notEqual(mgrA.cache_key, mgrB.cache_key);
    const aRb2 = mgrA.values.find((v) => v.player_id === "rb2")!;
    const bRb2 = mgrB.values.find((v) => v.player_id === "rb2")!;
    assert.equal(aRb2.used_sleeper_user_id, "userA");
    assert.equal(bRb2.used_sleeper_user_id, "userB");
    // Layer 3 differs: manager A already rosters an RB stud, manager B has none.
    assert.ok(bRb2.need_multiplier > aRb2.need_multiplier);
    assert.notEqual(aRb2.contextual_value, bRb2.contextual_value);
    // Layer 2 is untouched by either manager view.
    assert.equal(league.projections.find((p) => p.player_id === "rb2")!.league_points, lpRb2Before);
  });
});

describe("uncertainty", () => {
  it("widens the band for a rookie vs an established player at the same median", () => {
    const vet = analyticBand({ position: "WR", median: 200, is_rookie: false, snap_share: 0.85, td_points: 40, expected_games: 17, games_if_healthy: 17 });
    const rook = analyticBand({ position: "WR", median: 200, is_rookie: true, snap_share: 0.5, td_points: 40, expected_games: 17, games_if_healthy: 17 });
    assert.ok(rook.ceiling - rook.floor > vet.ceiling - vet.floor);
  });

  it("lowers confidence for rookies and thin samples", () => {
    const strong = confidenceBucket({ position: "WR", sample_seasons: 4, effective_sample: 40, is_rookie: false, team_changed: false, injury_flagged: false, snap_share: 0.9, role_locked: true });
    const weak = confidenceBucket({ position: "WR", sample_seasons: 0, effective_sample: 0, is_rookie: true, team_changed: false, injury_flagged: false, snap_share: 0.3, role_locked: false });
    assert.ok(strong.score > weak.score);
    assert.equal(weak.bucket === "LOW" || weak.bucket === "VERY_LOW", true);
  });
});

describe("RI vs Sleeper comparison", () => {
  it("flags direction + a deterministic opportunity/efficiency/TD driver", async () => {
    const base = await buildFixtureBase();
    const wr1 = base.projections.get("wr1")!;
    const c = comparePlayer(wr1, SLEEPER_BENCH.projections.get("wr1"));
    assert.equal(c.has_benchmark, true);
    assert.ok(["RI_ABOVE", "RI_BELOW", "AGREES"].includes(c.direction));
    assert.ok(c.stat_deltas.some((d) => d.stat === "targets"));
    assert.match(c.primary_driver, /Sleeper|agrees/);
  });

  it("returns NO_BENCHMARK cleanly when Sleeper has no row", async () => {
    const base = await buildFixtureBase();
    const c = comparePlayer(base.projections.get("te1")!, undefined);
    assert.equal(c.direction, "NO_BENCHMARK");
    assert.equal(c.disagreement, 0);
  });
});

describe("backtest (fair, out-of-sample)", () => {
  it("projects a season using only prior years", () => {
    const prior = [2022, 2023, 2024].map((season) => seasonRow({ player_id: "wr1", season, position: "WR", targets: 140, rec: 95, rec_yd: 1300, rec_td: 8, rec_rz_tgt: 18, gp: 17, pts_ppr: 270 }));
    const core = projectCoreForSeason("wr1", "WR", 26, prior, 2025);
    assert.ok(core && core.predicted_points > 150 && core.predicted_points < 380);
  });

  it("scores RI core against baselines and marks the Sleeper historical benchmark UNAVAILABLE", () => {
    const byYear = new Map<number, SeasonActuals>();
    for (const s of [2021, 2022, 2023, 2024, 2025]) {
      const players = new Map<string, PlayerSeasonActual>();
      players.set("wr1", seasonRow({ player_id: "wr1", season: s, position: "WR", targets: 150, rec: 100, rec_yd: 1350 + (s - 2023) * 20, rec_td: 8, rec_rz_tgt: 18, pts_ppr: 260 + (s - 2023) * 5 }));
      byYear.set(s, { season: s, players, team_totals: new Map() });
    }
    const rows = buildBacktestRows(byYear, new Map([["wr1", { position: "WR", age: 27 }]]), [2024, 2025]);
    assert.ok(rows.length >= 2);
    const scored = scoreBacktest(rows);
    assert.equal(scored.sleeper_historical, SLEEPER_HISTORICAL_BENCHMARK_STATUS);
    assert.ok(scored.metrics.find((m) => m.method === "RI_core"));
  });
});

describe("stat line construction", () => {
  it("expands a DEF projection into Sleeper points-allowed tier keys", () => {
    const line = statLineFromProjection({
      stats: { ...emptyStats(), def_sack: 40, def_int: 14, def_pts_allowed_per_game: 19 },
      position: "DEF",
      availability: { games_if_healthy: 17, expected_games: 17, availability_probability: 1, note: null },
    });
    assert.ok("sack" in line && "int" in line);
    const tierKeys = Object.keys(line).filter((k) => k.startsWith("pts_allow_"));
    assert.ok(tierKeys.length >= 5);
    const tierSum = tierKeys.reduce((a, k) => a + line[k]!, 0);
    assert.ok(Math.abs(tierSum - 17) < 0.5, `tier games should sum to ~17, got ${tierSum}`);
  });
});

function emptyStats() {
  return {
    pass_att: null, pass_cmp: null, cmp_pct: null, pass_yd: null, pass_ypa: null, pass_td: null, pass_int: null, pass_2pt: null,
    rush_att: null, rush_yd: null, rush_ypa: null, rush_td: null, rush_2pt: null,
    targets: null, rec: null, catch_rate: null, rec_yd: null, yprr: null, yptarget: null, rec_td: null, rec_2pt: null,
    fum_lost: null, fg_att: null, fg_made: null, fg_made_0_39: null, fg_made_40_49: null, fg_made_50p: null, fg_miss: null, xp_made: null, xp_miss: null,
    def_sack: null, def_int: null, def_fum_rec: null, def_td: null, def_safety: null, def_pts_allowed_per_game: null,
  };
}
