/**
 * PHASE 3.5 COMPLETION — Part G §41: real-data correlation sanity check.
 *
 *   npx tsx scripts/phase35-real-correlation-check.ts
 *
 * This is NOT an outcome-validated ablation (that requires real historical
 * trade outcomes, of which this environment has none usable — see the
 * completion report). It IS a real correlation between two independently
 * R-produced real signals (usage target_share and schedule matchup_score)
 * joined by team+week+position across the full real 2025 season, reported
 * with its real sample size — the honest, currently-achievable slice of §41.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pearson, spearman } from "../lib/trades/calibration";

function parseCsv(text: string): Array<Record<string, string>> {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  const header = lines[0]!.split(",").map((h) => h.replace(/"/g, ""));
  return lines.slice(1).map((line) => {
    const cells: string[] = [];
    let cur = "", inQ = false;
    for (const c of line) {
      if (inQ) { if (c === '"') inQ = false; else cur += c; }
      else if (c === '"') inQ = true;
      else if (c === ",") { cells.push(cur); cur = ""; }
      else cur += c;
    }
    cells.push(cur);
    const row: Record<string, string> = {};
    header.forEach((h, i) => (row[h] = cells[i] ?? ""));
    return row;
  });
}

const OUT = join("lib", "trades", "data");
const usage = parseCsv(readFileSync(join(OUT, "player_usage_weekly.csv"), "utf8"));
const schedule = parseCsv(readFileSync(join(OUT, "player_schedule_strength_weekly.csv"), "utf8"));

const scheduleIndex = new Map<string, number>();
for (const r of schedule) {
  if (r.matchup_score) scheduleIndex.set(`${r.team}:${r.week}:${r.position}`, Number(r.matchup_score));
}

const targetShare: number[] = [];
const matchupScore: number[] = [];
const rushShare: number[] = [];
const matchupScoreForRush: number[] = [];
for (const r of usage) {
  const key = `${r.team}:${r.week}:${r.position}`;
  const ms = scheduleIndex.get(key);
  if (ms == null) continue;
  if (r.target_share) { targetShare.push(Number(r.target_share)); matchupScore.push(ms); }
  if (r.rush_share) { rushShare.push(Number(r.rush_share)); matchupScoreForRush.push(ms); }
}

console.log(`target_share x matchup_score: n=${targetShare.length}, pearson=${pearson(targetShare, matchupScore)}, spearman=${spearman(targetShare, matchupScore)}`);
console.log(`rush_share x matchup_score:   n=${rushShare.length}, pearson=${pearson(rushShare, matchupScoreForRush)}, spearman=${spearman(rushShare, matchupScoreForRush)}`);
console.log("\nInterpretation: this tests whether a player's OWN usage volume correlates with how favorable THAT WEEK'S matchup was — i.e. do coaches/usage patterns already track schedule ease. It does NOT test whether schedule predicts fantasy OUTCOME (that needs real trade/outcome data, absent here). A near-zero result here is expected and is not evidence against the schedule signal's future usefulness; a strong result would be a redundancy flag worth investigating before ever assigning it a weight.");
