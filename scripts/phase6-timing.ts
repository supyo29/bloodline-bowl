/**
 * PHASE 6 §17/§18/§19/§20 — QB timing, TE timing, RB/WR sequencing, FLEX-first
 * value.
 *
 *   npx tsx scripts/phase6-timing.ts [--n 150]
 *
 * Controlled experiments: force ONE strategic decision (e.g. "take a QB in
 * round 2") and let the frozen D3 engine make every other pick, then compare
 * final-roster utility against the D3-natural baseline (no forcing) and
 * against alternative timings — under matched opponent seeds (paired). This
 * isolates the effect of the one decision instead of confounding it with
 * everything else the strategy also changes.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { FantasyPosition } from "@/lib/projections/schema";
import { overallPickNumber } from "@/lib/bridge/geometry";
import { buildContext, simulateDraft, round2, mean, type SimContext } from "./phase6-simulation";

const OUT = join("outputs", "projections-2026");
const csv = (rows: Array<Record<string, unknown>>): string => {
  if (rows.length === 0) return "\n";
  const keys = Object.keys(rows[0]!);
  return [keys.join(","), ...rows.map((r) => keys.map((k) => {
    const v = r[k]; const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(","))].join("\n") + "\n";
};
function percentile(xs: number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))));
  return s[i]!;
}

function runScenario(
  ctx: SimContext, slot: number, label: string, N: number, seedBase: number,
  forcedPositions?: Map<number, FantasyPosition>,
): Record<string, unknown> {
  const utils: number[] = [];
  const opens: number[] = [];
  for (let i = 0; i < N; i++) {
    const r = simulateDraft(ctx, slot, "D3_frozen_engine", seedBase + i, { forcedPositions });
    utils.push(r.utility.utility);
    opens.push(r.open_starter_slots);
  }
  return {
    scenario: label, n: N,
    final_utility_p20: round2(percentile(utils, 20)),
    final_utility_p50: round2(percentile(utils, 50)),
    final_utility_p80: round2(percentile(utils, 80)),
    final_utility_mean: round2(mean(utils)),
    viable_roster_rate: round2(opens.filter((x) => x === 0).length / N),
  };
}

async function main(): Promise<void> {
  const nArg = process.argv.find((a) => a.startsWith("--n"));
  const N = nArg ? Number(nArg.split("=")[1] ?? process.argv[process.argv.indexOf(nArg) + 1]) : 150;
  mkdirSync(OUT, { recursive: true });
  console.log("Building context…");
  const ctx = await buildContext();

  const SLOT = 7; // Supyo29's real, representative middle slot
  const overallAt = (round: number) => overallPickNumber(SLOT, round, ctx.numTeams, "snake");

  // ---- §17 QB timing ----------------------------------------------
  console.log("\n[QB timing]");
  const qbRows = [
    runScenario(ctx, SLOT, "D3 natural (no forcing)", N, 100000),
    runScenario(ctx, SLOT, "Elite QB round 2", N, 100000, new Map([[overallAt(2), "QB"]])),
    runScenario(ctx, SLOT, "Middle-tier QB round 6", N, 100000, new Map([[overallAt(6), "QB"]])),
    runScenario(ctx, SLOT, "Late QB round 10", N, 100000, new Map([[overallAt(10), "QB"]])),
  ];
  qbRows.forEach((r) => console.log(`  ${r.scenario}: median ${r.final_utility_p50}, mean ${r.final_utility_mean}, viable ${(r.viable_roster_rate as number) * 100}%`));
  writeFileSync(join(OUT, "phase6_qb_timing.csv"), csv(qbRows));

  // ---- §18 TE timing ------------------------------------------------
  console.log("\n[TE timing]");
  const teRows = [
    runScenario(ctx, SLOT, "D3 natural (no forcing)", N, 200000),
    runScenario(ctx, SLOT, "Elite TE round 1", N, 200000, new Map([[overallAt(1), "TE"]])),
    runScenario(ctx, SLOT, "Middle-tier TE round 5", N, 200000, new Map([[overallAt(5), "TE"]])),
    runScenario(ctx, SLOT, "Late TE round 11", N, 200000, new Map([[overallAt(11), "TE"]])),
  ];
  teRows.forEach((r) => console.log(`  ${r.scenario}: median ${r.final_utility_p50}, mean ${r.final_utility_mean}, viable ${(r.viable_roster_rate as number) * 100}%`));
  writeFileSync(join(OUT, "phase6_te_timing.csv"), csv(teRows));

  // ---- §19 RB/WR opening sequencing ---------------------------------
  console.log("\n[RB/WR sequencing]");
  const seqRows = [
    runScenario(ctx, SLOT, "D3 natural (no forcing)", N, 300000),
    runScenario(ctx, SLOT, "RB-RB (forced picks 1-2)", N, 300000, new Map([[overallAt(1), "RB"], [overallAt(2), "RB"]])),
    runScenario(ctx, SLOT, "RB-WR (forced picks 1-2)", N, 300000, new Map([[overallAt(1), "RB"], [overallAt(2), "WR"]])),
    runScenario(ctx, SLOT, "WR-RB (forced picks 1-2)", N, 300000, new Map([[overallAt(1), "WR"], [overallAt(2), "RB"]])),
    runScenario(ctx, SLOT, "WR-WR (forced picks 1-2)", N, 300000, new Map([[overallAt(1), "WR"], [overallAt(2), "WR"]])),
    runScenario(ctx, SLOT, "WR-WR-WR (forced picks 1-3)", N, 300000, new Map([[overallAt(1), "WR"], [overallAt(2), "WR"], [overallAt(3), "WR"]])),
    runScenario(ctx, SLOT, "RB-WR-WR (forced picks 1-3)", N, 300000, new Map([[overallAt(1), "RB"], [overallAt(2), "WR"], [overallAt(3), "WR"]])),
    runScenario(ctx, SLOT, "WR-RB-RB (forced picks 1-3)", N, 300000, new Map([[overallAt(1), "WR"], [overallAt(2), "RB"], [overallAt(3), "RB"]])),
  ];
  seqRows.forEach((r) => console.log(`  ${r.scenario}: median ${r.final_utility_p50}, mean ${r.final_utility_mean}, viable ${(r.viable_roster_rate as number) * 100}%`));
  writeFileSync(join(OUT, "phase6_position_sequence.csv"), csv(seqRows));

  // ---- §20 FLEX-first value (RB4/WR4 vs QB1 at the same pick) -------
  console.log("\n[FLEX-first value]");
  const flexRows = [
    runScenario(ctx, SLOT, "Round 4: take best RB (4th skill pick)", N, 400000, new Map([[overallAt(4), "RB"]])),
    runScenario(ctx, SLOT, "Round 4: take best WR (4th skill pick)", N, 400000, new Map([[overallAt(4), "WR"]])),
    runScenario(ctx, SLOT, "Round 4: take QB1", N, 400000, new Map([[overallAt(4), "QB"]])),
    runScenario(ctx, SLOT, "Round 8: take best RB", N, 400000, new Map([[overallAt(8), "RB"]])),
    runScenario(ctx, SLOT, "Round 8: take best WR", N, 400000, new Map([[overallAt(8), "WR"]])),
    runScenario(ctx, SLOT, "Round 8: take QB1", N, 400000, new Map([[overallAt(8), "QB"]])),
  ];
  flexRows.forEach((r) => console.log(`  ${r.scenario}: median ${r.final_utility_p50}, mean ${r.final_utility_mean}`));
  writeFileSync(join(OUT, "phase6_flex_analysis.csv"), csv(flexRows));

  console.log("\nwrote phase6_qb_timing.csv, phase6_te_timing.csv, phase6_position_sequence.csv, phase6_flex_analysis.csv");
}

main().catch((e) => { console.error(e); process.exit(1); });
