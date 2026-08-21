/**
 * Manager career aggregation across every season discovered in the league's
 * lineage, keyed by Sleeper's `user_id` — the one identifier Sleeper keeps
 * stable for the same person across seasons and even across renamed leagues.
 */

import {
  getLeagueRosters,
  getLeagueTransactions,
  getLeagueUsers,
} from "@/lib/sleeper/client";
import type { SeasonHistoryEntry } from "./history";
import { allWeeks } from "./season-data";

export interface ManagerSeasonRef {
  season: string;
  league_id: string;
  roster_id: number | null;
  display_name: string | null;
}

export interface ManagerCareerFacts {
  seasons_played: number;
  wins: number;
  losses: number;
  ties: number;
  win_percentage: number | null;
  points_for: number;
  points_against: number;
  championships: number;
  runner_up_finishes: number;
  playoff_appearances: number | null;
}

export interface ManagerTransactionFacts {
  trades: number;
  waiver_claims: number;
  free_agent_adds: number;
  drops: number;
  faab_spent: number | null;
}

export interface ManagerProfile {
  user_id: string;
  display_name: string | null;
  seasons: ManagerSeasonRef[];
  career: ManagerCareerFacts;
  transactions: ManagerTransactionFacts;
  draft_ids: string[];
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Sum one season's transaction counts per roster_id, across every week.
 * Tolerant of missing weeks (returns empty arrays for unplayed weeks).
 */
async function loadSeasonTransactionCounts(
  leagueId: string,
  revalidate: number,
): Promise<{
  countsByRoster: Map<
    number,
    {
      trades: number;
      waiver_claims: number;
      free_agent_adds: number;
      drops: number;
      faab: number;
    }
  >;
  warnings: string[];
}> {
  const warnings: string[] = [];
  const countsByRoster = new Map<
    number,
    {
      trades: number;
      waiver_claims: number;
      free_agent_adds: number;
      drops: number;
      faab: number;
    }
  >();

  const results = await Promise.all(
    allWeeks().map((week) =>
      getLeagueTransactions(leagueId, week, { revalidate }).catch(
        (error: unknown) => {
          warnings.push(
            `Could not load week ${week} transactions for league ${leagueId}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          return [];
        },
      ),
    ),
  );

  for (const weekTransactions of results) {
    for (const transaction of weekTransactions) {
      if (transaction.status !== "complete") continue;
      for (const rosterId of transaction.roster_ids) {
        const entry = countsByRoster.get(rosterId) ?? {
          trades: 0,
          waiver_claims: 0,
          free_agent_adds: 0,
          drops: 0,
          faab: 0,
        };
        if (transaction.type === "trade") entry.trades += 1;
        else if (transaction.type === "waiver") entry.waiver_claims += 1;
        else if (transaction.type === "free_agent") entry.free_agent_adds += 1;

        for (const dropRosterId of Object.values(transaction.drops ?? {})) {
          if (dropRosterId === rosterId) entry.drops += 1;
        }
        countsByRoster.set(rosterId, entry);
      }

      const bid = transaction.settings?.waiver_bid;
      if (transaction.type === "waiver" && typeof bid === "number") {
        const rosterId = transaction.roster_ids[0];
        if (rosterId !== undefined) {
          const entry = countsByRoster.get(rosterId) ?? {
            trades: 0,
            waiver_claims: 0,
            free_agent_adds: 0,
            drops: 0,
            faab: 0,
          };
          entry.faab += bid;
          countsByRoster.set(rosterId, entry);
        }
      }
    }
  }

  return { countsByRoster, warnings };
}

/**
 * Aggregate every manager's career facts across all seasons in `history`.
 * `MAX_WEEK` transaction fetches happen per season, so this is intentionally
 * the most expensive analytics call — callers should cache its result.
 */
export async function buildManagerProfiles(
  history: SeasonHistoryEntry[],
  currentSeason: string,
): Promise<{ profiles: ManagerProfile[]; warnings: string[] }> {
  const warnings: string[] = [];
  const profilesById = new Map<string, ManagerProfile>();

  for (const season of history) {
    const isCurrent = season.season === currentSeason;
    const revalidate = isCurrent ? 300 : 24 * 60 * 60;

    const [rosters, users, { countsByRoster, warnings: txWarnings }] =
      await Promise.all([
        getLeagueRosters(season.league_id, { revalidate }).catch(() => []),
        getLeagueUsers(season.league_id, { revalidate }).catch(() => []),
        loadSeasonTransactionCounts(season.league_id, revalidate),
      ]);
    warnings.push(...txWarnings);

    const usersById = new Map(users.map((u) => [u.user_id, u]));
    const standingByRoster = new Map(
      season.standings.map((s) => [s.roster_id, s]),
    );

    for (const roster of rosters) {
      if (!roster.owner_id) continue;
      const user = usersById.get(roster.owner_id);
      const standing = standingByRoster.get(roster.roster_id);

      const profile =
        profilesById.get(roster.owner_id) ??
        ({
          user_id: roster.owner_id,
          display_name: user?.display_name ?? null,
          seasons: [],
          career: {
            seasons_played: 0,
            wins: 0,
            losses: 0,
            ties: 0,
            win_percentage: null,
            points_for: 0,
            points_against: 0,
            championships: 0,
            runner_up_finishes: 0,
            playoff_appearances: null,
          },
          transactions: {
            trades: 0,
            waiver_claims: 0,
            free_agent_adds: 0,
            drops: 0,
            faab_spent: null,
          },
          draft_ids: [],
        } satisfies ManagerProfile);

      profile.seasons.push({
        season: season.season,
        league_id: season.league_id,
        roster_id: roster.roster_id,
        display_name: user?.display_name ?? null,
      });

      profile.career.seasons_played += 1;
      if (standing) {
        profile.career.wins += standing.wins;
        profile.career.losses += standing.losses;
        profile.career.ties += standing.ties;
        profile.career.points_for = round2(
          profile.career.points_for + standing.points_for,
        );
        profile.career.points_against = round2(
          profile.career.points_against + standing.points_against,
        );
        if (standing.championship) profile.career.championships += 1;
        if (standing.runner_up) profile.career.runner_up_finishes += 1;
      }

      const txCounts = countsByRoster.get(roster.roster_id);
      if (txCounts) {
        profile.transactions.trades += txCounts.trades;
        profile.transactions.waiver_claims += txCounts.waiver_claims;
        profile.transactions.free_agent_adds += txCounts.free_agent_adds;
        profile.transactions.drops += txCounts.drops;
        profile.transactions.faab_spent = round2(
          (profile.transactions.faab_spent ?? 0) + txCounts.faab,
        );
      }

      for (const draftId of season.draft_ids) {
        if (!profile.draft_ids.includes(draftId))
          profile.draft_ids.push(draftId);
      }

      profilesById.set(roster.owner_id, profile);
    }
  }

  for (const profile of profilesById.values()) {
    const games =
      profile.career.wins + profile.career.losses + profile.career.ties;
    profile.career.win_percentage =
      games > 0
        ? round2((profile.career.wins + profile.career.ties * 0.5) / games)
        : null;
  }

  return { profiles: [...profilesById.values()], warnings };
}
