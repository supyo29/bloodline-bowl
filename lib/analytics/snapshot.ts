/**
 * Builds the compact `/api/snapshot` response by composing already-built
 * pieces from `/api/league`, `/api/draft`, `/api/scoring`, and this analytics
 * layer — never re-implementing their logic, and never simply concatenating
 * their full payloads (`/api/league`'s player-level detail and `/api/draft`'s
 * available-player pool are both intentionally left out here).
 */

import {
  getLeagueRosters,
  getLeagueTransactions,
  getLeagueUsers,
  getMatchups,
  getNflState,
  getPlayerIndex,
} from "@/lib/sleeper/client";
import { buildDraftBundle } from "@/lib/sleeper/draft-service";
import { buildLeagueBundle, resolveLeagueId } from "@/lib/sleeper/service";
import { buildScoringBundle } from "@/lib/scoring/scoring-service";
import { buildWeekMatchupFacts, type MatchupFact } from "./matchups";
import { computeStandings, type RosterStandingFacts } from "./standings";
import { normalizeTransaction, type TransactionFact } from "./transactions";

const RECENT_TRANSACTION_WEEK_LOOKBACK = 3;
const RECENT_TRANSACTION_LIMIT = 15;

export interface LeagueSnapshot {
  league: {
    league_id: string;
    name: string;
    season: string;
    status: string;
    team_count: number;
  };
  scoring_summary: {
    classification: unknown;
    td_values: unknown;
    yardage_equivalencies: unknown;
  };
  standings: RosterStandingFacts[];
  teams: Array<{
    roster_id: number;
    manager: { user_id: string | null; display_name: string | null; team_name: string | null };
    record: { wins: number; losses: number; ties: number };
    points_for: number;
    roster_summary: { player_count: number; starter_count: number; bench_count: number };
    budget: {
      starting: number;
      spent: number;
      remaining: number;
      maximum_single_bid: number;
    } | null;
    draft_pick_count: number;
  }>;
  recent_transactions: TransactionFact[];
  current_matchups: MatchupFact[];
  draft: {
    draft_id: string | null;
    status: string | null;
    type: string | null;
    completed_picks: number | null;
    remaining_picks: number | null;
  };
}

export async function buildSnapshot(): Promise<{
  snapshot: LeagueSnapshot;
  warnings: string[];
}> {
  const leagueId = resolveLeagueId();
  const warnings: string[] = [];

  const [leagueBundle, draftBundle, scoring, nflState, rosters, users] = await Promise.all([
    buildLeagueBundle(leagueId),
    buildDraftBundle(leagueId, { availableLimit: 1, position: null }),
    buildScoringBundle(),
    getNflState().catch(() => null),
    getLeagueRosters(leagueId).catch(() => []),
    getLeagueUsers(leagueId).catch(() => []),
  ]);

  const league = leagueBundle.response.league;
  const usersById = new Map(users.map((user) => [user.user_id, user]));
  const rostersById = new Map(rosters.map((roster) => [roster.roster_id, roster]));

  const standingsRaw = computeStandings(rosters, users, new Map(), []);
  const standings = standingsRaw;

  const currentWeek = nflState?.week && nflState.week > 0 ? nflState.week : 1;
  let currentMatchups: MatchupFact[] = [];
  try {
    const rawMatchups = await getMatchups(leagueId, currentWeek);
    currentMatchups = buildWeekMatchupFacts(
      league.season,
      currentWeek,
      rawMatchups,
      rosters,
      usersById,
    );
  } catch (error) {
    warnings.push(
      `Could not load current-week matchups: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const recentWeeks = Array.from(
    { length: Math.min(RECENT_TRANSACTION_WEEK_LOOKBACK, currentWeek) },
    (_, i) => currentWeek - i,
  ).filter((week) => week >= 1);

  let recentTransactions: TransactionFact[] = [];
  try {
    const playerIndex = await getPlayerIndex();
    const weekResults = await Promise.all(
      recentWeeks.map((week) => getLeagueTransactions(leagueId, week).catch(() => [])),
    );
    const allTransactions = weekResults.flat().filter((t) => t.status === "complete");
    recentTransactions = allTransactions
      .sort((a, b) => (b.created ?? 0) - (a.created ?? 0))
      .slice(0, RECENT_TRANSACTION_LIMIT)
      .map((t) => normalizeTransaction(t, league.season, playerIndex, rostersById, usersById));
  } catch (error) {
    warnings.push(
      `Could not load recent transactions: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const budgetByRoster = new Map(
    draftBundle.response.teams.map((team) => [team.roster_id, team.budget]),
  );
  const pickCountByRoster = new Map(
    leagueBundle.response.teams.map((team) => [team.roster_id, team.draft_picks.length]),
  );

  const teams = leagueBundle.response.teams.map((team) => ({
    roster_id: team.roster_id,
    manager: {
      user_id: team.manager.user_id,
      display_name: team.manager.display_name,
      team_name: team.manager.team_name,
    },
    record: { wins: team.record.wins, losses: team.record.losses, ties: team.record.ties },
    points_for: team.record.points_for,
    roster_summary: {
      player_count: team.players.length,
      starter_count: team.starters.filter((s) => !s.is_empty).length,
      bench_count: team.bench.length,
    },
    budget: budgetByRoster.get(team.roster_id) ?? null,
    draft_pick_count: pickCountByRoster.get(team.roster_id) ?? 0,
  }));

  const snapshot: LeagueSnapshot = {
    league: {
      league_id: league.league_id,
      name: league.name,
      season: league.season,
      status: league.status,
      team_count: league.total_rosters,
    },
    scoring_summary: {
      classification: scoring.classification,
      td_values: scoring.comparisons.td_values,
      yardage_equivalencies: scoring.comparisons.yardage_equivalencies,
    },
    standings,
    teams,
    recent_transactions: recentTransactions,
    current_matchups: currentMatchups,
    draft: {
      draft_id: draftBundle.response.draft?.draft_id ?? null,
      status: draftBundle.response.draft?.status ?? null,
      type: draftBundle.response.draft?.type ?? null,
      completed_picks: draftBundle.response.draft?.completed_picks ?? null,
      remaining_picks: draftBundle.response.draft?.remaining_picks ?? null,
    },
  };

  return { snapshot, warnings };
}
