/**
 * Point-in-time weather evidence. Only a snapshot RETRIEVED strictly before kickoff counts (a forecast that existed
 * then, never retrospective weather). Nothing is manufactured: no eligible row -> null.
 */
import type { WeatherEvidence } from "./types";

export interface WeatherSnapshotRow {
  id: string; season: number; week: number; game_id: string | null; home_team: string; away_team: string;
  source_name: string | null; source_timestamp: string | null; retrieved_at: string;
  roof: string | null; temp: number | string | null; wind: number | string | null; weather_status: string | null; weather_risk_score: number | string | null;
}
const num = (v: unknown): number | null => (v == null || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);

export function selectPregameWeather(rows: readonly WeatherSnapshotRow[], game: { season: number; week: number; home_team: string; away_team: string; kickoff_at: string }): WeatherEvidence | null {
  const kickoff = Date.parse(game.kickoff_at);
  const eligible = rows
    .filter((r) => r.season === game.season && r.week === game.week && r.home_team === game.home_team && r.away_team === game.away_team)
    .filter((r) => { const t = Date.parse(r.retrieved_at); return Number.isFinite(t) && t < kickoff; })
    .sort((a, b) => Date.parse(b.retrieved_at) - Date.parse(a.retrieved_at) || (a.id < b.id ? -1 : 1));
  const r = eligible[0];
  if (!r) return null;
  return { snapshot_id: r.id, source_name: r.source_name, source_timestamp: r.source_timestamp, retrieved_at: r.retrieved_at, roof: r.roof, temp: num(r.temp), wind: num(r.wind), weather_status: r.weather_status, weather_risk_score: num(r.weather_risk_score) };
}
