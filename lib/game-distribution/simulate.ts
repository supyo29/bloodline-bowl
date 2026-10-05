/**
 * Team-game football simulator. ONE football outcome distribution per player; fantasy scoring is applied afterwards per league fingerprint.
 *
 * Per simulation (deterministic given the seed):
 *   1. draw the GAME-SCRIPT: a resampled pair of (actual/forecast) volume ratios from a real prior-season game — team volumes for both clubs;
 *   2. draw team efficiency shocks (shared by teammates => QB-WR-TE correlation);
 *   3. per player: draw availability + role residual from the matching confidence-tier pool (DNP is a real outcome);
 *   4. enforce football constraints: team target/carry shares sum to <= 1, counts are integers, carries <= team rush attempts, targets <= team pass attempts;
 *   5. per opportunity: resample a real play (pool) — yards are scaled by the shared team and player efficiency shocks; completions, TDs, INTs, fumbles
 *      come straight from the real plays (TD/turnover variance is therefore intrinsic, with zero/one/two/multi-TD outcomes arising naturally).
 * Nothing here reads any outcome of the game being forecast.
 */
import { allocateCounts, lognormalMultiplier, makeNormal, mulberry32, pick, seedFrom, stochasticRound, type Rng } from "./rng";
import type { PoolSampler } from "./pools";
import { N_STATS, STAT_INDEX } from "./fast-score";
import { availabilityClass, magBin, poolKeys, recencyOf, selectPool, tierOf, GAME_DISTRIBUTION_MODEL_VERSION, type CalibrationPriors, type VolumeRatios } from "./priors";
import type { RoleForecast, RolePosition } from "@/lib/role-calibration/types";

export interface TeamSpec { team: string; forecasts: RoleForecast[] }
export interface GameSpec { season: number; week: number; game_id: string; a: TeamSpec; b: TeamSpec }
export interface SimOptions { sims: number; sigma_team?: number; sigma_player?: number; excludeWeek?: number; widenQbChange?: boolean; qbChange?: { a: boolean; b: boolean } }
export interface PlayerSim { forecast: RoleForecast; stats: Float32Array; pool_key: string }
export interface TeamVolumeSim { team: string; pass_att: Float32Array; rush_att: Float32Array; rz_pass: Float32Array; rz_rush: Float32Array }
export interface GameSimResult { model_version: string; seed: number; sims: number; players: PlayerSim[]; teams: TeamVolumeSim[]; scenario_counts: Record<string, number>; constraint_violations: number }

const clip01 = (v: number): number => Math.min(1, Math.max(0, v));
const mag = (f: RoleForecast, cut: [number, number]): 0 | 1 | 2 => { const m = f.position === "QB" ? f.metrics.snap_share?.value ?? null : f.position === "RB" ? f.metrics.rush_share?.value ?? null : f.metrics.target_share?.value ?? null; return magBin(m, cut); };

/** Descriptive post-hoc script label of a sampled game (not an input): thresholds are descriptive only. */
export function scriptLabel(self: VolumeRatios, opp: VolumeRatios): string {
  const p = self[0], r = self[1];
  if (p >= 1.08 && r >= 1.08) return "HIGH_VOLUME_SHOOTOUT";
  if (p <= 0.92 && r <= 0.92) return "LOW_VOLUME_DEFENSIVE";
  if (p >= 1.12 && r <= 0.95) return "PASS_HEAVY_TRAILING_OR_SHOOTOUT";
  if (r >= 1.12 && p <= 0.95) return "RUSH_HEAVY_CLOCK_CONTROL";
  void opp; return "BALANCED";
}

