/**
 * League-specific WEEKLY replacement levels — shared by the lineup and waiver
 * engines.
 *
 *   weekly VOR(player) = weekly projection − best realistically available
 *                        replacement projection at that player's position
 *
 * "Realistically available" = the free-agent pool in THIS league, this week.
 * The best free agent overstates what you actually win on waivers, so the level
 * is taken a short step down the free-agent board (a streaming cushion). It is
 * position-aware and flex-aware: `flex_replacement` pools every flex-eligible
 * free agent.
 *
 * Fallback: if the free-agent pool has too few projected players at a position,
 * the level is the projection at rank `starterLine + cushion` of the FULL pool
 * (rostered + free agents) — `basis: "position_rank_fallback"`.
 */

import type {
  LeagueAvailability,
  ReplacementLevel,
  RosterConstraints,
  WeeklyProjectionBatch,
  WeeklyReplacement,
  WeeklyVOR,
  WeeklyWarning,
} from "./schema";

const BASE_POSITIONS = ["QB", "RB", "WR", "TE", "K", "DEF"];
/** extra rank past the last starter when falling back to the full pool */
const POOL_CUSHION_PER_TEAM = 0.5;

/**
 * Explicit replacement-frontier strategy (configurable, not an unexplained
 * constant). The actual available pool always stays central — none of these
 * modes regress to a generic QB12/RB24 rank.
 *
 *  - `nth_best_available` (default, n=1): the (n+1)-th best free agent at the
 *    position. n=1 also solves candidate self-influence: the single best FA at a
 *    position (often the candidate under evaluation) never sets its own
 *    replacement, and a candidate ranked 3rd+ cannot move the 2nd-best.
 *  - `best_available`: the single best free agent (aggressive — tends to
 *    understate VOR).
 *  - `marginal_starter`: the last "true starter" — projection at rank
 *    `base_starters + flex_share` of the FULL (rostered + FA) pool.
 */
export interface ReplacementFrontier {
  mode: "nth_best_available" | "best_available" | "marginal_starter";
  n?: number;
}
export const DEFAULT_FRONTIER: ReplacementFrontier = { mode: "nth_best_available", n: 1 };

interface Input {
  league_slug: string;
  week: number;
  team_count: number;
  constraints: RosterConstraints;
  projections: WeeklyProjectionBatch;
  availability: LeagueAvailability;
  frontier?: ReplacementFrontier;
}

