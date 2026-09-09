/**
 * Competitive Trade Intelligence — owner reservation price (Checkpoint C).
 *
 *   reservation_price(bundle) = Σ owner_perceived_value
 *     + replacement_cost           (OUR estimate of their lineup loss — a behavioral
 *                                   proxy for resistance, NOT their perceived value)
 *     + positional_scarcity_cost   (thin at the position after losing them → +)
 *     + surplus_discount           (deep at the position → −, ≤ 0)
 *     + bundle_nonadditivity       (losing 2+ from one position hurts more than the sum)
 *
 * `need_relief` is DELIBERATELY not here — it is a trade-level acceptance factor
 * (§11, §29), not a per-asset reservation discount.
 *
 * Bundles are NOT additive (§28): the replacement cost + scarcity cost of losing
 * two RBs together is computed from ONE combined leave-both-out lineup delta.
 */

import { lineupLossFromRemoving, type OwnerContext } from "./owner-context";
import type { OwnerPerceptionConfig } from "./config";
import type { TradeAnalysisContext } from "../context";
import {
  describeReservationLevel,
  type OwnerContextReadiness,
  type OwnerPerceivedValue,
  type ReservationPrice,
  type ValueConfidence,
} from "./schema";

const CONF_LEVEL: Record<ValueConfidence, number> = { HIGH: 3, MEDIUM: 2, LOW: 1, VERY_LOW: 0 };
const LEVEL_CONF: ValueConfidence[] = ["VERY_LOW", "LOW", "MEDIUM", "HIGH"];

export interface BuildReservationInput {
  ctx: TradeAnalysisContext;
  owner: OwnerContext;
  /** the outgoing bundle from THIS owner (1+ ids) */
  outgoing_ids: string[];
  perceived: Map<string, OwnerPerceivedValue>;
  config: OwnerPerceptionConfig;
}

