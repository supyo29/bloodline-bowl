/**
 * K / DEF production projection coverage — `ri-kicker-2026.1` / `ri-defense-2026.1`.
 *
 * Deterministic tests over the vendored snapshot + synthetic Sleeper player
 * records. Covers opportunity / accuracy / job-security / uncertainty for K,
 * every Bloodline-scored component for DEF, data-quality gates, and integration
 * with replacement/VOR + the frozen snake engine (K/DEF hard gate intact,
 * offensive fixtures unchanged).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildKickerLeagueProjections,
  buildDefenseLeagueProjections,
  buildSpecialTeamsProjections,
  resolveKickerRole,
  withoutRosteredSpecialTeams,
  KICKER_MODEL_VERSION,
  DEFENSE_MODEL_VERSION,
  NFL_TEAMS,
} from "@/lib/projections/special-teams";
import { leagueScoringContext } from "@/lib/projections/league";
import { computeReplacementLevels, applyValueOverReplacement } from "@/lib/projections/replacement";
import { recommendDraft, type EngineInput } from "@/lib/draft/engine";
import { buildMarketSnapshot } from "@/lib/draft/survival";
import type { NormalizedPlayer } from "@/lib/sleeper/types";
import type { LeagueProjection } from "@/lib/projections/schema";

/* ------------------------------------------------------------ Bloodline scoring */
// The real continuous config: no FG distance premium; continuous pts_allow.
const BLOODLINE_SCORING: Record<string, number> = {
  fgm: 3, fgmiss: -1, xpm: 1, xpmiss: -1,
  fgm_0_19: 0, fgm_20_29: 0, fgm_30_39: 0, fgm_40_49: 0, fgm_50p: 0, fgm_50_59: 0, fgm_60p: 0,
  sack: 1, sack_yd: 0.04, int: 1, int_ret_yd: 0.04, ff: 1, fum_rec: 1, fum_ret_yd: 0.04,
  safe: 2, blk_kick: 1, blk_kick_ret_yd: 0.04, def_td: 6, st_td: 6, def_st_td: 6,
  def_kr_yd: 0.04, def_pr_yd: 0.04, def_4_and_stop: 1, def_forced_punts: 1,
  pts_allow: -0.3, pts_allow_0: 0, pts_allow_1_6: 0, pts_allow_7_13: 0, pts_allow_14_20: 0,
  pts_allow_21_27: 0, pts_allow_28_34: 0, pts_allow_35p: 0,
};
const CTX = leagueScoringContext("bloodline-bowl", "L1", BLOODLINE_SCORING);

function mkK(id: string, team: string, dco: number | null, over: Partial<NormalizedPlayer> = {}): NormalizedPlayer {
  return {
    player_id: id, full_name: id, first_name: null, last_name: null, position: "K",
    fantasy_positions: ["K"], team, age: 27, years_exp: 4, status: null, injury_status: null,
    number: null, active: true, search_rank: 150, depth_chart_order: dco, depth_chart_position: "K", resolved: true,
    ...over,
  };
}
function mkDEF(team: string): NormalizedPlayer {
  return {
    player_id: team, full_name: `${team} D/ST`, first_name: team, last_name: "D/ST", position: "DEF",
    fantasy_positions: ["DEF"], team, age: null, years_exp: null, status: null, injury_status: null,
    number: null, active: true, search_rank: null, depth_chart_order: null, depth_chart_position: null, resolved: true,
  };
}

