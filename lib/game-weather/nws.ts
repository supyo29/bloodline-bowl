/** National Weather Service (api.weather.gov) client + PURE parsers. The forecast is whatever NWS published at retrieval time; nothing retrospective is used. */
export const NWS_USER_AGENT = "bloodline-bowl-calibration (https://bloodline-bowl-sleeper-bridge.vercel.app)";
export const NWS_HOURLY_HORIZON_HOURS = 156;

export interface HourlyPeriod { startTime: string; endTime: string; temperature: number; temperatureUnit: string; windSpeed: string; shortForecast: string; probabilityOfPrecipitation?: { value: number | null } }
export interface GridSeries { values: Array<{ validTime: string; value: number | null }> }

/** "5 to 10 mph" -> 10 (the upper bound: the conservative wind for a risk read); "12 mph" -> 12; unparseable -> null. */
export function parseWindMph(s: string | null | undefined): number | null {
  if (!s) return null; const nums = [...s.matchAll(/(\d+(?:\.\d+)?)/g)].map((m) => Number(m[1])); return nums.length ? Math.max(...nums) : null;
}
export const kmhToMph = (v: number): number => Math.round(v * 0.621371 * 10) / 10;
/** The hourly period containing the kickoff instant (startTime <= kickoff < endTime). */
export function pickPeriod(periods: readonly HourlyPeriod[], kickoffMs: number): HourlyPeriod | null {
  return periods.find((p) => Date.parse(p.startTime) <= kickoffMs && kickoffMs < Date.parse(p.endTime)) ?? null;
}
/** ISO-8601 "start/PT3H" (or P1DT6H) interval value containing tMs, from an NWS gridpoint series. */
export function gridValueAt(series: GridSeries | undefined, tMs: number): number | null {
  for (const v of series?.values ?? []) {
    const [start, dur] = v.validTime.split("/"); const s = Date.parse(start!); if (!Number.isFinite(s) || !dur) continue;
    const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?$/.exec(dur); if (!m) continue;
    const ms = ((Number(m[1] ?? 0) * 24 + Number(m[2] ?? 0)) * 60 + Number(m[3] ?? 0)) * 60_000;
    if (s <= tMs && tMs < s + ms) return v.value;
  }
  return null;
}
export interface NwsForecast { forecast_issued_at: string | null; source_url: string; period: HourlyPeriod; wind_gust_mph: number | null; precip_mm: number | null; raw: Record<string, unknown> }

async function getJson(url: string): Promise<{ properties?: Record<string, unknown> } | null> {
  const r = await fetch(url, { headers: { "User-Agent": NWS_USER_AGENT, Accept: "application/geo+json" }, cache: "no-store" }).catch(() => null);
  return r && r.ok ? ((await r.json()) as { properties?: Record<string, unknown> }) : null;
}
export async function fetchNwsForecast(lat: number, lon: number, kickoffMs: number): Promise<NwsForecast | null> {
  const pts = await getJson(`https://api.weather.gov/points/${lat},${lon}`);
  const hourlyUrl = pts?.properties?.forecastHourly as string | undefined, gridUrl = pts?.properties?.forecastGridData as string | undefined;
  if (!hourlyUrl) return null;
  const hourly = await getJson(hourlyUrl); const periods = (hourly?.properties?.periods ?? []) as HourlyPeriod[];
  const period = pickPeriod(periods, kickoffMs); if (!period) return null;
  const grid = gridUrl ? await getJson(gridUrl) : null;
  const gust = gridValueAt(grid?.properties?.windGust as GridSeries | undefined, kickoffMs), qpf = gridValueAt(grid?.properties?.quantitativePrecipitation as GridSeries | undefined, kickoffMs);
  return { forecast_issued_at: (hourly?.properties?.updateTime as string) ?? (hourly?.properties?.generatedAt as string) ?? null, source_url: hourlyUrl, period, wind_gust_mph: gust == null ? null : kmhToMph(gust), precip_mm: qpf, raw: { points_url: `https://api.weather.gov/points/${lat},${lon}`, grid_url: gridUrl ?? null, short_forecast: period.shortForecast, selected_period: period.startTime } };
}
