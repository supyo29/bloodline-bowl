/**
 * PHASE 2 — production-path v1 → v2 calibration impact audit.
 *
 *   npx tsx scripts/audit-production-v1-v2.ts
 *
 * Runs the COMPLETE production model (`buildBaseProjections` -> `projectTeamOffense`
 * -> reconciliation) twice over the identical 2026 universe — same roster data,
 * team environment, depth charts, league-independent inputs, reconciliation and
 * runtime state — with the ONLY difference being the Phase 2 calibration
 * (`CALIBRATION_V1` vs `CALIBRATION_V2`).
 *
 * Outputs (outputs/projections-2026/):
 *   phase2_production_v1_v2_comparison.csv   one row per player
 *   phase2_production_impact_summary.json    aggregates by position / age band / tier
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { buildBaseProjections, clearProjectionCaches } from "@/lib/projections/build";
import { CALIBRATION_V1, CALIBRATION_V2 } from "@/lib/projections/baselines";
import type { PlayerProjection } from "@/lib/projections/schema";

const OUT_DIR = join("outputs", "projections-2026");

function opportunity(p: PlayerProjection): number {
  const s = p.stats;
  return (s.pass_att ?? 0) + (s.targets ?? 0) + (s.rush_att ?? 0);
}
function round(v: number, d = 2): number {
  const m = 10 ** d;
  return Math.round(v * m) / m;
}
function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return lo === hi ? sorted[lo]! : sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (i - lo);
}
function ageBand(age: number | null): string {
  if (age == null) return "unknown";
  if (age < 24) return "<24";
  if (age < 27) return "24-26";
  if (age < 30) return "27-29";
  if (age < 33) return "30-32";
  return "33+";
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  console.log("Building production 2026 projections under v1 and v2 calibration…");

  clearProjectionCaches();
  const v1 = await buildBaseProjections({ season: 2026, skipBenchmark: true, calibration: CALIBRATION_V1 });
  const v2 = await buildBaseProjections({ season: 2026, skipBenchmark: true, calibration: CALIBRATION_V2 });
  // pre-reconciliation ("core") projections, for the sign-reversal analysis
  clearProjectionCaches();
  const v1core = await buildBaseProjections({ season: 2026, skipBenchmark: true, normalize: false, calibration: CALIBRATION_V1 });
  clearProjectionCaches();
  const v2core = await buildBaseProjections({ season: 2026, skipBenchmark: true, normalize: false, calibration: CALIBRATION_V2 });
  console.log(`  v1: ${v1.projections.size} players   v2: ${v2.projections.size} players`);

  // tier by v1 projected points within position (preseason grouping)
  const byPosV1 = new Map<string, PlayerProjection[]>();
  for (const p of v1.projections.values()) {
    if (!byPosV1.has(p.position)) byPosV1.set(p.position, []);
    byPosV1.get(p.position)!.push(p);
  }
  const tierOf = new Map<string, string>();
  for (const [, list] of byPosV1) {
    const sorted = [...list].sort((a, b) => b.neutral_points - a.neutral_points);
    sorted.forEach((p, i) => {
      const pct = i / sorted.length;
      tierOf.set(p.player_id, pct < 0.1 ? "top_10" : pct < 0.25 ? "p10_25" : pct < 0.5 ? "p25_50" : "bottom_50");
    });
  }

  interface Row {
    player_id: string; player_name: string; team: string | null; position: string;
    age: number | null; age_band: string; tier: string;
    v1_expected_games: number; v2_expected_games: number;
    v1_opportunity: number; v2_opportunity: number;
    v1_age_multiplier: number | null; v2_age_multiplier: number | null;
    v1_points: number; v2_points: number; delta: number; delta_pct: number | null;
    primary_reason: string;
  }

  const rows: Row[] = [];
  for (const [pid, a] of v1.projections) {
    const b = v2.projections.get(pid);
    if (!b) continue;
    const v1g = a.availability.expected_games;
    const v2g = b.availability.expected_games;
    const v1o = opportunity(a);
    const v2o = opportunity(b);
    const dGames = v2g - v1g;
    const dOppPct = v1o > 0 ? (v2o - v1o) / v1o : 0;
    const dAgeMul = (b.components.age_multiplier ?? 1) - (a.components.age_multiplier ?? 1);
    const delta = round(b.neutral_points - a.neutral_points);

    // attribute the dominant driver
    let reason = "unchanged";
    if (Math.abs(delta) >= 0.5) {
      const gamesEffect = Math.abs(dGames) / Math.max(v1g, 1);
      const oppEffect = Math.abs(dOppPct);
      const ageEffect = Math.abs(dAgeMul);
      if (gamesEffect >= oppEffect && gamesEffect >= ageEffect) {
        reason = dGames < 0 ? "expected_games_haircut" : "expected_games_floor_edge";
      } else if (oppEffect >= ageEffect) {
        reason = dOppPct < 0 ? "opportunity_age_shade_30plus" : "opportunity_redistribution";
      } else {
        reason = dAgeMul < 0 ? "steeper_age_curve" : "age_curve";
      }
    }

    rows.push({
      player_id: pid, player_name: a.full_name, team: a.team, position: a.position,
      age: a.age, age_band: ageBand(a.age), tier: tierOf.get(pid) ?? "bottom_50",
      v1_expected_games: v1g, v2_expected_games: v2g,
      v1_opportunity: round(v1o, 1), v2_opportunity: round(v2o, 1),
      v1_age_multiplier: a.components.age_multiplier, v2_age_multiplier: b.components.age_multiplier,
      v1_points: a.neutral_points, v2_points: b.neutral_points,
      delta, delta_pct: a.neutral_points > 0 ? round((delta / a.neutral_points) * 100, 1) : null,
      primary_reason: reason,
    });
  }
  rows.sort((x, y) => x.delta - y.delta);

  const headers = Object.keys(rows[0]!) as (keyof Row)[];
  const csv = [
    headers.join(","),
    ...rows.map((r) => headers.map((h) => (r[h] == null ? "" : String(r[h]))).join(",")),
  ].join("\n") + "\n";
  writeFileSync(join(OUT_DIR, "phase2_production_v1_v2_comparison.csv"), csv);
  console.log(`  wrote phase2_production_v1_v2_comparison.csv (${rows.length} players)`);

  // ---- aggregates ----
  const agg = (subset: Row[]) => {
    const d = subset.map((r) => r.delta).sort((a, b) => a - b);
    const dPct = subset.map((r) => r.delta_pct).filter((v): v is number => v != null).sort((a, b) => a - b);
    return {
      n: subset.length,
      mean_delta: round(d.reduce((a, b) => a + b, 0) / (d.length || 1)),
      median_delta: round(quantile(d, 0.5)),
      p10_delta: round(quantile(d, 0.1)),
      p90_delta: round(quantile(d, 0.9)),
      max_increase: round(Math.max(...d, 0)),
      max_decrease: round(Math.min(...d, 0)),
      mean_delta_pct: round(dPct.reduce((a, b) => a + b, 0) / (dPct.length || 1), 1),
      mean_v1_expected_games: round(subset.reduce((a, r) => a + r.v1_expected_games, 0) / (subset.length || 1)),
      mean_v2_expected_games: round(subset.reduce((a, r) => a + r.v2_expected_games, 0) / (subset.length || 1)),
    };
  };
  const groupBy = (key: (r: Row) => string) => {
    const g: Record<string, Row[]> = {};
    for (const r of rows) (g[key(r)] ??= []).push(r);
    return Object.fromEntries(Object.entries(g).map(([k, v]) => [k, agg(v)]));
  };

  const reasonCounts: Record<string, number> = {};
  for (const r of rows) reasonCounts[r.primary_reason] = (reasonCounts[r.primary_reason] ?? 0) + 1;

  // ---- core (pre-reconciliation) vs production sign-reversal analysis ----
  const MATERIAL = 3.0; // points
  const reversals: Array<{ name: string; pos: string; age: number | null; core_delta: number; prod_delta: number }> = [];
  let materialChanged = 0;
  for (const [pid, a] of v1.projections) {
    const b = v2.projections.get(pid);
    const ac = v1core.projections.get(pid);
    const bc = v2core.projections.get(pid);
    if (!b || !ac || !bc) continue;
    const prodDelta = b.neutral_points - a.neutral_points;
    const coreDelta = bc.neutral_points - ac.neutral_points;
    if (Math.abs(prodDelta) < MATERIAL && Math.abs(coreDelta) < MATERIAL) continue;
    materialChanged++;
    if (Math.sign(coreDelta) !== Math.sign(prodDelta) && Math.sign(coreDelta) !== 0 && Math.sign(prodDelta) !== 0) {
      reversals.push({ name: a.full_name, pos: a.position, age: a.age, core_delta: round(coreDelta), prod_delta: round(prodDelta) });
    }
  }
  reversals.sort((x, y) => Math.abs(y.prod_delta) - Math.abs(x.prod_delta));

  const biggestDrops = rows.slice(0, 12).map((r) => ({ name: r.player_name, pos: r.position, age: r.age, delta: r.delta, reason: r.primary_reason }));
  const biggestGains = rows.slice(-12).reverse().map((r) => ({ name: r.player_name, pos: r.position, age: r.age, delta: r.delta, reason: r.primary_reason }));

  const summary = {
    generated_at: new Date().toISOString(),
    v1_model: "ri-structural-2026.1 calibration",
    v2_model: "ri-structural-2026.2 calibration",
    players: rows.length,
    overall: agg(rows),
    by_position: groupBy((r) => r.position),
    by_age_band: groupBy((r) => r.age_band),
    by_tier: groupBy((r) => r.tier),
    primary_reason_counts: reasonCounts,
    biggest_decreases: biggestDrops,
    biggest_increases: biggestGains,
    core_vs_production: {
      material_change_threshold_pts: MATERIAL,
      players_materially_changed: materialChanged,
      sign_reversals: reversals.length,
      reversal_rate: round(reversals.length / Math.max(materialChanged, 1), 4),
      reversal_players: reversals,
    },
  };
  writeFileSync(join(OUT_DIR, "phase2_production_impact_summary.json"), JSON.stringify(summary, null, 2));
  console.log("  wrote phase2_production_impact_summary.json");

  console.log("\nOverall:", JSON.stringify(summary.overall));
  console.log("By position:");
  for (const [k, v] of Object.entries(summary.by_position)) console.log(`  ${k.padEnd(4)}`, JSON.stringify(v));
  console.log("By tier:");
  for (const [k, v] of Object.entries(summary.by_tier)) console.log(`  ${k.padEnd(10)}`, JSON.stringify(v));
  console.log("Reason counts:", JSON.stringify(reasonCounts));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
