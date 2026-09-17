/**
 * Intelligence Modernization Phase 1, Checkpoint C — the ONE canonical
 * builder for `NflRealityFrontier` (`lib/canonical/intelligence-freshness.ts`).
 *
 * Checkpoint B defined the type but deliberately did not decide who builds
 * it. This is that decision: no waiver/start-sit/matchup/trade/orchestrator
 * code may independently infer the completed-game frontier. Everyone calls
 * `loadNflRealityFrontier()`.
 *
 * Source: the same Sleeper schedule feed `SleeperScheduleProvider`
 * (`lib/weekly/schedule/sleeper-schedule.ts`) already uses for bye
 * detection -- `GET /schedule/nfl/regular/{season}`, one row per REG game
 * with `{ week, home, away, status, date }`. `status` is the authoritative
 * per-game completion signal ("complete" | "pre_game" | others); this module
 * reads ONLY that field to decide what's finished. It never infers
 * completion from calendar date, day-of-week, wall clock, or a fantasy
 * provider's nominal "current week" counter -- and it never hardcodes how
 * many games a week "should" have.
 *
 * Split in two, deliberately:
 *   - `buildNflRealityFrontier()` -- pure, deterministic, no I/O. Given the
 *     raw game rows, computes the frontier. This is what's unit-tested.
 *   - `loadNflRealityFrontier()` -- the only network call. Thin, uncached
 *     beyond Sleeper's own short revalidate window (completion status
 *     changes intra-day, unlike bye weeks which are stable once the slate
 *     is announced).
 *
 * `lib/canonical/intelligence-freshness.ts`'s evaluator never imports the
 * loader (or any network code) -- callers build/load a frontier first, then
 * pass it in.
 */

import { SLEEPER_ROOT_URL, fetchSleeper } from "@/lib/sleeper/client";
import type { NflRealityFrontier } from "./intelligence-freshness";

export interface RawNflScheduleGame {
  week?: number | null;
  home?: string | null;
  away?: string | null;
  game_id?: string | null;
  status?: string | null;
  date?: string | null;
}

/**
 * Only an exact "complete" status counts as finished. Every other value
 * (`pre_game`, `in_game`, `postponed`, or any future/unknown status Sleeper
 * introduces) is treated as NOT completed -- a conservative default that
 * never counts a game as done unless the source explicitly says so.
 */
function isCompleted(game: RawNflScheduleGame): boolean {
  return (game.status ?? "").trim().toLowerCase() === "complete";
}

/**
 * Pure and deterministic: identical `games` input always yields an
 * identical frontier. The `/schedule/nfl/regular/{season}` endpoint is
 * REG-only by construction, so non-REG games never enter this computation.
 *
 * Returns `null` only when there is no usable schedule data at all, or when
 * the season has zero completed games yet (there is no frontier to report
 * -- callers should treat that as "no independent frontier available",
 * exactly like omitting `nfl_reality` from the freshness request).
 */
export function buildNflRealityFrontier(
  games: RawNflScheduleGame[],
  season: number,
  asOf: string,
): NflRealityFrontier | null {
  const byWeek = new Map<number, RawNflScheduleGame[]>();
  for (const g of games) {
    if (typeof g.week !== "number" || !g.home || !g.away) continue;
    const arr = byWeek.get(g.week) ?? [];
    arr.push(g);
    byWeek.set(g.week, arr);
  }
  if (byWeek.size === 0) return null;

  let latestWeek = 0;
  let completedInLatestWeek = 0;
  let scheduledInLatestWeek = 0;
  let latestCompletedDate: string | null = null;

  for (const week of [...byWeek.keys()].sort((a, b) => a - b)) {
    const weekGames = byWeek.get(week)!;
    const completed = weekGames.filter(isCompleted);
    // Only advance the frontier when THIS week has at least one completed
    // game -- an announced-but-not-yet-played week (zero completions) must
    // never move the frontier forward. This is exactly what keeps "the
    // provider says week 2" from being mistaken for "week 2 has happened."
    if (completed.length > 0) {
      latestWeek = week;
      completedInLatestWeek = completed.length;
      scheduledInLatestWeek = weekGames.length;
      for (const g of completed) {
        if (g.date && (!latestCompletedDate || g.date > latestCompletedDate)) latestCompletedDate = g.date;
      }
    }
  }
  if (latestWeek === 0) return null;

  return {
    season,
    latest_week_with_any_completed_game: latestWeek,
    completed_games_in_latest_week: completedInLatestWeek,
    scheduled_games_in_latest_week: scheduledInLatestWeek,
    latest_completed_game_date: latestCompletedDate,
    as_of: asOf,
  };
}

/**
 * THE canonical async loader. Fetches the current season's REG schedule from
 * Sleeper and reduces it to a frontier. Returns `null` on any fetch failure
 * or when no games have completed yet -- never fabricates a frontier.
 */
export async function loadNflRealityFrontier(season: number): Promise<NflRealityFrontier | null> {
  const games = await fetchSleeper<RawNflScheduleGame[]>(`/schedule/nfl/regular/${season}`, {
    baseUrl: SLEEPER_ROOT_URL,
    revalidate: 15 * 60,
  }).catch(() => null);
  if (!Array.isArray(games)) return null;
  return buildNflRealityFrontier(games, season, new Date().toISOString());
}
