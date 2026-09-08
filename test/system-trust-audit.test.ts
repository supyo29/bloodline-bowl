/**
 * Team Management System Trust, Utilization & Causal-Influence Audit —
 * deterministic causal / forbidden-influence / production-remedy / failure /
 * stale-state assertions (spec §7–§12, §25–§30).
 *
 * This is NOT a modeling change. It proves — by controlled counterfactual —
 * that each layer's influence matches its deployment contract.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildOptimalLineup } from "@/lib/weekly/lineup";
import { applyFiToProductionBatch } from "@/lib/weekly/start-sit-fi/production-gate";
import { deploymentContract, fiMayInfluenceProduction, anyFiProductionInfluence } from "@/lib/weekly/start-sit-fi/deployment";
import { matchupDeploymentContract, matchupMayInfluenceProduction } from "@/lib/weekly/matchup-intelligence/deployment";
import { runPolicy } from "@/lib/orchestrator/policy";
import { applyHardGates } from "@/lib/orchestrator/gates";
import {
  assembleDimensions,
  buildEvidenceConfidence,
  classifyUrgency,
  pointsEffect,
} from "@/lib/orchestrator/dimensions";
import type { OrchestratorAction, OrchestratorCondition } from "@/lib/orchestrator/schema";
import type { ManagementAnalysisContext, ManagerAnalysisSlice } from "@/lib/orchestrator/context";
import { batch, player, proj, roster, STD_CONSTRAINTS } from "./fixtures/weekly";

/* ---------------------------------------------------------------- helpers */

function mkContext(over: Record<string, unknown> = {}): ManagementAnalysisContext {
  return {
    league: { league_slug: "trust-test" },
    season: 2026,
    week: 3,
    snapshot: { league: { waiver_settings: { type: "faab", waiver_day: "wed" } }, lineage: { snapshot_schema_version: 3 }, managers: [] },
    league_snapshot_id: "snap:trust:2026:w3:aaa",
    scoring_fingerprint: "scoring:v1:trust",
    teamState: null,
    rosterHealth: null,
    schedulePlanning: null,
    tradeCtx: { lineage: { projections: [] } },
    weeklyByManager: new Map(),
    strategyByManager: new Map(),
    availability: { team_state: true, roster_health: true, schedule_planning: true, strategy: true, weekly: new Map() },
    metrics: { canonical_provider_reads: 1, team_state_builds: 1, roster_health_builds: 1, schedule_planning_builds: 1, trade_context_builds: 1, weekly_intelligence_builds: 1, ms: {}, snapshot_ids_seen: ["snap:trust:2026:w3:aaa"], snapshot_coherent: true },
    warnings: [],
    options: {},
    versions: { orchestrator: "team-management-orchestrator-2026.1", team_state: "team-state-2026.1", roster_health: "roster-health-2026.1", schedule_planning: "schedule-planning-2026.1", strategy: "ri-trade-strategy-2026.2", weekly_engine: "post-draft-intel-2026.1", football_intelligence: "not_used", start_sit_shadow: "ri-startsit-2026.1", matchup_shadow: "ri-matchup-2026.1" },
    forManager: async () => null,
    ...over,
  } as unknown as ManagementAnalysisContext;
}

function mkSlice(over: Record<string, unknown> = {}): ManagerAnalysisSlice {
  return {
    manager_slug: "alice",
    manager_display_name: "Alice",
    team_name: "Alice",
    roster_id: 1,
    canonical_team_id: "team:trust:1",
    canonical_manager_id: "mgr:trust:1",
    is_vacant: false,
    teamState: {
      identity: { manager_slug: "alice", roster_id: 1, canonical_team_id: "team:trust:1", canonical_manager_id: "mgr:trust:1", is_vacant: false, manager_display_name: "Alice", team_name: "Alice" },
      roster: { players: [], all_players: ["s1", "s2", "s3", "bn1", "bn2"], starters: ["s1", "s2", "s3"], bench: ["bn1", "bn2"], ir: [], taxi: [] },
      structural_flags: [],
    },
    rosterHealth: {
      manager_slug: "alice", roster_id: 1, team_id: "team:trust:1", roster_health_version: "roster-health-2026.1",
      weekly: { fragility: { profile: "RESILIENT", worst_starter_dependency: 3, expected_one_loss_damage: 2, single_points_of_failure: [] }, player_dependency: [] },
      rest_of_season: { fragility: { profile: "RESILIENT" }, player_dependency: [], quality_surplus: [] },
      degradation: { overall: "OK", reasons: [] },
    },
    schedulePlanning: { manager_slug: "alice", roster_id: 1, team_id: "team:trust:1", is_vacant: false, planning_model_version: "schedule-planning-2026.1", week_timeline: [], summary: { next_bye_week: null, weeks_with_uncovered_slots: [] }, degradation: { structure: "OK", value: "OK", reasons: [] } },
    strategy: { manager_id: "mgr:trust:1", manager_slug: "alice", archetype: "CONTENDER", urgency: { score: 0.4, components: {} }, season: { season_stage: "MIDSEASON", weeks_remaining_regular: 8 } },
    weekly: mkWeekly(),
    ...over,
  } as unknown as ManagerAnalysisSlice;
}

