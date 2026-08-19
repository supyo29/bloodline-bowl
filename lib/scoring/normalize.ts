/**
 * Turns Sleeper's raw `scoring_settings` into readable rules, derived
 * per-category metrics, cross-category comparisons, and a format
 * classification. Pure and deterministic — no HTTP, no randomness.
 */

import { SCORING_CATALOG, humanizeKey } from "./catalog";
import { roundPoints } from "./calculate";
import type {
  DerivedBonuses,
  DerivedDefense,
  DerivedKicking,
  DerivedPassing,
  DerivedReceiving,
  DerivedRushing,
  DerivedTurnovers,
  NormalizedScoringRule,
  ScoringClassification,
  ScoringResponse,
} from "./types";

type Raw = Record<string, number>;

const nz = (raw: Raw, key: string): number | null =>
  typeof raw[key] === "number" && Number.isFinite(raw[key] as number)
    ? (raw[key] as number)
    : null;

const mul = (value: number | null, factor: number): number | null =>
  value === null ? null : roundPoints(value * factor);

/* -------------------------------------------------------------------------- */
/* Normalized rule list                                                        */
/* -------------------------------------------------------------------------- */

export function buildNormalizedRules(raw: Raw): {
  rules: NormalizedScoringRule[];
  warnings: string[];
} {
  const warnings: string[] = [];

  const rules = Object.entries(raw)
    .filter(([, points]) => typeof points === "number" && Number.isFinite(points))
    .map(([key, points]) => {
      const meta = SCORING_CATALOG[key];
      if (!meta) {
        warnings.push(
          `Scoring key '${key}' is not in the built-in label catalog; a generic label was generated.`,
        );
      }
      return {
        key,
        label: meta?.label ?? humanizeKey(key),
        category: meta?.category ?? ("other" as const),
        points,
      };
    })
    .sort(
      (a, b) => a.category.localeCompare(b.category) || a.key.localeCompare(b.key),
    );

  return { rules, warnings };
}

/* -------------------------------------------------------------------------- */
/* Derived per-category metrics                                                */
/* -------------------------------------------------------------------------- */

export function buildDerivedPassing(raw: Raw): DerivedPassing {
  const passYd = nz(raw, "pass_yd");
  return {
    pass_yd_value: passYd,
    points_per_25_pass_yards: mul(passYd, 25),
    points_per_100_pass_yards: mul(passYd, 100),
    passing_td_value: nz(raw, "pass_td"),
    interception_penalty: nz(raw, "pass_int"),
    two_point_conversion_value: nz(raw, "pass_2pt"),
    sack_taken_penalty: nz(raw, "pass_sack"),
  };
}

export function buildDerivedRushing(raw: Raw): DerivedRushing {
  const rushYd = nz(raw, "rush_yd");
  return {
    rush_yd_value: rushYd,
    points_per_10_rush_yards: mul(rushYd, 10),
    points_per_100_rush_yards: mul(rushYd, 100),
    rushing_td_value: nz(raw, "rush_td"),
    two_point_conversion_value: nz(raw, "rush_2pt"),
  };
}

export function buildDerivedReceiving(raw: Raw): DerivedReceiving {
  const recYd = nz(raw, "rec_yd");
  return {
    reception_value: nz(raw, "rec"),
    rec_yd_value: recYd,
    points_per_10_receiving_yards: mul(recYd, 10),
    points_per_100_receiving_yards: mul(recYd, 100),
    receiving_td_value: nz(raw, "rec_td"),
    two_point_conversion_value: nz(raw, "rec_2pt"),
    te_premium_bonus: nz(raw, "bonus_rec_te"),
  };
}

export function buildDerivedTurnovers(raw: Raw): DerivedTurnovers {
  return {
    interception_thrown_penalty: nz(raw, "pass_int"),
    fumble_lost_penalty: nz(raw, "fum_lost"),
    fumble_penalty_no_loss: nz(raw, "fum"),
  };
}

const FG_DISTANCE_TIER_KEYS = [
  "fgm_0_19",
  "fgm_20_29",
  "fgm_30_39",
  "fgm_40_49",
  "fgm_50_59",
  "fgm_60p",
  "fgm_50p",
];

export function buildDerivedKicking(raw: Raw): DerivedKicking {
  const tiers: Record<string, number> = {};
  for (const key of FG_DISTANCE_TIER_KEYS) {
    const value = nz(raw, key);
    if (value !== null && value !== 0) tiers[key] = value;
  }
  const flat = nz(raw, "fgm");

  return {
    extra_point_made: nz(raw, "xpm"),
    extra_point_missed: nz(raw, "xpmiss"),
    field_goal_missed: nz(raw, "fgmiss"),
    field_goal_made_flat: flat,
    field_goal_distance_tiers: tiers,
    // "Flat" scoring: a nonzero flat value with no distance tiers configured.
    uses_flat_scoring: flat !== null && flat !== 0 && Object.keys(tiers).length === 0,
  };
}

const POINTS_ALLOWED_TIER_KEYS = [
  "pts_allow_0",
  "pts_allow_1_6",
  "pts_allow_7_13",
  "pts_allow_14_20",
  "pts_allow_21_27",
  "pts_allow_28_34",
  "pts_allow_35p",
];

