/**
 * Trade Engine — Phase 2A: snapshot-consistent trade-analysis context.
 *
 * A single trade evaluation is built from ONE immutable league snapshot. Phase 1
 * (`analyzeTrade`) performed two provider reads — its own `buildCanonicalLeagueState`
 * plus the one `buildWeeklyTeamContext` did internally — so rosters, projections,
 * transactions or the replacement pool could differ between reads. Phase 2A reads
 * league state exactly once and threads that snapshot into the weekly-context
 * assembly (`snapshotOverride`), so BEFORE and AFTER are always computed from the
 * same state and no second read can occur during evaluation.
 *
 * This module owns the `TradeAnalysisContext` — every deterministic input the
 * Phase 1 and Phase 2 valuation layers need. It performs I/O (one league-state
 * read + the authoritative NFL schedule for the rest-of-season week range); the
 * evaluation layers that consume it are pure and synchronous.
 */

import { resolveLeagueStrict } from "@/lib/leagues/resolve";
import { buildCanonicalLeagueState } from "@/lib/canonical/state";
import { PlayerCrosswalk, NoCrosswalk } from "@/lib/canonical/players";
import { defaultCrosswalkSource } from "@/lib/persistence/supabase/crosswalk-source";
import { buildWeeklyTeamContext, type BuildWeeklyContextOptions } from "@/lib/weekly/context";
import { getScheduleProvider, type ScheduleProvider } from "@/lib/weekly/schedule/registry";
import { WEEKLY_ENGINE_VERSION } from "@/lib/weekly/schema";
import type {
  CanonicalLeagueSnapshot,
  CanonicalPlayer,
  CanonicalRoster,
} from "@/lib/canonical/schema";
import type {
  ByeInfo,
  RosterConstraints,
  WeeklyProjectionBatch,
  WeeklyReplacement,
  WeeklyWarning,
} from "@/lib/weekly/schema";

import { TRADE_ENGINE_VERSION } from "./schema";
import type { TradeDiagnostic } from "./schema";

export const TRADE_CONTEXT_VERSION = "ri-trade-contextual-2026.1" as const;

/** Last fantasy week the ROS layer will ever look at (NFL regular season is 18). */
const MAX_FANTASY_WEEK = 18;
const DEFAULT_CHAMPIONSHIP_WEEK = 17;

export interface RosScheduleContext {
  /** remaining fantasy weeks, inclusive of the current week */
  weeks: number[];
  regular_season_weeks: number[];
  playoff_weeks: number[];
  /** true only when league playoff settings resolved AND fall within the week range */
  playoff_window_available: boolean;
  playoff_start_week: number | null;
  championship_week: number | null;
  /** NFL team abbr -> set of REMAINING fantasy weeks that team is on a schedule-verified bye */
  bye_weeks_by_team: Map<string, Set<number>>;
  /** per remaining week: was an authoritative full-league schedule available? */
  schedule_status: "READY" | "PARTIAL" | "UNAVAILABLE";
  weeks_with_verified_schedule: number[];
}

export interface TradeAnalysisContext {
  league_slug: string;
  season: number;
  /** current fantasy week */
  week: number;
  team_count: number;
  scoring: {
    raw_scoring: Record<string, number>;
    scoring_rules: CanonicalLeagueSnapshot["league"]["scoring_rules"];
  };
  constraints: RosterConstraints;
  /** canonical metadata for every player referenced by any roster or projection */
  players_by_id: Map<string, CanonicalPlayer>;
  /** CURRENT-week projections (carry `.ros` for the rest-of-season signal) */
  projections: WeeklyProjectionBatch;
  /** CURRENT-week league replacement frontier */
  replacement: WeeklyReplacement;
  /** CURRENT-week schedule-verified byes */
  byes: ByeInfo;
  /** rest-of-season week range + per-week bye map */
  ros: RosScheduleContext;
  /** every participating manager's pre-trade roster, keyed by canonical_manager_id */
  rosters_by_manager: Map<string, CanonicalRoster>;
  /** the single immutable snapshot everything is derived from */
  snapshot: CanonicalLeagueSnapshot;
  versions: {
    trade_foundation_version: string;
    trade_context_version: string;
    weekly_engine_version: string;
    projections_model_version: string;
    ros_model_version: string | null;
  };
  warnings: WeeklyWarning[];
  diagnostics: TradeDiagnostic[];
}

