/**
 * Phase 6 — deterministic snapshot roster-health delta (spec §19, §20).
 * DESCRIPTIVE only — never "this trade was good".
 */
import type { TeamRosterHealth, RosterHealthDelta, RosterHealthChange, Horizon } from "./schema";
import { ROSTER_HEALTH_VERSION } from "./schema";

const round2 = (v: number) => Math.round(v * 100) / 100;

export function rosterHealthDelta(before: TeamRosterHealth, after: TeamRosterHealth): RosterHealthDelta {
  const changes: RosterHealthChange[] = [];
  const comparison_degradation: RosterHealthDelta["comparison_degradation"] = [];

  const bl = before.lineage.projection_lineage;
  const al = after.lineage.projection_lineage;
  if (bl.weekly.model_version !== al.weekly.model_version || bl.ros.source !== al.ros.source) {
    comparison_degradation.push("LINEAGE_MISMATCH");
  }

  for (const horizon of ["weekly", "rest_of_season"] as Horizon[]) {
    const b = horizon === "weekly" ? before.weekly : before.rest_of_season;
    const a = horizon === "weekly" ? after.weekly : after.rest_of_season;

    diffNum(changes, horizon, null, "STARTER_QUALITY_INCREASED", "STARTER_QUALITY_DECREASED", b.starter_quality_vor_total, a.starter_quality_vor_total, 0.5);
    diffNum(changes, horizon, null, "FRAGILITY_DECREASED", "FRAGILITY_INCREASED", b.fragility.worst_starter_dependency, a.fragility.worst_starter_dependency, 0.5, true);
    diffNum(changes, horizon, null, "CONCENTRATION_DECREASED", "CONCENTRATION_INCREASED", b.fragility.top3_weighted_dependency, a.fragility.top3_weighted_dependency, 0.5, true);

    for (const key of new Set([...b.depth_quality.map((d) => d.slot_key), ...a.depth_quality.map((d) => d.slot_key)])) {
      const bd = b.depth_quality.find((d) => d.slot_key === key);
      const ad = a.depth_quality.find((d) => d.slot_key === key);
      const bu = bd?.usable_backup_count ?? 0;
      const au = ad?.usable_backup_count ?? 0;
      if (au > bu) changes.push({ type: "DEPTH_QUALITY_IMPROVED", horizon, slot_key: key, before: bu, after: au, delta: au - bu });
      else if (au < bu) changes.push({ type: "DEPTH_QUALITY_WORSENED", horizon, slot_key: key, before: bu, after: au, delta: au - bu });
    }

    const bSpof = new Set(b.fragility.single_points_of_failure);
    const aSpof = new Set(a.fragility.single_points_of_failure);
    for (const id of aSpof) if (!bSpof.has(id)) changes.push({ type: "NEW_SINGLE_POINT_OF_FAILURE", horizon, slot_key: null, before: null, after: id, delta: null });
    for (const id of bSpof) if (!aSpof.has(id)) changes.push({ type: "SINGLE_POINT_OF_FAILURE_RESOLVED", horizon, slot_key: null, before: id, after: null, delta: null });

    for (const key of new Set([...b.quality_surplus.map((q) => q.slot_key), ...a.quality_surplus.map((q) => q.slot_key)])) {
      const bq = b.quality_surplus.find((q) => q.slot_key === key)?.quality_surplus ?? false;
      const aq = a.quality_surplus.find((q) => q.slot_key === key)?.quality_surplus ?? false;
      if (aq && !bq) changes.push({ type: "QUALITY_SURPLUS_GAINED", horizon, slot_key: key, before: "false", after: "true", delta: null });
      else if (bq && !aq) changes.push({ type: "QUALITY_SURPLUS_LOST", horizon, slot_key: key, before: "true", after: "false", delta: null });
    }
  }

  const summary =
    changes.length === 0
      ? "No material roster-health change."
      : changes
          .map((c) => `${c.type.replace(/_/g, " ").toLowerCase()}${c.slot_key ? ` (${c.slot_key} ${c.horizon})` : ` (${c.horizon})`}${c.delta != null ? ` Δ${round2(c.delta)}` : ""}`)
          .join("; ");

  return {
    roster_health_version: ROSTER_HEALTH_VERSION,
    team_id: after.team_id,
    before: { league_snapshot_id: before.lineage.league_snapshot_id, projection_lineage: bl },
    after: { league_snapshot_id: after.lineage.league_snapshot_id, projection_lineage: al },
    comparison_degradation,
    changes,
    summary,
  };
}

function diffNum(
  changes: RosterHealthChange[],
  horizon: Horizon,
  slot_key: string | null,
  upType: RosterHealthChange["type"],
  downType: RosterHealthChange["type"],
  before: number | null,
  after: number | null,
  minDelta: number,
  inverted = false,
): void {
  if (before == null || after == null) return;
  const delta = round2(after - before);
  if (Math.abs(delta) < minDelta) return;
  const better = inverted ? delta < 0 : delta > 0;
  changes.push({ type: better ? upType : downType, horizon, slot_key, before, after, delta });
}
