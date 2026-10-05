/** Held-out evaluation helpers for the prior-season fit: simulate a historical week and score every player's distribution against the actual stat line. */
import { linearCoefficients, scoreStats, N_STATS } from "./fast-score";
import { calibration, summarize, summarizeRecalibrated, pit, inverseLevel, type Scored } from "./dist";
import { mulberry32, seedFrom } from "./rng";
import { PoolSampler } from "./pools";
import { simulateGame } from "./simulate";
import type { CalibrationPriors } from "./priors";
import type { ObservedRow } from "@/lib/role-calibration/data";
import type { RoleForecast, RolePosition } from "@/lib/role-calibration/types";
import { parseCsv, num } from "@/lib/role-calibration/csv";

export const STD_PPR = { pass_yd: 0.04, pass_td: 4, pass_int: -2, rush_yd: 0.1, rush_td: 6, rec: 1, rec_yd: 0.1, rec_td: 6, fum_lost: -2 };
export interface HistStat { week: number; gsis: string; line: Record<string, number> }
export function parseHistoricalStats(text: string): HistStat[] {
  return parseCsv(text).map((r) => {
    const n = (k: string) => num(r[k]) ?? 0;
    return { week: Number(r.week), gsis: r.player_id!, line: { pass_att: n("attempts"), pass_cmp: n("completions"), pass_yd: n("passing_yards"), pass_td: n("passing_tds"), pass_int: n("passing_interceptions"), pass_sack: n("sacks_suffered"), rush_att: n("carries"), rush_yd: n("rushing_yards"), rush_td: n("rushing_tds"), rec_tgt: n("targets"), rec: n("receptions"), rec_yd: n("receiving_yards"), rec_td: n("receiving_tds"), fum_lost: n("rushing_fumbles_lost") + n("receiving_fumbles_lost") + n("sack_fumbles_lost") } };
  });
}
const STATS_ORDER = ["pass_att", "pass_cmp", "pass_yd", "pass_td", "pass_int", "pass_sack", "rush_att", "rush_yd", "rush_td", "rec_tgt", "rec", "rec_yd", "rec_td", "fum_lost"];
export const actualPoints = (line: Record<string, number> | undefined, coef: Float64Array): number => { if (!line) return 0; const v = new Float32Array(N_STATS); STATS_ORDER.forEach((k, i) => { v[i] = line[k] ?? 0; }); return scoreStats(v, 0, coef); };

/** Group a week's forecasts into games using the observed rows' game ids (historical weeks only). */
export function gamesOfWeek(observed: readonly ObservedRow[], season: number, week: number): Array<{ game_id: string; teams: [string, string] }> {
  const m = new Map<string, Set<string>>();
  for (const o of observed) if (o.season === season && o.week === week && o.game_id) (m.get(o.game_id) ?? m.set(o.game_id, new Set()).get(o.game_id)!).add(o.team);
  return [...m.entries()].filter(([, t]) => t.size === 2).map(([game_id, t]) => ({ game_id, teams: [...t].sort() as [string, string] }));
}

export interface WeekEval { week: number; scored: Array<Scored & { position: string; gsis: string; sim_mean: number; pit: number }> }
/** Materiality filter for calibration reporting: a point mass at 0 makes the interval of a near-zero player trivially 'cover' an actual 0. */
export const MATERIAL_MEAN_POINTS = 3;
export function evalHistoricalWeek(a: { season: number; week: number; forecasts: readonly RoleForecast[]; observed: readonly ObservedRow[]; stats: readonly HistStat[]; priors: CalibrationPriors; sampler: PoolSampler; sims: number; sigma_team: number; sigma_player: number; recal?: Record<string, number[]> | null }): WeekEval {
  const coefs: Record<string, Float64Array> = {}; for (const p of ["QB", "RB", "WR", "TE"] as RolePosition[]) coefs[p] = linearCoefficients(p, STD_PPR);
  const stat = new Map(a.stats.filter((s) => s.week === a.week).map((s) => [s.gsis, s.line]));
  const scored: WeekEval["scored"] = [];
  for (const g of gamesOfWeek(a.observed, a.season, a.week)) {
    const team = (t: string) => ({ team: t, forecasts: a.forecasts.filter((f) => f.week === a.week && f.nfl_team === t) });
    const res = simulateGame({ season: a.season, week: a.week, game_id: g.game_id, a: team(g.teams[0]), b: team(g.teams[1]) }, a.sampler, a.priors, { sims: a.sims, sigma_team: a.sigma_team, sigma_player: a.sigma_player, excludeWeek: a.week });
    for (const ps of res.players) {
      if (ps.forecast.confidence === "INSUFFICIENT_SAMPLE") continue;
      const pts = new Float64Array(a.sims); const coef = coefs[ps.forecast.position]!;
      for (let s = 0; s < a.sims; s++) pts[s] = scoreStats(ps.stats, s * N_STATS, coef);
      const actual = actualPoints(stat.get(ps.forecast.gsis_id ?? ""), coef);
      const raw = summarize(pts); const map = a.recal ? (a.recal[ps.forecast.position] ?? a.recal.ALL ?? null) : null; const sm = map ? summarizeRecalibrated(pts, map) : raw;
      const u = mulberry32(seedFrom("pit", a.season, a.week, ps.forecast.gsis_id ?? ""))();
      scored.push({ actual, quantiles: sm.quantiles, position: ps.forecast.position, gsis: ps.forecast.gsis_id ?? "", sim_mean: raw.mean, pit: map ? inverseLevel(map, pit(pts, actual, u)) : pit(pts, actual, u) });
    }
  }
  return { week: a.week, scored };
}
export const summarizeEval = (ws: readonly WeekEval[], minMean = MATERIAL_MEAN_POINTS) => calibration(ws.flatMap((w) => w.scored).filter((s) => s.sim_mean >= minMean));
