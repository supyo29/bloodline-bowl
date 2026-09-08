/**
 * Phase 7 — planning delta (spec §22).
 *
 * Descriptive / evaluative comparison of two immutable planning snapshots for the
 * SAME team. It NEVER concludes "this transaction was good" — it reports what
 * changed in the schedule-grounded planning picture, carrying before/after
 * lineage. Identical inputs → zero changes (invariant).
 */

import type {
  TeamSchedulePlan,
  SchedulePlanningDelta,
  PlanningChange,
  PlanningDegradationReason,
} from "./schema";

export function planningDelta(before: TeamSchedulePlan, after: TeamSchedulePlan): SchedulePlanningDelta {
  if (before.team_id !== after.team_id) {
    throw new Error(`planningDelta: team mismatch ${before.team_id} != ${after.team_id}`);
  }

  const changes: PlanningChange[] = [];
  const beforeByWeek = new Map(before.week_timeline.map((w) => [w.week, w]));

  for (const aw of after.week_timeline) {
    const bw = beforeByWeek.get(aw.week);
    if (!bw) continue;

    const bUncov = bw.uncovered_slot_labels.length;
    const aUncov = aw.uncovered_slot_labels.length;
    if (aUncov > bUncov) {
      changes.push(mk("WEEK_COVERAGE_WORSENED", aw.week, bUncov, aUncov));
      if (bUncov === 0) changes.push(mk("NEW_UNCOVERED_SLOT_WEEK", aw.week, "covered", aw.uncovered_slot_labels.join(",")));
    } else if (aUncov < bUncov) {
      changes.push(mk("WEEK_COVERAGE_IMPROVED", aw.week, bUncov, aUncov));
      if (aUncov === 0) changes.push(mk("UNCOVERED_SLOT_WEEK_RESOLVED", aw.week, bw.uncovered_slot_labels.join(","), "covered"));
    }

    if (aw.bye_player_count > bw.bye_player_count) {
      changes.push(mk("BYE_COLLISION_ADDED", aw.week, bw.bye_player_count, aw.bye_player_count));
    } else if (aw.bye_player_count < bw.bye_player_count) {
      changes.push(mk("BYE_COLLISION_REMOVED", aw.week, bw.bye_player_count, aw.bye_player_count));
    }

    // ROS-projected lineup value shift — labelled, never framed as a verdict
    const bv = bw.projected_lineup_value;
    const av = aw.projected_lineup_value;
    if (bv != null && av != null && Math.abs(av - bv) >= 0.5) {
      changes.push(
        mk(av > bv ? "ROS_PROJECTED_LINEUP_IMPROVED" : "ROS_PROJECTED_LINEUP_WORSENED", aw.week, round2(bv), round2(av)),
      );
    }

    const bProf = bw.future_roster_health?.fragility_profile ?? null;
    const aProf = aw.future_roster_health?.fragility_profile ?? null;
    if (aw.is_playoff_week && bProf && aProf && bProf !== aProf) {
      const worse = rank(aProf) > rank(bProf);
      changes.push(mk(worse ? "PLAYOFF_FRAGILITY_WORSENED" : "PLAYOFF_FRAGILITY_IMPROVED", aw.week, bProf, aProf));
    }
  }

  // bye-concentration window shift
  const bWin = before.summary.bye_concentration_window;
  const aWin = after.summary.bye_concentration_window;
  if ((bWin?.start_week ?? null) !== (aWin?.start_week ?? null)) {
    changes.push(mk("BYE_CONCENTRATION_SHIFTED", aWin?.start_week ?? null, bWin?.start_week ?? null, aWin?.start_week ?? null));
  }

  const comparison_degradation = [
    ...new Set<PlanningDegradationReason>([
      ...before.degradation.reasons,
      ...after.degradation.reasons,
    ]),
  ];
  if (before.lineage.league_snapshot_id !== after.lineage.league_snapshot_id) {
    // snapshots differ — expected; not itself a degradation
  }
  if (before.lineage.planning_model_version !== after.lineage.planning_model_version) {
    comparison_degradation.push("LINEAGE_MISMATCH");
  }

  return {
    planning_model_version: after.planning_model_version,
    team_id: after.team_id,
    before: {
      league_snapshot_id: before.lineage.league_snapshot_id,
      weekly_model_version: before.lineage.weekly_projection_lineage.model_version,
      ros_source: before.lineage.ros_projection_lineage.source,
    },
    after: {
      league_snapshot_id: after.lineage.league_snapshot_id,
      weekly_model_version: after.lineage.weekly_projection_lineage.model_version,
      ros_source: after.lineage.ros_projection_lineage.source,
    },
    comparison_degradation,
    changes,
    summary:
      changes.length === 0
        ? "No change in the schedule-grounded planning picture."
        : `${changes.length} planning change(s) across ${new Set(changes.map((c) => c.week)).size} week(s) — descriptive only.`,
  };
}

const round2 = (v: number) => Math.round(v * 100) / 100;

function mk(
  type: PlanningChange["type"],
  week: number | null,
  before: number | string | null,
  after: number | string | null,
): PlanningChange {
  const delta =
    typeof before === "number" && typeof after === "number" ? round2(after - before) : null;
  return { type, week, before, after, delta };
}

function rank(profile: string): number {
  return (
    { RESILIENT: 0, DISTRIBUTED_FRAGILITY: 1, CONCENTRATED_FRAGILITY: 2, FRAGILE_BOTH: 3 }[profile] ?? 0
  );
}
