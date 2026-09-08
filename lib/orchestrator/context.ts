/**
 * Phase 8 §6–§8 — the request-scoped `ManagementAnalysisContext`.
 *
 * Assembled ONCE per logical Orchestrator operation, inside a single
 * `runInLeagueStateScope`, so:
 *   - ONE canonical provider read is shared by every specialist (the scope memo
 *     is keyed on read-shape flags; we prime it with the superset shape up front
 *     and pass `snapshotOverride` wherever a builder accepts it);
 *   - ONE Team-State league context, ONE Roster Health league context, ONE
 *     Schedule Planning league context, ONE trade-analysis context (for strategy
 *     profiles) — each built for ALL managers;
 *   - per-manager Weekly Intelligence (lineup / start-sit / matchup / waivers +
 *     the Phase 4/5 shadows) built on demand and memoised on the context.
 *
 * This layer ADAPTS the frozen specialists; it does not redefine any of them.
 * It never normalises a provider roster, never defines identity, never touches
 * scoring / slot eligibility / projection values / replacement levels / trade
 * or waiver calculations / Phase 6 or Phase 7 semantics.
 *
 * Bounded residual (documented, P8-2): `buildRosterHealthContext` and
 * `buildSchedulePlanningContext` each internally re-assemble the weekly
 * projection batch + RI signal from the (memoised) snapshot — 2 extra IN-MEMORY
 * projection assemblies, ZERO extra provider reads. Eliminating them would
 * require changing frozen Phase 6/7 builders, which §9 forbids. Measured in the
 * certification (§41).
 */

import { runInLeagueStateScope } from "@/lib/canonical/request-scope";
import { buildCanonicalLeagueState } from "@/lib/canonical/state";
import { resolveLeagueStrict, type ResolvedLeague } from "@/lib/leagues/resolve";
import { resolveManager } from "@/lib/canonical/manager-context";
import { buildLeagueManagementContext } from "@/lib/team-state/build";
import { buildRosterHealthContext } from "@/lib/roster-health";
import { buildSchedulePlanningContext } from "@/lib/schedule-planning";
import { buildTradeAnalysisContext } from "@/lib/trades/context";
import { buildManagerStrategicProfile } from "@/lib/trades/strategy/profile";
import { TRADE_STRATEGY_VERSION } from "@/lib/trades/strategy/config";
import { buildWeeklyIntelligence } from "@/lib/weekly/intelligence";
import { TEAM_STATE_VERSION } from "@/lib/team-state/schema";
import { ROSTER_HEALTH_VERSION } from "@/lib/roster-health/schema";
import { PLANNING_MODEL_VERSION } from "@/lib/schedule-planning/schema";
import { WEEKLY_ENGINE_VERSION } from "@/lib/weekly/schema";

import type { CanonicalLeagueSnapshot } from "@/lib/canonical/schema";
import type { LeagueManagementContext, TeamManagementState } from "@/lib/team-state/schema";
import type { RosterHealthLeagueContext, TeamRosterHealth } from "@/lib/roster-health/schema";
import type { SchedulePlanningLeagueContext, TeamSchedulePlan } from "@/lib/schedule-planning/schema";
import type { ManagerStrategicProfile } from "@/lib/trades/strategy/types";
import type { TradeAnalysisContext } from "@/lib/trades/context";
import type { WeeklyIntelligence } from "@/lib/weekly/intelligence";

export interface ManagementAnalysisOptions {
  /** run concrete trade discovery for a material need (expensive — opt-in, §14). */
  includeTradeSearch?: boolean;
}

export interface SpecialistAvailability {
  team_state: boolean;
  roster_health: boolean;
  schedule_planning: boolean;
  strategy: boolean;
  /** per-manager weekly intelligence availability, filled as managers are analysed. */
  weekly: Map<string, boolean>;
}

export interface AssemblyMetrics {
  canonical_provider_reads: number;
  team_state_builds: number;
  roster_health_builds: number;
  schedule_planning_builds: number;
  trade_context_builds: number;
  weekly_intelligence_builds: number;
  ms: Record<string, number>;
  snapshot_ids_seen: string[];
  snapshot_coherent: boolean;
}

/**
 * The shared analysis graph. Every field is an existing certified contract —
 * there is no parallel representation of any fact.
 */
