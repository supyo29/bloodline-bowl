/**
 * ScheduleProvider — an AUTHORITATIVE NFL week schedule.
 *
 * The weekly engine uses this (and ONLY this) to decide bye weeks. A player's
 * absence from the projection feed is never treated as proof of a bye — that
 * would silently turn missing data into `projected_points = 0`.
 *
 * `getWeekSchedule` returns the set of teams that HAVE a game and the set on
 * BYE. `teams_on_bye` is only populated when the source is complete enough to
 * prove it (a full 32-team schedule for the week); otherwise `status` is
 * `UNAVAILABLE` and the caller must leave unprojected players `unavailable`.
 */

import type { WeeklyWarning } from "../schema";

export interface WeekSchedule {
  season: number;
  week: number;
  status: "READY" | "UNAVAILABLE";
  source: string;
  /** NFL team abbreviations with a game this week. */
  teams_with_games: Set<string>;
  /** NFL team abbreviations proven to have NO game this week. Empty if UNAVAILABLE. */
  teams_on_bye: Set<string>;
  /** team abbr -> opponent abbr, for teams with a game. */
  opponent_by_team: Record<string, string>;
  warnings: WeeklyWarning[];
}

export interface ScheduleProvider {
  readonly name: string;
  getWeekSchedule(season: number, week: number): Promise<WeekSchedule>;
}

/** The 32 current NFL clubs — used to derive byes from a complete schedule. */
export const NFL_TEAMS: readonly string[] = [
  "ARI", "ATL", "BAL", "BUF", "CAR", "CHI", "CIN", "CLE", "DAL", "DEN",
  "DET", "GB", "HOU", "IND", "JAX", "KC", "LAC", "LAR", "LV", "MIA",
  "MIN", "NE", "NO", "NYG", "NYJ", "PHI", "PIT", "SEA", "SF", "TB",
  "TEN", "WAS",
];
