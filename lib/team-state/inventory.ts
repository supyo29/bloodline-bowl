/**
 * Phase 2 — positional inventory. PURE COUNTS ONLY. No quality judgement.
 */

import type { CanonicalRoster } from "@/lib/canonical/schema";
import type { PositionInventory, PositionInventoryEntry, TeamStatePlayer } from "./schema";
import {
  eligibleForKey,
  leagueSlotKeys,
  maxSlotMatching,
  requiredStarters,
  slotEligiblePositions,
  startablePositions,
  type MatchCandidate,
} from "./slots";

export function computePositionInventory(
  startingSlots: string[],
  players: TeamStatePlayer[],
  roster: CanonicalRoster,
): PositionInventory {
  const byId = new Map(players.map((p) => [p.canonical_player_id, p]));
  const reserve = new Set([...roster.ir, ...roster.taxi]);
  const activeIds = roster.all_players.filter((id) => !reserve.has(id));
  const activePlayers = activeIds
    .map((id) => byId.get(id))
    .filter((p): p is TeamStatePlayer => Boolean(p));

  // ONE structural matching of active players to the full starting lineup.
  const candidates: MatchCandidate[] = activePlayers.map((p) => ({
    id: p.canonical_player_id,
    positions: startablePositions(p),
  }));
  const match = maxSlotMatching(startingSlots, candidates);
  const filledLabelCount = new Map<string, number>();
  for (const [slotIdx] of match.assignment) {
    const label = startingSlots[slotIdx]!;
    filledLabelCount.set(label, (filledLabelCount.get(label) ?? 0) + 1);
  }

  const rostered_by_position: Record<string, number> = {};
  const active_by_position: Record<string, number> = {};
  for (const p of players) {
    rostered_by_position[p.position] = (rostered_by_position[p.position] ?? 0) + 1;
    if (!reserve.has(p.canonical_player_id)) {
      active_by_position[p.position] = (active_by_position[p.position] ?? 0) + 1;
    }
  }

  const by_key: PositionInventoryEntry[] = leagueSlotKeys(startingSlots).map((key) => {
    const eligiblePlayers = players.filter((p) => eligibleForKey(startablePositions(p), key));
    const activeEligible = eligiblePlayers.filter((p) => !reserve.has(p.canonical_player_id));
    const covered = filledLabelCount.get(key) ?? 0;
    return {
      slot_key: key,
      eligible_positions: slotEligiblePositions(key),
      required_starters: requiredStarters(startingSlots, key),
      rostered: eligiblePlayers.length,
      active: activeEligible.length,
      // players currently ASSIGNED to a starting slot bearing this exact label.
      starting: players.filter((p) => p.roster_slot === "starter" && p.starting_slot_label === key).length,
      benched: activeEligible.filter((p) => p.roster_slot === "bench").length,
      ir: eligiblePlayers.filter((p) => p.roster_slot === "ir").length,
      taxi: eligiblePlayers.filter((p) => p.roster_slot === "taxi").length,
      starter_slots_covered: covered,
      bench_bodies: Math.max(0, activeEligible.length - covered),
    };
  });

  return { by_key, rostered_by_position, active_by_position };
}
