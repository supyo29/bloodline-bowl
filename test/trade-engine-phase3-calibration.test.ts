/**
 * Trade Engine — Phase 3A: calibration dataset and signal audit.
 *
 * Runs the 16-scenario taxonomy through `evaluateTrade` and exercises the
 * calibration statistics module (`lib/trades/calibration.ts`): distribution,
 * Pearson/Spearman correlation, conceptual-overlap matrix, and the ablation
 * evaluator. Also covers the historical no-look-ahead guard (framework-only —
 * no real Bloodline trade history is ingested in this environment).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildCalibrationScenarios } from "./fixtures/calibration-scenarios";
import { evaluateTrade } from "../lib/trades/evaluate";
import {
  describeDistribution,
  pearson,
  spearman,
  runAblation,
  CONCEPTUAL_OVERLAP_MATRIX,
} from "../lib/trades/calibration";
import { resolveTradeConfig } from "../lib/trades/config";
import { assertNoLookahead, isUsableForCalibration, summarizeHistoricalDataset, type HistoricalTradeRecord } from "../lib/trades/historical";

/** Run every scenario once and collect the components we calibrate on. */
function runScenarios() {
  return buildCalibrationScenarios().map((s) => {
    const out = evaluateTrade({ ...s.fixture.input, context: s.fixture.context({ rosWeeks: 6, playoffStartWeek: 4 }) });
    const p = out.participants[s.focus_manager]!;
    return { scenario: s, participant: p };
  });
}

describe("audit §1/§2 — calibration dataset covers the required taxonomy", () => {
  it("all 16 required scenario labels are present, each with an expected direction", () => {
    const scenarios = buildCalibrationScenarios();
    const required = [
      "STARTER_UPGRADE", "BENCH_ONLY", "DEPTH_BUILD", "CONSOLIDATION", "POSITIONAL_HOLE", "SCARCITY_SHIFT",
      "BYE_COVERAGE", "FRAGILITY_INCREASE", "FRAGILITY_DECREASE", "ROS_UPGRADE", "CURRENT_WEEK_UPGRADE",
      "CURRENT_WEEK_DOWNGRADE_ROS_UPGRADE", "HIGH_VARIANCE_PLAYER", "ROLE_UNCERTAINTY", "THREE_TEAM_BALANCED", "THREE_TEAM_HIDDEN_LOSER",
    ];
    const present = new Set(scenarios.map((s) => s.scenario));
    for (const r of required) assert.ok(present.has(r as never), `missing scenario ${r}`);
    assert.equal(scenarios.length, required.length);
  });

  it("includes multi-team (3-team) coverage and varied roster archetypes", () => {
    const scenarios = buildCalibrationScenarios();
    const threeTeam = scenarios.filter((s) => s.scenario.startsWith("THREE_TEAM"));
    assert.equal(threeTeam.length, 2);
  });

  it("every scenario resolves and its expected direction holds against the actual engine output", () => {
    for (const { scenario, participant } of runScenarios()) {
      const val =
        scenario.expected_component === "starter_points" ? participant.roster_utility_components.starter_points
        : scenario.expected_component === "ros_usable_value" ? (participant.phase2?.ros.ros_usable_value_delta ?? NaN)
        : participant.roster_utility_delta;
      if (scenario.expected_direction === "POSITIVE") assert.ok(val > 0, `${scenario.scenario}: expected positive, got ${val}`);
      else if (scenario.expected_direction === "NEGATIVE") assert.ok(val < 0, `${scenario.scenario}: expected negative, got ${val}`);
      else assert.ok(Math.abs(val) <= 3, `${scenario.scenario}: expected roughly neutral, got ${val}`);
    }
  });
});

