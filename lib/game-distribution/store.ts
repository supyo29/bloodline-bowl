/** Supabase adapter for the Phase-3 evidence tables. INSERT-ONLY + idempotent (conflict target = primary key). Database constraints enforce as_of/retrieved < kickoff. */
import type { SupabaseRest } from "@/lib/persistence/supabase/rest";
import type { WeatherSnapshot } from "@/lib/game-weather/capture";
import type { GameEnvironment, PlayerDistributionRecord } from "./environment";
import type { DistributionRow } from "./analysis";

export const T_WEATHER = "bridge_game_weather_forecasts", T_ENV = "bridge_game_environment_forecasts", T_PD = "bridge_player_distribution_forecasts", T_ANALYSIS = "bridge_distribution_calibration_analysis";
export interface WriteCounts { attempted: number; inserted: number; duplicate: number }
async function chunked(rest: SupabaseRest, table: string, rows: unknown[], conflict: string, size = 50): Promise<WriteCounts> {
  let ins = 0; for (let i = 0; i < rows.length; i += size) ins += (await rest.insertIgnoreDuplicates<unknown>(table, rows.slice(i, i + size), [conflict])).length;
  return { attempted: rows.length, inserted: ins, duplicate: rows.length - ins };
}
export const weatherRow = (w: WeatherSnapshot) => ({ ...w });
export const writeWeather = (rest: SupabaseRest, ws: readonly WeatherSnapshot[]) => chunked(rest, T_WEATHER, ws.map(weatherRow), "snapshot_id");
export const envRow = (e: GameEnvironment) => ({ env_id: e.env_id, model_version: e.model_version, season: e.season, week: e.week, nfl_game_id: e.nfl_game_id, home_team: e.home_team, away_team: e.away_team, kickoff_at: e.kickoff_at, capture_kind: e.capture_kind, as_of_at: e.as_of_at, data_cutoff_at: e.data_cutoff_at, weather_snapshot_id: e.weather.snapshot_id, confidence: e.confidence, record: e });
export const writeEnvironments = (rest: SupabaseRest, es: readonly GameEnvironment[]) => chunked(rest, T_ENV, es.map(envRow), "env_id", 20);
export const pdRow = (p: PlayerDistributionRecord) => ({ pd_id: p.pd_id, model_version: p.model_version, season: p.season, week: p.week, gsis_id: p.gsis_id, sleeper_id: p.sleeper_id, position: p.position, nfl_game_id: p.nfl_game_id, kickoff_at: p.kickoff_at, capture_kind: p.capture_kind, as_of_at: p.as_of_at, role_forecast_id: p.role_forecast_id, env_id: p.env_id, confidence: p.confidence, sims: p.sims, seed: p.seed, record: p });
export const writePlayerDistributions = (rest: SupabaseRest, ps: readonly PlayerDistributionRecord[]) => chunked(rest, T_PD, ps.map(pdRow), "pd_id", 25);
export const analysisRow = (r: DistributionRow & { pd_id?: string | null }) => ({ da_id: r.da_id, model_version: r.model_version, season: r.season, week: r.week, case_id: r.case_id, evidence_digest: r.evidence_digest, pd_id: r.pd_id ?? null, league_slug: r.league_slug, scoring_fingerprint: r.scoring_fingerprint, position: r.position, gsis_id: r.gsis_id, record: r });
export const writeDistributionAnalysis = (rest: SupabaseRest, rs: readonly (DistributionRow & { pd_id?: string | null })[]) => chunked(rest, T_ANALYSIS, rs.map(analysisRow), "da_id", 50);

export async function readWeather(rest: SupabaseRest, season: number, week: number): Promise<WeatherSnapshot[]> {
  return rest.select<WeatherSnapshot>(T_WEATHER, { filter: { season: `eq.${season}`, week: `eq.${week}` }, order: "retrieved_at.desc", limit: 1000 });
}
export async function readCurrentDistributionAnalysis(rest: SupabaseRest, season: number, week?: number): Promise<DistributionRow[]> {
  const out: DistributionRow[] = []; const f: Record<string, string> = { season: `eq.${season}` }; if (week != null) f.week = `eq.${week}`;
  for (let offset = 0; ; offset += 500) { const rows = await rest.select<{ record: DistributionRow }>("bridge_distribution_calibration_current", { filter: f, select: "record", order: "case_id.asc", limit: 500, offset }); out.push(...rows.map((r) => r.record)); if (rows.length < 500) break; }
  return out;
}

export async function readExistingDistributions(rest: SupabaseRest, season: number, week: number): Promise<Array<{ pd_id: string; gsis_id: string | null; capture_kind: string; nfl_game_id: string }>> {
  const out: Array<{ pd_id: string; gsis_id: string | null; capture_kind: string; nfl_game_id: string }> = [];
  for (let offset = 0; ; offset += 1000) { const rows = await rest.select<{ pd_id: string; gsis_id: string | null; capture_kind: string; nfl_game_id: string }>(T_PD, { filter: { season: `eq.${season}`, week: `eq.${week}` }, select: "pd_id,gsis_id,capture_kind,nfl_game_id", order: "pd_id.asc", limit: 1000, offset }); out.push(...rows); if (rows.length < 1000) break; }
  return out;
}
