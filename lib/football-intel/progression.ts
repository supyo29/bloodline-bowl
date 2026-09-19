/**
 * Receiver progression read adapter.
 *
 * Reads the additive DESCRIPTIVE_ONLY receiver_progression.csv artifact
 * published by the Football Intelligence refresh. Missing artifact or player
 * resolves to an empty array; nothing is fabricated.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ReceiverProgressionRow, ReceiverReadBucket } from "./schema";

const DATA_PATH = join(process.cwd(), "lib", "football-intel", "data", "receiver_progression.csv");

function parseCsv(text: string): Array<Record<string, string>> {
  const lines = text.split(/\r?\n/).filter((line) => line.length > 0);
  if (lines.length === 0) return [];

  const parseLine = (line: string): string[] => {
    const out: string[] = [];
    let cur = "";
    let quoted = false;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (quoted) {
        if (ch === '"' && line[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else if (ch === '"') {
          quoted = false;
        } else {
          cur += ch;
        }
      } else if (ch === '"') {
        quoted = true;
      } else if (ch === ",") {
        out.push(cur);
        cur = "";
      } else {
        cur += ch;
      }
    }
    out.push(cur);
    return out;
  };

  const header = parseLine(lines[0]!);
  return lines.slice(1).map((line) => {
    const cells = parseLine(line);
    return Object.fromEntries(header.map((key, i) => [key, cells[i] ?? ""]));
  });
}

const num = (value: string | undefined): number | null =>
  value == null || value === "" || !Number.isFinite(Number(value)) ? null : Number(value);

const str = (value: string | undefined): string | null =>
  value == null || value === "" ? null : value;

function allProgressionRows(): ReceiverProgressionRow[] {
  if (!existsSync(DATA_PATH)) return [];
  return parseCsv(readFileSync(DATA_PATH, "utf8")).map((r) => ({
    season: num(r.season) ?? 0,
    week: num(r.week) ?? 0,
    team: r.team ?? "",
    opponent: r.opponent ?? "",
    gsis_id: r.gsis_id ?? "",
    sleeper_id: str(r.sleeper_id),
    full_name: str(r.full_name),
    passer_gsis_id: str(r.passer_gsis_id),
    bucket: (r.bucket || "OTHER") as ReceiverReadBucket,
    targets: num(r.targets) ?? 0,
    target_read_share: num(r.target_read_share),
    receptions: num(r.receptions) ?? 0,
    receiving_yards: num(r.receiving_yards) ?? 0,
    yards_per_target: num(r.yards_per_target),
    air_yards: num(r.air_yards),
    adot: num(r.adot),
    yac: num(r.yac),
    epa_per_target: num(r.epa_per_target),
    success_rate: num(r.success_rate),
    first_down_rate: num(r.first_down_rate),
    explosive_rate: num(r.explosive_rate),
    receiving_tds: num(r.receiving_tds) ?? 0,
    td_rate: num(r.td_rate),
    targets_eligible: num(r.targets_eligible) ?? 0,
    targets_charted_read: num(r.targets_charted_read) ?? 0,
    read_coverage_rate: num(r.read_coverage_rate),
    output_class: "DESCRIPTIVE_ONLY",
    source: r.source ?? "nflverse_ftn",
    read_semantics: r.read_semantics ?? "",
  }));
}

export function receiverProgression(
  playerId: string,
  opts: { season?: number; week?: number } = {},
): ReceiverProgressionRow[] {
  return allProgressionRows().filter((row) =>
    (row.gsis_id === playerId || row.sleeper_id === playerId) &&
    (opts.season == null || row.season === opts.season) &&
    (opts.week == null || row.week === opts.week)
  );
}
