/**
 * PHASE 4 §21.2 / §21.3 / §28 — short-horizon lookahead ("cost of waiting").
 *
 * This is the heart of the snake decision. For each position it estimates what
 * the manager will realistically be choosing from at his NEXT pick, and turns
 * that into:
 *
 *   WaitProjectionLoss(pos) = bestNow(pos) − E[best available at next pick]
 *   WaitVORLoss(pos)        = same, in VOR units
 *
 * The correct recommendation may be the RB with the slightly lower current
 * projection if the RB pool collapses while the WR pool holds (§21.3).
 *
 * Method (deterministic, no game-tree search — §28 prefers the light version):
 *   - sort a position's available players by league points, desc
 *   - each has a survival probability p_i to the next pick
 *   - "player i is the best available at the next pick" iff i survives AND every
 *     player above i is gone:  P_i = p_i · Π_{j<i}(1 − p_j)
 *   - E[best available] = Σ_i points_i · P_i   (+ a residual for "all gone")
 *   - the range is [pessimistic, optimistic]: optimistic assumes the top
 *     survivor stays; pessimistic shifts down by one expected-taken sd.
 */

import type { FantasyPosition } from "@/lib/projections/schema";
import type { WaitComparison } from "./schema";

export interface LookaheadCandidate {
  player_id: string;
  league_points: number;
  vor: number;
  p_survives_next_pick: number;
}

export interface PositionOutlook {
  position: FantasyPosition;
  best_now_points: number;
  best_now_vor: number;
  expected_alt_points: [number, number];
  expected_alt_vor: [number, number];
  wait_projection_loss: [number, number];
  wait_vor_loss: [number, number];
  /** expected count of this position taken before the next pick */
  expected_taken: number;
}

function expectedBest(
  values: number[],
  survival: number[],
): { mean: number; optimistic: number; pessimistic: number; expectedTaken: number } {
  const n = values.length;
  if (n === 0) return { mean: 0, optimistic: 0, pessimistic: 0, expectedTaken: 0 };

  let gonePrefix = 1; // Π_{j<i} (1 - p_j)
  let mean = 0;
  for (let i = 0; i < n; i++) {
    const pi = clamp01(survival[i] ?? 0.5);
    mean += values[i]! * pi * gonePrefix;
    gonePrefix *= 1 - pi;
  }
  // residual mass = everyone gone -> fall to the last value (replacement-ish)
  mean += (values[n - 1] ?? 0) * gonePrefix;

  const expectedTaken = survival.reduce((a, p) => a + (1 - clamp01(p)), 0);
  const optimisticIdx = Math.max(0, Math.min(n - 1, Math.floor(expectedTaken)));
  const pessimisticIdx = Math.max(0, Math.min(n - 1, Math.ceil(expectedTaken + 1)));

  return {
    mean,
    optimistic: values[optimisticIdx] ?? values[n - 1] ?? 0,
    pessimistic: values[pessimisticIdx] ?? values[n - 1] ?? 0,
    expectedTaken,
  };
}

export function positionOutlook(
  position: FantasyPosition,
  candidates: LookaheadCandidate[],
): PositionOutlook {
  const sorted = candidates.slice().sort((a, b) => b.league_points - a.league_points);
  const pts = sorted.map((c) => c.league_points);
  const vor = sorted.map((c) => c.vor);
  const surv = sorted.map((c) => c.p_survives_next_pick);

  const bestNowPts = pts[0] ?? 0;
  const bestNowVor = vor[0] ?? 0;

  const p = expectedBest(pts, surv);
  const v = expectedBest(vor, surv);

  // range: [pessimistic (further down the board), optimistic (top holds)]
  const altPtsLo = Math.min(p.pessimistic, p.mean);
  const altPtsHi = Math.max(p.optimistic, p.mean);
  const altVorLo = Math.min(v.pessimistic, v.mean);
  const altVorHi = Math.max(v.optimistic, v.mean);

  return {
    position,
    best_now_points: round2(bestNowPts),
    best_now_vor: round2(bestNowVor),
    expected_alt_points: [round2(altPtsLo), round2(altPtsHi)],
    expected_alt_vor: [round2(altVorLo), round2(altVorHi)],
    wait_projection_loss: [round2(bestNowPts - altPtsHi), round2(bestNowPts - altPtsLo)],
    wait_vor_loss: [round2(bestNowVor - altVorHi), round2(bestNowVor - altVorLo)],
    expected_taken: round2(p.expectedTaken),
  };
}

/** Build a `WaitComparison` for one player from his position's outlook. */
export function waitComparisonForPlayer(
  outlook: PositionOutlook,
  playerLeaguePoints: number,
  playerVor: number,
): WaitComparison {
  const altPts = outlook.expected_alt_points;
  const altVor = outlook.expected_alt_vor;
  return {
    position: outlook.position,
    take_now_points: round2(playerLeaguePoints),
    take_now_vor: round2(playerVor),
    expected_alternative_points: altPts,
    expected_alternative_vor: altVor,
    wait_projection_loss: [
      round2(playerLeaguePoints - altPts[1]),
      round2(playerLeaguePoints - altPts[0]),
    ],
    wait_vor_loss: [
      round2(playerVor - altVor[1]),
      round2(playerVor - altVor[0]),
    ],
    basis:
      `${outlook.expected_taken} ${outlook.position} expected off the board before the next pick; ` +
      `E[best ${outlook.position} available] ≈ ${altPts[0]}–${altPts[1]} pts`,
  };
}

/**
 * The urgency term (§6): `TakeNowValue − WaitValue`, in league-point units.
 * Take-now = the player's points. Wait = P(survives) × E[his own value later,
 * which is unchanged] + P(gone) × E[best available at his position later].
 * Net = (1 − p_survive) × (points − E[best available later]).
 * Scaled by survival confidence so a LOW-confidence estimate can't spike it.
 */
export function urgencyValue(
  playerLeaguePoints: number,
  pSurvivesNextPick: number,
  expectedAltPointsMid: number,
  confidenceScale: number,
): number {
  const raw = (1 - clamp01(pSurvivesNextPick)) * (playerLeaguePoints - expectedAltPointsMid);
  return round2(Math.max(0, raw) * clamp01(confidenceScale));
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
