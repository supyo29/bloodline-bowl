/**
 * PHASE 3 — production v2 → v3 impact + opportunity-redistribution audit.
 *
 *   npx tsx scripts/audit-phase3-rookie.ts
 *
 * Runs the complete production model twice over the identical 2026 universe —
 * same rosters, team environment, depth charts, reconciliation, runtime state —
 * with the ONLY difference being the Phase 3 draft-capital rookie prior
 * (`CALIBRATION_V2` vs `CALIBRATION_V3`).
 *
 * Outputs (outputs/projections-2026/):
 *   phase3_2026_uncertain_role_audit.csv       every player, v2 vs v3
 *   phase3_opportunity_redistribution_audit.csv per team: rookie gains vs
 *                                               incumbent losses, conservation
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { buildBaseProjections, clearProjectionCaches } from "@/lib/projections/build";
import { CALIBRATION_V2, CALIBRATION_V3 } from "@/lib/projections/baselines";
import { rookieDraftFor } from "@/lib/projections/rookie-model";
import type { PlayerProjection } from "@/lib/projections/schema";

const OUT = join("outputs", "projections-2026");

const opp = (p: PlayerProjection) =>
  (p.stats.targets ?? 0) + (p.stats.rush_att ?? 0) + (p.stats.pass_att ?? 0);
const r2 = (v: number) => Math.round(v * 100) / 100;
const q = (s: number[], x: number) => {
  if (!s.length) return NaN;
  const i = (s.length - 1) * x, lo = Math.floor(i), hi = Math.ceil(i);
  return lo === hi ? s[lo]! : s[lo]! + (s[hi]! - s[lo]!) * (i - lo);
};

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  console.log("Building 2026 projections under v2 (Phase 2) and v3 (Phase 3) calibration…");
  clearProjectionCaches();
  const v2 = await buildBaseProjections({ season: 2026, skipBenchmark: true, calibration: CALIBRATION_V2 });
  clearProjectionCaches();
  const v3 = await buildBaseProjections({ season: 2026, skipBenchmark: true, calibration: CALIBRATION_V3 });

  interface Row {
    player_id: string; name: string; team: string | null; position: string; age: number | null;
    is_rookie: boolean; has_draft: boolean; draft_pick: number | null;
    v2_expected_games: number; v3_expected_games: number;
    v2_opportunity: number; v3_opportunity: number;
    v2_points: number; v3_points: number; delta: number; delta_pct: number | null;
    primary_reason: string;
  }
  const rows: Row[] = [];
  for (const [pid, a] of v2.projections) {
    const b = v3.projections.get(pid);
    if (!b) continue;
    const draft = rookieDraftFor(pid);
    const delta = r2(b.neutral_points - a.neutral_points);
    rows.push({
      player_id: pid, name: a.full_name, team: a.team, position: a.position, age: a.age,
      is_rookie: a.confidence.is_rookie, has_draft: !!draft, draft_pick: draft?.pick ?? null,
      v2_expected_games: a.availability.expected_games, v3_expected_games: b.availability.expected_games,
      v2_opportunity: r2(opp(a)), v3_opportunity: r2(opp(b)),
      v2_points: a.neutral_points, v3_points: b.neutral_points, delta,
      delta_pct: a.neutral_points > 0 ? r2((delta / a.neutral_points) * 100) : null,
      primary_reason:
        Math.abs(delta) < 0.5 ? "unchanged"
          : draft && a.confidence.is_rookie ? "draft_capital_rookie_prior"
            : "team_pool_redistribution",
    });
  }
  rows.sort((x, y) => x.delta - y.delta);
  const headers = Object.keys(rows[0]!) as (keyof Row)[];
  writeFileSync(
    join(OUT, "phase3_2026_uncertain_role_audit.csv"),
    [headers.join(","), ...rows.map((r) => headers.map((h) => (r[h] == null ? "" : String(r[h]))).join(","))].join("\n") + "\n",
  );

  const changed = rows.filter((r) => Math.abs(r.delta) >= 0.5);
  const rookieChanged = changed.filter((r) => r.primary_reason === "draft_capital_rookie_prior");
  const teammates = changed.filter((r) => r.primary_reason === "team_pool_redistribution");
  console.log(`  players materially changed: ${changed.length}  (rookies ${rookieChanged.length}, redistributed teammates ${teammates.length})`);

  // ---- per-team redistribution: rookie gains vs incumbent losses + conservation
  const teams = [...new Set(rows.map((r) => r.team).filter(Boolean))] as string[];
  const rdRows = teams.map((team) => {
    const tr = rows.filter((r) => r.team === team);
    const rookieGain = tr.filter((r) => r.primary_reason === "draft_capital_rookie_prior").reduce((s, r) => s + Math.max(0, r.delta), 0);
    const rookieDrop = tr.filter((r) => r.primary_reason === "draft_capital_rookie_prior").reduce((s, r) => s + Math.min(0, r.delta), 0);
    const incLoss = tr.filter((r) => r.primary_reason === "team_pool_redistribution" && r.delta < 0).reduce((s, r) => s + r.delta, 0);
    const incGain = tr.filter((r) => r.primary_reason === "team_pool_redistribution" && r.delta > 0).reduce((s, r) => s + r.delta, 0);
    const v2opp = tr.reduce((s, r) => s + r.v2_opportunity, 0);
    const v3opp = tr.reduce((s, r) => s + r.v3_opportunity, 0);
    const biggestInc = tr.filter((r) => r.primary_reason === "team_pool_redistribution").sort((x, y) => x.delta - y.delta)[0];
    return {
      team,
      rookies_with_draft_prior: tr.filter((r) => r.primary_reason === "draft_capital_rookie_prior").length,
      rookie_pts_gain: r2(rookieGain), rookie_pts_drop: r2(rookieDrop),
      incumbent_pts_lost: r2(incLoss), incumbent_pts_gained: r2(incGain),
      team_opportunity_v2: r2(v2opp), team_opportunity_v3: r2(v3opp),
      team_opportunity_conserved_pct: v2opp > 0 ? r2((v3opp / v2opp) * 100) : null,
      biggest_incumbent_move: biggestInc ? `${biggestInc.name} ${biggestInc.delta}` : "",
      redistribution_capped: "prior clamped to observed rookie ceiling (WR<=9tgt/g, RB<=16car/g)",
    };
  }).filter((r) => r.rookies_with_draft_prior > 0 || Math.abs(r.incumbent_pts_lost) > 1);
  rdRows.sort((a, b) => a.incumbent_pts_lost - b.incumbent_pts_lost);
  const rh = Object.keys(rdRows[0]!) as string[];
  writeFileSync(
    join(OUT, "phase3_opportunity_redistribution_audit.csv"),
    [rh.join(","), ...rdRows.map((r) => rh.map((h) => `"${String((r as Record<string, unknown>)[h])}"`).join(","))].join("\n") + "\n",
  );

  const deltas = changed.map((r) => r.delta).sort((a, b) => a - b);
  const summary = {
    generated_at: new Date().toISOString(),
    parent: "ri-structural-2026.2", version: "ri-structural-2026.3",
    players: rows.length, materially_changed: changed.length,
    rookies_repriced: rookieChanged.length, redistributed_teammates: teammates.length,
    delta_p10: r2(q(deltas, 0.1)), delta_p50: r2(q(deltas, 0.5)), delta_p90: r2(q(deltas, 0.9)),
    max_rookie_increase: r2(Math.max(0, ...rookieChanged.map((r) => r.delta))),
    max_incumbent_decrease: r2(Math.min(0, ...teammates.map((r) => r.delta))),
    biggest_rookie_gains: rookieChanged.filter((r) => r.delta > 0).sort((a, b) => b.delta - a.delta).slice(0, 8)
      .map((r) => ({ name: r.name, pos: r.position, pick: r.draft_pick, delta: r.delta })),
    biggest_incumbent_losses: teammates.sort((a, b) => a.delta - b.delta).slice(0, 8)
      .map((r) => ({ name: r.name, pos: r.position, delta: r.delta })),
    team_conservation_ok: rdRows.every((r) => r.team_opportunity_conserved_pct == null || Math.abs(r.team_opportunity_conserved_pct - 100) < 3),
  };
  writeFileSync(join(OUT, "phase3_production_impact_summary.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
