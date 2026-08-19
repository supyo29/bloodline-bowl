/**
 * Scoring-engine tests.
 *
 * Uses a fixed, hand-picked scoring settings object (loosely modeled on
 * Bloodline Bowl's actual live settings) so the arithmetic assertions are
 * exact and stable regardless of future changes to the live league. Live
 * settings are exercised separately in `scoring-live.test.ts`.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { calculateFantasyPoints, roundPoints } from "../lib/scoring/calculate";
import { buildArchetypeExamples, ARCHETYPE_STAT_LINES } from "../lib/scoring/archetypes";
import { buildDiagnostics } from "../lib/scoring/diagnostics";
import {
  buildComparisons,
  buildDerivedDefense,
  buildDerivedKicking,
  buildDerivedPassing,
  buildDerivedReceiving,
  buildDerivedRushing,
  buildNormalizedRules,
  classifyScoring,
} from "../lib/scoring/normalize";
import { buildSensitivity } from "../lib/scoring/sensitivity";

/** Modeled on Bloodline Bowl's live settings at the time this was written. */
const SETTINGS: Record<string, number> = {
  pass_yd: 0.04,
  pass_td: 4,
  pass_int: -2,
  pass_sack: -1,
  pass_2pt: 2,
  rush_yd: 0.1,
  rush_td: 6,
  rush_2pt: 2,
  rec: 0.5,
  rec_yd: 0.1,
  rec_td: 6,
  rec_2pt: 2,
  fum_lost: -2,
  fum: 0,
  xpm: 1,
  xpmiss: -1,
  fgm: 3,
  fgmiss: -1,
  fgm_0_19: 0,
  fgm_20_29: 0,
  fgm_30_39: 0,
  fgm_40_49: 0,
  fgm_50_59: 0,
  fgm_60p: 0,
  sack: 1,
  int: 1,
  fum_rec: 1,
  ff: 1,
  safe: 2,
  blk_kick: 1,
  def_td: 6,
  pts_allow: -0.25,
  pts_allow_0: 0,
  pts_allow_1_6: 0,
  pts_allow_7_13: 0,
  pts_allow_14_20: 0,
  pts_allow_21_27: 0,
  pts_allow_28_34: 0,
  pts_allow_35p: 0,
};

describe("calculateFantasyPoints: worked examples from the spec", () => {
  it("scores 300 passing yards at pass_yd=0.04 as 12 points", () => {
    const result = calculateFantasyPoints({ pass_yd: 300 }, SETTINGS);
    assert.equal(result.fantasy_points, 12);
    assert.equal(result.breakdown[0]?.points, 12);
    assert.deepEqual(result.warnings, []);
  });

  it("scores 2 passing touchdowns at pass_td=4 as 8 points", () => {
    const result = calculateFantasyPoints({ pass_td: 2 }, SETTINGS);
    assert.equal(result.fantasy_points, 8);
  });

  it("applies interception penalties as negative points", () => {
    const result = calculateFantasyPoints({ pass_int: 1 }, SETTINGS);
    assert.equal(result.fantasy_points, -2);
    assert.equal(result.breakdown[0]?.points, -2);

    const two = calculateFantasyPoints({ pass_int: 2 }, SETTINGS);
    assert.equal(two.fantasy_points, -4);
  });

  it("scores 8 receptions at rec=1 (full PPR) as 8 points", () => {
    const fullPpr = { ...SETTINGS, rec: 1 };
    const result = calculateFantasyPoints({ rec: 8 }, fullPpr);
    assert.equal(result.fantasy_points, 8);
  });

  it("scores 8 receptions at rec=0.5 (half PPR) as 4 points", () => {
    const result = calculateFantasyPoints({ rec: 8 }, SETTINGS);
    assert.equal(result.fantasy_points, 4);
  });

  it("computes a complete stat line correctly", () => {
    // Pocket QB archetype: 300 pass_yd, 2 pass_td, 1 pass_int, 10 rush_yd.
    const result = calculateFantasyPoints(
      { pass_yd: 300, pass_td: 2, pass_int: 1, rush_yd: 10 },
      SETTINGS,
    );
    // 12 + 8 - 2 + 1 = 19
    assert.equal(result.fantasy_points, 19);
    assert.equal(result.breakdown.length, 4);
  });
});

