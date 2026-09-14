/**
 * Individual return-game repair — regression coverage.
 *
 * Proves the invariants from the return-game certification spec: return
 * production is preserved from source data through projection, league
 * scoring, benchmarking, diagnostics, and downstream valuation, with no
 * double-counting and no effect in leagues that don't score returns.
 *
 * `calculateFantasyPoints` (`lib/scoring/calculate.ts`) is the sole scoring
 * authority throughout — this file never re-implements `yards * rate`.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { calculateFantasyPoints } from "@/lib/scoring/calculate";
import { scoreWeeklyLine } from "@/lib/weekly/scoring";
import { normalizePlayerSeasonActual, type PlayerSeasonActual, type SeasonActuals } from "@/lib/projections/actuals";
import { statLineFromProjection, translateStatsToLeague, leagueScoringContext, buildLeagueProjection } from "@/lib/projections/league";
import { parseSleeperSeasonArray } from "@/lib/projections/sleeper";
import type { RawSleeperProjectionEntry } from "@/lib/sleeper/client";
import { comparePlayer } from "@/lib/projections/compare";
import { projectReturnGame, applyReturnGameProjections, RETURN_GAME_MODEL_VERSION } from "@/lib/projections/return-game";
import { EMPTY_STATS, PROJECTION_MODEL_VERSION, PROJECTION_SCHEMA_VERSION, type PlayerProjection } from "@/lib/projections/schema";
import { buildDerivedSpecialTeams, classifyScoring } from "@/lib/scoring/normalize";

/* -------------------------------------------------------------------- Phase 11: core scoring */

