/**
 * Phase 6 — league-relative + position-relative benchmarking (spec §16, §17).
 * Percentiles are computed ONLY among comparable values from the same league,
 * same snapshot, same scoring, same horizon. Raw values are always retained.
 */

import type { TeamRosterHealth, Horizon } from "./schema";

function percentileRank(values: number[], v: number): number | null {
  const finite = values.filter((x) => Number.isFinite(x));
  if (finite.length < 2 || !Number.isFinite(v)) return null;
  const below = finite.filter((x) => x < v).length;
  const equal = finite.filter((x) => x === v).length;
  return Math.round(((below + equal / 2) / finite.length) * 100);
}

export function applyLeagueBenchmarks(teams: TeamRosterHealth[]): void {
  for (const horizon of ["weekly", "rest_of_season"] as Horizon[]) {
    const view = (t: TeamRosterHealth) => (horizon === "weekly" ? t.weekly : t.rest_of_season);

    const starterQ = teams.map((t) => view(t).starter_quality_vor_total ?? NaN);
    const depthQ = teams.map((t) => sumUsable(view(t)));
    // fragility: lower worst_starter_dependency = healthier -> invert
    const fragilityHealth = teams.map((t) => -(view(t).fragility.worst_starter_dependency ?? NaN));
    const benchU = teams.map((t) => view(t).bench_utility.reduce((s, b) => s + (b.starter_replacement_value ?? 0), 0));

    // per-position dependency pools (for position_percentile on each player)
    const depByPos = new Map<string, number[]>();
    for (const t of teams) {
      for (const d of view(t).player_dependency) {
        if (d.raw_point_loss == null) continue;
        (depByPos.get(d.position) ?? depByPos.set(d.position, []).get(d.position)!).push(d.raw_point_loss);
      }
    }
    const allDep = teams.flatMap((t) => view(t).player_dependency.map((d) => d.raw_point_loss ?? NaN));

    for (const t of teams) {
      const v = view(t);
      const rel = horizon === "weekly" ? t.league_relative.weekly : t.league_relative.rest_of_season;
      rel.starter_quality_pct = percentileRank(starterQ, v.starter_quality_vor_total ?? NaN);
      rel.depth_quality_pct = percentileRank(depthQ, sumUsable(v));
      rel.fragility_pct = percentileRank(fragilityHealth, -(v.fragility.worst_starter_dependency ?? NaN));
      rel.bench_utility_pct = percentileRank(
        benchU,
        v.bench_utility.reduce((s, b) => s + (b.starter_replacement_value ?? 0), 0),
      );
      rel.worst_dependency_pct = percentileRank(
        teams.map((x) => view(x).fragility.worst_starter_dependency ?? NaN),
        v.fragility.worst_starter_dependency ?? NaN,
      );
      for (const d of v.player_dependency) {
        d.league_percentile = percentileRank(allDep, d.raw_point_loss ?? NaN);
        d.position_percentile = percentileRank(depByPos.get(d.position) ?? [], d.raw_point_loss ?? NaN);
      }
    }
  }
}

function sumUsable(v: TeamRosterHealth["weekly"]): number {
  return v.depth_quality.filter((p) => !p.excluded_from_core_fragility).reduce((s, p) => s + p.usable_backup_count, 0);
}
