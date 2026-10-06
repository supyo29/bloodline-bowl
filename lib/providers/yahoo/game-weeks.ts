/**
 * Yahoo's own NFL fantasy-week calendar (`GET /game/{game_key}/game_weeks`).
 *
 * Yahoo transaction resources carry a timestamp but no fantasy-week field. The
 * game-week calendar is Yahoo's authoritative mapping of calendar dates to
 * fantasy weeks, so a transaction's week is the window that contains its
 * timestamp. Dates are Yahoo league days in US Eastern time. Nothing is guessed:
 * a timestamp outside every window stays `null`, and callers decide whether the
 * week filter is authoritative (see `weekFilterIsAuthoritative`).
 */

import type { YahooFantasyClient } from "./client";
import { asNumber, asString, collectionEntries, fantasyContent, mergeYahooEntity, unwrap } from "./parse";

export interface YahooGameWeek {
  week: number;
  /** Inclusive league-day bounds, `YYYY-MM-DD` (US Eastern). */
  start: string;
  end: string;
}

const cache = new Map<string, YahooGameWeek[]>();

export function clearGameWeeksCache(): void {
  cache.clear();
}

export function parseGameWeeks(body: unknown): YahooGameWeek[] {
  const game = mergeYahooEntity(fantasyContent(body)?.game);
  return collectionEntries(game.game_weeks)
    .map((entry) => {
      const gw = mergeYahooEntity(unwrap(entry, "game_week"));
      const week = asNumber(gw.week);
      const start = asString(gw.start);
      const end = asString(gw.end);
      return week !== null && start && end && /^\d{4}-\d{2}-\d{2}$/.test(start) && /^\d{4}-\d{2}-\d{2}$/.test(end)
        ? { week, start, end }
        : null;
    })
    .filter((w): w is YahooGameWeek => w !== null)
    .sort((a, b) => a.week - b.week);
}

/** Calendar for a game key (cached per process; the calendar is fixed for a season). */
export async function fetchYahooGameWeeks(client: YahooFantasyClient, gameKey: string): Promise<YahooGameWeek[]> {
  const hit = cache.get(gameKey);
  if (hit) return hit;
  const { data } = await client.get(`/game/${gameKey}/game_weeks`);
  const weeks = parseGameWeeks(data);
  if (weeks.length > 0) cache.set(gameKey, weeks);
  return weeks;
}

const EASTERN_DAY = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** Epoch seconds -> US-Eastern league day `YYYY-MM-DD`. */
export function easternLeagueDay(epochSeconds: number): string {
  return EASTERN_DAY.format(new Date(epochSeconds * 1000));
}

/** Fantasy week containing the timestamp, or null when it is outside every window. */
export function weekForTimestamp(weeks: YahooGameWeek[], epochSeconds: number): number | null {
  if (!Number.isFinite(epochSeconds)) return null;
  const day = easternLeagueDay(epochSeconds);
  const hit = weeks.find((w) => w.start <= day && day <= w.end);
  return hit ? hit.week : null;
}

/**
 * A week filter is authoritative only when the calendar covers `week` and every
 * transaction is either placed in a week or predates the season's first window
 * (it then cannot belong to any fantasy week). A timestamp in a calendar gap or
 * after the last window makes the filter non-authoritative.
 */
export function weekFilterIsAuthoritative(
  weeks: YahooGameWeek[],
  week: number,
  transactions: Array<{ fantasy_week: number | null; timestamp_seconds: number }>,
): boolean {
  if (!weeks.some((w) => w.week === week)) return false;
  const seasonStart = weeks[0]?.start;
  return transactions.every(
    (t) =>
      t.fantasy_week !== null ||
      (seasonStart !== undefined && Number.isFinite(t.timestamp_seconds) && easternLeagueDay(t.timestamp_seconds) < seasonStart),
  );
}