describe("calculateFantasyPoints: unsupported keys", () => {
  it("warns on an unsupported stat key without breaking valid ones", () => {
    const result = calculateFantasyPoints(
      { pass_yd: 100, made_up_stat_xyz: 5 },
      SETTINGS,
    );
    assert.equal(result.fantasy_points, 4); // only pass_yd counted
    assert.equal(result.breakdown.length, 1);
    assert.ok(
      result.warnings.some((w) => w.includes("made_up_stat_xyz")),
      "expected a warning naming the unsupported key",
    );
  });

  it("ignores a non-numeric stat value with a warning instead of throwing", () => {
    const result = calculateFantasyPoints(
      { pass_yd: "not a number" as unknown as number },
      SETTINGS,
    );
    assert.equal(result.fantasy_points, 0);
    assert.ok(result.warnings.length > 0);
  });

  it("never produces NaN or Infinity in the total", () => {
    const result = calculateFantasyPoints(
      { pass_yd: 100, unknown_key: 999, rush_yd: 50 },
      SETTINGS,
    );
    assert.ok(Number.isFinite(result.fantasy_points));
  });
});

describe("roundPoints", () => {
  it("absorbs floating-point noise", () => {
    // 0.1 * 100 is 10.000000000000002 in raw IEEE-754 arithmetic.
    assert.equal(roundPoints(0.1 * 100), 10);
  });
});

describe("normalize: rule catalog", () => {
  it("labels every known key and preserves its exact point value", () => {
    const { rules, warnings } = buildNormalizedRules(SETTINGS);
    assert.equal(rules.length, Object.keys(SETTINGS).length);

    const passTd = rules.find((r) => r.key === "pass_td");
    assert.equal(passTd?.label, "Passing touchdown");
    assert.equal(passTd?.category, "passing");
    assert.equal(passTd?.points, 4);

    // Every key in this fixture is in the catalog, so no warnings expected.
    assert.deepEqual(warnings, []);
  });

  it("falls back to a generated label and warns for an unrecognized key", () => {
    const { rules, warnings } = buildNormalizedRules({ totally_new_stat: 3 });
    assert.equal(rules[0]?.label, "Totally new stat");
    assert.equal(rules[0]?.category, "other");
    assert.ok(warnings.some((w) => w.includes("totally_new_stat")));
  });
});

describe("derived metrics", () => {
  it("computes passing yardage equivalents correctly", () => {
    const passing = buildDerivedPassing(SETTINGS);
    assert.equal(passing.points_per_25_pass_yards, 1); // 0.04 * 25
    assert.equal(passing.points_per_100_pass_yards, 4); // 0.04 * 100
    assert.equal(passing.passing_td_value, 4);
    assert.equal(passing.interception_penalty, -2);
  });

  it("computes rushing yardage equivalents correctly", () => {
    const rushing = buildDerivedRushing(SETTINGS);
    assert.equal(rushing.points_per_10_rush_yards, 1); // 0.1 * 10
    assert.equal(rushing.points_per_100_rush_yards, 10); // 0.1 * 100
    assert.equal(rushing.rushing_td_value, 6);
  });

  it("computes receiving yardage equivalents correctly", () => {
    const receiving = buildDerivedReceiving(SETTINGS);
    assert.equal(receiving.points_per_10_receiving_yards, 1);
    assert.equal(receiving.points_per_100_receiving_yards, 10);
    assert.equal(receiving.reception_value, 0.5);
    assert.equal(receiving.te_premium_bonus, null); // not configured in fixture
  });

  it("detects flat kicker scoring when distance tiers are all zero", () => {
    const kicking = buildDerivedKicking(SETTINGS);
    assert.equal(kicking.uses_flat_scoring, true);
    assert.equal(kicking.field_goal_made_flat, 3);
    assert.deepEqual(kicking.field_goal_distance_tiers, {});
  });

  it("detects the per-point points-allowed penalty model", () => {
    const defense = buildDerivedDefense(SETTINGS);
    assert.equal(defense.points_allowed_scoring_model, "per_point_penalty");
    assert.equal(defense.points_allowed_per_point, -0.25);
    assert.deepEqual(defense.points_allowed_tiers, {});
  });

  it("detects a tiered points-allowed model when tiers are nonzero", () => {
    const tiered = { ...SETTINGS, pts_allow: 0, pts_allow_0: 10, pts_allow_1_6: 7 };
    const defense = buildDerivedDefense(tiered);
    assert.equal(defense.points_allowed_scoring_model, "tiered_bonus");
    assert.deepEqual(defense.points_allowed_tiers, {
      pts_allow_0: 10,
      pts_allow_1_6: 7,
    });
  });
});

