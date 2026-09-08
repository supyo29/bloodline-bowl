/**
 * Phase 8 — Team Management Orchestrator: deterministic certification.
 *
 * Covers the approved plan's §37 adversarial matrix + §38 invariants + §35
 * symmetry + §17 hard gates + §11 shadow prohibition + §14/§15 dimension
 * normalisation + §27 HOLD/WATCH/ACTION/INSUFFICIENT_EVIDENCE semantics, all at
 * the pure-policy level with synthetic inputs (no network).
 *
 * Live end-to-end coverage is in `test/orchestrator-live.test.ts`.
 * Specialist isolation is in `test/orchestrator-isolation.test.ts`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ORCHESTRATOR_DEPLOYMENT,
  ORCHESTRATOR_VERSION,
  orchestratorMayExecuteTransactions,
  type DecisionDimensions,
  type OrchestratorAction,
  type OrchestratorCondition,
} from "@/lib/orchestrator/schema";
import {
  assembleDimensions,
  buildEvidenceConfidence,
  categorical,
  classifyUrgency,
  minConfidence,
  pointsEffect,
} from "@/lib/orchestrator/dimensions";
import { applyHardGates } from "@/lib/orchestrator/gates";
import { runPolicy } from "@/lib/orchestrator/policy";
import type { ManagementAnalysisContext, ManagerAnalysisSlice } from "@/lib/orchestrator/context";

/* ------------------------------------------------------------------ helpers */

function mkContext(over: Partial<Record<string, unknown>> = {}): ManagementAnalysisContext {
  return {
    league: { league_slug: "test-league" },
    season: 2026,
    week: 2,
    snapshot: { league: { waiver_settings: { type: "faab", faab_budget: 100, waiver_day: "wed" } }, lineage: { snapshot_schema_version: 3 }, managers: [] },
    league_snapshot_id: "snap:test:2026:w2:abc",
    scoring_fingerprint: "scoring:v1:test",
    teamState: null,
    rosterHealth: null,
    schedulePlanning: null,
    tradeCtx: { lineage: { projections: [] } },
    weeklyByManager: new Map(),
    strategyByManager: new Map(),
    availability: { team_state: true, roster_health: true, schedule_planning: true, strategy: true, weekly: new Map() },
    metrics: { canonical_provider_reads: 1, team_state_builds: 1, roster_health_builds: 1, schedule_planning_builds: 1, trade_context_builds: 1, weekly_intelligence_builds: 1, ms: {}, snapshot_ids_seen: [], snapshot_coherent: true },
    warnings: [],
    options: {},
    versions: { orchestrator: ORCHESTRATOR_VERSION, team_state: "team-state-2026.1", roster_health: "roster-health-2026.1", schedule_planning: "schedule-planning-2026.1", strategy: "ri-trade-strategy-2026.2", weekly_engine: "post-draft-intel-2026.1", football_intelligence: "not_used", start_sit_shadow: "ri-startsit-2026.1", matchup_shadow: "ri-matchup-2026.1" },
    forManager: async () => null,
    ...over,
  } as unknown as ManagementAnalysisContext;
}

function mkSlice(over: Partial<Record<string, unknown>> = {}): ManagerAnalysisSlice {
  return {
    manager_slug: "alice",
    manager_display_name: "Alice",
    team_name: "Team Alice",
    roster_id: 1,
    canonical_team_id: "team:test:1",
    canonical_manager_id: "mgr:test:1",
    is_vacant: false,
    teamState: {
      identity: { manager_slug: "alice", roster_id: 1, canonical_team_id: "team:test:1", canonical_manager_id: "mgr:test:1", is_vacant: false, manager_display_name: "Alice", team_name: "Team Alice" },
      roster: { players: [], all_players: ["p1", "p2", "p3", "b1", "b2"], starters: ["p1", "p2", "p3"], bench: ["b1", "b2"], ir: [], taxi: [] },
    },
    rosterHealth: {
      manager_slug: "alice",
      roster_id: 1,
      team_id: "team:test:1",
      roster_health_version: "roster-health-2026.1",
      weekly: { fragility: { profile: "RESILIENT", worst_starter_dependency: 3, expected_one_loss_damage: 2, single_points_of_failure: [] }, player_dependency: [] },
      rest_of_season: { fragility: { profile: "RESILIENT" }, player_dependency: [], quality_surplus: [] },
      degradation: { overall: "OK", reasons: [] },
    },
    schedulePlanning: { manager_slug: "alice", roster_id: 1, team_id: "team:test:1", is_vacant: false, planning_model_version: "schedule-planning-2026.1", week_timeline: [], summary: { next_bye_week: null, weeks_with_uncovered_slots: [] }, degradation: { structure: "OK", value: "OK", reasons: [] } },
    strategy: { manager_id: "mgr:test:1", manager_slug: "alice", archetype: "CONTENDER", urgency: { score: 0.4, components: {} }, season: { season_stage: "EARLY_SEASON", weeks_remaining_regular: 12 } },
    weekly: mkWeekly(),
    ...over,
  } as unknown as ManagerAnalysisSlice;
}

