/**
 * PHASE 4 §4.3 / §21.1 — tier model and quantified cliffs.
 *
 * Tiers are NOT "rank / 6". A tier boundary is a point in the position's own
 * value curve where the drop to the next player materially exceeds the local
 * average drop. Every cliff the engine cites is backed by the underlying
 * projection/VOR curve — a player labelled "last in Tier 2" must actually sit
 * in front of a real gap.
 *
 * `tier_drop` for player i = points from player i to the FIRST player of the
 * next tier down (0 when i is not the last man in his tier). That is the number
 * the urgency term consumes: it is what a manager loses by passing the tier.
 */

import type { FantasyPosition, LeagueProjection } from "@/lib/projections/schema";
import type { TierBoundary } from "./schema";

export const TIER_MODEL_VERSION = "gap-relative.v1";

/** A new tier starts where drop_i > gapMult × mean(local drops). */
const GAP_MULT = 1.9;
/** Local-drop window (players on each side) for the moving average. */
const LOCAL_WINDOW = 6;

export interface TieredPlayer {
  player_id: string;
  position: FantasyPosition;
  league_points: number;
  vor: number;
  position_rank: number;
  tier: number;
  /** points to the next player at this position (0 if last) */
  distance_to_next_in_tier: number;
  /** points to the first player of the next tier (0 if last tier or not tier-last) */
  distance_to_next_tier: number;
  /** true when this player is the last (lowest) member of his tier */
  is_tier_last: boolean;
}

export interface PositionTiers {
  position: FantasyPosition;
  players: TieredPlayer[];
  boundaries: TierBoundary[];
}

function localMeanDrop(drops: number[], i: number): number {
  const lo = Math.max(0, i - LOCAL_WINDOW);
  const hi = Math.min(drops.length, i + LOCAL_WINDOW + 1);
  let s = 0;
  let n = 0;
  for (let k = lo; k < hi; k++) {
    s += drops[k]!;
    n += 1;
  }
  return n > 0 ? s / n : 0;
}

/**
 * Tier one position's players (already the league pool, any order). `vorFn`
 * supplies VOR so this module does not need the replacement levels directly.
 */
export function tierPosition(
  position: FantasyPosition,
  pool: LeagueProjection[],
  vorFn: (p: LeagueProjection) => number,
): PositionTiers {
  const players = pool
    .filter((p) => p.position === position)
    .slice()
    .sort((a, b) => b.league_points - a.league_points);

  if (players.length === 0) {
    return { position, players: [], boundaries: [] };
  }

  const drops: number[] = [];
  for (let i = 1; i < players.length; i++) {
    drops.push(Math.max(0, players[i - 1]!.league_points - players[i]!.league_points));
  }

  const tiered: TieredPlayer[] = [];
  let tier = 1;
  for (let i = 0; i < players.length; i++) {
    if (i > 0) {
      const drop = drops[i - 1]!;
      const localMean = localMeanDrop(drops, i - 1) || 1;
      if (drop > GAP_MULT * localMean) tier += 1;
    }
    const p = players[i]!;
    const next = players[i + 1];
    tiered.push({
      player_id: p.player_id,
      position,
      league_points: round2(p.league_points),
      vor: round2(vorFn(p)),
      position_rank: i + 1,
      tier,
      distance_to_next_in_tier: next ? round2(p.league_points - next.league_points) : 0,
      distance_to_next_tier: 0, // filled below
      is_tier_last: false, // filled below
    });
  }

  // mark tier-last players and their distance to the next tier's best
  const boundaries: TierBoundary[] = [];
  for (let t = 1; t <= tier; t++) {
    const members = tiered.filter((x) => x.tier === t);
    if (members.length === 0) continue;
    const last = members[members.length - 1]!;
    const nextTierBest = tiered.find((x) => x.tier === t + 1) ?? null;
    last.is_tier_last = true;
    last.distance_to_next_tier = nextTierBest
      ? round2(last.league_points - nextTierBest.league_points)
      : 0;
    boundaries.push({
      position,
      tier: t,
      top_player_id: members[0]!.player_id,
      last_player_id: last.player_id,
      members: members.length,
      tier_top_points: members[0]!.league_points,
      tier_last_points: last.league_points,
      cliff_to_next_points: nextTierBest ? round2(last.league_points - nextTierBest.league_points) : 0,
      cliff_to_next_vor: nextTierBest ? round2(last.vor - nextTierBest.vor) : 0,
    });
  }

  return { position, players: tiered, boundaries };
}

/** Tier every position in one pass. */
export function tierAllPositions(
  pool: LeagueProjection[],
  vorFn: (p: LeagueProjection) => number,
  positions: FantasyPosition[] = ["QB", "RB", "WR", "TE", "K", "DEF"],
): Map<FantasyPosition, PositionTiers> {
  const out = new Map<FantasyPosition, PositionTiers>();
  for (const pos of positions) out.set(pos, tierPosition(pos, pool, vorFn));
  return out;
}

/**
 * `tier_drop` for a specific player: the points a manager loses by passing this
 * player's tier. Non-zero only for the last player in a tier that has a real
 * cliff in front of it.
 */
export function tierDropForPlayer(tiers: PositionTiers, playerId: string): number {
  const p = tiers.players.find((x) => x.player_id === playerId);
  if (!p || !p.is_tier_last) return 0;
  return Math.max(0, p.distance_to_next_tier);
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
