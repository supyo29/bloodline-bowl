/**
 * W2.P1 — Role & Opportunity offline qualification: protocol integrity, point-in-time / hindsight audits, double-count decomposition, applicability,
 * and the research/production boundary. These tests load DEV and VAL rows ONLY: the FINAL split is never read here (it is scored exactly once by
 * `scripts/role-qualification.ts final`).
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { buildWorld, c1Of, c2Of, decisions, fitRidge, opportunityAccuracy, paired, PREREG_PATH, preregSha, RAW_SCORING, ROLE_FREE, SPLIT_WEEKS, b1Of, injuryExpected, FEATURES, type Row } from "../scripts/lib/role-qualification";
import { parseObservedCsv, parseProfileCsv, loadInjuryReports } from "../lib/role-calibration/data";
import { buildHistoricalForecasts } from "../lib/game-distribution/fit";
import { ewma } from "../lib/role-calibration/volume";
import { assertPointInTime } from "../lib/role-calibration/forecast";
import { ROLE_SHADOW_CONF_WEIGHT, shadowCandidate } from "../lib/role-calibration/shadow";
import { METRICS_BY_POSITION } from "../lib/role-calibration/types";
import { evaluateInjuryModel } from "../lib/weekly/forecast/injury-model";

const ROOT = join(__dirname, "..");
const D = "lib/game-distribution/data/";
const prereg = JSON.parse(readFileSync(join(ROOT, PREREG_PATH), "utf8"));
const world = buildWorld(["DEV", "VAL"]);

describe("W2.P1 protocol integrity (pre-registration)", () => {
  it("splits are disjoint, ordered in time, and FINAL is the latest", () => {
    const all = [...SPLIT_WEEKS.DEV, ...SPLIT_WEEKS.VAL, ...SPLIT_WEEKS.FINAL];
    assert.equal(new Set(all).size, all.length);
    assert.deepEqual(all, [...all].sort((a, b) => a - b));
    assert.deepEqual(prereg.splits.FINAL.weeks, [...SPLIT_WEEKS.FINAL]);
  });
  it("thresholds are declared in the pre-registration, including the Role-specific increment over the Role-free control", () => {
    for (const k of ["T1_coverage_and_n", "T2_mae", "T2b_role_specific_increment", "T3_rmse", "T4_bias", "T5_consistency", "T6_decisions", "T7_tiers", "T8_injury_and_cap", "T9_leakage", "T10_robustness"]) assert.ok(prereg.promotion_thresholds_G2[k], k);
    assert.ok(prereg.candidates.C0 && prereg.candidates.C2 && prereg.candidates.C1);
    assert.ok(prereg.pending_live_gates.length >= 4, "the live/staging gates are explicitly pending");
  });
  it("the freeze (if present) pins this exact pre-registration; a changed threshold would invalidate FINAL", () => {
    const fz = join(ROOT, "scripts/w2p1/FROZEN.json");
    if (!existsSync(fz)) return;
    assert.equal(JSON.parse(readFileSync(fz, "utf8")).prereg_sha256, preregSha());
  });
  it("this test file never loaded a FINAL row", () => {
    assert.ok(world.rows.every((r) => r.split !== "FINAL" && !SPLIT_WEEKS.FINAL.includes(r.week)));
  });
});

describe("W2.P1 point-in-time and hindsight audit", () => {
  it("every eligible row passes the structural contract (input game strictly before target week)", () => {
    assert.ok(world.rows.length > 2000);
    assert.deepEqual(world.pointInTimeViolations, []);
    assert.deepEqual(world.rows.flatMap((r) => assertPointInTime({ ...r.forecast, kickoff_at: null })), []);
  });

  it("the committed 2025 as-of profiles are reproducible from strictly-earlier games ONLY: EWMA over weeks < target matches; including the target week does not (the check has teeth)", () => {
    // replaces the real-data audits in test/role-calibration.test.ts, which currently fail on the committed 2026 refresh (profiles exist only for target weeks 5-6)
    const observed = parseObservedCsv(readFileSync(join(ROOT, D, "observed_role_game_2025.csv"), "utf8")).filter((o) => o.season === 2025);
    const profiles = parseProfileCsv(readFileSync(join(ROOT, D, "role_profile_asof_2025.csv"), "utf8")).filter((p) => SPLIT_WEEKS.DEV.includes(p.target_week) && p.target_week >= 7 && p.position === "WR" && (p.metrics.target_share?.n_games ?? 0) >= 5);
    const byPlayer = new Map<string, typeof observed>();
    for (const o of observed) (byPlayer.get(o.gsis_id) ?? byPlayer.set(o.gsis_id, []).get(o.gsis_id)!).push(o);
    const before: number[] = [], withTarget: number[] = [];
    let closer = 0;
    for (const p of profiles) {
      const rows = (byPlayer.get(p.gsis_id) ?? []).sort((a, b) => a.week - b.week);
      const csv = p.metrics.target_share!.recent; const hasTarget = rows.some((o) => o.week === p.target_week && o.target_share != null);
      if (csv == null || !hasTarget) continue;
      const b = Math.abs(ewma(rows.filter((o) => o.week < p.target_week).map((o) => o.target_share))! - csv);
      const w = Math.abs(ewma(rows.filter((o) => o.week <= p.target_week).map((o) => o.target_share))! - csv);
      before.push(b); withTarget.push(w); if (b <= w) closer++;
    }
    const med = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]!;
    assert.ok(before.length >= 80, `n=${before.length}`);
    assert.ok(med(before) < med(withTarget) / 3, `median deviation strictly-before ${med(before)} vs with-target ${med(withTarget)}`);
    assert.ok(closer / before.length >= 0.8, `strictly-before is the closer reconstruction for ${closer}/${before.length}`);
  });

  it("ADVERSARIAL: poisoning the target week and every later week's observed outcomes leaves the Role forecasts byte-identical", () => {
    const observed = parseObservedCsv(readFileSync(join(ROOT, D, "observed_role_game_2025.csv"), "utf8")).filter((o) => o.season === 2025);
    const profiles = parseProfileCsv(readFileSync(join(ROOT, D, "role_profile_asof_2025.csv"), "utf8")).filter((p) => p.target_week === 8 && ["RB", "WR", "TE", "QB"].includes(p.position));
    const injuries = loadInjuryReports();
    const a = buildHistoricalForecasts({ season: 2025, profiles, observed, injuries, weeks: [8] });
    const poisoned = observed.map((o) => (o.week >= 8 ? { ...o, snap_share: 1, target_share: 0.99, rush_share: 0.99, targets: 60, carries: 60, dropbacks: 200, team_pass_att: 500, team_rush_att: 500, team_rz_pass_att: 90, team_rz_rush_att: 90, offensive_snaps: 99 } : o));
    const b = buildHistoricalForecasts({ season: 2025, profiles, observed: poisoned, injuries, weeks: [8] });
    assert.ok(a.length > 200);
    assert.deepEqual(b.map((f) => f.forecast_id), a.map((f) => f.forecast_id));
    assert.deepEqual(b.map((f) => f.opportunity), a.map((f) => f.opportunity));
  });

  it("the oracle control (target-game actual opportunity as features) is a LEAK: it wins big, proving the harness would see a leak if one existed", () => {
    const dev = world.rows.filter((r) => r.split === "DEV"), val = world.rows.filter((r) => r.split === "VAL" && r.designation !== "OUT" && r.position === "WR");
    const m = fitRidge(dev, "WR", "HALF", 100)!;
    const mo = fitRidge(dev, "WR", "HALF", 100, FEATURES.WR, "oracle")!; // fitted exactly like C2, but on the target game's own actual opportunity
    const honest = paired(val, (r) => b1Of(r, "HALF"), (r) => c2Of(r, m, "HALF").expected, "HALF", 50).dMAE;
    const oracle = paired(val, (r) => b1Of(r, "HALF"), (r) => c2Of(r, mo, "HALF", "oracle").expected, "HALF", 50).dMAE;
    assert.ok(oracle > honest + 0.3, `oracle ${oracle} vs honest ${honest}`);
  });

  it("Role features are exactly the as-of forecast's quantities (never the target game's own opportunity)", () => {
    const r = world.rows.filter((x) => x.position === "WR" && x.played).slice(0, 200);
    assert.ok(r.length > 50);
    let differs = 0;
    for (const row of r) {
      assert.equal(row.x.exp_targets, row.forecast.opportunity.targets);
      assert.equal(row.x.snap_share, row.forecast.metrics.snap_share?.value ?? null);
      if (row.actual_opp.targets != null && row.x.exp_targets !== row.actual_opp.targets) differs++;
    }
    assert.ok(differs / r.length > 0.9, "forecast opportunity is not the realized opportunity");
  });

  it("a team on BYE has no outcome to forecast: no eligible row belongs to a team without a game that week (the schedule is known pre-game)", () => {
    const observed = parseObservedCsv(readFileSync(join(ROOT, D, "observed_role_game_2025.csv"), "utf8")).filter((o) => o.season === 2025);
    const plays = new Set(observed.map((o) => `${o.week}|${o.team}`));
    assert.ok(world.rows.every((r) => plays.has(`${r.week}|${r.team}`)));
    assert.ok(world.counts.bye_week! > 0, "byes exist in the profiled population and were excluded");
  });

  it("the harness uses no Sleeper/provider identifier anywhere (NFL gsis identity only)", () => {
    const src = readFileSync(join(ROOT, "scripts/lib/role-qualification.ts"), "utf8");
    assert.ok(!/sleeper_id|yahoo_id|provider_player_id/.test(src.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "")));
  });
});

describe("W2.P1 injury / source double-count decomposition", () => {
  const pick = (pred: (r: Row) => boolean) => world.rows.find(pred)!;
  const dev = world.rows.filter((r) => r.split === "DEV");
  const model = fitRidge(dev, "WR", "HALF", 100)!;

  it("C2 never touches OUT players: the delta is exactly 0 and the expected value is the champion's known zero", () => {
    const outs = world.rows.filter((r) => r.designation === "OUT");
    assert.ok(outs.length > 30);
    for (const r of outs) { const c = c2Of(r, model, "HALF"); assert.equal(c.delta, 0); assert.equal(c.expected, b1Of(r, "HALF")); }
  });

  it("availability is applied exactly ONCE: C2 expected == the production injury model applied to (B0p + delta); the delta itself carries no availability term", () => {
    const rows = world.rows.filter((r) => r.position === "WR" && (r.designation === "QUESTIONABLE" || r.designation === "DOUBTFUL")).slice(0, 40);
    assert.ok(rows.length >= 10);
    for (const r of rows) {
      const c = c2Of(r, model, "HALF");
      const direct = evaluateInjuryModel({ source_status: r.raw_status, position: r.position, source_points: r.b0.HALF + c.delta, practice: r.practice, source_semantics: "CONDITIONAL_ON_ACTIVE" }).injury_adjusted_expected_points;
      assert.equal(c.expected, direct);
      // same features, healthy designation => the SAME delta (the delta does not depend on the designation at all)
      const healthyTwin: Row = { ...r, designation: "NONE", raw_status: null };
      assert.equal(c2Of(healthyTwin, model, "HALF").delta, c.delta);
    }
  });

  it("the EXISTING shadow (C1) double-discounts availability on an injury-adjusted baseline; C2 does not", () => {
    // C1 as written: candidate = baseline + k*cw*((1-p_absent)*xFP - baseline). Applied on B1p (already x P(active)), a Doubtful player is discounted twice.
    const baseline = 10, xfp = 10;
    const noInjury = shadowCandidate({ baseline, xfp_forecast: xfp, xfp_no_pressure: xfp, p_absent: 0, confidence: "MEDIUM" }).role_adjustment;
    const doubtful = shadowCandidate({ baseline, xfp_forecast: xfp, xfp_no_pressure: xfp, p_absent: 0.75, confidence: "MEDIUM" }).role_adjustment;
    assert.equal(noInjury, 0, "an xFP equal to the baseline asks for no change");
    assert.ok(doubtful < -0.5, `the same agreement now demands ${doubtful}: that is the availability discount repeated on top of the injury model`);
    const r = pick((x) => x.position === "WR" && x.designation === "DOUBTFUL");
    assert.ok(c1Of(r, "HALF") != null);
  });

  it("opportunity features contain no touchdown or points information: a TD-spike game cannot enter C2 except through the (negatively weighted) baseline term", () => {
    for (const pos of ["QB", "RB", "WR", "TE"] as const) for (const f of FEATURES[pos]) assert.ok(f === "b0" || /^(exp_|snap_share|air_yards_share)/.test(f), f);
    const r = pick((x) => x.position === "WR" && x.designation === "NONE" && x.covered);
    const spiked: Row = { ...r, b0: { HALF: r.b0.HALF + 3, STD: r.b0.STD + 3, PPR: r.b0.PPR + 3 } };
    const noSpike = c2Of(r, model, "HALF").delta, spike = c2Of(spiked, model, "HALF").delta;
    assert.ok(model.coef[model.features.indexOf("b0")]! < 0, "regression-to-the-mean: a higher baseline lowers the correction");
    assert.ok(spike <= noSpike + 1e-9, `a TD-inflated baseline never RAISES the Role adjustment (${noSpike} -> ${spike})`);
  });

  it("the Role-free control C0 exists and uses the baseline only", () => {
    const c0 = fitRidge(dev, "WR", "HALF", 100, ROLE_FREE)!;
    assert.deepEqual([...c0.features], ["b0"]);
  });
});

describe("W2.P1 applicability, shrinkage and missing data", () => {
  const dev = world.rows.filter((r) => r.split === "DEV");
  const model = fitRidge(dev, "RB", "HALF", 10)!;
  const covered = () => world.rows.find((r) => r.position === "RB" && r.designation === "NONE" && r.covered)!;

  it("K and DST are not applicable: the population and the metric map contain no K/DEF", () => {
    assert.ok(world.rows.every((r) => ["QB", "RB", "WR", "TE"].includes(r.position)));
    assert.deepEqual(Object.keys(METRICS_BY_POSITION).sort(), ["QB", "RB", "TE", "WR"]);
  });
  it("missing Role evidence is NEUTRAL (delta 0, champion value), never zero and never stale", () => {
    const r = covered();
    const uncovered: Row = { ...r, covered: false };
    assert.equal(c2Of(uncovered, model, "HALF").delta, 0);
    assert.equal(c2Of(uncovered, model, "HALF").expected, b1Of(r, "HALF"));
    const missingFeature: Row = { ...r, x: { ...r.x, exp_carries: null } };
    const c = c2Of(missingFeature, model, "HALF");
    assert.equal(c.applicable, false); assert.equal(c.delta, 0); assert.ok(c.expected > 0, "not forced to zero");
    assert.equal(c2Of(r, null, "HALF").delta, 0);
  });
  it("confidence shrinks the adjustment (INSUFFICIENT = 0, LOW = 0.6, MEDIUM = 1) and the cap bounds it (max(1, 25% of the baseline))", () => {
    const r = covered();
    const base = c2Of({ ...r, conf: "MEDIUM" }, model, "HALF");
    const low = c2Of({ ...r, conf: "LOW" }, model, "HALF"), none = c2Of({ ...r, conf: "INSUFFICIENT_SAMPLE" }, model, "HALF");
    assert.ok(Math.abs(low.delta - 0.6 * base.delta) < 1e-9);
    assert.equal(none.delta, 0);
    assert.equal(ROLE_SHADOW_CONF_WEIGHT.LOW, 0.6);
    const huge: Row = { ...r, x: { ...r.x, exp_carries: 80, exp_targets: 40, exp_rz_carries: 20, exp_rz_targets: 10, snap_share: 1 } };
    const c = c2Of({ ...huge, conf: "MEDIUM" }, model, "HALF");
    assert.ok(c.capped);
    assert.ok(Math.abs(c.delta) <= Math.max(1, 0.25 * Math.abs(r.b0.HALF)) + 1e-9);
  });
  it("a one-game role SPIKE is shrunk: the feature is an EWMA over earlier games, so one anomalous game moves it by at most its weight", () => {
    // weight of the newest game in a half-life-2 EWMA over n games is 1/sum(0.5^(k/2)); with 5 games that is < 0.35
    const n = 5; const w = Array.from({ length: n }, (_, k) => Math.pow(0.5, k / 2));
    assert.ok(1 / w.reduce((a, b) => a + b, 0) < 0.36);
    assert.equal(ewma([0.1, 0.1, 0.1, 0.1, 0.5])! < 0.3, true);
  });
  it("raw scorings are the three declared ones; PPR > HALF > STD for the same reception-heavy line", () => {
    const pts = (s: keyof typeof RAW_SCORING) => RAW_SCORING[s].rec! * 8;
    assert.ok(pts("PPR") > pts("HALF") && pts("HALF") > pts("STD"));
  });
  it("opportunity accuracy is computed on players who played, against three naive baselines", () => {
    const acc = opportunityAccuracy(world.rows);
    assert.ok(acc.length === 5 && acc.every((a) => a.n > 100 && Number.isFinite(a.role_mae) && Number.isFinite(a.last_game_mae)));
  });
  it("decision pairs are same-team/same-position/same-week only", () => {
    const rows = world.rows.filter((r) => r.split === "VAL" && r.designation !== "OUT" && r.position === "WR");
    const d = decisions(rows, (r) => b1Of(r, "HALF"), (r) => injuryExpected(r, r.b0.HALF + 1), "HALF");
    assert.ok(d.pairs > 100);
    assert.equal(d.challenger_wins + d.champion_wins + d.ambiguous, d.disagreements);
  });
});

describe("W2.P1 research / production boundary", () => {
  const files = (dir: string): string[] => readdirSync(join(ROOT, dir)).flatMap((f) => { const p = join(dir, f); return statSync(join(ROOT, p)).isDirectory() ? files(p) : p.endsWith(".ts") || p.endsWith(".tsx") ? [p] : []; });
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  it("no production file (lib/, app/) imports the qualification harness or its frozen artifacts", () => {
    for (const f of [...files("lib"), ...files("app")]) {
      const src = strip(readFileSync(join(ROOT, f), "utf8"));
      assert.ok(!/role-qualification|scripts\/w2p1|w2p1\/FROZEN/.test(src), f);
    }
  });
  it("production forecast code still rejects Role as PRODUCTION (the guard was not deleted in this phase)", () => {
    const v = readFileSync(join(ROOT, "lib/weekly/forecast/validate.ts"), "utf8");
    assert.match(v, /ROLE_PROMOTED|_PROMOTED/);
    assert.match(v, /NON_BASE_PRODUCTION_CONTRIBUTION/);
  });
  it("the pre-registration file hash is stable text (sanity)", () => {
    assert.match(createHash("sha256").update(readFileSync(join(ROOT, PREREG_PATH))).digest("hex"), /^[0-9a-f]{64}$/);
  });
});