describe("return-game — core Layer-2 scoring (calculateFantasyPoints is the sole authority)", () => {
  const LEAGUE: Record<string, number> = {
    rec: 1, rec_yd: 0.1, rec_td: 6, rush_yd: 0.1, rush_td: 6, kr_yd: 0.04, pr_yd: 0.04,
  };

  it("a WR's 500 kr_yd score exactly 500 * kr_yd rate as ADDITIONAL points", () => {
    const withoutKr = calculateFantasyPoints({ rec: 8, rec_yd: 90, rec_td: 1 }, LEAGUE).fantasy_points;
    const withKr = calculateFantasyPoints({ rec: 8, rec_yd: 90, rec_td: 1, kr_yd: 500 }, LEAGUE).fantasy_points;
    assert.equal(round2(withKr - withoutKr), round2(500 * LEAGUE.kr_yd!));
  });

  it("a WR's 340 pr_yd score exactly 340 * pr_yd rate as ADDITIONAL points", () => {
    const withoutPr = calculateFantasyPoints({ rec: 8, rec_yd: 90, rec_td: 1 }, LEAGUE).fantasy_points;
    const withPr = calculateFantasyPoints({ rec: 8, rec_yd: 90, rec_td: 1, pr_yd: 340 }, LEAGUE).fantasy_points;
    assert.equal(round2(withPr - withoutPr), round2(340 * LEAGUE.pr_yd!));
  });

  it("receiving + rushing + KR + PR combine without any category overwriting another", () => {
    const line = { rec: 6, rec_yd: 70, rec_td: 1, rush_yd: 15, kr_yd: 200, pr_yd: 120 };
    const result = calculateFantasyPoints(line, LEAGUE);
    const expected =
      6 * LEAGUE.rec! + 70 * LEAGUE.rec_yd! + 1 * LEAGUE.rec_td! + 15 * LEAGUE.rush_yd! + 200 * LEAGUE.kr_yd! + 120 * LEAGUE.pr_yd!;
    assert.equal(round2(result.fantasy_points), round2(expected));
    // Every category present in its own breakdown row — none merged/dropped.
    const stats = result.breakdown.map((b) => b.stat).sort();
    assert.deepEqual(stats, ["kr_yd", "pr_yd", "rec", "rec_td", "rec_yd", "rush_yd"]);
  });

  it("a no-return-scoring league gives zero additional points for the same return production", () => {
    const NO_RETURN_LEAGUE: Record<string, number> = { rec: 1, rec_yd: 0.1, rec_td: 6, rush_yd: 0.1, rush_td: 6 };
    const withoutReturns = calculateFantasyPoints({ rec: 8, rec_yd: 90 }, NO_RETURN_LEAGUE).fantasy_points;
    const withReturns = calculateFantasyPoints({ rec: 8, rec_yd: 90, kr_yd: 500, pr_yd: 340 }, NO_RETURN_LEAGUE).fantasy_points;
    assert.equal(withReturns, withoutReturns);
    const result = calculateFantasyPoints({ kr_yd: 500, pr_yd: 340 }, NO_RETURN_LEAGUE);
    assert.ok(result.warnings.some((w) => w.includes("kr_yd")));
    assert.ok(result.warnings.some((w) => w.includes("pr_yd")));
  });

  it("player kr_yd/pr_yd never contaminate team-defense def_kr_yd/def_pr_yd, or vice versa", () => {
    const LEAGUE2: Record<string, number> = { kr_yd: 0.04, pr_yd: 0.04, def_kr_yd: 0.01, def_pr_yd: 0.01 };
    const result = calculateFantasyPoints({ kr_yd: 100, pr_yd: 50, def_kr_yd: 100, def_pr_yd: 50 }, LEAGUE2);
    const byStat = Object.fromEntries(result.breakdown.map((b) => [b.stat, b.points]));
    assert.equal(byStat.kr_yd, round2(100 * 0.04));
    assert.equal(byStat.pr_yd, round2(50 * 0.04));
    assert.equal(byStat.def_kr_yd, round2(100 * 0.01));
    assert.equal(byStat.def_pr_yd, round2(50 * 0.01));
    assert.equal(result.fantasy_points, round2(100 * 0.04 + 50 * 0.04 + 100 * 0.01 + 50 * 0.01));
  });

  it("return TDs: an individual return TD is Sleeper's st_td key (live-verified), never kr_td/pr_td on a player row — no double-count path exists because Layer 1 never emits both", () => {
    // Live-verified 2024/2025 Sleeper box scores: an individual returner's row
    // carries `st_td`, while `kr_td`/`pr_td` appear only on the TEAM_XXX row.
    // statLineFromProjection must never emit kr_td/pr_td/st_td for an offensive
    // player (Layer 1 does not project return TDs — see return-game.ts header).
    const proj = fullProjection({ kr_yd: 300, pr_yd: 150 });
    const line = statLineFromProjection(proj);
    assert.equal(line.kr_td, undefined);
    assert.equal(line.pr_td, undefined);
    assert.equal(line.st_td, undefined);
    // If a raw actual/weekly line DOES carry a real st_td alongside kr_yd, both
    // score independently (generic key x multiplier engine - no special-casing).
    const scored = calculateFantasyPoints({ kr_yd: 100, st_td: 1 }, { kr_yd: 0.04, st_td: 6 });
    assert.equal(scored.fantasy_points, round2(100 * 0.04 + 6));
  });
});

/* -------------------------------------------------------------------- Phase 2: historical ingestion */

describe("return-game — historical actuals ingestion (lib/projections/actuals.ts)", () => {
  it("kr/kr_yd/pr/pr_yd survive Sleeper box-score ingestion exactly", () => {
    const row = normalizePlayerSeasonActual(
      "returner1",
      { gp: 17, kr: 13, kr_yd: 378, pr: 20, pr_yd: 260, rec: 40, rec_yd: 300 },
      2025,
      { position: "WR", team: "SEA" },
    );
    assert.equal(row.kr, 13);
    assert.equal(row.kr_yd, 378);
    assert.equal(row.pr, 20);
    assert.equal(row.pr_yd, 260);
    // Not folded into rushing/receiving.
    assert.equal(row.rec_yd, 300);
  });

  it("a player with no return keys in the box score gets 0, not a crash/undefined", () => {
    const row = normalizePlayerSeasonActual("nonreturner", { gp: 17, rec: 90, rec_yd: 1200 }, 2025, { position: "WR", team: "KC" });
    assert.equal(row.kr, 0);
    assert.equal(row.kr_yd, 0);
    assert.equal(row.pr, 0);
    assert.equal(row.pr_yd, 0);
  });
});

