/**
 * Phase 2 — structural depth pressure. DETERMINISTIC, PROJECTION-FREE.
 *
 * `level` describes STRUCTURAL slack (how many eligible active bodies back a
 * slot key), never player quality. A key can be `thin` while holding an elite
 * starter, or `none` while holding six replacement-level bodies. Every entry
 * carries a `reason_code` and the raw counts.
 */

import type { CanonicalRoster } from "@/lib/canonical/schema";
import type { DepthPressure, DepthPressureEntry, TeamStatePlayer } from "./schema";
import {
  eligibleForKey,
  isFlexSlot,
  leagueSlotKeys,
  maxSlotMatching,
  requiredStarters,
  slotEligiblePositions,
  startablePositions,
  type MatchCandidate,
} from "./slots";

const LEVEL_RANK = { broken: 0, bare: 1, thin: 2, none: 3 } as const;

export function computeDepthPressure(
  startingSlots: string[],
  players: TeamStatePlayer[],
  roster: CanonicalRoster,
): DepthPressure {
  const byId = new Map(players.map((p) => [p.canonical_player_id, p]));
  const reserve = new Set([...roster.ir, ...roster.taxi]);
  const activePlayers = roster.all_players
    .filter((id) => !reserve.has(id))
    .map((id) => byId.get(id))
    .filter((p): p is TeamStatePlayer => Boolean(p));

  const candidates: MatchCandidate[] = activePlayers.map((p) => ({
    id: p.canonical_player_id,
    positions: startablePositions(p),
  }));
  const baseMatch = maxSlotMatching(startingSlots, candidates);
  const unfilledLabels = new Set(baseMatch.unfilled.map((i) => startingSlots[i]!));

  const by_key: DepthPressureEntry[] = leagueSlotKeys(startingSlots).map((key) => {
    const flex = isFlexSlot(key);
    const required = requiredStarters(startingSlots, key);
    const activeEligible = activePlayers.filter((p) => eligibleForKey(startablePositions(p), key)).length;

    let backup: number;
    if (flex) {
      // Flex backup pool = flex-eligible active bodies, minus the base slots
      // those positions must fill first, minus the flex slots themselves.
      const elig = slotEligiblePositions(key);
      const baseDemand = elig.reduce((s, pos) => s + requiredStarters(startingSlots, pos), 0);
      backup = Math.max(0, activeEligible - baseDemand - required);
    } else {
      backup = Math.max(0, activeEligible - required);
    }

    let level: DepthPressureEntry["level"];
    let reason: DepthPressureEntry["reason_code"];
    if (unfilledLabels.has(key) || activeEligible < required) {
      level = "broken";
      reason = "BELOW_REQUIREMENT";
    } else if (backup === 0) {
      level = "bare";
      reason = "NO_BACKUP";
    } else if (backup === 1 && !flex) {
      level = "thin";
      reason = "SINGLE_BACKUP";
    } else if (flex && backup < Math.max(1, required)) {
      level = "thin";
      reason = "FLEX_POOL_SHALLOW";
    } else {
      level = "none";
      reason = backup >= 2 ? "ADEQUATE" : "ADEQUATE";
    }

    const surplusThreshold = flex ? required + 1 : 2;
    const structural_surplus = backup >= surplusThreshold;
    if (structural_surplus) reason = "SURPLUS";

    return {
      slot_key: key,
      level,
      required_starters: required,
      active_eligible: activeEligible,
      backup_count: backup,
      structural_surplus,
      surplus_count: structural_surplus ? backup - (flex ? required : 1) : 0,
      reason_code: reason,
    };
  });

  const pressured_keys = by_key
    .filter((e) => e.level !== "none")
    .sort((a, b) => LEVEL_RANK[a.level] - LEVEL_RANK[b.level])
    .map((e) => e.slot_key);
  const surplus_keys = by_key.filter((e) => e.structural_surplus).map((e) => e.slot_key);

  return { by_key, pressured_keys, surplus_keys };
}