export function computeWeeklyReplacement(input: Input): WeeklyReplacement {
  const { constraints, projections, availability, team_count } = input;
  const frontier = input.frontier ?? DEFAULT_FRONTIER;
  const warnings: WeeklyWarning[] = [];


  // position -> descending projected points, split into all / free-agent-only.
  const poolAll: Record<string, number[]> = {};
  const poolFA: Record<string, number[]> = {};
  for (const p of BASE_POSITIONS) {
    poolAll[p] = [];
    poolFA[p] = [];
  }
  for (const ap of availability.players) {
    const wp = projections.by_player.get(ap.canonical_player_id);
    if (!wp || wp.projected_points == null) continue;
    const pos = wp.position;
    if (!poolAll[pos]) continue;
    poolAll[pos]!.push(wp.projected_points);
    if (ap.ownership === "free_agent") poolFA[pos]!.push(wp.projected_points);
  }
  for (const p of BASE_POSITIONS) {
    poolAll[p]!.sort((a, b) => b - a);
    poolFA[p]!.sort((a, b) => b - a);
  }

  const starterLine = (pos: string): number => {
    const base = (constraints.slot_requirements[pos] ?? 0) * team_count;
    const flexShare =
      constraints.flex_positions.includes(pos) && constraints.flex_positions.length > 0
        ? (constraints.flex_slots * team_count) / constraints.flex_positions.length
        : 0;
    return base + flexShare;
  };

  const faIndex = (len: number): number => {
    if (len === 0) return 0;
    if (frontier.mode === "best_available") return 0;
    if (frontier.mode === "nth_best_available") return Math.min(frontier.n ?? 1, len - 1);
    return Math.min(1, len - 1); // marginal_starter falls back to nth for the FA-only branch
  };

  const level = (pos: string): ReplacementLevel => {
    const fa = poolFA[pos] ?? [];
    const all = poolAll[pos] ?? [];

    if (frontier.mode === "marginal_starter" && all.length > 0) {
      const rank = Math.round(starterLine(pos));
      const idx = Math.min(Math.max(0, rank - 1), all.length - 1);
      return {
        position: pos,
        replacement_points: round2(all[idx]!),
        basis: "position_rank_fallback",
        derived_from_rank: idx + 1,
        sample_size: all.length,
      };
    }
    if (fa.length >= 1) {
      const idx = faIndex(fa.length);
      return {
        position: pos,
        replacement_points: round2(fa[idx]!),
        basis: "available_pool_marginal",
        derived_from_rank: idx + 1,
        sample_size: fa.length,
      };
    }
    if (all.length > 0) {
      const rank = Math.round(starterLine(pos) + POOL_CUSHION_PER_TEAM * team_count);
      const idx = Math.min(Math.max(0, rank), all.length - 1);
      warnings.push({
        code: "replacement_fallback",
        message: `No free agent with a projection at ${pos}; replacement level uses full-pool rank ${idx + 1}.`,
        severity: "info",
      });
      return {
        position: pos,
        replacement_points: round2(all[idx]!),
        basis: "position_rank_fallback",
        derived_from_rank: idx + 1,
        sample_size: all.length,
      };
    }
    warnings.push({
      code: "replacement_unavailable",
      message: `No projected players at ${pos}; replacement level unavailable.`,
      severity: "warning",
    });
    return { position: pos, replacement_points: null, basis: "unavailable", derived_from_rank: null, sample_size: 0 };
  };

  const by_position: Record<string, ReplacementLevel> = {};
  for (const p of BASE_POSITIONS) by_position[p] = level(p);

  // FLEX replacement — best realistically available across flex-eligible FAs.
  const flexFA: number[] = [];
  for (const pos of constraints.flex_positions) flexFA.push(...(poolFA[pos] ?? []));
  flexFA.sort((a, b) => b - a);
  by_position.FLEX =
    flexFA.length > 0
      ? {
          position: "FLEX",
          replacement_points: round2(flexFA[faIndex(flexFA.length)]!),
          basis: "available_pool_marginal",
          derived_from_rank: faIndex(flexFA.length) + 1,
          sample_size: flexFA.length,
        }
      : {
          position: "FLEX",
          replacement_points:
            Math.max(...constraints.flex_positions.map((p) => by_position[p]?.replacement_points ?? 0)) || null,
          basis: "position_rank_fallback",
          derived_from_rank: null,
          sample_size: 0,
        };

  return {
    league_slug: input.league_slug,
    week: input.week,
    by_position,
    flex_positions: constraints.flex_positions,
    flex_slots: constraints.flex_slots,
    bench_slots: constraints.bench_slots,
    warnings,
  };
}

/** Weekly VOR for one player given a computed replacement table. */
export function weeklyVOR(
  cid: string,
  position: string,
  projectedPoints: number | null,
  replacement: WeeklyReplacement,
): WeeklyVOR {
  const rep = replacement.by_position[position]?.replacement_points ?? null;
  const flexRep = replacement.by_position.FLEX?.replacement_points ?? null;
  const isFlex = replacement.flex_positions.includes(position);
  return {
    canonical_player_id: cid,
    position,
    projected_points: projectedPoints,
    replacement_points: rep,
    vor: projectedPoints != null && rep != null ? round2(projectedPoints - rep) : null,
    flex_vor: isFlex && projectedPoints != null && flexRep != null ? round2(projectedPoints - flexRep) : null,
  };
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
