/**
 * Vendor the Roster Intel K/DST projection snapshot for `ri-kicker-2026.1` /
 * `ri-defense-2026.1`.
 *
 *   npx tsx scripts/build-special-teams-snapshot.ts
 *
 * Reads the R pipeline's Bloodline K/DST model outputs and writes a small,
 * self-contained JSON the bridge ships (`lib/projections/data/special-teams-2026.json`).
 * The bridge NEVER hits the R pipeline at runtime — this snapshot is the frozen,
 * reproducible input. Re-run this to refresh coverage; commit the new JSON.
 *
 * Source (must exist locally):
 *   ~/rosterintel/services/r-api/outputs/bloodline_2026/k_rankings.csv
 *   ~/rosterintel/services/r-api/outputs/bloodline_2026/dst_rankings.csv
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const SRC = join(homedir(), "rosterintel/services/r-api/outputs/bloodline_2026");
const OUT = "lib/projections/data/special-teams-2026.json";

function parseCsv(text: string): Array<Record<string, string>> {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  const header = splitCsvLine(lines[0]!);
  return lines.slice(1).map((line) => {
    const cells = splitCsvLine(line);
    const row: Record<string, string> = {};
    header.forEach((h, i) => (row[h] = cells[i] ?? ""));
    return row;
  });
}
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (q) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out;
}
const num = (x: string | undefined): number | null => {
  if (x == null || x === "") return null;
  const v = Number(x);
  return Number.isFinite(v) ? v : null;
};
const str = (x: string | undefined): string | null => (x && x !== "" ? x : null);

const k = parseCsv(readFileSync(join(SRC, "k_rankings.csv"), "utf8"));
const d = parseCsv(readFileSync(join(SRC, "dst_rankings.csv"), "utf8"));
const k0 = k[0];
const d0 = d[0];
if (!k0 || !d0) throw new Error("empty source CSV");

const meta = {
  source: "rosterintel/services/r-api/outputs/bloodline_2026",
  source_files: ["k_rankings.csv", "dst_rankings.csv"],
  model_version: k0.model_version ?? "",
  scoring_version: k0.scoring_version ?? "",
  projection_as_of: k0.projection_as_of ?? "",
  depth_chart_as_of: k0.depth_chart_as_of ?? "",
  derived_at: k0.derived_at ?? "",
  season: Number(k0.season ?? "2026"),
  vendored_at: new Date().toISOString(),
};

const kickers = k.map((r) => ({
  team: r.team ?? "", name: r.player_name ?? "", sleeper_id: str(r.sleeper_id), gsis_id: str(r.gsis_id),
  depth_rank: num(r.depth_rank), depth_chart_role: str(r.depth_chart_role),
  role_confidence: str(r.role_confidence), projection_confidence: str(r.projection_confidence),
  projection_tier: str(r.projection_tier), projection_methodology: str(r.projection_methodology),
  current_status: str(r.current_status), injury_status: str(r.injury_status),
  current_depth_rank: num(r.current_depth_rank),
  fg_att: num(r.fg_attempts), fg_made: num(r.fg_made), fg_missed: num(r.fg_missed),
  xp_att: num(r.pat_attempts), xp_made: num(r.pat_made), xp_missed: num(r.pat_missed),
  projected_bloodline_points: num(r.projected_bloodline_points),
  floor_points: num(r.floor_points), ceiling_points: num(r.ceiling_points), median_points: num(r.median_points),
  replacement_points: num(r.replacement_points), market_adp: num(r.market_adp), search_rank: num(r.search_rank),
}));

const defenses = d.map((r) => ({
  team: r.team ?? "", name: r.player_name ?? "", player_key: r.player_key ?? "",
  projection_confidence: str(r.projection_confidence), projection_methodology: str(r.projection_methodology),
  projection_tier: str(r.projection_tier),
  projected_bloodline_points: num(r.projected_bloodline_points),
  floor_points: num(r.floor_points), ceiling_points: num(r.ceiling_points), median_points: num(r.median_points),
  replacement_points: num(r.replacement_points),
  sacks: num(r.sacks), sack_yards: num(r.sack_yards),
  interceptions: num(r.interceptions), interception_return_yards: num(r.interception_return_yards),
  forced_fumbles: num(r.forced_fumbles), fumble_recoveries: num(r.fumble_recoveries), fumble_return_yards: num(r.fumble_return_yards),
  safeties: num(r.safeties), blocked_kicks: num(r.blocked_kicks), blocked_kick_return_yards: num(r.blocked_kick_return_yards),
  defensive_touchdowns: num(r.defensive_touchdowns), special_teams_touchdowns: num(r.special_teams_touchdowns),
  kickoff_return_yards: num(r.kickoff_return_yards), punt_return_yards: num(r.punt_return_yards),
  fourth_down_stops: num(r.fourth_down_stops), forced_punts: num(r.forced_punts),
  points_allowed_points: num(r.points_allowed_points),
  market_adp: num(r.market_adp), search_rank: num(r.search_rank),
}));

mkdirSync("lib/projections/data", { recursive: true });
writeFileSync(OUT, JSON.stringify({ _meta: meta, kickers, defenses }, null, 1) + "\n");
console.log(`wrote ${OUT}`);
console.log(`  ${kickers.length} kickers, ${defenses.length} defenses`);
console.log(`  model ${meta.model_version}, projections as-of ${meta.projection_as_of}`);