export interface BuildTradeContextOptions extends BuildWeeklyContextOptions {
  scheduleProviderOverride?: ScheduleProvider;
  /** cap the ROS horizon (tests); defaults to the league championship week */
  rosHorizonWeek?: number;
}

export interface BuildTradeContextResult {
  ok: boolean;
  status: number;
  code?: string;
  detail?: string;
  context: TradeAnalysisContext | null;
}

export async function buildTradeAnalysisContext(
  leagueSlug: string,
  options: BuildTradeContextOptions = {},
): Promise<BuildTradeContextResult> {
  const resolution = resolveLeagueStrict(leagueSlug);
  if (!resolution.ok) {
    return { ok: false, status: resolution.status, code: resolution.code, detail: resolution.detail, context: null };
  }

  const crosswalk =
    options.crosswalkOverride ??
    (defaultCrosswalkSource() ? new PlayerCrosswalk(defaultCrosswalkSource()!) : new PlayerCrosswalk(NoCrosswalk));

  // ---- THE single league-state read ------------------------------------------
  const state = await buildCanonicalLeagueState(leagueSlug, {
    includeMatchups: true,
    includeRecentTransactions: true,
    reportPersistence: true,
    providerOverride: options.providerOverride,
    crosswalkOverride: crosswalk,
  });
  if (!state.snapshot) {
    return {
      ok: false,
      status: state.status,
      code: state.code ?? "league_state_unavailable",
      detail: state.detail,
      context: null,
    };
  }
  const snapshot = state.snapshot;

  if (snapshot.managers.length === 0) {
    return { ok: false, status: 502, code: "no_managers", detail: `League "${leagueSlug}" returned no managers.`, context: null };
  }

  // ---- weekly context assembled FROM THAT SAME SNAPSHOT (no 2nd read) --------
  const primarySlug = snapshot.managers[0]!.manager_slug;
  const weekly = await buildWeeklyTeamContext(leagueSlug, primarySlug, {
    week: options.week,
    projectionProviderOverride: options.projectionProviderOverride,
    scheduleProviderOverride: options.scheduleProviderOverride,
    riSeasonProviderOverride: options.riSeasonProviderOverride,
    skipRiSeasonSignal: options.skipRiSeasonSignal,
    replacementFrontier: options.replacementFrontier,
    wantRestOfSeason: options.wantRestOfSeason ?? true,
    snapshotOverride: snapshot,
  });
  if (!weekly.context) {
    return {
      ok: weekly.ok,
      status: weekly.status,
      code: weekly.code,
      detail: weekly.detail,
      context: null,
    };
  }
  const wctx = weekly.context;
  const diagnostics: TradeDiagnostic[] = [];
  const warnings: WeeklyWarning[] = [...wctx.warnings];

  // ---- rest-of-season week range + per-week bye map -------------------------
  const week = wctx.league.week;
  const season = wctx.league.season;
  const ps = snapshot.league.playoff_settings;
  const championshipWeek = clampWeek(
    options.rosHorizonWeek ?? ps.championship_week ?? DEFAULT_CHAMPIONSHIP_WEEK,
    week,
  );
  const playoffStartWeek =
    ps.playoff_start_week != null && ps.playoff_start_week > week && ps.playoff_start_week <= championshipWeek
      ? ps.playoff_start_week
      : null;

  const weeks: number[] = [];
  for (let w = week; w <= championshipWeek; w += 1) weeks.push(w);
  const regular_season_weeks = playoffStartWeek == null ? [...weeks] : weeks.filter((w) => w < playoffStartWeek);
  const playoff_weeks = playoffStartWeek == null ? [] : weeks.filter((w) => w >= playoffStartWeek);
  const playoff_window_available = playoff_weeks.length > 0;
  if (!playoff_window_available) {
    diagnostics.push({
      code: "PLAYOFF_WINDOW_UNAVAILABLE",
      message:
        ps.playoff_start_week == null
          ? "League playoff settings did not resolve a playoff start week — playoff-window value is not reported separately."
          : `Playoff start week ${ps.playoff_start_week} is not inside the remaining week range (${week}..${championshipWeek}).`,
      severity: "info",
    });
  }

  const scheduleProvider = options.scheduleProviderOverride ?? getScheduleProvider();
  const bye_weeks_by_team = new Map<string, Set<number>>();
  const weeksWithSchedule: number[] = [];
  for (const w of weeks) {
    let sched;
    try {
      sched = await scheduleProvider.getWeekSchedule(season, w);
    } catch {
      sched = null;
    }
    if (sched && sched.status === "READY") {
      weeksWithSchedule.push(w);
      for (const team of sched.teams_on_bye) {
        const set = bye_weeks_by_team.get(team) ?? new Set<number>();
        set.add(w);
        bye_weeks_by_team.set(team, set);
      }
    }
  }
  const schedule_status: RosScheduleContext["schedule_status"] =
    weeksWithSchedule.length === weeks.length ? "READY" : weeksWithSchedule.length === 0 ? "UNAVAILABLE" : "PARTIAL";
  if (schedule_status !== "READY") {
    diagnostics.push({
      code: "BYE_DATA_UNAVAILABLE",
      message:
        schedule_status === "UNAVAILABLE"
          ? "No authoritative NFL schedule for any remaining week — ROS bye effects are NOT modeled (players assumed to play; never fabricated as a 0)."
          : `Authoritative NFL schedule verified for ${weeksWithSchedule.length}/${weeks.length} remaining weeks — byes only modeled for verified weeks.`,
      severity: schedule_status === "UNAVAILABLE" ? "warning" : "info",
    });
  }

  const players_by_id = new Map<string, CanonicalPlayer>(
    snapshot.players.map((p) => [p.canonical_player_id, p]),
  );
  for (const [id, p] of wctx.projections.resolved_players) if (!players_by_id.has(id)) players_by_id.set(id, p);

  const rosters_by_manager = new Map<string, CanonicalRoster>();
  for (const team of snapshot.teams) {
    const roster = snapshot.rosters.find((r) => r.canonical_team_id === team.canonical_team_id);
    if (!roster) continue;
    for (const mid of team.canonical_manager_ids) rosters_by_manager.set(mid, roster);
  }

  const context: TradeAnalysisContext = {
    league_slug: wctx.league.slug,
    season,
    week,
    team_count: snapshot.league.team_count,
    scoring: { raw_scoring: wctx.league.raw_scoring, scoring_rules: wctx.league.scoring_rules },
    constraints: wctx.league.roster_constraints,
    players_by_id,
    projections: wctx.projections,
    replacement: wctx.replacement,
    byes: wctx.byes,
    ros: {
      weeks,
      regular_season_weeks,
      playoff_weeks,
      playoff_window_available,
      playoff_start_week: playoffStartWeek,
      championship_week: championshipWeek,
      bye_weeks_by_team,
      schedule_status,
      weeks_with_verified_schedule: weeksWithSchedule,
    },
    rosters_by_manager,
    snapshot,
    versions: {
      trade_foundation_version: TRADE_ENGINE_VERSION,
      trade_context_version: TRADE_CONTEXT_VERSION,
      weekly_engine_version: WEEKLY_ENGINE_VERSION,
      projections_model_version: wctx.projections.model_version,
      ros_model_version: wctx.ros_signal?.ri_model_version ?? null,
    },
    warnings,
    diagnostics,
  };

  return { ok: true, status: 200, context };
}

function clampWeek(w: number, floor: number): number {
  return Math.max(floor, Math.min(MAX_FANTASY_WEEK, Math.round(w)));
}
