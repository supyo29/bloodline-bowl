/**
 * Draft-night domain logic: which draft is live, what each roster still needs,
 * and which players remain available.
 *
 * Pure functions — no HTTP — so the roster/needs math is testable directly.
 */

import type {
  DraftAcquisition,
  DraftTeam,
  NormalizedPlayer,
  RawDraft,
  RawDraftPick,
  RawLeagueUser,
  RawRoster,
} from "./types";
import type { PlayerIndex } from "./client";
import { computeBudget } from "./budget";
import {
  eligibilityOf,
  emptyEligibilityDiagnostics,
  recordEligibility,
  type EligibilityDiagnostics,
} from "./eligibility";

export { isCurrentlyDraftable, eligibilityOf } from "./eligibility";

/** Slots that are not part of the required starting lineup. */
const BENCH_SLOTS = new Set(["BN", "IR", "TAXI"]);

/** Flex slots and the positions each one accepts. */
const FLEX_ELIGIBILITY: Record<string, string[]> = {
  FLEX: ["RB", "WR", "TE"],
  WRRB_FLEX: ["RB", "WR"],
  WRRB_WRT: ["RB", "WR", "TE"],
  REC_FLEX: ["WR", "TE"],
  SUPER_FLEX: ["QB", "RB", "WR", "TE"],
  IDP_FLEX: ["DL", "LB", "DB"],
};

export function isFlexSlot(slot: string): boolean {
  return slot in FLEX_ELIGIBILITY;
}

export function isBenchSlot(slot: string): boolean {
  return BENCH_SLOTS.has(slot);
}

/** Strict starting slots: not bench, not flex. */
export function strictStartingSlots(rosterPositions: string[]): string[] {
  return rosterPositions.filter(
    (slot) => !isBenchSlot(slot) && !isFlexSlot(slot),
  );
}

export function flexSlots(rosterPositions: string[]): string[] {
  return rosterPositions.filter(isFlexSlot);
}

export function benchSlots(rosterPositions: string[]): string[] {
  return rosterPositions.filter(isBenchSlot);
}

/** The positions a player can fill, preferring Sleeper's fantasy_positions. */
export function eligiblePositions(player: NormalizedPlayer): string[] {
  if (player.fantasy_positions.length > 0) return player.fantasy_positions;
  return player.position ? [player.position] : [];
}

function playerFillsSlot(player: NormalizedPlayer, slot: string): boolean {
  const eligible = eligiblePositions(player);
  const accepted = FLEX_ELIGIBILITY[slot];
  if (accepted) return eligible.some((position) => accepted.includes(position));
  return eligible.includes(slot);
}

/**
 * Every position this league can actually draft, derived from its own roster
 * positions (flex slots expanded to the positions they accept).
 */
export function draftablePositions(rosterPositions: string[]): Set<string> {
  const positions = new Set<string>();
  for (const slot of rosterPositions) {
    if (isBenchSlot(slot)) continue;
    const accepted = FLEX_ELIGIBILITY[slot];
    if (accepted) {
      for (const position of accepted) positions.add(position);
    } else {
      positions.add(slot);
    }
  }
  return positions;
}

export interface RosterNeeds {
  /** Strict starting slots still unfilled — a genuine "must draft a TE". */
  required: Array<{ position: string; minimum_needed: number }>;
  /** Flex slots not yet covered by a surplus player. */
  flexible_slots_remaining: number;
  bench_slots_remaining: number;
  /** Strict starting slots already covered. */
  starters_filled: number;
  starters_required: number;
}

/**
 * Assign acquired players to starting slots, then report what is still needed.
 *
 * Uses a most-constrained-first greedy match so a multi-position player is not
 * wasted on a slot that a single-position player could have filled. Strict
 * slots are filled before flex slots, since a flex slot can be covered by the
 * surplus but not the other way around.
 *
 * Deliberately does NOT report a flex-eligible position as "required" — a team
 * with two RBs and an empty FLEX does not need a third RB specifically.
 */