describe("cross-category comparisons", () => {
  it("reports TD values and yardage equivalencies", () => {
    const comparisons = buildComparisons(SETTINGS);
    assert.deepEqual(comparisons.td_values, { passing: 4, rushing: 6, receiving: 6 });
    assert.equal(comparisons.yardage_equivalencies["100_pass_yards"], 4);
    assert.equal(comparisons.yardage_equivalencies["100_rush_yards"], 10);
    assert.equal(comparisons.yardage_equivalencies["100_receiving_yards"], 10);
  });

  it("computes touchdown and yardage-value ratios", () => {
    const comparisons = buildComparisons(SETTINGS);
    assert.equal(comparisons.ratios.rushing_td_to_passing_td, 1.5); // 6/4
    assert.equal(comparisons.ratios.receiving_td_to_passing_td, 1.5);
    assert.equal(comparisons.ratios.rush_yard_to_pass_yard_value, 2.5); // 0.1/0.04
  });

  it("returns null ratios rather than dividing by zero", () => {
    const noPassTd = { ...SETTINGS, pass_td: 0 };
    const comparisons = buildComparisons(noPassTd);
    assert.equal(comparisons.ratios.rushing_td_to_passing_td, null);
  });
});

describe("classification", () => {
  it("classifies half-PPR correctly", () => {
    const classification = classifyScoring(SETTINGS, ["QB", "QB", "RB", "WR"]);
    assert.equal(classification.base, "half_ppr");
    assert.ok(classification.features.includes("4-point passing touchdown"));
    assert.ok(
      classification.features.some((f) => f.includes("6-point rushing touchdown")),
    );
    assert.ok(classification.features.some((f) => f.includes("2QB")));
  });

  it("classifies standard (no PPR) correctly", () => {
    const classification = classifyScoring({ ...SETTINGS, rec: 0 }, ["QB"]);
    assert.equal(classification.base, "standard");
  });

  it("classifies full PPR correctly", () => {
    const classification = classifyScoring({ ...SETTINGS, rec: 1 }, ["QB"]);
    assert.equal(classification.base, "full_ppr");
  });

  it("only lists TE premium when the bonus key is actually present", () => {
    const withoutPremium = classifyScoring(SETTINGS, ["QB"]);
    assert.ok(!withoutPremium.features.some((f) => f.includes("TE premium")));

    const withPremium = classifyScoring({ ...SETTINGS, bonus_rec_te: 0.5 }, ["QB"]);
    assert.ok(withPremium.features.some((f) => f.includes("TE premium")));
  });

  it("detects Superflex distinctly from a strict 2QB league", () => {
    const superflex = classifyScoring(SETTINGS, ["QB", "SUPER_FLEX"]);
    assert.ok(superflex.features.some((f) => f.includes("Superflex")));
    assert.ok(!superflex.features.some((f) => f.includes("2QB")));
  });
});

describe("archetype examples", () => {
  it("computes every archetype through the shared scoring engine (no hardcoding)", () => {
    const archetypes = buildArchetypeExamples(SETTINGS);
    for (const [key, { stats }] of Object.entries(ARCHETYPE_STAT_LINES)) {
      const expected = calculateFantasyPoints(stats, SETTINGS).fantasy_points;
      assert.equal(
        archetypes[key as keyof typeof archetypes].fantasy_points,
        expected,
        `${key} should match a fresh calculation`,
      );
    }
  });

  it("matches the spec's worked pocket_qb and rushing_qb totals", () => {
    const archetypes = buildArchetypeExamples(SETTINGS);
    // pocket_qb: 12 + 8 - 2 + 1 = 19
    assert.equal(archetypes.pocket_qb.fantasy_points, 19);
    // rushing_qb: (220*.04=8.8) + 4 - 2 + (80*.1=8) + 6 = 24.8
    assert.equal(archetypes.rushing_qb.fantasy_points, 24.8);
  });

  it("shows the receiving RB scoring higher than the workhorse RB under half PPR", () => {
    const archetypes = buildArchetypeExamples(SETTINGS);
    // receiving_rb: 50*.1=5 + 8*.5=4 + 70*.1=7 = 16
    // workhorse_rb: 100*.1=10 + 6 + 3*.5=1.5 + 20*.1=2 = 19.5
    assert.equal(archetypes.receiving_rb.fantasy_points, 16);
    assert.equal(archetypes.workhorse_rb.fantasy_points, 19.5);
  });
});