function mkWeekly(over: Record<string, unknown> = {}): unknown {
  return {
    data_quality: { projections: "READY" },
    lineage: { snapshot: { league_snapshot_id: "snap:test:2026:w2:abc" } },
    lineup: {
      changes_recommended: [],
      unresolved_decisions: [],
      empty_slots: [],
      illegal_situations: [],
      bye_problems: [],
      optimality_status: "COMPLETE",
      optimal_total: 120,
      projected_points_gained: 0,
      slots: [],
    },
    start_sit: [],
    start_sit_shadow: null,
    matchup: { win_probability: 0.5 },
    matchup_intelligence: null,
    waivers: { recommendations: [], do_not_add: [], considered: 5, roster_has_open_spot: false },
    ...over,
  };
}

function mkLineupAction(gain: number, opts: { structural?: boolean; provisional?: boolean } = {}): OrchestratorAction {
  const ec = buildEvidenceConfidence({ projectionBasis: "WEEKLY", dataQuality: "READY", specialistConfidence: opts.provisional ? "PROVISIONAL" : "COMPLETE", horizon: "CURRENT_WEEK" });
  return {
    action_class: "LINEUP",
    target_condition: opts.structural ? "LINEUP_STRUCTURAL_DEFECT" : "LINEUP_SUBOPTIMAL",
    target_problem: opts.structural ? "Empty starter slot" : "A bench player outprojects a starter",
    originating_specialist: "lineup",
    remedy: { kind: "LINEUP", changes: [{ slot: "RB", start_player_id: "b1", start_player_name: "Bench Guy", sit_player_id: "p1", sit_player_name: "Starter" }], is_reshuffle: false, ir_move: null },
    dimensions: assembleDimensions({
      expected_weekly_effect: pointsEffect(gain, "lineup.projected_points_gained", { basis: "WEEKLY", horizon: "CURRENT_WEEK" }),
      risk_reduction: opts.structural ? categorical("POSITIVE", "MAJOR", "lineup") : null,
      ...classifyUrgency(opts.structural ? { isCurrentStructuralDefect: true } : { futureWeeksAway: 0 }),
      evidence_confidence: ec,
      cost: { band: "LOW", consumes: null, reasons: [] },
      irreversibility: "REVERSIBLE",
    }),
    priority: gain >= 3 ? "HIGH" : gain >= 1.25 ? "MEDIUM" : "LOW",
    reason_codes: ["LINEUP_POINTS_GAIN"],
    negative_evidence: [],
    explanation_chain: [{ specialist: "lineup", fact: "best legal lineup beats current", data: { projected_points_gained: gain } }],
    expires_when: ["player_lock_this_week"],
  };
}

