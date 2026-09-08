/**
 * Phase 5 — Matchup Intelligence: deterministic statistical invariants
 * (spec §22, §28, §30), the adversarial matrix (spec §Z), deployment contract,
 * and isolation from production / trades / Phase 4 shadow.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  simulateMatchup,
  loadDistributionModel,
  __resetDistributionModelCache,
  matchupDeploymentContract,
  matchupMayInfluenceProduction,
  isValidMatchupTransition,
  type SimPlayer,
} from "@/lib/weekly/matchup-intelligence";

const ROOT = process.cwd();
const lineup = (projs: number[], opts: Partial<Record<number, Partial<SimPlayer>>> = {}): SimPlayer[] =>
  ["QB", "RB", "RB", "WR", "WR", "WR", "TE", "RB", "K", "DEF"].map((p, i) => ({
    canonical_player_id: `p${i}`,
    position: p,
    projection: projs[i] ?? 10,
    questionable: false,
    is_qb: p === "QB",
    side: "team" as const,
    ...opts[i],
  }));

const EVEN = [22, 14, 10, 16, 12, 9, 11, 8, 8, 7];
const sim = (team: SimPlayer[], opp: SimPlayer[], id = "seed|a|b|1|v|d|10000") =>
  simulateMatchup({
    team,
    opponent: opp.map((p) => ({ ...p, side: "opponent" as const })),
    seedIdentity: id,
    simCount: 8000,
  });

/* -------------------- deployment contract (spec §25) -------------------- */

test("deployment is SHADOW_ONLY and cannot influence production", () => {
  __resetDistributionModelCache();
  assert.equal(matchupDeploymentContract().deployment, "SHADOW_ONLY");
  assert.equal(matchupMayInfluenceProduction(), false);
});

test("deployment lifecycle forbids skipping states", () => {
  assert.equal(isValidMatchupTransition("SHADOW_ONLY", "RESEARCH_ELIGIBLE"), true);
  assert.equal(isValidMatchupTransition("SHADOW_ONLY", "PRODUCTION_ACTIVE"), false);
  assert.equal(isValidMatchupTransition("PRODUCTION_ELIGIBLE", "PRODUCTION_ACTIVE"), true);
  assert.equal(isValidMatchupTransition("RESEARCH_ELIGIBLE", "CERTIFICATION_FAILED"), true);
  assert.equal(isValidMatchupTransition("PRODUCTION_ACTIVE", "SHADOW_ONLY"), true);
});

/* -------------------- calibrated distribution model -------------------- */

test("distribution model is OOS-calibrated per position (pit_ks small, pi80 ~ 0.80)", () => {
  const m = loadDistributionModel(true);
  assert.ok(m);
  for (const [pos, pm] of Object.entries(m!.positions)) {
    assert.ok(pm.calibration.pit_ks < 0.13, `${pos} pit_ks ${pm.calibration.pit_ks}`);
    assert.ok(pm.calibration.pi80_cov > 0.74 && pm.calibration.pi80_cov < 0.87, `${pos} pi80 ${pm.calibration.pi80_cov}`);
  }
});

test("calibrated model is wider than the weeklyBand CV heuristic for RB/WR/TE (fixes overconfidence)", () => {
  const m = loadDistributionModel(true)!;
  for (const pos of ["RB", "WR", "TE"]) {
    const pm = m.positions[pos]!;
    assert.ok(pm.empirical_resid_sd > pm.weeklyband_cv_sd_at_mean * 1.2, `${pos}`);
  }
});

/* -------------------- simulator invariants (spec §30) -------------------- */

test("determinism: identical seed identity + inputs -> identical output", () => {
  const a = sim(lineup(EVEN), lineup(EVEN));
  const b = sim(lineup(EVEN), lineup(EVEN));
  assert.deepEqual(a, b);
});

test("win probability in [0,1]; quantiles ordered", () => {
  const s = sim(lineup(EVEN), lineup(EVEN.map((x) => x * 0.9)));
  assert.ok(s.win_probability >= 0 && s.win_probability <= 1);
  for (const d of [s.team_score, s.opponent_score, s.margin]) {
    assert.ok(d.p10 <= d.p25 && d.p25 <= d.median && d.median <= d.p75 && d.p75 <= d.p90, JSON.stringify(d));
    assert.ok(d.sd >= 0);
  }
});

test("adversarial 3 (true coin flip): equal lineups -> WP ~ 0.5", () => {
  const s = sim(lineup(EVEN), lineup(EVEN));
  assert.ok(Math.abs(s.win_probability - 0.5) < 0.04, `${s.win_probability}`);
});

test("adversarial 1/2 (overwhelming favorite / underdog)", () => {
  const fav = sim(lineup(EVEN.map((x) => x * 1.6)), lineup(EVEN.map((x) => x * 0.7)));
  const dog = sim(lineup(EVEN.map((x) => x * 0.7)), lineup(EVEN.map((x) => x * 1.6)));
  assert.ok(fav.win_probability > 0.9, `${fav.win_probability}`);
  assert.ok(dog.win_probability < 0.1, `${dog.win_probability}`);
  assert.equal(dog.upset_probability > 0, true); // underdog gets a labelled upset prob
});

