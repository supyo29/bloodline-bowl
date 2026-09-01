/**
 * PHASE 4 §4.2 / §7 (report) / §12 — league-derived replacement levels.
 *
 * Replacement level is derived ENTIRELY from the league's own lineup config and
 * team count. Nothing is hard-coded to QB12 / RB24 / WR36 — those numbers only
 * appear if the league's structure produces them.
 *
 * FLEX handling (§12) is not a flat split. A FLEX slot is filled by whichever
 * RB / WR / TE is the best remaining option AFTER each team's base starters, so
 * we find the actual marginal players: pool every eligible player past his
 * position's base-starter line, take the top `flexSlots × teams` of that
 * combined pool by league points, and count how many of each position land in
 * it. A pass-catching-RB-heavy player pool therefore lifts RB replacement more
 * than WR, automatically.
 *
 * A bench/streaming cushion is added past the last starter to reflect that the
 * real waiver wire is not literally the Nth+1 player.
 */

import type { FantasyPosition, LeagueProjection } from "@/lib/projections/schema";
import type { ReplacementDerivation } from "./schema";

const FLEX_ELIGIBLE: Record<string, FantasyPosition[]> = {
  FLEX: ["RB", "WR", "TE"],
  WRRB_FLEX: ["RB", "WR"],
  WRRB_WRT: ["RB", "WR", "TE"],
  REC_FLEX: ["WR", "TE"],
  SUPER_FLEX: ["QB", "RB", "WR", "TE"],
};
const BASE_SLOT: Record<string, FantasyPosition> = {
  QB: "QB", RB: "RB", WR: "WR", TE: "TE", K: "K", DEF: "DEF",
};
const BENCH_SLOTS = new Set(["BN", "IR", "TAXI"]);
const POSITIONS: FantasyPosition[] = ["QB", "RB", "WR", "TE", "K", "DEF"];

export interface ReplacementLevels {
  by_position: Record<FantasyPosition, ReplacementDerivation>;
  replacement_points: Record<FantasyPosition, number>;
  /** total bench slots — informs the streaming cushion */
  bench_slots: number;
}

function bySortedPoints(
  pool: LeagueProjection[],
): Record<FantasyPosition, LeagueProjection[]> {
  const out = { QB: [], RB: [], WR: [], TE: [], K: [], DEF: [] } as Record<
    FantasyPosition,
    LeagueProjection[]
  >;
  for (const p of pool) (out[p.position] ??= []).push(p);
  for (const pos of POSITIONS) {
    out[pos].sort((a, b) => b.league_points - a.league_points);
  }
  return out;
}

export function computeReplacementLevels(
  rosterPositions: string[],
  numTeams: number,
  pool: LeagueProjection[],
): ReplacementLevels {
  const baseDemand: Record<FantasyPosition, number> = { QB: 0, RB: 0, WR: 0, TE: 0, K: 0, DEF: 0 };
  const flexSlotDefs: FantasyPosition[][] = [];
  let benchSlots = 0;

  for (const slot of rosterPositions) {
    if (BENCH_SLOTS.has(slot)) { benchSlots += 1; continue; }
    const base = BASE_SLOT[slot];
    if (base) { baseDemand[base] += 1; continue; }
    const elig = FLEX_ELIGIBLE[slot];
    if (elig?.length) flexSlotDefs.push(elig);
  }

  const sorted = bySortedPoints(pool);

  // --- FLEX marginal-player attribution -------------------------------------
  // Only positions that appear in at least one flex definition compete.
  const flexShare: Record<FantasyPosition, number> = { QB: 0, RB: 0, WR: 0, TE: 0, K: 0, DEF: 0 };
  const flexEligiblePositions = new Set<FantasyPosition>(flexSlotDefs.flat());
  const totalFlexSlots = flexSlotDefs.length * numTeams;

  if (totalFlexSlots > 0 && flexEligiblePositions.size > 0) {
    // candidate = every eligible player ranked past his position's base line
    const marginal: Array<{ pos: FantasyPosition; pts: number }> = [];
    for (const pos of flexEligiblePositions) {
      const baseLine = baseDemand[pos] * numTeams;
      const rest = sorted[pos].slice(baseLine);
      for (const p of rest) marginal.push({ pos, pts: p.league_points });
    }
    marginal.sort((a, b) => b.pts - a.pts);
    for (const m of marginal.slice(0, totalFlexSlots)) flexShare[m.pos] += 1;
  }

  // --- bench / streaming cushion ------------------------------------------
  // ~1 extra roster-quality body per 6 teams for the core skill positions, a
  // hair less for QB/TE (shallower starter demand) and 0 for K/DEF (streamed).
  const cushionFor = (pos: FantasyPosition): number => {
    if (pos === "K" || pos === "DEF") return 0;
    const perSix = numTeams / 6;
    return pos === "QB" || pos === "TE" ? Math.round(perSix * 0.5) : Math.round(perSix);
  };

  const by_position = {} as Record<FantasyPosition, ReplacementDerivation>;
  const replacement_points = { QB: 0, RB: 0, WR: 0, TE: 0, K: 0, DEF: 0 } as Record<FantasyPosition, number>;

  for (const pos of POSITIONS) {
    const starterDemand = baseDemand[pos] * numTeams + flexShare[pos];
    const cushion = cushionFor(pos);
    const rank = Math.max(1, Math.round(starterDemand + cushion));
    const list = sorted[pos];
    const at = list[Math.min(list.length - 1, rank - 1)];
    const pts = at ? round2(at.league_points) : 0;
    replacement_points[pos] = pts;
    by_position[pos] = {
      position: pos,
      league_starter_demand: round2(baseDemand[pos] * numTeams),
      flex_share: flexShare[pos],
      bench_cushion: cushion,
      replacement_rank: rank,
      replacement_points: pts,
      basis:
        `${baseDemand[pos]}/team base × ${numTeams} teams` +
        (flexShare[pos] > 0 ? ` + ${flexShare[pos]} flex (marginal-player)` : "") +
        (cushion > 0 ? ` + ${cushion} streaming cushion` : "") +
        ` → pool rank ${rank}`,
    };
  }

  return { by_position, replacement_points, bench_slots: benchSlots };
}

/** VOR for one league projection against these levels. */
export function vorOf(p: LeagueProjection, levels: ReplacementLevels): number {
  return round2(p.league_points - (levels.replacement_points[p.position] ?? 0));
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