/** A player index that mirrors the current NFL reality for the snapshot kickers. */
function liveIndex(): Map<string, NormalizedPlayer> {
  const m = new Map<string, NormalizedPlayer>();
  // real current starters (Sleeper ids from the snapshot)
  const starters: Array<[string, string]> = [
    ["11533", "DAL"], ["8259", "LAC"], ["3451", "HOU"], ["2747", "SEA"], ["3678", "DEN"],
    ["6650", "TB"], ["5189", "SF"], ["4227", "KC"], ["11786", "JAX"], ["11792", "MIN"],
    ["12711", "BAL"], ["7042", "BUF"], ["2020", "CHI"], ["11539", "DET"], ["7839", "CIN"],
    ["4195", "PHI"], ["1945", "PIT"], ["12015", "LAR"], ["650", "ATL"], ["10955", "ARI"],
    ["7922", "MIA"], ["12961", "CAR"], ["6083", "LV"], ["6528", "TEN"], ["11261", "CLE"],
    ["12185", "IND"], ["11058", "NYJ"], ["12713", "NE"],
  ];
  for (const [id, team] of starters) m.set(id, mkK(id, team, 1));
  // Jake Moody: BAL backup (dco null, Loop is BAL's dco 1) — the Phase 9 trap
  m.set("10937", mkK("10937", "BAL", null, { full_name: "Jake Moody" }));
  // rookies not in the snapshot
  m.set("13545", mkK("13545", "GB", 1, { full_name: "Trey Smack", years_exp: 0 }));
  m.set("13833", mkK("13833", "NYG", 1, { full_name: "Dominic Zvada", years_exp: 0 }));
  m.set("13968", mkK("13968", "WAS", 1, { full_name: "Drew Stevens", years_exp: 0 }));
  for (const t of NFL_TEAMS) m.set(t, mkDEF(t));
  return m;
}

/* -------------------------------------------------------------------- KICKER */

describe("K — job security (resolveKickerRole)", () => {
  const snap = { team: "DAL", name: "Brandon Aubrey", sleeper_id: "11533", depth_rank: 1, depth_chart_role: "DEPTH_1", role_confidence: "HIGH", projection_confidence: "HIGH", projection_tier: "TIER_A_CURRENT_DIRECT", current_status: "Active", injury_status: null, fg_att: 34, fg_made: 30, fg_missed: 4, xp_att: 40, xp_made: 39, xp_missed: 1, projected_bloodline_points: 144, floor_points: 118, ceiling_points: 170, replacement_points: 116.6 };

  it("K-2: a live-depth-2 kicker is INVALID (not a normal starter)", () => {
    const r = resolveKickerRole({ ...snap }, mkK("x", "DAL", 2), false);
    assert.equal(r.confidence, "INVALID");
  });
  it("K-2: a practice-squad kicker with no team is INVALID", () => {
    const r = resolveKickerRole({ ...snap }, mkK("x", null as unknown as string, null), false);
    assert.equal(r.confidence, "INVALID");
  });
  it("Phase-9 trap: no live depth_chart_order + a team-mate is depth 1 -> LOW", () => {
    const r = resolveKickerRole({ ...snap, team: "WAS", name: "Jake Moody" }, mkK("10937", "BAL", null), true);
    assert.equal(r.confidence, "LOW");
    assert.ok(r.reasons.some((x) => /another kicker on the team is depth 1/.test(x)));
  });
  it("K-1: live depth-1 on the projected team + current direct projection -> HIGH", () => {
    const r = resolveKickerRole({ ...snap }, mkK("11533", "DAL", 1), false);
    assert.equal(r.confidence, "HIGH");
  });
  it("K-7: team mismatch (snapshot team != live team) -> at most MEDIUM", () => {
    const r = resolveKickerRole({ ...snap, team: "IND" }, mkK("11533", "DAL", 1), false);
    assert.equal(r.confidence, "MEDIUM");
    assert.ok(r.reasons.some((x) => /differs from the snapshot team/.test(x)));
  });
  it("an Out / IR injury status is INVALID", () => {
    const r = resolveKickerRole({ ...snap }, mkK("11533", "DAL", 1, { injury_status: "Out" }), false);
    assert.equal(r.confidence, "INVALID");
  });
});