describe("sensitivity analysis", () => {
  it("does not mutate the input scoring settings", () => {
    const snapshot = { ...SETTINGS };
    const archetypes = buildArchetypeExamples(SETTINGS);
    buildSensitivity(SETTINGS, archetypes);
    assert.deepEqual(SETTINGS, snapshot);
  });

  it("computes pass_td+1 as exactly the touchdown count more per archetype", () => {
    const archetypes = buildArchetypeExamples(SETTINGS);
    const sensitivity = buildSensitivity(SETTINGS, archetypes);
    // pocket_qb has 2 pass_td -> +2; rushing_qb has 1 -> +1; others 0 pass_td -> +0.
    assert.equal(sensitivity.pass_td_plus_1.changes.pocket_qb, 2);
    assert.equal(sensitivity.pass_td_plus_1.changes.rushing_qb, 1);
    assert.equal(sensitivity.pass_td_plus_1.changes.volume_wr, 0);
  });

  it("computes reception+0.5 proportional to reception count", () => {
    const archetypes = buildArchetypeExamples(SETTINGS);
    const sensitivity = buildSensitivity(SETTINGS, archetypes);
    // volume_wr: 10 receptions -> +5; typical_te: 5 -> +2.5; receiving_rb: 8 -> +4.
    assert.equal(sensitivity.reception_plus_0_5.changes.volume_wr, 5);
    assert.equal(sensitivity.reception_plus_0_5.changes.typical_te, 2.5);
    assert.equal(sensitivity.reception_plus_0_5.changes.receiving_rb, 4);
  });

  it("computes rush_td+1 and rec_td+1 only for archetypes that score one", () => {
    const archetypes = buildArchetypeExamples(SETTINGS);
    const sensitivity = buildSensitivity(SETTINGS, archetypes);
    assert.equal(sensitivity.rush_td_plus_1.changes.workhorse_rb, 1);
    assert.equal(sensitivity.rush_td_plus_1.changes.volume_wr, 0);
    assert.equal(sensitivity.rec_td_plus_1.changes.big_play_wr, 1);
    assert.equal(sensitivity.rec_td_plus_1.changes.elite_te_game, 1);
    assert.equal(sensitivity.rec_td_plus_1.changes.workhorse_rb, 0);
  });

  it("computes a harsher interception penalty as a negative change", () => {
    const archetypes = buildArchetypeExamples(SETTINGS);
    const sensitivity = buildSensitivity(SETTINGS, archetypes);
    // Both QB archetypes throw exactly 1 interception.
    assert.equal(sensitivity.interception_penalty_minus_1.changes.pocket_qb, -1);
    assert.equal(sensitivity.interception_penalty_minus_1.changes.rushing_qb, -1);
  });
});

describe("diagnostics", () => {
  it("flags rushing and receiving TD premiums over passing TD", () => {
    const diagnostics = buildDiagnostics(SETTINGS);
    const ids = diagnostics.map((d) => d.id);
    assert.ok(ids.includes("rushing_td_premium"));
    assert.ok(ids.includes("receiving_td_premium"));
  });

  it("flags the points-allowed penalty model", () => {
    const diagnostics = buildDiagnostics(SETTINGS);
    const found = diagnostics.find((d) => d.id === "defense_points_allowed_penalty");
    assert.ok(found);
    assert.equal(found.severity, "notable");
  });

  it("flags flat kicker scoring", () => {
    const diagnostics = buildDiagnostics(SETTINGS);
    assert.ok(diagnostics.some((d) => d.id === "flat_kicker_scoring"));
  });

  it("does not flag TE premium when no such key is configured", () => {
    const diagnostics = buildDiagnostics(SETTINGS);
    assert.ok(!diagnostics.some((d) => d.id === "tight_end_premium"));
  });

  it("flags TE premium when the bonus key is configured", () => {
    const diagnostics = buildDiagnostics({ ...SETTINGS, bonus_rec_te: 1 });
    const found = diagnostics.find((d) => d.id === "tight_end_premium");
    assert.ok(found);
    assert.equal(found.severity, "notable");
  });

  it("does not flag a standard -2 interception penalty as low", () => {
    const diagnostics = buildDiagnostics(SETTINGS);
    assert.ok(!diagnostics.some((d) => d.id === "low_interception_penalty"));
  });

  it("flags a genuinely light interception penalty", () => {
    const diagnostics = buildDiagnostics({ ...SETTINGS, pass_int: -1 });
    assert.ok(diagnostics.some((d) => d.id === "low_interception_penalty"));
  });

  it("only fires each diagnostic from actual evidence in the settings", () => {
    // A perfectly symmetric scoring table should trigger none of the TD/yardage
    // premium diagnostics, proving nothing is fabricated when there is no gap.
    const symmetric = {
      pass_yd: 0.04,
      rush_yd: 0.04,
      rec_yd: 0.04,
      pass_td: 6,
      rush_td: 6,
      rec_td: 6,
      pass_int: -2,
      fum_lost: -2,
    };
    const diagnostics = buildDiagnostics(symmetric);
    assert.deepEqual(diagnostics, []);
  });
});
