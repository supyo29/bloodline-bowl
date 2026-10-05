/**
 * Prior-season fitting (pure functions; the driver script does the I/O). Everything here uses ONLY the prior season's as-of (pre-game) forecasts and
 * that season's completed games — never the season being evaluated.
 */
import { buildRoleForecast } from "@/lib/role-calibration/forecast";
import { forecastTeamVolume } from "@/lib/role-calibration/volume";
import type { InjuryRow, ObservedRow, ProfileRow } from "@/lib/role-calibration/data";
import type { RoleForecast, RolePosition } from "@/lib/role-calibration/types";
import { availabilityClass, magBin, poolKeys, recencyOf, tierOf, type CalibrationPriors, type RolePool, type RoleRow, type VolumeRatios } from "./priors";

export function primaryMetricValue(f: RoleForecast): number | null {
  return f.position === "QB" ? f.metrics.snap_share?.value ?? null : f.position === "RB" ? f.metrics.rush_share?.value ?? null : f.metrics.target_share?.value ?? null;
}

/** Historical as-of forecasts for every profiled skill player and target week. Teammate pressure is deliberately OFF (the propagation priors may include the prior season). */
export function buildHistoricalForecasts(a: { season: number; profiles: readonly ProfileRow[]; observed: readonly ObservedRow[]; injuries: readonly InjuryRow[]; weeks: readonly number[] }): RoleForecast[] {
  const out: RoleForecast[] = [];
  for (const w of a.weeks) {
    const prof = a.profiles.filter((p) => p.target_week === w && ["QB", "RB", "WR", "TE"].includes(p.position));
    for (const p of prof) {
      out.push(buildRoleForecast({ season: a.season, week: w, profile: p, teammates: [], observed: a.observed, injuries: a.injuries, depth: [], propagation: null, nflGameId: null, kickoffAt: null, asOfAt: `${a.season}-09-01T00:00:00.000Z`, captureKind: "AS_OF_RECONSTRUCTION", priorGameKickoff: () => null }));
    }
  }
  return out;
}

export function magCutpoints(forecasts: readonly RoleForecast[]): Record<RolePosition, [number, number]> {
  const out = {} as Record<RolePosition, [number, number]>;
  for (const pos of ["QB", "RB", "WR", "TE"] as const) {
    const v = forecasts.filter((f) => f.position === pos).map(primaryMetricValue).filter((x): x is number => x != null && x > 0).sort((x, y) => x - y);
    out[pos] = v.length >= 9 ? [v[Math.floor(v.length / 3)]!, v[Math.floor((2 * v.length) / 3)]!] : [0.1, 0.3];
  }
  return out;
}

const r4 = (x: number): number => Math.round(x * 1e4) / 1e4;
/** Role residual pools: actual - forecast per player-game, including the DNP outcome, stratified by confidence tier / availability class / magnitude. */
export function buildRolePools(forecasts: readonly RoleForecast[], observed: readonly ObservedRow[], season: number, cut: Record<RolePosition, [number, number]>): Record<string, RolePool> {
  const byKey = new Map<string, ObservedRow>();
  for (const o of observed) if (o.season === season) byKey.set(`${o.week}|${o.gsis_id}`, o);
  const pools: Record<string, RolePool> = {};
  const add = (key: string, row: RoleRow) => { (pools[key] ??= { n: 0, rows: [] }).rows.push(row); pools[key]!.n++; };
  for (const f of forecasts) {
    const pv = primaryMetricValue(f); if (pv == null || !f.gsis_id) continue;
    const o = byKey.get(`${f.week}|${f.gsis_id}`); const played = !!o && (o.offensive_snaps ?? 0) > 0;
    const d = (m: "snap_share" | "target_share" | "rush_share" | "rz_target_share" | "rz_carry_share", actual: number | null | undefined): number | null => { const fv = f.metrics[m]?.value; return played && fv != null && actual != null ? r4(actual - fv) : null; };
    const fdb = f.opportunity.dropbacks;
    const row: RoleRow = played && o ? {
      played: 1, d_snap: d("snap_share", o.snap_share), d_target: d("target_share", o.target_share), d_rush: d("rush_share", o.rush_share), d_rz_target: d("rz_target_share", o.rz_target_share), d_rz_carry: d("rz_carry_share", o.rz_carry_share),
      ratio_dropbacks: f.position === "QB" && fdb != null && fdb > 3 && o.dropbacks != null ? r4(Math.min(3, o.dropbacks / fdb)) : null,
      d_designed: f.position === "QB" && f.opportunity.designed_rushes != null && o.designed_rushes != null ? r4(o.designed_rushes - f.opportunity.designed_rushes) : null,
      d_scrambles: f.position === "QB" && f.opportunity.scrambles != null && o.qb_scrambles != null ? r4(o.qb_scrambles - f.opportunity.scrambles) : null,
    } : { played: 0, d_snap: null, d_target: null, d_rush: null, d_rz_target: null, d_rz_carry: null, ratio_dropbacks: null, d_designed: null, d_scrambles: null };
    const tier = tierOf(f.metrics[f.position === "QB" ? "snap_share" : f.position === "RB" ? "rush_share" : "target_share"]?.n_games_season ?? 0);
    const keys = poolKeys(f.position, availabilityClass(f.availability.designation), recencyOf(f), tier, magBin(pv, cut[f.position]));
    for (const k of keys) add(k, row); // every pool level is populated so the sampler can fall back to coarser levels
  }
  return pools;
}

