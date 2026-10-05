/**
 * Game environment + player distribution RECORDS (the persisted, pregame artifacts). Pure given the simulation result.
 * Football Intelligence context is attached ONLY when the published FI snapshot's through_week is strictly before the target week (otherwise it would
 * contain the game being forecast); it is context, not a driver of the Phase-3 means.
 */
import { createHash } from "node:crypto";
import { summarize, summarizeRecalibrated, type DistSummary } from "./dist";
import { linearCoefficients, scoreStats, N_STATS, STAT_INDEX } from "./fast-score";
import { GAME_DISTRIBUTION_MODEL_VERSION, type CalibrationPriors } from "./priors";
import type { GameSimResult, PlayerSim } from "./simulate";
import type { FootballIntelligence } from "@/lib/football-intel";
import type { ObservedRow } from "@/lib/role-calibration/data";
import type { CaptureKind, ForecastConfidence } from "@/lib/role-calibration/types";
import type { NflGame } from "@/lib/calibration/types";
import type { WeatherSnapshot } from "@/lib/game-weather/capture";

const f64 = (a: Float32Array): Float64Array => Float64Array.from(a);
const pick = (d: DistSummary) => ({ mean: d.mean, sd: d.sd, p5: d.quantiles.p5!, p10: d.quantiles.p10!, p25: d.quantiles.p25!, p50: d.quantiles.p50!, p75: d.quantiles.p75!, p90: d.quantiles.p90!, p95: d.quantiles.p95! });
export type VolumeDist = ReturnType<typeof pick>;

export interface TeamEnvironment { team: string; opponent: string; games_current_season: number; games_used: number; qb_changed_last_game: boolean; volume: { pass_att: VolumeDist; rush_att: VolumeDist; rz_pass_att: VolumeDist; rz_rush_att: VolumeDist; plays: VolumeDist }; forecast_means: { pass_att: number | null; rush_att: number | null; rz_pass_att: number | null; rz_rush_att: number | null }; scenario_probabilities: Record<string, number>; confidence: ForecastConfidence }
export interface GameEnvironment {
  env_id: string; model_version: string; season: number; week: number; nfl_game_id: string; home_team: string; away_team: string; kickoff_at: string;
  capture_kind: CaptureKind; as_of_at: string; data_cutoff_at: string | null; sims: number; seed: number; constraint_violations: number;
  teams: [TeamEnvironment, TeamEnvironment];
  weather: { status: "CAPTURED_PREGAME" | "NOT_CAPTURED"; snapshot_id: string | null; risk_class: string | null; roof_type: string | null; temp_f: number | null; wind_mph: number | null; wind_gust_mph: number | null; precip_prob: number | null; hours_to_kickoff: number | null; flags: string[] };
  football_intelligence: { status: "USED_AS_CONTEXT" | "OMITTED_NOT_PREGAME" | "UNAVAILABLE"; version: string | null; through_week: number | null; teams: Record<string, unknown> | null; interactions: Record<string, unknown> | null };
  confidence: ForecastConfidence; notes: string[];
}

const FI_KEYS = ["off_pace_sec_play", "off_proe", "off_pass_epa", "off_rush_epa", "off_pressure_rate_allowed", "off_sack_rate_allowed", "off_rz_td_rate"], FI_DEF = ["def_pass_epa_allowed", "def_rush_epa_allowed", "def_pressure_rate", "def_success_allowed", "def_rz_td_rate_allowed"];
export function fiContext(fi: FootballIntelligence | null, week: number, season: number, a: string, b: string): GameEnvironment["football_intelligence"] {
  if (!fi) return { status: "UNAVAILABLE", version: null, through_week: null, teams: null, interactions: null };
  const m = fi.manifest;
  if (!(m.season === season && m.through_week < week)) return { status: "OMITTED_NOT_PREGAME", version: m.football_intelligence_version, through_week: m.through_week, teams: null, interactions: null };
  const team = (t: string) => { const p = fi.team(t); if (!p) return null; const o: Record<string, unknown> = {}; for (const k of FI_KEYS) o[k] = p.offense[k] ? { modeled: p.offense[k]!.modeled, pct: p.offense[k]!.league_percentile, confidence: p.offense[k]!.confidence } : null; for (const k of FI_DEF) o[k] = p.defense[k] ? { modeled: p.defense[k]!.modeled, pct: p.defense[k]!.league_percentile, confidence: p.defense[k]!.confidence } : null; return o; };
  const ix = (f: string, off: string, def: string) => { const r = fi.contextualMatchup(f, off, def) as { availability?: string; interaction_signal?: number | null; confidence?: string | null }; return r.availability === "NOT_AVAILABLE" ? null : { signal: r.interaction_signal ?? null, confidence: r.confidence ?? null }; };
  return { status: "USED_AS_CONTEXT", version: m.football_intelligence_version, through_week: m.through_week, teams: { [a]: team(a), [b]: team(b) }, interactions: { [`${a}_off_vs_${b}_def`]: { pass_epa: ix("pass_epa_vs_pass_defense", a, b), rush_epa: ix("rush_epa_vs_rush_defense", a, b), proe_pace: ix("proe_pace_vs_pass_funnel", a, b) }, [`${b}_off_vs_${a}_def`]: { pass_epa: ix("pass_epa_vs_pass_defense", b, a), rush_epa: ix("rush_epa_vs_rush_defense", b, a), proe_pace: ix("proe_pace_vs_pass_funnel", b, a) } } };
}

