/**
 * Per-manager factual availability counts, backing `GET /api/manager-availability`.
 *
 * Deliberately descriptive only — no injury-response scoring, no efficiency
 * judgment, no "good/bad" labels. That analysis belongs downstream (the R
 * manager-efficiency engine); this module only counts what
 * `historical-availability.ts` already classified from real evidence.
 */

import type { AvailabilityRecord } from "./historical-availability";
import type { RawLeagueUser, RawRoster } from "@/lib/sleeper/types";

export interface ManagerAvailabilitySummary {
  manager_id: string | null;
  roster_id: number | null;
  manager_display_name: string | null;
  team_name: string | null;

  rostered_player_weeks: number;
  starter_player_weeks: number;
  starter_unavailable_weeks: number;
  ir_player_weeks: number;
  bye_starter_weeks: number;
  inactive_starter_weeks: number;
  confirmed_injury_starter_weeks: number;
  unknown_absence_starter_weeks: number;
}

/** `inactive_starter_weeks` and `confirmed_injury_starter_weeks` are always 0 — see field-level note below. */
const INJURY_INACTIVE_NOTE =
  "Always 0: Sleeper's public API exposes no historical injury designation or official inactive-list archive (see /api/player-availability's coverage.field_support). Counting these would require fabricating evidence.";

export function summarizeManagerAvailability(
  records: AvailabilityRecord[],
  rosters: RawRoster[],
  users: RawLeagueUser[],
): { managers: ManagerAvailabilitySummary[]; notes: string[] } {
  const usersById = new Map(users.map((u) => [u.user_id, u]));
  const byRoster = new Map<number, ManagerAvailabilitySummary>();

  for (const roster of rosters) {
    const user = roster.owner_id ? usersById.get(roster.owner_id) : undefined;
    byRoster.set(roster.roster_id, {
      manager_id: roster.owner_id,
      roster_id: roster.roster_id,
      manager_display_name: user?.display_name ?? null,
      team_name: (user?.metadata?.team_name as string | undefined) ?? null,
      rostered_player_weeks: 0,
      starter_player_weeks: 0,
      starter_unavailable_weeks: 0,
      ir_player_weeks: 0,
      bye_starter_weeks: 0,
      inactive_starter_weeks: 0,
      confirmed_injury_starter_weeks: 0,
      unknown_absence_starter_weeks: 0,
    });
  }

  for (const record of records) {
    if (record.roster_id === null) continue;
    let summary = byRoster.get(record.roster_id);
    if (!summary) {
      // A roster that no longer exists in the current snapshot (rare, but
      // possible across league history) still deserves a row rather than
      // silently dropping its weeks.
      summary = {
        manager_id: record.manager_id,
        roster_id: record.roster_id,
        manager_display_name: null,
        team_name: null,
        rostered_player_weeks: 0,
        starter_player_weeks: 0,
        starter_unavailable_weeks: 0,
        ir_player_weeks: 0,
        bye_starter_weeks: 0,
        inactive_starter_weeks: 0,
        confirmed_injury_starter_weeks: 0,
        unknown_absence_starter_weeks: 0,
      };
      byRoster.set(record.roster_id, summary);
    }

    if (record.rostered) summary.rostered_player_weeks += 1;
    if (record.availability_class === "ir") summary.ir_player_weeks += 1;

    if (!record.started) continue;
    summary.starter_player_weeks += 1;

    switch (record.availability_class) {
      case "bye":
        summary.starter_unavailable_weeks += 1;
        summary.bye_starter_weeks += 1;
        break;
      case "ir":
        summary.starter_unavailable_weeks += 1;
        break;
      case "did_not_play_unknown":
      case "unknown":
        summary.starter_unavailable_weeks += 1;
        summary.unknown_absence_starter_weeks += 1;
        break;
      case "participated":
        break;
      default:
        break;
    }
  }

  const managers = [...byRoster.values()].sort(
    (a, b) => (a.roster_id ?? 0) - (b.roster_id ?? 0),
  );

  return { managers, notes: [INJURY_INACTIVE_NOTE] };
}
