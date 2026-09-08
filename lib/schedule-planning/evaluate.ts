/**
 * Phase 7 — per-team future planning timeline.
 *
 * For every remaining week: schedule-verified byes → future legal lineup (the
 * FROZEN `buildOptimalLineup`) → uncovered slots + bye-loss estimate + projected
 * lineup value + (near/medium window) future roster-health via the FROZEN Phase 6
 * `evaluateHorizon`.
 *
 * STRUCTURE fields (bye / coverage / opponent / playoff-week) are HIGH confidence
 * for the full regular season. VALUE fields (projected lineup totals, bye-loss
 * points, future roster-health value) degrade with the projection horizon and are
 * explicitly labelled `ROS_PROJECTION`. The two are never collapsed (spec §1).
 */

import { buildOptimalLineup } from "@/lib/weekly/lineup";
import { evaluateHorizon, rosterWithout, type RosterHealthInputs } from "@/lib/roster-health";
import type { CanonicalRoster } from "@/lib/canonical/schema";
import type { TeamManagementState } from "@/lib/team-state/schema";
import type { WeeklyProjectionBatch, WeeklyProjection } from "@/lib/weekly/schema";
import type { FullSchedule } from "./schedule";
import type {
  WeekPlan,
  ScheduleContextEntry,
  FutureRosterHealthPressure,
  PlanningDegradation,
  PlanningDegradationReason,
  ProjectionBasis,
  ValueConfidence,
  StructureConfidence,
} from "./schema";

const NEAR_TERM = 3;
const MEDIUM_TERM = 6;
const round2 = (v: number) => Math.round(v * 100) / 100;

export interface TimelineInput {
  inputs: RosterHealthInputs;
  roster: CanonicalRoster;
  teamState: TeamManagementState;
  schedule: FullSchedule;
  currentWeek: number;
  lastRegularWeek: number;
  playoffWeeks: number[];
  fiVersion: string;
  /** current-week baseline usable-backup total (same horizon) for the health delta. */
  baselineDepthUsable: number;
}