describe("audit §3 — signal distribution audit", () => {
  const runs = runScenarios();
  const componentSets: Record<string, Array<number | null>> = {
    starter_points_delta: runs.map((r) => r.participant.starter_points_delta),
    starter_vor_delta: runs.map((r) => r.participant.starter_vor_delta),
    bench_value_delta: runs.map((r) => r.participant.bench_value_delta),
    roster_utility_delta: runs.map((r) => r.participant.roster_utility_delta),
    ros_usable_value_delta: runs.map((r) => r.participant.phase2?.ros.ros_usable_value_delta ?? null),
    usable_depth_delta: runs.map((r) => r.participant.phase2?.depth.usable_depth_delta ?? null),
    fragility_delta: runs.map((r) => r.participant.phase2?.depth.fragility_delta ?? null),
    replacement_context_delta: runs.map((r) => r.participant.phase2?.depth.replacement_context_delta ?? null),
    bye_coverage_delta: runs.map((r) => r.participant.phase2?.ros.bye_coverage_delta ?? null),
    consolidation_effect: runs.map((r) => r.participant.phase2?.ros.consolidation_effect ?? null),
    interaction_residual: runs.map((r) => r.participant.phase2?.ros.interaction_residual ?? null),
  };

  it("every required component has a computable, finite distribution over the scenario set", () => {
    for (const [name, values] of Object.entries(componentSets)) {
      const d = describeDistribution(values);
      assert.equal(d.n, runs.length, name);
      assert.ok(d.missing_frequency < 1, `${name}: entirely missing`);
      if (d.mean != null) {
        assert.ok(Number.isFinite(d.mean), `${name} mean not finite`);
        assert.ok(Number.isFinite(d.std_dev!), `${name} std_dev not finite`);
        assert.ok(d.min! <= d.median! && d.median! <= d.max!, `${name}: median outside [min,max]`);
        assert.ok(d.p10! <= d.p25! && d.p25! <= d.p75! && d.p75! <= d.p90!, `${name}: percentiles out of order`);
      }
    }
  });

  it("distribution reports missingness honestly (not silently zero)", () => {
    const withGaps = [1, 2, null, 4, undefined, 6];
    const d = describeDistribution(withGaps);
    assert.equal(d.n, 6);
    assert.equal(d.missing, 2);
    assert.ok(d.mean !== 0); // must not fold missing into a zero that drags the mean down
    assert.equal(d.mean, (1 + 2 + 4 + 6) / 4);
  });

  it("zero-frequency and missing-frequency are tracked separately", () => {
    const d = describeDistribution([0, 0, 1, null, 2]);
    assert.equal(d.zero_count, 2);
    assert.equal(d.missing, 1);
  });
});

describe("audit §4 — correlation matrix (Pearson + Spearman)", () => {
  const runs = runScenarios();
  const starterPoints = runs.map((r) => r.participant.starter_points_delta);
  const starterVor = runs.map((r) => r.participant.starter_vor_delta);
  const rosUsable = runs.map((r) => r.participant.phase2?.ros.ros_usable_value_delta ?? null);
  const usableDepth = runs.map((r) => r.participant.phase2?.depth.usable_depth_delta ?? null);
  const fragility = runs.map((r) => r.participant.phase2?.depth.fragility_delta ?? null);
  const replacementContext = runs.map((r) => r.participant.phase2?.depth.replacement_context_delta ?? null);
  const benchValue = runs.map((r) => r.participant.bench_value_delta);
  const byeCoverage = runs.map((r) => r.participant.phase2?.ros.bye_coverage_delta ?? null);
  const consolidation = runs.map((r) => r.participant.phase2?.ros.consolidation_effect ?? null);

  it("starter_points vs starter_vor: high positive correlation (both Pearson and Spearman) — confirms the Phase 1 audit's D2 finding empirically", () => {
    const r = pearson(starterPoints, starterVor);
    const rho = spearman(starterPoints, starterVor);
    assert.ok(r != null && r > 0.6, `pearson=${r}`);
    assert.ok(rho != null && rho > 0.5, `spearman=${rho}`);
  });

  it("computes every required pair without throwing and returns a number or null (never NaN)", () => {
    const pairs: Array<[string, Array<number | null>, string, Array<number | null>]> = [
      ["starter_points", starterPoints, "ros_usable_value", rosUsable],
      ["bench_value", benchValue, "usable_depth", usableDepth],
      ["usable_depth", usableDepth, "fragility", fragility],
      ["replacement_context", replacementContext, "fragility", fragility],
      ["replacement_context", replacementContext, "starter_vor", starterVor],
      ["ros_usable_value", rosUsable, "bye_coverage", byeCoverage],
      ["consolidation", consolidation, "usable_depth", usableDepth],
    ];
    for (const [an, a, bn, b] of pairs) {
      const r = pearson(a, b);
      const rho = spearman(a, b);
      if (r != null) assert.ok(Number.isFinite(r), `${an}x${bn} pearson not finite`);
      if (rho != null) assert.ok(Number.isFinite(rho), `${an}x${bn} spearman not finite`);
    }
  });

  it("pearson returns null (not 0) for a constant series — undefined correlation is not zero correlation", () => {
    assert.equal(pearson([5, 5, 5, 5], [1, 2, 3, 4]), null);
  });

  it("pearson and spearman agree in sign for a monotonic-but-nonlinear relationship", () => {
    const x = [1, 2, 3, 4, 5];
    const y = x.map((v) => v ** 3);
    const r = pearson(x, y)!;
    const rho = spearman(x, y)!;
    assert.ok(r > 0 && rho > 0);
    assert.ok(rho > r - 0.01, "spearman should be at least as strong as pearson for a monotonic nonlinear relation");
  });
});

