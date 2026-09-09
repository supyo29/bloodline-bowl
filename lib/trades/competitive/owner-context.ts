/**
 * Competitive Trade Intelligence — per-manager context assembly (Checkpoint C).
 *
 * Everything the owner-perception / reservation / acceptance models need about
 * ONE manager, assembled ONCE per request and memoized:
 *   - roster + slot assignments + optimal lineup
 *   - draft anchors (which pick THIS manager spent on each player)
 *   - positional needs + surplus (reuses the frozen `buildTradeSearchProfile`)
 *   - the league replacement frontier
 *
 * Reuses `buildOptimalLineup` / `weeklyVOR` / `computePositionalNeeds` — the same
 * canonical roster intelligence the rest of Bloodline Bowl uses. No new
 * lineup model.
 */

import type { CanonicalPlayer, CanonicalRoster } from "@/lib/canonical/schema";
import { buildOptimalLineup } from "@/lib/weekly/lineup";
import { weeklyVOR } from "@/lib/weekly/replacement";
import type { TradeAnalysisContext } from "../context";
import { buildTradeSearchProfile } from "../discovery/profiles";
import type { TradeSearchProfile } from "../discovery/types";
import type { StarterImportance } from "./schema";

export interface OwnerPlayerContext {
  canonical_player_id: string;
  position: string;
  name: string;
  starter_importance: StarterImportance;
  /** current-week VOR if started */
  vor: number | null;
  projected_points: number | null;
  /** this manager's draft pick for the player (null if undrafted / picked up) */
  draft_round: number | null;
  draft_pick: number | null;
  draft_slot: number | null;
  /** startable players this manager rosters at the player's position (incl. this one) */
  position_startable_count: number;
  /** how many startable options remain at the position WITHOUT this player */
  position_startable_without: number;
}

export interface OwnerContext {
  manager_id: string;
  manager_slug: string;
  roster: CanonicalRoster | null;
  profile: TradeSearchProfile;
  by_player: Map<string, OwnerPlayerContext>;
  /** optimal-lineup total with the current roster */
  optimal_total: number | null;
  /** positions the optimal lineup actually starts (labels) */
  starting_slot_labels: string[];
  available: boolean;
  readiness_notes: string[];
}

const STARTABLE_VOR = 0.5; // VOR ≥ this ⇒ "startable-quality" at the position

export interface BuildOwnerContextDeps {
  ctx: TradeAnalysisContext;
}

/** Memoized per-manager context builder for one request. */
export function makeOwnerContextCache(ctx: TradeAnalysisContext): (managerId: string) => OwnerContext {
  const cache = new Map<string, OwnerContext>();
  return (managerId: string): OwnerContext => {
    const hit = cache.get(managerId);
    if (hit) return hit;
    const built = buildOwnerContext(ctx, managerId);
    cache.set(managerId, built);
    return built;
  };
}

export function buildOwnerContext(ctx: TradeAnalysisContext, managerId: string): OwnerContext {
  const manager = ctx.snapshot.managers.find((m) => m.canonical_manager_id === managerId);
  const slug = manager?.manager_slug ?? managerId;
  const roster = ctx.rosters_by_manager.get(managerId) ?? null;
  const profile = buildTradeSearchProfile(managerId, slug, ctx);
  const readiness_notes: string[] = [];

  if (!roster) {
    return {
      manager_id: managerId,
      manager_slug: slug,
      roster: null,
      profile,
      by_player: new Map(),
      optimal_total: null,
      starting_slot_labels: [],
      available: false,
      readiness_notes: ["roster not found for this manager"],
    };
  }

  // draft anchors for this manager
  const draftByPlayer = new Map<string, { round: number; pick: number; slot: number | null }>();
  for (const dp of ctx.snapshot.draft_picks) {
    if (dp.canonical_manager_id === managerId && dp.canonical_player_id) {
      draftByPlayer.set(dp.canonical_player_id, { round: dp.round, pick: dp.pick_number, slot: dp.draft_slot });
    }
  }
  if (draftByPlayer.size === 0) readiness_notes.push("no draft picks resolved for this manager — draft anchor unavailable");

  const playerMap = new Map<string, CanonicalPlayer>();
  for (const id of roster.all_players) {
    const p = ctx.players_by_id.get(id);
    if (p) playerMap.set(id, p);
  }

  const lineup = buildOptimalLineup({
    week: ctx.week,
    roster,
    constraints: ctx.constraints,
    players: playerMap,
    projections: ctx.projections,
  });
  const optimalStarterIds = new Set(
    lineup.slots.map((s) => s.recommended_player_id).filter((x): x is string => Boolean(x)),
  );
  const startingSlotLabels = lineup.slots
    .filter((s) => s.recommended_player_id)
    .map((s) => s.slot);

  const reserve = new Set([...roster.ir, ...roster.taxi]);

  // per-position startable counts
  const startableByPos = new Map<string, string[]>();
  for (const id of roster.all_players) {
    if (reserve.has(id)) continue;
    const p = ctx.players_by_id.get(id);
    if (!p) continue;
    const pts = ctx.projections.by_player.get(id)?.projected_points ?? null;
    const v = weeklyVOR(id, p.position, pts, ctx.replacement);
    if ((v.vor ?? -Infinity) >= STARTABLE_VOR || optimalStarterIds.has(id)) {
      const arr = startableByPos.get(p.position) ?? [];
      arr.push(id);
      startableByPos.set(p.position, arr);
    }
  }

  const by_player = new Map<string, OwnerPlayerContext>();
  for (const id of roster.all_players) {
    const p = ctx.players_by_id.get(id);
    const position = p?.position ?? ctx.projections.by_player.get(id)?.position ?? "UNKNOWN";
    const pts = ctx.projections.by_player.get(id)?.projected_points ?? null;
    const v = weeklyVOR(id, position, pts, ctx.replacement);
    const dp = draftByPlayer.get(id) ?? null;
    const startableAtPos = startableByPos.get(position) ?? [];
    const isReserve = reserve.has(id);

    let importance: StarterImportance;
    if (isReserve && roster.ir.includes(id)) importance = "IR";
    else if (optimalStarterIds.has(id)) {
      const slotLabel = lineup.slots.find((s) => s.recommended_player_id === id)?.slot ?? "";
      if (slotLabel.startsWith("FLEX") || slotLabel.startsWith("W/R") || slotLabel.startsWith("W/R/T")) importance = "FLEX_STARTER";
      else {
        // locked vs regular: locked if no bench player at the position is close in VOR
        const benchAtPos = roster.all_players.filter(
          (bid) => bid !== id && !reserve.has(bid) && !optimalStarterIds.has(bid) && (ctx.players_by_id.get(bid)?.position ?? "") === position,
        );
        const myVor = v.vor ?? 0;
        const bestBench = Math.max(
          -Infinity,
          ...benchAtPos.map((bid) => {
            const bp = ctx.projections.by_player.get(bid)?.projected_points ?? null;
            return weeklyVOR(bid, position, bp, ctx.replacement).vor ?? -Infinity;
          }),
        );
        importance = bestBench < myVor - 3 || !Number.isFinite(bestBench) ? "LOCKED_STARTER" : "REGULAR_STARTER";
      }
    } else if ((v.vor ?? -Infinity) >= STARTABLE_VOR) importance = "ROTATIONAL";
    else importance = "BENCH_DEPTH";

    by_player.set(id, {
      canonical_player_id: id,
      position,
      name: p?.full_name ?? id,
      starter_importance: importance,
      vor: v.vor,
      projected_points: pts,
      draft_round: dp?.round ?? null,
      draft_pick: dp?.pick ?? null,
      draft_slot: dp?.slot ?? null,
      position_startable_count: startableAtPos.length,
      position_startable_without: Math.max(0, startableAtPos.filter((x) => x !== id).length),
    });
  }

  return {
    manager_id: managerId,
    manager_slug: slug,
    roster,
    profile,
    by_player,
    optimal_total: lineup.optimal_total,
    starting_slot_labels: startingSlotLabels,
    available: true,
    readiness_notes,
  };
}