export function buildWeekTimeline(t: TimelineInput): WeekPlan[] {
  const { inputs, roster, teamState, schedule, currentWeek, lastRegularWeek, playoffWeeks } = t;
  const { constraints, playerById } = inputs;
  const weeklyModel = inputs.weekly.model_version;

  const activeIds = roster.all_players.filter((id) => !roster.ir.includes(id) && !roster.taxi.includes(id));

  // per-player remaining PLAYING weeks (schedule-verified byes removed) — the
  // denominator for the prorated ROS per-week mean.
  const remainingPlayingWeeks = new Map<string, number>();
  for (const id of activeIds) {
    const abbr = playerById.get(id)?.nfl_team;
    if (!abbr) continue;
    let n = 0;
    for (let w = currentWeek; w <= lastRegularWeek; w += 1) {
      if (schedule.byeByWeek.get(w)?.has(abbr)) continue;
      n += 1;
    }
    remainingPlayingWeeks.set(id, Math.max(1, n));
  }
  const rosPerWeek = (id: string): number | null => {
    const tot = inputs.rosPointsByCid.get(id) ?? null;
    return tot != null ? tot / (remainingPlayingWeeks.get(id) ?? 1) : null;
  };

  const weeks = [...new Set([...range(currentWeek, lastRegularWeek), ...playoffWeeks])].sort((a, b) => a - b);
  const out: WeekPlan[] = [];

  for (const week of weeks) {
    const isCurrent = week === currentWeek;
    const isPlayoff = playoffWeeks.includes(week);
    const byeAbbrs = schedule.byeByWeek.get(week) ?? null;
    const weekIncomplete = schedule.incompleteWeeks.has(week);

    const reasons: PlanningDegradationReason[] = ["ROSTER_ASSUMED_STATIC"];
    if (weekIncomplete) reasons.push("SCHEDULE_WEEK_INCOMPLETE");

    // ---- VALUE basis: current week = true weekly projection; future = prorated ROS
    const basis: ProjectionBasis = isCurrent ? "WEEKLY" : "ROS_PROJECTION";
    if (!isCurrent) reasons.push("FUTURE_WEEKLY_PROJECTION_UNAVAILABLE", "ROS_PROJECTION_USED");
    const ptsFor = (id: string): number | null =>
      isCurrent ? inputs.weekly.by_player.get(id)?.projected_points ?? null : rosPerWeek(id);

    const missing = activeIds.filter(
      (id) => ptsFor(id) == null && inputs.weekly.by_player.get(id)?.projection_status !== "bye",
    );
    if (missing.length > 0) reasons.push("MISSING_PLAYER_PROJECTION");
    if (byeAbbrs == null && !weekIncomplete) {
      // schedule fetched but this week's bye set could not be asserted
    }
    if (Object.keys(schedule.opponentByWeek.get(week) ?? {}).length === 0) reasons.push("OPPONENT_UNKNOWN");

    const weekBatch = synthBatch(inputs.weekly, activeIds, ptsFor);

    // ---- STRUCTURE: future legal lineup, byes applied
    const byePlayers = byeAbbrs
      ? activeIds.filter((id) => {
          const abbr = playerById.get(id)?.nfl_team;
          return abbr != null && byeAbbrs.has(abbr);
        })
      : [];

    const noByeLineup = buildOptimalLineup({ week, roster, constraints, players: playerById, projections: weekBatch });
    const byeRoster = byePlayers.length ? rosterWithout(roster, new Set(byePlayers)) : roster;
    const byeLineup = byePlayers.length
      ? buildOptimalLineup({ week, roster: byeRoster, constraints, players: playerById, projections: weekBatch })
      : noByeLineup;

    const byeStarters = byePlayers.filter((id) =>
      noByeLineup.slots.some((s) => s.recommended_player_id === id),
    );
    const uncovered = byeAbbrs
      ? byeLineup.slots.filter((s) => !s.recommended_player_id).map((s) => s.slot)
      : [];

    const byeLoss =
      byeAbbrs && noByeLineup.optimal_total != null && byeLineup.optimal_total != null
        ? round2(Math.max(0, noByeLineup.optimal_total - byeLineup.optimal_total))
        : byeAbbrs
          ? null
          : 0;

    // ---- schedule context per filled starter slot (descriptive only, spec §12)
    const oppMap = schedule.opponentByWeek.get(week) ?? {};
    const context: ScheduleContextEntry[] = byeLineup.slots
      .filter((s) => s.recommended_player_id)
      .map((s) => {
        const pid = s.recommended_player_id!;
        const abbr = playerById.get(pid)?.nfl_team ?? null;
        const opp = abbr ? oppMap[abbr] ?? null : null;
        const onBye = byeAbbrs != null && abbr != null && byeAbbrs.has(abbr);
        return {
          slot_key: s.slot,
          canonical_player_id: pid,
          nfl_team: abbr,
          opponent: opp,
          home_away: null, // provider does not expose home/away (documented in schedule.ts)
          is_bye: onBye,
          context_label: onBye ? "bye" : opp ? "neutral" : "unknown",
          evidence: { opponent: opp, week },
        };
      });

    // ---- future roster-health pressure — near+medium window only (runtime tail)
    let health: FutureRosterHealthPressure | null = null;
    if (!isCurrent && week - currentWeek <= MEDIUM_TERM) {
      const inputsW = withWeekPoints(inputs, activeIds, ptsFor, byeAbbrs);
      const hv = evaluateHorizon(inputsW, byeRoster, teamState, "rest_of_season");
      const usable = hv.depth_quality
        .filter((d) => !d.excluded_from_core_fragility)
        .reduce((sum, d) => sum + d.usable_backup_count, 0);
      health = {
        fragility_profile: hv.fragility.profile,
        worst_dependency: hv.fragility.worst_starter_dependency,
        single_points_of_failure: hv.fragility.single_points_of_failure,
        uncovered_slot_labels: uncovered,
        depth_quality_delta: round2(usable - t.baselineDepthUsable),
        quality_surplus_slots_lost: [],
      };
    }

    // ---- confidence: STRUCTURE and VALUE resolved independently (spec §1, §9)
    const structureConf: StructureConfidence = weekIncomplete ? "LOW" : "HIGH";
    const dist = week - currentWeek;
    const valueConf: ValueConfidence = isCurrent
      ? "HIGH"
      : missing.length > 0
        ? "LOW"
        : dist <= MEDIUM_TERM
          ? "MEDIUM"
          : "ROS_CONTEXT_ONLY";
    void NEAR_TERM;

    const degradation: PlanningDegradation = {
      reasons: [...new Set(reasons)],
      structure: weekIncomplete ? "PARTIAL" : "OK",
      value: isCurrent
        ? "OK"
        : missing.length === activeIds.length
          ? "INSUFFICIENT"
          : missing.length > 0
            ? "DEGRADED"
            : "ROS_ONLY",
    };

    out.push({
      week,
      is_current: isCurrent,
      is_playoff_week: isPlayoff,
      nfl_schedule_state: weekIncomplete ? "SCHEDULE_WEEK_INCOMPLETE" : "SCHEDULE_KNOWN",
      starters_on_bye: byeStarters,
      bye_player_count: byePlayers.length,
      legal_lineup_covered: uncovered.length === 0,
      uncovered_slot_labels: uncovered,
      structure_confidence: structureConf,
      projection_basis: missing.length === activeIds.length ? "NONE" : basis,
      projected_lineup_value: byeLineup.optimal_total,
      no_bye_lineup_value: noByeLineup.optimal_total,
      estimated_bye_loss: byeLoss,
      value_confidence: valueConf,
      value_source: {
        weekly_model_version: weeklyModel,
        ros_source: inputs.ros_source,
        ri_model_version: inputs.ri_model_version,
      },
      schedule_context: context,
      future_roster_health: health,
      degradation,
    });
  }
  return out;
}