export function simulateGame(game: GameSpec, pools: PoolSampler, priors: CalibrationPriors, opt: SimOptions): GameSimResult {
  const seed = seedFrom(GAME_DISTRIBUTION_MODEL_VERSION, game.season, game.week, game.game_id);
  const rng: Rng = mulberry32(seed), normal = makeNormal(rng);
  const sigmaTeam = opt.sigma_team ?? priors.shocks.sigma_team, sigmaPlayer = opt.sigma_player ?? priors.shocks.sigma_player;
  const pairs = opt.excludeWeek == null ? priors.team_game_pairs : priors.team_game_pairs.filter((g) => g.week !== opt.excludeWeek);
  const teams = [game.a, game.b];
  const players: PlayerSim[] = [];
  const table = teams.map((t) => t.forecasts.map((f) => {
    const tier = tierOf(f.metrics[f.position === "QB" ? "snap_share" : f.position === "RB" ? "rush_share" : "target_share"]?.n_games_season ?? 0);
    const sel = selectPool(priors, poolKeys(f.position, availabilityClass(f.availability.designation), recencyOf(f), tier, mag(f, priors.mag_cutpoints[f.position])));
    players.push({ forecast: f, stats: new Float32Array(opt.sims * N_STATS), pool_key: sel.key });
    return { f, pool: sel.pool, sim: players[players.length - 1]! };
  }));
  const teamSims: TeamVolumeSim[] = teams.map((t) => ({ team: t.team, pass_att: new Float32Array(opt.sims), rush_att: new Float32Array(opt.sims), rz_pass: new Float32Array(opt.sims), rz_rush: new Float32Array(opt.sims) }));
  const scenario: Record<string, number> = {}; let violations = 0;
  const S = STAT_INDEX;

  for (let s = 0; s < opt.sims; s++) {
    const g = pick(pairs, rng); const flip = rng() < 0.5;
    const ratio: VolumeRatios[] = flip ? [g.b, g.a] : [g.a, g.b];
    const shockTeam = teams.map(() => lognormalMultiplier(sigmaTeam, normal()));
    for (let ti = 0; ti < 2; ti++) {
      const t = teams[ti]!, rows = table[ti]!;
      const base = t.forecasts[0]?.volumes; if (!base) continue;
      // regime widening (data-driven, only if the prior-season evidence supports it): scale the log-ratio deviation
      const widen = opt.widenQbChange && priors.regime.applied && (ti === 0 ? opt.qbChange?.a : opt.qbChange?.b) ? (priors.regime.qb_change_dispersion_ratio ?? 1) : 1;
      const rr = ratio[ti]!.map((r) => (widen === 1 ? r : Math.exp(Math.log(Math.max(r, 1e-3)) * widen))) as VolumeRatios;
      // integer team opportunity pools (stochastic rounding preserves the mean); player counts are allocated out of these so no player/team constraint can break
      const passAtt = stochasticRound((base.team_pass_att ?? 0) * rr[0], rng), rushAtt = stochasticRound((base.team_rush_att ?? 0) * rr[1], rng);
      const rzPass = Math.min(passAtt, stochasticRound((base.team_rz_pass_att ?? 0) * rr[2], rng)), rzRush = Math.min(rushAtt, stochasticRound((base.team_rz_rush_att ?? 0) * rr[3], rng));
      teamSims[ti]!.pass_att[s] = passAtt; teamSims[ti]!.rush_att[s] = rushAtt; teamSims[ti]!.rz_pass[s] = rzPass; teamSims[ti]!.rz_rush[s] = rzRush;
      const label = scriptLabel(rr, ratio[1 - ti]!); scenario[label] = (scenario[label] ?? 0) + 1;

      // 3. availability + role residuals
      const drawn = rows.map(({ f, pool }) => { const r = pick(pool.rows, rng); return { f, r, mp: lognormalMultiplier(sigmaPlayer, normal()) }; });
      // 4. constraint: share sums <= 1 across this team's forecast players
      const tgt = drawn.map(({ f, r }) => (r.played && f.metrics.target_share?.value_with_pressure != null ? clip01(f.metrics.target_share.value_with_pressure + (r.d_target ?? 0)) : 0));
      const rus = drawn.map(({ f, r }) => (r.played && f.metrics.rush_share?.value_with_pressure != null ? clip01(f.metrics.rush_share.value_with_pressure + (r.d_rush ?? 0)) : 0));
      const rzt = drawn.map(({ f, r }) => (r.played && f.metrics.rz_target_share?.value_with_pressure != null ? clip01(f.metrics.rz_target_share.value_with_pressure + (r.d_rz_target ?? 0)) : 0));
      const rzc = drawn.map(({ f, r }) => (r.played && f.metrics.rz_carry_share?.value_with_pressure != null ? clip01(f.metrics.rz_carry_share.value_with_pressure + (r.d_rz_carry ?? 0)) : 0));
      for (const arr of [tgt, rus, rzt, rzc]) { const tot = arr.reduce((a, b) => a + b, 0); if (tot > 1) { violations++; for (let i = 0; i < arr.length; i++) arr[i]! /= tot; } }
      const nTgt = allocateCounts(tgt, passAtt, rng), nRzT = allocateCounts(rzt, rzPass, rng), nCar = allocateCounts(rus, rushAtt, rng), nRzC = allocateCounts(rzc, rzRush, rng);
      drawn.forEach(({ f, r, mp }, i) => {
        if (!r.played) return;
        const out = rows[i]!.sim.stats; const o = s * N_STATS; const shock = shockOf(shockTeam[ti]!, mp);
        const pos = f.position as RolePosition;
        if (pos === "QB") {
          const fDb = f.opportunity.dropbacks ?? 0; const snapF = f.metrics.snap_share?.value ?? 1;
          const factor = r.ratio_dropbacks != null ? r.ratio_dropbacks : snapF > 0 ? clip01((snapF + (r.d_snap ?? 0)) / snapF) : 0;
          const db = stochasticRound(fDb * rr[0] * factor, rng);
          const rzRatio = passAtt > 0 ? Math.min(1, rzPass / passAtt) : 0;
          for (let k = 0; k < db; k++) { const d = pools.dropback(rng() < rzRatio ? "rz" : "nonrz", rng);
            if (d.outcome === "sack") { out[o + S.pass_sack]! += 1; out[o + S.fum_lost]! += d.fum; } else if (d.outcome === "scramble") { out[o + S.rush_att]! += 1; out[o + S.rush_yd]! += d.yards * shock; out[o + S.rush_td]! += d.td; out[o + S.fum_lost]! += d.fum; } else { out[o + S.pass_att]! += 1; out[o + S.pass_cmp]! += d.cmp; out[o + S.pass_yd]! += d.yards * shock; out[o + S.pass_td]! += d.td; out[o + S.pass_int]! += d.int; out[o + S.fum_lost]! += d.fum; } }
          const designed = stochasticRound(Math.max(0, (f.opportunity.designed_rushes ?? 0) + (r.d_designed ?? 0)), rng); // scrambles come out of the dropbacks above
          for (const [n, kind] of [[designed, "designed"]] as const) for (let k = 0; k < n; k++) { const d = pools.rush("QB", kind, "nonrz", rng); out[o + S.rush_att]! += 1; out[o + S.rush_yd]! += d.yards * shock; out[o + S.rush_td]! += d.td; out[o + S.fum_lost]! += d.fum; }
          return;
        }
        if (pos === "RB") {
          const carries = nCar[i]!; const rz = Math.min(carries, nRzC[i]!);
          for (let k = 0; k < carries; k++) { const d = pools.rush("RB", "rush", k < rz ? "rz" : "nonrz", rng); out[o + S.rush_att]! += 1; out[o + S.rush_yd]! += d.yards * shock; out[o + S.rush_td]! += d.td; out[o + S.fum_lost]! += d.fum; }
        }
        const targets = nTgt[i]!; const rzT = Math.min(targets, nRzT[i]!);
        for (let k = 0; k < targets; k++) { const d = pools.target(pos as "RB" | "WR" | "TE", k < rzT ? "rz" : "nonrz", rng); out[o + S.rec_tgt]! += 1; out[o + S.rec]! += d.cmp; out[o + S.rec_yd]! += d.yards * shock; out[o + S.rec_td]! += d.td; out[o + S.fum_lost]! += d.fum; }
      });
    }
  }
  return { model_version: GAME_DISTRIBUTION_MODEL_VERSION, seed, sims: opt.sims, players, teams: teamSims, scenario_counts: scenario, constraint_violations: violations };
}
/** team shock x player shock (both mean-one multipliers applied to yardage only). */
const shockOf = (team: number, player: number): number => team * player;