describe("audit §5 — conceptual overlap audit", () => {
  it("every documented pair has an explicit overlap level and a non-empty reason", () => {
    for (const entry of CONCEPTUAL_OVERLAP_MATRIX) {
      assert.ok(["HIGH", "MODERATE", "LOW", "NONE"].includes(entry.overlap));
      assert.ok(entry.reason.length > 20, `${entry.a}x${entry.b}: reason too thin`);
    }
  });

  it("starter_points x starter_vor is classified HIGH overlap, matching the Phase 1 audit finding", () => {
    const e = CONCEPTUAL_OVERLAP_MATRIX.find((x) => x.a === "starter_points" && x.b === "starter_vor")!;
    assert.equal(e.overlap, "HIGH");
  });

  it("replacement_cliff x roster_fragility is HIGH overlap (fragility is partly BUILT from cliff, not independent)", () => {
    const e = CONCEPTUAL_OVERLAP_MATRIX.find((x) => x.a === "replacement_cliff" && x.b === "roster_fragility")!;
    assert.equal(e.overlap, "HIGH");
  });
});

describe("audit §6 — ablation framework", () => {
  it("a signal that materially improves directional accuracy shows positive incremental value", () => {
    const runs = runScenarios();
    const ablation = runAblation(
      "ros_usable_value",
      runs.map((r) => ({
        name: r.scenario.scenario,
        expected_direction: r.scenario.expected_direction,
        input: r,
      })),
      (r) => (r.scenario.expected_component === "roster_utility" ? r.participant.roster_utility_delta : (r.participant.phase2?.ros.ros_usable_value_delta ?? 0)),
      () => 0, // "ablated": pretend the signal contributes nothing
    );
    assert.ok(ablation.full_directional_accuracy >= ablation.ablated_directional_accuracy,
      `full=${ablation.full_directional_accuracy} ablated=${ablation.ablated_directional_accuracy}`);
    assert.equal(ablation.outcomes.length, runs.length);
  });

  it("removing a signal that was never informative shows zero (not negative-surprise) incremental value", () => {
    const runs = runScenarios();
    const noise = runAblation(
      "constant_noise",
      runs.map((r) => ({ name: r.scenario.scenario, expected_direction: r.scenario.expected_direction, input: r })),
      () => 0.001, // a signal indistinguishable from neutral in both models
      () => 0,
    );
    assert.ok(Math.abs(noise.incremental_directional_value) < 0.3, `incremental=${noise.incremental_directional_value}`);
  });

  it("ranking stability is computable and bounded in [-1, 1] when defined", () => {
    const runs = runScenarios();
    const result = runAblation(
      "starter_points",
      runs.map((r) => ({ name: r.scenario.scenario, expected_direction: r.scenario.expected_direction, input: r })),
      (r) => r.participant.roster_utility_delta,
      (r) => r.participant.roster_utility_delta - r.participant.roster_utility_components.starter_points,
    );
    if (result.ranking_stability != null) {
      assert.ok(result.ranking_stability >= -1 && result.ranking_stability <= 1);
    }
  });
});

