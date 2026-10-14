import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { alertLevel, assertTimeSplit, bandOf, brier, brierSkill, breakoutVerdict, cohortStats, displayBreakout, isBreakout, logLoss, PRIMARY_TOP_N, shownProbability, tierOf, tierRate, topNCut, type GateInput } from "@/lib/w2r1/breakout";

describe("W2.R1 S6 labels, base rates and time split", () => {
  it("primary labels are position-specific and never pooled (TE/K/DST top-6, QB/RB/WR top-12)", () => {
    assert.deepEqual(PRIMARY_TOP_N, { QB: 12, RB: 12, WR: 12, TE: 6, K: 6, DST: 6 });
  });
  it("top-N cut includes ties and a non-player can never be a positive", () => {
    const scores = [30, 25, 20, 20, 18, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1];
    assert.equal(topNCut(scores, 4), 20); assert.equal(topNCut(scores, 6), 10); assert.equal(isBreakout("TE", 10, true, scores), true, "ties at the 6th value are included"); assert.equal(isBreakout("TE", 9, true, scores), false);
    assert.equal(isBreakout("QB", 30, false, scores), false, "did not play => label 0 (an outcome, not an exclusion)");
  });
  it("tier cohorts and the Laplace-smoothed base rate", () => { assert.equal(tierOf(12), "STARTER"); assert.equal(tierOf(11.9), "FLEX"); assert.equal(tierOf(5.9), "FRINGE"); assert.equal(tierRate(0, 0), 0.5); assert.ok(Math.abs(tierRate(3, 8) - 0.4) < 1e-12); });
  it("splits must be time-ordered: an overlapping (random-style) split is rejected", () => {
    assert.doesNotThrow(() => assertTimeSplit([{ season: 2024, week: 18 }], [{ season: 2025, week: 3 }]));
    assert.throws(() => assertTimeSplit([{ season: 2025, week: 9 }, { season: 2022, week: 3 }], [{ season: 2025, week: 3 }, { season: 2025, week: 12 }]), /time split violated/);
  });
});

describe("W2.R1 S6 small samples, unknowns and display discipline", () => {
  it("unknown model output or missing history goes to the BASE RATE, never to 0 and never to an extreme", () => {
    assert.equal(shownProbability(null, 0.2, 10), 0.2); assert.equal(shownProbability(0.9, 0.2, 0), 0.2);
    assert.ok(Math.abs(shownProbability(0.5, 0.2, 3) - (0.6 * 0.5 + 0.4 * 0.2)) < 1e-12); assert.equal(shownProbability(0.5, 0.2, 9), 0.5);
    assert.ok(shownProbability(0.0, 0.2, 9) >= 0.001);
  });
  it("a raw / uncalibrated score is never shown as a probability: only a VALIDATION CANDIDATE position may display one", () => {
    for (const v of ["DIAGNOSTIC ONLY", "NO RELIABLE BREAKOUT SIGNAL", "INSUFFICIENT SAMPLE"] as const) { const d = displayBreakout(v, 0.4, 0.12, { n: 38, events: 11 }); assert.equal(d.percent, null); assert.equal(d.band, null); assert.ok(!/%/.test(d.text)); }
    const ok = displayBreakout("VALIDATION CANDIDATE", 0.29, 0.12, { n: 38, events: 11 });
    assert.equal(ok.percent, 29); assert.match(ok.text, /Comparable situations: 38; breakouts: 11; empirical rate: 29%/); assert.match(ok.text, /position base rate 12%/); assert.equal(ok.band, "High");
  });
  it("alert thresholds are fixed multiples of the position base rate", () => { assert.equal(alertLevel(0.24, 0.12), "HIGH"); assert.equal(alertLevel(0.18, 0.12), "ELEVATED"); assert.equal(alertLevel(0.17, 0.12), "NONE"); assert.equal(bandOf(0.05, 0.12), "Low"); });
  it("cohort statistics include the NEGATIVE examples and the base rate", () => {
    const s = cohortStats([{ label: 1, tierExpected: 0.2 }, { label: 0, tierExpected: 0.2 }, { label: 0, tierExpected: 0.2 }, { label: 0, tierExpected: 0.2 }], 0.12);
    assert.equal(s.negatives, 3); assert.equal(s.positives, 1); assert.equal(s.rate, 0.25); assert.equal(s.baseRate, 0.12); assert.ok(Math.abs(s.liftOverBase - 0.25 / 0.12) < 1e-12); assert.ok(Math.abs(s.liftOverTierExpected - 1.25) < 1e-12);
  });
  it("Brier / log loss / skill arithmetic", () => { assert.ok(Math.abs(brier([0.5, 0.5], [1, 0]) - 0.25) < 1e-12); assert.ok(logLoss([0.9], [1]) < logLoss([0.6], [1])); assert.ok(Math.abs(brierSkill(0.09, 0.1) - 0.1) < 1e-12); });
});

