/**
 * Phase-3 materialization: (1) LIVE capture of pregame weather + environment + player distributions for games whose kickoff is still ahead;
 * (2) persist a completed week's labeled reconstruction + analysis. Insert-only, idempotent (content-addressed ids), DB-enforced as_of < kickoff.
 */
import { createHash } from "node:crypto";
import { gameForTeam, loadNflGames } from "@/lib/calibration/games";
import type { LeagueScoringInput } from "@/lib/calibration/case-builder";
import type { NflGame } from "@/lib/calibration/types";
import type { SupabaseRest } from "@/lib/persistence/supabase/rest";
import { defaultWeeklyAuditRest } from "@/lib/persistence/supabase/weekly-audit-store";
import { buildWeekForecasts } from "@/lib/role-calibration/forecast-week";
import { writeForecasts } from "@/lib/role-calibration/store";
import { buildWeatherSnapshot, latestPregameWeather, type WeatherSnapshot } from "@/lib/game-weather/capture";
import { fetchNwsForecast } from "@/lib/game-weather/nws";
import { STADIUMS } from "@/lib/game-weather/stadiums";
import { buildPlayerDistributionRecord, type PlayerDistributionRecord } from "./environment";
import { evaluateWeek, loadModelInputs, simulateWeek, DEFAULT_SIMS } from "./run-week";
import { readExistingDistributions, readWeather, writeDistributionAnalysis, writeEnvironments, writePlayerDistributions, writeWeather, type WriteCounts } from "./store";
import { seedFrom } from "./rng";
import { GAME_DISTRIBUTION_MODEL_VERSION } from "./priors";
import type { RoleForecast } from "@/lib/role-calibration/types";

export interface LiveSummary { season: number; week: number; games_total: number; games_future: number; weather: { attempted: number; captured: number; skipped: Record<string, number>; write: WriteCounts | null }; role_forecasts: { built: number; write: WriteCounts | null }; environments: { built: number; write: WriteCounts | null }; player_distributions: { built: number; write: WriteCounts | null } }

export async function captureWeatherForGames(games: readonly NflGame[], nowMs: number): Promise<{ snapshots: WeatherSnapshot[]; skipped: Record<string, number> }> {
  const snapshots: WeatherSnapshot[] = []; const skipped: Record<string, number> = {};
  for (const g of games) {
    if (!(nowMs < Date.parse(g.kickoff_at))) { skipped.AFTER_KICKOFF = (skipped.AFTER_KICKOFF ?? 0) + 1; continue; }
    const st = STADIUMS[g.home_team];
    const fc = st && st.roof !== "dome" && !(g.provenance as { espn_neutral_site?: boolean }).espn_neutral_site ? await fetchNwsForecast(st.lat, st.lon, Date.parse(g.kickoff_at)).catch(() => null) : null;
    const r = buildWeatherSnapshot(g, fc, new Date(nowMs).toISOString());
    if (r.snapshot) snapshots.push(r.snapshot); else skipped[r.skipped] = (skipped[r.skipped] ?? 0) + 1;
  }
  return { snapshots, skipped };
}

