/**
 * Phase 6 — whole-lineup contingency primitive (spec §3, §7).
 *
 * `baseline = value(best legal lineup)`; for each removed player,
 * `loss = baseline − value(best legal lineup with that player gone)`.
 * Uses the FROZEN `buildOptimalLineup` (Hungarian max-weight over
 * slots × players, eligibility from the frozen `slotEligiblePositions`) — it is
 * NOT modified. FLEX / SUPER_FLEX / multi-position eligibility are handled
 * jointly by the optimizer, so a versatile backup is matched to at most one
 * slot (spec §13).
 */

import { buildOptimalLineup, type LineupResult } from "@/lib/weekly/lineup";
import type { CanonicalPlayer, CanonicalRoster } from "@/lib/canonical/schema";
import type { RosterConstraints, WeeklyProjectionBatch, WeeklyProjection } from "@/lib/weekly/schema";

/** synthesize a projection batch for a non-weekly horizon (ROS) from a points map. */
export function horizonBatch(
  base: WeeklyProjectionBatch,
  pointsByCid: Map<string, number | null>,
): WeeklyProjectionBatch {
  const by_player = new Map<string, WeeklyProjection>();
  for (const [cid, wp] of base.by_player) {
    const pts = pointsByCid.get(cid) ?? null;
    by_player.set(cid, {
      ...wp,
      projected_points: pts,
      floor_points: pts != null ? pts * 0.7 : null,
      ceiling_points: pts != null ? pts * 1.3 : null,
      std_dev: pts != null ? pts * 0.3 : null,
      projection_status: pts != null ? "projected" : wp.projection_status,
    });
  }
  return { ...base, by_player };
}

export interface LineupValue {
  value: number | null;
  status: LineupResult["optimality_status"];
  starterIds: string[];
  slotByPlayer: Map<string, string>;
  provisional: boolean; // an UNKNOWN starter would distort the value
}

export function bestLegalLineup(
  roster: CanonicalRoster,
  constraints: RosterConstraints,
  playerMap: Map<string, CanonicalPlayer>,
  projections: WeeklyProjectionBatch,
  week: number,
): LineupValue {
  const lineup = buildOptimalLineup({ week, roster, constraints, players: playerMap, projections });
  const starterIds = lineup.slots.map((s) => s.recommended_player_id).filter((x): x is string => Boolean(x));
  const slotByPlayer = new Map<string, string>();
  for (const s of lineup.slots) if (s.recommended_player_id) slotByPlayer.set(s.recommended_player_id, s.slot);
  return {
    value: lineup.optimal_total,
    status: lineup.optimality_status,
    starterIds,
    slotByPlayer,
    provisional: lineup.optimality_status === "PROVISIONAL",
  };
}

/** a roster with `removeIds` removed from every list. */
export function rosterWithout(roster: CanonicalRoster, removeIds: Set<string>): CanonicalRoster {
  const f = (xs: string[]) => xs.filter((x) => !removeIds.has(x));
  return {
    ...roster,
    slots: roster.slots.map((s) => (s.canonical_player_id && removeIds.has(s.canonical_player_id) ? { ...s, canonical_player_id: null, is_empty: true } : s)),
    starters: f(roster.starters),
    bench: f(roster.bench),
    ir: f(roster.ir),
    taxi: f(roster.taxi),
    all_players: f(roster.all_players),
  };
}

export interface ContingencyResult {
  removed_player_id: string;
  baseline_value: number | null;
  post_value: number | null;
  value_loss: number | null;
  promoted_player_id: string | null;
  promoted_projection: number | null;
  slot_affected: string | null;
  provisional: boolean;
}

/**
 * Contingency for a single removed player, given a precomputed baseline.
 */
export function contingency(
  roster: CanonicalRoster,
  constraints: RosterConstraints,
  playerMap: Map<string, CanonicalPlayer>,
  projections: WeeklyProjectionBatch,
  week: number,
  baseline: LineupValue,
  removedId: string,
): ContingencyResult {
  const after = bestLegalLineup(rosterWithout(roster, new Set([removedId])), constraints, playerMap, projections, week);
  const baseStarter = baseline.starterIds.includes(removedId);
  const removedSlot = baseline.slotByPlayer.get(removedId) ?? null;

  // who filled the vacated slot after re-optimization (a starter now who was not before)
  const before = new Set(baseline.starterIds);
  const promoted = after.starterIds.find((id) => !before.has(id)) ?? null;
  const promotedProj = promoted != null ? projections.by_player.get(promoted)?.projected_points ?? null : null;

  const loss =
    baseline.value != null && after.value != null ? Math.max(0, round2(baseline.value - after.value)) : null;

  return {
    removed_player_id: removedId,
    baseline_value: baseline.value,
    post_value: after.value,
    value_loss: baseStarter ? loss : loss != null && loss > 0 ? loss : 0,
    promoted_player_id: promoted,
    promoted_projection: promotedProj,
    slot_affected: removedSlot,
    provisional: baseline.provisional || after.provisional,
  };
}

const round2 = (v: number) => Math.round(v * 100) / 100;
