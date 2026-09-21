/** Phase 4 (Checkpoint G) — evaluation suite defined first, evidence classification honest, prospective capture immutable and class-separated. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { auditHistoricalEvidence, scoreDecisions, METRIC_DEFINITIONS, type DecisionOutcome } from "@/lib/waiver2/evaluation";


test("the evaluation suite is DEFINED before any fitting: every spec §28 target has a named definition, and nothing here fits a parameter", () => {
  for (const k of ["net_roster_value", "starter_improvement", "replacement_value_gain", "breakout_identification", "false_breakout_avoidance", "drop_regret", "faab_efficiency", "opportunity_per_faab", "alternative_regret"]) assert.ok(METRIC_DEFINITIONS[k] && METRIC_DEFINITIONS[k]!.length > 15, k);
  assert.doesNotMatch(readFileSync("lib/waiver2/evaluation.ts", "utf8"), /optimi[sz]e|gradient|fit\(|regress|tune\(/i, "the suite scores; it does not fit");
});
test("HISTORICAL HONESTY: no pool history exists — alternatives are UNSAFE_FOR_BACKTEST, claims RETROSPECTIVE_ONLY, and TRUE_AS_OF only comes from live captures", () => {
  const a = auditHistoricalEvidence(); const by = (s: string) => a.find((x) => x.input.startsWith(s))!;
  assert.equal(by("free-agent pool").class, "UNSAFE_FOR_BACKTEST"); assert.equal(by("candidate ranking").class, "UNSAFE_FOR_BACKTEST"); assert.equal(by("realized claims").class, "RETROSPECTIVE_ONLY"); assert.equal(by("manager roster").class, "RECONSTRUCTABLE_AS_OF");
  assert.deepEqual(a.filter((x) => x.usable_for_backtest).map((x) => x.input), ["Waiver 2.0 LIVE_CAPTURED weekly records with attached outcomes"]);
  assert.ok(a.every((x) => x.reason.length > 20));
});
test("the suite REFUSES anything that is not TRUE_AS_OF_HISTORY and never fabricates a metric from nothing", () => {
  const d = (over: Partial<DecisionOutcome>): DecisionOutcome => ({ decision_id: "d", evidence_class: "TRUE_AS_OF_HISTORY", archetype: "IMMEDIATE_STARTER", role_persisted_points_at_decision: 0, chosen_points_started: 30, drop_points_lost: 5, best_alternative_points_started: 40, role_share_change: 0.03, faab_spent: 10, starter_slot_improvement: 4, replacement_level_points: 3, weeks_held: 4, drop_regret_points: 2, ...over });
  const r = scoreDecisions([d({ decision_id: "a" }), d({ decision_id: "b", evidence_class: "RETROSPECTIVE_ONLY" }), d({ decision_id: "c", evidence_class: "UNSAFE_FOR_BACKTEST" }), d({ decision_id: "e", archetype: "ROLE_GROWTH_BREAKOUT", role_share_change: -0.02, faab_spent: 0 })]);
  assert.equal(r.scored, 2); assert.deepEqual(r.refused.map((x) => x.decision_id).sort(), ["b", "c"]); assert.match(r.refused[0]!.reason, /not backtest-grade/);
  assert.equal(r.metrics.net_roster_value, 25); assert.equal(r.metrics.alternative_regret, 10); assert.equal(r.metrics.breakout_identification, 0); assert.equal(r.metrics.faab_efficiency, 2.5);
  const none = scoreDecisions([d({ evidence_class: "RETROSPECTIVE_ONLY" })]); assert.equal(none.scored, 0); assert.ok(Object.values(none.metrics).every((v) => v === null), "no eligible decisions -> no numbers");
});

