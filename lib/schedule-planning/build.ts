/**
 * Phase 7 — Schedule & Forward Planning orchestrator.
 *
 * `buildSchedulePlanningContext(leagueSlug)` — ONE canonical league-state read,
 * ONE weekly projection batch, ONE RI signal, ONE `buildLeagueManagementContext`,
 * ONE full-season schedule fetch (all memoized in a single
 * `runInLeagueStateScope`). Every team's full remaining-season planning timeline
 * is computed in memory. 0 extra provider reads per manager / per week.
 *
 * SHARED_CONTEXT: never mutates a projection, never calls a recommendation
 * engine, never returns a lineup, never adjusts a score.
 */

import { runInLeagueStateScope } from "@/lib/canonical/request-scope";
import { buildLeagueManagementContext } from "@/lib/team-state/build";
import {
  buildRosterHealthInputs,
  evaluateHorizon,
  type RosterHealthInputOptions,
} from "@/lib/roster-health";
import { TEAM_STATE_VERSION } from "@/lib/team-state/schema";
import { ROSTER_HEALTH_VERSION } from "@/lib/roster-health/schema";
import { loadFullSchedule, type FullSchedule } from "./schedule";
import { buildWeekTimeline } from "./evaluate";
import {
  PLANNING_MODEL_VERSION,
  type SchedulePlanningLeagueContext,
  type TeamSchedulePlan,
  type PlanningLineage,
  type PlanningSummary,
  type PlanningDegradation,
  type PlanningDegradationReason,
  type WeekPlan,
} from "./schema";

/** NFL regular season length (weeks) — the planning ceiling when playoff config is absent. */
const NFL_LAST_REGULAR_WEEK = 18;

export type SchedulePlanningOptions = RosterHealthInputOptions;

export async function buildSchedulePlanningContext(
  leagueSlug: string,
  options: SchedulePlanningOptions = {},
): Promise<SchedulePlanningLeagueContext> {
  return runInLeagueStateScope(() => buildInner(leagueSlug, options));
}

async function buildInner(
  leagueSlug: string,
  options: SchedulePlanningOptions,
): Promise<SchedulePlanningLeagueContext> {
  const inputs = await buildRosterHealthInputs(leagueSlug, options);
  const lmcRes = await buildLeagueManagementContext(leagueSlug, { snapshotOverride: inputs.snapshot });
  if (!lmcRes.ok || !lmcRes.context) {
    throw new Error(`schedule-planning: Team-State context unavailable (${lmcRes.code ?? "unknown"})`);
  }
  const lmc = lmcRes.context;

  const warnings = [...inputs.warnings, ...lmc.warnings];

  // ---- planning horizon from CANONICAL playoff config (spec §14) ----
  const playoff = inputs.snapshot.league.playoff_settings ?? {
    playoff_team_count: null,
    playoff_start_week: null,
    championship_week: null,
  };
  const currentWeek = inputs.week;
  const playoffConfigAvailable =
    playoff.playoff_start_week != null && playoff.championship_week != null;
  const lastRegularWeek = playoffConfigAvailable
    ? Math.max(currentWeek, playoff.playoff_start_week! - 1)
    : NFL_LAST_REGULAR_WEEK;
  const playoffWeeks = playoffConfigAvailable
    ? range(playoff.playoff_start_week!, playoff.championship_week!)
    : [];
  if (!playoffConfigAvailable) warnings.push("schedule-planning: playoff config unavailable — planning through NFL week 18, no playoff weeks");

  // ---- ONE full-season schedule fetch (spec §2, §31) ----
  const schedule: FullSchedule = await loadFullSchedule(
    inputs.season,
    currentWeek,
    Math.max(lastRegularWeek, playoffWeeks.at(-1) ?? lastRegularWeek),
  );

  const fiVersion = "not_used"; // FI is descriptive-only in Phase 7 (spec §12); no numeric adjustment

  const lineage: PlanningLineage = {
    planning_model_version: PLANNING_MODEL_VERSION,
    team_state_version: TEAM_STATE_VERSION,
    roster_health_version: ROSTER_HEALTH_VERSION,
    weekly_projection_lineage: { model_version: inputs.weekly.model_version, source: inputs.weekly.source },
    ros_projection_lineage: { source: inputs.ros_source, ri_model_version: inputs.ri_model_version },
    nfl_schedule_source: schedule.source,
    football_intelligence_version: fiVersion,
    league_snapshot_id: lmc.league.league_snapshot_id ?? null,
    scoring_fingerprint: lmc.league.scoring_fingerprint ?? null,
    planning_horizon: { current_week: currentWeek, last_regular_week: lastRegularWeek, playoff_weeks: playoffWeeks },
    playoff_config: playoffConfigAvailable
      ? {
          playoff_start_week: playoff.playoff_start_week,
          playoff_team_count: playoff.playoff_team_count,
          championship_week: playoff.championship_week,
        }
      : "unavailable",
    deployment: "SHARED_CONTEXT",
    generated_at: new Date().toISOString(),
  };

  const teamStateByTeamId = new Map(lmc.teams.map((tm) => [tm.identity.canonical_team_id, tm]));

  const teams: TeamSchedulePlan[] = [];
  for (const roster of [...inputs.rosters].sort(
    (a, b) => rosterIdOf(a, teamStateByTeamId) - rosterIdOf(b, teamStateByTeamId),
  )) {
    const ts = teamStateByTeamId.get(roster.canonical_team_id);
    if (!ts) continue;

    // current-week baseline usable-backup total (ROS horizon) for the health delta
    const baseHv = evaluateHorizon(inputs, roster, ts, "rest_of_season");
    const baselineDepthUsable = baseHv.depth_quality
      .filter((d) => !d.excluded_from_core_fragility)
      .reduce((sum, d) => sum + d.usable_backup_count, 0);

    const week_timeline = buildWeekTimeline({
      inputs,
      roster,
      teamState: ts,
      schedule,
      currentWeek,
      lastRegularWeek,
      playoffWeeks,
      fiVersion,
      baselineDepthUsable,
    });

    const summary = summarize(week_timeline, playoffWeeks);
    const degradation = rollUp(week_timeline, playoffConfigAvailable, ts.identity.is_vacant);

    teams.push({
      planning_model_version: PLANNING_MODEL_VERSION,
      lineage,
      team_id: roster.canonical_team_id,
      roster_id: ts.identity.roster_id,
      manager_slug: ts.identity.manager_slug,
      manager_display_name: ts.identity.manager_display_name,
      team_name: ts.identity.team_name,
      is_vacant: ts.identity.is_vacant,
      week_timeline,
      summary,
      degradation,
      orchestrator_hint: null,
    });
  }

  return {
    planning_model_version: PLANNING_MODEL_VERSION,
    lineage,
    league_slug: inputs.league_slug,
    season: inputs.season,
    week: currentWeek,
    teams,
    roster_index: Object.fromEntries(teams.map((t, i) => [t.roster_id, i])),
    manager_index: Object.fromEntries(teams.map((t, i) => [t.manager_slug, i])),
    warnings,
  };
}

