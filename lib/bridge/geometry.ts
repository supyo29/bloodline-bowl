/**
 * Draft geometry — league-specific pick math.
 *
 * Pure functions. Every value is derived from the ACTIVE league's own slot,
 * team count, and round count — nothing here is hardcoded to one league.
 *
 * Only snake and linear orders are modeled. Auction drafts have no fixed pick
 * order, so `snakePicksForSlot` is not meaningful for them and callers should
 * gate on `draft.type`.
 */

export interface DraftGeometryInput {
  /** 1-indexed draft slot. */
  slot: number;
  /** Teams in the draft (picks per round). */
  teamCount: number;
  rounds: number;
  /**
   * Count of picks already made across the whole draft (any team). Used to
   * work out which of this slot's picks is "next".
   */
  overallPicksMade: number;
  /** "snake" reverses every even round; "linear" keeps slot order every round. */
  order?: "snake" | "linear";
}

export interface SlotPick {
  round: number;
  /** 1-indexed overall pick number. */
  overall: number;
}

export interface DraftGeometry {
  slot: number;
  team_count: number;
  rounds: number;
  order: "snake" | "linear";
  /** Every overall pick number this slot owns, in draft order. */
  all_picks: SlotPick[];
  /** This slot's next upcoming pick, or null when the slot is done. */
  next_pick: SlotPick | null;
  /** The pick after `next_pick`, or null. */
  following_pick: SlotPick | null;
  /** Overall picks by other teams between now and `next_pick` (0 if on the clock). */
  picks_until_next: number;
  /** Overall picks between `next_pick` and `following_pick` (the "wait"). */
  wait_after_next: number | null;
  /** 1-indexed round `next_pick` falls in, or null. */
  current_round: number | null;
  /** How many of this slot's own picks are already spent. */
  own_picks_made: number;
}

/**
 * The overall pick number a slot holds in a given round.
 *
 * Round 1 counts up from slot 1; in a snake draft every even round counts back
 * down. A linear draft keeps the same slot order every round.
 */
export function overallPickNumber(
  slot: number,
  round: number,
  teamCount: number,
  order: "snake" | "linear" = "snake",
): number {
  const base = (round - 1) * teamCount;
  if (order === "linear" || round % 2 === 1) {
    return base + slot;
  }
  return base + (teamCount - slot + 1);
}

export function computeDraftGeometry(input: DraftGeometryInput): DraftGeometry {
  const order = input.order ?? "snake";
  const slot = Math.trunc(input.slot);
  const teamCount = Math.trunc(input.teamCount);
  const rounds = Math.trunc(input.rounds);

  if (
    !Number.isFinite(slot) ||
    slot < 1 ||
    !Number.isFinite(teamCount) ||
    teamCount < 1 ||
    slot > teamCount ||
    !Number.isFinite(rounds) ||
    rounds < 1
  ) {
    throw new Error(
      `Invalid draft geometry: slot ${input.slot}, teams ${input.teamCount}, rounds ${input.rounds}.`,
    );
  }

  const picksMade = Math.max(0, Math.trunc(input.overallPicksMade) || 0);

  const allPicks: SlotPick[] = [];
  for (let round = 1; round <= rounds; round += 1) {
    allPicks.push({
      round,
      overall: overallPickNumber(slot, round, teamCount, order),
    });
  }

  const nextIndex = allPicks.findIndex((pick) => pick.overall > picksMade);
  const nextPick = nextIndex === -1 ? null : (allPicks[nextIndex] as SlotPick);
  const followingPick =
    nextIndex === -1 || nextIndex + 1 >= allPicks.length
      ? null
      : (allPicks[nextIndex + 1] as SlotPick);

  return {
    slot,
    team_count: teamCount,
    rounds,
    order,
    all_picks: allPicks,
    next_pick: nextPick,
    following_pick: followingPick,
    picks_until_next: nextPick ? Math.max(0, nextPick.overall - 1 - picksMade) : 0,
    wait_after_next:
      nextPick && followingPick
        ? followingPick.overall - nextPick.overall - 1
        : null,
    current_round: nextPick ? nextPick.round : null,
    own_picks_made: nextPick
      ? nextIndex
      : allPicks.length,
  };
}