/**
 * Leave-N-out optimal-lineup delta for a set of players on `roster` — OUR
 * estimate of the lineup consequence of the owner losing them. Positive =
 * points lost. Used as a behavioral proxy for reservation resistance, never as
 * the owner's perceived value.
 */
export function lineupLossFromRemoving(
  ctx: TradeAnalysisContext,
  roster: CanonicalRoster,
  removeIds: string[],
): number | null {
  const removeSet = new Set(removeIds);
  const playerMap = new Map<string, CanonicalPlayer>();
  for (const id of roster.all_players) {
    const p = ctx.players_by_id.get(id);
    if (p) playerMap.set(id, p);
  }
  const full = buildOptimalLineup({ week: ctx.week, roster, constraints: ctx.constraints, players: playerMap, projections: ctx.projections });
  const stripped: CanonicalRoster = {
    ...roster,
    all_players: roster.all_players.filter((id) => !removeSet.has(id)),
    starters: roster.starters.filter((id) => !removeSet.has(id)),
    bench: roster.bench.filter((id) => !removeSet.has(id)),
    slots: roster.slots.filter((s) => !s.canonical_player_id || !removeSet.has(s.canonical_player_id)),
  };
  const without = buildOptimalLineup({ week: ctx.week, roster: stripped, constraints: ctx.constraints, players: playerMap, projections: ctx.projections });
  if (full.optimal_total == null || without.optimal_total == null) return null;
  return Math.round((full.optimal_total - without.optimal_total) * 100) / 100;
}

/**
 * Checkpoint F — optimal-lineup points/wk a roster would GAIN by adding
 * `addId` (no drop modeled — an upper bound on the lineup benefit). Used by the
 * liquidity model to ask "would this player enter manager X's lineup?".
 */
export function lineupGainFromAdding(
  ctx: TradeAnalysisContext,
  roster: CanonicalRoster,
  addId: string,
): number | null {
  const p = ctx.players_by_id.get(addId);
  if (!p) return null;
  const playerMap = new Map<string, CanonicalPlayer>();
  for (const id of roster.all_players) {
    const rp = ctx.players_by_id.get(id);
    if (rp) playerMap.set(id, rp);
  }
  const base = buildOptimalLineup({ week: ctx.week, roster, constraints: ctx.constraints, players: playerMap, projections: ctx.projections });
  if (roster.all_players.includes(addId)) return 0;
  playerMap.set(addId, p);
  const augmented: CanonicalRoster = {
    ...roster,
    all_players: [...roster.all_players, addId],
    bench: [...roster.bench, addId],
  };
  const withAdd = buildOptimalLineup({ week: ctx.week, roster: augmented, constraints: ctx.constraints, players: playerMap, projections: ctx.projections });
  if (base.optimal_total == null || withAdd.optimal_total == null) return null;
  return Math.round((withAdd.optimal_total - base.optimal_total) * 100) / 100;
}
