/**
 * Deterministic reconciliation between per-player weekly scoring and Sleeper's
 * own team-level matchup totals — the check that proves the new player-weekly
 * endpoint isn't quietly dropping or double-counting anything before it ships.
 *
 * For each roster in a week: sum the starters' `fantasy_points` from the
 * player-weekly rows and compare against that roster's `points` field on the
 * matchup row. They should match to the cent; any gap is diagnosed rather
 * than swallowed.
 */

import type { PlayerWeeklyRow } from "./historical-scoring";
import type { RawMatchup } from "@/lib/sleeper/types";

/** Sleeper occasionally carries a fractional-cent rounding difference. */
export const RECONCILIATION_TOLERANCE = 0.05;

export interface RosterReconciliation {
  roster_id: number;
  week: number;
  matchup_reported_points: number;
  summed_starter_points: number;
  difference: number;
  within_tolerance: boolean;
  starter_count: number;
}

export function reconcileWeek(
  week: number,
  matchups: RawMatchup[],
  playerWeeklyRows: PlayerWeeklyRow[],
): RosterReconciliation[] {
  const pointsByPlayer = new Map(playerWeeklyRows.map((row) => [row.player_id, row.fantasy_points]));

  return matchups
    .filter((row) => typeof row.points === "number")
    .map((row): RosterReconciliation => {
      const starterIds = (row.starters ?? []).filter((id) => id !== "0");
      const summed = starterIds.reduce((sum, id) => sum + (pointsByPlayer.get(id) ?? 0), 0);
      const reported = row.points as number;
      const difference = Math.round((summed - reported) * 100) / 100;

      return {
        roster_id: row.roster_id,
        week,
        matchup_reported_points: reported,
        summed_starter_points: Math.round(summed * 100) / 100,
        difference,
        within_tolerance: Math.abs(difference) <= RECONCILIATION_TOLERANCE,
        starter_count: starterIds.length,
      };
    })
    .sort((a, b) => a.roster_id - b.roster_id);
}

export interface ReconciliationSummary {
  weeks_checked: number[];
  rosters_checked: number;
  rosters_within_tolerance: number;
  max_absolute_difference: number;
  status: "reconciled" | "discrepancies_found" | "no_data";
}

export function summarizeReconciliation(
  results: RosterReconciliation[],
): ReconciliationSummary {
  if (results.length === 0) {
    return {
      weeks_checked: [],
      rosters_checked: 0,
      rosters_within_tolerance: 0,
      max_absolute_difference: 0,
      status: "no_data",
    };
  }

  const weeks = [...new Set(results.map((r) => r.week))].sort((a, b) => a - b);
  const withinTolerance = results.filter((r) => r.within_tolerance).length;
  const maxDiff = Math.max(...results.map((r) => Math.abs(r.difference)));

  return {
    weeks_checked: weeks,
    rosters_checked: results.length,
    rosters_within_tolerance: withinTolerance,
    max_absolute_difference: Math.round(maxDiff * 100) / 100,
    status: withinTolerance === results.length ? "reconciled" : "discrepancies_found",
  };
}
