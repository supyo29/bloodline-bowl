/**
 * Shared per-season data loader: league, users, rosters, weekly matchups, and
 * playoff brackets for one Sleeper league id. Every analytics endpoint that
 * needs "a season's worth of facts" goes through this one loader so caching
 * policy and failure tolerance are defined in exactly one place.
 */

import {
  SleeperError,
  getLeague,
  getLeagueRosters,
  getLeagueUsers,
  getLosersBracket,
  getMatchups,
  getWinnersBracket,
} from "@/lib/sleeper/client";
import type {
  RawBracketMatch,
  RawLeague,
  RawLeagueUser,
  RawMatchup,
  RawRoster,
} from "@/lib/sleeper/types";

/** NFL regular season + playoffs never exceeds this many weeks. */
export const MAX_WEEK = 18;

export interface SeasonDataBundle {
  league: RawLeague;
  users: RawLeagueUser[];
  rosters: RawRoster[];
  /** Week number -> that week's matchup rows (empty array if unplayed). */
  matchupsByWeek: Map<number, RawMatchup[]>;
  winnersBracket: RawBracketMatch[];
  losersBracket: RawBracketMatch[];
  warnings: string[];
}

interface LoadOptions {
  /** Cache TTL for league/users/rosters/bracket resources. */
  revalidate: number;
  /** Specific weeks to fetch matchups for; omit to skip matchups entirely. */
  weeks?: number[];
}

function describeError(error: unknown): string {
  return error instanceof SleeperError || error instanceof Error
    ? error.message
    : String(error);
}

/** Load one season's core facts, tolerating missing/unplayed sub-resources. */
export async function loadSeasonData(
  leagueId: string,
  options: LoadOptions,
): Promise<SeasonDataBundle> {
  const { revalidate, weeks = [] } = options;
  const warnings: string[] = [];

  const league = await getLeague(leagueId);

  const [users, rosters] = await Promise.all([
    getLeagueUsers(leagueId, { revalidate }).catch((error: unknown) => {
      warnings.push(`Could not load users for league ${leagueId}: ${describeError(error)}`);
      return [];
    }),
    getLeagueRosters(leagueId, { revalidate }).catch((error: unknown) => {
      warnings.push(`Could not load rosters for league ${leagueId}: ${describeError(error)}`);
      return [];
    }),
  ]);

  // A bracket only exists once the commissioner generates playoffs; a 404 here
  // just means "no bracket yet", not a failure worth warning about.
  const [winnersBracket, losersBracket] = await Promise.all([
    getWinnersBracket(leagueId, { revalidate }).catch(() => []),
    getLosersBracket(leagueId, { revalidate }).catch(() => []),
  ]);

  const matchupsByWeek = new Map<number, RawMatchup[]>();
  if (weeks.length > 0) {
    const results = await Promise.all(
      weeks.map(async (week) => {
        try {
          const matchups = await getMatchups(leagueId, week, { revalidate });
          return [week, Array.isArray(matchups) ? matchups : []] as [number, RawMatchup[]];
        } catch (error) {
          warnings.push(
            `Could not load week ${week} matchups for league ${leagueId}: ${describeError(error)}`,
          );
          return [week, [] as RawMatchup[]] as [number, RawMatchup[]];
        }
      }),
    );
    for (const [week, matchups] of results) matchupsByWeek.set(week, matchups);
  }

  return {
    league,
    users: Array.isArray(users) ? users : [],
    rosters: Array.isArray(rosters) ? rosters : [],
    matchupsByWeek,
    winnersBracket: Array.isArray(winnersBracket) ? winnersBracket : [],
    losersBracket: Array.isArray(losersBracket) ? losersBracket : [],
    warnings,
  };
}

/** All weeks 1..MAX_WEEK, for callers that want a full-season sweep. */
export function allWeeks(): number[] {
  return Array.from({ length: MAX_WEEK }, (_, i) => i + 1);
}