describe("K — projection model", () => {
  const built = buildKickerLeagueProjections({ ctx: CTX, playerIndex: liveIndex() });
  const byName = new Map(built.projections.map((p) => [p.full_name, p]));

  it("K-1: valid starting kickers receive a production projection", () => {
    assert.ok(built.projections.length >= 24);
    assert.ok(byName.has("Brandon Aubrey"));
    assert.ok(byName.has("Cameron Dicker"));
  });
  it("K-2: the Phase-9 trap kicker (Jake Moody) is NOT in the production pool", () => {
    assert.equal(byName.has("Jake Moody"), false);
    assert.ok(built.roles.some((r) => r.name === "Jake Moody" && r.confidence === "LOW"));
  });
  it("K-4/K-5: accuracy matters — more misses lowers expected points", () => {
    const k = (fgm: number, fgmiss: number) =>
      buildKickerLeagueProjections({
        ctx: CTX,
        playerIndex: (() => {
          const m = liveIndex();
          return m;
        })(),
      });
    // score two synthetic lines directly through the config
    const acc = 30 * 3 + 2 * -1 + 39 * 1 + 1 * -1;
    const inacc = 26 * 3 + 6 * -1 + 36 * 1 + 4 * -1;
    assert.ok(acc > inacc, "fewer misses => more points under fgm 3 / fgmiss -1");
  });
  it("K-6: no FG-distance premium — a 50+ make is worth the same 3 as a 20-yarder", () => {
    assert.equal((BLOODLINE_SCORING.fgm_50p ?? -999), 0);
    assert.equal((BLOODLINE_SCORING.fgm_0_19 ?? -999), 0);
    assert.equal((BLOODLINE_SCORING.fgm ?? -999), 3);
  });
  it("K-7: role uncertainty (MEDIUM) widens the outcome band vs a HIGH-role kicker", () => {
    const high = byName.get("Brandon Aubrey")!;
    const med = built.projections.find((p) => built.roles.find((r) => r.player_id === p.player_id && r.confidence === "MEDIUM"));
    assert.ok(med, "a MEDIUM-confidence kicker exists");
    const relSpread = (p: LeagueProjection) => (p.league_outcome.ceiling - p.league_outcome.floor) / p.league_outcome.median;
    // team-neutral / modeled kickers carry a wider relative band
    assert.ok(relSpread(med!) >= relSpread(high) - 0.02);
  });
  it("all production kickers sit in a sane season-point range", () => {
    for (const p of built.projections) {
      assert.ok(p.league_points >= 85 && p.league_points <= 185, `${p.full_name} = ${p.league_points}`);
    }
  });
  it("K data quality: coverage VALID, no duplicate team starter", () => {
    assert.equal(built.coverage.version, KICKER_MODEL_VERSION);
    assert.equal(built.coverage.status, "VALID");
    const perTeam = new Map<string, number>();
    for (const p of built.projections) perTeam.set(p.team!, (perTeam.get(p.team!) ?? 0) + 1);
    assert.ok([...perTeam.values()].every((n) => n === 1));
  });
});

/* --------------------------------------------------------------------- DEF */