export function computeRosterNeeds(
  players: NormalizedPlayer[],
  rosterPositions: string[],
): RosterNeeds {
  const strict = strictStartingSlots(rosterPositions);
  const flex = flexSlots(rosterPositions);
  const bench = benchSlots(rosterPositions);

  const unassigned = new Set(players.map((_, index) => index));

  const fillSlots = (slots: string[]): string[] => {
    const remaining = [...slots];
    const unfilled: string[] = [];

    while (remaining.length > 0) {
      // Most-constrained slot first: the one with the fewest candidates.
      let bestSlotIndex = -1;
      let bestCandidates: number[] = [];

      for (let i = 0; i < remaining.length; i += 1) {
        const slot = remaining[i] as string;
        const candidates = [...unassigned].filter((playerIndex) =>
          playerFillsSlot(players[playerIndex] as NormalizedPlayer, slot),
        );
        if (bestSlotIndex === -1 || candidates.length < bestCandidates.length) {
          bestSlotIndex = i;
          bestCandidates = candidates;
        }
      }

      const slot = remaining.splice(bestSlotIndex, 1)[0] as string;
      if (bestCandidates.length === 0) {
        unfilled.push(slot);
        continue;
      }

      // Spend the least flexible player that fits.
      bestCandidates.sort(
        (a, b) =>
          eligiblePositions(players[a] as NormalizedPlayer).length -
          eligiblePositions(players[b] as NormalizedPlayer).length,
      );
      unassigned.delete(bestCandidates[0] as number);
    }

    return unfilled;
  };

  const unfilledStrict = fillSlots(strict);
  const unfilledFlex = fillSlots(flex);

  const requiredCounts = new Map<string, number>();
  for (const slot of unfilledStrict) {
    requiredCounts.set(slot, (requiredCounts.get(slot) ?? 0) + 1);
  }

  return {
    required: [...requiredCounts.entries()]
      .map(([position, minimum_needed]) => ({ position, minimum_needed }))
      .sort((a, b) => a.position.localeCompare(b.position)),
    flexible_slots_remaining: unfilledFlex.length,
    // Bench is pure capacity: any surplus player fills it.
    bench_slots_remaining: Math.max(0, bench.length - unassigned.size),
    starters_filled: strict.length - unfilledStrict.length,
    starters_required: strict.length,
  };
}

/** Count acquired players by primary position. */
export function positionCounts(
  players: NormalizedPlayer[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const player of players) {
    const position = player.position ?? "UNKNOWN";
    counts[position] = (counts[position] ?? 0) + 1;
  }
  return counts;
}

/* -------------------------------------------------------------------------- */
/* Draft selection                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Choose the draft this endpoint should report on: an in-progress draft first,
 * then the nearest upcoming one, then the most recent completed one.
 */
export function selectActiveDraft(drafts: RawDraft[]): RawDraft | null {
  if (drafts.length === 0) return null;

  const bySeasonDesc = [...drafts].sort((a, b) =>
    b.season.localeCompare(a.season),
  );

  return (
    bySeasonDesc.find((draft) => draft.status === "drafting") ??
    bySeasonDesc.find((draft) => draft.status === "paused") ??
    bySeasonDesc.find((draft) => draft.status === "pre_draft") ??
    bySeasonDesc[0] ??
    null
  );
}

/* -------------------------------------------------------------------------- */
/* Auction prices                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Read the winning bid from a pick.
 *
 * Sleeper puts the auction price in `metadata.amount` as a string. This field
 * is NOT in Sleeper's published documentation, so it is parsed defensively and
 * a missing value yields `null` rather than a fabricated price.
 */
