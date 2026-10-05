/** Pure weather snapshot construction + pregame selection. Only a snapshot RETRIEVED strictly before kickoff can ever be used; nothing is retrofitted. */
import { createHash } from "node:crypto";
import { STADIUMS } from "./stadiums";
import { weatherRisk, type WeatherRiskClass } from "./risk";
import { parseWindMph, type NwsForecast } from "./nws";
import type { NflGame } from "@/lib/calibration/types";

export interface WeatherSnapshot {
  snapshot_id: string; season: number; week: number; nfl_game_id: string; home_team: string; away_team: string; kickoff_at: string;
  stadium: string; latitude: number; longitude: number; roof_type: "dome" | "retractable" | "outdoor"; roof_status: null;
  source: string; source_url: string | null; forecast_issued_at: string | null; retrieved_at: string; hours_to_kickoff: number;
  temp_f: number | null; wind_mph: number | null; wind_gust_mph: number | null; precip_prob: number | null; precip_mm: number | null; short_forecast: string | null;
  risk_class: WeatherRiskClass; risk_score: number | null; flags: string[]; raw: Record<string, unknown>;
}
export type SnapshotResult = { snapshot: WeatherSnapshot; skipped?: undefined } | { snapshot?: undefined; skipped: string };

export function buildWeatherSnapshot(game: NflGame, forecast: NwsForecast | null, retrievedAtIso: string): SnapshotResult {
  const stadium = STADIUMS[game.home_team];
  if (!stadium) return { skipped: "NO_STADIUM_FOR_HOME_TEAM" };
  if ((game.provenance as { espn_neutral_site?: boolean }).espn_neutral_site) return { skipped: "NEUTRAL_SITE_UNSUPPORTED" };
  const ko = Date.parse(game.kickoff_at), rt = Date.parse(retrievedAtIso);
  if (!(rt < ko)) return { skipped: "RETRIEVED_AT_OR_AFTER_KICKOFF" };
  const hours = Math.round(((ko - rt) / 3600_000) * 100) / 100;
  let temp: number | null = null, wind: number | null = null, gust: number | null = null, pp: number | null = null, mm: number | null = null, sf: string | null = null, issued: string | null = null, url: string | null = null, raw: Record<string, unknown> = {};
  if (stadium.roof !== "dome") {
    if (!forecast) return { skipped: "NO_FORECAST_AVAILABLE" };
    const p = forecast.period; temp = p.temperatureUnit === "F" ? p.temperature : Math.round((p.temperature * 9) / 5 + 32); wind = parseWindMph(p.windSpeed); gust = forecast.wind_gust_mph; pp = p.probabilityOfPrecipitation?.value ?? null; mm = forecast.precip_mm; sf = p.shortForecast; issued = forecast.forecast_issued_at; url = forecast.source_url; raw = forecast.raw;
    if (issued && !(Date.parse(issued) < ko)) return { skipped: "FORECAST_ISSUED_AT_OR_AFTER_KICKOFF" };
  } else raw = { note: "dome: conditions irrelevant; roof type only" };
  const risk = weatherRisk({ roof: stadium.roof, temp_f: temp, wind_mph: wind, wind_gust_mph: gust, precip_prob: pp, short_forecast: sf });
  const id = `gw:${createHash("sha256").update(JSON.stringify([game.nfl_game_id, issued, raw.selected_period ?? null, temp, wind, gust, pp, mm, sf, stadium.roof])).digest("hex").slice(0, 24)}`;
  return { snapshot: { snapshot_id: id, season: game.season, week: game.week, nfl_game_id: game.nfl_game_id, home_team: game.home_team, away_team: game.away_team, kickoff_at: game.kickoff_at, stadium: stadium.name, latitude: stadium.lat, longitude: stadium.lon, roof_type: stadium.roof, roof_status: null, source: stadium.roof === "dome" ? "stadium_registry" : "nws", source_url: url, forecast_issued_at: issued, retrieved_at: retrievedAtIso, hours_to_kickoff: hours, temp_f: temp, wind_mph: wind, wind_gust_mph: gust, precip_prob: pp, precip_mm: mm, short_forecast: sf, risk_class: risk.risk_class, risk_score: risk.risk_score, flags: risk.flags, raw } };
}

/** The latest snapshot RETRIEVED strictly before `asOfMs` AND kickoff — the only weather a pregame model may see. */
export function latestPregameWeather<T extends { retrieved_at: string; kickoff_at: string; snapshot_id: string }>(rows: readonly T[], asOfMs: number): T | null {
  const ok = rows.filter((r) => Date.parse(r.retrieved_at) < Date.parse(r.kickoff_at) && Date.parse(r.retrieved_at) <= asOfMs).sort((a, b) => Date.parse(b.retrieved_at) - Date.parse(a.retrieved_at) || (a.snapshot_id < b.snapshot_id ? -1 : 1));
  return ok[0] ?? null;
}
