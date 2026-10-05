/**
 * Week runner. Reuses Phase 1 (ledger cases, games, scoring) and Phase 2 (role forecasts + analysis) and adds the simulation + distribution layer.
 *  - evaluateWeek   : a COMPLETED week, read-only: distributions for every player with a pregame role forecast scored against the ledger (models A/B/C/D)
 *  - captureLiveWeek: an UPCOMING week: freezes environment + player distribution records for games whose kickoff is still in the future
 */
import { loadNflGames, gameForTeam } from "@/lib/calibration/games";
import type { NflGame } from "@/lib/calibration/types";
import { readCurrentCases } from "@/lib/calibration/store";
import type { LeagueScoringInput } from "@/lib/calibration/case-builder";
import type { SupabaseRest } from "@/lib/persistence/supabase/rest";
import { loadFootballIntelligence } from "@/lib/football-intel";
import { loadObservedRoleGames } from "@/lib/role-calibration/data";
import { buildWeekForecasts } from "@/lib/role-calibration/forecast-week";
import { forecastsForWeek, materializeRoleAnalysis } from "@/lib/role-calibration/materialize";
import { selectForecast } from "@/lib/role-calibration/analysis";
import { forecastTeamVolume } from "@/lib/role-calibration/volume";
import type { RoleForecast, CaptureKind } from "@/lib/role-calibration/types";
import { qbChangedBefore } from "./fit";
import { buildDistributionAnalysis, type CaseExtra, type DistributionRow } from "./analysis";
import { decompose6 } from "./decompose";
import { buildGameEnvironment, buildPlayerDistributionRecord, type GameEnvironment, type PlayerDistributionRecord } from "./environment";
import { PoolSampler, loadEmpiricalPools } from "./pools";
import { GAME_DISTRIBUTION_MODEL_VERSION, loadPriors } from "./priors";
import { simulateGame, type GameSimResult, type PlayerSim } from "./simulate";
import { loadPositionYields } from "@/lib/role-calibration/data";
import type { WeatherSnapshot } from "@/lib/game-weather/capture";

export const DEFAULT_SIMS = 1000;
export function loadModelInputs(season: number) {
  const prior = season - 1; const priors = loadPriors(prior), pf = loadEmpiricalPools(prior);
  if (!priors || !pf) throw new Error(`Phase 3 priors/pools for ${prior} are missing (run scripts/game-distribution-fit.ts)`);
  return { priors, sampler: new PoolSampler(pf), prior };
}

/**
 * One forecast per player: the latest frozen strictly before that player's own kickoff (LIVE wins ties) — the same player-level rule as the Phase-1 ledger.
 * Without this, a player captured several times as injuries/depth changed would be simulated several times.
 */
export function latestForecastPerPlayer(forecasts: readonly RoleForecast[], games: readonly NflGame[], season: number, week: number): RoleForecast[] {
  const byKey = new Map<string, RoleForecast>();
  const keys = new Set(forecasts.map((f) => f.gsis_id ?? `s:${f.sleeper_id}`));
  for (const k of keys) {
    const any = forecasts.find((f) => (f.gsis_id ?? `s:${f.sleeper_id}`) === k)!; const g = gameForTeam(games, any.nfl_team); if (!g) continue;
    const pick = selectForecast(forecasts, any.gsis_id, any.sleeper_id, season, week, g.kickoff_at); if (pick) byKey.set(k, pick);
  }
  return [...byKey.values()];
}

export interface WeekSim { games: NflGame[]; sims: Map<string, GameSimResult>; simByGsis: Map<string, PlayerSim>; envs: GameEnvironment[]; forecasts: RoleForecast[] }
export function simulateWeek(a: { season: number; week: number; games: readonly NflGame[]; forecasts: readonly RoleForecast[]; sims: number; captureKind: CaptureKind; asOfAt: (g: NflGame) => string; weather?: ReadonlyMap<string, WeatherSnapshot>; onlyFutureAt?: number }): WeekSim {
  const { priors, sampler } = loadModelInputs(a.season); const observed = loadObservedRoleGames(); const fi = loadFootballIntelligence();
  const forecastsOne = latestForecastPerPlayer(a.forecasts, a.games, a.season, a.week);
  const sims = new Map<string, GameSimResult>(), simByGsis = new Map<string, PlayerSim>(), envs: GameEnvironment[] = [];
  for (const g of a.games) {
    if (a.onlyFutureAt != null && !(a.onlyFutureAt < Date.parse(g.kickoff_at))) continue;
    const fa = forecastsOne.filter((f) => f.nfl_team === g.home_team), fb = forecastsOne.filter((f) => f.nfl_team === g.away_team);
    if (!fa.length && !fb.length) continue;
    const qbChange = { a: qbChangedBefore(observed, g.home_team, a.season, a.week), b: qbChangedBefore(observed, g.away_team, a.season, a.week) };
    const res = simulateGame({ season: a.season, week: a.week, game_id: g.nfl_game_id, a: { team: g.home_team, forecasts: fa }, b: { team: g.away_team, forecasts: fb } }, sampler, priors, { sims: a.sims, widenQbChange: true, qbChange });
    sims.set(g.nfl_game_id, res);
    for (const ps of res.players) if (ps.forecast.gsis_id) simByGsis.set(ps.forecast.gsis_id, ps);
    const vol = (t: string) => { const v = forecastTeamVolume(observed, t, a.season, a.week); return { games_used: v.games_used, pass: v.team_pass_att, rush: v.team_rush_att, rzp: v.team_rz_pass_att, rzr: v.team_rz_rush_att }; };
    const cutoffs = [...fa, ...fb].map((f) => f.data_cutoff_at).filter((x): x is string => !!x).sort();
    envs.push(buildGameEnvironment({ game: g, sim: res, observed, qbChange, teams: [g.home_team, g.away_team], weather: a.weather?.get(g.nfl_game_id) ?? null, fi, captureKind: a.captureKind, asOfAt: a.asOfAt(g), dataCutoffAt: cutoffs[cutoffs.length - 1] ?? null, firstForecasts: [vol(g.home_team), vol(g.away_team)] }));
  }
  return { games: [...a.games], sims, simByGsis, envs, forecasts: forecastsOne };
}

