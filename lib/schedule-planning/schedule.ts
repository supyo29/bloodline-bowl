/**
 * Phase 7 — full-season schedule adapter.
 *
 * The `SleeperScheduleProvider` already fetches + caches the ENTIRE
 * regular-season schedule on first use (spec §2), so calling `getWeekSchedule`
 * for every remaining week costs ONE provider read. Produces a per-week bye set
 * + opponent/home-away map for the whole remaining season.
 */

import { getScheduleProvider } from "@/lib/weekly/schedule/registry";
import type { ScheduleProvider } from "@/lib/weekly/schedule/types";

export interface FullSchedule {
  source: string;
  /** week -> set of NFL abbrs on a schedule-verified bye that week. */
  byeByWeek: Map<number, Set<string>>;
  /** week -> { team abbr -> opponent abbr }. */
  opponentByWeek: Map<number, Record<string, string>>;
  /** week -> { team abbr -> "home" | "away" }. */
  homeAwayByWeek: Map<number, Record<string, "home" | "away">>;
  /** weeks whose feed failed the structural-intactness check (byes NOT asserted). */
  incompleteWeeks: Set<number>;
}

export async function loadFullSchedule(
  season: number,
  fromWeek: number,
  toWeek: number,
  provider: ScheduleProvider = getScheduleProvider(),
): Promise<FullSchedule> {
  const byeByWeek = new Map<number, Set<string>>();
  const opponentByWeek = new Map<number, Record<string, string>>();
  const homeAwayByWeek = new Map<number, Record<string, "home" | "away">>();
  const incompleteWeeks = new Set<number>();
  let source = "sleeper_schedule";

  for (let w = fromWeek; w <= toWeek; w += 1) {
    let sched;
    try {
      sched = await provider.getWeekSchedule(season, w);
    } catch {
      incompleteWeeks.add(w);
      continue;
    }
    source = sched.source;
    opponentByWeek.set(w, { ...sched.opponent_by_team });
    // home/away: the schedule provider only carries opponent_by_team; derive
    // side from the raw feed shape when available, else leave null.
    const ha: Record<string, "home" | "away"> = {};
    // opponent_by_team is symmetric; a dedicated home/away needs the raw feed —
    // the provider does not expose it, so home_away stays null unless a future
    // provider revision adds it. Recorded here for the contract.
    homeAwayByWeek.set(w, ha);
    if (sched.status === "READY") {
      byeByWeek.set(w, new Set(sched.teams_on_bye));
    } else {
      incompleteWeeks.add(w);
    }
  }

  return { source, byeByWeek, opponentByWeek, homeAwayByWeek, incompleteWeeks };
}
