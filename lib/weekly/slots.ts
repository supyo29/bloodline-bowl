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