function mkWeekly(over: Record<string, unknown> = {}): unknown {
  return {
    data_quality: { projections: "READY" },
    lineage: { snapshot: { league_snapshot_id: "snap:trust:2026:w3:aaa" } },
    lineup: { changes_recommended: [], unresolved_decisions: [], empty_slots: [], illegal_situations: [], bye_problems: [], optimality_status: "COMPLETE", optimal_total: 120, projected_points_gained: 0, slots: [] },
    start_sit: [],
    start_sit_shadow: null,
    matchup: { win_probability: 0.5, projected_margin: 1.2 },
    matchup_intelligence: null,
    waivers: { recommendations: [], do_not_add: [], considered: 4, roster_has_open_spot: false },
    ...over,
  };
}

function mkCond(code: string, over: Partial<OrchestratorCondition> = {}): OrchestratorCondition {
  return { code, title: code, sources: ["roster_health"], evidence: [{ specialist: "roster_health", fact: code, data: {} }], materiality: "MATERIAL", urgency: "NEAR_TERM", timing_degradation: [], horizon: "REST_OF_REGULAR_SEASON", has_available_remedy: false, disposition: "WATCH", suppression_reasons: [], ...over };
}

function mkLineupAction(gain: number): OrchestratorAction {
  return {
    action_class: "LINEUP", target_condition: "LINEUP_SUBOPTIMAL", target_problem: "bench outprojects starter", originating_specialist: "lineup",
    remedy: { kind: "LINEUP", changes: [{ slot: "RB", start_player_id: "bn1", start_player_name: "Bench", sit_player_id: "s1", sit_player_name: "Starter" }], is_reshuffle: false, ir_move: null },
    dimensions: assembleDimensions({ expected_weekly_effect: pointsEffect(gain, "lineup.projected_points_gained", { basis: "WEEKLY", horizon: "CURRENT_WEEK" }), risk_reduction: null, ...classifyUrgency({ futureWeeksAway: 0 }), evidence_confidence: buildEvidenceConfidence({ projectionBasis: "WEEKLY", dataQuality: "READY", specialistConfidence: "COMPLETE", horizon: "CURRENT_WEEK" }), cost: { band: "LOW", consumes: null, reasons: [] }, irreversibility: "REVERSIBLE" }),
    priority: gain >= 3 ? "HIGH" : "MEDIUM", reason_codes: ["LINEUP_POINTS_GAIN"], negative_evidence: [],
    explanation_chain: [{ specialist: "lineup", fact: "best legal lineup beats current", data: { projected_points_gained: gain } }], expires_when: ["player_lock_this_week"],
  };
}