export function buildDerivedDefense(raw: Raw): DerivedDefense {
  const tiers: Record<string, number> = {};
  for (const key of POINTS_ALLOWED_TIER_KEYS) {
    const value = nz(raw, key);
    if (value !== null && value !== 0) tiers[key] = value;
  }
  const perPoint = nz(raw, "pts_allow");
  const hasTiers = Object.keys(tiers).length > 0;

  return {
    sack: nz(raw, "sack"),
    interception: nz(raw, "int"),
    fumble_recovery: nz(raw, "fum_rec"),
    forced_fumble: nz(raw, "ff"),
    safety: nz(raw, "safe"),
    blocked_kick: nz(raw, "blk_kick"),
    defensive_touchdown: nz(raw, "def_td"),
    points_allowed_scoring_model:
      perPoint !== null && perPoint !== 0
        ? "per_point_penalty"
        : hasTiers
          ? "tiered_bonus"
          : "none",
    points_allowed_per_point: perPoint,
    points_allowed_tiers: tiers,
  };
}

export function buildDerivedBonuses(raw: Raw): DerivedBonuses {
  const bigPlay: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key.startsWith("bonus_") && key !== "bonus_rec_te" && value !== 0) {
      bigPlay[key] = value;
    }
  }

  return {
    passing_two_point_conversion: nz(raw, "pass_2pt"),
    rushing_two_point_conversion: nz(raw, "rush_2pt"),
    receiving_two_point_conversion: nz(raw, "rec_2pt"),
    big_play_bonuses: bigPlay,
  };
}

/* -------------------------------------------------------------------------- */
/* Cross-category comparisons                                                  */
/* -------------------------------------------------------------------------- */

export function buildComparisons(raw: Raw): ScoringResponse["comparisons"] {
  const passTd = nz(raw, "pass_td");
  const rushTd = nz(raw, "rush_td");
  const recTd = nz(raw, "rec_td");
  const passYd = nz(raw, "pass_yd");
  const rushYd = nz(raw, "rush_yd");
  const recYd = nz(raw, "rec_yd");

  const ratio = (a: number | null, b: number | null): number | null =>
    a === null || b === null || b === 0 ? null : roundPoints(a / b);

  return {
    td_values: { passing: passTd, rushing: rushTd, receiving: recTd },
    yardage_equivalencies: {
      "100_pass_yards": mul(passYd, 100),
      "100_rush_yards": mul(rushYd, 100),
      "100_receiving_yards": mul(recYd, 100),
    },
    ratios: {
      rushing_td_to_passing_td: ratio(rushTd, passTd),
      receiving_td_to_passing_td: ratio(recTd, passTd),
      rush_yard_to_pass_yard_value: ratio(rushYd, passYd),
      receiving_yard_to_pass_yard_value: ratio(recYd, passYd),
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Classification                                                              */
/* -------------------------------------------------------------------------- */

export function classifyScoring(
  raw: Raw,
  rosterPositions: string[],
): ScoringClassification {
  const rec = nz(raw, "rec");
  const passTd = nz(raw, "pass_td") ?? 4;
  const rushTd = nz(raw, "rush_td");
  const recTd = nz(raw, "rec_td");

  const base: ScoringClassification["base"] =
    rec === null || rec === 0
      ? "standard"
      : rec === 0.5
        ? "half_ppr"
        : rec === 1
          ? "full_ppr"
          : "custom_ppr";

  const features: string[] = [];
  features.push(`${passTd}-point passing touchdown`);

  if (rushTd !== null && rushTd !== passTd) {
    features.push(`${rushTd}-point rushing touchdown (vs. ${passTd}-point passing)`);
  }
  if (recTd !== null && recTd !== passTd) {
    features.push(`${recTd}-point receiving touchdown (vs. ${passTd}-point passing)`);
  }
  if (base === "custom_ppr" && rec !== null) {
    features.push(`custom reception value (${rec} points per catch)`);
  }

  const teBonus = nz(raw, "bonus_rec_te");
  if (teBonus !== null && teBonus !== 0) {
    features.push(`TE premium (+${teBonus} points per tight end reception)`);
  }

  const qbSlots = rosterPositions.filter((slot) => slot === "QB").length;
  if (rosterPositions.includes("SUPER_FLEX")) {
    features.push("Superflex (a flex slot also accepts QB)");
  } else if (qbSlots >= 2) {
    features.push(`${qbSlots}QB (dedicated starting quarterback slots)`);
  }

  const ptsAllow = nz(raw, "pts_allow");
  const hasPtsAllowTiers = POINTS_ALLOWED_TIER_KEYS.some(
    (key) => nz(raw, key) !== null && nz(raw, key) !== 0,
  );
  if (ptsAllow !== null && ptsAllow !== 0 && !hasPtsAllowTiers) {
    features.push("points-allowed penalty for team defense (continuous, not tiered)");
  }

  const fgFlat = nz(raw, "fgm");
  const hasFgTiers = FG_DISTANCE_TIER_KEYS.some(
    (key) => nz(raw, key) !== null && nz(raw, key) !== 0,
  );
  if (fgFlat !== null && fgFlat !== 0 && !hasFgTiers) {
    features.push("flat field-goal scoring (no distance bonus)");
  }

  const passSack = nz(raw, "pass_sack");
  if (passSack !== null && passSack !== 0) {
    features.push(`quarterback-sacked penalty (${passSack} points)`);
  }

  if ([nz(raw, "pass_2pt"), nz(raw, "rush_2pt"), nz(raw, "rec_2pt")].some(
    (v) => v !== null && v !== 0,
  )) {
    features.push("2-point conversions scored");
  }

  for (const [key, value] of Object.entries(raw)) {
    if (key.startsWith("bonus_") && key !== "bonus_rec_te" && value !== 0) {
      const meta = SCORING_CATALOG[key];
      features.push(`${meta?.label ?? humanizeKey(key)} (+${value})`);
    }
  }

  return { base, features };
}
