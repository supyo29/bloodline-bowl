/**
 * W1.P2 injury priors — EVIDENCE COUNTS, not hand-set probabilities.
 *
 * Each cell is `[n, active]`: of `n` injury-reported player-weeks, `active` produced offensive snaps. The model turns counts
 * into probabilities with Beta shrinkage (see injury-model.ts), so a thin cell is pulled toward its parent instead of
 * producing false precision. Counts are reproduced from committed data by `scripts/injury-calibration.ts`; the test
 * `injury-calibration.test.ts` recomputes them and fails if they drift.
 *
 * Training window: 2025 regular season W1-18 (nflverse final team-week designation + observed offensive snaps). 2026 W1-4 is
 * held out and NEVER used here. Single-season prior: every probability derived from it is PROVISIONAL.
 */

export const INJURY_PRIOR_VERSION = "injury-priors-2025-w1-18.v1" as const;

export type Counts = readonly [n: number, active: number];
export type Practice = "FULL" | "LIMITED" | "DNP";
export type RoleTier = "RELEVANT" | "FRINGE";

export interface QuestionablePriors {
  pooled: Counts;
  tier: Record<RoleTier, Counts>;
  cell: Record<RoleTier, Record<Practice, Counts>>;
}

export interface InjuryPriorCounts {
  version: typeof INJURY_PRIOR_VERSION;
  /** designation -> evidence. Questionable is stratified; Doubtful/Out are pooled (sample too small to stratify). */
  questionable: QuestionablePriors;
  doubtful: Counts;
  out: Counts;
}

/** Shrinkage strength (pseudo-observations) and the parent prior mean used when a Doubtful cell is almost empty. */
export const SHRINKAGE_K = 10;
export const DOUBTFUL_PARENT_MEAN = 0.15;
/** A source projection at/above this many points marks a decision-relevant player (role proxy available at runtime). */
export const RELEVANT_SOURCE_POINTS = 8;

export const INJURY_PRIOR_COUNTS: InjuryPriorCounts = {
  version: INJURY_PRIOR_VERSION,
  questionable: {
    pooled: [352, 206],
    tier: { RELEVANT: [121, 87], FRINGE: [189, 101] },
    cell: {
      RELEVANT: { FULL: [17, 16], LIMITED: [83, 57], DNP: [16, 10] },
      FRINGE: { FULL: [41, 22], LIMITED: [121, 65], DNP: [23, 11] },
    },
  },
  doubtful: [29, 0],
  out: [428, 0],
};
