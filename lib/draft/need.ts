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
import { computeRosterNeeds, flexSlots } from "@/lib/sleeper/draft";
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

/**
 * PHASE 4 DEFECT FIX (recommendation_version 2026.2, discovered in Phase 6
 * multi-round trajectory validation): `positionalAdvantage` compares a
 * candidate to his position's future alternative — a property of the PLAYER
 * POOL, with no roster awareness at all. For a shallow-starter, wide-tier
 * position (QB above all — one starting slot, no FLEX eligibility, but a
 * steep points spread among startable QBs) this let `positionalAdvantage`
 * alone justify drafting a 3rd, 4th, 5th QB: `roster_need` correctly went
 * negative, but the 0.45-weighted `positionalAdvantage` term is independent
 * of need and stayed large, and in Phase 6 self-play simulation a manager
 * drafted SEVEN quarterbacks and finished with open RB/WR/FLEX/K/DEF slots.
 *
 * Fix: a positional edge only has recommendation value if the candidate could
 * plausibly ever START. Once a manager already holds enough players at a
 * position to fill every slot that position could occupy — its base starter
 * slots, every FLEX slot (conservatively, since FLEX is shared), plus one
 * bench-depth/handcuff allowance — `positionalAdvantage` is damped to a small
 * residual (0.15x) rather than zeroed (a genuine future-trade/injury-insurance
 * angle survives, it just cannot drive the primary recommendation). This never
 * fires for a legitimate 1st-2nd QB, or up through a 5th flex-eligible
 * RB/WR/TE — only for a position already past what the roster can use.
 */
export function positionalAdvantageDamp(
  state: RosterNeedState,
  position: FantasyPosition,
  rosterPositions: string[],
): number {
  const baseReq: Record<string, number> = { QB: 1, RB: 2, WR: 2, TE: 1, K: 1, DEF: 1 };
  const totalFlex = flexSlots(rosterPositions).length;
  const usefulCapacity = (baseReq[position] ?? 1) + (FLEX_ELIGIBLE.has(position) ? totalFlex : 0) + 1;
  const have = state.have[position] ?? 0;
  return have < usefulCapacity ? 1 : 0.15;
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