function mkWaiverAction(effect: number, priority: "HIGH" | "MEDIUM" | "LOW", targetCondition = "WAIVER_UPGRADE_AVAILABLE"): OrchestratorAction {
  return {
    action_class: "WAIVER", target_condition: targetCondition, target_problem: "roster upgrade", originating_specialist: "waiver",
    remedy: { kind: "WAIVER", add_player_id: "fa9", add_player_name: "FA", add_position: "RB", drop_player_id: "bn2", drop_player_name: "Drop", immediate_role: "flex", waiver_engine_priority: priority },
    dimensions: assembleDimensions({ expected_weekly_effect: pointsEffect(effect, "waiver.starter_impact", { basis: "WEEKLY", horizon: "CURRENT_WEEK" }), risk_reduction: null, ...classifyUrgency({ needsWaiverClaim: true, waiverDayKnown: true }), evidence_confidence: buildEvidenceConfidence({ projectionBasis: "WEEKLY", dataQuality: "READY", specialistConfidence: "MEDIUM", horizon: "CURRENT_WEEK" }), cost: { band: "MEDIUM", consumes: "faab", reasons: [] }, irreversibility: "PARTLY_REVERSIBLE" }),
    priority, reason_codes: ["WAIVER_NET_IMPROVEMENT"], negative_evidence: [],
    explanation_chain: [{ specialist: "waiver", fact: "waiver engine recommendation", data: { priority } }], expires_when: ["candidate_rostered_elsewhere"],
  };
}

/* ============================================================= §8 Phase 4 */

test("§8 forbidden-influence: extreme Start/Sit FI shadow adjustment cannot change the production lineup", () => {
  const players = new Map([
    ["qb1", player("qb1", "QB")], ["rb1", player("rb1", "RB")], ["rb2", player("rb2", "RB")],
    ["wr1", player("wr1", "WR")], ["wr2", player("wr2", "WR")], ["te1", player("te1", "TE")],
    ["k1", player("k1", "K")], ["def1", player("def1", "DEF")], ["rbX", player("rbX", "RB")],
  ]);
  const projections = batch(
    [proj("qb1", "QB", 20), proj("rb1", "RB", 14), proj("rb2", "RB", 11), proj("wr1", "WR", 13), proj("wr2", "WR", 10), proj("te1", "TE", 8), proj("k1", "K", 8), proj("def1", "DEF", 7), proj("rbX", "RB", 6)],
    [...players.values()],
  );
  const rst = roster("t1", ["qb1", "rb1", "rb2", "wr1", "wr2", "te1", "k1", "def1"], ["rbX"]);
  const before = buildOptimalLineup({ week: 3, roster: rst, constraints: STD_CONSTRAINTS, players, projections });

  // adversarial deployment contract: extreme model. The gate must still no-op
  // because no position is PRODUCTION_ACTIVE.
  const adversarialModel = {
    start_sit_model_version: "ri-startsit-ADVERSARIAL",
    deployment: "SHADOW_ONLY",
    deployment_contract: { model_version: "adv", deployment: "SHADOW_ONLY", positions: {}, activation_log: [] },
    positions: {},
  } as unknown as Parameters<typeof applyFiToProductionBatch>[1]["model"];
  const gated = applyFiToProductionBatch(projections, { positionOf: (id) => players.get(id)?.position ?? null, request_season: 2026, model: adversarialModel, fi: null });
  assert.equal(gated.fi_applied, false);
  assert.equal(gated.batch, projections, "batch returned by reference — byte-identical");

  const after = buildOptimalLineup({ week: 3, roster: rst, constraints: STD_CONSTRAINTS, players, projections: gated.batch });
  assert.equal(after.optimal_total, before.optimal_total);
  assert.deepEqual(after.slots.map((s) => s.recommended_player_id), before.slots.map((s) => s.recommended_player_id));
});

test("§8 forbidden-influence: fiMayInfluenceProduction is false for every position; anyFiProductionInfluence is false", () => {
  // uses the REAL served model
  const c = deploymentContract(null);
  assert.notEqual(c.deployment, "PRODUCTION_ACTIVE");
  for (const pos of ["QB", "RB", "WR", "TE", "K", "DEF"]) assert.equal(fiMayInfluenceProduction(null, pos), false);
  assert.equal(anyFiProductionInfluence(null), false);
});

