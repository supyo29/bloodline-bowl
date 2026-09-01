/**
 * Layer 3 — manager contextual value.
 *
 * Consumes Layer-2 `LeagueProjection`s (already league-scored, manager-agnostic)
 * plus ONE manager's resolved identity + current roster, and produces a
 * need-weighted view for that manager's draft board. It never mutates a
 * `LeagueProjection` or a `PlayerProjection` — a player's projected points are
 * identical no matter which manager is looking.
 *
 * Cache key for anything this module produces MUST include
 * `league_id + sleeper_user_id + draft_id/state` (see `build.ts`). roster_id is
 * NOT globally unique (BijiMac and DarthMarker are both roster_id 2 in different
 * leagues) so it is never the key.
 */

import { startingSlots } from "@/lib/sleeper/normalize";
import type { FantasyPosition, LeagueProjection, ManagerProjectionValue } from "./schema";
import type { PlayerComparison } from "./compare";

export interface ManagerRosterState {
  league_id: string;
  sleeper_user_id: string;
  roster_id: number;
  draft_id: string | null;
  draft_state: string | null;
  /** player_ids currently rostered by THIS manager */
  owned_player_ids: string[];
  /** the league's roster_positions */
  roster_positions: string[];
  /** position of each owned player (from the live player index) */
  position_by_player: Map<string, FantasyPosition | null>;
}

const FLEX_SLOTS: Record<string, FantasyPosition[]> = {
  FLEX: ["RB", "WR", "TE"],
  WRRB_FLEX: ["RB", "WR"],
  REC_FLEX: ["WR", "TE"],
  SUPER_FLEX: ["QB", "RB", "WR", "TE"],
};

interface Needs {
  /** starter slots still unfilled, per position (flex counted toward each eligible pos) */
  open_starters: Record<FantasyPosition, number>;
  /** multiplier per position: >1 = need, <1 = already deep */
  need_multiplier: Record<FantasyPosition, number>;
}

export function computeManagerNeeds(state: ManagerRosterState): Needs {
  const slots = startingSlots(state.roster_positions);
  const required: Record<FantasyPosition, number> = { QB: 0, RB: 0, WR: 0, TE: 0, K: 0, DEF: 0 };
  let flexPool = 0;
  const flexElig = new Set<FantasyPosition>();

  for (const slot of slots) {
    if (["QB", "RB", "WR", "TE", "K", "DEF"].includes(slot)) {
      required[slot as FantasyPosition] += 1;
    } else if (FLEX_SLOTS[slot]) {
      flexPool += 1;
      for (const p of FLEX_SLOTS[slot]!) flexElig.add(p);
    }
  }

  const have: Record<FantasyPosition, number> = { QB: 0, RB: 0, WR: 0, TE: 0, K: 0, DEF: 0 };
  for (const pid of state.owned_player_ids) {
    const pos = state.position_by_player.get(pid);
    if (pos && pos in have) have[pos] += 1;
  }

  const open_starters: Record<FantasyPosition, number> = { QB: 0, RB: 0, WR: 0, TE: 0, K: 0, DEF: 0 };
  for (const pos of Object.keys(required) as FantasyPosition[]) {
    open_starters[pos] = Math.max(0, required[pos] - have[pos]);
  }
  // distribute the flex pool over its eligible positions with remaining need
  const flexLeft = flexPool;
  for (const pos of flexElig) {
    const surplusNeed = Math.max(0, required[pos] + 1 - have[pos] - open_starters[pos]);
    const take = Math.min(flexLeft, surplusNeed > 0 ? 1 : 0);
    open_starters[pos] += take * 0.6;
  }

  const need_multiplier: Record<FantasyPosition, number> = { QB: 1, RB: 1, WR: 1, TE: 1, K: 1, DEF: 1 };
  for (const pos of Object.keys(need_multiplier) as FantasyPosition[]) {
    const open = open_starters[pos];
    const depth = have[pos] - required[pos];
    if (open >= 1) need_multiplier[pos] = 1.25;
    else if (open > 0) need_multiplier[pos] = 1.12;
    else if (depth >= 2) need_multiplier[pos] = 0.82;
    else if (depth >= 1) need_multiplier[pos] = 0.92;
  }

  return { open_starters, need_multiplier };
}

export function buildManagerProjectionValues(
  state: ManagerRosterState,
  leaguePool: LeagueProjection[],
  comparisons: Map<string, PlayerComparison>,
): { needs: Needs; values: ManagerProjectionValue[] } {
  const needs = computeManagerNeeds(state);
  const owned = new Set(state.owned_player_ids);

  const values: ManagerProjectionValue[] = leaguePool.map((lp) => {
    const mult = needs.need_multiplier[lp.position] ?? 1;
    const open = needs.open_starters[lp.position] ?? 0;
    const baseValue = lp.value_over_replacement ?? lp.league_points;
    const contextual = round2(baseValue * mult);

    const cmp = comparisons.get(lp.player_id);
    const edge = cmp && cmp.has_benchmark
      ? {
          ri_vs_sleeper_pct: cmp.neutral_delta_pct,
          direction: cmp.direction,
          primary_driver: cmp.primary_driver,
          confidence: lp.confidence,
        }
      : {
          ri_vs_sleeper_pct: null,
          direction: "NO_BENCHMARK" as const,
          primary_driver: null,
          confidence: lp.confidence,
        };

    return {
      player_id: lp.player_id,
      full_name: lp.full_name,
      position: lp.position,
      used_roster_id: state.roster_id,
      used_sleeper_user_id: state.sleeper_user_id,
      roster_fit: owned.has(lp.player_id)
        ? "ALREADY_ROSTERED"
        : open >= 1
          ? "FILLS_OPEN_STARTER"
          : mult < 1
            ? "DEPTH_ONLY"
            : "BENCH_UPSIDE",
      fills_open_starter: open >= 1 && !owned.has(lp.player_id),
      need_multiplier: mult,
      contextual_value: contextual,
      projection_edge: edge,
    };
  });

  values.sort((a, b) => b.contextual_value - a.contextual_value);
  return { needs, values };
}

function round2(v: number): number { return Math.round(v * 100) / 100; }
