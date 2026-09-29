/** Supabase adapter for the calibration ledger. INSERT-ONLY + idempotent (conflict targets are the tables' real unique keys). */
import type { SupabaseRest } from "@/lib/persistence/supabase/rest";
import type { CalibrationCase, FootballOutcome, NflGame } from "./types";
import type { ExistingCaseHead } from "./case-builder";

export const CASE_TABLE = "bridge_calibration_cases";
export const OUTCOME_TABLE = "bridge_calibration_football_outcomes";
export const GAME_TABLE = "bridge_calibration_nfl_games";
const CHUNK = 200;
export interface WriteCounts { attempted: number; inserted: number; duplicate: number }

async function writeChunks(rest: SupabaseRest, table: string, rows: unknown[], conflict: string[]): Promise<WriteCounts> {
  let inserted = 0;
  for (let i = 0; i < rows.length; i += CHUNK) inserted += (await rest.insertIgnoreDuplicates<unknown>(table, rows.slice(i, i + CHUNK), conflict)).length;
  return { attempted: rows.length, inserted, duplicate: rows.length - inserted };
}
export const writeCases = (rest: SupabaseRest, cases: readonly CalibrationCase[]) => writeChunks(rest, CASE_TABLE, cases.map((c) => ({ ...c })), ["case_id", "evidence_digest"]);
export const writeFootballOutcomes = (rest: SupabaseRest, rows: readonly FootballOutcome[]) => writeChunks(rest, OUTCOME_TABLE, rows.map((o) => ({ ...o })), ["outcome_id"]);
export const writeGames = (rest: SupabaseRest, games: readonly NflGame[]) =>
  writeChunks(rest, GAME_TABLE, games.map((g) => ({ nfl_game_id: g.nfl_game_id, season: g.season, week: g.week, home_team: g.home_team, away_team: g.away_team, kickoff_at: g.kickoff_at, kickoff_source: g.kickoff_source, status: g.status, provenance: g.provenance })), ["nfl_game_id", "kickoff_at", "status"]);

/** Latest revision head per case_id for a week (used to decide skip / new revision). */
export async function readCaseHeads(rest: SupabaseRest, season: number, week: number): Promise<Map<string, ExistingCaseHead>> {
  const heads = new Map<string, ExistingCaseHead>();
  for (let offset = 0; ; offset += 1000) {
    const rows = await rest.select<{ case_id: string; evidence_digest: string; revision: number }>(CASE_TABLE, { filter: { season: `eq.${season}`, week: `eq.${week}` }, select: "case_id,evidence_digest,revision", order: "case_id.asc,revision.asc", limit: 1000, offset });
    for (const r of rows) heads.set(r.case_id, { evidence_digest: r.evidence_digest, revision: r.revision }); // ascending revision => last write wins = head
    if (rows.length < 1000) break;
  }
  return heads;
}

export async function readCurrentCases(rest: SupabaseRest, filter: { season: number; week?: number; league_slug?: string }): Promise<CalibrationCase[]> {
  const f: Record<string, string> = { season: `eq.${filter.season}` };
  if (filter.week != null) f.week = `eq.${filter.week}`;
  if (filter.league_slug) f.league_slug = `eq.${filter.league_slug}`;
  const all: CalibrationCase[] = [];
  for (let offset = 0; ; offset += 1000) {
    const rows = await rest.select<CalibrationCase>("bridge_calibration_cases_current", { filter: f, order: "case_id.asc", limit: 1000, offset });
    all.push(...rows);
    if (rows.length < 1000) break;
  }
  return all;
}