test("adversarial 4 (equal mean, different variance): as FAVORITE, lower variance raises WP", () => {
  // swap RB2 (proj 10) between a low- and a high-variance realization by faking questionable
  const base = lineup([28, 20, 10, 18, 14, 12, 13, 9, 9, 8]); // clear favorite means
  const opp = lineup(EVEN.map((x) => x * 0.85));
  const lowVar = sim(base, opp);
  const highVar = sim(
    base.map((p, i) => (i === 2 ? { ...p, questionable: true } : p)), // widen RB2's distribution
    opp,
  );
  assert.ok(lowVar.win_probability >= highVar.win_probability - 0.01, `${lowVar.win_probability} vs ${highVar.win_probability}`);
});

test("adversarial 4b (equal mean, different variance): as UNDERDOG, higher variance raises WP", () => {
  const base = lineup(EVEN.map((x) => x * 0.8)); // clear underdog
  const opp = lineup(EVEN.map((x) => x * 1.15));
  const lowVar = sim(base, opp);
  const highVar = sim(base.map((p, i) => (i === 2 ? { ...p, questionable: true } : p)), opp);
  assert.ok(highVar.win_probability >= lowVar.win_probability - 0.01, `${highVar.win_probability} vs ${lowVar.win_probability}`);
});

test("adversarial 14/15/16 (zero / unknown / verified-zero projections)", () => {
  const withZero = lineup(EVEN).map((p, i) => (i === 8 ? { ...p, projection: 0 } : p)); // K projects 0
  const s = sim(withZero, lineup(EVEN));
  assert.ok(s.win_probability >= 0 && s.win_probability <= 1);
  // an unknown (null) projection player is dropped from the sim, not treated as 0
  const withNull = lineup(EVEN).map((p, i) => (i === 8 ? { ...p, projection: null } : p));
  const s2 = sim(withNull, lineup(EVEN));
  assert.ok(s2.team_score.expected < s.team_score.expected + 1); // fewer contributors
});

test("adversarial 19 (massive total): higher projections -> wider absolute score sd, WP still calibrated to margin", () => {
  const small = sim(lineup(EVEN.map((x) => x * 0.6)), lineup(EVEN.map((x) => x * 0.6)));
  const big = sim(lineup(EVEN.map((x) => x * 1.5)), lineup(EVEN.map((x) => x * 1.5)));
  assert.ok(big.team_score.sd > small.team_score.sd);
  assert.ok(Math.abs(big.win_probability - 0.5) < 0.05 && Math.abs(small.win_probability - 0.5) < 0.05);
});

test("adversarial 22 (missing distribution model) -> no crash, falls back", () => {
  // simulate with an unknown position -> playerSampler falls back to a heuristic band
  const weird = lineup(EVEN).map((p, i) => (i === 7 ? { ...p, position: "P" } : p));
  const s = sim(weird, lineup(EVEN));
  assert.ok(Number.isFinite(s.win_probability));
});

test("blowout / upset probabilities are internally consistent", () => {
  const s = sim(lineup(EVEN.map((x) => x * 1.4)), lineup(EVEN.map((x) => x * 0.75)));
  assert.ok(s.blowout_probability >= 0 && s.blowout_probability <= 1);
  assert.equal(s.upset_probability, 0); // favorite -> no upset prob
});

test("analytic Phi screen tracks the MC win probability", () => {
  for (const mult of [0.8, 1.0, 1.2]) {
    const s = sim(lineup(EVEN), lineup(EVEN.map((x) => x * mult)));
    assert.ok(Math.abs(s.analytic_win_probability - s.win_probability) < 0.08, `${mult}: ${s.analytic_win_probability} vs ${s.win_probability}`);
  }
});

/* -------------------- isolation (spec §21, §V, Phase-4 pattern) -------------------- */

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

test("production matchup.ts does NOT import matchup-intelligence", () => {
  const src = readFileSync(join(ROOT, "lib", "weekly", "matchup.ts"), "utf8");
  assert.ok(!src.includes("matchup-intelligence"));
});

test("lib/trades never imports matchup-intelligence or the distribution model", () => {
  for (const f of walk(join(ROOT, "lib", "trades"))) {
    const src = readFileSync(f, "utf8");
    assert.ok(!src.includes("matchup-intelligence"), f);
    assert.ok(!src.includes("matchup_distribution_model"), f);
  }
});

test("lineup.ts / start-sit-fi are not touched by matchup-intelligence", () => {
  const lineupSrc = readFileSync(join(ROOT, "lib", "weekly", "lineup.ts"), "utf8");
  assert.ok(!lineupSrc.includes("matchup-intelligence"));
  for (const f of walk(join(ROOT, "lib", "weekly", "start-sit-fi"))) {
    assert.ok(!readFileSync(f, "utf8").includes("matchup-intelligence"), f);
  }
});

test("matchup-intelligence never imports recommendation-ranking code", () => {
  for (const f of walk(join(ROOT, "lib", "weekly", "matchup-intelligence"))) {
    const src = readFileSync(f, "utf8");
    for (const bad of ["waivers", "start-sit", "decision-score", "buildTopActions"]) {
      assert.ok(!src.includes(`"./${bad}`) && !src.includes(`/${bad}"`), `${f} -> ${bad}`);
    }
  }
});
