/**
 * Position baselines + age curves + regression constants for the Roster Intel
 * structural model. Everything here is documented and evidence-anchored to
 * multi-year NFL norms; nothing is tuned to any external projection.
 */

import type { FantasyPosition } from "./schema";
import type { PlayerSeasonActual } from "./actuals";
import { rookieDraftFor } from "./rookie-model";

/** Recency weights for a 2026 projection (sum need not be 1; normalized later). */
export const SEASON_RECENCY_WEIGHTS: Record<number, number> = {
  [2025]: 0.55,
  [2024]: 0.30,
  [2023]: 0.15,
  [2022]: 0.06,
  [2021]: 0.03,
};

/** Games in a regular season. Sleeper/RotoWire report gp≈18; NFL plays 17. */
export const REGULAR_SEASON_GAMES = 17;

/**
 * Shrinkage strength K per rate stat: `shrunk = w*obs + (1-w)*baseline`,
 * `w = n_eff / (n_eff + K)` where `n_eff` is games-weighted sample. A larger K
 * regresses harder — volatile efficiency (TD rate, YPC) gets a big K.
 */
export const SHRINKAGE_K = {
  snap_share: 8,
  target_share: 10,
  carry_share: 9,
  rz_target_share: 14,
  rz_carry_share: 14,
  catch_rate: 24,
  yards_per_target: 40,
  yards_per_carry: 55,
  yards_per_att: 60,
  cmp_pct: 30,
  pass_td_rate: 90, // per red-zone pass attempt
  rush_td_rate: 60, // per red-zone carry
  rec_td_rate: 55, // per red-zone target
  int_rate: 90,
  availability: 6,
} as const;

/** League-average efficiency + conversion baselines (multi-year norms). */
export const POSITION_BASELINES: Record<
  FantasyPosition,
  {
    catch_rate: number;
    yards_per_target: number;
    yards_per_carry: number;
    yards_per_att: number;
    cmp_pct: number;
    rec_td_per_rz_target: number;
    rush_td_per_rz_carry: number;
    pass_td_per_rz_att: number;
    int_per_att: number;
    availability: number;
    fum_lost_per_touch: number;
  }
> = {
  QB: {
    catch_rate: 0, yards_per_target: 0, yards_per_carry: 4.4, yards_per_att: 7.1,
    cmp_pct: 0.645, rec_td_per_rz_target: 0, rush_td_per_rz_carry: 0.34,
    pass_td_per_rz_att: 0.36, int_per_att: 0.024, availability: 0.86,
    fum_lost_per_touch: 0.011,
  },
  RB: {
    catch_rate: 0.76, yards_per_target: 6.4, yards_per_carry: 4.3, yards_per_att: 0,
    cmp_pct: 0, rec_td_per_rz_target: 0.16, rush_td_per_rz_carry: 0.20,
    pass_td_per_rz_att: 0, int_per_att: 0, availability: 0.80,
    fum_lost_per_touch: 0.006,
  },
  WR: {
    catch_rate: 0.63, yards_per_target: 8.4, yards_per_carry: 6.5, yards_per_att: 0,
    cmp_pct: 0, rec_td_per_rz_target: 0.20, rush_td_per_rz_carry: 0.25,
    pass_td_per_rz_att: 0, int_per_att: 0, availability: 0.85,
    fum_lost_per_touch: 0.004,
  },
  TE: {
    catch_rate: 0.66, yards_per_target: 7.6, yards_per_carry: 3.5, yards_per_att: 0,
    cmp_pct: 0, rec_td_per_rz_target: 0.22, rush_td_per_rz_carry: 0.2,
    pass_td_per_rz_att: 0, int_per_att: 0, availability: 0.86,
    fum_lost_per_touch: 0.004,
  },
  K: {
    catch_rate: 0, yards_per_target: 0, yards_per_carry: 0, yards_per_att: 0,
    cmp_pct: 0, rec_td_per_rz_target: 0, rush_td_per_rz_carry: 0,
    pass_td_per_rz_att: 0, int_per_att: 0, availability: 0.94,
    fum_lost_per_touch: 0,
  },
  DEF: {
    catch_rate: 0, yards_per_target: 0, yards_per_carry: 0, yards_per_att: 0,
    cmp_pct: 0, rec_td_per_rz_target: 0, rush_td_per_rz_carry: 0,
    pass_td_per_rz_att: 0, int_per_att: 0, availability: 1,
    fum_lost_per_touch: 0,
  },
};

/** League-average team volume, for regressing thin team histories. */
export const TEAM_BASELINE = {
  pass_att: 565,
  rush_att: 435,
  plays: 1000,
  pass_td: 26,
  rush_td: 13,
} as const;