export interface ManagementAnalysisContext {
  league: ResolvedLeague;
  season: number;
  week: number;
  snapshot: CanonicalLeagueSnapshot;
  league_snapshot_id: string;
  scoring_fingerprint: string | null;

  teamState: LeagueManagementContext | null;
  rosterHealth: RosterHealthLeagueContext | null;
  schedulePlanning: SchedulePlanningLeagueContext | null;
  tradeCtx: TradeAnalysisContext | null;

  /** per-manager memoised weekly intelligence. */
  readonly weeklyByManager: Map<string, WeeklyIntelligence | null>;
  /** per-manager memoised strategic profile. */
  readonly strategyByManager: Map<string, ManagerStrategicProfile | null>;

  availability: SpecialistAvailability;
  metrics: AssemblyMetrics;
  warnings: string[];

  options: ManagementAnalysisOptions;

  /** versions for lineage. */
  versions: {
    orchestrator: string;
    team_state: string | null;
    roster_health: string | null;
    schedule_planning: string | null;
    strategy: string | null;
    weekly_engine: string | null;
    football_intelligence: string | null;
    start_sit_shadow: string | null;
    matchup_shadow: string | null;
  };

  /** resolve one manager's specialist slices (weekly is lazy). */
  forManager(managerSlug: string): Promise<ManagerAnalysisSlice | null>;
}

export interface ManagerAnalysisSlice {
  manager_slug: string;
  manager_display_name: string | null;
  team_name: string | null;
  roster_id: number;
  canonical_team_id: string;
  canonical_manager_id: string;
  is_vacant: boolean;

  teamState: TeamManagementState | null;
  rosterHealth: TeamRosterHealth | null;
  schedulePlanning: TeamSchedulePlan | null;
  strategy: ManagerStrategicProfile | null;
  weekly: WeeklyIntelligence | null;
}

const now = () => Date.now();