function mkWaiverAction(effect: number, opts: { priority?: "HIGH" | "MEDIUM" | "LOW"; drop?: boolean; targetCondition?: string } = {}): OrchestratorAction {
  const ec = buildEvidenceConfidence({ projectionBasis: "WEEKLY", dataQuality: "READY", specialistConfidence: "MEDIUM", horizon: "CURRENT_WEEK" });
  return {
    action_class: "WAIVER",
    target_condition: opts.targetCondition ?? "WAIVER_UPGRADE_AVAILABLE",
    target_problem: "Roster upgrade at RB",
    originating_specialist: "waiver",
    remedy: { kind: "WAIVER", add_player_id: "fa1", add_player_name: "FA Guy", add_position: "RB", drop_player_id: opts.drop ? "b1" : null, drop_player_name: opts.drop ? "Bench Guy" : null, immediate_role: "flex", waiver_engine_priority: opts.priority ?? "MEDIUM" },
    dimensions: assembleDimensions({
      expected_weekly_effect: pointsEffect(effect, "waiver.starter_impact", { basis: "WEEKLY", horizon: "CURRENT_WEEK" }),
      risk_reduction: null,
      ...classifyUrgency({ needsWaiverClaim: true, waiverDayKnown: true }),
      evidence_confidence: ec,
      cost: { band: opts.drop ? "MEDIUM" : "MEDIUM", consumes: "faab", reasons: [] },
      irreversibility: "PARTLY_REVERSIBLE",
    }),
    priority: opts.priority ?? "MEDIUM",
    reason_codes: ["WAIVER_NET_IMPROVEMENT"],
    negative_evidence: [],
    explanation_chain: [{ specialist: "waiver", fact: "waiver engine recommendation", data: { priority: opts.priority ?? "MEDIUM" } }],
    expires_when: ["candidate_rostered_elsewhere"],
  };
}

function mkShadowOnlyAction(): OrchestratorAction {
  const a = mkLineupAction(5);
  a.originating_specialist = "start_sit_shadow";
  a.explanation_chain = [{ specialist: "start_sit_shadow", fact: "shadow prefers player B", data: {} }];
  a.target_condition = "SHADOW_STARTSIT_DISAGREEMENT";
  return a;
}

function mkCondition(code: string, over: Partial<OrchestratorCondition> = {}): OrchestratorCondition {
  return {
    code,
    title: code,
    sources: ["roster_health"],
    evidence: [{ specialist: "roster_health", fact: code, data: {} }],
    materiality: "MATERIAL",
    urgency: "NEAR_TERM",
    timing_degradation: [],
    horizon: "REST_OF_REGULAR_SEASON",
    has_available_remedy: false,
    disposition: "WATCH",
    suppression_reasons: [],
    ...over,
  };
}

/* ----------------------------------------------------------------- schema */

test("deployment contract: ADVISORY_ONLY, never executes", () => {
  assert.equal(ORCHESTRATOR_DEPLOYMENT, "ADVISORY_ONLY");
  assert.equal(orchestratorMayExecuteTransactions(), false);
  assert.equal(ORCHESTRATOR_VERSION, "team-management-orchestrator-2026.1");
});

/* -------------------------------------------------------- §14/§15 dimensions */

test("dimension normalisation keeps source units, never a 0-100 rescale", () => {
  const e = pointsEffect(3.4, "lineup.projected_points_gained", { basis: "WEEKLY" });
  assert.equal(e.value, 3.4);
  assert.equal(e.unit, "fantasy_points");
  assert.equal(e.source, "lineup.projected_points_gained");
  const c = categorical("POSITIVE", "MATERIAL", "roster_health.player_dependency");
  assert.equal(c.direction, "POSITIVE");
  assert.equal(c.magnitude_class, "MATERIAL");
  assert.equal(pointsEffect(null, "x").value, null); // never fabricated
});

test("P8-1: urgency never finer than week; NOW only for a current structural defect", () => {
  const struct = classifyUrgency({ isCurrentStructuralDefect: true });
  assert.equal(struct.urgency, "NOW");
  assert.ok(struct.timing_degradation.includes("EXACT_LOCK_TIME_UNAVAILABLE"));
  const waiver = classifyUrgency({ needsWaiverClaim: true, waiverDayKnown: false });
  assert.equal(waiver.urgency, "BEFORE_WAIVERS");
  assert.ok(waiver.timing_degradation.includes("WAIVER_DAY_UNKNOWN"));
  const far = classifyUrgency({ futureWeeksAway: 8 });
  assert.equal(far.urgency, "FUTURE");
  const near = classifyUrgency({ futureWeeksAway: 2 });
  assert.equal(near.urgency, "NEAR_TERM");
});

test("confidence propagation: ranking first never upgrades a LOW-evidence action (§22)", () => {
  const ec = buildEvidenceConfidence({ projectionBasis: "ROS_PROJECTION", dataQuality: "READY", specialistConfidence: "LOW UNRESOLVED", horizon: "REST_OF_REGULAR_SEASON" });
  assert.equal(ec.floor, "LOW");
  const d: DecisionDimensions = assembleDimensions({
    expected_weekly_effect: pointsEffect(10, "x"),
    risk_reduction: null,
    ...classifyUrgency({ futureWeeksAway: 0 }),
    evidence_confidence: ec,
    cost: { band: "LOW", consumes: null, reasons: [] },
    irreversibility: "REVERSIBLE",
  });
  assert.equal(d.confidence, "LOW");
  assert.equal(minConfidence("HIGH", "LOW", "MEDIUM"), "LOW");
});

