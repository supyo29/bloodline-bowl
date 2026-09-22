/**
 * Phase 9 Step 3 — week closure. A weekly audit may finalize (write outcomes / declare WEEK_COMPLETE) ONLY when
 * football reality says the week is done. This module is a thin, honest wrapper over the ALREADY-canonical
 * `buildNflSeasonCompletion` (`lib/canonical/nfl-reality-frontier.ts`, Phase 3.5A) — it does not re-derive
 * completion from calendar date, day-of-week, or a provider's nominal "current week". Pure; no I/O.
 */
import type { NflSeasonCompletion, NflWeekCompletion } from "@/lib/canonical/nfl-reality-frontier";

export type WeekClosureStatus = "WEEK_IN_PROGRESS" | "WEEK_COMPLETE" | "WEEK_INCOMPLETE_SOURCE_CONFLICT";

export interface WeekClosure {
  status: WeekClosureStatus;
  season: number;
  week: number;
  scheduled: number;
  completed: number;
  by_status: Record<string, number>;
  reason: string;
  source: string;
  as_of: string | null;
}

/**
 * Pure. `completion` is `null` only when the source fetch failed (fail closed — never treated as complete).
 * A week with an unusual status present (e.g. "postponed") among its scheduled games stays PARTIAL under
 * `buildNflSeasonCompletion`'s own predicate (only `status === "complete"` counts), so it is reported here as
 * `WEEK_IN_PROGRESS`, never silently finalized. `WEEK_INCOMPLETE_SOURCE_CONFLICT` covers a fetch failure or a
 * week with 0 scheduled games (a data gap, not a real bye/complete state).
 */
export function determineWeekClosure(season: number, week: number, completion: NflSeasonCompletion | null): WeekClosure {
  if (!completion) {
    return { status: "WEEK_INCOMPLETE_SOURCE_CONFLICT", season, week, scheduled: 0, completed: 0, by_status: {}, reason: "NFL season completion source unavailable (fetch failed)", source: "unavailable", as_of: null };
  }
  const w: NflWeekCompletion | undefined = completion.weeks.find((x) => x.week === week);
  if (!w || w.scheduled === 0) {
    return { status: "WEEK_INCOMPLETE_SOURCE_CONFLICT", season, week, scheduled: w?.scheduled ?? 0, completed: w?.completed ?? 0, by_status: w?.by_status ?? {}, reason: w ? "0 scheduled games for this week" : "week not present in the schedule source", source: completion.source, as_of: completion.as_of };
  }
  if (w.state === "COMPLETE") {
    return { status: "WEEK_COMPLETE", season, week, scheduled: w.scheduled, completed: w.completed, by_status: w.by_status, reason: `all ${w.scheduled} scheduled games are complete`, source: completion.source, as_of: completion.as_of };
  }
  return { status: "WEEK_IN_PROGRESS", season, week, scheduled: w.scheduled, completed: w.completed, by_status: w.by_status, reason: `${w.completed}/${w.scheduled} games complete (state ${w.state})`, source: completion.source, as_of: completion.as_of };
}
