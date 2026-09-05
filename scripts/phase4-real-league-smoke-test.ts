/**
 * PHASE 4 — real-league, read-only discovery smoke test.
 *
 *   npx tsx scripts/phase4-real-league-smoke-test.ts
 *
 * Read-only: calls `discoverTrades` against the REAL registered leagues.
 * Nothing is mutated — discovery never proposes, submits, or persists a
 * trade; it only returns candidates.
 */
import { discoverTrades } from "../lib/trades/discovery/discover";

async function run(label: string, req: Parameters<typeof discoverTrades>[0]) {
  console.log(`\n=== ${label} ===`);
  try {
    const res = await discoverTrades(req);
    console.log(`status=${res.status} results=${res.results.length} evaluated=${res.search_metadata.packages_evaluated} generated=${res.search_metadata.packages_generated} pruned=${res.search_metadata.packages_pruned}`);
    for (const d of res.diagnostics) console.log(`  diagnostic: [${d.severity}] ${d.code}: ${d.message}`);
    for (const r of res.results.slice(0, 3)) {
      console.log(`  #${r.rank} [${r.shape}] my_gain=${r.my_gain} viability=${r.trade_viability}`);
      for (const t of r.transfers) console.log(`     ${t.from_manager_id} -> ${t.to_manager_id}: ${t.canonical_player_id}`);
      console.log(`     rationale: ${r.rationale.join(" | ")}`);
    }
  } catch (e) {
    console.log(`ERROR: ${(e as Error).message}`);
  }
}

async function main() {
  await run("Devoted to the Game / darthmarker — BEST_AVAILABLE", { league: "devoted-to-the-game", manager: "darthmarker", mode: "BEST_AVAILABLE", max_results: 5 });
  await run("Devoted to the Game / darthmarker — POSITIONAL_NEED RB", { league: "devoted-to-the-game", manager: "darthmarker", mode: "POSITIONAL_NEED", target_position: "RB", max_results: 5 });
  await run("Devoted to the Game / darthmarker — CONSOLIDATE", { league: "devoted-to-the-game", manager: "darthmarker", mode: "CONSOLIDATE", max_results: 5 });
  await run("Bloodline Bowl — BEST_AVAILABLE (manager: supyo29)", { league: "bloodline-bowl", manager: "supyo29", mode: "BEST_AVAILABLE", max_results: 5 });
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
