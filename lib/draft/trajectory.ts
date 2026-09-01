/**
 * PHASE 4 §15 — roster-construction trajectory.
 *
 * The engine does not evaluate only the open slots right now; it asks whether
 * the roster is on a path that can still finish a legal, startable lineup.
 *
 *   StarterCompletionRisk — P(cannot fill core starters + flex on this path)
 *   FlexCompletionRisk    — same, isolated to the flex slots
 *   PositionConcentration — how lopsided the roster already is (0 = balanced)
 *   BenchBalance          — whether bench depth is spread across positions
 *
 * "Drafting WR5 while RB2 is empty" is fine in SOME states; doing it until no
 * startable RB remains is not. The risk metric captures exactly that: it climbs
 * when an open starter position's startable supply is running out relative to
 * the manager's remaining picks.
 */

import type { FantasyPosition } from "@/lib/projections/schema";
import { computeRosterNeeds } from "@/lib/sleeper/draft";
import type { NormalizedPlayer } from "@/lib/sleeper/types";
import type { RosterTrajectory } from "./schema";

const CORE: FantasyPosition[] = ["QB", "RB", "WR", "TE"];
const FLEX_ELIGIBLE = new Set<FantasyPosition>(["RB", "WR", "TE"]);

export interface TrajectoryInput {
  rosterPlayers: NormalizedPlayer[];
  rosterPositions: string[];
  /** the manager's remaining picks in the whole draft (incl. the current one) */
  picksRemaining: number;
  /** startable-quality players still available, per position (VOR > 0) */
  startableRemaining: Record<FantasyPosition, number>;
  /** expected picks of each position by other teams before the manager's next turn */
  demandBeforeNextTurn: Record<FantasyPosition, number>;
}

export function computeRosterTrajectory(input: TrajectoryInput): RosterTrajectory {
  const needs = computeRosterNeeds(input.rosterPlayers, input.rosterPositions);

  const open_starters: Record<string, number> = { QB: 0, RB: 0, WR: 0, TE: 0, K: 0, DEF: 0 };
  for (const r of needs.required) open_starters[r.position] = r.minimum_needed;
  const open_flex = needs.flexible_slots_remaining;

  const totalOpenStarterSlots =
    Object.values(open_starters).reduce((a, b) => a + b, 0) + open_flex;
  const buffer = input.picksRemaining - totalOpenStarterSlots;

  // --- per-position completion pressure -----------------------------------
  const at_risk: FantasyPosition[] = [];
  let worstPositionRisk = 0;
  for (const pos of CORE) {
    const need = open_starters[pos] ?? 0;
    if (need <= 0) continue;
    const supply = input.startableRemaining[pos] ?? 0;
    const demand = input.demandBeforeNextTurn[pos] ?? 0;
    // players likely to still be startable at this position by the manager's
    // NEXT pick, minus what he needs. Negative => likely to miss the tier.
    const projectedSlack = supply - demand - need;
    const risk = logistic(-projectedSlack / 1.5);
    if (risk >= 0.4) at_risk.push(pos);
    worstPositionRisk = Math.max(worstPositionRisk, risk);
  }

  // physical impossibility dominates
  const physicalRisk = buffer < 0 ? 1 : logistic((1.5 - buffer) / 1.2);
  const starter_completion_risk = clamp01(Math.max(physicalRisk, worstPositionRisk));

  // flex: needs at least one of RB/WR/TE startable per open flex slot
  const flexSupply = [...FLEX_ELIGIBLE].reduce(
    (a, p) => a + (input.startableRemaining[p] ?? 0),
    0,
  );
  const flexDemand = [...FLEX_ELIGIBLE].reduce(
    (a, p) => a + (input.demandBeforeNextTurn[p] ?? 0),
    0,
  );
  const flex_completion_risk =
    open_flex <= 0 ? 0 : clamp01(logistic((open_flex + flexDemand - flexSupply) / 3));

  // --- concentration / balance ------------------------------------------
  const counts: Record<string, number> = {};
  for (const p of input.rosterPlayers) {
    const pos = p.position ?? "?";
    counts[pos] = (counts[pos] ?? 0) + 1;
  }
  const coreCounts = CORE.map((p) => counts[p] ?? 0);
  const meanCore = coreCounts.reduce((a, b) => a + b, 0) / CORE.length || 0;
  const variance =
    coreCounts.reduce((a, c) => a + (c - meanCore) ** 2, 0) / CORE.length;
  const position_concentration = round3(Math.sqrt(variance) / (meanCore + 1));

  const rosterSize = input.rosterPlayers.length || 1;
  const benchSpread = new Set(input.rosterPlayers.map((p) => p.position)).size;
  const bench_balance = round3(benchSpread / Math.min(rosterSize, CORE.length + 2));

  return {
    open_starters,
    open_flex,
    starter_completion_risk: round3(starter_completion_risk),
    flex_completion_risk: round3(flex_completion_risk),
    position_concentration,
    bench_balance,
    at_risk_positions: at_risk,
  };
}

/**
 * The change in starter-completion risk from adding one player at `position`.
 * A negative delta (risk relief) is what the construction-risk utility term
 * rewards; a positive delta (piling onto a filled position while a starter slot
 * rots) is what it penalises.
 */
export function riskDeltaFromPick(
  before: RosterTrajectory,
  position: FantasyPosition,
  input: TrajectoryInput,
): number {
  const open = before.open_starters[position] ?? 0;
  const flexHelp = FLEX_ELIGIBLE.has(position) && before.open_flex > 0;
  if (open <= 0 && !flexHelp) {
    // adds no starter capacity; if other positions are at risk this is a cost
    return before.at_risk_positions.length > 0 ? 0.12 * before.starter_completion_risk : 0;
  }
  // recompute risk with this slot conceptually filled
  const startable = { ...input.startableRemaining };
  startable[position] = Math.max(0, (startable[position] ?? 0) - 1);
  const synthetic: NormalizedPlayer = {
    player_id: `__synthetic_${position}`,
    full_name: `synthetic ${position}`,
    first_name: null,
    last_name: null,
    position,
    fantasy_positions: [position],
    team: null,
    age: null,
    years_exp: null,
    status: null,
    injury_status: null,
    number: null,
    active: true,
    search_rank: null,
    depth_chart_order: null,
    depth_chart_position: null,
    resolved: true,
  };
  const after = computeRosterTrajectory({
    ...input,
    rosterPlayers: [...input.rosterPlayers, synthetic],
    picksRemaining: input.picksRemaining - 1,
    startableRemaining: startable,
  });
  return round3(after.starter_completion_risk - before.starter_completion_risk);
}

function logistic(x: number): number {
  return 1 / (1 + Math.exp(-x));
}
function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}
