/**
 * DESCRIPTIVE weather-risk classification (conditions only) — explicitly NOT a fantasy-point adjustment. The eventual relationship is conditional
 * (weather x position x archetype x passing depth x kicking distance x roof) and needs accumulated LIVE samples; this label only records how severe the
 * pregame conditions looked. Domes are DOME_CONTROLLED; a retractable roof with unknown status keeps its outdoor reading but is flagged ROOF_STATUS_UNKNOWN.
 */
import type { RoofType } from "./stadiums";
export type WeatherRiskClass = "DOME_CONTROLLED" | "LOW" | "MODERATE" | "HIGH" | "UNKNOWN";
export interface RiskInput { roof: RoofType; temp_f: number | null; wind_mph: number | null; wind_gust_mph: number | null; precip_prob: number | null; short_forecast: string | null }
const c01 = (v: number): number => Math.min(1, Math.max(0, v));
export function weatherRisk(i: RiskInput): { risk_class: WeatherRiskClass; risk_score: number | null; flags: string[] } {
  if (i.roof === "dome") return { risk_class: "DOME_CONTROLLED", risk_score: 0, flags: [] };
  const flags: string[] = [];
  if (i.roof === "retractable") flags.push("ROOF_STATUS_UNKNOWN");
  if (i.temp_f == null && i.wind_mph == null && i.precip_prob == null) return { risk_class: "UNKNOWN", risk_score: null, flags };
  const wind = Math.max(i.wind_mph ?? 0, 0.6 * (i.wind_gust_mph ?? 0));
  const snowOrIce = /snow|sleet|freezing|ice/i.test(i.short_forecast ?? "");
  const comps = { wind: c01((wind - 10) / 20), precip: c01(((i.precip_prob ?? 0) - 30) / 50) * (snowOrIce ? 1.25 : 1), cold: i.temp_f == null ? 0 : c01((32 - i.temp_f) / 30), heat: i.temp_f == null ? 0 : c01((i.temp_f - 92) / 12) };
  const score = Math.round(Math.min(1, Math.max(...Object.values(comps))) * 100) / 100;
  if (comps.wind >= 0.5) flags.push("HIGH_WIND"); if (comps.precip >= 0.5) flags.push(snowOrIce ? "SNOW_OR_ICE_RISK" : "PRECIP_RISK"); if (comps.cold >= 0.5) flags.push("COLD"); if (comps.heat >= 0.5) flags.push("HEAT");
  return { risk_class: score < 0.25 ? "LOW" : score < 0.5 ? "MODERATE" : "HIGH", risk_score: score, flags };
}
