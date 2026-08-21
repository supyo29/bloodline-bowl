/**
 * Deterministic structural roster analysis: composition, age, and auction
 * spend — facts and formula-backed derived metrics only. FLEX/SUPER_FLEX
 * handling and starting-slot coverage reuse the exact logic already built and
 * tested for `/api/draft`, so there is one implementation of "what counts as
 * a filled slot" across the whole bridge.
 */

import {
  computeRosterNeeds,
  eligiblePositions,
  flexSlots,
  positionCounts,
  strictStartingSlots,
} from "@/lib/sleeper/draft";
import type { NormalizedPlayer } from "@/lib/sleeper/types";

export interface RosterComposition {
  player_count: number;
  players_by_position: Record<string, number>;
  players_by_team: Record<string, number>;
  starter_count: number;
  bench_count: number;
  taxi_count: number;
  reserve_count: number;
  open_roster_slots: number;
}

export interface AgeFacts {
  average_age: number | null;
  median_age: number | null;
  age_by_position: Record<string, number | null>;
  years_experience_distribution: Record<string, number>;
}

export interface SlotCoverage {
  required_slots: Record<string, number>;
  flex_slot_count: number;
  current_counts: Record<string, number>;
  strict_slots_filled: Array<{ position: string; minimum_needed: number }>;
  flexible_slots_remaining: number;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? round2(((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2)
    : (sorted[mid] as number);
}

export function buildRosterComposition(
  allPlayers: NormalizedPlayer[],
  starters: NormalizedPlayer[],
  bench: NormalizedPlayer[],
  taxi: NormalizedPlayer[],
  reserve: NormalizedPlayer[],
  totalRosterSlots: number,
): RosterComposition {
  const byTeam: Record<string, number> = {};
  for (const player of allPlayers) {
    const team = player.team ?? "UNKNOWN";
    byTeam[team] = (byTeam[team] ?? 0) + 1;
  }

  return {
    player_count: allPlayers.length,
    players_by_position: positionCounts(allPlayers),
    players_by_team: byTeam,
    starter_count: starters.length,
    bench_count: bench.length,
    taxi_count: taxi.length,
    reserve_count: reserve.length,
    open_roster_slots: Math.max(0, totalRosterSlots - allPlayers.length),
  };
}

export function buildAgeFacts(allPlayers: NormalizedPlayer[]): AgeFacts {
  const ages = allPlayers
    .map((player) => player.age)
    .filter((age): age is number => typeof age === "number");

  const byPosition = new Map<string, number[]>();
  for (const player of allPlayers) {
    if (typeof player.age !== "number") continue;
    const position = player.position ?? "UNKNOWN";
    const bucket = byPosition.get(position) ?? [];
    bucket.push(player.age);
    byPosition.set(position, bucket);
  }
  const ageByPosition: Record<string, number | null> = {};
  for (const [position, values] of byPosition) {
    ageByPosition[position] = round2(
      values.reduce((sum, v) => sum + v, 0) / values.length,
    );
  }

  const experienceBuckets: Record<string, number> = {};
  for (const player of allPlayers) {
    if (typeof player.years_exp !== "number") continue;
    const key = player.years_exp === 0 ? "rookie" : `${player.years_exp}_years`;
    experienceBuckets[key] = (experienceBuckets[key] ?? 0) + 1;
  }

  return {
    average_age:
      ages.length > 0
        ? round2(ages.reduce((sum, v) => sum + v, 0) / ages.length)
        : null,
    median_age: median(ages),
    age_by_position: ageByPosition,
    years_experience_distribution: experienceBuckets,
  };
}

/**
 * Starting-lineup slot coverage, delegating FLEX/SUPER_FLEX-aware matching to
 * {@link computeRosterNeeds} — the same function `/api/draft` uses, so a
 * roster is never described as "needing a WR" merely because a flex slot is
 * open (see that module's docstring for the full rationale).
 */
export function buildSlotCoverage(
  allPlayers: NormalizedPlayer[],
  rosterPositions: string[],
): SlotCoverage {
  const strict = strictStartingSlots(rosterPositions);
  const requiredCounts: Record<string, number> = {};
  for (const slot of strict)
    requiredCounts[slot] = (requiredCounts[slot] ?? 0) + 1;

  const currentCounts: Record<string, number> = {};
  for (const player of allPlayers) {
    for (const position of eligiblePositions(player)) {
      currentCounts[position] = (currentCounts[position] ?? 0) + 1;
    }
  }

  const needs = computeRosterNeeds(allPlayers, rosterPositions);

  return {
    required_slots: requiredCounts,
    flex_slot_count: flexSlots(rosterPositions).length,
    current_counts: currentCounts,
    strict_slots_filled: needs.required, // unfilled strict slots, per the shared engine
    flexible_slots_remaining: needs.flexible_slots_remaining,
  };
}

export interface AuctionSpendFacts {
  total_spend: number | null;
  average_acquisition_cost: number | null;
  spend_by_position: Record<string, number>;
  remaining_budget: number | null;
}

/** Auction spend facts from a roster's own completed draft picks (price -> null when unknown). */
export function buildAuctionSpendFacts(
  acquisitions: Array<{
    player: NormalizedPlayer | null;
    price: number | null;
  }>,
  startingBudget: number | null,
): AuctionSpendFacts {
  const priced = acquisitions.filter(
    (a): a is { player: NormalizedPlayer; price: number } =>
      a.player !== null && typeof a.price === "number",
  );

  if (priced.length === 0) {
    return {
      total_spend: null,
      average_acquisition_cost: null,
      spend_by_position: {},
      remaining_budget: startingBudget,
    };
  }

  const totalSpend = priced.reduce((sum, a) => sum + a.price, 0);
  const spendByPosition: Record<string, number> = {};
  for (const { player, price } of priced) {
    const position = player.position ?? "UNKNOWN";
    spendByPosition[position] = (spendByPosition[position] ?? 0) + price;
  }

  return {
    total_spend: round2(totalSpend),
    average_acquisition_cost: round2(totalSpend / priced.length),
    spend_by_position: spendByPosition,
    remaining_budget:
      startingBudget !== null ? round2(startingBudget - totalSpend) : null,
  };
}
