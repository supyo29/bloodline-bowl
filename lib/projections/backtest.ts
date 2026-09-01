/**
 * Genuine out-of-sample backtest for the Roster Intel projection core.
 *
 * FAIR-BACKTEST RULE: to project season Y we use ONLY seasons <= Y-1. No actual
 * from Y (or later) touches the projection — no team totals, no depth charts, no
 * "who ended up the starter" hindsight.
 *
 * SCOPE / HONEST LIMITATION: the full engine (`model.ts`) reallocates opportunity
 * across a team's *current* roster, which requires knowing the Y roster — that is
 * hindsight, so it is deliberately excluded here. What is backtested is the RI
 * CORE: recency-weighted opportunity -> shrunk efficiency -> regressed TD rate ->
 * availability -> points. This is the part of the model that carries the
 * projection philosophy; the team-reallocation layer is validated separately by
 * `reconcile.ts`, not here.
 *
 * SLEEPER HISTORICAL HEAD-TO-HEAD: Sleeper's stored historical projections are
 * timestamped end-of-season (verified: `last_modified` ~ January of Y+1), not
 * preseason, so a fair RI-vs-Sleeper-preseason comparison for past years is
 * impossible. This module reports that as
 * `SLEEPER PROJECTION BENCHMARK UNAVAILABLE (historical)` and does NOT fabricate
 * one.
 */

import type { FantasyPosition } from "./schema";
import type { PlayerSeasonActual, SeasonActuals } from "./actuals";
import {
  AVAILABILITY_FLOOR,
  GAMES_ATTRITION_HAIRCUT,
  POSITION_BASELINES,
  REGULAR_SEASON_GAMES,
  SHRINKAGE_K,
  ageMultiplier,
  opportunityAgeShade,
  shrink,
} from "./baselines";

export const SLEEPER_HISTORICAL_BENCHMARK_STATUS =
  "SLEEPER PROJECTION BENCHMARK UNAVAILABLE (historical) — Sleeper's stored past-season projections are end-of-season timestamped, not preseason; a fair preseason head-to-head cannot be constructed.";

/* --------------------------------------------- RI core (no team reallocation) */

function wRate(
  seasons: PlayerSeasonActual[],
  num: (s: PlayerSeasonActual) => number,
  den: (s: PlayerSeasonActual) => number,
  asOf: number,
): number {
  let wn = 0;
  let wd = 0;
  for (const s of seasons) {
    if (s.season > asOf) continue;
    const w = recencyByGap(asOf - s.season);
    wn += w * num(s);
    wd += w * den(s);
  }
  return wd > 0 ? wn / wd : 0;
}

/** recency weight purely by season gap, so the backtest can slide across years. */
function recencyByGap(gap: number): number {
  return [0.55, 0.3, 0.15, 0.06, 0.03][gap] ?? 0;
}

export interface CoreProjection {
  player_id: string;
  position: FantasyPosition;
  predicted_points: number;
}