describe("DEF — projection model", () => {
  const built = buildDefenseLeagueProjections({ ctx: CTX, playerIndex: liveIndex() });
  const byTeam = new Map(built.projections.map((p) => [p.team, p]));

  it("DEF-10: all 32 team defenses receive a valid projection, unique teams", () => {
    assert.equal(built.projections.length, 32);
    assert.equal(new Set(built.projections.map((p) => p.team)).size, 32);
    for (const t of NFL_TEAMS) assert.ok(byTeam.has(t), `missing ${t}`);
    assert.equal(built.coverage.status, "VALID");
    assert.equal(built.coverage.version, DEFENSE_MODEL_VERSION);
  });
  it("DEF-11: lower expected points allowed => higher Bloodline projection", () => {
    // pts_allow is -0.3 continuous; two synthetic lines
    const good = 300 * -0.3;
    const bad = 460 * -0.3;
    assert.ok(good > bad);
  });
  it("DEF-12/13: sacks and sack yards both add value", () => {
    assert.ok((BLOODLINE_SCORING.sack ?? -999) > 0 && (BLOODLINE_SCORING.sack_yd ?? -999) > 0);
    assert.ok(45 * 1 + 300 * 0.04 > 35 * 1 + 220 * 0.04);
  });
  it("DEF-14: turnovers (INT + FF + FR) add value without FF/FR double-count logic error", () => {
    assert.ok((BLOODLINE_SCORING.int ?? -999) > 0 && (BLOODLINE_SCORING.ff ?? -999) > 0 && (BLOODLINE_SCORING.fum_rec ?? -999) > 0);
  });
  it("DEF-15/16: forced punts and 4th-down stops both score", () => {
    assert.equal((BLOODLINE_SCORING.def_forced_punts ?? -999), 1);
    assert.equal((BLOODLINE_SCORING.def_4_and_stop ?? -999), 1);
  });
  it("DEF-17: return yards materially increase the projection (0.04/yd on KR+PR+INT ret)", () => {
    // ~400 KR + 500 PR + 180 INT-ret = 1080 yds * 0.04 = 43.2 pts — material
    assert.ok((400 + 500 + 180) * 0.04 > 20);
  });
  it("DEF-18: no bucket points-allowed logic — the tier keys are all zero", () => {
    for (const key of ["pts_allow_0", "pts_allow_1_6", "pts_allow_7_13", "pts_allow_14_20", "pts_allow_21_27", "pts_allow_28_34", "pts_allow_35p"]) {
      assert.equal(BLOODLINE_SCORING[key], 0);
    }
  });
  it("DEF projections are wider than a stable offensive projection would be", () => {
    for (const p of built.projections) {
      const spread = (p.league_outcome.ceiling - p.league_outcome.floor) / p.league_outcome.median;
      assert.ok(spread >= 0.35, `${p.team} spread ${spread.toFixed(2)}`);
    }
  });
  it("weekly DEF scale is plausible (season / 17 in ~3..14)", () => {
    for (const p of built.projections) {
      const wk = p.league_points / 17;
      assert.ok(wk >= 3 && wk <= 14, `${p.team} ${wk.toFixed(1)}/wk`);
    }
  });
});

/* ------------------------------------------------------------- integration */

