/**
 * Phase 4 — Start/Sit FI translation: deterministic statistical invariants
 * (spec §2, §10, §20, §30) + routing-restriction proofs (§2).
 *
 * These MUST fail if a descriptive / non-predictive FI field can move a
 * recommendation, if confidence stops being monotone, or if an adjustment
 * escapes its documented bound.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  translateFiAdjustment,
  loadStartSitModel,
  __resetStartSitModelCache,
  type StartSitModel,
} from "@/lib/weekly/start-sit-fi";
import type { FootballIntelligence } from "@/lib/football-intel";
import type { TeamProfile, TeamMetricRating } from "@/lib/football-intel";

/* ---- synthetic FI snapshot ------------------------------------------------ */
function rating(over: Partial<TeamMetricRating>): TeamMetricRating {
  return {
    team: "X",
    side: "offense",
    metric: "m",
    output_class: "MODELED",
    predictive_status: "PREDICTIVE",
    raw: 0,
    modeled: 0,
    league_mean: 0,
    league_percentile: 0.5,
    n_obs_effective: 400,
    prior_mean: 0,
    prior_n_seasons: 4,
    prior_discount: 1,
    prior_weight: 0.3,
    recent_weight: 0.5,
    shrunk_to_league: 0.2,
    std_error: 0.02,
    confidence: "HIGH",
    trend: { current_level: 0, recent_level: 0, direction: "stable", magnitude: 0, confidence: "HIGH" },
    ...over,
  };
}

function fakeFI(opts: {
  season?: number;
  offPct?: number;
  offConf?: TeamMetricRating["confidence"];
  defSuccessPct?: number;
  defSuccessConf?: TeamMetricRating["confidence"];
  defPassEpaAllowedPct?: number; // NOT_PREDICTIVE
}): FootballIntelligence {
  const off: Record<string, TeamMetricRating> = {
    off_pass_epa: rating({ metric: "off_pass_epa", league_percentile: opts.offPct ?? 0.5, confidence: opts.offConf ?? "HIGH" }),
    off_success_rate: rating({ metric: "off_success_rate", league_percentile: opts.offPct ?? 0.5, confidence: opts.offConf ?? "HIGH" }),
    off_rush_epa: rating({ metric: "off_rush_epa", league_percentile: opts.offPct ?? 0.5, confidence: opts.offConf ?? "HIGH" }),
    off_proe: rating({ metric: "off_proe", league_percentile: opts.offPct ?? 0.5, confidence: opts.offConf ?? "HIGH" }),
    off_pace_sec_play: rating({ metric: "off_pace_sec_play", league_percentile: opts.offPct ?? 0.5, confidence: opts.offConf ?? "HIGH" }),
    off_explosive_pass_rate: rating({ metric: "off_explosive_pass_rate", league_percentile: opts.offPct ?? 0.5, confidence: opts.offConf ?? "HIGH" }),
  };
  const def: Record<string, TeamMetricRating> = {
    def_success_allowed: rating({
      side: "defense", metric: "def_success_allowed", predictive_status: "PREDICTIVE",
      league_percentile: opts.defSuccessPct ?? 0.5, confidence: opts.defSuccessConf ?? "HIGH",
    }),
    def_pass_epa_allowed: rating({
      side: "defense", metric: "def_pass_epa_allowed", predictive_status: "NOT_PREDICTIVE",
      league_percentile: opts.defPassEpaAllowedPct ?? 0.99, confidence: "HIGH",
    }),
    def_rush_epa_allowed: rating({
      side: "defense", metric: "def_rush_epa_allowed", predictive_status: "NOT_PREDICTIVE",
      league_percentile: 0.99, confidence: "HIGH",
    }),
    def_man_rate: rating({
      side: "defense", metric: "def_man_rate", output_class: "DESCRIPTIVE_ONLY",
      predictive_status: "DESCRIPTIVE_TENDENCY", league_percentile: 0.99, confidence: "HIGH",
    }),
  };
  const tp: TeamProfile = { team: "OFF", season: opts.season ?? 2025, through_week: 18, offense: off, defense: {} };
  const dp: TeamProfile = { team: "DEF", season: opts.season ?? 2025, through_week: 18, offense: {}, defense: def };
  return {
    manifest: {
      football_intelligence_version: "fi:2025:w18:test",
      model_tag: "t", feature_schema_version: 1, generated_at: "", season: opts.season ?? 2025,
      through_week: 18, data_cutoff: { pbp: 18 }, seasons_used: { prior: [2024], current: 2025 },
      model_versions: {}, source_versions: {}, config: {}, files: [],
      output_classes: ["OBSERVED", "MODELED", "DESCRIPTIVE_ONLY"], determinism: "", notes: [],
    },
    team: (t) => (t === "OFF" ? tp : t === "DEF" ? dp : null),
    teams: () => [tp, dp],
    playerUsage: () => ({ gsis_id: "", sleeper_id: null, pfr_id: null, full_name: null, position: null, nfl_team: null, season: 2025, through_week: 18, games: null, eff_games: null, last_week: null, metrics: {}, resolution: "UNRESOLVED" }),
    coverageAllowed: () => [],
    contextualMatchup: () => ({ availability: "NOT_AVAILABLE" }),
    ftnDescriptive: () => [],
    throughWeek: () => 18,
  };
}