/* ------------------------------------------------------------- §17 hard gates */

test("hard gate: shadow-only evidence can never pass to an ACTION (§11)", () => {
  const r = applyHardGates(mkShadowOnlyAction(), mkContext(), mkSlice());
  assert.equal(r.pass, false);
  assert.ok(r.reasons.includes("SHADOW_ONLY_EVIDENCE"));
});

test("hard gate: unavailable / illegal player is rejected", () => {
  const a = mkWaiverAction(4);
  (a.remedy as { add_player_id: string }).add_player_id = "p1"; // already on the roster
  const r = applyHardGates(a, mkContext(), mkSlice());
  assert.equal(r.pass, false);
  assert.ok(r.reasons.includes("ILLEGAL_OR_UNAVAILABLE"));
});

test("hard gate: tiny lineup edge fails the materiality gate", () => {
  const r = applyHardGates(mkLineupAction(0.2), mkContext(), mkSlice());
  assert.equal(r.pass, false);
  assert.ok(r.reasons.includes("IMPROVEMENT_BELOW_MATERIALITY"));
});

test("hard gate: required specialist missing blocks that action class (§42)", () => {
  const slice = mkSlice({ weekly: mkWeekly({ waivers: undefined }) });
  const r = applyHardGates(mkWaiverAction(5, { priority: "HIGH" }), mkContext(), slice);
  assert.equal(r.pass, false);
  assert.ok(r.reasons.includes("REQUIRED_SPECIALIST_UNAVAILABLE"));
});

test("hard gate: stale/incoherent snapshot fails closed", () => {
  const mac = mkContext({ metrics: { ...mkContext().metrics, snapshot_coherent: false } });
  const r = applyHardGates(mkLineupAction(5), mac, mkSlice());
  assert.equal(r.pass, false);
  assert.ok(r.reasons.includes("STALE_SNAPSHOT"));
});

/* ----------------------------------------------- §27 HOLD / WATCH / ACTION */

test("HOLD: already optimal + no waiver + resilient → HOLD with rationale (§2, §37.1)", () => {
  const out = runPolicy(mkContext(), mkSlice(), [], []);
  assert.equal(out.verdict, "HOLD");
  assert.ok(out.hold_rationale.length > 0);
  assert.ok(out.hold_rationale.some((r) => r.includes("ROSTER_ALREADY_OPTIMAL")));
  assert.ok(out.hold_rationale.some((r) => r.includes("ROSTER_HEALTH_RESILIENT")));
});

test("ACTION: obvious free lineup improvement → ACTION / LINEUP / HIGH (§37.2)", () => {
  const cond = mkCondition("LINEUP_SUBOPTIMAL", { materiality: "MATERIAL", urgency: "THIS_WEEK", horizon: "CURRENT_WEEK", disposition: "ACTIONED" });
  const out = runPolicy(mkContext(), mkSlice({ weekly: mkWeekly({ lineup: { ...(mkWeekly() as { lineup: object }).lineup, changes_recommended: [{ slot: "RB", in: "b1", out: "p1", gain: 4.2, part_of_reshuffle: false }], projected_points_gained: 4.2 } }) }), [cond], [mkLineupAction(4.2)]);
  assert.equal(out.verdict, "ACTION");
  assert.equal(out.primary_action?.action_class, "LINEUP");
  assert.equal(out.primary_action?.priority, "HIGH");
});

test("HOLD: tiny lineup improvement → not an ACTION (§37.3)", () => {
  const cond = mkCondition("LINEUP_SUBOPTIMAL", { materiality: "MINOR", urgency: "THIS_WEEK", disposition: "NOT_MATERIAL", suppression_reasons: ["IMPROVEMENT_BELOW_MATERIALITY"] });
  const out = runPolicy(mkContext(), mkSlice(), [cond], [mkLineupAction(0.3)]);
  assert.notEqual(out.verdict, "ACTION");
  assert.ok(out.suppressed_actions.some((s) => s.reasons.includes("IMPROVEMENT_BELOW_MATERIALITY")));
});