/**
 * Position-specific age multiplier applied to efficiency (and to opportunity for
 * aging players — see `opportunityAgeShade`). Peaks and declines follow
 * well-documented positional aging.
 *
 * The RB / WR post-peak slopes were steepened in the Phase 2 calibration
 * (`analysis/phase2_calibration.R`): the production curves plateaued ~2-3 years
 * too long, leaving a systematic over-projection of WRs 29-32 (~-36 pt residual)
 * and RBs 26-29 (~-24). Steepening is holdout-validated (2025 paired MAE:
 * WR -0.54 [-0.89,-0.24], RB -0.70 [-1.31,-0.15]). QB / TE curves unchanged.
 * Model version: ri-structural-2026.2.
 */
export function ageMultiplier(position: FantasyPosition, age: number | null): number {
  if (age == null || !Number.isFinite(age)) return 1;
  const clamp = (v: number) => Math.max(0.62, Math.min(1.06, v));
  switch (position) {
    case "RB":
      // rise to ~22, plateau to 25, decline from 25, steep after 28
      if (age <= 22) return clamp(0.95 + (age - 21) * 0.03);
      if (age <= 25) return 1.0;
      if (age <= 28) return clamp(1.0 - (age - 25) * 0.04);
      return clamp(0.88 - (age - 28) * 0.06);
    case "WR":
      // rise to ~23, plateau to 27, decline from 27, steep after 30
      if (age <= 23) return clamp(0.93 + (age - 21) * 0.035);
      if (age <= 27) return 1.0;
      if (age <= 30) return clamp(1.0 - (age - 27) * 0.04);
      return clamp(0.88 - (age - 30) * 0.05);
    case "TE":
      if (age <= 24) return clamp(0.88 + (age - 21) * 0.04);
      if (age <= 30) return 1.0;
      return clamp(1.0 - (age - 30) * 0.03);
    case "QB":
      if (age <= 24) return clamp(0.94 + (age - 22) * 0.03);
      if (age <= 36) return 1.0;
      return clamp(1.0 - (age - 36) * 0.03);
    default:
      return 1;
  }
}

/**
 * The pre-Phase-2 (`ri-structural-2026.1`) age curve. Retained ONLY so the
 * production v1→v2 impact audit (`scripts/audit-production-v1-v2.ts`) can run
 * both calibrations against an otherwise-identical pipeline. Not used by the
 * live model.
 */
export function ageMultiplierV1(position: FantasyPosition, age: number | null): number {
  if (age == null || !Number.isFinite(age)) return 1;
  const clamp = (v: number) => Math.max(0.7, Math.min(1.06, v));
  switch (position) {
    case "RB":
      if (age <= 22) return clamp(0.95 + (age - 21) * 0.03);
      if (age <= 26) return 1.0;
      if (age <= 28) return clamp(1.0 - (age - 26) * 0.03);
      return clamp(0.94 - (age - 28) * 0.05);
    case "WR":
      if (age <= 23) return clamp(0.93 + (age - 21) * 0.035);
      if (age <= 28) return 1.0;
      if (age <= 31) return clamp(1.0 - (age - 28) * 0.025);
      return clamp(0.925 - (age - 31) * 0.04);
    case "TE":
      if (age <= 24) return clamp(0.88 + (age - 21) * 0.04);
      if (age <= 30) return 1.0;
      return clamp(1.0 - (age - 30) * 0.03);
    case "QB":
      if (age <= 24) return clamp(0.94 + (age - 22) * 0.03);
      if (age <= 36) return 1.0;
      return clamp(1.0 - (age - 36) * 0.03);
    default:
      return 1;
  }
}

/**
 * Phase 2 (holdout-validated): aging shows up in *usage*, not only efficiency.
 * For a skill player 30 or older, shade projected opportunity (targets, carries,
 * red-zone looks) toward the age multiplier. A no-op below 30 and for QBs (whose
 * age multiplier is 1.0 until 36). Model version: ri-structural-2026.2.
 */
export function opportunityAgeShade(position: FantasyPosition, age: number | null): number {
  if (age == null || !Number.isFinite(age) || age < OPPORTUNITY_AGE_SHADE_FROM) return 1;
  return 0.5 + 0.5 * ageMultiplier(position, age);
}
export const OPPORTUNITY_AGE_SHADE_FROM = 30;


/**
 * Phase 2: preseason expected-games is systematically ~1-2 games too high across
 * every skill position (component analysis: proj_games mean 13.5-14.1 vs actual
 * 11.5-12.4). A player's own healthy multi-year history cannot predict a
 * mid-season injury, a benching, or a coach's-decision scratch. Subtract a flat
 * attrition allowance from `17 * availability`.
 *
 * The value is selected by a DEVELOPMENT-ONLY rule (2023-2024; 2025 never
 * consulted — see `analysis/phase2_calibration.R` section 2b):
 *   grid H = {0, 0.25, ..., 2.5}; stable region
 *     S = { h : bias bootstrap 95% CI contains 0
 *             & MAE(h) <= min_H MAE + 0.50
 *             & RMSE(h) <= min_H RMSE + 0.75
 *             & Spearman(h) >= max_H Spearman - 0.005 }
 *   h* = grid value nearest median(S), ties -> smaller.
 * Development result: S = {1.25, 1.50, 1.75, 2.00}, median 1.625 -> h* = 1.50,
 * dev calibration slope 0.998.
 *
 * Frozen h* run once against 2025: ALL bias +1.13, MAE 39.82, RMSE 57.70,
 * Spearman 0.734, calibration slope 1.021, paired MAE vs v1 -1.75 [-3.00,-0.43].
 * Model version: ri-structural-2026.2.
 */