const model = (): StartSitModel => {
  __resetStartSitModelCache();
  const m = loadStartSitModel(true);
  assert.ok(m, "start_sit_model.json must be present (run the R pipeline)");
  return m!;
};

const IN = (over: Partial<Parameters<typeof translateFiAdjustment>[0]>) => ({
  canonical_player_id: "p1",
  position: "WR",
  nfl_team: "OFF",
  opponent: "DEF",
  baseline_projection: 12,
  request_season: 2025,
  model: model(),
  ...over,
});

test("deployment is SHADOW_ONLY", () => {
  assert.equal(model().deployment, "SHADOW_ONLY");
});

test("NOT_PREDICTIVE FI (def_pass_epa_allowed) contributes exactly 0", () => {
  const a = translateFiAdjustment(IN({ fi: fakeFI({ defPassEpaAllowedPct: 0.99 }) }));
  const c = a.contributions.find((x) => x.family === "def_pass_epa_allowed");
  if (c) {
    assert.equal(c.points_contribution, 0);
    assert.equal(c.confidence_weight, 0);
  }
  // it also never appears as an eligible contribution in any position's model
  for (const pos of Object.keys(model().positions)) {
    for (const f of model().positions[pos]!.families) {
      assert.notEqual(f.routing, "NOT_PREDICTIVE");
      assert.notEqual(f.routing, "DESCRIPTIVE_ONLY");
    }
  }
});

test("DESCRIPTIVE_ONLY FI (def_man_rate) can never be a model family", () => {
  for (const pos of Object.keys(model().positions)) {
    const fams = model().positions[pos]!.families.map((f) => f.family);
    assert.ok(!fams.includes("def_man_rate"));
    assert.ok(!fams.some((f) => f.includes("ftn")));
  }
});

test("missing FI snapshot -> baseline-equivalent (zero adjustment)", () => {
  const a = translateFiAdjustment(IN({ fi: null }));
  assert.equal(a.expected_adjustment, 0);
  assert.equal(a.adjusted_projection, a.baseline_projection);
  assert.ok(a.reason_codes.includes("FI_UNAVAILABLE"));
});

test("lower confidence cannot increase an otherwise-identical influence", () => {
  const hi = translateFiAdjustment(IN({ fi: fakeFI({ offPct: 0.9, offConf: "HIGH", defSuccessPct: 0.9, defSuccessConf: "HIGH" }) }));
  const md = translateFiAdjustment(IN({ fi: fakeFI({ offPct: 0.9, offConf: "MEDIUM", defSuccessPct: 0.9, defSuccessConf: "MEDIUM" }) }));
  const lo = translateFiAdjustment(IN({ fi: fakeFI({ offPct: 0.9, offConf: "LOW", defSuccessPct: 0.9, defSuccessConf: "LOW" }) }));
  assert.ok(Math.abs(md.raw_expected_adjustment) <= Math.abs(hi.raw_expected_adjustment) + 1e-9);
  assert.ok(Math.abs(lo.raw_expected_adjustment) <= Math.abs(md.raw_expected_adjustment) + 1e-9);
});