test("WATCH: severe fragility but no remedy → WATCH (§37.4)", () => {
  const slice = mkSlice({
    rosterHealth: { ...(mkSlice().rosterHealth as object), weekly: { fragility: { profile: "CONCENTRATED_FRAGILITY", worst_starter_dependency: 14, expected_one_loss_damage: 6, single_points_of_failure: ["p1"] }, player_dependency: [{ position: "QB", full_name: "QB1", starting_slot_label: "QB", raw_point_loss: 18, pct_lineup_loss: 15, single_point_of_failure: true, league_percentile: 96 }] } },
  });
  const cond = mkCondition("QB_DEPTH_VULNERABILITY", { materiality: "MATERIAL", urgency: "NEAR_TERM", has_available_remedy: false });
  const out = runPolicy(mkContext(), slice, [cond], []); // no candidates → no remedy
  assert.equal(out.verdict, "WATCH");
  assert.ok(out.watch_items.some((c) => c.code === "QB_DEPTH_VULNERABILITY"));
});

test("ACTION: severe fragility + strong waiver remedy → ACTION / WAIVER (§37.5)", () => {
  const cond = mkCondition("QB_DEPTH_VULNERABILITY", { materiality: "MATERIAL", urgency: "NEAR_TERM" });
  const wa = mkWaiverAction(4.5, { priority: "HIGH", targetCondition: "QB_DEPTH_VULNERABILITY" });
  const slice = mkSlice({ weekly: mkWeekly({ waivers: { recommendations: [], do_not_add: [], considered: 3, roster_has_open_spot: true } }) });
  const out = runPolicy(mkContext(), slice, [cond], [wa]);
  assert.equal(out.verdict, "ACTION");
  assert.equal(out.primary_action?.action_class, "WAIVER");
});

test("WATCH: distant future bye hole (week 10 seen in week 2) → WATCH not ACTION (§37.6)", () => {
  const cond = mkCondition("WEEK_10_UNCOVERED_SLOT", { materiality: "MINOR", urgency: "FUTURE", horizon: "REST_OF_REGULAR_SEASON", disposition: "WATCH", suppression_reasons: ["FUTURE_CONCERN_TOO_DISTANT"] });
  const out = runPolicy(mkContext(), mkSlice(), [cond], []);
  assert.notEqual(out.verdict, "ACTION");
  assert.ok(out.watch_items.some((c) => c.code === "WEEK_10_UNCOVERED_SLOT"));
});

test("INSUFFICIENT_EVIDENCE distinct from HOLD when a required specialist failed (§27)", () => {
  const slice = mkSlice({ weekly: null });
  const out = runPolicy(mkContext(), slice, [], []);
  assert.equal(out.verdict, "INSUFFICIENT_EVIDENCE");
});

/* --------------------------------------------------- §24 dominance / suppression */

test("dominance: free lineup swap dominates a costly waiver for the SAME problem (§37.12)", () => {
  const cond = mkCondition("LINEUP_SUBOPTIMAL", { materiality: "MATERIAL", urgency: "THIS_WEEK", horizon: "CURRENT_WEEK" });
  const lineup = mkLineupAction(3.0);
  const waiver = mkWaiverAction(3.0, { priority: "MEDIUM", drop: true, targetCondition: "LINEUP_SUBOPTIMAL" });
  const slice = mkSlice({ weekly: mkWeekly({ lineup: { ...(mkWeekly() as { lineup: object }).lineup, changes_recommended: [{ slot: "RB", in: "b1", out: "p1", gain: 3, part_of_reshuffle: false }], projected_points_gained: 3 } }) });
  const out = runPolicy(mkContext(), slice, [cond], [waiver, lineup]);
  assert.equal(out.primary_action?.action_class, "LINEUP");
  assert.ok(out.suppressed_actions.some((s) => s.action.action_class === "WAIVER" && (s.reasons.includes("DOMINATED_BY_LINEUP") || s.reasons.includes("ACTION_DUPLICATES_OTHER"))));
});