/** LIVE forward capture for an UPCOMING week. Per-game freeze: only games whose kickoff is still in the future are captured. */
export async function captureLiveWeek(a: { season: number; week: number; leagues: readonly LeagueScoringInput[]; rest?: SupabaseRest | null; write: boolean; sims?: number; nowMs?: number }): Promise<LiveSummary> {
  const now = a.nowMs ?? Date.now(); const sims = a.sims ?? DEFAULT_SIMS; const { priors } = loadModelInputs(a.season);
  const { games } = await loadNflGames(a.season, a.week); const future = games.filter((g) => now < Date.parse(g.kickoff_at));
  const rest = a.write ? a.rest ?? defaultWeeklyAuditRest() : null; if (a.write && !rest) throw new Error("game distribution capture requires Supabase configuration");
  const wx = await captureWeatherForGames(future, now);
  const wWrite = rest ? await writeWeather(rest, wx.snapshots) : null;
  // the freshest PREGAME weather per game (this capture's snapshot, else anything already recorded before kickoff)
  const stored = rest ? await readWeather(rest, a.season, a.week).catch(() => [] as WeatherSnapshot[]) : [];
  const wxByGame = new Map<string, WeatherSnapshot>();
  for (const g of future) { const pick = latestPregameWeather([...wx.snapshots, ...stored].filter((w) => w.nfl_game_id === g.nfl_game_id), now); if (pick) wxByGame.set(g.nfl_game_id, pick); }
  const fw = await buildWeekForecasts({ season: a.season, week: a.week, captureKind: "LIVE_CAPTURED", games, nowMs: now });
  const roleWrite = rest ? await writeForecasts(rest, fw.forecasts) : null;
  const ws = simulateWeek({ season: a.season, week: a.week, games: future, forecasts: fw.forecasts, sims, captureKind: "LIVE_CAPTURED", asOfAt: () => new Date(now).toISOString(), weather: wxByGame, onlyFutureAt: now });
  const envWrite = rest ? await writeEnvironments(rest, ws.envs) : null;
  const envByGame = new Map(ws.envs.map((e) => [e.nfl_game_id, e]));
  const pds: PlayerDistributionRecord[] = [];
  for (const [gid, res] of ws.sims) { const g = games.find((x) => x.nfl_game_id === gid)!; const env = envByGame.get(gid) ?? null; for (const ps of res.players) { if (ps.forecast.confidence === "INSUFFICIENT_SAMPLE") continue; pds.push(buildPlayerDistributionRecord({ ps, sims, seed: res.seed, game: g, env_id: env?.env_id ?? null, captureKind: "LIVE_CAPTURED", asOfAt: new Date(now).toISOString(), leagues: a.leagues, priors })); } }
  const pdWrite = rest ? await writePlayerDistributions(rest, pds) : null;
  return { season: a.season, week: a.week, games_total: games.length, games_future: future.length, weather: { attempted: future.length, captured: wx.snapshots.length, skipped: wx.skipped, write: wWrite }, role_forecasts: { built: fw.forecasts.length, write: roleWrite }, environments: { built: ws.envs.length, write: envWrite }, player_distributions: { built: pds.length, write: pdWrite } };
}

/** Persist a COMPLETED week's labeled AS_OF_RECONSTRUCTION environments + player distributions + analysis rows (the Phase-3 bootstrap, like Phase 2's). */
export async function persistWeek(a: { rest: SupabaseRest; ev: Awaited<ReturnType<typeof evaluateWeek>>; leagues: readonly LeagueScoringInput[]; season: number; week: number; sims: number }) {
  const { priors } = loadModelInputs(a.season); const { ev } = a;
  const asOf = (g: NflGame) => new Date(Date.parse(g.kickoff_at) - 3600_000).toISOString();
  const missing = ev.forecasts.forecasts.filter((f) => f.capture_kind === "AS_OF_RECONSTRUCTION"); if (missing.length) await writeForecasts(a.rest, missing); // FK: role_forecast_id must exist
  // A game that already has a genuine LIVE capture keeps it: no reconstruction is written for it and the analysis links to the LIVE distribution.
  const existing = await readExistingDistributions(a.rest, a.season, a.week);
  const liveByGsis = new Map(existing.filter((e) => e.capture_kind === "LIVE_CAPTURED" && e.gsis_id).map((e) => [e.gsis_id!, e]));
  const liveGames = new Set(existing.filter((e) => e.capture_kind === "LIVE_CAPTURED").map((e) => e.nfl_game_id));
  const envs = ev.envs.filter((e) => !liveGames.has(e.nfl_game_id));
  const envWrite = await writeEnvironments(a.rest, envs);
  const envByGame = new Map(ev.envs.map((e) => [e.nfl_game_id, e]));
  const pds: PlayerDistributionRecord[] = []; const pdByGsis = new Map<string, string>();
  for (const [gid, res] of ev.sims) { const g = ev.games.find((x) => x.nfl_game_id === gid)!; for (const ps of res.players) { if (ps.forecast.confidence === "INSUFFICIENT_SAMPLE" || !ps.forecast.gsis_id) continue;
    const live = liveByGsis.get(ps.forecast.gsis_id); if (live) { pdByGsis.set(ps.forecast.gsis_id, live.pd_id); continue; }
    const rec = buildPlayerDistributionRecord({ ps, sims: a.sims, seed: res.seed, game: g, env_id: envByGame.get(gid)?.env_id ?? null, captureKind: "AS_OF_RECONSTRUCTION", asOfAt: asOf(g), leagues: a.leagues, priors }); pds.push(rec); pdByGsis.set(ps.forecast.gsis_id, rec.pd_id); } }
  const pdWrite = await writePlayerDistributions(a.rest, pds);
  const rows = ev.rows.map((r) => ({ ...r, pd_id: r.gsis_id ? pdByGsis.get(r.gsis_id) ?? null : null }));
  const daWrite = await writeDistributionAnalysis(a.rest, rows);
  return { environments: envWrite, player_distributions: pdWrite, analysis: daWrite, live_games_preserved: liveGames.size };
}
void createHash; void gameForTeam; void seedFrom; void GAME_DISTRIBUTION_MODEL_VERSION; export type { RoleForecast };
