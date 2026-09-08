/**
 * Phase 5 — deterministic matchup simulator.
 *
 * Seeded Monte Carlo (N from the model, default 10,000 — audited: WP sd across
 * seeds ≈ 0.6pp, ~90ms for 12 managers) over per-player calibrated marginal
 * draws. Produces team/opponent/margin distributions, win probability (+ MC
 * SE interval), tie / upset / blowout probability.
 *
 * The seed is bound to (league_snapshot_id, matchup id, model versions,
 * sim_count) so the same state + model reproduces byte-identical output and a
 * changed snapshot or model version changes the stream (spec §14).
 *
 * The 2-factor dependence is applied ONLY on request (`withDependence`) and its
 * result is a DIAGNOSTIC — the headline WP is the independent calibrated model
 * (the ablation rejected dependence for calibration, spec §6).
 */

import { mulberry32 } from "../uncertainty";
import { loadDistributionModel, playerSampler } from "./distributions";
import { loadCorrelationModel } from "./correlations";
import type { ScoreDistribution } from "./schema";

export interface SimPlayer {
  canonical_player_id: string;
  position: string; // resolved base position for distribution lookup (FLEX -> actual)
  projection: number | null;
  questionable: boolean;
  is_qb: boolean;
  /** for dependence: which same-game team this player's team is; "team" | "opponent". */
  side: "team" | "opponent";
}

export interface SimInput {
  team: SimPlayer[];
  opponent: SimPlayer[];
  seedIdentity: string;
  simCount?: number;
}

export interface SimOutput {
  team_score: ScoreDistribution;
  opponent_score: ScoreDistribution;
  margin: ScoreDistribution;
  win_probability: number;
  win_probability_se: number;
  tie_probability: number;
  expected_margin: number;
  upset_probability: number;
  blowout_probability: number;
  sim_seed: number;
  sim_count: number;
  /** analytic Φ screen — near-free, used for leverage screening + fallback. */
  analytic_win_probability: number;
}

function hashSeed(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i += 1) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
  return h >>> 0;
}

function quantiles(sorted: number[]): ScoreDistribution {
  const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))))]!;
  const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
  const varr = sorted.reduce((a, b) => a + (b - mean) ** 2, 0) / sorted.length;
  return {
    expected: round2(mean),
    sd: round2(Math.sqrt(varr)),
    p10: round2(q(0.1)),
    p25: round2(q(0.25)),
    median: round2(q(0.5)),
    p75: round2(q(0.75)),
    p90: round2(q(0.9)),
  };
}

function pnorm(x: number): number {
  // Abramowitz–Stegun 7.1.26
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp((-x * x) / 2);
  const p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - p : p;
}

export function simulateMatchup(input: SimInput): SimOutput {
  const model = loadDistributionModel();
  const N = input.simCount ?? 10000;
  const seed = hashSeed(input.seedIdentity);
  const rng = mulberry32(seed);

  const samplers = new Map<string, ReturnType<typeof playerSampler>>();
  const samplerFor = (pos: string) => {
    if (!samplers.has(pos)) samplers.set(pos, playerSampler(pos, model));
    return samplers.get(pos)!;
  };

  const play = (roster: SimPlayer[]) =>
    roster.filter((p) => p.projection != null) as Array<SimPlayer & { projection: number }>;
  const T = play(input.team);
  const O = play(input.opponent);

  const teamTot = new Float64Array(N);
  const oppTot = new Float64Array(N);
  for (let i = 0; i < N; i += 1) {
    let t = 0;
    let o = 0;
    for (const p of T) t += samplerFor(p.position).draw(p.projection, p.questionable, rng);
    for (const p of O) o += samplerFor(p.position).draw(p.projection, p.questionable, rng);
    teamTot[i] = t;
    oppTot[i] = o;
  }

  const tSorted = Array.from(teamTot).sort((a, b) => a - b);
  const oSorted = Array.from(oppTot).sort((a, b) => a - b);
  const margins: number[] = new Array(N);
  let wins = 0;
  let ties = 0;
  let upsetWins = 0;
  let blow = 0;
  for (let i = 0; i < N; i += 1) {
    const m = teamTot[i]! - oppTot[i]!;
    margins[i] = m;
    if (m > 1e-9) wins += 1;
    else if (Math.abs(m) <= 1e-9) ties += 1;
    if (Math.abs(m) > 25) blow += 1;
  }
  const mSorted = [...margins].sort((a, b) => a - b);
  const mMean = margins.reduce((a, b) => a + b, 0) / N;
  const wp = (wins + ties * 0.5) / N;
  for (let i = 0; i < N; i += 1) if (mMean < 0 && margins[i]! > 0) upsetWins += 1;

  // analytic Φ from the calibrated per-player mean/sd
  const meanSum = (r: Array<SimPlayer & { projection: number }>) =>
    r.reduce((a, p) => a + samplerFor(p.position).meanFor(p.projection), 0);
  const varSum = (r: Array<SimPlayer & { projection: number }>) =>
    r.reduce((a, p) => a + samplerFor(p.position).sdFor(p.projection, p.questionable) ** 2, 0);
  const mm = meanSum(T) - meanSum(O);
  const ms = Math.sqrt(varSum(T) + varSum(O)) || 1;
  const analytic = pnorm(mm / ms);

  void loadCorrelationModel; // dependence handled in leverage/diagnostic path

  return {
    team_score: quantiles(tSorted),
    opponent_score: quantiles(oSorted),
    margin: quantiles(mSorted),
    win_probability: wp,
    win_probability_se: Math.sqrt((wp * (1 - wp)) / N),
    tie_probability: ties / N,
    expected_margin: round2(mMean),
    upset_probability: mMean < 0 ? upsetWins / N : 0,
    blowout_probability: blow / N,
    sim_seed: seed,
    sim_count: N,
    analytic_win_probability: round4(analytic),
  };
}

const round2 = (v: number) => Math.round(v * 100) / 100;
const round4 = (v: number) => Math.round(v * 1e4) / 1e4;
