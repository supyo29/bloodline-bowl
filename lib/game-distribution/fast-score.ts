/**
 * Fast exact scoring of simulated football stat lines under a league's scoring: per-stat linear coefficients are derived by PROBING the repo's single
 * scoring path (materializeScoringEvents + scoreWeeklyLine), so position bonuses (e.g. TE premium) are included. Exact whenever the league's offensive
 * scoring is per-unit linear in these stats (verified by a test against the engine); threshold bonuses are not produced by the simulator.
 */
import { scoreExpectedLine } from "@/lib/role-calibration/xfp";
import type { RolePosition } from "@/lib/role-calibration/types";

export const STAT_KEYS = ["pass_att", "pass_cmp", "pass_yd", "pass_td", "pass_int", "pass_sack", "rush_att", "rush_yd", "rush_td", "rec_tgt", "rec", "rec_yd", "rec_td", "fum_lost"] as const;
export type StatKey = (typeof STAT_KEYS)[number];
export const STAT_INDEX: Record<StatKey, number> = Object.fromEntries(STAT_KEYS.map((k, i) => [k, i])) as Record<StatKey, number>;
export const N_STATS = STAT_KEYS.length;

export function linearCoefficients(position: RolePosition, rawScoring: Record<string, number>): Float64Array {
  const base = scoreExpectedLine(position, {}, rawScoring);
  const c = new Float64Array(N_STATS);
  STAT_KEYS.forEach((k, i) => { c[i] = scoreExpectedLine(position, { [k]: 1 }, rawScoring) - base; });
  return c;
}
export function scoreStats(stats: Float32Array, offset: number, coef: Float64Array): number {
  let s = 0; for (let i = 0; i < N_STATS; i++) s += stats[offset + i]! * coef[i]!; return s;
}