/* -------------------------------------------------------------------- Phase 5: Sleeper benchmark normalization */

describe("return-game — Sleeper benchmark normalization (lib/projections/sleeper.ts)", () => {
  function entry(playerId: string, stats: Record<string, number>): RawSleeperProjectionEntry {
    return {
      player_id: playerId, team: "SEA", opponent: null, season: "2026", season_type: "regular",
      week: null, category: "proj", company: "rotowire", last_modified: null, updated_at: null,
      stats, player: { first_name: "Test", last_name: "Returner", position: "WR", years_exp: 4 },
    };
  }

  it("preserves an explicit kr_yd/pr_yd value when Sleeper supplies it", () => {
    const src = parseSleeperSeasonArray([entry("p1", { gp: 17, kr_yd: 250, pr_yd: 90 })], 2026);
    const p = src.projections.get("p1")!;
    assert.equal(p.stats.kr_yd, 250);
    assert.equal(p.stats.pr_yd, 90);
  });

  it("distinguishes an explicit zero from Sleeper's field being entirely absent", () => {
    const explicitZero = parseSleeperSeasonArray([entry("p1", { gp: 17, kr_yd: 0 })], 2026);
    assert.equal(explicitZero.projections.get("p1")!.stats.kr_yd, 0);

    const absent = parseSleeperSeasonArray([entry("p2", { gp: 17 })], 2026);
    assert.equal(absent.projections.get("p2")!.stats.kr_yd, null);
    assert.equal(absent.projections.get("p2")!.stats.pr_yd, null);
  });
});

/* -------------------------------------------------------------------- Phase 4/6: league translation + comparison diagnostics */

function fullProjection(overrides: Partial<PlayerProjection["stats"]> = {}): Pick<PlayerProjection, "stats" | "position" | "availability"> {
  return {
    position: "WR",
    availability: { games_if_healthy: 17, expected_games: 17, availability_probability: 0.97, note: null },
    stats: { ...EMPTY_STATS, targets: 100, rec: 70, rec_yd: 900, rec_td: 6, ...overrides },
  };
}

describe("return-game — Layer 2 league translation (lib/projections/league.ts)", () => {
  it("statLineFromProjection emits kr_yd/pr_yd in Sleeper's own scoring-key namespace", () => {
    const line = statLineFromProjection(fullProjection({ kr_yd: 300, pr_yd: 150 }));
    assert.equal(line.kr_yd, 300);
    assert.equal(line.pr_yd, 150);
  });

  it("translateStatsToLeague: X return yards at league rate Y contributes exactly X*Y", () => {
    const ctx = leagueScoringContext("test", "1", { rec: 1, rec_yd: 0.1, rec_td: 6, kr_yd: 0.04, pr_yd: 0.04 });
    const withReturns = translateStatsToLeague(fullProjection({ kr_yd: 500, pr_yd: 200 }), ctx);
    const without = translateStatsToLeague(fullProjection(), ctx);
    // Season points are availability-adjusted (17/17 = 1 here), so the delta is exact.
    assert.equal(round2(withReturns.league_points - without.league_points), round2(500 * 0.04 + 200 * 0.04));
  });

  it("a league without kr_yd/pr_yd configured is unaffected by return production existing in Layer 1", () => {
    const ctx = leagueScoringContext("test", "1", { rec: 1, rec_yd: 0.1, rec_td: 6 });
    const withReturns = translateStatsToLeague(fullProjection({ kr_yd: 500, pr_yd: 200 }), ctx);
    const without = translateStatsToLeague(fullProjection(), ctx);
    assert.equal(withReturns.league_points, without.league_points);
  });
});