export function projectCoreForSeason(
  playerId: string,
  position: FantasyPosition,
  age: number | null,
  priorSeasons: PlayerSeasonActual[],
  targetSeason: number,
): CoreProjection | null {
  const hist = priorSeasons
    .filter((s) => s.season < targetSeason && s.gp > 0)
    .sort((a, b) => b.season - a.season)
    .slice(0, 4);
  if (hist.length === 0) return null;

  const asOf = targetSeason - 1;
  const g = (s: PlayerSeasonActual) => Math.min(s.gp, REGULAR_SEASON_GAMES);
  const nEff = hist.reduce((a, s) => a + recencyByGap(asOf - s.season) * g(s), 0);
  const base = POSITION_BASELINES[position];
  const ageMul = ageMultiplier(position, age);

  const pg = (f: (s: PlayerSeasonActual) => number) => wRate(hist, f, g, asOf);

  const gamesRatio = wRate(hist, g, () => REGULAR_SEASON_GAMES, asOf); // weighted mean gp/17
  const availability = clamp(
    shrink(gamesRatio || base.availability, base.availability, nEff, SHRINKAGE_K.availability),
    AVAILABILITY_FLOOR, 0.985,
  );
  // Phase 2: subtract the preseason-unforeseeable attrition allowance (see
  // GAMES_ATTRITION_HAIRCUT in baselines.ts).
  const games = Math.max(1, REGULAR_SEASON_GAMES * availability - GAMES_ATTRITION_HAIRCUT);
  const oppShade = opportunityAgeShade(position, age);

  let pts = 0;
  if (position === "QB") {
    const patt = pg((s) => s.pass_att);
    const ypa = clamp(shrink(pg((s) => s.pass_yd) / (pg((s) => s.pass_att) || 1) || base.yards_per_att, base.yards_per_att, nEff, SHRINKAGE_K.yards_per_att), 5.6, 8.6) * ageMul;
    const tdRate = clamp(shrink(sum(hist, (s) => s.pass_td) / (sum(hist, (s) => s.pass_att) || 1), 0.045, nEff, 120), 0.028, 0.07);
    const intRate = clamp(shrink(sum(hist, (s) => s.pass_int) / (sum(hist, (s) => s.pass_att) || 1) || base.int_per_att, base.int_per_att, nEff, SHRINKAGE_K.int_rate), 0.014, 0.04);
    const ratt = pg((s) => s.rush_att);
    const rypc = clamp(shrink(pg((s) => s.rush_yd) / (pg((s) => s.rush_att) || 1) || 4.4, 4.4, nEff, SHRINKAGE_K.yards_per_carry), 2, 8);
    const rtdRate = clamp(shrink(sum(hist, (s) => s.rush_td) / (sum(hist, (s) => s.rush_att) || 1), 0.03, nEff, 80), 0, 0.12);
    pts = games * (
      patt * ypa * 0.04 + patt * tdRate * 4 - patt * intRate
      + ratt * rypc * 0.1 + ratt * rtdRate * 6
    );
  } else {
    // Phase 2: aging shows up in usage, not only efficiency — shade opportunity
    // for players 30+ (opportunityAgeShade).
    const tgt = pg((s) => s.targets) * oppShade;
    const cr = clamp(shrink(pg((s) => s.rec) / (pg((s) => s.targets) || 1) || base.catch_rate, base.catch_rate, nEff, SHRINKAGE_K.catch_rate), 0.4, 0.85);
    const ypt = clamp(shrink(pg((s) => s.rec_yd) / (pg((s) => s.targets) || 1) || base.yards_per_target, base.yards_per_target, nEff, SHRINKAGE_K.yards_per_target), 3, 13) * ageMul;
    const recTdRate = clamp(shrink(sum(hist, (s) => s.rec_td) / (sum(hist, (s) => s.rec_rz_tgt) || 1) || base.rec_td_per_rz_target, base.rec_td_per_rz_target, nEff, SHRINKAGE_K.rec_td_rate), 0.05, 0.45);
    const rzTgt = pg((s) => s.rec_rz_tgt) * oppShade;
    const carr = pg((s) => s.rush_att) * oppShade;
    const ypc = clamp(shrink(pg((s) => s.rush_yd) / (pg((s) => s.rush_att) || 1) || base.yards_per_carry, base.yards_per_carry, nEff, SHRINKAGE_K.yards_per_carry), 2.5, 6) * (position === "RB" ? ageMul : 1);
    const rushTdRate = clamp(shrink(sum(hist, (s) => s.rush_td) / (sum(hist, (s) => s.rush_rz_att) || 1) || base.rush_td_per_rz_carry, base.rush_td_per_rz_carry, nEff, SHRINKAGE_K.rush_td_rate), 0.04, 0.35);
    const rzCar = pg((s) => s.rush_rz_att) * oppShade;
    pts = games * (
      tgt * cr * 1 + tgt * ypt * 0.1 + rzTgt * recTdRate * 6
      + carr * ypc * 0.1 + rzCar * rushTdRate * 6
      - ((tgt * cr + carr) * base.fum_lost_per_touch) * 2
    );
  }

  return { player_id: playerId, position, predicted_points: round2(Math.max(0, pts)) };
}

/* --------------------------------------------------------- baselines + scoring */

export interface BacktestRow {
  player_id: string;
  position: FantasyPosition;
  target_season: number;
  actual_points: number;
  ri_core: number | null;
  bl_prev_points: number | null;
  bl_prev_ppg_x17: number | null;
  bl_3yr_weighted: number | null;
}

export interface BacktestMetrics {
  method: string;
  n: number;
  mae: number;
  rmse: number;
  bias: number;
  spearman: number;
  /** share of players where this method's error beat prev-year points */
  beat_prev_year_rate: number | null;
}

