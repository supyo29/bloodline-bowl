/**
 * PHASE 6 §5/§6 — final-roster utility + optimal starter/FLEX assignment.
 *
 * RESEARCH / EVALUATION function — this is NOT the production recommendation
 * score (§5: "This function is NOT automatically the production recommendation
 * score"). It answers "how good is this finished 15-round roster", used by the
 * simulation harness to compare strategies (`scripts/phase6-simulation.ts`)
 * and, if promoted, to derive a small bounded trajectory term for Phase 4.
 *
 * Starter/FLEX assignment (§6): Bloodline's slots are QB, RB, RB, WR, WR, TE,
 * FLEX, FLEX, K, DEF. Because the base slots are position-locked and FLEX
 * accepts RB/WR/TE, the optimal assignment is a simple greedy — fill each
 * position-locked slot with the top players of that position, then fill FLEX
 * from whatever RB/WR/TE remains, by value. This is provably optimal here (an
 * exchange argument: the base requirement is a hard floor, so no swap into
 * FLEX can ever raise total value once the top-N per locked position are
 * seated) — no ILP/Hungarian-algorithm machinery needed.
 */

import type { FantasyPosition, LeagueProjection } from "@/lib/projections/schema";
import { computeReplacementLevels, vorOf, type ReplacementLevels } from "./replacement";

const FLEX_ELIGIBLE: FantasyPosition[] = ["RB", "WR", "TE"];

export interface StarterSlots {
  QB: number; RB: number; WR: number; TE: number; K: number; DEF: number; FLEX: number;
}

/** Read the league's starter demand straight from its own roster_positions. */
export function starterSlotsOf(rosterPositions: string[]): StarterSlots {
  const s: StarterSlots = { QB: 0, RB: 0, WR: 0, TE: 0, K: 0, DEF: 0, FLEX: 0 };
  for (const slot of rosterPositions) {
    if (slot === "BN" || slot === "IR" || slot === "TAXI") continue;
    if (slot in s && slot !== "FLEX") s[slot as keyof StarterSlots] += 1;
    else if (slot === "FLEX" || slot === "WRRB_FLEX" || slot === "REC_FLEX" || slot === "WRRB_WRT") s.FLEX += 1;
  }
  return s;
}

export interface RosterAssignment {
  starters: Partial<Record<FantasyPosition, LeagueProjection[]>>;
  flex: LeagueProjection[];
  bench: LeagueProjection[];
  open_slots: Partial<Record<FantasyPosition, number>>;
  open_flex: number;
}

/**
 * Assign an owned player set to starting slots optimally, per the greedy
 * argument above. `owned` may contain any positions; only FantasyPosition
 * (QB/RB/WR/TE/K/DEF) players are placed, others fall to bench (defensive —
 * should not occur with a legal roster).
 */
export function assignOptimalRoster(
  owned: LeagueProjection[],
  slots: StarterSlots,
): RosterAssignment {
  const byPos: Record<FantasyPosition, LeagueProjection[]> = { QB: [], RB: [], WR: [], TE: [], K: [], DEF: [] };
  for (const p of owned) (byPos[p.position] ??= []).push(p);
  for (const pos of Object.keys(byPos) as FantasyPosition[]) {
    byPos[pos]!.sort((a, b) => b.league_points - a.league_points);
  }

  const starters: Partial<Record<FantasyPosition, LeagueProjection[]>> = {};
  const open_slots: Partial<Record<FantasyPosition, number>> = {};
  const leftover: LeagueProjection[] = [];

  for (const pos of ["QB", "K", "DEF"] as FantasyPosition[]) {
    const need = slots[pos];
    const take = byPos[pos]!.slice(0, need);
    starters[pos] = take;
    open_slots[pos] = Math.max(0, need - take.length);
    leftover.push(...byPos[pos]!.slice(need));
  }
  // RB/WR/TE base slots, then FLEX from the remaining pool of the three
  const flexPool: LeagueProjection[] = [];
  for (const pos of FLEX_ELIGIBLE) {
    const need = slots[pos];
    const take = byPos[pos]!.slice(0, need);
    starters[pos] = take;
    open_slots[pos] = Math.max(0, need - take.length);
    flexPool.push(...byPos[pos]!.slice(need));
  }
  flexPool.sort((a, b) => b.league_points - a.league_points);
  const flex = flexPool.slice(0, slots.FLEX);
  const open_flex = Math.max(0, slots.FLEX - flex.length);
  const bench = [...flexPool.slice(slots.FLEX), ...leftover];

  return { starters, flex, bench, open_slots, open_flex };
}

/* -------------------------------------------------------------- utility */

export interface RosterUtilityWeights {
  starter_vor: number;
  flex_vor: number;
  /** bench VOR is multiplied by this before counting (§21 — a bench point is not a starter point) */
  bench_discount: number;
  positional_advantage: number;
  /** points charged per unfilled REQUIRED starter slot (uses replacement level) */
  starter_completion_penalty_scale: number;
  construction_risk: number;
}

/**
 * Default weights. `bench_discount` and `starter_completion_penalty_scale` are
 * swept in `analysis/phase6_roster_trajectory.R` §21 sensitivity analysis;
 * these are the values that held up.
 */
