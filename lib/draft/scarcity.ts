/**
 * PHASE 4 §4.4 — positional scarcity.
 *
 * Scarcity is NOT "few players left". It is high only when the remaining-value
 * CURVE at a position actually falls away — i.e. the drop from the best
 * available to the marginal startable option is steep AND demand will consume
 * that gap before the manager picks again.
 *
 *   scarcity_index ≈ f( remaining starter-quality players,
 *                       slope of the remaining value curve,
 *                       expected positional demand before the next turn )
 *
 * A position with 2 elite players and then a plateau of average ones is NOT
 * scarce for the plateau — only for those 2.
 */

import type { FantasyPosition } from "@/lib/projections/schema";
import type { ScarcitySnapshot } from "./schema";

export interface ScarcityInput {
  position: FantasyPosition;
  /** VOR of every still-available player at this position, descending */
  availableVor: number[];
  /** starter demand for this position league-wide (base + flex) */
  starterDemand: number;
  /** expected picks of this position before the manager's next turn */
  expectedDemandBeforeNextPick: number;
  /** the replacement drop for this position (points from #1 available to replacement) */
  replacementDrop: number;
}

export function computeScarcity(input: ScarcityInput): ScarcitySnapshot {
  const vor = input.availableVor.slice().sort((a, b) => b - a);
  const starterQuality = vor.filter((v) => v > 0).length;

  // slope of the remaining value curve over the "startable window": from the
  // best available to the marginal starter (or to the last positive-VOR player).
  const windowEnd = Math.max(1, Math.min(vor.length, Math.ceil(input.starterDemand)));
  const top = vor[0] ?? 0;
  const marginal = vor[windowEnd - 1] ?? 0;
  const slope = windowEnd > 1 ? (top - marginal) / (windowEnd - 1) : 0;

  // normalize: a steep curve + thin supply + heavy imminent demand => scarce.
  // supply pressure: how much of the startable window demand will eat
  const supplyPressure =
    starterQuality > 0
      ? Math.min(1, input.expectedDemandBeforeNextPick / starterQuality)
      : 1;
  // curve pressure: slope relative to the replacement drop (bounded)
  const curvePressure =
    input.replacementDrop > 1
      ? Math.min(1, slope / (input.replacementDrop / windowEnd + 1e-6))
      : Math.min(1, slope / 10);

  const scarcity_index = round3(clamp01(0.55 * curvePressure + 0.45 * supplyPressure));

  return {
    position: input.position,
    starter_quality_remaining: starterQuality,
    remaining_value_slope: round3(slope),
    replacement_drop: round3(input.replacementDrop),
    expected_demand_before_next_pick: round3(input.expectedDemandBeforeNextPick),
    scarcity_index,
  };
}

/**
 * Points-equivalent scarcity pressure for one player: how much of the position's
 * value slope this player sits in front of, scaled by the scarcity index. This
 * is what the utility function consumes (league-point units).
 */
export function scarcityValueForPlayer(
  snapshot: ScarcitySnapshot,
  playerVorRankInPosition: number,
): number {
  // only the players inside the steep part of the curve get scarcity credit
  if (playerVorRankInPosition > Math.max(1, snapshot.starter_quality_remaining)) return 0;
  return round3(snapshot.scarcity_index * snapshot.remaining_value_slope);
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}