test("independent actions both surface: a lineup fix AND a separate waiver upgrade (§25, §37.28)", () => {
  const c1 = mkCondition("LINEUP_SUBOPTIMAL", { materiality: "MATERIAL", urgency: "THIS_WEEK", horizon: "CURRENT_WEEK" });
  const c2 = mkCondition("WAIVER_UPGRADE_AVAILABLE", { materiality: "MATERIAL", urgency: "BEFORE_WAIVERS", horizon: "CURRENT_WEEK" });
  const slice = mkSlice({
    weekly: mkWeekly({
      lineup: { ...(mkWeekly() as { lineup: object }).lineup, changes_recommended: [{ slot: "RB", in: "b1", out: "p1", gain: 3.5, part_of_reshuffle: false }], projected_points_gained: 3.5 },
      waivers: { recommendations: [], do_not_add: [], considered: 3, roster_has_open_spot: true },
    }),
  });
  const out = runPolicy(mkContext(), slice, [c1, c2], [mkLineupAction(3.5), mkWaiverAction(3.0, { priority: "HIGH" })]);
  assert.equal(out.verdict, "ACTION");
  assert.equal(out.primary_action?.action_class, "LINEUP");
  assert.ok(out.secondary_actions.some((a) => a.action_class === "WAIVER"));
});

/* -------------------------------------------------- §11 shadow prohibition */

test("§38 invariant: swapping the shadow payload never changes primary/secondary actions", () => {
  const cond = mkCondition("LINEUP_SUBOPTIMAL", { materiality: "MATERIAL", urgency: "THIS_WEEK", horizon: "CURRENT_WEEK" });
  const slice = mkSlice({ weekly: mkWeekly({ lineup: { ...(mkWeekly() as { lineup: object }).lineup, changes_recommended: [{ slot: "RB", in: "b1", out: "p1", gain: 4, part_of_reshuffle: false }], projected_points_gained: 4 } }) });
  const a = runPolicy(mkContext(), slice, [cond], [mkLineupAction(4)]);
  // now add an adversarial shadow-only action that "prefers" a different player
  const b = runPolicy(mkContext(), slice, [cond, mkCondition("SHADOW_STARTSIT_DISAGREEMENT", { disposition: "SHADOW_DIAGNOSTIC_ONLY", materiality: "INFORMATIONAL", suppression_reasons: ["SHADOW_ONLY_EVIDENCE"] })], [mkLineupAction(4), mkShadowOnlyAction()]);
  assert.deepEqual(a.primary_action?.remedy, b.primary_action?.remedy);
  assert.equal(a.verdict, b.verdict);
  assert.ok(b.suppressed_actions.some((s) => s.reasons.includes("SHADOW_ONLY_EVIDENCE")));
});

/* --------------------------------------------------------------- §35 symmetry */

test("§35: identical underlying state, different manager slug → identical policy result", () => {
  const cond = mkCondition("LINEUP_SUBOPTIMAL", { materiality: "MATERIAL", urgency: "THIS_WEEK", horizon: "CURRENT_WEEK" });
  const cand = [mkLineupAction(3.5)];
  const base = mkSlice({ weekly: mkWeekly({ lineup: { ...(mkWeekly() as { lineup: object }).lineup, changes_recommended: [{ slot: "RB", in: "b1", out: "p1", gain: 3.5, part_of_reshuffle: false }], projected_points_gained: 3.5 } }) });
  const alice = runPolicy(mkContext(), base, [cond], cand);
  const bob = runPolicy(mkContext(), mkSlice({ ...(base as object), manager_slug: "bob", canonical_manager_id: "mgr:test:2", weekly: base.weekly }), [cond], cand);
  assert.equal(alice.verdict, bob.verdict);
  assert.deepEqual(alice.primary_action?.remedy, bob.primary_action?.remedy);
  assert.deepEqual(alice.primary_action?.dimensions, bob.primary_action?.dimensions);
});

/* -------------------------------------------------------------- §38 determinism */

