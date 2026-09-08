/**
 * Phase 8 — orchestrate one manager (and the league).
 *
 * `orchestrateManager(mac, slug)` runs: derive conditions → aggregate →
 * generate candidates (production specialists only) → policy (gates →
 * lexicographic priority → dominance) → assemble the immutable, lineage-stamped
 * `OrchestratorResult`. It executes NOTHING and mutates NO specialist.
 */

import {
  buildManagementAnalysisContext,
  managerSlugsOf,
  type ManagementAnalysisContext,
  type ManagementAnalysisOptions,
} from "./context";
import { aggregateConditions, deriveConditions } from "./conditions";
import { lineupCandidates, tradeExplorationCandidates, waiverCandidates } from "./candidates";
import { runPolicy } from "./policy";
import { captureOrchestratorResult } from "./capture";
import {
  ORCHESTRATOR_DEPLOYMENT,
  ORCHESTRATOR_VERSION,
  type OrchestratorAction,
  type OrchestratorLeagueResult,
  type OrchestratorLeagueRow,
  type OrchestratorLineage,
  type OrchestratorResult,
  type SpecialistUsage,
} from "./schema";

function buildLineage(mac: ManagementAnalysisContext, used: Set<string>, shadowSeen: Set<string>): OrchestratorLineage {
  const usage = (key: string, available: boolean): { version: string | null; usage: SpecialistUsage } => {
    const version = (mac.versions as Record<string, string | null>)[key] ?? null;
    if (!available) return { version, usage: "UNAVAILABLE" };
    if (key === "start_sit_shadow" || key === "matchup_shadow") {
      return { version, usage: shadowSeen.has(key) ? "SHADOW_CONTEXT_ONLY" : "NOT_USED" };
    }
    return { version, usage: used.has(key) ? "USED_FOR_ACTION" : "USED_AS_CONTEXT" };
  };

  const sp = mac.schedulePlanning;
  const weeklyProjLineage = mac.tradeCtx?.lineage.projections ?? [];
  const weeklyEntry = weeklyProjLineage.find((p) => p.role === "weekly_absolute") ?? null;
  const rosEntry = weeklyProjLineage.find((p) => p.role === "season_ordinal") ?? null;

  return {
    orchestrator_version: ORCHESTRATOR_VERSION,
    deployment: ORCHESTRATOR_DEPLOYMENT,
    league_snapshot_id: mac.league_snapshot_id,
    scoring_fingerprint: mac.scoring_fingerprint,
    season: mac.season,
    week: mac.week,
    generated_at: new Date().toISOString(),
    specialists: {
      canonical: { version: `schema_v${mac.snapshot.lineage?.snapshot_schema_version ?? "?"}`, usage: "USED_AS_CONTEXT" },
      team_state: usage("team_state", mac.availability.team_state),
      football_intelligence: usage("football_intelligence", Boolean(mac.versions.football_intelligence)),
      start_sit_shadow: usage("start_sit_shadow", Boolean(mac.versions.start_sit_shadow)),
      matchup_shadow: usage("matchup_shadow", Boolean(mac.versions.matchup_shadow)),
      roster_health: usage("roster_health", mac.availability.roster_health),
      schedule_planning: usage("schedule_planning", mac.availability.schedule_planning),
      strategy: usage("strategy", mac.availability.strategy),
      weekly_engine: usage("weekly_engine", true),
    },
    projection_lineage: {
      weekly: weeklyEntry ? { source: weeklyEntry.source, model_version: weeklyEntry.model_version } : { source: "sleeper_weekly", model_version: "sleeper-weekly-rotowire" },
      ros: rosEntry ? { source: rosEntry.source, ri_model_version: rosEntry.model_version } : { source: "sleeper_season_rotowire_prorated", ri_model_version: mac.rosterHealth?.lineage.projection_lineage?.ros?.ri_model_version ?? null },
    },
    planning_horizon: {
      current_week: mac.week,
      last_regular_week: sp?.lineage.planning_horizon.last_regular_week ?? null,
      playoff_weeks: sp?.lineage.planning_horizon.playoff_weeks ?? [],
    },
  };
}