export const QB_CHANGE_LOOKBACK = 2;
/** Did the team's starting QB (most dropbacks) change in the last completed game vs the one before it? Sourced from observed games only. */
export function starterQb(observed: readonly ObservedRow[], team: string, season: number, week: number): string | null {
  const rows = observed.filter((o) => o.team === team && o.season === season && o.week === week && o.position === "QB" && (o.dropbacks ?? 0) > 0).sort((a, b) => (b.dropbacks ?? 0) - (a.dropbacks ?? 0));
  return rows[0]?.gsis_id ?? null;
}
export function qbChangedBefore(observed: readonly ObservedRow[], team: string, season: number, week: number): boolean {
  const last = [...new Set(observed.filter((o) => o.team === team && (o.season < season || (o.season === season && o.week < week))).map((o) => `${o.season}|${o.week}`))].sort().slice(-QB_CHANGE_LOOKBACK);
  if (last.length < 2) return false;
  const [s1, w1] = last[0]!.split("|").map(Number) as [number, number], [s2, w2] = last[1]!.split("|").map(Number) as [number, number];
  const a = starterQb(observed, team, s1, w1), b = starterQb(observed, team, s2, w2);
  return a != null && b != null && a !== b;
}

const ratio = (actual: number | null, forecast: number | null, floor: number, lo: number, hi: number): number => (actual == null || forecast == null ? 1 : Math.min(hi, Math.max(lo, actual / Math.max(forecast, floor))));
export function buildTeamGamePairs(observed: readonly ObservedRow[], season: number, weeks: readonly number[]): CalibrationPriors["team_game_pairs"] {
  const out: CalibrationPriors["team_game_pairs"] = [];
  const games = new Map<string, Map<string, ObservedRow>>();
  for (const o of observed) if (o.season === season && weeks.includes(o.week) && o.game_id) { const m = games.get(o.game_id) ?? games.set(o.game_id, new Map()).get(o.game_id)!; if (!m.has(o.team)) m.set(o.team, o); }
  for (const [, m] of [...games.entries()].sort()) {
    if (m.size !== 2) continue;
    const [ta, tb] = [...m.keys()].sort(); const ra = m.get(ta!)!, rb = m.get(tb!)!;
    const vec = (r: ObservedRow): VolumeRatios | null => {
      const f = forecastTeamVolume(observed, r.team, season, r.week); if (f.games_used < 3) return null;
      return [r4(ratio(r.team_pass_att, f.team_pass_att, 5, 0.3, 2.5)), r4(ratio(r.team_rush_att, f.team_rush_att, 5, 0.3, 2.5)), r4(ratio(r.team_rz_pass_att, f.team_rz_pass_att, 1, 0, 4)), r4(ratio(r.team_rz_rush_att, f.team_rz_rush_att, 1, 0, 4))];
    };
    const a = vec(ra), b = vec(rb); if (!a || !b) continue;
    out.push({ week: ra.week, a, b, qb_change_a: qbChangedBefore(observed, ta!, season, ra.week), qb_change_b: qbChangedBefore(observed, tb!, season, rb.week) });
  }
  return out;
}

/** Dispersion (SD of log pass-attempt ratio) for teams whose QB changed vs all others — used to widen ONLY when the prior season supports it. */
export function regimeDispersion(pairs: CalibrationPriors["team_game_pairs"]): CalibrationPriors["regime"] {
  const chg: number[] = [], other: number[] = [];
  for (const p of pairs) { (p.qb_change_a ? chg : other).push(Math.log(p.a[0])); (p.qb_change_b ? chg : other).push(Math.log(p.b[0])); }
  const sd = (xs: number[]) => { if (xs.length < 2) return null; const m = xs.reduce((s, x) => s + x, 0) / xs.length; return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1)); };
  const a = sd(chg), b = sd(other);
  const ratioV = a != null && b != null && b > 0 ? r4(a / b) : null;
  return { qb_change_dispersion_ratio: ratioV, n_qb_change_games: chg.length, n_other_games: other.length, applied: ratioV != null && chg.length >= 30 && ratioV > 1.05 };
}