export function buildReservationPrice(input: BuildReservationInput): ReservationPrice {
  const { ctx, owner, outgoing_ids, perceived, config } = input;
  const reasons: string[] = [];

  const ids = outgoing_ids.filter((id) => owner.by_player.has(id));
  const missing = outgoing_ids.filter((id) => !owner.by_player.has(id));
  if (missing.length > 0) reasons.push(`${missing.length} outgoing id(s) not on this owner's roster — excluded from the bundle`);

  if (!owner.available || ids.length === 0) {
    return {
      canonical_player_ids: outgoing_ids,
      owner_manager_id: owner.manager_id,
      reservation_price: null,
      perceived_value: null,
      components: { owner_perceived_value: 0, replacement_cost: 0, positional_scarcity_cost: 0, surplus_discount: 0, bundle_nonadditivity: 0 },
      sanity_floor_applied: false,
      reservation_descriptor: describeReservationLevel(null),
      readiness: owner.available ? "GLOBAL_MARKET_ONLY" : "UNAVAILABLE",
      confidence: "VERY_LOW",
      reasons: [...reasons, owner.available ? "no owner-rostered assets in the outgoing bundle" : "owner context unavailable"],
    };
  }

  // ---- Σ owner-perceived value ----
  let perceivedSum = 0;
  let anyPerceivedMissing = false;
  for (const id of ids) {
    const v = perceived.get(id)?.owner_perceived_value ?? null;
    if (v == null) anyPerceivedMissing = true;
    else perceivedSum += v;
  }

  // ---- replacement cost (combined leave-all-out) → z ----
  const combinedLoss = owner.roster ? lineupLossFromRemoving(ctx, owner.roster, ids) : null;
  const replacementCostZ = combinedLoss == null ? 0 : round4(Math.max(0, combinedLoss) / config.replacement_points_to_z);
  if (combinedLoss != null && combinedLoss > 1) {
    reasons.push(`losing ${ids.length === 1 ? "this player" : "these players"} costs the owner ~${combinedLoss.toFixed(1)} optimal-lineup pts/wk → replacement cost +${replacementCostZ.toFixed(2)} z`);
  }

  // ---- positional scarcity + surplus (per position in the bundle) ----
  let scarcityCost = 0;
  let surplusDiscount = 0;
  const byPos = new Map<string, string[]>();
  for (const id of ids) {
    const pos = owner.by_player.get(id)!.position;
    byPos.set(pos, [...(byPos.get(pos) ?? []), id]);
  }
  for (const [pos, group] of byPos) {
    // startable options remaining at the position after losing the whole group
    const anyPc = owner.by_player.get(group[0]!)!;
    const remaining = Math.max(0, anyPc.position_startable_count - group.length);
    const need = positionNeedCount(owner, pos);
    const gap = Math.max(0, need - remaining);
    if (gap > 0) {
      const c = round4(gap * config.positional_scarcity_cost_per_gap);
      scarcityCost += c;
      reasons.push(`after losing ${group.length} ${pos}, owner has ${remaining} startable vs ${need} needed → scarcity cost +${c.toFixed(2)} z`);
    }
    const extra = Math.max(0, remaining - (need + 1));
    if (extra > 0) {
      const d = round4(extra * config.surplus_discount_per_extra);
      surplusDiscount += d;
      reasons.push(`owner keeps ${remaining} startable ${pos} (needs ${need}) — surplus discount ${d.toFixed(2)} z`);
    }
  }

  // ---- bundle non-additivity: combined loss beyond the sum of singles ----
  let bundleNonAdd = 0;
  if (ids.length > 1 && owner.roster && combinedLoss != null) {
    let sumSingles = 0;
    for (const id of ids) {
      const s = lineupLossFromRemoving(ctx, owner.roster, [id]);
      if (s != null) sumSingles += Math.max(0, s);
    }
    const excess = combinedLoss - sumSingles;
    if (excess > 0.5) {
      bundleNonAdd = round4((excess / config.replacement_points_to_z) * config.bundle_nonadditivity_gain);
      reasons.push(`bundle: losing all ${ids.length} together costs ${excess.toFixed(1)} pts/wk MORE than the sum of losing each alone → +${bundleNonAdd.toFixed(2)} z`);
    }
  }

  // ---- sanity bounds (Checkpoint D §36) ----
  // (a) the summed surplus discount is bounded so stacked discounts can't
  //     collapse a valuable player's reservation arbitrarily.
  const sb = config.reservation_sanity;
  const boundedSurplusDiscount = Math.max(surplusDiscount, -sb.max_surplus_discount);
  if (boundedSurplusDiscount > surplusDiscount + 1e-6) {
    reasons.push(`surplus discount clamped from ${surplusDiscount.toFixed(2)} to ${boundedSurplusDiscount.toFixed(2)} z (max ${sb.max_surplus_discount})`);
  }

  let reservation =
    anyPerceivedMissing && ids.length === 1
      ? null
      : round4(perceivedSum + replacementCostZ + scarcityCost + boundedSurplusDiscount + bundleNonAdd);

  // (b) reservation may fall BELOW owner-perceived value for an expendable
  //     player, but not below a floor: for a positively-perceived bundle it
  //     stays ≥ floor_fraction · perceived; everything is bounded below by an
  //     absolute z floor so it never becomes a meaningless / large-negative number.
  let sanityFloorApplied = false;
  if (reservation != null && !anyPerceivedMissing) {
    const posFloor = perceivedSum > 0 ? sb.floor_fraction_of_perceived * perceivedSum : -Infinity;
    const floor = Math.max(sb.absolute_floor_z, posFloor);
    if (reservation < floor) {
      reservation = round4(floor);
      sanityFloorApplied = true;
      reasons.push(`reservation floored at ${reservation.toFixed(2)} z (RESERVATION_SANITY_FLOOR_APPLIED — stacked discounts would otherwise drive it below a defensible minimum)`);
    }
  }

  // ---- §72: human-facing phrasing (never "negative fantasy value") ----
  if (reservation != null && reservation < 0) {
    reasons.push(
      `${describeReservationLevel(reservation)} (reservation ${reservation.toFixed(2)} on the centered standardized scale — this is a very low bar to trade the player away, NOT a claim that the owner values the player below zero fantasy points).`,
    );
  }

  // ---- readiness / confidence ----
  const readiness: OwnerContextReadiness = perceived.get(ids[0]!)?.readiness ?? "PARTIAL_OWNER_CONTEXT";
  const ceiling = config.readiness_confidence_ceiling[readiness] ?? "LOW";
  let level = CONF_LEVEL[ceiling as ValueConfidence];
  if (combinedLoss == null) level = Math.max(0, level - 1);
  if (anyPerceivedMissing) level = Math.max(0, level - 1);

  return {
    canonical_player_ids: ids,
    owner_manager_id: owner.manager_id,
    reservation_price: reservation,
    perceived_value: anyPerceivedMissing ? null : round4(perceivedSum),
    components: {
      owner_perceived_value: round4(perceivedSum),
      replacement_cost: replacementCostZ,
      positional_scarcity_cost: round4(scarcityCost),
      surplus_discount: round4(boundedSurplusDiscount),
      bundle_nonadditivity: bundleNonAdd,
    },
    sanity_floor_applied: sanityFloorApplied,
    reservation_descriptor: describeReservationLevel(reservation),
    readiness,
    confidence: LEVEL_CONF[Math.max(0, Math.min(3, level))]!,
    reasons,
  };
}

/** startable players the owner "needs" at a position — from the frozen needs model. */
function positionNeedCount(owner: OwnerContext, position: string): number {
  const need = owner.profile.needs.find((n) => n.position === position);
  // map the 5-level need scale to a startable-count target
  const base: Record<string, number> = { QB: 1, RB: 2, WR: 2, TE: 1, K: 1, DEF: 1 };
  const target = base[position] ?? 1;
  if (!need) return target;
  if (need.severity === "CRITICAL" || need.severity === "HIGH") return target + 1;
  return target;
}

function round4(v: number): number {
  const r = Math.round(v * 10000) / 10000;
  return r === 0 ? 0 : r;
}