export const DEFAULT_ROSTER_UTILITY_WEIGHTS: RosterUtilityWeights = {
  starter_vor: 1.0,
  flex_vor: 1.0,
  bench_discount: 0.3,
  positional_advantage: 0.5,
  starter_completion_penalty_scale: 1.5,
  construction_risk: 40,
};

export interface RosterUtilityBreakdown {
  starter_vor: number;
  starter_points: number;
  flex_vor: number;
  flex_points: number;
  bench_vor_raw: number;
  bench_vor_discounted: number;
  positional_advantage: number;
  starter_completion_penalty: number;
  open_starter_slots: number;
  construction_risk_penalty: number;
  utility: number;
}

/**
 * §5 FinalRosterUtility = StarterVOR + FlexVOR + discounted BenchVOR
 *                        + PositionalAdvantage − StarterCompletionPenalty
 *                        − ConstructionRisk
 *
 * `leagueMedianVorByPosition` (a starter-quality baseline, e.g. the median VOR
 * of the Nth-best player at each position across the league pool) powers
 * PositionalAdvantage: an elite starter is worth more than a replacement-level
 * one at the same slot, beyond what raw VOR already captures relative to
 * bench-level replacement — this rewards a true positional EDGE (a QB1 who
 * clearly outproduces a typical Bloodline starting QB), which is what makes an
 * elite QB/TE pick legitimately valuable in the final-roster sense.
 */
export function computeRosterUtility(
  assignment: RosterAssignment,
  levels: ReplacementLevels,
  leagueMedianStarterVor: Partial<Record<FantasyPosition, number>>,
  weights: RosterUtilityWeights = DEFAULT_ROSTER_UTILITY_WEIGHTS,
  constructionRisk = 0,
): RosterUtilityBreakdown {
  let starterVor = 0;
  let starterPts = 0;
  let posAdv = 0;
  for (const pos of Object.keys(assignment.starters) as FantasyPosition[]) {
    for (const p of assignment.starters[pos] ?? []) {
      const v = vorOf(p, levels);
      starterVor += v;
      starterPts += p.league_points;
      const med = leagueMedianStarterVor[pos] ?? 0;
      posAdv += Math.max(0, v - med);
    }
  }
  let flexVor = 0;
  let flexPts = 0;
  for (const p of assignment.flex) {
    flexVor += vorOf(p, levels);
    flexPts += p.league_points;
  }
  let benchVorRaw = 0;
  for (const p of assignment.bench) benchVorRaw += Math.max(0, vorOf(p, levels));
  const benchVorDisc = benchVorRaw * weights.bench_discount;

  const openStarters =
    Object.values(assignment.open_slots).reduce((a, b) => a + (b ?? 0), 0) + assignment.open_flex;
  // penalty magnitude anchored to the position's own replacement level, so an
  // open QB slot in a QB-shallow league costs more than in a QB-deep one
  const avgReplacement =
    (Object.values(levels.replacement_points).reduce((a, b) => a + b, 0) || 0) / 6;
  const completionPenalty = openStarters * avgReplacement * weights.starter_completion_penalty_scale;

  const utility = round2(
    weights.starter_vor * starterVor +
      weights.flex_vor * flexVor +
      weights.positional_advantage * posAdv +
      benchVorDisc -
      completionPenalty -
      weights.construction_risk * constructionRisk,
  );

  return {
    starter_vor: round2(starterVor),
    starter_points: round2(starterPts),
    flex_vor: round2(flexVor),
    flex_points: round2(flexPts),
    bench_vor_raw: round2(benchVorRaw),
    bench_vor_discounted: round2(benchVorDisc),
    positional_advantage: round2(posAdv),
    starter_completion_penalty: round2(completionPenalty),
    open_starter_slots: openStarters,
    construction_risk_penalty: round2(weights.construction_risk * constructionRisk),
    utility,
  };
}

/** Median VOR of the Nth-best player per position, across the full league pool. */
export function leagueMedianStarterVor(
  pool: LeagueProjection[],
  slots: StarterSlots,
  numTeams: number,
  levels: ReplacementLevels,
): Partial<Record<FantasyPosition, number>> {
  const out: Partial<Record<FantasyPosition, number>> = {};
  const byPos: Record<FantasyPosition, LeagueProjection[]> = { QB: [], RB: [], WR: [], TE: [], K: [], DEF: [] };
  for (const p of pool) (byPos[p.position] ??= []).push(p);
  for (const pos of Object.keys(byPos) as FantasyPosition[]) {
    const need = pos === "RB" || pos === "WR" || pos === "TE" ? slots[pos] + slots.FLEX / 3 : slots[pos];
    const n = Math.max(1, Math.round(need * numTeams));
    const sorted = byPos[pos]!.slice().sort((a, b) => b.league_points - a.league_points).slice(0, n);
    const vors = sorted.map((p) => vorOf(p, levels)).sort((a, b) => a - b);
    out[pos] = vors.length ? vors[Math.floor(vors.length / 2)]! : 0;
  }
  return out;
}

export { computeReplacementLevels };

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