export function buildGameEnvironment(a: { game: NflGame; sim: GameSimResult; observed: readonly ObservedRow[]; qbChange: { a: boolean; b: boolean }; teams: [string, string]; weather: WeatherSnapshot | null; fi: FootballIntelligence | null; captureKind: CaptureKind; asOfAt: string; dataCutoffAt: string | null; firstForecasts: [{ games_used: number; pass: number | null; rush: number | null; rzp: number | null; rzr: number | null }, { games_used: number; pass: number | null; rush: number | null; rzp: number | null; rzr: number | null }] }): GameEnvironment {
  const { game, sim } = a;
  const tEnv = (i: 0 | 1): TeamEnvironment => {
    const t = sim.teams[i]!; const team = a.teams[i]; const opp = a.teams[1 - i]!;
    const cur = new Set(a.observed.filter((o) => o.team === team && o.season === game.season && o.week < game.week).map((o) => o.week)).size;
    const plays = new Float64Array(t.pass_att.length); for (let s = 0; s < plays.length; s++) plays[s] = t.pass_att[s]! + t.rush_att[s]!;
    const fm = a.firstForecasts[i]; const qbc = i === 0 ? a.qbChange.a : a.qbChange.b;
    return { team, opponent: opp, games_current_season: cur, games_used: fm.games_used, qb_changed_last_game: qbc,
      volume: { pass_att: pick(summarize(f64(t.pass_att))), rush_att: pick(summarize(f64(t.rush_att))), rz_pass_att: pick(summarize(f64(t.rz_pass))), rz_rush_att: pick(summarize(f64(t.rz_rush))), plays: pick(summarize(plays)) },
      forecast_means: { pass_att: fm.pass, rush_att: fm.rush, rz_pass_att: fm.rzp, rz_rush_att: fm.rzr }, scenario_probabilities: {}, confidence: cur < 3 || qbc ? "LOW" : "MEDIUM" };
  };
  const teams: [TeamEnvironment, TeamEnvironment] = [tEnv(0), tEnv(1)];
  const totalSims = Object.values(sim.scenario_counts).reduce((x, y) => x + y, 0) / 2;
  for (const k of Object.keys(sim.scenario_counts)) for (const t of teams) t.scenario_probabilities[k] = 0; // probabilities are pooled across both clubs' sampled scripts (labels are descriptive, post hoc)
  for (const [k, v] of Object.entries(sim.scenario_counts)) for (const t of teams) t.scenario_probabilities[k] = Math.round((v / (2 * totalSims)) * 1e4) / 1e4;
  const w = a.weather;
  const env_id = `ge:${createHash("sha256").update(JSON.stringify([GAME_DISTRIBUTION_MODEL_VERSION, game.nfl_game_id, a.captureKind, teams.map((t) => [t.team, t.volume.pass_att.mean, t.volume.rush_att.mean, t.qb_changed_last_game]), w?.snapshot_id ?? null, sim.seed, sim.sims])).digest("hex").slice(0, 24)}`;
  const conf: ForecastConfidence = teams.some((t) => t.confidence === "LOW") ? "LOW" : "MEDIUM";
  return { env_id, model_version: GAME_DISTRIBUTION_MODEL_VERSION, season: game.season, week: game.week, nfl_game_id: game.nfl_game_id, home_team: game.home_team, away_team: game.away_team, kickoff_at: game.kickoff_at, capture_kind: a.captureKind, as_of_at: a.asOfAt, data_cutoff_at: a.dataCutoffAt, sims: sim.sims, seed: sim.seed, constraint_violations: sim.constraint_violations, teams,
    weather: w ? { status: "CAPTURED_PREGAME", snapshot_id: w.snapshot_id, risk_class: w.risk_class, roof_type: w.roof_type, temp_f: w.temp_f, wind_mph: w.wind_mph, wind_gust_mph: w.wind_gust_mph, precip_prob: w.precip_prob, hours_to_kickoff: w.hours_to_kickoff, flags: w.flags } : { status: "NOT_CAPTURED", snapshot_id: null, risk_class: null, roof_type: null, temp_f: null, wind_mph: null, wind_gust_mph: null, precip_prob: null, hours_to_kickoff: null, flags: [] },
    football_intelligence: fiContext(a.fi, game.week, game.season, teams[0].team, teams[1].team), confidence: conf,
    notes: ["script labels are descriptive classifications of resampled prior-season games, not model inputs", "FI and weather are context only in this version: neither shifts a simulated mean (no validated as-of history to fit them on)"] };
}