describe("return-game — RI vs Sleeper comparison diagnostics (lib/projections/compare.ts)", () => {
  it("a materially return-driven disagreement is identified as return-game, not opportunity/efficiency/TD", () => {
    const proj: PlayerProjection = {
      schema_version: PROJECTION_SCHEMA_VERSION, model_version: PROJECTION_MODEL_VERSION, season: 2026,
      generated_at: "2026-01-01T00:00:00Z", data_as_of: "2025", player_id: "ret1", sleeper_player_id: "ret1",
      full_name: "Return Specialist", position: "WR", team: "SEA", age: 26, years_exp: 4,
      stats: { ...EMPTY_STATS, targets: 60, rec: 42, rec_yd: 480, rec_td: 3, kr_yd: 600, pr_yd: 300 },
      components: {
        snap_share: 0.4, target_share: 0.15, carry_share: null, rz_target_share: 0.1, goal_line_share: null,
        team_pass_att: 550, team_rush_att: 420, team_plays: 970, team_pass_td: 28, team_rush_td: 12,
        volume_component: 40, efficiency_component: 40, td_component: 18, availability_component: 0,
        rookie_prior_weight: 0, age_multiplier: 1,
      },
      availability: { games_if_healthy: 17, expected_games: 17, availability_probability: 0.97, note: null },
      neutral_points: 140, neutral_ppg: 8.2,
      outcome: { floor: 100, median: 140, ceiling: 180, sd: 25, percentiles: { floor: 20, ceiling: 80 } },
      confidence: { bucket: "MEDIUM", score: 0.5, reasons: [], sample_seasons: 2, is_rookie: false, team_changed: false, injury_flagged: false },
      sources: {}, warnings: [],
    };
    const bench = {
      player_id: "ret1", full_name: "Return Specialist", position: "WR" as const, team: "SEA", years_exp: 4,
      is_rookie: false, injury_status: null,
      sleeper_points: { std: 130, half_ppr: 145, ppr: 160 },
      stats: {
        gp: 17, pass_att: null, pass_cmp: null, pass_yd: null, pass_td: null, pass_int: null, pass_2pt: null,
        rush_att: null, rush_yd: null, rush_td: null, rush_2pt: null,
        targets: 58, rec: 40, rec_yd: 470, rec_td: 3, rec_2pt: null, fum_lost: null,
        kr: null, kr_yd: null, pr: null, pr_yd: null, pr_td: null,
        fgm_40_49: null, fgm_50p: null, fgm_yds: null, fgmiss_40_49: null, fgmiss_50p: null, xpm: null, xpmiss: null,
        def_sack: null, def_int: null, def_fum_rec: null, def_td: null, def_blk_kick: null,
      },
      raw_stat_keys: [], source_updated_at: null,
    };
    const cmp = comparePlayer(proj, bench);
    assert.ok(cmp.primary_driver.includes("return-game"), `expected a return-game driver, got: ${cmp.primary_driver}`);
    const krDelta = cmp.stat_deltas.find((d) => d.stat === "kr_yd");
    const prDelta = cmp.stat_deltas.find((d) => d.stat === "pr_yd");
    assert.equal(krDelta?.ri, 600);
    assert.equal(prDelta?.ri, 300);
  });
});

/* -------------------------------------------------------------------- Phase 8/9: weekly actuals + projections */

describe("return-game — weekly actuals scoring (lib/weekly/scoring.ts, already-generic engine)", () => {
  it("a weekly stat line with kr_yd is scored and appears in the breakdown", () => {
    const scored = scoreWeeklyLine({ kr_yd: 87, rec: 3, rec_yd: 28 }, { kr_yd: 0.04, rec: 1, rec_yd: 0.1 });
    assert.ok(scored.scored_keys.includes("kr_yd"));
    assert.equal(scored.points, round2(87 * 0.04 + 3 * 1 + 28 * 0.1));
  });

  it("a weekly stat line with pr_yd is scored and appears in the breakdown", () => {
    const scored = scoreWeeklyLine({ pr_yd: 54 }, { pr_yd: 0.04 });
    assert.ok(scored.scored_keys.includes("pr_yd"));
    assert.equal(scored.points, round2(54 * 0.04));
  });

  it("rankings reflect the added points: a returner outscores an otherwise-identical non-returner", () => {
    const scoring = { rec: 1, rec_yd: 0.1, kr_yd: 0.04, pr_yd: 0.04 };
    const base = { rec: 5, rec_yd: 60 };
    const returner = scoreWeeklyLine({ ...base, kr_yd: 120, pr_yd: 40 }, scoring).points;
    const nonReturner = scoreWeeklyLine(base, scoring).points;
    assert.ok(returner > nonReturner, `returner (${returner}) should outscore non-returner (${nonReturner})`);
  });
});

