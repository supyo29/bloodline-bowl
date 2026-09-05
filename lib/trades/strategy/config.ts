/**
 * Trade Engine — Phase 6 configuration and thresholds. Every weight here is
 * conservative, bounded, and documented — none is learned or calibrated
 * (trade-level calibration remains deferred, `TRADE_CALIBRATION_MIN_REAL_TRADES`
 * unchanged at 50). Where evidence is insufficient for a component, its
 * weight is 0 or the component is diagnostic-only, never invented.
 */

import type { HorizonWeights, StrategicArchetype, TimeHorizon } from "./types";
import type { AcceptanceClass } from "../schema";

export const TRADE_STRATEGY_VERSION = "ri-trade-strategy-2026.1" as const;

/* -------------------------------------------------------------------------- */
/* 6A — season stage thresholds, derived from league geometry (fractions of   */
/* the regular season), not hardcoded NFL week numbers.                       */
/* -------------------------------------------------------------------------- */

/** midseason begins once this fraction of the regular season has elapsed */
export const MIDSEASON_FRACTION = 0.4;
/** playoff push begins once this fraction of the regular season remains (i.e. this close to the playoff cutover) */
export const PLAYOFF_PUSH_WEEKS_REMAINING = 3;

/* -------------------------------------------------------------------------- */
/* 6B — playoff status classification (categorical, no fabricated odds)       */
/* -------------------------------------------------------------------------- */

/** a team this many games back (by win_percentage-equivalent) of the last playoff spot is BUBBLE, not LONG_SHOT */
export const BUBBLE_GAMES_BACK_MAX = 1.5;
/** a team this many games back is mathematically distant but not yet eliminated */
export const LONG_SHOT_GAMES_BACK_MAX = 3.5;
/** rank at or inside the playoff line, at least this many games clear of the cutline, is STRONG_POSITION; clear by more is CLINCHED-eligible (still gated by weeks remaining) */
export const CLINCH_GAMES_CLEAR_MIN = 2.5;
export const CLINCH_MAX_WEEKS_REMAINING = 3;
/**
 * Spec §6/§11: "do not classify based solely on current rank," and "avoid
 * letting one weak metric determine the classification." At 0-1 games
 * played every team is tied (or separated by a single result), so ANY
 * playoff-status label reads as false confidence rather than real signal —
 * below this games-played floor, playoff status (and therefore archetype)
 * is UNKNOWN, not a guess dressed up as STRONG_POSITION/CONTENDER.
 */
export const MIN_GAMES_PLAYED_FOR_STATUS = 2;

/* -------------------------------------------------------------------------- */
/* 6D — urgency formula. Documented, linear, bounded [0, 1].                  */
/* score = clamp(0.5 * playoff_status_component + 0.3 * time_pressure_component + 0.2 * record_component, 0, 1) */
/* -------------------------------------------------------------------------- */

export const URGENCY_WEIGHTS = { playoff_status: 0.5, time_pressure: 0.3, record: 0.2 } as const;

export const PLAYOFF_STATUS_URGENCY: Record<string, number> = {
  CLINCHED: 0.05,
  STRONG_POSITION: 0.25,
  BUBBLE: 0.75,
  LONG_SHOT: 0.55,
  ELIMINATED: 0.1,
  UNKNOWN: 0.4,
};

/** horizon weights per archetype — how much each archetype should weight each planning horizon, summing to 1.0 per archetype */
export const HORIZON_WEIGHTS_BY_ARCHETYPE: Record<StrategicArchetype, HorizonWeights> = {
  FRONT_RUNNER: { CURRENT_WEEK: 0.1, NEXT_3_WEEKS: 0.15, REST_OF_REGULAR_SEASON: 0.15, FANTASY_PLAYOFFS: 0.5, FULL_REMAINING_SEASON: 0.1 },
  CONTENDER: { CURRENT_WEEK: 0.15, NEXT_3_WEEKS: 0.2, REST_OF_REGULAR_SEASON: 0.2, FANTASY_PLAYOFFS: 0.35, FULL_REMAINING_SEASON: 0.1 },
  BUBBLE: { CURRENT_WEEK: 0.3, NEXT_3_WEEKS: 0.35, REST_OF_REGULAR_SEASON: 0.2, FANTASY_PLAYOFFS: 0.1, FULL_REMAINING_SEASON: 0.05 },
  MUST_WIN: { CURRENT_WEEK: 0.4, NEXT_3_WEEKS: 0.4, REST_OF_REGULAR_SEASON: 0.15, FANTASY_PLAYOFFS: 0.03, FULL_REMAINING_SEASON: 0.02 },
  LONG_SHOT: { CURRENT_WEEK: 0.2, NEXT_3_WEEKS: 0.3, REST_OF_REGULAR_SEASON: 0.3, FANTASY_PLAYOFFS: 0.1, FULL_REMAINING_SEASON: 0.1 },
  ELIMINATED: { CURRENT_WEEK: 0.2, NEXT_3_WEEKS: 0.2, REST_OF_REGULAR_SEASON: 0.3, FANTASY_PLAYOFFS: 0.1, FULL_REMAINING_SEASON: 0.2 },
  UNKNOWN: { CURRENT_WEEK: 0.2, NEXT_3_WEEKS: 0.2, REST_OF_REGULAR_SEASON: 0.2, FANTASY_PLAYOFFS: 0.2, FULL_REMAINING_SEASON: 0.2 },
};

