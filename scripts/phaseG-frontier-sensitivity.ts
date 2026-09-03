/**
 * PR #3 item 5 — replacement-frontier sensitivity.
 *
 * The weekly replacement level is now an explicit, configurable
 * `ReplacementFrontier` strategy (lib/weekly/replacement.ts) instead of an
 * unexplained `FA_CUSHION = 1` constant. This script runs the FULL weekly engine
 * for the three real target managers under every reasonable frontier choice and
 * reports whether the TOP waiver recommendations actually move.
 *
 *   npx tsx scripts/phaseG-frontier-sensitivity.ts [week]
 */

import { buildWeeklyIntelligence } from "../lib/weekly/intelligence";
import type { ReplacementFrontier } from "../lib/weekly/replacement";

const WEEK = Number(process.argv[2] ?? 1);

const TARGETS = [
  ["bloodline-bowl", "supyo29"],
  ["bloodline-bowl", "BijiMac"],
  ["devoted-to-the-game", "DarthMarker"],
] as const;

const FRONTIERS: Array<{ label: string; frontier: ReplacementFrontier }> = [
  { label: "best_available", frontier: { mode: "best_available" } },
  { label: "nth_best n=1 (DEFAULT)", frontier: { mode: "nth_best_available", n: 1 } },
  { label: "nth_best n=2", frontier: { mode: "nth_best_available", n: 2 } },
  { label: "nth_best n=3", frontier: { mode: "nth_best_available", n: 3 } },
  { label: "marginal_starter", frontier: { mode: "marginal_starter" } },
];

function topN<T>(a: T[], n: number): T[] {
  return a.slice(0, n);
}

async function main() {
  for (const [league, manager] of TARGETS) {
    console.log(`\n${"=".repeat(72)}\n${league} / ${manager} — week ${WEEK}\n${"=".repeat(72)}`);

    const rows: Array<{ label: string; top1: string; top1Net: number; top3: string[]; recCount: number }> = [];

    for (const { label, frontier } of FRONTIERS) {
      const r = await buildWeeklyIntelligence(league, manager, { week: WEEK, replacementFrontier: frontier });
      if (!r.intelligence) {
        console.log(`  ${label.padEnd(24)} -> ERROR ${r.code} ${r.detail}`);
        continue;
      }
      const recs = r.intelligence.waivers.recommendations;
      rows.push({
        label,
        top1: recs[0]?.add_name ?? "(none)",
        top1Net: recs[0]?.net_roster_gain ?? 0,
        top3: topN(recs, 3).map((x) => x.add_name),
        recCount: recs.length,
      });
    }

    for (const row of rows) {
      console.log(
        `  ${row.label.padEnd(24)} top1=${row.top1} (net ${row.top1Net.toFixed(1)})  ` +
          `top3=[${row.top3.join(", ")}]  recs=${row.recCount}`,
      );
    }

    // The "realistic available pool" family (best_available .. nth_best n=3) is
    // the apples-to-apples comparison. `marginal_starter` deliberately raises the
    // bar to the last true starter and is reported separately.
    const pool = rows.filter((r) => !r.label.includes("marginal_starter"));
    const distinctTop1 = new Set(pool.map((r) => r.top1));
    const defTop3 = pool.find((r) => r.label.includes("DEFAULT"))?.top3 ?? [];
    const setStable = pool.every(
      (r) => JSON.stringify([...r.top3].sort()) === JSON.stringify([...defTop3].sort()),
    );
    const marginal = rows.find((r) => r.label.includes("marginal_starter"));
    console.log(
      `\n  VERDICT (available-pool frontiers): top-1 ${distinctTop1.size === 1 ? "STABLE" : `reorders at the margin (${[...distinctTop1].join(" | ")})`}; ` +
        `top-3 SET ${setStable ? "STABLE" : "MOVES"}.` +
        `\n  marginal_starter (aggressive last-starter bar): top1=${marginal?.top1 ?? "n/a"}, ${marginal?.recCount ?? 0} recs — suppresses marginal streamers by design.`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
