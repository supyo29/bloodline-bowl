/**
 * League history: walks the Sleeper season lineage (`previous_league_id`) and
 * reports factual per-season results. Championships/runner-ups are only ever
 * read from actual bracket results — never inferred from regular-season
 * standings, which is a meaningfully different (and unsupported) claim.
 */

import { getLeagueDrafts } from "@/lib/sleeper/client";
import { traverseLeagueLineage } from "./lineage";
import { loadSeasonData } from "./season-data";
import { assignRegularSeasonFinish, computeStandings } from "./standings";
import type { RosterStandingFacts } from "./standings";

export interface SeasonHistoryEntry {
  season: string;
  league_id: string;
  league_name: string;
  status: string;
  settings: Record<string, number>;
  scoring_settings: Record<string, number>;
  roster_positions: string[];
  team_count: number;
  draft_ids: string[];
  manager_ids: string[];
  standings: RosterStandingFacts[];
  champion: RosterStandingFacts | null;
  runner_up: RosterStandingFacts | null;
}

export interface LeagueHistoryResult {
  seasons: SeasonHistoryEntry[];
  warnings: string[];
}

/**
 * `revalidate` distinguishes the current season (short cache, still changing)
 * from past seasons (long cache — those results are final).
 */
export async function buildLeagueHistory(
  leagueId: string,
  currentSeason: string,
): Promise<LeagueHistoryResult> {
  const lineage = await traverseLeagueLineage(leagueId);
  const warnings = [...lineage.warnings];

  const seasons = await Promise.all(
    lineage.seasons.map(async ({ league }) => {
      const isCurrent = league.season === currentSeason;
      const revalidate = isCurrent ? 300 : 24 * 60 * 60;

      const [seasonData, drafts] = await Promise.all([
        loadSeasonData(league.league_id, { revalidate }),
        getLeagueDrafts(league.league_id, { revalidate }).catch(
          (error: unknown) => {
            warnings.push(
              `Could not load drafts for ${league.season} (league ${league.league_id}): ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
            return [];
          },
        ),
      ]);
      warnings.push(...seasonData.warnings);

      const standings = assignRegularSeasonFinish(
        computeStandings(
          seasonData.rosters,
          seasonData.users,
          new Map(), // Full weekly-score stats are exposed by /api/standings; history stays lighter.
          seasonData.winnersBracket,
        ),
      );

      const champion = standings.find((s) => s.championship) ?? null;
      const runnerUp = standings.find((s) => s.runner_up) ?? null;

      const entry: SeasonHistoryEntry = {
        season: league.season,
        league_id: league.league_id,
        league_name: league.name,
        status: league.status,
        settings: league.settings ?? {},
        scoring_settings: league.scoring_settings ?? {},
        roster_positions: league.roster_positions ?? [],
        team_count: league.total_rosters,
        draft_ids: Array.isArray(drafts) ? drafts.map((d) => d.draft_id) : [],
        manager_ids: seasonData.users.map((u) => u.user_id),
        standings,
        champion,
        runner_up: runnerUp,
      };
      return entry;
    }),
  );

  // Most recent season first.
  seasons.sort((a, b) => b.season.localeCompare(a.season));

  return { seasons, warnings };
}