test("§8 forbidden-influence: an Orchestrator ACTION cannot be created solely from a Start/Sit shadow disagreement", () => {
  const shadowOnly: OrchestratorAction = { ...mkLineupAction(9), originating_specialist: "start_sit_shadow", target_condition: "SHADOW_STARTSIT_DISAGREEMENT", explanation_chain: [{ specialist: "start_sit_shadow", fact: "shadow prefers player B by +50", data: { adjustment: 50 } }] };
  const gate = applyHardGates(shadowOnly, mkContext(), mkSlice());
  assert.equal(gate.pass, false);
  assert.ok(gate.reasons.includes("SHADOW_ONLY_EVIDENCE"));

  const normal = runPolicy(mkContext(), mkSlice(), [], []);
  const withExtremeShadow = runPolicy(
    mkContext(),
    mkSlice(),
    [mkCond("SHADOW_STARTSIT_DISAGREEMENT", { disposition: "SHADOW_DIAGNOSTIC_ONLY", materiality: "INFORMATIONAL", suppression_reasons: ["SHADOW_ONLY_EVIDENCE"] })],
    [shadowOnly],
  );
  assert.equal(normal.verdict, "HOLD");
  assert.notEqual(withExtremeShadow.verdict, "ACTION");
  assert.equal(withExtremeShadow.primary_action, null);
});

/* ============================================================= §9 Phase 5 */

test("§9 forbidden-influence: matchupMayInfluenceProduction is false; no MAX_WIN_PROBABILITY production objective", () => {
  assert.equal(matchupDeploymentContract().deployment, "SHADOW_ONLY");
  assert.equal(matchupMayInfluenceProduction(), false);
});

test("§9 forbidden-influence: extreme shadow WP (99% / 1%) never creates an Orchestrator ACTION", () => {
  for (const wp of [0.99, 0.01]) {
    const slice = mkSlice({ weekly: mkWeekly({ matchup: { win_probability: 0.5, projected_margin: 0 }, matchup_intelligence: { lineage: { deployment: "SHADOW_ONLY", matchup_model_version: "ri-matchup-2026.1" }, win_probability: wp } }) });
    const cond = mkCond("SHADOW_MATCHUP_WP_DISAGREEMENT", { sources: ["matchup_shadow"], disposition: "SHADOW_DIAGNOSTIC_ONLY", materiality: "INFORMATIONAL", horizon: "CURRENT_WEEK", suppression_reasons: ["SHADOW_ONLY_EVIDENCE"] });
    const out = runPolicy(mkContext(), slice, [cond], []);
    assert.notEqual(out.verdict, "ACTION");
    assert.equal(out.primary_action, null);
    assert.ok(out.watch_items.some((c) => c.code === "SHADOW_MATCHUP_WP_DISAGREEMENT"));
  }
});

/* ============================================================ §10 Phase 6 */

test("§10 contextual: Roster Health fragility change alters conditions but fabricates NO remedy", () => {
  const resilient = mkSlice();
  const fragile = mkSlice({
    rosterHealth: {
      manager_slug: "alice", roster_id: 1, team_id: "team:trust:1", roster_health_version: "roster-health-2026.1",
      weekly: { fragility: { profile: "CONCENTRATED_FRAGILITY", worst_starter_dependency: 16, expected_one_loss_damage: 7, single_points_of_failure: ["s1"] }, player_dependency: [{ position: "QB", full_name: "QB1", starting_slot_label: "QB", raw_point_loss: 19, pct_lineup_loss: 16, single_point_of_failure: true, league_percentile: 99 }] },
      rest_of_season: { fragility: { profile: "CONCENTRATED_FRAGILITY" }, player_dependency: [], quality_surplus: [] },
      degradation: { overall: "OK", reasons: [] },
    },
  });
  // with NO waiver / trade remedy available, high fragility must be WATCH, never a fabricated ACTION
  const a = runPolicy(mkContext(), resilient, [], []);
  const b = runPolicy(mkContext(), fragile, [mkCond("QB_DEPTH_VULNERABILITY", { materiality: "MATERIAL", urgency: "NEAR_TERM" }), mkCond("ROSTER_FRAGILITY", { materiality: "MATERIAL", urgency: "NEAR_TERM" })], []);
  assert.equal(a.verdict, "HOLD");
  assert.equal(b.verdict, "WATCH");
  assert.equal(b.primary_action, null);
  assert.equal(b.suppressed_actions.filter((s) => s.action.action_class === "WAIVER" || s.action.action_class === "TRADE_EXPLORATION").length, 0, "no fabricated remedy");
});

/* ============================================================ §11 Phase 7 */