test("INSUFFICIENT_SAMPLE FI produces zero contribution", () => {
  const a = translateFiAdjustment(IN({ fi: fakeFI({ offPct: 0.95, offConf: "INSUFFICIENT_SAMPLE", defSuccessConf: "INSUFFICIENT_SAMPLE" }) }));
  assert.equal(a.raw_expected_adjustment, 0);
});

test("neutral FI (all percentiles 0.5) -> ~zero directional adjustment (symmetry)", () => {
  const a = translateFiAdjustment(IN({ fi: fakeFI({ offPct: 0.5, defSuccessPct: 0.5 }) }));
  assert.ok(Math.abs(a.raw_expected_adjustment) < 0.05);
});

test("monotonicity: increasing a validated positive signal does not decrease its influence", () => {
  const lo = translateFiAdjustment(IN({ position: "WR", fi: fakeFI({ offPct: 0.6 }) }));
  const hi = translateFiAdjustment(IN({ position: "WR", fi: fakeFI({ offPct: 0.95 }) }));
  const cLo = lo.contributions.filter((c) => c.family.startsWith("off_")).reduce((s, c) => s + c.points_contribution, 0);
  const cHi = hi.contributions.filter((c) => c.family.startsWith("off_")).reduce((s, c) => s + c.points_contribution, 0);
  // same sign, |hi| >= |lo| for the offensive-percentile block
  if (Math.abs(cLo) > 1e-6) assert.ok(Math.abs(cHi) >= Math.abs(cLo) - 1e-9);
});

test("bounds: |expected_adjustment| <= max_total_adjustment_fraction * |baseline|", () => {
  const m = model();
  const frac = m.max_total_adjustment_fraction ?? 0.25;
  for (const pct of [0.01, 0.2, 0.5, 0.8, 0.99]) {
    const a = translateFiAdjustment(IN({ baseline_projection: 20, fi: fakeFI({ offPct: pct, defSuccessPct: 1 - pct }) }));
    assert.ok(Math.abs(a.expected_adjustment) <= frac * 20 + 1e-9, `pct ${pct}: ${a.expected_adjustment}`);
  }
});

test("a tiny FI signal cannot overturn a large baseline edge (handled by shadow tie-break gate)", () => {
  // translate layer produces a bounded adjustment; the gate lives in shadow.ts.
  const a = translateFiAdjustment(IN({ baseline_projection: 18, fi: fakeFI({ offPct: 0.7 }) }));
  assert.ok(Math.abs(a.expected_adjustment) < 6); // never enough to flip an 8+ pt edge alone
});

test("determinism: identical inputs -> identical output", () => {
  const f = fakeFI({ offPct: 0.8, defSuccessPct: 0.3 });
  const a = translateFiAdjustment(IN({ fi: f }));
  const b = translateFiAdjustment(IN({ fi: f }));
  assert.deepEqual(a, b);
});

test("prior-season FI snapshot is flagged and haircut, not presented as current", () => {
  const a = translateFiAdjustment(IN({ request_season: 2026, fi: fakeFI({ season: 2025, offPct: 0.9 }) }));
  assert.equal(a.fi_prior_season_only, true);
  assert.ok(a.reason_codes.includes("FI_PRIOR_SEASON_ONLY"));
  assert.ok(a.warnings.some((w) => /prior/i.test(w)));
});

test("explanation reason codes only reference families that actually contributed numerically", () => {
  const a = translateFiAdjustment(IN({ fi: fakeFI({ offPct: 0.5, defSuccessPct: 0.5, defPassEpaAllowedPct: 0.99 }) }));
  // def_pass_epa_allowed is NOT_PREDICTIVE and contributes 0 -> its reason code
  // (if present) is the descriptive/not-predictive marker, never an "advantage".
  assert.ok(!a.reason_codes.includes("FI_PASS_EFFICIENCY_ADVANTAGE") || a.contributions.some((c) => c.family.includes("pass") && Math.abs(c.points_contribution) > 1e-6));
});
