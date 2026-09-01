/**
 * PHASE 4 §4.5 / §13 — roster need as a UTILITY ADJUSTMENT, not a hard filter.
 *
 * Need matters but must not dominate. It is expressed in league-point units so
 * it adds cleanly to VOR in the utility function:
 *
 *   roster_need(player) = needWeight(position) × positionReplacementGap
 *
 * where needWeight is:
 *   + strong   when the player fills an open required starter slot
 *   + mild     when he fills open FLEX capacity
 *   ~ zero     when the position is startable-complete but not deep
 *   − mild     when the position is already deep (redundancy)
 *
 * The ONLY hard rule is roster legality (handled upstream in eligibility): a
 * high-value player is never rejected merely because his position is "filled".
 *
 * §13 positional advantage (QB/TE especially) is computed separately in
 * `positionalAdvantage` — value beyond the expected later alternative — so an
 * elite QB can out-rank an RB even with the QB slot empty-but-not-urgent.
 */

import type { FantasyPosition } from "@/lib/projections/schema";
import { computeRosterNeeds } from "@/lib/sleeper/draft";
import type { NormalizedPlayer } from "@/lib/sleeper/types";

const FLEX_ELIGIBLE = new Set<FantasyPosition>(["RB", "WR", "TE"]);

export interface RosterNeedState {
  open_required: Record<string, number>;
  open_flex: number;
  have: Record<string, number>;
  /** positions where the manager already has a startable + real depth advantage */
  secured_positions: FantasyPosition[];
}

export function computeRosterNeedState(
  rosterPlayers: NormalizedPlayer[],
  rosterPositions: string[],
): RosterNeedState {
  const needs = computeRosterNeeds(rosterPlayers, rosterPositions);
  const open_required: Record<string, number> = { QB: 0, RB: 0, WR: 0, TE: 0, K: 0, DEF: 0 };
  for (const r of needs.required) open_required[r.position] = r.minimum_needed;

  const have: Record<string, number> = { QB: 0, RB: 0, WR: 0, TE: 0, K: 0, DEF: 0 };
  for (const p of rosterPlayers) {
    const pos = p.position ?? "";
    if (pos in have) have[pos] = (have[pos] ?? 0) + 1;
  }

  // "secured" = has ≥ 2 more than the base requirement at a scoring position
  const baseReq: Record<string, number> = { QB: 1, RB: 2, WR: 2, TE: 1, K: 1, DEF: 1 };
  const secured_positions = (Object.keys(have) as FantasyPosition[]).filter(
    (pos) => (have[pos] ?? 0) - (baseReq[pos] ?? 1) >= 2,
  );

  return { open_required, open_flex: needs.flexible_slots_remaining, have, secured_positions };
}

/**
 * Need weight for a position given the roster state. Returns a dimensionless
 * multiplier in ~[-0.4, +0.9]; multiply by the position's replacement gap to
 * get league-point units.
 */
export function needWeight(
  state: RosterNeedState,
  position: FantasyPosition,
): number {
  const open = state.open_required[position] ?? 0;
  const have = state.have[position] ?? 0;
  const baseReq: Record<string, number> = { QB: 1, RB: 2, WR: 2, TE: 1, K: 1, DEF: 1 };
  const depth = have - (baseReq[position] ?? 1);

  if (open >= 1) return 0.9;
  if (FLEX_ELIGIBLE.has(position) && state.open_flex > 0) return 0.35;
  if (state.secured_positions.includes(position)) return -0.4;
  if (depth >= 1) return -0.2;
  return 0.0;
}

/**
 * §13 — positional advantage: how much this player beats the expected player
 * available at the same position at the manager's NEXT pick. This is what lets
 * an elite QB/TE legitimately outrank an RB/WR even off a non-urgent slot, and
 * what stops the engine reaching for a QB in a flat tier.
 *
 * `expectedLaterValue` comes from the lookahead module.
 */
export function positionalAdvantage(
  playerLeaguePoints: number,
  expectedLaterValue: number,
): number {
  return round2(playerLeaguePoints - expectedLaterValue);
}

/** Points-equivalent roster-need adjustment for one player. */
export function rosterNeedValue(
  state: RosterNeedState,
  position: FantasyPosition,
  positionReplacementGap: number,
): number {
  return round2(needWeight(state, position) * Math.max(0, positionReplacementGap));
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
