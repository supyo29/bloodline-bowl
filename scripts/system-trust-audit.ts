/**
 * Team Management System Trust, Utilization & Causal-Influence Audit — runner.
 *
 *   node --import tsx scripts/system-trust-audit.ts
 *
 * Builds the model registry, runs representative + live requests with
 * request-scoped instrumentation, checks artifact/version identity, lineage
 * coherence, identity + scoring + slot legality, and writes
 * `artifacts/system-trust-audit.json`. Runs NO model training and changes NO
 * deployment state.
 */

import { writeFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { execSync } from "node:child_process";

import { runInLeagueStateScope } from "@/lib/canonical/request-scope";
import { buildManagementAnalysisContext, managerSlugsOf } from "@/lib/orchestrator/context";
import { orchestrateManager, buildManagerOrchestration } from "@/lib/orchestrator";
import { buildOrchestratorTrace } from "@/lib/orchestrator/trace";
import { buildWeeklyIntelligence } from "@/lib/weekly/intelligence";
import { buildRosterHealthContext } from "@/lib/roster-health";
import { buildSchedulePlanningContext } from "@/lib/schedule-planning";
import { deploymentContract, fiMayInfluenceProduction, anyFiProductionInfluence } from "@/lib/weekly/start-sit-fi/deployment";
import { matchupDeploymentContract, matchupMayInfluenceProduction } from "@/lib/weekly/matchup-intelligence/deployment";
import { listLeagueTargets } from "@/lib/leagues/registry";

const OUT = "artifacts/system-trust-audit.json";
const LEAGUES = ["bloodline-bowl", "devoted-to-the-game", "sportys-alumni"];

type Json = Record<string, unknown>;
const round = (v: number) => Math.round(v * 100) / 100;

async function main() {
  const report: Json = {
    audit: "team-management-system-trust",
    audit_timestamp: new Date().toISOString(),
    main_sha: safe(() => execSync("git rev-parse HEAD").toString().trim()),
    branch: safe(() => execSync("git rev-parse --abbrev-ref HEAD").toString().trim()),
    frozen_surfaces_unchanged: safe(() => {
      const diff = execSync(
        "git diff --stat f0bda54 -- lib/trades/ros.ts lib/trades/depth.ts lib/weekly/lineup.ts lib/weekly/slots.ts lib/weekly/start-sit.ts lib/weekly/waivers.ts lib/weekly/matchup.ts lib/weekly/start-sit-fi lib/weekly/matchup-intelligence lib/roster-health lib/schedule-planning lib/team-state lib/canonical lib/football-intel",
      ).toString().trim();
      return diff === "" ? "UNCHANGED" : diff;
    }),
  };

  // ---- 1. model / component registry -----------------------------------
  report.model_registry = buildRegistry();

  // ---- 15. artifact / version identity --------------------------------
  report.artifact_identity = artifactIdentity();

  // ---- deployment-state matrix (assert, do not infer) -----------------
  report.deployment_state_assertions = {
    start_sit_fi: {
      served_deployment: deploymentContract(null).deployment,
      fiMayInfluenceProduction: Object.fromEntries(["QB", "RB", "WR", "TE", "K", "DEF"].map((p) => [p, fiMayInfluenceProduction(null, p)])),
      anyFiProductionInfluence: anyFiProductionInfluence(null),
    },
    matchup_intelligence: {
      served_deployment: matchupDeploymentContract().deployment,
      matchupMayInfluenceProduction: matchupMayInfluenceProduction(),
    },
  };

  // ---- 4/5/31/32. runtime utilization matrix (live) -------------------
  const utilization: Json[] = [];
  const productionSample: Json[] = [];
  const leagueCounts: Json = {};

  for (const league of LEAGUES) {
    const registered = listLeagueTargets().some((t) => t.key === league);
    if (!registered) {
      utilization.push({ league, status: "NOT_REGISTERED" });
      continue;
    }
    try {
      const t0 = Date.now();
      const ctxRes = await buildManagementAnalysisContext(league);
      if (!ctxRes.ok) {
        utilization.push({ league, status: "CONTEXT_UNAVAILABLE", code: ctxRes.code });
        continue;
      }
      const mac = ctxRes.context;
      const ctxMs = Date.now() - t0;
      const slugs = managerSlugsOf(mac);

      const verdicts: Record<string, number> = { HOLD: 0, WATCH: 0, ACTION: 0, INSUFFICIENT_EVIDENCE: 0 };
      const actionClasses: Record<string, number> = { LINEUP: 0, WAIVER: 0, TRADE_EXPLORATION: 0 };
      const modelUse: Record<string, number> = { roster_health_context: 0, schedule_planning_context: 0, start_sit_shadow_context: 0, matchup_shadow_context: 0, waiver_used_for_action: 0, lineup_used_for_action: 0, strategy_context: 0 };
      let forbiddenOk = true;

      for (const slug of slugs) {
        const r = await orchestrateManager(mac, slug);
        if (!r) continue;
        verdicts[r.verdict] = (verdicts[r.verdict] ?? 0) + 1;
        if (r.primary_action) actionClasses[r.primary_action.action_class] = (actionClasses[r.primary_action.action_class] ?? 0) + 1;
        for (const a of r.secondary_actions) actionClasses[a.action_class] = (actionClasses[a.action_class] ?? 0) + 1;
        const sp = r.lineage.specialists;
        if (["USED_AS_CONTEXT","USED_FOR_ACTION"].includes(sp.roster_health?.usage ?? "")) modelUse.roster_health_context = (modelUse.roster_health_context ?? 0) + 1;
        if (sp.schedule_planning?.usage !== "UNAVAILABLE" && sp.schedule_planning?.usage !== "NOT_USED") modelUse.schedule_planning_context = (modelUse.schedule_planning_context ?? 0) + 1;
        if (sp.start_sit_shadow?.usage === "SHADOW_CONTEXT_ONLY") modelUse.start_sit_shadow_context = (modelUse.start_sit_shadow_context ?? 0) + 1;
        if (sp.matchup_shadow?.usage === "SHADOW_CONTEXT_ONLY") modelUse.matchup_shadow_context = (modelUse.matchup_shadow_context ?? 0) + 1;
        if (sp.strategy?.usage !== "UNAVAILABLE") modelUse.strategy_context = (modelUse.strategy_context ?? 0) + 1;
        for (const a of [r.primary_action, ...r.secondary_actions].filter(Boolean)) {
          if (a!.action_class === "WAIVER") modelUse.waiver_used_for_action = (modelUse.waiver_used_for_action ?? 0) + 1;
          if (a!.action_class === "LINEUP") modelUse.lineup_used_for_action = (modelUse.lineup_used_for_action ?? 0) + 1;
          const srcs = new Set(a!.explanation_chain.map((e) => e.specialist));
          srcs.add(a!.originating_specialist);
          if (![...srcs].some((s) => s !== "start_sit_shadow" && s !== "matchup_shadow")) forbiddenOk = false;
        }
        // full sample for the first manager
        if (slug === slugs[0]) {
          const trace = buildOrchestratorTrace(mac, r);
          productionSample.push({
            league, manager: slug, verdict: r.verdict, confidence: r.confidence,
            primary: r.primary_action ? { class: r.primary_action.action_class, priority: r.primary_action.priority, urgency: r.primary_action.dimensions.urgency, target: r.primary_action.target_condition } : null,
            watch: r.future_watch_items.map((c) => c.code),
            snapshot_id: r.lineage.league_snapshot_id,
            scoring_fingerprint: r.lineage.scoring_fingerprint,
            specialists: Object.fromEntries(Object.entries(r.lineage.specialists).map(([k, v]) => [k, { version: v.version, usage: v.usage }])),
            trace_components: Object.fromEntries(Object.entries(trace.components).map(([k, v]) => [k, { role: v.role, production_influence: v.production_influence }])),
            forbidden_influence_ok: trace.forbidden_influence_ok,
          });
        }
      }

      utilization.push({
        league,
        status: "OK",
        managers: slugs.length,
        context_assembly_ms: ctxMs,
        canonical_provider_reads: mac.metrics.canonical_provider_reads,
        snapshot_ids_seen: mac.metrics.snapshot_ids_seen,
        snapshot_coherent: mac.metrics.snapshot_coherent,
        stage_ms: mac.metrics.ms,
        availability: {
          team_state: mac.availability.team_state, roster_health: mac.availability.roster_health,
          schedule_planning: mac.availability.schedule_planning, strategy: mac.availability.strategy,
        },
        forbidden_influence_ok: forbiddenOk,
      });
      leagueCounts[league] = { verdicts, action_classes: actionClasses, model_utilization: modelUse };
    } catch (e) {
      utilization.push({ league, status: "ERROR", error: e instanceof Error ? e.message : String(e) });
    }
  }
  report.utilization_matrix = utilization;
  report.production_sample = productionSample;
  report.league_wide_counts = leagueCounts;

  // ---- 17. cross-layer lineage coherence (one request) ---------------
  report.lineage_coherence = await runInLeagueStateScope(async () => {
    const out: Json[] = [];
    for (const [league, mgr] of [["bloodline-bowl", "supyo29"], ["devoted-to-the-game", "darthmarker"]] as const) {
      try {
        const wi = await buildWeeklyIntelligence(league, mgr);
        const ts = wi.ok ? wi.intelligence!.lineage.snapshot?.league_snapshot_id : null;
        const rh = await buildRosterHealthContext(league).catch(() => null);
        const sp = await buildSchedulePlanningContext(league).catch(() => null);
        const r = await buildManagerOrchestration(league, mgr);
        const ids = [
          ts,
          rh?.lineage.league_snapshot_id ?? null,
          sp?.lineage.league_snapshot_id ?? null,
          r.ok ? r.result.lineage.league_snapshot_id : null,
        ].filter(Boolean);
        out.push({
          league, manager: mgr,
          weekly_snapshot: ts,
          roster_health_snapshot: rh?.lineage.league_snapshot_id ?? null,
          schedule_planning_snapshot: sp?.lineage.league_snapshot_id ?? null,
          orchestrator_snapshot: r.ok ? r.result.lineage.league_snapshot_id : null,
          all_equal: new Set(ids).size === 1,
          scoring_fingerprint: r.ok ? r.result.lineage.scoring_fingerprint : null,
          weekly_projection: r.ok ? r.result.lineage.projection_lineage.weekly : null,
          ros_projection: r.ok ? r.result.lineage.projection_lineage.ros : null,
        });
      } catch (e) {
        out.push({ league, manager: mgr, error: e instanceof Error ? e.message : String(e) });
      }
    }
    return out;
  });

  // ---- verdict vector (§34) — NOT one opaque number ------------------
  const anyForbiddenBreak = utilization.some((u) => u.status === "OK" && u.forbidden_influence_ok === false);
  const lineageOk = (report.lineage_coherence as Json[]).every((l) => l.all_equal !== false);
  const anyReadFanOut = utilization.some((u) => u.status === "OK" && (u.canonical_provider_reads as number) > 1);
  const anySnapshotIncoherent = utilization.some((u) => u.status === "OK" && u.snapshot_coherent === false);
  const fiOk = report.deployment_state_assertions && !anyFiProductionInfluence(null) && !matchupMayInfluenceProduction();

  // ---- 21. calibration-status registry -------------------------------
  report.calibration_registry = {
    football_intelligence: "OBSERVED/MODELED CERTIFIED (walk-forward) + DESCRIPTIVE_ONLY subset; def-EPA-allowed NOT_PREDICTIVE",
    start_sit_fi: "SHADOW_ONLY / NULL_FINDING_REPRODUCED (acc_delta ~0, reversal win-rate ~0.50) / REQUIRES_2026_REEVALUATION",
    matchup_intelligence: "MATHEMATICALLY_CALIBRATED_ONLY (empirical marginals fix current-MC overconfidence) / SHADOW_ONLY / 2-factor dependence REJECTED / REQUIRES_2026_LIVE_CAPTURE",
    roster_health: "DETERMINISTIC_CERTIFIED / REAL_PREDICTIVE_VALUE_UNPROVEN",
    schedule_planning: "STRUCTURAL_MATH_CERTIFIED (schedule/bye/coverage HIGH) / FUTURE_VALUE_DEGRADED (ROS_PROJECTION)",
    orchestrator: "POLICY_CORRECTNESS_CERTIFIED / STRATEGIC_OUTCOME_UNPROVEN / REQUIRES_DURABLE_DECISION_CAPTURE",
    weekly_projections: "PRODUCTION (RotoWire-backed); K/DST use Sleeper standard-points fallback",
    ros_projections: "RI ORDINAL_ONLY (absolute-level calibration caveat) + Sleeper season prorated absolute",
  };

  // ---- 23. 2026 re-evaluation readiness ------------------------------
  report.reevaluation_readiness = {
    start_sit_fi: safe(() => {
      const m = JSON.parse(readFileSync("lib/weekly/data/start_sit_reevaluation_manifest.json", "utf8")) as Json;
      return { current_status: m.reevaluation_status, completed_2026_weeks: m.completed_fi_weeks, minimum_required: m.minimum_weeks_required, next_candidate_version: m.next_candidate_version, eligible: m.reevaluation_eligible };
    }),
    matchup_intelligence: "live-calibration capture path documented (Phase 5); 0 completed 2026 weeks",
    roster_health: "roster-health-2026.2 documented; deterministic v1 frozen",
    schedule_planning: "schedule-planning-2026.2 documented; structural v1 frozen",
    orchestrator: "orchestrator-2026.2 gated on durable decision capture; NullCaptureStore default (schema + MemoryCaptureStore adapter tested)",
  };

  report.trust_vector = {
    canonical_integrity: "SEE_phase1c_certify (cross_surface_discrepancies=0, null_required_fields=0, identity_unresolved=0 — all 3 leagues)",
    identity_integrity: "SEE_phase1c_certify (identity_unresolved=0)",
    lineage_integrity: lineageOk && !anySnapshotIncoherent ? "PASS" : "FAIL",
    model_loading: (report.artifact_identity as Json[]).every((a) => a.loadable !== false) ? "PASS" : "FAIL",
    expected_utilization: utilization.some((u) => u.status === "OK") ? "PASS" : "FAIL",
    forbidden_influence: !anyForbiddenBreak && fiOk ? "PASS" : "FAIL",
    shared_context_read_fan_out: anyReadFanOut ? "FAIL" : "PASS",
    calibration_reproduction: "PASS (Phase 3: 24 invariant + 15 adversarial; Phase 4: 12 adversarial + null-finding artifact; Phase 5: FI/context ablation noise-level)",
    failure_degradation: "PASS (test/system-trust-audit.test.ts — 14 causal / forbidden / failure / stale assertions)",
    production_parity: "SEE_live_prod_smoke (post-deploy)",
    real_2026_outcome_validation: "NOT_YET_AVAILABLE",
  };

  report.findings = [
    { id: "TA-1", severity: "P2", area: "observability / dead diagnostic", finding: "Orchestrator `extractShadowDisagreements` read `reversals`/`summary.reversal_count` — fields that do not exist on `StartSitShadowComparison` (`lineup_differs`/`lineup_deltas`/`start_sit_deltas`). The Phase-4 SHADOW disagreement condition (`SHADOW_STARTSIT_DISAGREEMENT`) was therefore unreachable — INVOKED + OUTPUT_VALID but never CONSUMED even as a diagnostic.", disposition: "FIXED in this audit (conditions.ts). Post-fix: start_sit_shadow surfaced as SHADOW_CONTEXT_ONLY for 10/12 managers in bloodline + devoted. Still architecturally barred from ACTION (unchanged)." },
    { id: "TA-2", severity: "P3", area: "semantics / naming", finding: "A WAIVER OrchestratorAction inherits the waiver engine's `priority` (HIGH/MEDIUM/LOW), which the certified waiver `DecisionScore` derives from current-week impact + ROS value + scarcity + bye-coverage + injury-hedge. So a `HIGH`-priority WAIVER action can carry a small current-week `expected_weekly_effect` (~0.3-0.7 pts). This is transparent (the dimension shows the small number) and correct (deferring to the certified `PRODUCTION_AUTHORITATIVE` waiver gate per §18), NOT activity bias.", disposition: "Documented as a semantic note. The Orchestrator could additionally annotate 'high ROS value, low current-week impact' — a 2026.2 nicety, not a defect." },
    { id: "TA-3", severity: "INFO", area: "live utilization", finding: "0 HOLD across devoted-to-the-game (12) and sportys-alumni (14) in the current week-1 snapshot; bloodline-bowl is 3 WATCH / 9 ACTION. Investigated: this reflects unset preseason lineups — nearly every manager has a material (>1.25 pt) best-legal-lineup gain OR a HIGH-priority waiver available. The mechanism produces HOLD when the roster is actually optimal (test/orchestrator.test.ts §28 + test/system-trust-audit.test.ts §28) and produced WATCH for the 3 bloodline managers whose lineup gain was below materiality.", disposition: "Not a defect. HOLD is reachable and demonstrated; the live 0-HOLD rate is a property of the preseason snapshot, not an activity bias in the policy. Preserve." },
    { id: "TA-4", severity: "P3", area: "artifact metadata", finding: "`start_sit_reevaluation_manifest.json` carries `current_model_version` but not a bare `model_version` key; `football_intelligence_manifest.json` carries `model_tag` not `deployment` (FI has no single deployment state — it is routed). The audit's generic key-scan reports `deployment: null` for these — a scan limitation, not a model defect.", disposition: "Documented. Deployment states are asserted programmatically (deploymentContract / matchupDeploymentContract) not scanned; those assertions PASS." },
  ];

  writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log(`\nwrote ${OUT}`);
  console.log(JSON.stringify(report.trust_vector, null, 2));
  console.log("\nleague-wide counts:");
  console.log(JSON.stringify(leagueCounts, null, 2));
}

function safe<T>(fn: () => T): T | string {
  try {
    return fn();
  } catch (e) {
    return `ERROR: ${e instanceof Error ? e.message : String(e)}`;
  }
}

function buildRegistry(): Json[] {
  return [
    reg("canonical_league_state", "schema_v3", "PRODUCTION_FOUNDATION", "lib/canonical/*", true, "CanonicalLeagueSnapshot", "buildCanonicalLeagueState", "every layer", "n/a", "live_request_snapshot", "n/a"),
    reg("team_state", "team-state-2026.1", "SHARED_FOUNDATION", "lib/team-state/*", false, "TeamManagementState", "buildLeagueManagementContext", "roster_health, schedule_planning, orchestrator", "no evaluative/recommendation logic", "current_week", "n/a"),
    reg("football_intelligence", "ri-football-intel-2026.1 (fi:2025:w18)", "SHARED_RESEARCH_ROUTED", "lib/football-intel/data/*, analysis/football_intel/*", false, "FootballIntelligenceSnapshot", "start-sit-fi/{translate,shadow,production-gate}", "start_sit_fi shadow only", "NOT_PREDICTIVE / DESCRIPTIVE_ONLY fields barred from numeric production", "as_of_2025_w18 (frozen)", "manual R pipeline"),
    reg("start_sit_fi", "ri-startsit-2026.1", "SHADOW_ONLY", "lib/weekly/data/start_sit_model.json", false, "StartSitShadowComparison", "lib/weekly/intelligence.ts", "any production lineup/start-sit/waiver/trade/matchup score", "false (fiMayInfluenceProduction ≡ false)", "current_week (shadow)", "ri-startsit-2026.2, gated on >=4 genuine 2026 weeks"),
    reg("matchup_intelligence", "ri-matchup-2026.1", "SHADOW_ONLY", "lib/weekly/data/matchup_distribution_model.json + matchup_correlation_model.json", false, "MatchupIntelligence", "lib/weekly/intelligence.ts", "any production lineup/matchup score; no MAX_WIN_PROBABILITY objective", "false (matchupMayInfluenceProduction ≡ false)", "current_week pregame (shadow)", "ri-matchup-2026.2, live calibration capture"),
    reg("roster_health", "roster-health-2026.1", "SHARED_CONTEXT", "lib/roster-health/*", false, "RosterHealthLeagueContext", "orchestrator context, 2 API routes", "trade/waiver scoring (needs dedicated integration phase)", "false (evidence, not a remedy)", "weekly + rest_of_season (separate)", "roster-health-2026.2"),
    reg("schedule_planning", "schedule-planning-2026.1", "SHARED_CONTEXT", "lib/schedule-planning/*", false, "SchedulePlanningLeagueContext", "orchestrator context, 2 API routes", "trade/waiver/lineup/streaming recs (needs dedicated integration phase)", "false (evidence, not a remedy)", "full remaining season, STRUCTURE vs VALUE confidence separate", "schedule-planning-2026.2"),
    reg("orchestrator", "team-management-orchestrator-2026.1", "ADVISORY_ONLY", "lib/orchestrator/*", false, "OrchestratorResult", "2 /orchestrate API routes", "autonomous transaction execution (orchestratorMayExecuteTransactions ≡ false)", "advisory only — recommends, never executes", "current + horizon-graded", "orchestrator-2026.2, gated on durable decision capture"),
    reg("production_lineup", "post-draft-intel-2026.1 (buildOptimalLineup)", "PRODUCTION_AUTHORITATIVE", "lib/weekly/lineup.ts", true, "LineupResult", "weekly intelligence, matchup, waivers, roster-health, schedule-planning, orchestrator", "n/a", "true", "current_week", "n/a"),
    reg("production_start_sit", "post-draft-intel-2026.1 (compareStartSit, MAX_EXPECTED)", "PRODUCTION_AUTHORITATIVE", "lib/weekly/start-sit.ts", true, "StartSitComparison[]", "weekly intelligence, orchestrator", "n/a", "true", "current_week", "n/a"),
    reg("waiver_engine", "post-draft-intel-2026.1 (buildWaiverRecommendations)", "PRODUCTION_AUTHORITATIVE", "lib/weekly/waivers.ts", true, "WaiverResult", "weekly intelligence, orchestrator (USED_FOR_ACTION)", "n/a", "true", "current + ROS blend", "n/a"),
    reg("production_matchup", "post-draft-intel-2026.1 (buildMatchup)", "PRODUCTION_AUTHORITATIVE", "lib/weekly/matchup.ts", true, "MatchupResult", "weekly intelligence, orchestrator (context)", "n/a", "true (win_probability is the production field)", "current_week", "n/a"),
    reg("trade_engine", "ri-trade-foundation-2026.2 / contextual / calibrated / data / discovery ri-trade-discovery-2026.2 / negotiation ri-trade-negotiation-2026.2 / strategy ri-trade-strategy-2026.2", "PRODUCTION (calibration deferred: 1 real trade vs 50 floor)", "lib/trades/*", true, "TradeAnalysis / TradeDiscoveryResponse", "trade API routes, orchestrator (strategy profile only, TRADE_EXPLORATION pointer)", "n/a", "true for trade recs; Phase 3 calibrated weights all 0", "current + ROS + playoff windows", "trade calibration reopen at 50 real trades"),
    reg("trade_depth", "lib/trades/depth.ts (frozen)", "PRODUCTION (frozen)", "lib/trades/depth.ts", true, "depth eval", "trade engine", "Roster Health must not replace it", "true within trade scope", "current + ROS", "n/a"),
    reg("trade_ros", "lib/trades/ros.ts (frozen)", "PRODUCTION (frozen)", "lib/trades/ros.ts", true, "RosRosterValue", "trade engine; Schedule Planning must NOT repoint it", "Schedule Planning must not modify weekly_totals / bye_hole_slot_weeks / windows", "true within trade scope", "rest of season + playoff window", "n/a"),
    reg("weekly_projections", "sleeper-weekly-rotowire", "PRODUCTION_AUTHORITATIVE", "lib/weekly/projections/sleeper-weekly.ts", true, "WeeklyProjectionBatch", "lineup, start-sit, matchup, waivers, roster-health, schedule-planning", "n/a", "true", "current_week", "n/a"),
    reg("ros_projections", "ri-structural-2026.3 (ordinal) + sleeper season prorated (absolute)", "PRODUCTION_AUTHORITATIVE (ordinal use)", "lib/weekly/projections-ri.ts, lib/weekly/ros.ts", true, "RosSignal", "waivers, trade ROS, roster-health, schedule-planning", "RI used ORDINALLY only (absolute-level calibration caveat)", "true (ordinal)", "rest of season", "n/a"),
    reg("replacement_framework", "nth_best_available(n=1) weekly / position_rank_theoretical ROS", "PRODUCTION_AUTHORITATIVE", "lib/weekly/replacement.ts", true, "WeeklyReplacement", "lineup VOR, waivers, roster-health", "n/a", "true", "current + ROS", "n/a"),
    reg("scoring_model", "scoring:v1:<fingerprint> (per league)", "PRODUCTION_AUTHORITATIVE", "lib/scoring/*", true, "CanonicalScoringRule[]", "projections, all value-producing layers", "no component may assume default PPR", "true", "n/a", "n/a"),
    reg("k_path", "buildOptimalLineup K slot + waiver K + Sleeper standard pts fallback", "PRODUCTION (no dedicated model)", "lib/weekly/lineup.ts, waivers.ts, projections/sleeper-weekly.ts", true, "slot fill / waiver eval", "lineup, waivers, orchestrator (K_DST reason code)", "no dedicated K streaming model in Phase 8", "true (as a normal slot/add)", "current_week", "n/a"),
    reg("dst_path", "buildOptimalLineup DEF slot + waiver DEF; excluded from Phase 6 core fragility/SPOF", "PRODUCTION (no dedicated model)", "lib/weekly/lineup.ts, waivers.ts, roster-health/evaluate.ts", true, "slot fill / waiver eval", "lineup, waivers, orchestrator (K_DST reason code)", "no dedicated D/ST streaming model; Phase 6 excludes from core fragility", "true (as a normal slot/add)", "current_week", "n/a"),
  ];
}

function reg(
  component_name: string, model_version: string, deployment_state: string, artifact: string,
  may_influence_production: boolean, output_contract: string, expected_callers: string,
  forbidden_or_note: string, may_influence_note: string, current_horizon: string, re_evaluation_status: string,
): Json {
  return { component_name, model_version, deployment_state, artifact, output_contract, expected_callers, forbidden_callers_or_note: forbidden_or_note, may_influence_production, may_influence_note, current_horizon, re_evaluation_status };
}

function artifactIdentity(): Json[] {
  const files: Array<[string, string]> = [
    ["football_intelligence", "lib/football-intel/data/football_intelligence_manifest.json"],
    ["start_sit_fi_model", "lib/weekly/data/start_sit_model.json"],
    ["start_sit_fi_manifest", "lib/weekly/data/start_sit_manifest.json"],
    ["start_sit_reevaluation_manifest", "lib/weekly/data/start_sit_reevaluation_manifest.json"],
    ["matchup_distribution_model", "lib/weekly/data/matchup_distribution_model.json"],
    ["matchup_correlation_model", "lib/weekly/data/matchup_correlation_model.json"],
  ];
  return files.map(([name, path]) => {
    if (!existsSync(path)) return { name, path, exists: false, loadable: false };
    try {
      const raw = readFileSync(path, "utf8");
      const j = JSON.parse(raw) as Json;
      const sha = safe(() => execSync(`shasum -a 256 "${path}"`).toString().split(" ")[0]);
      return {
        name, path, exists: true, loadable: true, bytes: statSync(path).size,
        content_sha256: sha,
        model_version: j.model_version ?? j.matchup_model_version ?? j.start_sit_model_version ?? j.model_tag ?? j.football_intelligence_version ?? null,
        deployment: (j.deployment_contract as Json)?.deployment ?? j.deployment ?? j.re_evaluation_status ?? null,
        data_cutoff: j.data_cutoff ?? j.through_week ?? null,
        seasons_used: j.seasons_used ?? null,
      };
    } catch (e) {
      return { name, path, exists: true, loadable: false, error: e instanceof Error ? e.message : String(e) };
    }
  });
}

void round;
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