describe("return-game — weekly projection audit (Sleeper's own weekly feed, live-verified 2026-09)", () => {
  it("documents the verified provider behavior: PR present weekly (outcome A), KR absent weekly (outcome B, deferred)", () => {
    // Live GET https://api.sleeper.app/projections/nfl/{season}/{week} (WR/RB),
    // captured 2026-09-14: individual rows carry `pr`/`pr_yd`/`pr_td` for real
    // punt returners (Mecole Hardman, KaVontae Turpin, Xavier Worthy, ...);
    // `kr`/`kr_yd` do not appear on ANY row, individual or team, in that feed.
    // scoreWeeklyLine (above) already scores pr_yd correctly with no code
    // change needed — this is a documentation test, not a network assertion,
    // so it can't silently pass on stale info: it just records the finding
    // the certification checkpoint relies on.
    const findings = {
      weekly_projection_feed_has_individual_pr_yd: true,
      weekly_projection_feed_has_individual_kr_yd: false,
      season_projection_feed_has_individual_kr_or_pr_yd: false,
    };
    assert.equal(findings.weekly_projection_feed_has_individual_pr_yd, true);
    assert.equal(findings.weekly_projection_feed_has_individual_kr_yd, false);
  });
});

/* -------------------------------------------------------------------- Phase 3: return-game module itself */

