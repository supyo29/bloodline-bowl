/**
 * Phase 2 — structural flags. DETERMINISTIC facts about current-state risk.
 * Never a recommendation. Every flag carries reason-coded `facts`.
 */

import type { CanonicalRoster } from "@/lib/canonical/schema";
import type { StructuralFlag, TeamStatePlayer } from "./schema";
import {
  eligibleForKey,
  leagueSlotKeys,
  maxSlotMatching,
  requiredStarters,
  startablePositions,
  type MatchCandidate,
} from "./slots";

export interface FlagInput {
  startingSlots: string[];
  players: TeamStatePlayer[];
  roster: CanonicalRoster;
  activeCapacity: number | null; // starting_slots.length + bench_slots, or null
  scheduleReady: boolean;
  startersOnBye: string[]; // canonical ids
  /** canonical id -> set of REMAINING weeks (incl. this) that player's NFL team is on a schedule-verified bye. */
  byeWeeksByPlayer: Map<string, number[]>;
}

function candidatesOf(players: TeamStatePlayer[]): MatchCandidate[] {
  return players.map((p) => ({ id: p.canonical_player_id, positions: startablePositions(p) }));
}

export function computeStructuralFlags(input: FlagInput): StructuralFlag[] {
  const { startingSlots, players, roster, activeCapacity, scheduleReady } = input;
  const flags: StructuralFlag[] = [];
  const byId = new Map(players.map((p) => [p.canonical_player_id, p]));
  const reserve = new Set([...roster.ir, ...roster.taxi]);
  const active = roster.all_players
    .filter((id) => !reserve.has(id))
    .map((id) => byId.get(id))
    .filter((p): p is TeamStatePlayer => Boolean(p));
  const irPlayers = roster.ir.map((id) => byId.get(id)).filter((p): p is TeamStatePlayer => Boolean(p));

  const keys = leagueSlotKeys(startingSlots);
  const baseMatch = maxSlotMatching(startingSlots, candidatesOf(active));
  const unfilledIdx = baseMatch.unfilled;

  /* ---- UNFILLED_STARTER_SLOT : canonical roster has an empty starting slot */
  const emptyStartingSlots = roster.slots
    .filter((s) => s.is_empty && s.slot !== "BN" && s.slot !== "IR" && s.slot !== "TAXI")
    .map((s) => s.slot);
  if (emptyStartingSlots.length > 0) {
    flags.push({
      code: "UNFILLED_STARTER_SLOT",
      severity: "critical",
      positions: [...new Set(emptyStartingSlots)],
      player_ids: [],
      message: `${emptyStartingSlots.length} starting slot(s) currently have no player assigned: ${emptyStartingSlots.join(", ")}.`,
      facts: { empty_slots: emptyStartingSlots, count: emptyStartingSlots.length },
    });
  }

  /* ---- ILLEGAL_CURRENT_LINEUP : ACTIVE players cannot fill every starting slot */
  if (unfilledIdx.length > 0) {
    const unfillable = [...new Set(unfilledIdx.map((i) => startingSlots[i]!))];
    flags.push({
      code: "ILLEGAL_CURRENT_LINEUP",
      severity: "critical",
      positions: unfillable,
      player_ids: [],
      message: `The active roster cannot structurally field a legal lineup — ${unfilledIdx.length} slot(s) unfillable: ${unfillable.join(", ")}.`,
      facts: { unfillable_slots: unfillable, unfillable_count: unfilledIdx.length },
    });
  }

  /* ---- NO_ACTIVE_BACKUP : a base key that exactly meets its requirement, 0 spare */
  for (const key of keys) {
    if (requiredStarters(startingSlots, key) === 0) continue;
    const required = requiredStarters(startingSlots, key);
    const activeEligible = active.filter((p) => eligibleForKey(startablePositions(p), key));
    if (activeEligible.length === required && required > 0) {
      flags.push({
        code: "NO_ACTIVE_BACKUP",
        severity: "warning",
        positions: [key],
        player_ids: activeEligible.map((p) => p.canonical_player_id),
        message: `${key}: exactly ${required} active eligible player(s) for ${required} starter slot(s) — zero active backup.`,
        facts: { slot_key: key, required, active_eligible: activeEligible.length },
      });
    }
  }

  /* ---- SINGLE_POINT_OF_FAILURE : one active player is load-bearing for 2+ keys */
  for (const p of active) {
    const without = maxSlotMatching(
      startingSlots,
      candidatesOf(active.filter((q) => q.canonical_player_id !== p.canonical_player_id)),
    );
    const newlyUnfilled = without.unfilled.length - baseMatch.unfilled.length;
    if (newlyUnfilled <= 0) continue;
    const affectedKeys = [
      ...new Set(without.unfilled.map((i) => startingSlots[i]!)),
    ].filter((k) => !unfilledIdx.map((i) => startingSlots[i]!).includes(k));
    const familiesCovered = [...new Set(startablePositions(p))].filter((pos) =>
      keys.includes(pos) || keys.some((k) => eligibleForKey([pos], k)),
    );
    if (affectedKeys.length >= 2 || (affectedKeys.length >= 1 && familiesCovered.length >= 2)) {
      flags.push({
        code: "SINGLE_POINT_OF_FAILURE",
        severity: "warning",
        positions: affectedKeys,
        player_ids: [p.canonical_player_id],
        message: `${p.full_name} is the only active player covering ${affectedKeys.join(" + ")} — losing them breaks the lineup.`,
        facts: {
          player: p.full_name,
          slot_keys_broken: affectedKeys,
          eligible_positions: startablePositions(p),
        },
      });
    }
  }

  /* ---- CURRENT_WEEK_BYE_GAP : removing bye starters leaves a slot unfillable */
  if (scheduleReady && input.startersOnBye.length > 0) {
    const availableThisWeek = active.filter((p) => !input.startersOnBye.includes(p.canonical_player_id));
    const byeMatch = maxSlotMatching(startingSlots, candidatesOf(availableThisWeek));
    const extraUnfilled = byeMatch.unfilled.length - baseMatch.unfilled.length;
    if (extraUnfilled > 0) {
      const gapKeys = [...new Set(byeMatch.unfilled.map((i) => startingSlots[i]!))];
      flags.push({
        code: "CURRENT_WEEK_BYE_GAP",
        severity: "warning",
        positions: gapKeys,
        player_ids: input.startersOnBye,
        message: `Current-week byes leave ${extraUnfilled} starting slot(s) without an eligible active fill: ${gapKeys.join(", ")}.`,
        facts: { gap_slots: gapKeys, bye_starters: input.startersOnBye, extra_unfilled: extraUnfilled },
      });
    }
  }

  /* ---- SHARED_BYE_WEEK : 2+ active players at the same key share a bye week */
  if (input.byeWeeksByPlayer.size > 0) {
    const weekBuckets = new Map<number, TeamStatePlayer[]>();
    for (const p of active) {
      for (const w of input.byeWeeksByPlayer.get(p.canonical_player_id) ?? []) {
        const bucket = weekBuckets.get(w) ?? [];
        bucket.push(p);
        weekBuckets.set(w, bucket);
      }
    }
    for (const [week, group] of weekBuckets) {
      if (group.length < 2) continue;
      // Only flag when the shared bye actually pressures a key.
      for (const key of keys) {
        const required = requiredStarters(startingSlots, key);
        if (required === 0) continue;
        const atKey = group.filter((p) => eligibleForKey(startablePositions(p), key));
        const totalActiveAtKey = active.filter((p) => eligibleForKey(startablePositions(p), key)).length;
        if (atKey.length >= 2 && totalActiveAtKey - atKey.length < required) {
          flags.push({
            code: "SHARED_BYE_WEEK",
            severity: "info",
            positions: [key],
            player_ids: atKey.map((p) => p.canonical_player_id),
            message: `Week ${week}: ${atKey.length} active ${key}-eligible players share a bye, dropping below the ${required} starter requirement.`,
            facts: { week, slot_key: key, shared: atKey.map((p) => p.full_name), required },
          });
        }
      }
    }
  }

  /* ---- IR_DEPTH_REDUCTION : an IR player whose position is bare/broken while active */
  for (const p of irPlayers) {
    for (const key of startablePositions(p)) {
      if (!keys.includes(key)) continue;
      const required = requiredStarters(startingSlots, key);
      if (required === 0) continue;
      const activeEligible = active.filter((q) => eligibleForKey(startablePositions(q), key)).length;
      if (activeEligible <= required) {
        flags.push({
          code: "IR_DEPTH_REDUCTION",
          severity: "info",
          positions: [key],
          player_ids: [p.canonical_player_id],
          message: `${p.full_name} (IR) is depth this roster is missing at ${key} — only ${activeEligible} active eligible for ${required} slot(s).`,
          facts: { player: p.full_name, slot_key: key, active_eligible: activeEligible, required },
        });
        break;
      }
    }
  }

  /* ---- OPEN_ROSTER_SLOT / OVER_ROSTER_LIMIT */
  if (activeCapacity != null) {
    const openSlots = activeCapacity - active.length;
    if (openSlots > 0) {
      flags.push({
        code: "OPEN_ROSTER_SLOT",
        severity: "info",
        positions: [],
        player_ids: [],
        message: `${openSlots} active roster spot(s) open (${active.length}/${activeCapacity}).`,
        facts: { open: openSlots, active: active.length, capacity: activeCapacity },
      });
    } else if (openSlots < 0) {
      flags.push({
        code: "OVER_ROSTER_LIMIT",
        severity: "warning",
        positions: [],
        player_ids: [],
        message: `Active roster is over capacity by ${-openSlots} (${active.length}/${activeCapacity}).`,
        facts: { over_by: -openSlots, active: active.length, capacity: activeCapacity },
      });
    }
  }

  return flags;
}