/** Read-only evaluation of a completed week against the Phase-1 ledger. */
export async function evaluateWeek(a: { season: number; week: number; rest: SupabaseRest; leagues: readonly LeagueScoringInput[]; sims?: number }) {
  const { priors, prior } = loadModelInputs(a.season);
  const sims = a.sims ?? DEFAULT_SIMS;
  const [{ games }, fw, cases] = await Promise.all([loadNflGames(a.season, a.week), forecastsForWeek(a.rest, a.season, a.week), readCurrentCases(a.rest, { season: a.season, week: a.week })]);
  const role = await materializeRoleAnalysis({ season: a.season, week: a.week, leagues: a.leagues, rest: a.rest, write: false, forecasts: fw.forecasts });
  const ws = simulateWeek({ season: a.season, week: a.week, games, forecasts: fw.forecasts, sims, captureKind: "AS_OF_RECONSTRUCTION", asOfAt: (g) => new Date(Date.parse(g.kickoff_at) - 3600_000).toISOString() });
  const extra = new Map<string, CaseExtra>(cases.map((c) => [c.case_id, { case_id: c.case_id, projected_std_dev: c.projected_std_dev, projected_floor: c.projected_floor, projected_ceiling: c.projected_ceiling, projection_artifact_kind: c.projection_artifact_kind }]));
  const raw = new Map(a.leagues.filter((l) => l.scoring_fingerprint && l.raw_scoring).map((l) => [l.scoring_fingerprint!, l.raw_scoring!]));
  // actual provider stat lines (football outcomes) for the TD / turnover decomposition
  const outcomes = new Map<string, Record<string, number>>();
  for (let offset = 0; ; offset += 1000) { const rows = await a.rest.select<{ provider_player_ids: Record<string, string>; raw_stats: Record<string, number> }>("bridge_calibration_football_outcomes", { filter: { season: `eq.${a.season}`, week: `eq.${a.week}` }, select: "provider_player_ids,raw_stats", order: "outcome_id.asc", limit: 1000, offset }); for (const r of rows) if (r.provider_player_ids?.sleeper_id) outcomes.set(r.provider_player_ids.sleeper_id, r.raw_stats); if (rows.length < 1000) break; }
  const observed = loadObservedRoleGames(); const yields = loadPositionYields(prior);
  const fByGsis = new Map(fw.forecasts.filter((f) => f.gsis_id).map((f) => [f.gsis_id!, f]));
  const statLine = (raw0: Record<string, number> | undefined) => raw0 ? ({ pass_att: raw0.pass_att ?? 0, pass_cmp: raw0.pass_cmp ?? 0, pass_yd: raw0.pass_yd ?? 0, pass_td: raw0.pass_td ?? 0, pass_int: raw0.pass_int ?? 0, pass_sack: raw0.pass_sack ?? 0, rush_att: raw0.rush_att ?? 0, rush_yd: raw0.rush_yd ?? 0, rush_td: raw0.rush_td ?? 0, rec_tgt: raw0.rec_tgt ?? 0, rec: raw0.rec ?? 0, rec_yd: raw0.rec_yd ?? 0, rec_td: raw0.rec_td ?? 0, fum_lost: raw0.fum_lost ?? 0 }) : null;
  const rows: DistributionRow[] = buildDistributionAnalysis({ roleRows: role.rows, cases: extra, sims: ws.sims, simByGsis: ws.simByGsis, priors, rawScoringByFingerprint: raw, decomp6: (r) => {
    const f = r.gsis_id ? fByGsis.get(r.gsis_id) : null; const row = observed.find((o) => o.gsis_id === r.gsis_id && o.season === r.season && o.week === r.week); const rs = raw.get(r.scoring_fingerprint);
    if (!f || !row || !rs || !yields || r.baseline_projection == null || r.actual_fantasy_points == null) return null;
    return decompose6({ pos: r.position, baseline: r.baseline_projection, actual: r.actual_fantasy_points, forecast: f, actualRow: row, actualLine: statLine(r.sleeper_id ? outcomes.get(r.sleeper_id) : undefined), yields, raw: rs });
  } });
  return { rows, roleRows: role.rows, envs: ws.envs, sims: ws.sims, simByGsis: ws.simByGsis, forecasts: fw, games, priors };
}
export { gameForTeam, GAME_DISTRIBUTION_MODEL_VERSION };
export type { PlayerDistributionRecord };
void buildPlayerDistributionRecord; void buildWeekForecasts;