export async function buildManagementAnalysisContext(
  leagueSlug: string,
  options: ManagementAnalysisOptions = {},
): Promise<{ ok: true; context: ManagementAnalysisContext } | { ok: false; status: number; code: string; detail: string }> {
  const resolution = resolveLeagueStrict(leagueSlug);
  if (!resolution.ok) {
    return { ok: false, status: resolution.status ?? 404, code: resolution.code ?? "league_unresolved", detail: `League "${leagueSlug}" could not be resolved.` };
  }
  const league = resolution.league;

  return runInLeagueStateScope(async () => {
    const metrics: AssemblyMetrics = {
      canonical_provider_reads: 0,
      team_state_builds: 0,
      roster_health_builds: 0,
      schedule_planning_builds: 0,
      trade_context_builds: 0,
      weekly_intelligence_builds: 0,
      ms: {},
      snapshot_ids_seen: [],
      snapshot_coherent: true,
    };
    const warnings: string[] = [];

    // ---- 1. ONE canonical read, superset shape — primes the scope memo -------
    let t = now();
    const stateRes = await buildCanonicalLeagueState(leagueSlug, {
      includeMatchups: true,
      includeRecentTransactions: true,
      reportPersistence: true,
    });
    metrics.ms.canonical = now() - t;
    metrics.canonical_provider_reads = 1;
    if (!stateRes.ok || !stateRes.snapshot) {
      return { ok: false as const, status: stateRes.status ?? 502, code: stateRes.code ?? "canonical_state_unavailable", detail: stateRes.detail ?? "Canonical league state is unavailable." };
    }
    const snapshot = stateRes.snapshot;
    const league_snapshot_id = snapshot.lineage?.league_snapshot_id ?? `snap:${leagueSlug}:${snapshot.league.season}:w${snapshot.week}:unknown`;
    const scoring_fingerprint = snapshot.league.scoring_fingerprint ?? null;
    metrics.snapshot_ids_seen.push(league_snapshot_id);
    const season = snapshot.league.season;
    const week = snapshot.league.current_week ?? snapshot.week ?? 1;

    const noteSnapshot = (id: string | null | undefined, label: string) => {
      if (!id) return;
      if (!metrics.snapshot_ids_seen.includes(id)) metrics.snapshot_ids_seen.push(id);
      if (id !== league_snapshot_id) {
        metrics.snapshot_coherent = false;
        warnings.push(`snapshot divergence: ${label} used ${id}, orchestrator base is ${league_snapshot_id}`);
      }
    };

    const availability: SpecialistAvailability = {
      team_state: false,
      roster_health: false,
      schedule_planning: false,
      strategy: false,
      weekly: new Map(),
    };

    // ---- 2. Team-State (all managers), sharing the primed snapshot ----------
    let teamState: LeagueManagementContext | null = null;
    t = now();
    try {
      const res = await buildLeagueManagementContext(leagueSlug, { snapshotOverride: snapshot });
      metrics.team_state_builds += 1;
      if (res.ok && res.context) {
        teamState = res.context;
        availability.team_state = true;
        noteSnapshot(res.context.league.league_snapshot_id, "team_state");
      } else {
        warnings.push(`team_state unavailable: ${res.code ?? "unknown"}`);
      }
    } catch (e) {
      warnings.push(`team_state threw: ${e instanceof Error ? e.message : String(e)}`);
    }
    metrics.ms.team_state = now() - t;

    // ---- 3. Roster Health (all managers) ----------------------------------
    let rosterHealth: RosterHealthLeagueContext | null = null;
    t = now();
    try {
      rosterHealth = await buildRosterHealthContext(leagueSlug);
      metrics.roster_health_builds += 1;
      availability.roster_health = true;
      noteSnapshot(rosterHealth.lineage.league_snapshot_id, "roster_health");
      warnings.push(...rosterHealth.warnings.map((w) => `roster_health: ${w}`));
    } catch (e) {
      warnings.push(`roster_health unavailable: ${e instanceof Error ? e.message : String(e)}`);
    }
    metrics.ms.roster_health = now() - t;

    // ---- 4. Schedule Planning (all managers) -----------------------------
    let schedulePlanning: SchedulePlanningLeagueContext | null = null;
    t = now();
    try {
      schedulePlanning = await buildSchedulePlanningContext(leagueSlug);
      metrics.schedule_planning_builds += 1;
      availability.schedule_planning = true;
      noteSnapshot(schedulePlanning.lineage.league_snapshot_id, "schedule_planning");
      warnings.push(...schedulePlanning.warnings.map((w) => `schedule_planning: ${w}`));
    } catch (e) {
      warnings.push(`schedule_planning unavailable: ${e instanceof Error ? e.message : String(e)}`);
    }
    metrics.ms.schedule_planning = now() - t;

    // ---- 5. Trade-analysis context (for strategy profiles) --------------
    let tradeCtx: TradeAnalysisContext | null = null;
    t = now();
    try {
      const res = await buildTradeAnalysisContext(leagueSlug);
      metrics.trade_context_builds += 1;
      if (res.context) {
        tradeCtx = res.context;
        availability.strategy = true;
        noteSnapshot(res.context.lineage.snapshot.league_snapshot_id, "trade_context");
      } else {
        warnings.push(`strategy/trade context unavailable: ${res.code ?? "unknown"}`);
      }
    } catch (e) {
      warnings.push(`strategy/trade context threw: ${e instanceof Error ? e.message : String(e)}`);
    }
    metrics.ms.trade_context = now() - t;

    const weeklyByManager = new Map<string, WeeklyIntelligence | null>();
    const strategyByManager = new Map<string, ManagerStrategicProfile | null>();

    const fiVersion =
      schedulePlanning?.lineage.football_intelligence_version ??
      (rosterHealth ? "see_roster_health_lineage" : null);

    const context: ManagementAnalysisContext = {
      league,
      season,
      week,
      snapshot,
      league_snapshot_id,
      scoring_fingerprint,
      teamState,
      rosterHealth,
      schedulePlanning,
      tradeCtx,
      weeklyByManager,
      strategyByManager,
      availability,
      metrics,
      warnings,
      options,
      versions: {
        orchestrator: "team-management-orchestrator-2026.1",
        team_state: availability.team_state ? TEAM_STATE_VERSION : null,
        roster_health: rosterHealth?.roster_health_version ?? (availability.roster_health ? ROSTER_HEALTH_VERSION : null),
        schedule_planning: schedulePlanning?.planning_model_version ?? (availability.schedule_planning ? PLANNING_MODEL_VERSION : null),
        strategy: availability.strategy ? TRADE_STRATEGY_VERSION : null,
        weekly_engine: WEEKLY_ENGINE_VERSION,
        football_intelligence: fiVersion,
        start_sit_shadow: null,
        matchup_shadow: null,
      },

      async forManager(managerSlug: string): Promise<ManagerAnalysisSlice | null> {
        const cm = resolveManager(snapshot.managers, managerSlug);
        if (!cm) return null;

        const tsTeam =
          teamState?.teams.find(
            (x) =>
              x.identity.manager_slug.toLowerCase() === managerSlug.toLowerCase() ||
              x.identity.canonical_manager_id === cm.canonical_manager_id,
          ) ?? null;
        const rhTeam =
          rosterHealth?.teams.find((x) => x.manager_slug.toLowerCase() === managerSlug.toLowerCase()) ?? null;
        const spTeam =
          schedulePlanning?.teams.find((x) => x.manager_slug.toLowerCase() === managerSlug.toLowerCase()) ?? null;

        // strategy profile (memoised)
        let strategy = strategyByManager.get(managerSlug) ?? null;
        if (!strategyByManager.has(managerSlug)) {
          if (tradeCtx) {
            try {
              strategy = buildManagerStrategicProfile(tradeCtx, cm.canonical_manager_id, cm.manager_slug);
            } catch (e) {
              warnings.push(`strategy[${managerSlug}] threw: ${e instanceof Error ? e.message : String(e)}`);
              strategy = null;
            }
          }
          strategyByManager.set(managerSlug, strategy);
        }

        // weekly intelligence (memoised, lazy)
        let weekly = weeklyByManager.get(managerSlug) ?? null;
        if (!weeklyByManager.has(managerSlug)) {
          const tw = now();
          try {
            const res = await buildWeeklyIntelligence(leagueSlug, managerSlug, { snapshotOverride: snapshot });
            metrics.weekly_intelligence_builds += 1;
            weekly = res.ok ? res.intelligence : null;
            availability.weekly.set(managerSlug, Boolean(weekly));
            if (weekly) noteSnapshot(weekly.lineage.snapshot?.league_snapshot_id, `weekly[${managerSlug}]`);
            else warnings.push(`weekly[${managerSlug}] unavailable: ${res.code ?? "unknown"}`);
          } catch (e) {
            warnings.push(`weekly[${managerSlug}] threw: ${e instanceof Error ? e.message : String(e)}`);
            availability.weekly.set(managerSlug, false);
            weekly = null;
          }
          metrics.ms[`weekly[${managerSlug}]`] = now() - tw;
          weeklyByManager.set(managerSlug, weekly);
        }

        // capture shadow versions for lineage the first time we see them
        if (weekly?.start_sit_shadow && !context.versions.start_sit_shadow) {
          context.versions.start_sit_shadow =
            (weekly.start_sit_shadow.lineage as { start_sit_model_version?: string })?.start_sit_model_version ?? null;
        }
        if (weekly?.matchup_intelligence && !context.versions.matchup_shadow) {
          context.versions.matchup_shadow =
            (weekly.matchup_intelligence.lineage as { matchup_model_version?: string })?.matchup_model_version ?? null;
        }
        if (weekly?.matchup_intelligence && !context.versions.football_intelligence) {
          context.versions.football_intelligence =
            (weekly.matchup_intelligence.lineage as { football_intelligence_version?: string })?.football_intelligence_version ?? null;
        }

        return {
          manager_slug: cm.manager_slug,
          manager_display_name: cm.display_name ?? tsTeam?.identity.manager_display_name ?? null,
          team_name: tsTeam?.identity.team_name ?? rhTeam?.team_name ?? spTeam?.team_name ?? null,
          roster_id: tsTeam?.identity.roster_id ?? rhTeam?.roster_id ?? spTeam?.roster_id ?? -1,
          canonical_team_id: tsTeam?.identity.canonical_team_id ?? rhTeam?.team_id ?? spTeam?.team_id ?? "",
          canonical_manager_id: cm.canonical_manager_id,
          is_vacant: tsTeam?.identity.is_vacant ?? spTeam?.is_vacant ?? false,
          teamState: tsTeam,
          rosterHealth: rhTeam,
          schedulePlanning: spTeam,
          strategy,
          weekly,
        };
      },
    };

    return { ok: true as const, context };
  });
}

/** Manager slugs present in this league (for the league endpoint). */
export function managerSlugsOf(ctx: ManagementAnalysisContext): string[] {
  if (ctx.teamState) return ctx.teamState.teams.map((t) => t.identity.manager_slug);
  return ctx.snapshot.managers.map((m) => m.manager_slug);
}
