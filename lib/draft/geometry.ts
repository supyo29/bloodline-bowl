/**
 * PHASE 4 §5 / §21A — snake pick geometry for the recommendation engine.
 *
 * The primitive `overallPickNumber` / `computeDraftGeometry` already live in
 * `lib/bridge/geometry.ts` and are shared. This module adds the decision-engine
 * view on top:
 *
 *   - a `SnakeTurnState` that names the manager's current pick, next pick, and
 *     second-next pick, plus the wait between them;
 *   - `is_consecutive_turn` — the snake-turn case where a manager owns two
 *     back-to-back overall picks (slot 1 or slot N) and must be optimised as a
 *     PAIR, not two independent BPA picks (§21A);
 *   - future-pick enumeration for the "what will I see when the draft comes
 *     back to me" landscape.
 *
 * Pure. Every value derives from the league's own slot / team count / rounds.
 */

import { computeDraftGeometry, overallPickNumber } from "@/lib/bridge/geometry";
import type { FuturePick, SnakeTurnState, SupportedDraftType } from "./schema";

export { overallPickNumber };

export interface SnakeStateInput {
  slot: number;
  teamCount: number;
  rounds: number;
  /** completed picks across the whole draft (any team) */
  overallPicksMade: number;
  order?: SupportedDraftType;
}

/**
 * The manager's turn geometry. `current_pick` is this slot's next unspent pick;
 * `next_manager_pick` is the one after that. When those two are consecutive
 * overall picks the manager is on the snake turn.
 */
export function computeSnakeTurnState(input: SnakeStateInput): SnakeTurnState {
  const order: SupportedDraftType = input.order ?? "snake";
  const geo = computeDraftGeometry({
    slot: input.slot,
    teamCount: input.teamCount,
    rounds: input.rounds,
    overallPicksMade: input.overallPicksMade,
    order: order === "linear" ? "linear" : "snake",
  });

  const current = geo.next_pick;
  const next = geo.following_pick;
  const secondNext =
    current && geo.own_picks_made + 2 < geo.all_picks.length
      ? (geo.all_picks[geo.own_picks_made + 2] as FuturePick)
      : null;

  const picksUntilNext =
    current && next ? next.overall - current.overall - 1 : geo.wait_after_next ?? 0;
  const picksUntilSecondNext =
    next && secondNext ? secondNext.overall - next.overall - 1 : null;

  return {
    order,
    team_count: geo.team_count,
    rounds: geo.rounds,
    slot: geo.slot,
    overall_picks_made: Math.max(0, Math.trunc(input.overallPicksMade) || 0),
    all_picks: geo.all_picks,
    current_pick: current,
    next_manager_pick: next,
    second_next_manager_pick: secondNext,
    picks_until_next: Math.max(0, picksUntilNext),
    picks_until_second_next:
      picksUntilSecondNext == null ? null : Math.max(0, picksUntilSecondNext),
    current_round: geo.current_round,
    own_picks_made: geo.own_picks_made,
    is_consecutive_turn:
      current != null && next != null && next.overall - current.overall === 1,
  };
}

/**
 * How many picks by OTHER teams fall between two overall pick numbers
 * (exclusive of both endpoints). `from` is the pick the manager is making now.
 */
export function picksBetween(fromOverall: number, toOverall: number): number {
  return Math.max(0, toOverall - fromOverall - 1);
}

/**
 * Enumerate the overall picks other teams will make before `targetOverall`,
 * starting immediately after `fromOverall`. Used to size positional-run and
 * survival windows.
 */
export function interveningPickCount(
  turn: SnakeTurnState,
  targetOverall: number,
): number {
  if (!turn.current_pick) return 0;
  return picksBetween(turn.current_pick.overall, targetOverall);
}

/**
 * Canonical turn-pair key (§21A.3): because no opponent picks between the two
 * consecutive selections, Pair(A,B) and Pair(B,A) are the same decision state.
 */
export function canonicalPairKey(playerIdA: string, playerIdB: string): string {
  return [playerIdA, playerIdB].sort().join("::");
}

/**
 * The two future picks whose landscape a turn-pair should forecast: the
 * manager's pick after the current consecutive turn, and the one after that.
 * For BijiMac (slot 12) at picks 12/13 these are 36/37.
 */
export function nextTurnPickPair(turn: SnakeTurnState): [FuturePick, FuturePick] | null {
  if (!turn.is_consecutive_turn) return null;
  const idx = turn.own_picks_made; // current pick index
  const third = turn.all_picks[idx + 2];
  const fourth = turn.all_picks[idx + 3];
  if (!third || !fourth) return null;
  return [third, fourth];
}
