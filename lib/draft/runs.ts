/**
 * PHASE 4 §11 — positional run detection.
 *
 * A "run" is a recent burst of same-position picks (5 WR in the last 8, 3 QB in
 * the last 5). The engine reports `run_signal` (what happened) and `run_effect`
 * (what it changes) SEPARATELY, and a run NEVER changes a player's fundamental
 * value — only expected survival / tier survival / scarcity urgency.
 *
 * The engine does not blindly chase a run: the effect feeds survival, and the
 * utility function decides whether the resulting urgency is worth a reach.
 */

import type { FantasyPosition } from "@/lib/projections/schema";
import type { RunEffect, RunSignal } from "./schema";

/** Look-back window for run detection (picks). */
export const RUN_WINDOW = 8;
/** A run is flagged when the position's share of the window exceeds baseline by this much. */
const RUN_THRESHOLD = 0.18;

export interface RecentPick {
  overall: number;
  position: FantasyPosition | null;
}

/**
 * Baseline pick rate per position — how often this position is drafted league
 * wide, from the league's own starter demand (so a TE-premium league has a
 * higher TE baseline). Falls back to a standard split when demand is absent.
 */
export function baselinePickRates(
  starterDemand: Record<FantasyPosition, number>,
): Record<FantasyPosition, number> {
  const total = (Object.values(starterDemand).reduce((a, b) => a + b, 0)) || 1;
  const out = { QB: 0, RB: 0, WR: 0, TE: 0, K: 0, DEF: 0 } as Record<FantasyPosition, number>;
  for (const pos of Object.keys(out) as FantasyPosition[]) {
    out[pos] = starterDemand[pos] / total;
  }
  return out;
}

export function detectRuns(
  recentPicks: RecentPick[],
  baseline: Record<FantasyPosition, number>,
  window: number = RUN_WINDOW,
): RunSignal[] {
  const w = recentPicks
    .slice()
    .sort((a, b) => b.overall - a.overall)
    .slice(0, window);
  const counts = { QB: 0, RB: 0, WR: 0, TE: 0, K: 0, DEF: 0 } as Record<FantasyPosition, number>;
  for (const p of w) if (p.position && p.position in counts) counts[p.position] += 1;

  const size = w.length || 1;
  const out: RunSignal[] = [];
  for (const pos of Object.keys(counts) as FantasyPosition[]) {
    const rate = counts[pos] / size;
    const intensity = Math.max(0, rate - (baseline[pos] ?? 0));
    out.push({
      position: pos,
      picked_in_window: counts[pos],
      window_size: size,
      baseline_rate: round3(baseline[pos] ?? 0),
      run_intensity: round3(intensity),
      is_run: intensity >= RUN_THRESHOLD && counts[pos] >= 3,
    });
  }
  return out;
}

/**
 * Translate a run signal into its effect. `demand_multiplier` scales the
 * expected number of same-position picks before the manager's next turn;
 * `survival_delta` is the resulting drop in per-player survival probability.
 * `fundamental_value_delta` is always 0 — surfaced so an auditor can confirm
 * the run did not touch player value.
 */
export function runEffect(signal: RunSignal): RunEffect {
  if (!signal.is_run) {
    return {
      position: signal.position,
      demand_multiplier: 1,
      survival_delta: 0,
      fundamental_value_delta: 0,
    };
  }
  // a moderate run ~1.4x demand, a severe run up to ~2.2x; capped.
  const mult = Math.min(2.2, 1 + 2.4 * signal.run_intensity);
  return {
    position: signal.position,
    demand_multiplier: round3(mult),
    survival_delta: round3(-Math.min(0.35, 0.5 * signal.run_intensity)),
    fundamental_value_delta: 0,
  };
}

/** Extra same-position picks attributable to a run over a given pick window. */
export function runExtraDemand(
  effect: RunEffect,
  baselineRate: number,
  interveningPicks: number,
): number {
  const baseExpected = baselineRate * interveningPicks;
  return Math.max(0, baseExpected * (effect.demand_multiplier - 1));
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}
