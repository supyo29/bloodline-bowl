/**
 * Phase 1B.2 compatibility adapter: canonical snapshot -> the `RosterStandingFacts`
 * shape produced by `lib/analytics/standings.ts#computeStandings(rosters, users,
 * new Map(), [])`.
 *
 * That "empty maps" call is exactly how `buildSnapshot` and
 * `/api/leagues/:slug/managers/:slug/snapshot` invoke it today — with NO weekly
 * matchup history and NO playoff bracket. So the only fields those callers ever
 * get populated are the ones derivable from current league state:
 *   roster_id, manager, wins/losses/ties, win_percentage, points_for/against,
 *   games_played, average_points_for/against.
 * Every weekly-derived field (highest/lowest/median/stdev weekly score,
 * high/low counts) and every bracket-derived field (regular_season_finish,
 * playoff_finish, championship, runner_up) is null / 0 / false in that call —
 * and stays exactly that here.
 *
 * `/api/standings` itself is NOT migrated — it passes real `matchupsByWeek` +
 * `winnersBracket` and needs the full historical weekly loader.
 */

import type { RosterStandingFacts } from "@/lib/analytics/standings";
import type { CanonicalLeagueSnapshot, CanonicalManager } from "../schema";

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export function canonicalToStandingsFacts(
  snapshot: CanonicalLeagueSnapshot,
): RosterStandingFacts[] {
  const managerById = new Map<string, CanonicalManager>(
    snapshot.managers.map((m) => [m.canonical_manager_id, m]),
  );
  const standingByTeam = new Map(
    snapshot.standings.map((s) => [s.canonical_team_id, s]),
  );

  return snapshot.teams
    .map((team): RosterStandingFacts => {
      const rosterId = Number(team.provider_team_id);
      // Primary owner: the resolved CanonicalManager if present, else — for a
      // roster whose owner has LEFT the league (`owner_id` set, no `users`
      // entry) — the raw `provider_owner_id`, exactly matching the legacy
      // `managerRef` which yielded `{ user_id: roster.owner_id, display_name:
      // null, team_name: null }`. Co-owners never drive the ManagerRef.
      const owner = team.canonical_manager_ids[0]
        ? managerById.get(team.canonical_manager_ids[0])
        : undefined;
      const ownerUserId = owner?.provider_user_id ?? team.provider_owner_id ?? null;
      const standing = standingByTeam.get(team.canonical_team_id);

      const wins = standing?.wins ?? team.record.wins;
      const losses = standing?.losses ?? team.record.losses;
      const ties = standing?.ties ?? team.record.ties;
      const gamesPlayed = wins + losses + ties;
      const pointsFor = round2(standing?.points_for ?? team.record.points_for);
      const pointsAgainst = round2(standing?.points_against ?? team.record.points_against);

      return {
        roster_id: rosterId,
        manager: {
          user_id: ownerUserId,
          display_name: owner?.display_name ?? null,
          team_name: team.team_name,
        },
        wins,
        losses,
        ties,
        // `computeStandings` rounds win_percentage to 2dp; `toCanonicalStandings`
        // keeps 3dp — re-round here for byte compatibility.
        win_percentage:
          gamesPlayed > 0 ? round2((wins + ties * 0.5) / gamesPlayed) : null,
        points_for: pointsFor,
        points_against: pointsAgainst,
        games_played: gamesPlayed,
        average_points_for: gamesPlayed > 0 ? round2(pointsFor / gamesPlayed) : null,
        average_points_against:
          gamesPlayed > 0 ? round2(pointsAgainst / gamesPlayed) : null,
        highest_weekly_score: null,
        lowest_weekly_score: null,
        median_weekly_score: null,
        standard_deviation_weekly_score: null,
        weekly_high_score_count: 0,
        weekly_low_score_count: 0,
        regular_season_finish: null,
        playoff_finish: null,
        championship: false,
        runner_up: false,
      };
    })
    .sort((a, b) => a.roster_id - b.roster_id);
}