export const GAMES_ATTRITION_HAIRCUT = 1.5;

/**
 * Phase 2: the availability floor was 0.45 (~7.6 games) — too high for a
 * projectable player who then loses his role entirely. 0.35 (~6 games) is the
 * realistic minimum. Model version: ri-structural-2026.2.
 */
export const AVAILABILITY_FLOOR = 0.35;

/** Games-weighted "effective sample" for a set of seasons (down-weights short years). */
export function effectiveSample(seasons: PlayerSeasonActual[]): number {
  return seasons.reduce((acc, s) => {
    const w = SEASON_RECENCY_WEIGHTS[s.season] ?? 0;
    return acc + w * Math.min(s.gp, REGULAR_SEASON_GAMES);
  }, 0);
}

/** `shrunk = w*observed + (1-w)*baseline`, w from games-weighted sample. */
export function shrink(
  observed: number,
  baseline: number,
  nEff: number,
  k: number,
): number {
  const w = nEff / (nEff + k);
  return w * observed + (1 - w) * baseline;
}

/**
 * Calibration profile — bundles every lever the Phase 2 / Phase 3 changes
 * touched so the production model can be run under an older profile with
 * everything else identical (`scripts/audit-production-v1-v2.ts`,
 * `scripts/audit-phase3-rookie.ts`). The live model always uses the newest.
 */
export interface CalibrationProfile {
  id: "v1" | "v2" | "v3";
  gamesAttritionHaircut: number;
  availabilityFloor: number;
  ageMultiplier: (position: FantasyPosition, age: number | null) => number;
  /** Multiplicative shade on projected opportunity (targets/carries/RZ looks). */
  opportunityShade: (position: FantasyPosition, age: number | null) => number;
  /**
   * Phase 3: `sleeper_id -> {pick, round}` for a rookie, or null. When it
   * returns a draft record, `model.ts` projects a WR/RB/TE rookie's per-game
   * opportunity from draft position instead of the depth-chart-slot lookup.
   * v1/v2 always return null (behaviour identical to pre-Phase-3).
   */
  rookieDraftFor: (sleeperPlayerId: string) => { pick: number; round: number } | null;
}

/** Live production calibration: Phase 2 games/age + Phase 3 draft-capital rookie prior. */
export const CALIBRATION_V3: CalibrationProfile = {
  id: "v3",
  gamesAttritionHaircut: GAMES_ATTRITION_HAIRCUT,
  availabilityFloor: AVAILABILITY_FLOOR,
  ageMultiplier,
  opportunityShade: opportunityAgeShade,
  rookieDraftFor,
};

/** Phase 2 calibration (no draft-capital rookie prior). */
export const CALIBRATION_V2: CalibrationProfile = {
  ...CALIBRATION_V3,
  id: "v2",
  rookieDraftFor: () => null,
};

export const CALIBRATION_V1: CalibrationProfile = {
  id: "v1",
  gamesAttritionHaircut: 0,
  availabilityFloor: 0.45,
  ageMultiplier: ageMultiplierV1,
  // v1 shaded RB opportunity by `0.6 + 0.4*ageMul` at ALL ages; other positions 1.
  opportunityShade: (position, age) =>
    position === "RB" ? 0.6 + 0.4 * ageMultiplierV1("RB", age) : 1,
  rookieDraftFor: () => null,
};

/**
 * Season expected-games from a floored availability probability, under a given
 * calibration. Single source of truth for `model.ts` and the invariant tests.
 *
 *   games(a) = max(1, 17 * clamp(a - rbAgePenalty, 0.4, 0.985) - haircut)
 *
 * Monotonic non-decreasing in `flooredAvailability` (clamp ∘ affine ∘ max are
 * all non-decreasing). For any availability, `games` under v2 is <= v1: v2 only
 * lowers the floor (which cannot raise a clamped value) and adds a positive
 * haircut. The `max(1, ...)` never binds for a real player: the availability
 * floor (0.35) gives 17*0.35 - 1.5 = 4.45 > 1, so there is NO edge case where v2
 * exceeds v1.
 */
export function expectedSeasonGames(
  flooredAvailability: number,
  cal: CalibrationProfile,
  rbAgePenalty = 0,
): number {
  const eff = Math.max(0.4, Math.min(0.985, flooredAvailability - rbAgePenalty));
  return Math.max(1, REGULAR_SEASON_GAMES * eff - cal.gamesAttritionHaircut);
}