/* ------------------------------------------------------------------ helpers */

function range(a: number, b: number): number[] {
  const r: number[] = [];
  for (let i = a; i <= b; i += 1) r.push(i);
  return r;
}

/** clone the weekly batch with `projected_points` swapped to the per-week basis. */
function synthBatch(
  base: WeeklyProjectionBatch,
  ids: string[],
  ptsFor: (id: string) => number | null,
): WeeklyProjectionBatch {
  const by_player = new Map<string, WeeklyProjection>();
  for (const id of ids) {
    const wp = base.by_player.get(id);
    if (!wp) continue;
    const pts = ptsFor(id);
    by_player.set(id, {
      ...wp,
      projected_points: pts,
      floor_points: pts != null ? pts * 0.7 : null,
      ceiling_points: pts != null ? pts * 1.3 : null,
      std_dev: pts != null ? pts * 0.3 : null,
      projection_status: pts != null ? "projected" : wp.projection_status,
    });
  }
  return { ...base, by_player };
}

/** a RosterHealthInputs clone whose ROS points map is the per-week basis (byes → 0). */
function withWeekPoints(
  inputs: RosterHealthInputs,
  ids: string[],
  ptsFor: (id: string) => number | null,
  byeAbbrs: Set<string> | null,
): RosterHealthInputs {
  const rosPointsByCid = new Map<string, number | null>();
  for (const id of ids) {
    const abbr = inputs.playerById.get(id)?.nfl_team;
    const onBye = byeAbbrs != null && abbr != null && byeAbbrs.has(abbr);
    rosPointsByCid.set(id, onBye ? 0 : ptsFor(id));
  }
  return { ...inputs, rosPointsByCid };
}