export function buildBacktestRows(
  seasonsByYear: Map<number, SeasonActuals>,
  positionByPlayer: Map<string, { position: FantasyPosition | null; age: number | null }>,
  targetSeasons: number[],
): BacktestRow[] {
  const rows: BacktestRow[] = [];
  const allYears = [...seasonsByYear.keys()].sort();

  for (const ty of targetSeasons) {
    const actualSeason = seasonsByYear.get(ty);
    if (!actualSeason) continue;
    const priorYears = allYears.filter((y) => y < ty);

    for (const [pid, actual] of actualSeason.players) {
      const meta = positionByPlayer.get(pid);
      const pos = meta?.position ?? actual.position;
      if (!pos || pos === "K" || pos === "DEF") continue;
      if (actual.gp === 0) continue;

      const priorSeasons: PlayerSeasonActual[] = [];
      for (const y of priorYears) {
        const row = seasonsByYear.get(y)?.players.get(pid);
        if (row) priorSeasons.push(row);
      }
      if (priorSeasons.length === 0) continue; // no history -> rookie, excluded from core backtest

      const prev = seasonsByYear.get(ty - 1)?.players.get(pid) ?? null;
      const core = projectCoreForSeason(pid, pos, meta?.age ?? null, priorSeasons, ty);

      rows.push({
        player_id: pid,
        position: pos,
        target_season: ty,
        actual_points: round2(actual.pts_ppr),
        ri_core: core?.predicted_points ?? null,
        bl_prev_points: prev ? round2(prev.pts_ppr) : null,
        bl_prev_ppg_x17: prev && prev.gp > 0 ? round2((prev.pts_ppr / prev.gp) * REGULAR_SEASON_GAMES) : null,
        bl_3yr_weighted: weighted3yr(priorSeasons, ty),
      });
    }
  }
  return rows;
}

function weighted3yr(prior: PlayerSeasonActual[], ty: number): number | null {
  const w = [0.5, 0.3, 0.2];
  let wn = 0;
  let wd = 0;
  for (let i = 0; i < 3; i++) {
    const row = prior.find((s) => s.season === ty - 1 - i);
    if (row) {
      wn += w[i]! * row.pts_ppr;
      wd += w[i]!;
    }
  }
  return wd > 0 ? round2(wn / wd) : null;
}

export function scoreBacktest(rows: BacktestRow[]): {
  metrics: BacktestMetrics[];
  sleeper_historical: string;
  n_players: number;
} {
  const methods: Array<{ name: string; get: (r: BacktestRow) => number | null }> = [
    { name: "RI_core", get: (r) => r.ri_core },
    { name: "baseline_prev_year_points", get: (r) => r.bl_prev_points },
    { name: "baseline_prev_year_ppg_x17", get: (r) => r.bl_prev_ppg_x17 },
    { name: "baseline_3yr_weighted", get: (r) => r.bl_3yr_weighted },
  ];

  const metrics = methods.map((m) => {
    const pairs = rows
      .map((r) => ({ pred: m.get(r), actual: r.actual_points, prevErr: r.bl_prev_points != null ? Math.abs(r.bl_prev_points - r.actual_points) : null }))
      .filter((p): p is { pred: number; actual: number; prevErr: number | null } => p.pred != null);
    const n = pairs.length;
    if (n === 0) {
      return { method: m.name, n: 0, mae: 0, rmse: 0, bias: 0, spearman: 0, beat_prev_year_rate: null };
    }
    const errs = pairs.map((p) => p.pred - p.actual);
    const mae = errs.reduce((a, e) => a + Math.abs(e), 0) / n;
    const rmse = Math.sqrt(errs.reduce((a, e) => a + e * e, 0) / n);
    const bias = errs.reduce((a, e) => a + e, 0) / n;
    const spearman = spearmanCorr(pairs.map((p) => p.pred), pairs.map((p) => p.actual));
    const beatable = pairs.filter((p) => p.prevErr != null);
    const beat = beatable.length
      ? beatable.filter((p) => Math.abs(p.pred - p.actual) < p.prevErr!).length / beatable.length
      : null;
    return {
      method: m.name,
      n,
      mae: round2(mae),
      rmse: round2(rmse),
      bias: round2(bias),
      spearman: round3(spearman),
      beat_prev_year_rate: beat == null ? null : round3(beat),
    };
  });

  return {
    metrics,
    sleeper_historical: SLEEPER_HISTORICAL_BENCHMARK_STATUS,
    n_players: rows.length,
  };
}

/* ------------------------------------------------------------------ math utils */

function spearmanCorr(a: number[], b: number[]): number {
  const ra = rankArray(a);
  const rb = rankArray(b);
  const n = a.length;
  const mean = (n + 1) / 2;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    num += (ra[i]! - mean) * (rb[i]! - mean);
    da += (ra[i]! - mean) ** 2;
    db += (rb[i]! - mean) ** 2;
  }
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : 0;
}
function rankArray(x: number[]): number[] {
  const idx = x.map((v, i) => [v, i] as const).sort((p, q) => p[0] - q[0]);
  const r = new Array<number>(x.length);
  for (let i = 0; i < idx.length; i++) r[idx[i]![1]] = i + 1;
  return r;
}
function clamp(v: number, lo: number, hi: number): number { return Math.max(lo, Math.min(hi, v)); }
function sum(s: PlayerSeasonActual[], f: (x: PlayerSeasonActual) => number): number { return s.reduce((a, x) => a + f(x), 0); }
function round2(v: number): number { return Math.round(v * 100) / 100; }
function round3(v: number): number { return Math.round(v * 1000) / 1000; }