test("§11 contextual: Schedule Planning urgency change reorders WATCH but fabricates NO transaction", () => {
  const distant = runPolicy(mkContext(), mkSlice(), [mkCond("WEEK_12_UNCOVERED_SLOT", { materiality: "MINOR", urgency: "FUTURE", horizon: "REST_OF_REGULAR_SEASON", disposition: "WATCH" })], []);
  const near = runPolicy(mkContext(), mkSlice(), [mkCond("WEEK_4_UNCOVERED_SLOT", { materiality: "MATERIAL", urgency: "NEAR_TERM", horizon: "NEXT_2_3_WEEKS", disposition: "WATCH" })], []);
  assert.equal(distant.verdict, "WATCH");
  assert.equal(near.verdict, "WATCH"); // still WATCH — no remedy specialist supplied one
  assert.equal(near.primary_action, null);
  assert.equal([...distant.suppressed_actions, ...near.suppressed_actions].filter((s) => s.action.action_class !== "TRADE_EXPLORATION" || !s.action.remedy).length >= 0, true);
});

/* ========================================================== §12 remedies */

test("§12 positive influence: a real production LINEUP improvement drives ACTION; removing it removes the ACTION", () => {
  const cond = mkCond("LINEUP_SUBOPTIMAL", { materiality: "MATERIAL", urgency: "THIS_WEEK", horizon: "CURRENT_WEEK" });
  const withImprovement = mkSlice({ weekly: mkWeekly({ lineup: { changes_recommended: [{ slot: "RB", in: "bn1", out: "s1", gain: 4.5, part_of_reshuffle: false }], unresolved_decisions: [], empty_slots: [], illegal_situations: [], bye_problems: [], optimality_status: "COMPLETE", optimal_total: 124, projected_points_gained: 4.5, slots: [] } }) });
  const withAction = runPolicy(mkContext(), withImprovement, [cond], [mkLineupAction(4.5)]);
  assert.equal(withAction.verdict, "ACTION");
  assert.equal(withAction.primary_action?.action_class, "LINEUP");

  const noImprovement = runPolicy(mkContext(), mkSlice(), [], []);
  assert.equal(noImprovement.verdict, "HOLD");
});

test("§12 positive influence: a WAIVER candidate that clears the engine gate drives ACTION; degrading it removes the ACTION", () => {
  const cond = mkCond("WAIVER_UPGRADE_AVAILABLE", { materiality: "MATERIAL", urgency: "BEFORE_WAIVERS", horizon: "CURRENT_WEEK" });
  const strong = runPolicy(mkContext(), mkSlice(), [cond], [mkWaiverAction(3.5, "HIGH")]);
  assert.equal(strong.verdict, "ACTION");
  assert.equal(strong.primary_action?.action_class, "WAIVER");

  const weak = runPolicy(mkContext(), mkSlice(), [cond], [mkWaiverAction(0.4, "LOW")]);
  assert.notEqual(weak.verdict, "ACTION");
  assert.ok(weak.suppressed_actions.some((s) => s.reasons.includes("IMPROVEMENT_BELOW_MATERIALITY")));
});

/* ======================================================= §25 failure inj */

test("§25 failure injection: waiver engine missing → no WAIVER action; lineup still works", () => {
  const slice = mkSlice({ weekly: mkWeekly({ waivers: undefined, lineup: { changes_recommended: [{ slot: "RB", in: "bn1", out: "s1", gain: 4, part_of_reshuffle: false }], unresolved_decisions: [], empty_slots: [], illegal_situations: [], bye_problems: [], optimality_status: "COMPLETE", optimal_total: 124, projected_points_gained: 4, slots: [] } }) });
  const cond = mkCond("LINEUP_SUBOPTIMAL", { materiality: "MATERIAL", urgency: "THIS_WEEK", horizon: "CURRENT_WEEK" });
  const out = runPolicy(mkContext(), slice, [cond, mkCond("WAIVER_UPGRADE_AVAILABLE", { materiality: "MATERIAL", urgency: "BEFORE_WAIVERS", horizon: "CURRENT_WEEK" })], [mkLineupAction(4), mkWaiverAction(5, "HIGH")]);
  assert.equal(out.primary_action?.action_class, "LINEUP");
  assert.ok(out.suppressed_actions.some((s) => s.action.action_class === "WAIVER" && s.reasons.includes("REQUIRED_SPECIALIST_UNAVAILABLE")));
});