/* ------------------------------------------------------------------ helpers */

function range(a: number, b: number): number[] {
  const r: number[] = [];
  for (let i = a; i <= b; i += 1) r.push(i);
  return r;
}

function rosterIdOf(
  roster: { canonical_team_id: string },
  m: Map<string, { identity: { roster_id: number } }>,
): number {
  return m.get(roster.canonical_team_id)?.identity.roster_id ?? 999;
}

function summarize(timeline: WeekPlan[], playoffWeeks: number[]): PlanningSummary {
  const future = timeline.filter((w) => !w.is_current);
  const byeWeeks = future.filter((w) => w.bye_player_count > 0);
  const nextBye = byeWeeks[0]?.week ?? null;

  let worst: PlanningSummary["worst_bye_week"] = null;
  for (const w of byeWeeks) {
    if (worst == null || (w.estimated_bye_loss ?? 0) > (worst.estimated_bye_loss ?? 0)) {
      worst = { week: w.week, estimated_bye_loss: w.estimated_bye_loss };
    }
  }

  // tightest 3-week window by summed bye loss
  let window: PlanningSummary["bye_concentration_window"] = null;
  for (let i = 0; i < timeline.length; i += 1) {
    const slice = timeline.slice(i, i + 3);
    const first = slice[0];
    const last = slice[slice.length - 1];
    if (slice.length < 2 || !first || !last) continue;
    const total = slice.reduce((s, w) => s + (w.estimated_bye_loss ?? 0), 0);
    if (total > 0 && (window == null || total > window.total_estimated_bye_loss)) {
      window = {
        start_week: first.week,
        end_week: last.week,
        total_estimated_bye_loss: Math.round(total * 100) / 100,
      };
    }
  }

  const weeksWithUncovered = timeline.filter((w) => w.uncovered_slot_labels.length > 0).map((w) => w.week);

  const playoffTimeline = timeline.filter((w) => w.is_playoff_week);
  const playoffExposure =
    playoffTimeline.length > 0
      ? {
          fragility_profile:
            playoffTimeline
              .map((w) => w.future_roster_health?.fragility_profile)
              .find((p): p is string => Boolean(p)) ?? "UNKNOWN",
          thin_positions: [
            ...new Set(playoffTimeline.flatMap((w) => w.uncovered_slot_labels)),
          ],
          weeks_with_uncovered_slots: playoffTimeline
            .filter((w) => w.uncovered_slot_labels.length > 0)
            .map((w) => w.week),
        }
      : null;

  return {
    next_bye_week: nextBye,
    worst_bye_week: worst,
    bye_concentration_window: window,
    weeks_with_uncovered_slots: weeksWithUncovered,
    playoff_weeks: playoffWeeks,
    playoff_exposure: playoffExposure,
    projected_lineup_value_timeline: timeline.map((w) => ({
      week: w.week,
      value: w.projected_lineup_value,
      basis: w.projection_basis,
    })),
  };
}

function rollUp(
  timeline: WeekPlan[],
  playoffConfigAvailable: boolean,
  vacant: boolean,
): PlanningDegradation {
  const reasons = new Set<PlanningDegradationReason>();
  for (const w of timeline) for (const r of w.degradation.reasons) reasons.add(r);
  if (!playoffConfigAvailable) reasons.add("PLAYOFF_CONFIG_UNAVAILABLE");

  const structOrder = { OK: 0, PARTIAL: 1, INSUFFICIENT: 2 } as const;
  const valueOrder = { OK: 0, DEGRADED: 1, ROS_ONLY: 2, INSUFFICIENT: 3 } as const;
  let structure: PlanningDegradation["structure"] = "OK";
  let value: PlanningDegradation["value"] = "OK";
  for (const w of timeline) {
    if (structOrder[w.degradation.structure] > structOrder[structure]) structure = w.degradation.structure;
    if (valueOrder[w.degradation.value] > valueOrder[value]) value = w.degradation.value;
  }
  void vacant;
  return { reasons: [...reasons], structure, value };
}