test("§38 invariant: same inputs → byte-identical policy output", () => {
  const cond = [mkCondition("QB_DEPTH_VULNERABILITY", { materiality: "MATERIAL", urgency: "NEAR_TERM" }), mkCondition("WAIVER_UPGRADE_AVAILABLE", { materiality: "MATERIAL", urgency: "BEFORE_WAIVERS", horizon: "CURRENT_WEEK" })];
  const cand = [mkWaiverAction(4, { priority: "HIGH" }), mkWaiverAction(2, { priority: "MEDIUM" })];
  const a = runPolicy(mkContext(), mkSlice(), cond, cand);
  const b = runPolicy(mkContext(), mkSlice(), cond, cand);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

/* ----------------------------------------------- §37 remaining adversarial table */

test("§37 adversarial matrix — verdict shape per scenario", () => {
  const scenarios: Array<{ n: string; conds: OrchestratorCondition[]; cands: OrchestratorAction[]; slice?: ManagerAnalysisSlice; expect: (v: string) => boolean }> = [
    { n: "8 waiver requires dropping equal bench value → HOLD/WATCH", conds: [mkCondition("WAIVER_UPGRADE_AVAILABLE", { materiality: "MINOR", disposition: "NOT_MATERIAL", suppression_reasons: ["DROP_COST_EXCEEDS_BENEFIT"] })], cands: [mkWaiverAction(0.5, { priority: "LOW", drop: true })], expect: (v) => v === "HOLD" || v === "WATCH" },
    { n: "13 start/sit shadow disagreement only → WATCH, no ACTION", conds: [mkCondition("SHADOW_STARTSIT_DISAGREEMENT", { disposition: "SHADOW_DIAGNOSTIC_ONLY", materiality: "INFORMATIONAL", suppression_reasons: ["SHADOW_ONLY_EVIDENCE"] })], cands: [mkShadowOnlyAction()], expect: (v) => v !== "ACTION" },
    { n: "15 roster health fragile / remedies poor → WATCH", conds: [mkCondition("ROSTER_FRAGILITY", { materiality: "MATERIAL", urgency: "NEAR_TERM" })], cands: [], expect: (v) => v === "WATCH" },
    { n: "16 schedule future risk / current healthy → WATCH", conds: [mkCondition("WEEK_9_UNCOVERED_SLOT", { materiality: "MINOR", urgency: "NEAR_TERM", disposition: "WATCH" })], cands: [], expect: (v) => v === "WATCH" },
    { n: "19 K/DST stream opportunity → ACTION/WAIVER", conds: [mkCondition("WAIVER_UPGRADE_AVAILABLE", { materiality: "MATERIAL", urgency: "BEFORE_WAIVERS", horizon: "CURRENT_WEEK" })], cands: [mkWaiverAction(3.2, { priority: "HIGH" })], expect: (v) => v === "ACTION" },
    { n: "30 nothing useful anywhere → HOLD", conds: [], cands: [], expect: (v) => v === "HOLD" },
  ];
  for (const s of scenarios) {
    const out = runPolicy(mkContext(), s.slice ?? mkSlice(), s.conds, s.cands);
    assert.ok(s.expect(out.verdict), `${s.n}: got ${out.verdict}`);
  }
});

test("§38 invariant: illegal transaction never recommended; unavailable player never 'available'", () => {
  const bad = mkWaiverAction(9, { priority: "HIGH" });
  (bad.remedy as { drop_player_id: string }).drop_player_id = "not-on-roster";
  const out = runPolicy(mkContext(), mkSlice(), [mkCondition("WAIVER_UPGRADE_AVAILABLE", { materiality: "MATERIAL", urgency: "BEFORE_WAIVERS", horizon: "CURRENT_WEEK" })], [bad]);
  assert.notEqual(out.primary_action?.action_class, "WAIVER");
  assert.ok(out.suppressed_actions.some((s) => s.reasons.includes("ILLEGAL_OR_UNAVAILABLE")));
});

test("§38 invariant: a distant future issue does not outrank an immediate material problem", () => {
  const immediate = mkCondition("LINEUP_SUBOPTIMAL", { materiality: "MATERIAL", urgency: "THIS_WEEK", horizon: "CURRENT_WEEK" });
  const distant = mkCondition("WEEK_12_UNCOVERED_SLOT", { materiality: "MINOR", urgency: "FUTURE", horizon: "REST_OF_REGULAR_SEASON", disposition: "NOT_URGENT" });
  const slice = mkSlice({ weekly: mkWeekly({ lineup: { ...(mkWeekly() as { lineup: object }).lineup, changes_recommended: [{ slot: "RB", in: "b1", out: "p1", gain: 3, part_of_reshuffle: false }], projected_points_gained: 3 } }) });
  const out = runPolicy(mkContext(), slice, [distant, immediate], [mkLineupAction(3)]);
  assert.equal(out.primary_action?.target_condition, "LINEUP_SUBOPTIMAL");
});