/** two highest-weighted horizons per archetype are reported as `preferred_horizons` */
export function preferredHorizonsFor(weights: HorizonWeights): TimeHorizon[] {
  return (Object.entries(weights) as Array<[TimeHorizon, number]>).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([h]) => h);
}

/* -------------------------------------------------------------------------- */
/* 6F — strategic adjustment caps and rationality floor                       */
/* -------------------------------------------------------------------------- */

/**
 * The strategic adjustment (sum of all components) can never exceed this
 * fraction of the trade's own |base_utility_delta|, with a small fixed floor
 * so a break-even trade can still receive a modest strategic nudge. This is
 * the Core Phase 6 Invariant's enforcement point: standings context can
 * change PREFERENCE, never overwhelm roster economics.
 */
export const STRATEGIC_ADJUSTMENT_CAP_FRACTION = 0.5;
export const STRATEGIC_ADJUSTMENT_CAP_FLOOR = 0.75;

function capMagnitude(baseUtilityDelta: number): number {
  return Math.max(STRATEGIC_ADJUSTMENT_CAP_FLOOR, Math.abs(baseUtilityDelta) * STRATEGIC_ADJUSTMENT_CAP_FRACTION);
}

export function capStrategicAdjustment(raw: number, baseUtilityDelta: number): { capped: number; wasCapped: boolean } {
  const cap = capMagnitude(baseUtilityDelta);
  if (raw > cap) return { capped: cap, wasCapped: true };
  if (raw < -cap) return { capped: -cap, wasCapped: true };
  return { capped: raw, wasCapped: false };
}

/**
 * Rationality-floor promotion policy (spec §32), applied to `base_acceptance`
 * to produce the ceiling `strategic_acceptance` may reach — strategic context
 * can promote AT MOST one band, and HARD_REJECT can never be promoted at all.
 * `strategic_acceptance` is additionally never allowed past this ceiling even
 * if the computed strategic score would suggest more.
 */
const PROMOTION_CEILING: Record<AcceptanceClass, AcceptanceClass> = {
  HARD_REJECT: "HARD_REJECT",
  REJECT: "RELUCTANT",
  RELUCTANT: "NEUTRAL",
  NEUTRAL: "ACCEPT",
  ACCEPT: "ACCEPT",
  STRONG_ACCEPT: "STRONG_ACCEPT",
};

export function promotionCeiling(base: AcceptanceClass): AcceptanceClass {
  return PROMOTION_CEILING[base];
}

const ACCEPTANCE_ORDER: AcceptanceClass[] = ["HARD_REJECT", "REJECT", "RELUCTANT", "NEUTRAL", "ACCEPT", "STRONG_ACCEPT"];
export function acceptanceRank(a: AcceptanceClass): number {
  return ACCEPTANCE_ORDER.indexOf(a);
}

/** minimum net-positive strategic adjustment required before promoting acceptance at all — avoids promoting on noise */
export const PROMOTION_MIN_ADJUSTMENT = 0.25;

/* -------------------------------------------------------------------------- */
/* 6E — playoff-schedule utility caps                                         */
/* -------------------------------------------------------------------------- */

/** playoff-schedule adjustment is capped to this many points regardless of how favorable the schedule looks — schedule is a modifier, never a dominant factor */
export const PLAYOFF_SCHEDULE_ADJUSTMENT_CAP = 1.0;
/** playoff-schedule adjustment only applies at all for these playoff statuses (qualification gate, spec §27) */
export const PLAYOFF_SCHEDULE_ELIGIBLE_STATUSES = new Set(["CLINCHED", "STRONG_POSITION", "BUBBLE"]);
/** bubble teams get a reduced weight on playoff-schedule value vs. clinched/strong-position teams (spec §28 bubble guard) */
export const PLAYOFF_SCHEDULE_WEIGHT_BY_STATUS: Record<string, number> = {
  CLINCHED: 1.0,
  STRONG_POSITION: 0.7,
  BUBBLE: 0.3,
  LONG_SHOT: 0,
  ELIMINATED: 0,
  UNKNOWN: 0,
};

/* -------------------------------------------------------------------------- */
/* 6F — per-component weights. Each component is individually capped BEFORE   */
/* the overall strategic_adjustment cap is applied — no single component can  */
/* dominate on its own, and the aggregate is bounded again on top of that.    */
/* -------------------------------------------------------------------------- */

export const COMPONENT_CAP = 0.6;

export const IMMEDIATE_NEED_WEIGHT = 0.5;
export const SHORT_HORIZON_WEIGHT = 0.35;
export const DEPTH_FRAGILITY_WEIGHT = 0.5;
export const DEPTH_USABLE_WEIGHT = 0.15;
export const BYE_URGENCY_WEIGHT = 0.5;

/**
 * Spec §35: Phase 3's only volatility-adjacent signals are shadow-only,
 * zero-weighted, and explicitly not authoritative (`ri-trade-calibrated-2026.2`).
 * There is no other ceiling/floor evidence in this repository. Ceiling/floor
 * preference is therefore STRUCTURALLY zero — not merely defaulted — until a
 * real, non-Phase-3 volatility signal exists. This is an explicit "weight = 0,
 * diagnostic only" component per the spec's Calibration Deferral section, not
 * an oversight.
 */
export const CEILING_FLOOR_PREFERENCE_WEIGHT = 0;