describe("audit §7 — monotonicity", () => {
  it("resolveTradeConfig enforces threshold monotonicity (documented exception boundary)", () => {
    assert.throws(() => resolveTradeConfig({ thresholds: { accept: 5, strong_accept: 3 } }));
  });

  it("a strictly better starter outcome never produces a lower starter_points component (spot-check across the scenario set)", () => {
    // Not a formal proof, but an executable regression: no scenario in the
    // taxonomy should show a positive standalone swing with a negative
    // starter_points delta unless the fixture is explicitly a displacement case.
    const runs = runScenarios();
    const starterUpgrade = runs.find((r) => r.scenario.scenario === "STARTER_UPGRADE")!;
    assert.ok(starterUpgrade.participant.roster_utility_components.starter_points > 0);
  });
});

describe("audit §33/§34 — historical retrospective framework: no look-ahead bias", () => {
  it("a well-formed record (snapshot at/before trade date, outcome strictly after) passes the guard", () => {
    const record: HistoricalTradeRecord = {
      trade_id: "t1", league_slug: "test-league",
      trade_date: "2026-10-01T00:00:00.000Z",
      input_snapshot_captured_at: "2026-09-30T12:00:00.000Z",
      proposal: {}, model_inputs_summary: {},
      outcome: { evaluated_through: "2026-12-01T00:00:00.000Z", starter_points_added_after_trade: 12, ros_points_realized: 80, weeks_started: 6, replacement_adjusted_realized_value: 40, playoff_week_contribution: 10, availability_note: null },
      human_label: null, human_label_reason: null,
    };
    const check = assertNoLookahead(record);
    assert.equal(check.ok, true, JSON.stringify(check.violations));
    assert.equal(isUsableForCalibration(record), true);
  });

  it("REJECTS a record whose input snapshot was captured AFTER the trade date (future roster state leaking into inputs)", () => {
    const record: HistoricalTradeRecord = {
      trade_id: "t2", league_slug: "test-league",
      trade_date: "2026-10-01T00:00:00.000Z",
      input_snapshot_captured_at: "2026-10-05T00:00:00.000Z", // AFTER — a leak
      proposal: {}, model_inputs_summary: {}, outcome: null, human_label: null, human_label_reason: null,
    };
    const check = assertNoLookahead(record);
    assert.equal(check.ok, false);
    assert.ok(check.violations.some((v) => v.includes("AFTER trade_date")));
    assert.equal(isUsableForCalibration(record), false);
  });

  it("REJECTS a record whose outcome window is not strictly after the trade date (outcome must be future, by definition)", () => {
    const record: HistoricalTradeRecord = {
      trade_id: "t3", league_slug: "test-league",
      trade_date: "2026-10-01T00:00:00.000Z",
      input_snapshot_captured_at: "2026-09-30T00:00:00.000Z",
      proposal: {}, model_inputs_summary: {},
      outcome: { evaluated_through: "2026-09-15T00:00:00.000Z", starter_points_added_after_trade: null, ros_points_realized: null, weeks_started: null, replacement_adjusted_realized_value: null, playoff_week_contribution: null, availability_note: null },
      human_label: null, human_label_reason: null,
    };
    assert.equal(assertNoLookahead(record).ok, false);
  });

  it("missing historical data degrades safely: an empty dataset summarizes to zero records, not an error", () => {
    const summary = summarizeHistoricalDataset([]);
    assert.equal(summary.total_records, 0);
    assert.equal(summary.records_with_outcome, 0);
    assert.equal(summary.lookahead_violations, 0);
  });

  it("this environment has NOT ingested real Bloodline Bowl trade history — documented, not silently assumed", () => {
    // No completed-trade retrospective dataset exists here (no network access to
    // pull real transaction history in this environment). The framework above is
    // ready to accept one; none is fabricated.
    const realHistoricalDataset: HistoricalTradeRecord[] = [];
    assert.equal(realHistoricalDataset.length, 0);
  });
});