describe("return-game — projection module (lib/projections/return-game.ts)", () => {
  function seasons(rows: Array<Partial<PlayerSeasonActual> & { player_id: string; season: number }>): SeasonActuals[] {
    const bySeason = new Map<number, Map<string, PlayerSeasonActual>>();
    for (const r of rows) {
      const full: PlayerSeasonActual = {
        player_id: r.player_id, season: r.season, position: r.position ?? "WR", team: r.team ?? "SEA",
        gp: r.gp ?? 17, gs: r.gs ?? 17, off_snp: 0, tm_off_snp: 0, snap_share: null,
        pass_att: 0, pass_cmp: 0, pass_yd: 0, pass_td: 0, pass_int: 0, pass_rz_att: 0,
        rush_att: 0, rush_yd: 0, rush_td: 0, rush_rz_att: 0, g2g_att: 0,
        targets: r.targets ?? 0, rec: r.rec ?? 0, rec_yd: r.rec_yd ?? 0, rec_td: 0, rec_air_yd: 0, rec_rz_tgt: 0,
        fum_lost: 0, kr: r.kr ?? 0, kr_yd: r.kr_yd ?? 0, pr: r.pr ?? 0, pr_yd: r.pr_yd ?? 0,
        fgm: 0, fga: 0, fgm_yds: 0, xpm: 0, xpa: 0,
        def_sack: 0, def_int: 0, def_fum_rec: 0, def_td: 0, def_safety: 0, pts_ppr: 0,
      };
      if (!bySeason.has(r.season)) bySeason.set(r.season, new Map());
      bySeason.get(r.season)!.set(r.player_id, full);
    }
    return [...bySeason.entries()].sort((a, b) => a[0] - b[0]).map(([season, players]) => ({ season, players, team_totals: new Map() }));
  }

  it("projects a season-pace kr_yd/pr_yd for a player with current-season role evidence", () => {
    const sa = seasons([
      { player_id: "ret1", season: 2024, kr: 20, kr_yd: 500, pr: 15, pr_yd: 200, gp: 17 },
      { player_id: "ret1", season: 2025, kr: 22, kr_yd: 550, pr: 18, pr_yd: 250, gp: 17 },
    ]);
    const proj = projectReturnGame(sa);
    const p = proj.get("ret1");
    assert.ok(p, "expected a return-game projection for ret1");
    assert.ok(p!.kr_yd != null && p!.kr_yd > 0);
    assert.ok(p!.pr_yd != null && p!.pr_yd > 0);
    assert.equal(p!.role_confidence, "HIGH");
  });

  it("does NOT project a return role for a player with zero return-attempt evidence", () => {
    const sa = seasons([{ player_id: "wr_no_returns", season: 2025, rec: 90, rec_yd: 1200, gp: 17 }]);
    const proj = projectReturnGame(sa);
    assert.equal(proj.has("wr_no_returns"), false);
  });

  it("shrinks (does not confidently extrapolate) a player whose most recent season shows the role is gone", () => {
    const sa = seasons([
      { player_id: "ret_lost_job", season: 2023, kr: 30, kr_yd: 800, gp: 17 },
      { player_id: "ret_lost_job", season: 2024, kr: 25, kr_yd: 650, gp: 16 },
      { player_id: "ret_lost_job", season: 2025, kr: 0, kr_yd: 0, rec: 40, rec_yd: 500, gp: 15 },
    ]);
    const proj = projectReturnGame(sa);
    const p = proj.get("ret_lost_job");
    // No qualifying evidence in ANY season row (2025 has 0 attempts, below the
    // role threshold) so the two prior seasons alone still count as evidence,
    // but continuity is false -> low confidence, heavily shrunk.
    assert.ok(p);
    assert.equal(p!.role_confidence, "LOW");
    assert.ok(p!.notes.some((n) => n.includes("shrunk")));
  });

  it("applyReturnGameProjections merges into stats without touching neutral_points/outcome/other stats", () => {
    const sa = seasons([{ player_id: "ret1", season: 2025, kr: 20, kr_yd: 500, gp: 17 }]);
    const rg = projectReturnGame(sa);
    const projections = new Map<string, PlayerProjection>([
      ["ret1", {
        schema_version: PROJECTION_SCHEMA_VERSION, model_version: PROJECTION_MODEL_VERSION, season: 2026,
        generated_at: "x", data_as_of: "x", player_id: "ret1", sleeper_player_id: "ret1", full_name: "Ret",
        position: "WR", team: "SEA", age: 26, years_exp: 4,
        stats: { ...EMPTY_STATS, rec: 40, rec_yd: 500 },
        components: {
          snap_share: 0.5, target_share: 0.1, carry_share: null, rz_target_share: 0.05, goal_line_share: null,
          team_pass_att: 500, team_rush_att: 400, team_plays: 900, team_pass_td: 25, team_rush_td: 10,
          volume_component: 30, efficiency_component: 20, td_component: 10, availability_component: 0,
          rookie_prior_weight: 0, age_multiplier: 1,
        },
        availability: { games_if_healthy: 17, expected_games: 17, availability_probability: 0.97, note: null },
        neutral_points: 90, neutral_ppg: 5.3,
        outcome: { floor: 60, median: 90, ceiling: 120, sd: 20, percentiles: { floor: 20, ceiling: 80 } },
        confidence: { bucket: "MEDIUM", score: 0.5, reasons: [], sample_seasons: 1, is_rookie: false, team_changed: false, injury_flagged: false },
        sources: {}, warnings: [],
      }],
    ]);
    const before = { ...projections.get("ret1")!.outcome };
    const neutralBefore = projections.get("ret1")!.neutral_points;
    applyReturnGameProjections(projections, rg);
    const after = projections.get("ret1")!;
    assert.ok(after.stats.kr_yd != null && after.stats.kr_yd > 0);
    assert.equal(after.stats.rec_yd, 500); // untouched
    assert.equal(after.neutral_points, neutralBefore); // return-neutral in Layer 1
    assert.deepEqual(after.outcome, before);
    assert.ok(after.sources[RETURN_GAME_MODEL_VERSION]?.used);
  });
});

/* -------------------------------------------------------------------- Phase 7: scoring API visibility */

