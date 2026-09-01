/**
 * PHASE 3 — draft-capital rookie opportunity prior (`ri-structural-2026.3`).
 *
 * Deterministic invariants + R↔TS parity for `lib/projections/rookie-model.ts`.
 * The model + its held-out evidence are in `analysis/phase3_rookie_role_model.R`
 * and `outputs/projections-2026/phase3_*`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  rookieOpportunityPrior,
  rookieDraftFor,
  rookieDraftClassSize,
  ROOKIE_MODEL_VERSION,
  UDFA_PICK,
} from "@/lib/projections/rookie-model";
import { CALIBRATION_V1, CALIBRATION_V2, CALIBRATION_V3 } from "@/lib/projections/baselines";
import { PROJECTION_MODEL_VERSION } from "@/lib/projections/schema";
import type { FantasyPosition } from "@/lib/projections/schema";

interface ParityFixture {
  model_version: string;
  tolerance_abs: number;
  cases: Array<{ position: FantasyPosition; pick: number; round: number; target_pg: number; carry_pg: number }>;
}
const fixture = JSON.parse(
  readFileSync(join(process.cwd(), "test", "fixtures", "phase3-parity.json"), "utf8"),
) as ParityFixture;

describe("rookie model — R ↔ TS parity", () => {
  it("fixture matches the current model version", () => {
    assert.equal(fixture.model_version, ROOKIE_MODEL_VERSION);
    assert.equal(ROOKIE_MODEL_VERSION, PROJECTION_MODEL_VERSION);
  });

  it("every fixture case agrees within tolerance", () => {
    for (const c of fixture.cases) {
      const r = rookieOpportunityPrior(c.position, { pick: c.pick, round: c.round });
      assert.ok(r, `no prediction for ${c.position} pick ${c.pick}`);
      assert.ok(
        Math.abs(r.target_pg - c.target_pg) <= fixture.tolerance_abs,
        `${c.position} pick ${c.pick}: target_pg R ${c.target_pg} vs TS ${r.target_pg}`,
      );
      assert.ok(
        Math.abs(r.carry_pg - c.carry_pg) <= fixture.tolerance_abs,
        `${c.position} pick ${c.pick}: carry_pg R ${c.carry_pg} vs TS ${r.carry_pg}`,
      );
    }
  });
});

describe("rookie model — football invariants (§27)", () => {
  const skill: FantasyPosition[] = ["WR", "RB", "TE"];

  it("QB and unsupported positions return null (handled elsewhere)", () => {
    assert.equal(rookieOpportunityPrior("QB", { pick: 1, round: 1 }), null);
    assert.equal(rookieOpportunityPrior("K", { pick: 1, round: 1 }), null);
    assert.equal(rookieOpportunityPrior("DEF", { pick: 1, round: 1 }), null);
  });

  it("opportunity is strictly positive and never NaN", () => {
    for (const pos of skill) {
      for (let pick = 1; pick <= 300; pick += 7) {
        const r = rookieOpportunityPrior(pos, { pick, round: Math.min(8, Math.ceil(pick / 32)) })!;
        assert.ok(Number.isFinite(r.target_pg) && r.target_pg >= 0, `${pos} ${pick} target`);
        assert.ok(Number.isFinite(r.carry_pg) && r.carry_pg >= 0, `${pos} ${pick} carry`);
        assert.ok(r.snap_share > 0 && r.snap_share <= 1, `${pos} ${pick} snap`);
        assert.ok(r.band.lo <= r.band.hi, `${pos} ${pick} band`);
      }
    }
  });

  it("better draft capital never lowers projected opportunity (monotone in pick)", () => {
    for (const pos of skill) {
      let prev = Infinity;
      for (let pick = 1; pick <= 260; pick += 1) {
        const r = rookieOpportunityPrior(pos, { pick, round: Math.min(8, Math.ceil(pick / 32)) })!;
        const opp = r.target_pg + r.carry_pg;
        assert.ok(opp <= prev + 1e-9, `${pos}: opportunity rose at pick ${pick} (${opp} > ${prev})`);
        prev = opp;
      }
    }
  });

  it("more round (later) never raises projected opportunity, holding pick", () => {
    for (const pos of skill) {
      const at = (round: number) => {
        const r = rookieOpportunityPrior(pos, { pick: 100, round })!;
        return r.target_pg + r.carry_pg;
      };
      for (let round = 2; round <= 8; round++) {
        assert.ok(at(round) <= at(round - 1) + 1e-9, `${pos} round ${round}`);
      }
    }
  });

  it("projected per-game opportunity is football-plausible (capped)", () => {
    // a hypothetical #1 pick cannot be projected past the observed rookie ceiling
    const wr = rookieOpportunityPrior("WR", { pick: 1, round: 1 })!;
    const rb = rookieOpportunityPrior("RB", { pick: 1, round: 1 })!;
    assert.ok(wr.target_pg <= 9.0 + 1e-9, `WR target cap: ${wr.target_pg}`);
    assert.ok(rb.carry_pg <= 16.0 + 1e-9, `RB carry cap: ${rb.carry_pg}`);
    // and a very late pick still gets a small non-zero role
    const late = rookieOpportunityPrior("WR", { pick: 258, round: 8 })!;
    assert.ok(late.target_pg > 0.5 && late.target_pg < 3, `late WR: ${late.target_pg}`);
  });

  it("missing / invalid draft input falls back to the UDFA sentinel, not a crash", () => {
    const a = rookieOpportunityPrior("WR", { pick: NaN, round: NaN })!;
    const b = rookieOpportunityPrior("WR", { pick: UDFA_PICK, round: 8 })!;
    assert.deepEqual(a, b);
  });
});

describe("rookie model — calibration-profile wiring", () => {
  it("only the live (v3) profile activates the draft-capital rookie prior", () => {
    assert.equal(CALIBRATION_V1.rookieDraftFor("anything"), null);
    assert.equal(CALIBRATION_V2.rookieDraftFor("anything"), null);
    assert.equal(CALIBRATION_V3.rookieDraftFor, rookieDraftFor);
  });

  it("the vendored 2026 rookie draft crosswalk is well-formed", () => {
    assert.ok(rookieDraftClassSize() > 40, `only ${rookieDraftClassSize()} rookies vendored`);
    // a known 2026 top pick resolves (Jeremiyah Love, RB, pick 3 — sleeper 13287)
    const love = rookieDraftFor("13287");
    assert.ok(love && love.pick === 3 && love.round === 1, JSON.stringify(love));
    // an unknown id resolves to null
    assert.equal(rookieDraftFor("does-not-exist"), null);
  });
});

/* ------------------------------------------------------------- build-level: rookie share cap + conservation (§26) */