export async function orchestrateManager(mac: ManagementAnalysisContext, managerSlug: string): Promise<OrchestratorResult | null> {
  const slice = await mac.forManager(managerSlug);
  if (!slice) return null;

  // vacant team → nothing to manage
  if (slice.is_vacant) {
    const lineage = buildLineage(mac, new Set(), new Set());
    return {
      orchestrator_version: ORCHESTRATOR_VERSION,
      lineage,
      league_slug: mac.league.league_slug,
      manager_slug: slice.manager_slug,
      manager_display_name: slice.manager_display_name,
      team_name: slice.team_name,
      roster_id: slice.roster_id,
      canonical_team_id: slice.canonical_team_id,
      is_vacant: true,
      verdict: "HOLD",
      primary_action: null,
      secondary_actions: [],
      current_conditions: [],
      future_watch_items: [],
      suppressed_actions: [],
      confidence: "HIGH",
      hold_rationale: ["VACANT_TEAM — no manager to advise."],
      degradation: { missing_specialists: [], reasons: ["vacant_team"], evidence_insufficient: false },
    };
  }

  const rawConditions = deriveConditions(mac, slice);
  const conditions = aggregateConditions(rawConditions);

  const candidates: OrchestratorAction[] = [
    ...lineupCandidates(mac, slice, conditions),
    ...waiverCandidates(mac, slice, conditions),
    ...(await tradeExplorationCandidates(mac, slice, conditions)),
  ];

  const outcome = runPolicy(mac, slice, conditions, candidates);

  const usedSpecialists = new Set<string>();
  for (const a of [outcome.primary_action, ...outcome.secondary_actions].filter(Boolean) as OrchestratorAction[]) {
    if (a.action_class === "LINEUP") usedSpecialists.add("weekly_engine");
    if (a.action_class === "WAIVER") usedSpecialists.add("weekly_engine");
    if (a.action_class === "TRADE_EXPLORATION") usedSpecialists.add("strategy");
    for (const e of a.explanation_chain) {
      if (e.specialist === "roster_health") usedSpecialists.add("roster_health");
      if (e.specialist === "schedule_planning") usedSpecialists.add("schedule_planning");
      if (e.specialist === "team_state") usedSpecialists.add("team_state");
    }
  }
  const shadowSeen = new Set<string>();
  for (const c of outcome.conditions) {
    if (c.sources.includes("start_sit_shadow")) shadowSeen.add("start_sit_shadow");
    if (c.sources.includes("matchup_shadow")) shadowSeen.add("matchup_shadow");
  }

  const missing: string[] = [];
  if (!mac.availability.team_state) missing.push("team_state");
  if (!mac.availability.roster_health) missing.push("roster_health");
  if (!mac.availability.schedule_planning) missing.push("schedule_planning");
  if (!mac.availability.strategy) missing.push("strategy");
  if (!slice.weekly) missing.push("weekly_intelligence");

  const result: OrchestratorResult = {
    orchestrator_version: ORCHESTRATOR_VERSION,
    lineage: buildLineage(mac, usedSpecialists, shadowSeen),
    league_slug: mac.league.league_slug,
    manager_slug: slice.manager_slug,
    manager_display_name: slice.manager_display_name,
    team_name: slice.team_name,
    roster_id: slice.roster_id,
    canonical_team_id: slice.canonical_team_id,
    is_vacant: false,
    verdict: outcome.verdict,
    primary_action: outcome.primary_action,
    secondary_actions: outcome.secondary_actions,
    // every specialist-detected fact considered this run (§28)
    current_conditions: outcome.conditions,
    // real but premature — future-horizon watch items + shadow diagnostics (§3)
    future_watch_items: outcome.watch_items.filter(
      (c) => c.horizon !== "CURRENT_WEEK" || c.disposition === "SHADOW_DIAGNOSTIC_ONLY",
    ),
    suppressed_actions: outcome.suppressed_actions,
    confidence: outcome.confidence,
    hold_rationale: outcome.hold_rationale,
    degradation: {
      missing_specialists: missing,
      reasons: mac.warnings.filter((w) => w.includes(managerSlug) || w.includes("unavailable") || w.includes("divergence")),
      evidence_insufficient: outcome.verdict === "INSUFFICIENT_EVIDENCE",
    },
  };

  await captureOrchestratorResult(result);
  return result;
}

export async function buildManagerOrchestration(
  leagueSlug: string,
  managerSlug: string,
  options: ManagementAnalysisOptions & { includeTrace?: boolean } = {},
): Promise<
  | { ok: true; result: OrchestratorResult; trace?: import("./trace").OrchestratorTrace }
  | { ok: false; status: number; code: string; detail: string }
> {
  const ctxRes = await buildManagementAnalysisContext(leagueSlug, options);
  if (!ctxRes.ok) return ctxRes;
  const result = await orchestrateManager(ctxRes.context, managerSlug);
  if (!result) return { ok: false, status: 404, code: "manager_not_in_league", detail: `Manager "${managerSlug}" has no state in "${leagueSlug}".` };
  if (options.includeTrace) {
    const { buildOrchestratorTrace } = await import("./trace");
    return { ok: true, result, trace: buildOrchestratorTrace(ctxRes.context, result) };
  }
  return { ok: true, result };
}

export async function buildLeagueOrchestration(
  leagueSlug: string,
  options: ManagementAnalysisOptions = {},
): Promise<{ ok: true; result: OrchestratorLeagueResult } | { ok: false; status: number; code: string; detail: string }> {
  // league endpoint: cheap path only — trade discovery is never run league-wide (§34, §41)
  const ctxRes = await buildManagementAnalysisContext(leagueSlug, { ...options, includeTradeSearch: false });
  if (!ctxRes.ok) return ctxRes;
  const mac = ctxRes.context;

  const slugs = managerSlugsOf(mac);
  const rows: OrchestratorLeagueRow[] = [];
  for (const slug of slugs) {
    const r = await orchestrateManager(mac, slug);
    if (!r) continue;
    rows.push({
      manager_slug: r.manager_slug,
      manager_display_name: r.manager_display_name,
      team_name: r.team_name,
      roster_id: r.roster_id,
      is_vacant: r.is_vacant,
      verdict: r.verdict,
      primary_action: r.primary_action
        ? {
            action_class: r.primary_action.action_class,
            target_problem: r.primary_action.target_problem,
            priority: r.primary_action.priority,
            urgency: r.primary_action.dimensions.urgency,
          }
        : null,
      watch_count: r.future_watch_items.length,
      top_condition_codes: r.current_conditions.slice(0, 3).map((c) => c.code),
      confidence: r.confidence,
      degraded: r.degradation.missing_specialists.length > 0 || r.verdict === "INSUFFICIENT_EVIDENCE",
    });
  }
  rows.sort((a, b) => a.roster_id - b.roster_id);

  const lineage = buildLineage(mac, new Set(), new Set());
  return {
    ok: true,
    result: {
      orchestrator_version: ORCHESTRATOR_VERSION,
      lineage,
      league_slug: mac.league.league_slug,
      season: mac.season,
      week: mac.week,
      rows,
      warnings: mac.warnings,
    },
  };
}
