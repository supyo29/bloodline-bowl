/**
 * Starting-slot eligibility — the ONE place the weekly engine maps a roster
 * slot label to the player positions that may fill it. Shared by the context
 * builder, the lineup optimizer, and anything that reasons about FLEX.
 *
 * Covers Sleeper labels (`FLEX`, `SUPER_FLEX`, `WRRB_FLEX`, …) and Yahoo labels
 * (`W/R/T`, `Q/W/R/T`, `W/R`, …) — a Yahoo flex must not be treated as a
 * literal position, which would leave the slot unfillable and understate every
 * downstream total.
 */

export const BASE_STARTING_POSITIONS = ["QB", "RB", "WR", "TE", "K", "DEF"] as const;
export const BASE_STARTING = new Set<string>(BASE_STARTING_POSITIONS);

/** Roster slot labels that are never a starting slot (bench / reserve). */
export const NON_STARTING_SLOTS = new Set(["BN", "BE", "IR", "IL", "NA", "TAXI", "TX"]);

export const FLEX_ELIGIBILITY: Record<string, string[]> = {
  // Sleeper
  FLEX: ["RB", "WR", "TE"],
  WRRB_FLEX: ["RB", "WR"],
  REC_FLEX: ["WR", "TE"],
  WRRB_WRT: ["RB", "WR", "TE"],
  SUPER_FLEX: ["QB", "RB", "WR", "TE"],
  SUPERFLEX: ["QB", "RB", "WR", "TE"],
  IDP_FLEX: ["DL", "LB", "DB"],
  // Yahoo
  "W/R/T": ["WR", "RB", "TE"],
  "W/R": ["WR", "RB"],
  "W/T": ["WR", "TE"],
  "R/T": ["RB", "TE"],
  "Q/W/R/T": ["QB", "WR", "RB", "TE"],
  "Q/W/R": ["QB", "WR", "RB"],
};

/** Positions eligible for `slot`; a non-flex slot returns just its own label. */
export function slotEligiblePositions(slot: string): string[] {
  return FLEX_ELIGIBILITY[slot] ?? [slot];
}

export function isFlexSlot(slot: string): boolean {
  return slot in FLEX_ELIGIBILITY;
}

/** The base-position "family" a slot belongs to for grouping (flex -> "FLEX"). */
export function slotFamily(slot: string): string {
  return BASE_STARTING.has(slot) ? slot : "FLEX";
}

export interface MatchCandidate {
  id: string;
  /** every position this player can be started at (position + eligible_positions) */
  positions: string[];
}

export interface SlotMatchResult {
  /** slot index -> candidate id */
  assignment: Map<number, string>;
  /** slot indices left unfilled by any eligible candidate */
  unfilled: number[];
}

/**
 * Maximum-cardinality bipartite matching of candidates to starting slots by
 * eligibility (Kuhn's augmenting paths). Deterministic: candidates and slots are
 * tried in the given order. This is the ONE place structural fieldability of a
 * lineup is decided — lineup / matchup / positional-needs all consume it rather
 * than re-interpreting FLEX.
 */
export function maxSlotMatching(slotLabels: string[], candidates: MatchCandidate[]): SlotMatchResult {
  const slotOK = slotLabels.map((label) => {
    const elig = new Set(slotEligiblePositions(label));
    return (c: MatchCandidate) => c.positions.some((p) => elig.has(p));
  });
  const slotOfCand = new Array<number>(candidates.length).fill(-1); // candidate -> slot
  const candOfSlot = new Array<number>(slotLabels.length).fill(-1); // slot -> candidate

  const tryAugment = (ci: number, seen: boolean[]): boolean => {
    for (let s = 0; s < slotLabels.length; s += 1) {
      if (seen[s] || !slotOK[s]!(candidates[ci]!)) continue;
      seen[s] = true;
      if (candOfSlot[s] === -1 || tryAugment(candOfSlot[s]!, seen)) {
        candOfSlot[s] = ci;
        slotOfCand[ci] = s;
        return true;
      }
    }
    return false;
  };

  for (let ci = 0; ci < candidates.length; ci += 1) {
    tryAugment(ci, new Array(slotLabels.length).fill(false));
  }

  const assignment = new Map<number, string>();
  const unfilled: number[] = [];
  for (let s = 0; s < slotLabels.length; s += 1) {
    if (candOfSlot[s] === -1) unfilled.push(s);
    else assignment.set(s, candidates[candOfSlot[s]!]!.id);
  }
  return { assignment, unfilled };
}
