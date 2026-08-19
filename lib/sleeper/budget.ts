/**
 * Auction budget math.
 *
 * Pure functions with no Sleeper or HTTP dependencies so the arithmetic that
 * matters most during live bidding is directly testable.
 */

/**
 * Sleeper does not expose a minimum-bid setting on the draft object, and its
 * auction UI enforces a $1 floor. This is the assumed default; it is surfaced
 * in the response as `budget.minimum_bid` with `minimum_bid_source` so a reader
 * knows it was assumed rather than read from settings.
 */
export const DEFAULT_MINIMUM_BID = 1;

export interface BudgetInput {
  startingBudget: number;
  spent: number;
  slotsRequired: number;
  slotsFilled: number;
  minimumBid: number;
}

export interface BudgetResult {
  starting: number;
  spent: number;
  remaining: number;
  slots_required: number;
  slots_filled: number;
  slots_remaining: number;
  /**
   * Dollars that must be held back to fill every remaining slot *other than*
   * the one currently being bid on: `(slots_remaining - 1) * minimum_bid`.
   */
  minimum_required_for_remaining_slots: number;
  /**
   * The largest bid this roster can place while still being able to fill every
   * remaining slot at the minimum bid.
   */
  maximum_single_bid: number;
  /** False when the roster is full or cannot afford even the minimum bid. */
  can_bid: boolean;
}

/**
 * Compute a roster's live bidding position.
 *
 * maximum_single_bid = remaining - (slots_remaining - 1) * minimum_bid
 *
 * A roster with one slot left can spend everything it has; a roster with six
 * slots left must reserve five minimum bids.
 */
export function computeBudget(input: BudgetInput): BudgetResult {
  const { startingBudget, spent, slotsRequired, slotsFilled, minimumBid } =
    input;

  const remaining = startingBudget - spent;
  const slotsRemaining = Math.max(0, slotsRequired - slotsFilled);

  // With no slots left the roster cannot bid at all, so nothing is reserved.
  const reserved = slotsRemaining > 0 ? (slotsRemaining - 1) * minimumBid : 0;

  const maximumSingleBid =
    slotsRemaining > 0 ? Math.max(0, remaining - reserved) : 0;

  return {
    starting: startingBudget,
    spent,
    remaining,
    slots_required: slotsRequired,
    slots_filled: slotsFilled,
    slots_remaining: slotsRemaining,
    minimum_required_for_remaining_slots: reserved,
    maximum_single_bid: maximumSingleBid,
    can_bid: slotsRemaining > 0 && maximumSingleBid >= minimumBid,
  };
}

/**
 * Can `challenger` top a bid of `amount`? Used to answer "can anyone outbid me
 * at $47" without the caller re-deriving the arithmetic.
 */
export function canOutbid(challenger: BudgetResult, amount: number): boolean {
  return challenger.can_bid && challenger.maximum_single_bid > amount;
}