export interface PlayerDistributionRecord {
  pd_id: string; model_version: string; mode: "SHADOW_ONLY"; season: number; week: number; gsis_id: string | null; sleeper_id: string | null; player_name: string | null; position: string; nfl_team: string | null; opponent_team: string | null;
  nfl_game_id: string; kickoff_at: string; capture_kind: CaptureKind; as_of_at: string; role_forecast_id: string; env_id: string | null; confidence: ForecastConfidence; sims: number; seed: number; pool_key: string;
  football: Record<string, { mean: number; p10: number; p50: number; p90: number }>; td_count_probabilities: { zero: number; one: number; two: number; three_plus: number }; p_zero_opportunity: number;
  fantasy: Record<string, { raw: DistSummary; recalibrated: DistSummary }>;
}
const FB_STATS = ["pass_att", "pass_yd", "pass_td", "pass_int", "rush_att", "rush_yd", "rush_td", "rec_tgt", "rec", "rec_yd", "rec_td"] as const;
export function buildPlayerDistributionRecord(a: { ps: PlayerSim; sims: number; seed: number; game: NflGame; env_id: string | null; captureKind: CaptureKind; asOfAt: string; leagues: ReadonlyArray<{ scoring_fingerprint: string | null; raw_scoring: Record<string, number> | null }>; priors: CalibrationPriors }): PlayerDistributionRecord {
  const f = a.ps.forecast; const n = a.sims;
  const football: PlayerDistributionRecord["football"] = {};
  for (const k of FB_STATS) { const col = new Float64Array(n); for (let s = 0; s < n; s++) col[s] = a.ps.stats[s * N_STATS + STAT_INDEX[k]]!; const d = summarize(col); football[k] = { mean: d.mean, p10: d.quantiles.p10!, p50: d.quantiles.p50!, p90: d.quantiles.p90! }; }
  let z = 0, o = 0, t2 = 0, t3 = 0, zeroOpp = 0;
  for (let s = 0; s < n; s++) { const b = s * N_STATS; const td = a.ps.stats[b + STAT_INDEX.pass_td]! + a.ps.stats[b + STAT_INDEX.rush_td]! + a.ps.stats[b + STAT_INDEX.rec_td]!; if (td === 0) z++; else if (td === 1) o++; else if (td === 2) t2++; else t3++; if (a.ps.stats[b + STAT_INDEX.rec_tgt]! + a.ps.stats[b + STAT_INDEX.rush_att]! + a.ps.stats[b + STAT_INDEX.pass_att]! === 0) zeroOpp++; }
  const fantasy: PlayerDistributionRecord["fantasy"] = {}; const recal = a.priors.recalibration.mapped[f.position] ?? a.priors.recalibration.mapped.ALL ?? null;
  for (const l of a.leagues) { if (!l.scoring_fingerprint || !l.raw_scoring || fantasy[l.scoring_fingerprint]) continue; const coef = linearCoefficients(f.position, l.raw_scoring); const pts = new Float64Array(n); for (let s = 0; s < n; s++) pts[s] = scoreStats(a.ps.stats, s * N_STATS, coef); fantasy[l.scoring_fingerprint] = { raw: summarize(pts), recalibrated: summarizeRecalibrated(pts, recal) }; }
  const opp = a.game.home_team === f.nfl_team ? a.game.away_team : a.game.home_team;
  const pd_id = `pd:${createHash("sha256").update(JSON.stringify([GAME_DISTRIBUTION_MODEL_VERSION, f.forecast_id, a.env_id, a.ps.pool_key, a.seed, n, football.rec_yd!.mean, football.rush_yd!.mean, football.pass_yd!.mean, a.captureKind])).digest("hex").slice(0, 24)}`;
  return { pd_id, model_version: GAME_DISTRIBUTION_MODEL_VERSION, mode: "SHADOW_ONLY", season: f.season, week: f.week, gsis_id: f.gsis_id, sleeper_id: f.sleeper_id, player_name: f.player_name, position: f.position, nfl_team: f.nfl_team, opponent_team: opp, nfl_game_id: a.game.nfl_game_id, kickoff_at: a.game.kickoff_at, capture_kind: a.captureKind, as_of_at: a.asOfAt, role_forecast_id: f.forecast_id, env_id: a.env_id, confidence: f.confidence, sims: n, seed: a.seed, pool_key: a.ps.pool_key, football, td_count_probabilities: { zero: Math.round((z / n) * 1e4) / 1e4, one: Math.round((o / n) * 1e4) / 1e4, two: Math.round((t2 / n) * 1e4) / 1e4, three_plus: Math.round((t3 / n) * 1e4) / 1e4 }, p_zero_opportunity: Math.round((zeroOpp / n) * 1e4) / 1e4, fantasy };
}