import { buildBaseProjections, clearProjectionCaches } from "@/lib/projections/build";
import type { NormalizedPlayer } from "@/lib/sleeper/types";
import type { SeasonActuals, PlayerSeasonActual } from "@/lib/projections/actuals";

function mkPlayer(o: Partial<NormalizedPlayer> & { player_id: string; position: FantasyPosition }): NormalizedPlayer {
  return {
    player_id: o.player_id, full_name: o.full_name ?? o.player_id, first_name: null, last_name: null,
    position: o.position, fantasy_positions: [o.position], team: o.team ?? "KC",
    age: o.age ?? 26, years_exp: o.years_exp ?? 4, status: null, injury_status: null, number: null,
    active: true, search_rank: o.search_rank ?? 50, depth_chart_order: o.depth_chart_order ?? 1,
    depth_chart_position: null, resolved: true,
  };
}
function mkSeason(o: Partial<PlayerSeasonActual> & { player_id: string; season: number }): PlayerSeasonActual {
  return {
    player_id: o.player_id, season: o.season, position: o.position ?? "WR", team: o.team ?? "KC",
    gp: o.gp ?? 17, gs: 17, off_snp: 900, tm_off_snp: 1000, snap_share: 0.9,
    pass_att: o.pass_att ?? 0, pass_cmp: o.pass_cmp ?? 0, pass_yd: o.pass_yd ?? 0, pass_td: o.pass_td ?? 0,
    pass_int: o.pass_int ?? 0, pass_rz_att: o.pass_rz_att ?? 0,
    rush_att: o.rush_att ?? 0, rush_yd: o.rush_yd ?? 0, rush_td: o.rush_td ?? 0, rush_rz_att: o.rush_rz_att ?? 0, g2g_att: 0,
    targets: o.targets ?? 0, rec: o.rec ?? 0, rec_yd: o.rec_yd ?? 0, rec_td: o.rec_td ?? 0, rec_air_yd: 0, rec_rz_tgt: o.rec_rz_tgt ?? 0,
    fum_lost: 0, fgm: 0, fga: 0, fgm_yds: 0, xpm: 0, xpa: 0,
    def_sack: 0, def_int: 0, def_fum_rec: 0, def_td: 0, def_safety: 0, pts_ppr: o.pts_ppr ?? 0,
  };
}

