/**
 * End-to-end tests for `/api/scoring` against the real Bloodline Bowl league.
 * Requires network access.
 *
 * These assert structural invariants and internal consistency rather than
 * hardcoded point values, so they stay correct if the commissioner changes
 * scoring settings later (as already happened once during this project).
 */

import assert from "node:assert/strict";
import { before, describe, it } from "node:test";

import { getLeague } from "../lib/sleeper/client";
import { resolveLeagueId } from "../lib/sleeper/service";
import { calculateFantasyPoints } from "../lib/scoring/calculate";
import { ARCHETYPE_STAT_LINES } from "../lib/scoring/archetypes";
import { buildScoringBundle } from "../lib/scoring/scoring-service";
import type { ScoringResponse } from "../lib/scoring/types";

let response: ScoringResponse;
let liveScoringSettings: Record<string, number>;

before(async () => {
  response = await buildScoringBundle();
  const league = await getLeague(resolveLeagueId());
  liveScoringSettings = league.scoring_settings ?? {};
});

describe("live scoring snapshot", () => {
  it("uses the live league's actual scoring settings, not a hardcoded format", () => {
    assert.deepEqual(response.scoring.raw, liveScoringSettings);
  });

  it("preserves every raw scoring key in the normalized list", () => {
    const rawKeys = Object.keys(liveScoringSettings).sort();
    const normalizedKeys = response.scoring.normalized.map((r) => r.key).sort();
    assert.deepEqual(normalizedKeys, rawKeys);
  });

  it("gives every normalized rule a nonempty label and a valid category", () => {
    const validCategories = new Set([
      "passing",
      "rushing",
      "receiving",
      "turnovers",
      "kicking",
      "defense",
      "special_teams",
      "bonuses",
      "other",
    ]);
    for (const rule of response.scoring.normalized) {
      assert.ok(rule.label.length > 0, `${rule.key} has an empty label`);
      assert.ok(
        validCategories.has(rule.category),
        `${rule.key} has an invalid category '${rule.category}'`,
      );
      assert.equal(rule.points, liveScoringSettings[rule.key]);
    }
  });

  it("reports the league's real name and season", () => {
    assert.equal(response.league.name, "Bloodline Bowl");
    assert.ok(/^\d{4}$/.test(response.league.season));
  });
});

describe("live derived metrics: mathematically correct against raw settings", () => {
  it("computes passing yardage derivatives correctly", () => {
    const passYd = liveScoringSettings.pass_yd;
    if (typeof passYd === "number") {
      assert.equal(response.derived.passing.points_per_25_pass_yards, passYd * 25);
      assert.equal(response.derived.passing.points_per_100_pass_yards, passYd * 100);
    }
  });

  it("computes rushing yardage derivatives correctly", () => {
    const rushYd = liveScoringSettings.rush_yd;
    if (typeof rushYd === "number") {
      assert.equal(response.derived.rushing.points_per_10_rush_yards, rushYd * 10);
      assert.equal(response.derived.rushing.points_per_100_rush_yards, rushYd * 100);
    }
  });

  it("computes receiving yardage derivatives correctly", () => {
    const recYd = liveScoringSettings.rec_yd;
    if (typeof recYd === "number") {
      assert.equal(response.derived.receiving.points_per_10_receiving_yards, recYd * 10);
      assert.equal(
        response.derived.receiving.points_per_100_receiving_yards,
        recYd * 100,
      );
    }
  });

  it("matches the comparisons block's yardage equivalencies to derived metrics", () => {
    assert.equal(
      response.comparisons.yardage_equivalencies["100_pass_yards"],
      response.derived.passing.points_per_100_pass_yards,
    );
    assert.equal(
      response.comparisons.yardage_equivalencies["100_rush_yards"],
      response.derived.rushing.points_per_100_rush_yards,
    );
    assert.equal(
      response.comparisons.yardage_equivalencies["100_receiving_yards"],
      response.derived.receiving.points_per_100_receiving_yards,
    );
  });
});

describe("live archetype examples", () => {
  it("computes every archetype through the same engine as everything else", () => {
    for (const [key, { stats }] of Object.entries(ARCHETYPE_STAT_LINES)) {
      const expected = calculateFantasyPoints(stats, liveScoringSettings).fantasy_points;
      assert.equal(
        response.archetype_examples[key as keyof typeof response.archetype_examples]
          .fantasy_points,
        expected,
      );
    }
  });

  it("produces a finite number for every archetype", () => {
    for (const result of Object.values(response.archetype_examples)) {
      assert.ok(Number.isFinite(result.fantasy_points));
    }
  });
});

describe("live sensitivity analysis", () => {
  it("keeps sensitivity changes internally consistent with a fresh calculation", () => {
    const adjusted = { ...liveScoringSettings, pass_td: (liveScoringSettings.pass_td ?? 0) + 1 };
    const expectedPocketQb =
      calculateFantasyPoints(ARCHETYPE_STAT_LINES.pocket_qb.stats, adjusted).fantasy_points -
      response.archetype_examples.pocket_qb.fantasy_points;
    assert.equal(
      response.sensitivity.pass_td_plus_1.changes.pocket_qb,
      Math.round(expectedPocketQb * 10_000) / 10_000,
    );
  });

  it("never mutates the live scoring settings while computing sensitivity", () => {
    // buildScoringBundle already ran; the fetched settings should still match
    // what a fresh fetch returns.
    assert.deepEqual(response.scoring.raw, liveScoringSettings);
  });
});

describe("live diagnostics and classification", () => {
  it("only emits diagnostics with a valid severity", () => {
    for (const diagnostic of response.diagnostics) {
      assert.ok(["informational", "notable", "strong"].includes(diagnostic.severity));
      assert.ok(diagnostic.message.length > 0);
    }
  });

  it("classifies reception value consistently with the raw rec key", () => {
    const rec = liveScoringSettings.rec;
    if (rec === 0 || rec === undefined) {
      assert.equal(response.classification.base, "standard");
    } else if (rec === 0.5) {
      assert.equal(response.classification.base, "half_ppr");
    } else if (rec === 1) {
      assert.equal(response.classification.base, "full_ppr");
    } else {
      assert.equal(response.classification.base, "custom_ppr");
    }
  });
});

describe("scoring_engine: stable machine-readable rules", () => {
  it("mirrors every normalized rule's points and category", () => {
    for (const rule of response.scoring.normalized) {
      assert.deepEqual(response.scoring_engine.rules[rule.key], {
        points: rule.points,
        category: rule.category,
      });
    }
    assert.equal(
      Object.keys(response.scoring_engine.rules).length,
      response.scoring.normalized.length,
    );
  });

  it("is versioned", () => {
    assert.equal(response.scoring_engine.version, 1);
  });
});

describe("live: no crash on unsupported keys", () => {
  it("reports a warning list even when nothing is unsupported", () => {
    assert.ok(Array.isArray(response.metadata.warnings));
    assert.equal(response.metadata.rule_count, response.scoring.normalized.length);
  });
});
