/**
 * PHASE 4 §14 — K / DST hard timing gate.
 *
 * K and DST are HARD-ineligible as an early primary recommendation. Their
 * replacement level and weekly-streaming economics differ from core positions,
 * and the frozen scoring model can make a kicker's raw projected points look
 * competitive with a WR3 — which it is not, in draft-value terms.
 *
 * Release rule (deterministic, documented):
 *   K and DST become draftable only in the final `KDST_RELEASE_TAIL_ROUNDS`
 *   rounds of the draft, OR once the manager has filled every core starting
 *   slot (QB/RB/WR/TE + FLEX) AND has at most `KDST_BENCH_SLACK` bench slots
 *   left — whichever comes first.
 *
 * Before the release point, K/DST are removed from the candidate pool with a
 * `kdst_before_release` hard reason. After it, they are ordinary candidates
 * (still scored on VOR etc., no artificial boost).
 *
 * Phase 7 will do deeper K/DST validation; this gate is intentionally strict.
 */

import type { FantasyPosition } from "@/lib/projections/schema";

/** K/DST open in the last N rounds regardless of roster state. */
export const KDST_RELEASE_TAIL_ROUNDS = 3;
/** ...or once core starters are done and the bench is nearly full. */
export const KDST_BENCH_SLACK = 1;

export interface KdstGateInput {
  totalRounds: number;
  /** the round the manager's current pick falls in (1-indexed) */
  currentRound: number | null;
  /** open required starter slots for CORE positions only (QB/RB/WR/TE) */
  openCoreStarters: number;
  /** open flex slots */
  openFlex: number;
  /** bench slots not yet filled */
  openBench: number;
}

export interface KdstGate {
  released: boolean;
  release_round: number;
  reason: string;
}

export function evaluateKdstGate(input: KdstGateInput): KdstGate {
  const releaseRound = Math.max(1, input.totalRounds - KDST_RELEASE_TAIL_ROUNDS + 1);
  const round = input.currentRound ?? 1;

  const byRound = round >= releaseRound;
  const byRoster =
    input.openCoreStarters === 0 &&
    input.openFlex === 0 &&
    input.openBench <= KDST_BENCH_SLACK;

  const released = byRound || byRoster;
  return {
    released,
    release_round: releaseRound,
    reason: released
      ? byRound
        ? `round ${round} ≥ release round ${releaseRound} (last ${KDST_RELEASE_TAIL_ROUNDS} rounds)`
        : `core starters + flex filled and ≤ ${KDST_BENCH_SLACK} bench slot(s) left`
      : `held: round ${round} < release round ${releaseRound}, and core lineup not yet complete`,
  };
}

export function isKdst(position: FantasyPosition): boolean {
  return position === "K" || position === "DEF";
}