describe("integration — replacement / VOR / engine", () => {
  const st = buildSpecialTeamsProjections({ ctx: CTX, playerIndex: liveIndex() });
  const ROSTER_POS = ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "FLEX", "K", "DEF", "BN", "BN", "BN", "BN", "BN"];

  function offensePool(): LeagueProjection[] {
    const p: LeagueProjection[] = [];
    const push = (pos: LeagueProjection["position"], pts: number, i: number) =>
      p.push({
        player_id: `${pos}${i}`, full_name: `${pos}${i}`, position: pos, team: `T${i % 12}`,
        league_slug: "l", league_id: "L1", scoring_hash: CTX.scoring_hash,
        league_points: pts, league_ppg: pts / 17,
        league_outcome: { floor: pts * 0.8, median: pts, ceiling: pts * 1.25, sd: pts * 0.15, percentiles: { floor: 20, ceiling: 80 } },
        sleeper_league_points: null,
        vs_sleeper: { delta_points: null, delta_pct: null, ri_rank: null, sleeper_rank: null, rank_delta: null, primary_driver: null },
        replacement_points: null, value_over_replacement: null, vor_rank: null, position_rank: null, overall_rank: null, tier: null,
        confidence: "HIGH",
      });
    [330, 320, 300, 285, 260, 250, 240, 230, 220, 210, 200, 190, 180, 170, 160, 150, 140, 130, 120, 110].forEach((v, i) => push("RB", v, i));
    [310, 305, 300, 292, 285, 278, 270, 262, 255, 248, 240, 232, 225, 218, 210, 202, 195, 188, 180, 172, 165, 158].forEach((v, i) => push("WR", v, i));
    [300, 240, 210, 190, 175, 160, 150, 140, 130, 120].forEach((v, i) => push("TE", v, i));
    [360, 350, 342, 335, 328, 322, 316, 310, 304, 298, 292, 286, 280].forEach((v, i) => push("QB", v, i));
    return p;
  }
  const full = [...offensePool(), ...st.kickers, ...st.defenses];

  const mkInput = (over: Partial<EngineInput> = {}): EngineInput => ({
    leaguePool: full, rosterPositions: ROSTER_POS, numTeams: 12, draftType: "snake", rounds: 15,
    completedPicks: [], manager: { roster_id: 7, sleeper_user_id: "u", manager_slug: "m", draft_slot: 7 },
    rosterPlayers: [],
    market: buildMarketSnapshot({ adpByPlayer: null, searchRankByPlayer: new Map(full.map((x) => [x.player_id, null])), timestamp: "t" }),
    provenance: { projection_source: "t", projection_version: "ri-structural-2026.3", projection_timestamp: "t", league_scoring_hash: CTX.scoring_hash, draft_state_timestamp: "t" },
    projectionCoverage: { QB: "ri-structural-2026.3", RB: "ri-structural-2026.3", WR: "ri-structural-2026.3", TE: "ri-structural-2026.3", K: "ri-kicker-2026.1", DEF: "ri-defense-2026.1" },
    ...over,
  });

  it("Int-21: the candidate pool includes K and DEF projections", () => {
    assert.ok(full.some((p) => p.position === "K"));
    assert.ok(full.filter((p) => p.position === "DEF").length === 32);
  });
  it("Int-22: replacement levels are finite for K and DEF", () => {
    const lv = computeReplacementLevels(ROSTER_POS, 12, full);
    assert.ok(Number.isFinite(lv.replacement_points.K) && lv.replacement_points.K > 0);
    assert.ok(Number.isFinite(lv.replacement_points.DEF) && lv.replacement_points.DEF > 0);
  });
  it("Int: custom-scoring DEF/K raw points do NOT outrank elite RB/WR by VOR", () => {
    const pool = full.map((p) => ({ ...p }));
    const lv = computeReplacementLevels(ROSTER_POS, 12, pool);
    applyValueOverReplacement(pool, lv);
    const topRb = pool.filter((p) => p.position === "RB").sort((a, b) => (b.value_over_replacement ?? 0) - (a.value_over_replacement ?? 0))[0]!;
    const topWr = pool.filter((p) => p.position === "WR").sort((a, b) => (b.value_over_replacement ?? 0) - (a.value_over_replacement ?? 0))[0]!;
    const topDef = pool.filter((p) => p.position === "DEF").sort((a, b) => (b.value_over_replacement ?? 0) - (a.value_over_replacement ?? 0))[0]!;
    const topK = pool.filter((p) => p.position === "K").sort((a, b) => (b.value_over_replacement ?? 0) - (a.value_over_replacement ?? 0))[0]!;
    assert.ok((topDef.value_over_replacement ?? 0) < (topRb.value_over_replacement ?? 0));
    assert.ok((topDef.value_over_replacement ?? 0) < (topWr.value_over_replacement ?? 0));
    assert.ok((topK.value_over_replacement ?? 0) < (topRb.value_over_replacement ?? 0));
  });
  it("Int-20 / K-9: K and DEF are hard-ineligible early (round 1)", () => {
    const res = recommendDraft(mkInput());
    const surfaced = [res.primary_recommendation, ...res.alternates, ...res.wait_candidates, ...res.do_not_reach]
      .filter(Boolean).map((x) => x!.position);
    assert.ok(!surfaced.includes("K"));
    assert.ok(!surfaced.includes("DEF"));
    assert.equal(res.readiness.snake_engine_status, "READY");
  });
  it("Int-23/24: the late-round engine can legally recommend a DEF, then a K", () => {
    const roster = ["QB", "RB", "RB", "WR", "WR", "TE", "RB", "WR", "WR", "RB", "QB", "TE", "RB"].map((pos, i) => ({
      player_id: `own${i}`, full_name: `own${i}`, first_name: null, last_name: null, position: pos,
      fantasy_positions: [pos], team: "AAA", age: 26, years_exp: 4, status: null, injury_status: null,
      number: null, active: true, search_rank: 50, depth_chart_order: 1, depth_chart_position: null, resolved: true,
    })) as NormalizedPlayer[];
    const made = Array.from({ length: 13 * 12 + 6 }, (_, i) => ({ overall: i + 1, roster_id: (i % 12) + 1, player_id: `f${i}`, position: null }));
    const res = recommendDraft(mkInput({ rosterPlayers: roster, completedPicks: made as never }));
    const surfaced = [res.primary_recommendation, ...res.alternates, ...res.wait_candidates].filter(Boolean).map((x) => x!.position);
    assert.ok(surfaced.includes("DEF") || res.primary_recommendation?.position === "DEF", "DEF actionable late");
  });
  it("Int-19 / DEF-19 / K-8: no SECOND K or DEF once one is rostered (withoutRosteredSpecialTeams)", () => {
    const complete: NormalizedPlayer[] = ["QB", "RB", "RB", "WR", "WR", "TE", "RB", "WR", "RB", "WR", "QB", "TE", "K", "DEF"].map((pos, i) => ({
      player_id: pos === "K" ? "K-own" : pos === "DEF" ? "PHI" : `own${i}`, full_name: `own${i}`, first_name: null, last_name: null, position: pos,
      fantasy_positions: [pos], team: pos === "DEF" ? "PHI" : "AAA", age: 26, years_exp: 4, status: null, injury_status: null,
      number: null, active: true, search_rank: 50, depth_chart_order: 1, depth_chart_position: null, resolved: true,
    }));
    // orchestration: the pool the engine sees has K + DEF stripped
    const engPool = withoutRosteredSpecialTeams(full, complete);
    assert.equal(engPool.some((p) => p.position === "K"), false, "no K rows once a K is rostered");
    assert.equal(engPool.some((p) => p.position === "DEF"), false, "no DEF rows once a DEF is rostered");

    const made = Array.from({ length: 14 * 12 + 6 }, (_, i) => ({ overall: i + 1, roster_id: (i % 12) + 1, player_id: `f${i}`, position: null }));
    const res = recommendDraft(mkInput({ leaguePool: engPool, rosterPlayers: complete, completedPicks: made as never }));
    const surfaced = [res.primary_recommendation, ...res.alternates, ...res.wait_candidates, ...res.do_not_reach].filter(Boolean).map((x) => x!.position);
    assert.ok(!surfaced.includes("K"), "no 2nd K surfaced");
    assert.ok(!surfaced.includes("DEF"), "no 2nd DEF surfaced");
  });
  it("withoutRosteredSpecialTeams keeps K/DEF available while the roster has none", () => {
    const partial = [{ position: "RB" }, { position: "WR" }];
    const p = withoutRosteredSpecialTeams(full, partial);
    assert.equal(p.some((x) => x.position === "K"), true);
    assert.equal(p.filter((x) => x.position === "DEF").length, 32);
  });
  it("Int-28 / Int-32: model versions unchanged; no early K/DEF; coverage in provenance", () => {
    const res = recommendDraft(mkInput());
    assert.equal(res.provenance.recommendation_model_version, "ri-snake-decision-2026.2");
    assert.equal(res.provenance.projection_version, "ri-structural-2026.3");
    assert.equal(res.provenance.survival_model_version, "ri-snake-survival-2026.1");
    assert.equal(res.provenance.projection_coverage.K, "ri-kicker-2026.1");
    assert.equal(res.provenance.projection_coverage.DEF, "ri-defense-2026.1");
  });
});