export function parsePickPrice(pick: RawDraftPick): number | null {
  const amount = pick.metadata?.amount;
  if (typeof amount !== "string" || amount.trim() === "") return null;
  const parsed = Number.parseInt(amount, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

/* -------------------------------------------------------------------------- */
/* Available players                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Minimum candidates guaranteed per required starting position in an unfiltered
 * response. Sleeper leaves `search_rank` null on all 32 team defenses, so a
 * purely rank-ordered list would never surface a DEF — even though this league
 * must start one. Kickers are similarly sparse.
 */
export const MIN_PER_REQUIRED_POSITION = 5;

export interface AvailablePlayerOptions {
  playerIndex: PlayerIndex;
  /** Player ids already drafted or already rostered. */
  takenPlayerIds: ReadonlySet<string>;
  rosterPositions: string[];
  /** Optional single-position filter from the query string. */
  position?: string | null;
  limit: number;
}

/** The distinct positions this league requires in its strict starting lineup. */
export function requiredStartingPositions(
  rosterPositions: string[],
): Set<string> {
  return new Set(strictStartingSlots(rosterPositions));
}

/**
 * Aggregated availability diagnostics for one pool build. Additive to the
 * `/api/draft` response; lets an operator detect future Sleeper-data
 * contamination without a per-player debug dump.
 */
export interface AvailabilityDiagnostics extends EligibilityDiagnostics {
  /** Records already drafted or rostered (excluded before eligibility). */
  already_drafted_count: number;
  /** malformed + unsupported_position + inactive + missing_team. */
  stale_or_invalid_player_count: number;
  /** Eligible records whose position this league cannot draft (e.g. K in a K-less league). */
  eligible_but_not_league_position: number;
  /** Final count offered for this league (after league-position + query filters, before `limit`). */
  league_candidate_count: number;
}

/**
 * The remaining player pool, ordered by Sleeper's own `search_rank`, plus
 * aggregated integrity diagnostics.
 *
 * Eligibility is delegated wholesale to `isCurrentlyDraftable` /
 * `eligibilityOf` (`lib/sleeper/eligibility.ts`) — the single source of truth
 * shared with the bridge board, manager recommendations, and the projection
 * pool. This function only adds the league-position scoping, the `search_rank`
 * ordering, and the DEF/K coverage guarantee.
 *
 * No proprietary rankings are invented: `search_rank` is Sleeper's relevance
 * ordering, and players without one sort last (alphabetically, for stability).
 */
export function buildAvailablePlayerPool(options: AvailablePlayerOptions): {
  players: NormalizedPlayer[];
  diagnostics: AvailabilityDiagnostics;
} {
  const { playerIndex, takenPlayerIds, rosterPositions, position, limit } =
    options;

  const draftable = draftablePositions(rosterPositions);
  const wanted = position ? position.toUpperCase() : null;

  const eligDiag = emptyEligibilityDiagnostics();
  let alreadyDrafted = 0;
  let eligibleButNotLeaguePosition = 0;

  const candidates: NormalizedPlayer[] = [];
  for (const player of playerIndex.values()) {
    if (takenPlayerIds.has(player.player_id)) {
      alreadyDrafted += 1;
      continue;
    }

    const positionsOf = eligiblePositions(player);
    // A record is "fantasy-relevant to this league" if its claimed position is
    // one the league can draft. Sleeper's dump is mostly OL / IDP / practice-squad
    // records that no standard-lineup league drafts; folding those into the
    // integrity counts would bury the signal (`missing_team` must read as
    // "teamless player who WOULD otherwise be a candidate here").
    //
    // `eligibilityOf` needs the RAW record, so we still classify it for the
    // exclusion reason — we just only *count* fantasy-relevant records, plus
    // malformed ones (a small, always-interesting bucket).
    const positionRelevant = positionsOf.some((slot) => draftable.has(slot));

    const verdict = eligibilityOf(player);
    if (positionRelevant || verdict.reason === "malformed") {
      recordEligibility(eligDiag, verdict);
    }

    if (!verdict.eligible) continue;

    if (!positionRelevant) {
      eligibleButNotLeaguePosition += 1;
      continue;
    }
    if (wanted && !positionsOf.includes(wanted)) continue;

    candidates.push(player);
  }

  // "stale / invalid" = a record that claims to be a current fantasy player but
  // is not one. `unsupported_position` is a correct classification, not
  // contamination, so it is reported separately and not summed here.
  const staleOrInvalid =
    eligDiag.excluded_by_reason.malformed +
    eligDiag.excluded_by_reason.inactive +
    eligDiag.excluded_by_reason.missing_team;

  const diagnostics: AvailabilityDiagnostics = {
    ...eligDiag,
    already_drafted_count: alreadyDrafted,
    stale_or_invalid_player_count: staleOrInvalid,
    eligible_but_not_league_position: eligibleButNotLeaguePosition,
    league_candidate_count: candidates.length,
  };

  candidates.sort((a, b) => {
    const rankA = a.search_rank ?? Number.MAX_SAFE_INTEGER;
    const rankB = b.search_rank ?? Number.MAX_SAFE_INTEGER;
    if (rankA !== rankB) return rankA - rankB;
    return a.full_name.localeCompare(b.full_name);
  });

  if (candidates.length <= limit) return { players: candidates, diagnostics };

  // Already narrowed to one position: a straight rank cut is what was asked for.
  if (wanted) return { players: candidates.slice(0, limit), diagnostics };

  const selected = new Set<string>();

  // Pass 1: round-robin a guaranteed allotment across required positions, so a
  // rank-less but startable position (DEF) always appears.
  const positions = [...requiredStartingPositions(rosterPositions)].sort();
  const coverageBudget = Math.min(
    limit,
    positions.length * MIN_PER_REQUIRED_POSITION,
  );
  const cursors = new Map(positions.map((slot) => [slot, 0]));

  for (let round = 0; round < MIN_PER_REQUIRED_POSITION; round += 1) {
    for (const slot of positions) {
      if (selected.size >= coverageBudget) break;
      let cursor = cursors.get(slot) ?? 0;
      while (cursor < candidates.length) {
        const candidate = candidates[cursor] as NormalizedPlayer;
        cursor += 1;
        if (selected.has(candidate.player_id)) continue;
        if (!eligiblePositions(candidate).includes(slot)) continue;
        selected.add(candidate.player_id);
        break;
      }
      cursors.set(slot, cursor);
    }
  }

  // Pass 2: fill everything else strictly by rank.
  for (const candidate of candidates) {
    if (selected.size >= limit) break;
    selected.add(candidate.player_id);
  }

  // Return in rank order regardless of which pass selected each player.
  return {
    players: candidates.filter((candidate) => selected.has(candidate.player_id)),
    diagnostics,
  };
}

/**
 * Back-compatible shim: the remaining player pool as a plain array, ordered by
 * Sleeper `search_rank`. Existing callers and tests keep working unchanged; new
 * callers that want the integrity diagnostics use `buildAvailablePlayerPool`.
 */
export function buildAvailablePlayers(
  options: AvailablePlayerOptions,
): NormalizedPlayer[] {
  return buildAvailablePlayerPool(options).players;
}

/* -------------------------------------------------------------------------- */
/* Team assembly                                                               */
/* -------------------------------------------------------------------------- */

export interface AssembleTeamsInput {
  rosters: RawRoster[];
  usersById: Map<string, RawLeagueUser>;
  /** Completed acquisitions grouped by the roster that won them. */
  acquisitionsByRoster: Map<number, DraftAcquisition[]>;
  slotByRosterId: Map<number, number>;
  slotsRequired: number;
  /** Null for non-auction drafts, which get no budget block. */
  startingBudget: number | null;
  minimumBid: number;
  rosterPositions: string[];
}

/**
 * Build the per-team draft view: acquisitions, budget position, and needs.
 *
 * Pure so the whole team-level pipeline — spend accumulation, max-bid math, and
 * needs — can be exercised against a simulated mid-auction in tests.
 */
export function assembleDraftTeams(input: AssembleTeamsInput): DraftTeam[] {
  const {
    rosters,
    usersById,
    acquisitionsByRoster,
    slotByRosterId,
    slotsRequired,
    startingBudget,
    minimumBid,
    rosterPositions,
  } = input;

  return rosters
    .map((roster): DraftTeam => {
      const owned = acquisitionsByRoster.get(roster.roster_id) ?? [];
      const ownedPlayers = owned
        .map((acquisition) => acquisition.player)
        .filter((player): player is NormalizedPlayer => player !== null);

      // A pick with an unknown price contributes 0 rather than NaN.
      const spent = owned.reduce(
        (sum, acquisition) => sum + (acquisition.price ?? 0),
        0,
      );

      const budget =
        startingBudget !== null
          ? computeBudget({
              startingBudget,
              spent,
              slotsRequired,
              slotsFilled: owned.length,
              minimumBid,
            })
          : null;

      const user = roster.owner_id ? usersById.get(roster.owner_id) : undefined;

      return {
        roster_id: roster.roster_id,
        draft_slot: slotByRosterId.get(roster.roster_id) ?? null,
        manager: {
          user_id: roster.owner_id ?? null,
          display_name: user?.display_name ?? null,
          team_name: (user?.metadata?.team_name as string | undefined) ?? null,
          is_vacant: !roster.owner_id,
        },
        players_acquired: owned.map((acquisition) => ({
          player_id: acquisition.player?.player_id ?? "",
          full_name: acquisition.player?.full_name ?? "",
          position: acquisition.player?.position ?? null,
          team: acquisition.player?.team ?? null,
          price: acquisition.price,
          pick_no: acquisition.pick_no,
        })),
        roster: {
          players_acquired: owned.length,
          slots_required: slotsRequired,
          slots_remaining: Math.max(0, slotsRequired - owned.length),
        },
        budget: budget
          ? {
              starting: budget.starting,
              spent: budget.spent,
              remaining: budget.remaining,
              minimum_required_for_remaining_slots:
                budget.minimum_required_for_remaining_slots,
              maximum_single_bid: budget.maximum_single_bid,
              can_bid: budget.can_bid,
            }
          : null,
        positions: positionCounts(ownedPlayers),
        needs: computeRosterNeeds(ownedPlayers, rosterPositions),
      };
    })
    .sort((a, b) => a.roster_id - b.roster_id);
}
