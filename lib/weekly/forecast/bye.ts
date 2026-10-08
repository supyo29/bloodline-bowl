/**
 * W1.P3 — the ONE authoritative interpretation of a verified bye.
 *
 * A bye proves exactly one thing: the player cannot score THIS week. It says nothing about how good he is. Two different
 * questions therefore need two different values, and this module is where they are separated:
 *
 *   current-week utility   "what can he contribute this week?"      -> 0 on a verified bye   (lineup, matchup, bye-hole math)
 *   hold / asset value     "what am I giving up if I drop him?"      -> NOT suppressed by the bye (drop side, asset questions)
 *
 * Everything that needs to know "is this player on a verified bye?" asks `isVerifiedBye`. The bye zero ROW is built in exactly
 * one place (`verifiedByeRow`). Consumers pick the view that matches their question; none re-derives bye semantics.
 *
 * `isVerifiedBye` reads only EXPLICIT state (`is_bye` / `projection_status === "bye"`). It never infers a bye from a zero, and a
 * missing projection or a known-zero projection is never a bye.
 */

import type { WeeklyProjection } from "../schema";

/** Explicit bye state only. A 0 projection, a null projection, or an Out designation is NOT a bye. */
export function isVerifiedBye(row: Pick<WeeklyProjection, "is_bye" | "projection_status"> | null | undefined): boolean {
  return row != null && (row.is_bye === true || row.projection_status === "bye");
}

/** Weeks the hold-value proxy spreads ROS over. Same horizon the waiver engine's ROS edge already uses (a shared constant, not a new model). */
export function holdHorizonWeeks(week: number): number {
  return Math.max(1, 18 - week);
}

export type HoldBasis =
  /** not on a bye: the player's own current-week value IS his hold value basis (legacy behavior, unchanged) */
  | "CURRENT_WEEK_NOT_BYE"
  /** bye, but the source still carried a pre-bye projection (underlying football value) */
  | "SOURCE_PROJECTION_PRE_BYE"
  /** bye, no source projection: existing ROS projection spread over the remaining weeks. CRUDE and uncalibrated — labelled as such. */
  | "ROS_PER_WEEK_PROXY"
  /** bye and nothing to ground a forward value: UNKNOWN, never zero */
  | "UNAVAILABLE";

/**
 * W1.R2: the hold (asset) value lives in ONE place — `canonicalAssetValue` / `holdWeeklyValue` in ./asset.ts — and covers injury as well as
 * bye. This module keeps only the bye interpretation (`isVerifiedBye`, `verifiedByeRow`, `deriveForwardRow`) and the shared horizon constant.
 */

/**
 * THE single producer of a verified-bye projection row: current-week value is a known 0, bye state is explicit, and the
 * ROS/identity fields of the underlying player are carried through unchanged so asset value is not erased.
 */
export function verifiedByeRow(a: {
  canonical_player_id: string;
  week: number;
  season: number;
  position: string;
  nfl_team: string | null;
  injury_status: string | null;
  rest_of_season_points: number | null;
  ros: WeeklyProjection["ros"];
  source: string;
  model_version: string;
  warnings: string[];
  /** ZERO: a verified-schedule bye has a degenerate 0/0/0 band. NONE: synthetic per-week rows that carry no band at all. */
  band: "ZERO" | "NONE";
}): WeeklyProjection {
  return {
    canonical_player_id: a.canonical_player_id,
    week: a.week,
    season: a.season,
    position: a.position,
    nfl_team: a.nfl_team,
    opponent: null,
    is_home: null,
    projected_points: 0,
    floor_points: a.band === "ZERO" ? 0 : null,
    ceiling_points: a.band === "ZERO" ? 0 : null,
    std_dev: a.band === "ZERO" ? 0 : null,
    projection_status: "bye",
    expected_availability: 0,
    is_bye: true,
    injury_status: a.injury_status,
    rest_of_season_points: a.rest_of_season_points,
    ros: a.ros,
    source: a.source,
    model_version: a.model_version,
    uncertainty_source: "none",
    warnings: a.warnings,
  };
}

/** warnings that describe THIS WEEK's bye state of a row (they never describe another horizon) */
const CURRENT_WEEK_BYE_WARNING = /^bye_/;

/**
 * W1.R1 — the ONE way to turn a CURRENT-WEEK projection row into a row for ANOTHER horizon (rest of season, a future week, a per-week basis).
 *
 * A current-week row carries current-week GAME STATE: the bye flag and `bye` status, the 0 availability a bye row has, this week's opponent,
 * bye warnings. None of that describes another horizon. Rewriters that copied the row (`{...wp, projected_points: ...}`) and patched only some
 * fields leaked it (audit: surviving mutations E1/E2 — a rewritten schedule-planning row and a synthesized trade-ROS row kept `is_bye`).
 *
 *   points != null   a projected row for the new horizon: status `projected`, `is_bye` false, availability 1 if the source row was a bye
 *                    (a bye's 0 means "not playing THIS week"), no opponent, bye warnings dropped
 *   points == null   the horizon's value is UNKNOWN: status `unavailable` (never `bye`), `is_bye` false, no bands. A current-week bye is NOT
 *                    evidence about another horizon — treating it as one turned an unknown ROS into a verified zero.
 *
 * Player-level facts (injury designation, team, position, ROS) are kept. A horizon that IS itself a bye is built with `verifiedByeRow`, not here.
 */
export function deriveForwardRow(src: WeeklyProjection, points: number | null, opts: { proportionalBands?: boolean } = {}): WeeklyProjection {
  const wasBye = isVerifiedBye(src);
  const bands = opts.proportionalBands !== false && points != null ? { floor: points * 0.7, ceiling: points * 1.3, std: points * 0.3 } : null;
  return {
    ...src,
    projected_points: points,
    floor_points: bands?.floor ?? null,
    ceiling_points: bands?.ceiling ?? null,
    std_dev: bands?.std ?? null,
    projection_status: points != null ? "projected" : "unavailable",
    is_bye: false,
    opponent: null,
    is_home: null,
    expected_availability: wasBye ? 1 : src.expected_availability,
    warnings: src.warnings.filter((w) => !CURRENT_WEEK_BYE_WARNING.test(w)),
  };
}