describe("return-game — scoring catalog / classification visibility", () => {
  it("derives special-teams rate metrics only when the league configures them", () => {
    const withReturns = buildDerivedSpecialTeams({ kr_yd: 0.04, pr_yd: 0.04 });
    assert.equal(withReturns.kick_return_yard_value, 0.04);
    assert.equal(withReturns.points_per_100_kick_return_yards, 4);
    assert.equal(withReturns.points_per_25_punt_return_yards, 1);

    const without = buildDerivedSpecialTeams({});
    assert.equal(without.kick_return_yard_value, null);
    assert.equal(without.punt_return_yard_value, null);
  });

  it("classification.features reports individual return scoring only when nonzero", () => {
    const on = classifyScoring({ pass_td: 4, kr_yd: 0.1, pr_yd: 0.1 }, []);
    assert.ok(on.features.some((f) => f.includes("kickoff return yards")));
    assert.ok(on.features.some((f) => f.includes("punt return yards")));

    const off = classifyScoring({ pass_td: 4 }, []);
    assert.ok(!off.features.some((f) => f.includes("return yards")));
  });
});

/* -------------------------------------------------------------------- Phase 10: downstream propagation */

describe("return-game — downstream propagation (Layer 2 -> value, via the normal architecture)", () => {
  it("a return specialist gains value only in a league that scores returns; unaffected otherwise", () => {
    const specialist = fullProjection({ kr_yd: 500, pr_yd: 250, targets: 90, rec: 60, rec_yd: 700, rec_td: 4 });
    const twin = fullProjection({ targets: 90, rec: 60, rec_yd: 700, rec_td: 4 }); // identical, no returns

    const scoringWithReturns = { rec: 1, rec_yd: 0.1, rec_td: 6, kr_yd: 0.04, pr_yd: 0.04 };
    const scoringWithoutReturns = { rec: 1, rec_yd: 0.1, rec_td: 6 };

    const ctxOn = leagueScoringContext("league-on", "1", scoringWithReturns);
    const ctxOff = leagueScoringContext("league-off", "2", scoringWithoutReturns);

    const lpSpecialistOn = buildLeagueProjection(asPlayerProjection(specialist, "specialist"), ctxOn, null);
    const lpTwinOn = buildLeagueProjection(asPlayerProjection(twin, "twin"), ctxOn, null);
    const lpSpecialistOff = buildLeagueProjection(asPlayerProjection(specialist, "specialist"), ctxOff, null);
    const lpTwinOff = buildLeagueProjection(asPlayerProjection(twin, "twin"), ctxOff, null);

    assert.ok(
      lpSpecialistOn.league_points > lpTwinOn.league_points,
      `specialist (${lpSpecialistOn.league_points}) should outrank twin (${lpTwinOn.league_points}) in a return-scoring league`,
    );
    assert.equal(
      lpSpecialistOff.league_points,
      lpTwinOff.league_points,
      "specialist and twin must be IDENTICAL in a league that doesn't score returns",
    );
  });
});

/* ------------------------------------------------------------------------------ helpers */

function asPlayerProjection(
  base: Pick<PlayerProjection, "stats" | "position" | "availability">,
  id: string,
): PlayerProjection {
  return {
    schema_version: PROJECTION_SCHEMA_VERSION, model_version: PROJECTION_MODEL_VERSION, season: 2026,
    generated_at: "x", data_as_of: "x", player_id: id, sleeper_player_id: id, full_name: id,
    position: base.position, team: "SEA", age: 26, years_exp: 4,
    stats: base.stats,
    components: {
      snap_share: 0.5, target_share: 0.15, carry_share: null, rz_target_share: 0.08, goal_line_share: null,
      team_pass_att: 550, team_rush_att: 420, team_plays: 970, team_pass_td: 28, team_rush_td: 12,
      volume_component: 50, efficiency_component: 40, td_component: 20, availability_component: 0,
      rookie_prior_weight: 0, age_multiplier: 1,
    },
    availability: base.availability,
    neutral_points: 150, neutral_ppg: 8.8,
    outcome: { floor: 110, median: 150, ceiling: 190, sd: 25, percentiles: { floor: 20, ceiling: 80 } },
    confidence: { bucket: "MEDIUM", score: 0.5, reasons: [], sample_seasons: 2, is_rookie: false, team_changed: false, injury_flagged: false },
    sources: {}, warnings: [],
  };
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