describe("rookie model — §26 team-pool interaction", () => {
  // A team with a thin WR room + one very-highly-drafted rookie WR (in the
  // vendored 2026 crosswalk: Jordyn Tyson, sleeper_id 13276? use a real one).
  const rookieId = "13279"; // Carnell Tate, WR pick 4 (vendored)
  function fx() {
    const players: NormalizedPlayer[] = [
      mkPlayer({ player_id: "QB1", position: "QB", team: "AAA" }),
      mkPlayer({ player_id: "WRvet", position: "WR", team: "AAA", depth_chart_order: 1 }),
      mkPlayer({ player_id: rookieId, full_name: "Rookie WR", position: "WR", team: "AAA", years_exp: 0, age: 22, depth_chart_order: 2 }),
      mkPlayer({ player_id: "WR3", position: "WR", team: "AAA", depth_chart_order: 3 }),
      mkPlayer({ player_id: "WR4", position: "WR", team: "AAA", depth_chart_order: 4 }),
      mkPlayer({ player_id: "TE2boundary", position: "TE", team: "AAA", depth_chart_order: 2 }),
      mkPlayer({ player_id: "RB1", position: "RB", team: "AAA", depth_chart_order: 1 }),
      mkPlayer({ player_id: "TE1", position: "TE", team: "AAA", depth_chart_order: 1 }),
      // filler teams so replacement/pools aren't degenerate
      ...["BBB", "CCC", "DDD"].flatMap((t) => [
        mkPlayer({ player_id: `${t}_qb`, position: "QB", team: t }),
        mkPlayer({ player_id: `${t}_wr1`, position: "WR", team: t }),
        mkPlayer({ player_id: `${t}_wr2`, position: "WR", team: t, depth_chart_order: 2 }),
        mkPlayer({ player_id: `${t}_rb`, position: "RB", team: t }),
        mkPlayer({ player_id: `${t}_te`, position: "TE", team: t }),
      ]),
    ];
    const playerIndex = new Map(players.map((p) => [p.player_id, p]));
    const seasons: SeasonActuals[] = [2023, 2024, 2025].map((season) => {
      const rows = new Map<string, PlayerSeasonActual>();
      rows.set("QB1", mkSeason({ player_id: "QB1", season, position: "QB", pass_att: 560, pass_cmp: 370, pass_yd: 4100, pass_td: 27, pass_int: 11, pass_rz_att: 60 }));
      rows.set("WRvet", mkSeason({ player_id: "WRvet", season, position: "WR", targets: 150, rec: 100, rec_yd: 1350, rec_td: 9, rec_rz_tgt: 18, pts_ppr: 260 }));
      rows.set("WR3", mkSeason({ player_id: "WR3", season, position: "WR", targets: 95, rec: 62, rec_yd: 760, rec_td: 5, rec_rz_tgt: 9, pts_ppr: 150 }));
      rows.set("WR4", mkSeason({ player_id: "WR4", season, position: "WR", targets: 70, rec: 46, rec_yd: 520, rec_td: 3, rec_rz_tgt: 6, pts_ppr: 100 }));
      rows.set("TE2boundary", mkSeason({ player_id: "TE2boundary", season, position: "TE", targets: 62, rec: 44, rec_yd: 470, rec_td: 3, rec_rz_tgt: 7, pts_ppr: 95 }));
      rows.set("RB1", mkSeason({ player_id: "RB1", season, position: "RB", rush_att: 240, rush_yd: 1050, rush_td: 9, rush_rz_att: 42, targets: 50, rec: 40, rec_yd: 320, pts_ppr: 240 }));
      rows.set("TE1", mkSeason({ player_id: "TE1", season, position: "TE", targets: 80, rec: 56, rec_yd: 620, rec_td: 5, rec_rz_tgt: 11, pts_ppr: 140 }));
      const team_totals = new Map([["AAA", { pass_att: 590, rush_att: 430, targets: 555, pass_td: 30, rush_td: 15, rec_td: 30, plays: 1020, authoritative: true }]]);
      for (const t of ["BBB", "CCC", "DDD"]) {
        rows.set(`${t}_qb`, mkSeason({ player_id: `${t}_qb`, season, position: "QB", pass_att: 540, pass_cmp: 350, pass_yd: 3900, pass_td: 24, pass_int: 12, pass_rz_att: 58 }));
        rows.set(`${t}_wr1`, mkSeason({ player_id: `${t}_wr1`, season, position: "WR", targets: 140, rec: 92, rec_yd: 1200, rec_td: 8, rec_rz_tgt: 16, pts_ppr: 240 }));
        rows.set(`${t}_wr2`, mkSeason({ player_id: `${t}_wr2`, season, position: "WR", targets: 95, rec: 62, rec_yd: 780, rec_td: 5, rec_rz_tgt: 9, pts_ppr: 150 }));
        rows.set(`${t}_rb`, mkSeason({ player_id: `${t}_rb`, season, position: "RB", rush_att: 220, rush_yd: 980, rush_td: 8, rush_rz_att: 38, targets: 45, rec: 36, rec_yd: 300, pts_ppr: 220 }));
        rows.set(`${t}_te`, mkSeason({ player_id: `${t}_te`, season, position: "TE", targets: 78, rec: 54, rec_yd: 600, rec_td: 4, rec_rz_tgt: 9, pts_ppr: 130 }));
        team_totals.set(t, { pass_att: 560, rush_att: 420, targets: 528, pass_td: 26, rush_td: 13, rec_td: 26, plays: 980, authoritative: true });
      }
      return { season, players: rows, team_totals };
    });
    return { playerIndex, seasons };
  }

  it("a highly-drafted rookie WR's target share is capped at the historical ceiling (~0.28)", async () => {
    clearProjectionCaches();
    const base = await buildBaseProjections({ season: 2026, skipBenchmark: true, fixtures: fx() });
    const rook = base.projections.get(rookieId)!;
    const teamTargets = [...base.projections.values()]
      .filter((p) => p.team === "AAA" && p.position !== "QB")
      .reduce((s, p) => s + (p.stats.targets ?? 0), 0);
    const share = (rook.stats.targets ?? 0) / teamTargets;
    assert.ok(rook.confidence.is_rookie, "fixture player must be a rookie");
    assert.ok(share <= 0.30, `rookie target share ${share.toFixed(3)} exceeds cap`);
    assert.ok((rook.stats.targets ?? 0) > 20, "rookie should still get a real projection (draft prior active)");
  });

  it("team target conservation holds with a draft-capital rookie in the room", async () => {
    clearProjectionCaches();
    const base = await buildBaseProjections({ season: 2026, skipBenchmark: true, fixtures: fx() });
    assert.equal(base.reconciliation.hard_misses.length, 0, JSON.stringify(base.reconciliation.hard_misses));
    assert.equal(base.reconciliation.soft_misses.length, 0);
  });

  it("§26 Isaiah-Likely guard: a drafted rookie does not cliff the boundary incumbent", async () => {
    // Without the role-aware keep-window widening, the rookie edging past the
    // receiver top-N cutoff drops TE2boundary to filler weight (~88% loss).
    clearProjectionCaches();
    const v2 = await buildBaseProjections({ season: 2026, skipBenchmark: true, fixtures: fx(), calibration: CALIBRATION_V2 });
    clearProjectionCaches();
    const v3 = await buildBaseProjections({ season: 2026, skipBenchmark: true, fixtures: fx(), calibration: CALIBRATION_V3 });
    const t2 = v2.projections.get("TE2boundary")!.stats.targets ?? 0;
    const t3 = v3.projections.get("TE2boundary")!.stats.targets ?? 0;
    assert.ok(t2 > 20, `v2 baseline sanity: ${t2}`);
    const lossFrac = (t2 - t3) / t2;
    assert.ok(lossFrac < 0.45, `boundary incumbent cliffed: ${t2.toFixed(1)} -> ${t3.toFixed(1)} (${(lossFrac * 100).toFixed(0)}% loss)`);
    // and the rookie still earns a real role
    assert.ok((v3.projections.get(rookieId)!.stats.targets ?? 0) > 20);
  });
});
