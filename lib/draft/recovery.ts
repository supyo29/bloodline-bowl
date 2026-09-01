/**
 * PHASE 6 §9/§10/§11/§36 — positional recovery cost + roster trajectory state.
 *
 * `RecoveryCost_p` = the expected value a manager gives up by not drafting
 * position `p` now and instead taking his next viable `p` at a future turn.
 * Reuses the Phase 4 lookahead machinery (`positionOutlook`) — this is NOT a
 * new survival or value model, just the multi-turn application of the frozen
 * Phase 4/5 one built for Phase 4's single-turn wait-loss.
 *
 * `TrajectoryRisk` composes (§11): OpenStarterRisk (from `trajectory.ts`'s
 * `starter_completion_risk`), FutureTierRisk (from recovery cost — a position
 * whose tier collapses by the next 1-2 turns is risky to leave open),
 * PositionConcentrationRisk (`trajectory.ts`'s `position_concentration`), and
 * LowDepthRisk (bench_balance inverse). It does NOT penalize an unconventional
 * build merely for being unconventional (§12) — only when the forward-looking
 * numbers say a position is genuinely hard to recover.
 */

import type { FantasyPosition, LeagueProjection } from "@/lib/projections/schema";
import { positionOutlook, type LookaheadCandidate, type PositionOutlook } from "./lookahead";
import type { RosterTrajectory } from "./schema";

export interface MultiTurnCliff {
  position: FantasyPosition;
  current_tier: number | null;
  /** best available player's tier right now */
  outlook_next_turn: PositionOutlook;
  outlook_second_turn: PositionOutlook | null;
  /** points/VOR lost between "best now" and the second-turn expectation */
  recovery_cost_points: number;
  recovery_cost_vor: number;
}

/**
 * Build the multi-turn recovery-cost forecast for one position, at two future
 * horizons (the manager's next turn, and the turn after). `candidatesAt`
 * supplies the still-available pool + per-player survival to EACH horizon
 * (already conditioned on current availability — Phase 5).
 */
export function positionRecoveryCost(
  position: FantasyPosition,
  currentBestPoints: number,
  currentBestVor: number,
  nextTurn: LookaheadCandidate[],
  secondTurn: LookaheadCandidate[] | null,
): MultiTurnCliff {
  const outlookNext = positionOutlook(position, nextTurn);
  const outlookSecond = secondTurn ? positionOutlook(position, secondTurn) : null;

  // recovery cost uses the SECOND turn when available (the true "postpone this
  // position for a full extra cycle" cost); falls back to the next turn.
  const target = outlookSecond ?? outlookNext;
  const midPts = (target.expected_alt_points[0] + target.expected_alt_points[1]) / 2;
  const midVor = (target.expected_alt_vor[0] + target.expected_alt_vor[1]) / 2;

  return {
    position,
    current_tier: null,
    outlook_next_turn: outlookNext,
    outlook_second_turn: outlookSecond,
    recovery_cost_points: round2(Math.max(0, currentBestPoints - midPts)),
    recovery_cost_vor: round2(Math.max(0, currentBestVor - midVor)),
  };
}

/* -------------------------------------------------------------- trajectory risk */

export interface TrajectoryRiskInput {
  trajectory: RosterTrajectory;
  /** recovery cost (VOR) per open-starter position, from `positionRecoveryCost` */
  recoveryCostByPosition: Partial<Record<FantasyPosition, number>>;
  /** typical single-position recovery cost league-wide, for normalisation */
  typicalRecoveryCostVor: number;
}

export interface TrajectoryRiskBreakdown {
  open_starter_risk: number;
  future_tier_risk: number;
  position_concentration_risk: number;
  low_depth_risk: number;
  /** bounded 0..1 composite */
  trajectory_risk: number;
}

/**
 * Composite, bounded [0,1]. Each term is itself bounded, and the composite is
 * a weighted mean (not a sum), so it cannot blow past 1 regardless of how many
 * terms fire — this is what keeps a later Phase-4 planning term boundable
 * (§33, §45 "trajectory penalty must remain bounded").
 */
export function computeTrajectoryRisk(input: TrajectoryRiskInput): TrajectoryRiskBreakdown {
  const open_starter_risk = clamp01(input.trajectory.starter_completion_risk);

  const costs = Object.values(input.recoveryCostByPosition).filter((v): v is number => v != null);
  const worst = costs.length ? Math.max(...costs) : 0;
  const future_tier_risk = clamp01(worst / Math.max(1, 2.5 * input.typicalRecoveryCostVor));

  const position_concentration_risk = clamp01(input.trajectory.position_concentration / 2.5);
  const low_depth_risk = clamp01(1 - input.trajectory.bench_balance);

  const trajectory_risk = round3(
    clamp01(
      0.35 * open_starter_risk +
        0.35 * future_tier_risk +
        0.2 * position_concentration_risk +
        0.1 * low_depth_risk,
    ),
  );

  return {
    open_starter_risk: round3(open_starter_risk),
    future_tier_risk: round3(future_tier_risk),
    position_concentration_risk: round3(position_concentration_risk),
    low_depth_risk: round3(low_depth_risk),
    trajectory_risk,
  };
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

export type { LeagueProjection };
