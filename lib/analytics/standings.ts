/**
 * Standings: factual won-loss records plus straightforward derived statistics
 * computed from actual weekly scores. No power rankings, no luck/expected-win
 * modeling — see the module docstring in `lib/analytics/types.ts` for why.
 */

import type { ManagerRef } from "./types";
import type { RawBracketMatch, RawLeagueUser, RawMatchup, RawRoster } from "@/lib/sleeper/types";

export interface RosterStandingFacts {
  roster_id: number;
  manager: ManagerRef;

  wins: number;
  losses: number;
  ties: number;
  win_percentage: number | null;

  points_for: number;
  points_against: number;

  games_played: number;
  average_points_for: number | null;
  average_points_against: number | null;

  highest_weekly_score: number | null;
  lowest_weekly_score: number | null;
  median_weekly_score: number | null;
  /** Population standard deviation of this roster's weekly scores. */
  standard_deviation_weekly_score: number | null;

  /** Weeks this roster posted the single highest score across the league. */
  weekly_high_score_count: number;
  /** Weeks this roster posted the single lowest score across the league. */
  weekly_low_score_count: number;

  /** Only populated when a bracket exists and this roster's path is decided. */
  regular_season_finish: number | null;
  playoff_finish: number | null;
  championship: boolean;
  runner_up: boolean;
}

function combinePoints(whole: number | undefined, decimal: number | undefined): number {
  const base = typeof whole === "number" && Number.isFinite(whole) ? whole : 0;
  const fraction = typeof decimal === "number" && Number.isFinite(decimal) ? decimal : 0;
  return Math.round((base + fraction / 100) * 100) / 100;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const value =
    sorted.length % 2 === 0
      ? ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2
      : (sorted[mid] as number);
  return round2(value);
}

/** Population standard deviation: sqrt(mean squared deviation from the mean). */
function populationStdDev(values: number[]): number | null {
  if (values.length === 0) return null;
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
  return round2(Math.sqrt(variance));
}

function managerRef(
  roster: RawRoster,
  usersById: Map<string, RawLeagueUser>,
): ManagerRef {
  const user = roster.owner_id ? usersById.get(roster.owner_id) : undefined;
  return {
    user_id: roster.owner_id ?? null,
    display_name: user?.display_name ?? null,
    team_name: (user?.metadata?.team_name as string | undefined) ?? null,
  };
}

/** Find the championship match (place 1) in a winners bracket, if decided. */
function findChampionshipResult(
  winnersBracket: RawBracketMatch[],
): { championId: number; runnerUpId: number } | null {
  const final = winnersBracket.find((match) => match.p === 1 && match.w !== null);
  if (!final || final.w === null) return null;
  return { championId: final.w, runnerUpId: final.l ?? -1 };
}

/**
 * Compute per-roster standings facts.
 *
 * `points_for`/`points_against` come from Sleeper's own running roster totals
 * (authoritative); weekly high/low/median/stdev come from actual per-week
 * matchup scores, so both are cross-checked sources rather than one derived
 * from the other.
 */
export function computeStandings(
  rosters: RawRoster[],
  users: RawLeagueUser[],
  matchupsByWeek: Map<number, RawMatchup[]>,
  winnersBracket: RawBracketMatch[],
): RosterStandingFacts[] {
  const usersById = new Map(users.map((user) => [user.user_id, user]));
  const championship = findChampionshipResult(winnersBracket);

  // Weekly scores per roster, and the league-wide high/low roster each week.
  const weeklyScoresByRoster = new Map<number, number[]>();
  const highCountByRoster = new Map<number, number>();
  const lowCountByRoster = new Map<number, number>();

  for (const weekRows of matchupsByWeek.values()) {
    const scored = weekRows.filter(
      (row): row is RawMatchup & { points: number } => typeof row.points === "number",
    );
    if (scored.length === 0) continue;

    for (const row of scored) {
      const bucket = weeklyScoresByRoster.get(row.roster_id) ?? [];
      bucket.push(row.points);
      weeklyScoresByRoster.set(row.roster_id, bucket);
    }

    const maxPoints = Math.max(...scored.map((row) => row.points));
    const minPoints = Math.min(...scored.map((row) => row.points));
    for (const row of scored) {
      if (row.points === maxPoints) {
        highCountByRoster.set(row.roster_id, (highCountByRoster.get(row.roster_id) ?? 0) + 1);
      }
      if (row.points === minPoints) {
        lowCountByRoster.set(row.roster_id, (lowCountByRoster.get(row.roster_id) ?? 0) + 1);
      }
    }
  }

  return rosters
    .map((roster): RosterStandingFacts => {
      const settings = roster.settings ?? {};
      const wins = settings.wins ?? 0;
      const losses = settings.losses ?? 0;
      const ties = settings.ties ?? 0;
      const gamesPlayed = wins + losses + ties;

      const pointsFor = combinePoints(settings.fpts, settings.fpts_decimal);
      const pointsAgainst = combinePoints(
        settings.fpts_against,
        settings.fpts_against_decimal,
      );

      const weeklyScores = weeklyScoresByRoster.get(roster.roster_id) ?? [];

      return {
        roster_id: roster.roster_id,
        manager: managerRef(roster, usersById),

        wins,
        losses,
        ties,
        win_percentage: gamesPlayed > 0 ? round2((wins + ties * 0.5) / gamesPlayed) : null,

        points_for: pointsFor,
        points_against: pointsAgainst,

        games_played: gamesPlayed,
        average_points_for: gamesPlayed > 0 ? round2(pointsFor / gamesPlayed) : null,
        average_points_against: gamesPlayed > 0 ? round2(pointsAgainst / gamesPlayed) : null,

        highest_weekly_score: weeklyScores.length > 0 ? round2(Math.max(...weeklyScores)) : null,
        lowest_weekly_score: weeklyScores.length > 0 ? round2(Math.min(...weeklyScores)) : null,
        median_weekly_score: median(weeklyScores),
        standard_deviation_weekly_score: populationStdDev(weeklyScores),

        weekly_high_score_count: highCountByRoster.get(roster.roster_id) ?? 0,
        weekly_low_score_count: lowCountByRoster.get(roster.roster_id) ?? 0,

        // Regular-season finish requires a fully-played schedule to rank
        // meaningfully; left null here and computed by the standings route,
        // which has the full sorted list in hand.
        regular_season_finish: null,
        playoff_finish: null,
        championship: championship?.championId === roster.roster_id,
        runner_up: championship?.runnerUpId === roster.roster_id,
      };
    })
    .sort((a, b) => a.roster_id - b.roster_id);
}

/**
 * Assign `regular_season_finish` (1 = best) by wins, then points_for, matching
 * Sleeper's own default tiebreaker. Mutates and returns the same array.
 */
export function assignRegularSeasonFinish(
  standings: RosterStandingFacts[],
): RosterStandingFacts[] {
  const ranked = [...standings].sort(
    (a, b) => b.wins - a.wins || b.points_for - a.points_for,
  );
  ranked.forEach((entry, index) => {
    entry.regular_season_finish = index + 1;
  });
  return standings;
}
