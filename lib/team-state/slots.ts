/**
 * Shared slot-key resolution for Team-State. Thin wrappers over the FROZEN
 * `lib/weekly/slots.ts` primitives — Team-State does NOT re-interpret FLEX.
 */

import {
  BASE_STARTING,
  isFlexSlot,
  maxSlotMatching,
  slotEligiblePositions,
  type MatchCandidate,
} from "@/lib/weekly/slots";
import type { CanonicalPosition } from "@/lib/canonical/schema";

export { slotEligiblePositions, isFlexSlot, maxSlotMatching, BASE_STARTING };
export type { MatchCandidate };

const uniq = <T,>(xs: T[]): T[] => [...new Set(xs)];

/** Positions a player can be STARTED at (position + eligible_positions), deduped. */
export function startablePositions(p: {
  position: CanonicalPosition;
  eligible_positions: CanonicalPosition[];
}): string[] {
  return uniq([p.position, ...p.eligible_positions]);
}

/**
 * The distinct slot keys the league scores against: every BASE position that
 * appears in the starting lineup, plus every distinct flex-slot label. Order:
 * base positions in `["QB","RB","WR","TE","K","DEF"]` order, then flex labels in
 * first-seen order.
 */
export function leagueSlotKeys(startingSlots: string[]): string[] {
  const bases = ["QB", "RB", "WR", "TE", "K", "DEF"].filter((b) => startingSlots.includes(b));
  const flex = uniq(startingSlots.filter((s) => isFlexSlot(s)));
  return [...bases, ...flex];
}

/** How many starting slots require exactly `key`. */
export function requiredStarters(startingSlots: string[], key: string): number {
  return startingSlots.filter((s) => s === key).length;
}

/** Does this player qualify for `key` (base position or flex label)? */
export function eligibleForKey(startable: string[], key: string): boolean {
  const elig = new Set(slotEligiblePositions(key));
  return startable.some((p) => elig.has(p));
}