describe("W2.R1 S6 gates are golden-linked to the recorded validation results", () => {
  const res = JSON.parse(readFileSync("scripts/w2r1/results/s6_val.json", "utf8")) as { positions: Record<string, { events_val: number; last_retained: string; verdict: string; ladder: Record<string, { brier_skill_vs_M0: number; boot_vs_M0: { lo95: number }; dLogLoss_vs_M0: number; calibration: { slope: number; ece: number; top_decile_lift: number; top_decile_events: number }; val_late: { brier_skill_vs_M0: number; logloss_gain_vs_M0: number } }> }> };
  for (const [pos, P] of Object.entries(res.positions)) {
    it(`${pos}: the gate function reproduces the harness verdict (${P.verdict})`, () => {
      const L = P.ladder[P.last_retained];
      const g: GateInput | null = L ? { events: P.events_val, skillVsBase: L.brier_skill_vs_M0, skillLo95: L.boot_vs_M0.lo95, logLossGain: L.dLogLoss_vs_M0, slope: L.calibration.slope, ece: L.calibration.ece, topDecileLift: L.calibration.top_decile_lift, topDecileEvents: L.calibration.top_decile_events, lateSkill: L.val_late.brier_skill_vs_M0, lateLogLossGain: L.val_late.logloss_gain_vs_M0 } : null;
      assert.equal(breakoutVerdict(g), P.verdict);
    });
  }
  it("gate thresholds are exactly the preregistered ones", () => {
    const base: GateInput = { events: 50, skillVsBase: 0.05, skillLo95: 0.001, logLossGain: 0.01, slope: 1, ece: 0.02, topDecileLift: 2, topDecileEvents: 12, lateSkill: 0.05, lateLogLossGain: 0.01 };
    assert.equal(breakoutVerdict(base), "VALIDATION CANDIDATE");
    assert.equal(breakoutVerdict({ ...base, events: 39 }), "INSUFFICIENT SAMPLE"); assert.equal(breakoutVerdict({ ...base, skillVsBase: 0.019 }), "NO RELIABLE BREAKOUT SIGNAL"); assert.equal(breakoutVerdict({ ...base, skillLo95: 0 }), "NO RELIABLE BREAKOUT SIGNAL");
    assert.equal(breakoutVerdict({ ...base, slope: 1.21 }), "DIAGNOSTIC ONLY"); assert.equal(breakoutVerdict({ ...base, slope: 0.79 }), "DIAGNOSTIC ONLY"); assert.equal(breakoutVerdict({ ...base, ece: 0.031 }), "DIAGNOSTIC ONLY");
    assert.equal(breakoutVerdict({ ...base, topDecileLift: 1.29 }), "DIAGNOSTIC ONLY"); assert.equal(breakoutVerdict({ ...base, topDecileEvents: 9 }), "DIAGNOSTIC ONLY"); assert.equal(breakoutVerdict({ ...base, lateSkill: 0.01 }), "DIAGNOSTIC ONLY");
  });
});

describe("W2.R1 S6 leakage controls (research harness structure + recorded poison results)", () => {
  it("the as-of window is strictly earlier and the label code runs AFTER features and reads no feature", () => {
    const src = readFileSync("scripts/w2r1/s6_build.R", "utf8");
    assert.equal(src.split("idx <- which(h$season < s | (h$season == s & h$week < w))").length - 1, 3, "player as-of, teammate shares and trend features must all be strictly earlier");
    assert.ok(!/which\(h\$season <= \d+\)/.test(src), "no season-wide (future-including) window");
    assert.ok(!/h\$week <= w/.test(src), "no <= target week anywhere");
    assert.ok(src.indexOf("player_asof <- function") < src.indexOf("# ---- labels (outcomes"), "features are defined before labels");
    const featBlock = src.slice(src.indexOf("player_asof <- function"), src.indexOf("Hs <- split(H"));
    assert.ok(!/lab_|actual\[|\$actual\b.*(idx\)|target)/.test(featBlock.replace(/h\$actual\[same\]/g, "").replace(/h\$actual/g, "")), "feature code must not touch label columns");
  });
  it("recorded poison tests passed (player 150/150, team 702/702, Tier-B 100/100) and no 2026 season was loaded", () => {
    const leak = JSON.parse(readFileSync("scripts/w2r1/results/s6_leak.json", "utf8")) as { player_asof_poison: { passed: number; total: number }; team_asof_poison: { passed: number; total: number }; tier_b_prior_season_only: { passed: number; total: number }; structural: { season_2026_loaded: boolean } };
    assert.equal(leak.player_asof_poison.passed, leak.player_asof_poison.total); assert.equal(leak.team_asof_poison.passed, leak.team_asof_poison.total); assert.equal(leak.tier_b_prior_season_only.passed, leak.tier_b_prior_season_only.total); assert.equal(leak.structural.season_2026_loaded, false);
  });
});
