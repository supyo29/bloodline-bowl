/**
 * Weekly stat line -> league points, via the repo's existing scoring engine.
 *
 * `calculateFantasyPoints` is reused verbatim — no scoring math is
 * re-implemented. A projected stat line is scored with the LEAGUE's own
 * canonical `raw_scoring` map, so two leagues score the same projected line
 * differently (which is the point).
 */

import { calculateFantasyPoints } from "@/lib/scoring/calculate";

/** Sleeper projection keys that are metadata / ADP, never scoring stats. */
const NON_SCORING_KEY = /^(adp_|pos_adp_|pos_rank|rank_|gp$|gms_active$|gp_|snp_)/;

export interface ScoredLine {
  points: number;
  /** scoring keys that were present in the stat line and actually scored */
  scored_keys: string[];
  /** stat keys the league does not score (informational, not an error) */
  unscored_keys: string[];
}

export function scoreWeeklyLine(
  stats: Record<string, number>,
  rawScoring: Record<string, number>,
): ScoredLine {
  const clean: Record<string, number> = {};
  for (const [k, v] of Object.entries(stats)) {
    if (NON_SCORING_KEY.test(k)) continue;
    if (typeof v === "number" && Number.isFinite(v)) clean[k] = v;
  }
  const result = calculateFantasyPoints(clean, rawScoring);
  const scored = result.breakdown.filter((b) => b.points !== 0 || b.multiplier !== 0).map((b) => b.stat);
  const unscored = Object.keys(clean).filter((k) => !(k in rawScoring));
  return {
    points: Math.round(result.fantasy_points * 100) / 100,
    scored_keys: scored,
    unscored_keys: unscored,
  };
}