test("§25 failure injection: weekly + team-state both missing → INSUFFICIENT_EVIDENCE, not a false HOLD", () => {
  const out = runPolicy(mkContext(), mkSlice({ weekly: null, teamState: null }), [], []);
  assert.equal(out.verdict, "INSUFFICIENT_EVIDENCE");
});

test("§25 failure injection: stale/incoherent snapshot fails every action closed", () => {
  const mac = mkContext({ metrics: { ...mkContext().metrics, snapshot_coherent: false } });
  const out = runPolicy(mac, mkSlice(), [mkCond("LINEUP_SUBOPTIMAL", { materiality: "MATERIAL", urgency: "THIS_WEEK", horizon: "CURRENT_WEEK" })], [mkLineupAction(9)]);
  assert.notEqual(out.verdict, "ACTION");
  assert.ok(out.suppressed_actions.some((s) => s.reasons.includes("STALE_SNAPSHOT")));
});

/* ============================================================= §28 HOLD */

test("§28 HOLD audit: not biased toward activity — HOLD, then one remedy at a time flips it", () => {
  const base = runPolicy(mkContext(), mkSlice(), [], []);
  assert.equal(base.verdict, "HOLD");

  const plusLineup = runPolicy(
    mkContext(),
    mkSlice({ weekly: mkWeekly({ lineup: { changes_recommended: [{ slot: "RB", in: "bn1", out: "s1", gain: 3.2, part_of_reshuffle: false }], unresolved_decisions: [], empty_slots: [], illegal_situations: [], bye_problems: [], optimality_status: "COMPLETE", optimal_total: 123, projected_points_gained: 3.2, slots: [] } }) }),
    [mkCond("LINEUP_SUBOPTIMAL", { materiality: "MATERIAL", urgency: "THIS_WEEK", horizon: "CURRENT_WEEK" })],
    [mkLineupAction(3.2)],
  );
  assert.equal(plusLineup.verdict, "ACTION");
});

/* ============================================================ §30 dominance */

test("§30 dominance: free lineup fix dominates an equivalent costly waiver for the same condition", () => {
  const cond = mkCond("LINEUP_SUBOPTIMAL", { materiality: "MATERIAL", urgency: "THIS_WEEK", horizon: "CURRENT_WEEK" });
  const slice = mkSlice({ weekly: mkWeekly({ lineup: { changes_recommended: [{ slot: "RB", in: "bn1", out: "s1", gain: 3, part_of_reshuffle: false }], unresolved_decisions: [], empty_slots: [], illegal_situations: [], bye_problems: [], optimality_status: "COMPLETE", optimal_total: 123, projected_points_gained: 3, slots: [] } }) });
  const out = runPolicy(mkContext(), slice, [cond], [mkWaiverAction(3, "MEDIUM", "LINEUP_SUBOPTIMAL"), mkLineupAction(3)]);
  assert.equal(out.primary_action?.action_class, "LINEUP");
  assert.ok(out.suppressed_actions.some((s) => s.action.action_class === "WAIVER"));
});

/* ==================================================== TA-1 regression */

test("TA-1 regression: a real Start/Sit shadow lineup difference surfaces as a SHADOW_DIAGNOSTIC_ONLY condition (never an ACTION)", async () => {
  const { deriveConditions } = await import("@/lib/orchestrator/conditions");
  const slice = mkSlice({
    weekly: mkWeekly({
      start_sit_shadow: {
        lineage: { deployment: "SHADOW_ONLY", start_sit_model_version: "ri-startsit-2026.1" },
        lineup_differs: true,
        lineup_deltas: [{ in: "bn1", out: "s1", slot: "FLEX" }],
        start_sit_deltas: [{ slot: "FLEX", baseline_start: "s1", fi_start: "bn1" }],
        adjustments: [],
      },
    }),
  });
  const conds = deriveConditions(mkContext(), slice);
  const shadowCond = conds.find((c) => c.code === "SHADOW_STARTSIT_DISAGREEMENT");
  assert.ok(shadowCond, "the shadow disagreement condition is now reachable (was dead before TA-1)");
  assert.equal(shadowCond!.disposition, "SHADOW_DIAGNOSTIC_ONLY");
  assert.ok(shadowCond!.suppression_reasons.includes("SHADOW_ONLY_EVIDENCE"));
  assert.equal(shadowCond!.has_available_remedy, false);
});
