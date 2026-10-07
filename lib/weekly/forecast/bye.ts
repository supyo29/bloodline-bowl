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

export interface HoldWeeklyValue {
  /** per-week hold value in league points; null = unknown (NOT 0) */
  points: number | null;
  basis: HoldBasis;
}

/**
 * Per-week value to use when the question is "what asset am I giving up?" (drop side).
 * - not on bye: the legacy current-week projection (so every non-bye decision is numerically unchanged)
 * - verified bye: the underlying value with the bye effect removed — pre-bye source projection if present, else ROS ÷ remaining weeks
 *   (no calibration claim), else unknown
 * A bye NEVER yields 0 here merely because he is on bye.
 */
export function holdWeeklyValue(args: {
  row: WeeklyProjection | null | undefined;
  /** canonical forecast for the player, if the context has one (preferred source of the pre-bye underlying value) */
  underlying_points?: number | null;
  week: number;
}): HoldWeeklyValue {
  const { row } = args;
  if (!row) return { points: null, basis: "UNAVAILABLE" };
  if (!isVerifiedBye(row)) return { points: row.projected_points, basis: "CURRENT_WEEK_NOT_BYE" };
  if (args.underlying_points != null) return { points: args.underlying_points, basis: "SOURCE_PROJECTION_PRE_BYE" };
  if (row.rest_of_season_points != null) {
    return { points: Math.round((row.rest_of_season_points / holdHorizonWeeks(args.week)) * 100) / 100, basis: "ROS_PER_WEEK_PROXY" };
  }
  return { points: null, basis: "UNAVAILABLE" };
}

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
