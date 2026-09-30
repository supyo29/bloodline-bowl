/** Supabase adapter for the Role Calibration evidence tables. INSERT-ONLY + idempotent (conflict target = primary key). */
import type { SupabaseRest } from "@/lib/persistence/supabase/rest";
import type { RoleForecast } from "./types";
import type { RoleAnalysisRow } from "./analysis";

export const FORECAST_TABLE = "bridge_role_forecasts";
export const ANALYSIS_TABLE = "bridge_role_calibration_analysis";
const CHUNK = 100;
export interface WriteCounts { attempted: number; inserted: number; duplicate: number }

async function chunked(rest: SupabaseRest, table: string, rows: unknown[], conflict: string[]): Promise<WriteCounts> {
  let inserted = 0;
  for (let i = 0; i < rows.length; i += CHUNK) inserted += (await rest.insertIgnoreDuplicates<unknown>(table, rows.slice(i, i + CHUNK), conflict)).length;
  return { attempted: rows.length, inserted, duplicate: rows.length - inserted };
}
export const forecastRow = (f: RoleForecast) => ({ forecast_id: f.forecast_id, forecast_version: f.forecast_version, season: f.season, week: f.week, gsis_id: f.gsis_id, sleeper_id: f.sleeper_id, player_name: f.player_name, nfl_team: f.nfl_team, position: f.position, nfl_game_id: f.nfl_game_id, kickoff_at: f.kickoff_at, capture_kind: f.capture_kind, as_of_at: f.as_of_at, data_cutoff_at: f.data_cutoff_at, data_cutoff_week: f.data_cutoff_week, confidence: f.confidence, confidence_score: f.confidence_score, record: f });
export const writeForecasts = (rest: SupabaseRest, fs: readonly RoleForecast[]) => chunked(rest, FORECAST_TABLE, fs.map(forecastRow), ["forecast_id"]);
export const analysisRow = (a: RoleAnalysisRow) => ({ analysis_id: a.analysis_id, analysis_version: a.analysis_version, season: a.season, week: a.week, case_id: a.case_id, evidence_digest: a.evidence_digest, forecast_id: a.forecast_id, league_slug: a.league_slug, scoring_fingerprint: a.scoring_fingerprint, position: a.position, gsis_id: a.gsis_id, record: a });
export const writeAnalysis = (rest: SupabaseRest, rows: readonly RoleAnalysisRow[]) => chunked(rest, ANALYSIS_TABLE, rows.map(analysisRow), ["analysis_id"]);

export async function readForecasts(rest: SupabaseRest, season: number, week: number): Promise<RoleForecast[]> {
  const out: RoleForecast[] = [];
  for (let offset = 0; ; offset += 1000) {
    const rows = await rest.select<{ record: RoleForecast }>(FORECAST_TABLE, { filter: { season: `eq.${season}`, week: `eq.${week}` }, select: "record", order: "forecast_id.asc", limit: 1000, offset });
    out.push(...rows.map((r) => r.record));
    if (rows.length < 1000) break;
  }
  return out;
}
export async function readCurrentAnalysis(rest: SupabaseRest, season: number, week?: number): Promise<RoleAnalysisRow[]> {
  const out: RoleAnalysisRow[] = []; const f: Record<string, string> = { season: `eq.${season}` }; if (week != null) f.week = `eq.${week}`;
  for (let offset = 0; ; offset += 1000) {
    const rows = await rest.select<{ record: RoleAnalysisRow }>("bridge_role_calibration_current", { filter: f, select: "record", order: "case_id.asc", limit: 1000, offset });
    out.push(...rows.map((r) => r.record));
    if (rows.length < 1000) break;
  }
  return out;
}
