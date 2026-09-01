/**
 * Replacement level, value over replacement, positional scarcity and tiers.
 *
 * Everything here is derived from the league's ACTUAL lineup configuration
 * (`roster_positions`) and team count — nothing is hard-coded to QB12 / RB24 /
 * WR36. FLEX / SUPER_FLEX / REC_FLEX slots are distributed across their eligible
 * positions by how the league's own starter demand splits, so a superflex
 * league lifts QB replacement level automatically.
 */

import type { FantasyPosition, LeagueProjection } from "./schema";

const FLEX_ELIGIBLE: Record<string, FantasyPosition[]> = {
  FLEX: ["RB", "WR", "TE"],
  WRRB_FLEX: ["RB", "WR"],
  REC_FLEX: ["WR", "TE"],
  SUPER_FLEX: ["QB", "RB", "WR", "TE"],
  IDP_FLEX: [],
};

const BASE_SLOT: Record<string, FantasyPosition> = {
  QB: "QB", RB: "RB", WR: "WR", TE: "TE", K: "K", DEF: "DEF",
};

export interface ReplacementLevels {
  /** starters demanded league-wide per position (fractional, incl. flex share) */
  demand: Record<FantasyPosition, number>;
  /** the replacement rank (1-indexed) per position */
  replacement_rank: Record<FantasyPosition, number>;
  /** league points at replacement rank per position */
  replacement_points: Record<FantasyPosition, number>;
}

export function computeReplacementLevels(
  rosterPositions: string[],
  numTeams: number,
  pool: LeagueProjection[],
): ReplacementLevels {
  const perTeam: Record<FantasyPosition, number> = { QB: 0, RB: 0, WR: 0, TE: 0, K: 0, DEF: 0 };

  for (const slot of rosterPositions) {
    if (slot === "BN" || slot === "IR" || slot === "TAXI") continue;
    const base = BASE_SLOT[slot];
    if (base) {
      perTeam[base] += 1;
      continue;
    }
    const elig = FLEX_ELIGIBLE[slot];
    if (elig && elig.length) {
      // split this flex slot across eligible positions by their base demand,
      // falling back to an even split when no base demand exists yet.
      const baseWeights = elig.map((p) => perTeam[p]);
      const wSum = baseWeights.reduce((a, b) => a + b, 0);
      elig.forEach((p, i) => {
        perTeam[p] += wSum > 0 ? baseWeights[i]! / wSum : 1 / elig.length;
      });
    }
  }

  const demand: Record<FantasyPosition, number> = { ...perTeam };
  const replacement_rank: Record<FantasyPosition, number> = { QB: 0, RB: 0, WR: 0, TE: 0, K: 0, DEF: 0 };
  const replacement_points: Record<FantasyPosition, number> = { QB: 0, RB: 0, WR: 0, TE: 0, K: 0, DEF: 0 };

  const byPos = groupByPosition(pool);

  for (const pos of Object.keys(perTeam) as FantasyPosition[]) {
    const leagueStarters = perTeam[pos] * numTeams;
    // replacement = first player past the last startable one, plus a small
    // bench cushion (~1 extra per 6 teams) to reflect real waiver quality.
    const rank = Math.max(1, Math.round(leagueStarters + numTeams / 6));
    replacement_rank[pos] = rank;
    const sorted = (byPos[pos] ?? []).slice().sort((a, b) => b.league_points - a.league_points);
    const at = sorted[Math.min(sorted.length - 1, rank - 1)];
    replacement_points[pos] = at ? round2(at.league_points) : 0;
  }

  return { demand, replacement_rank, replacement_points };
}

/**
 * Fill `replacement_points`, `value_over_replacement`, `vor_rank`,
 * `position_rank`, `overall_rank`, `tier` on every pool entry in place.
 */
export function applyValueOverReplacement(
  pool: LeagueProjection[],
  levels: ReplacementLevels,
): void {
  const byPos = groupByPosition(pool);

  for (const pos of Object.keys(byPos) as FantasyPosition[]) {
    const players = byPos[pos]!.slice().sort((a, b) => b.league_points - a.league_points);
    const repl = levels.replacement_points[pos] ?? 0;
    players.forEach((p, i) => {
      p.position_rank = i + 1;
      p.replacement_points = round2(repl);
      p.value_over_replacement = round2(p.league_points - repl);
    });
    assignTiers(players);
  }

  const overall = pool
    .slice()
    .sort((a, b) => (b.value_over_replacement ?? -1e9) - (a.value_over_replacement ?? -1e9));
  overall.forEach((p, i) => {
    p.overall_rank = i + 1;
    p.vor_rank = i + 1;
  });
}

/**
 * Gap-based tiering within a position: a new tier starts where the drop to the
 * next player exceeds `gapMult` x the local average drop.
 */
function assignTiers(sortedDesc: LeagueProjection[], gapMult = 1.9): void {
  if (sortedDesc.length === 0) return;
  const drops: number[] = [];
  for (let i = 1; i < sortedDesc.length; i++) {
    drops.push(Math.max(0, sortedDesc[i - 1]!.league_points - sortedDesc[i]!.league_points));
  }
  const avgDrop = drops.reduce((a, b) => a + b, 0) / Math.max(1, drops.length) || 1;
  let tier = 1;
  sortedDesc[0]!.tier = 1;
  for (let i = 1; i < sortedDesc.length; i++) {
    if (drops[i - 1]! > gapMult * avgDrop) tier++;
    sortedDesc[i]!.tier = tier;
  }
}

export interface PositionalScarcity {
  position: FantasyPosition;
  starters_demanded: number;
  replacement_rank: number;
  replacement_points: number;
  /** points between the #1 and the replacement-level player */
  elite_cliff: number;
  /** average VOR of the startable tier — higher = position is scarce/valuable */
  startable_vor_mean: number;
}

export function positionalScarcity(
  pool: LeagueProjection[],
  levels: ReplacementLevels,
  numTeams: number,
): PositionalScarcity[] {
  const byPos = groupByPosition(pool);
  const out: PositionalScarcity[] = [];
  for (const pos of Object.keys(levels.demand) as FantasyPosition[]) {
    const players = (byPos[pos] ?? []).slice().sort((a, b) => b.league_points - a.league_points);
    if (players.length === 0) continue;
    const starters = Math.round(levels.demand[pos] * numTeams);
    const repl = levels.replacement_points[pos] ?? 0;
    const startable = players.slice(0, Math.max(1, starters));
    out.push({
      position: pos,
      starters_demanded: starters,
      replacement_rank: levels.replacement_rank[pos] ?? 0,
      replacement_points: round2(repl),
      elite_cliff: round2((players[0]?.league_points ?? 0) - repl),
      startable_vor_mean: round2(
        startable.reduce((a, p) => a + (p.league_points - repl), 0) / startable.length,
      ),
    });
  }
  return out.sort((a, b) => b.startable_vor_mean - a.startable_vor_mean);
}

/* ------------------------------------------------------------------ helpers */

function groupByPosition(pool: LeagueProjection[]): Partial<Record<FantasyPosition, LeagueProjection[]>> {
  const out: Partial<Record<FantasyPosition, LeagueProjection[]>> = {};
  for (const p of pool) (out[p.position] ??= []).push(p);
  return out;
}
function round2(v: number): number { return Math.round(v * 100) / 100; }
