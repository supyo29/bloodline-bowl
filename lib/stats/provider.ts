/**
 * NFL weekly stats provider backed by Sleeper's own stats endpoint.
 *
 * `GET /v1/stats/nfl/regular/{season}/{week}` is public, same-domain
 * (`api.sleeper.app`), and not documented in Sleeper's official API docs, but
 * it is Sleeper's own infrastructure — not a third-party scrape and not a
 * paid service — and its keys line up with `scoring_settings` keys exactly,
 * which is what lets the raw stats be fed straight into Bloodline Bowl's own
 * scoring engine. Sleeper's own precomputed `pts_*` fields on each stat line
 * are intentionally ignored.
 */

import { getWeeklyStats } from "@/lib/sleeper/client";
import type { PlayerStatLine, PlayerStatsProvider } from "./types";

/** Sleeper's own computed point totals — never used as this bridge's source of truth. */
const SLEEPER_COMPUTED_KEYS = new Set([
  "pts_std",
  "pts_ppr",
  "pts_half_ppr",
  "pos_rank_std",
  "pos_rank_ppr",
  "pos_rank_half_ppr",
]);

export class SleeperStatsProvider implements PlayerStatsProvider {
  readonly name = "Sleeper";

  isAvailable(): boolean {
    return true;
  }

  unavailableReason(): string | null {
    return null;
  }

  async getWeeklyStats(
    season: string,
    week: number,
  ): Promise<PlayerStatLine[]> {
    const raw = await getWeeklyStats(season, week);
    return (
      Object.entries(raw)
        // Sleeper's stats endpoint includes one synthetic "TEAM_XXX" row per NFL
        // team carrying team-level offensive aggregates (not in /players/nfl,
        // not a rosterable entity). Scoring these as an individual player would
        // produce large bogus point totals that dominate rankings.
        .filter(([playerId]) => !playerId.startsWith("TEAM_"))
        .map(([playerId, statLine]) => {
          const stats: Record<string, number> = {};
          for (const [key, value] of Object.entries(statLine)) {
            if (SLEEPER_COMPUTED_KEYS.has(key)) continue;
            if (typeof value === "number" && Number.isFinite(value))
              stats[key] = value;
          }
          return { player_id: playerId, season, week, stats };
        })
    );
  }
}

const provider: PlayerStatsProvider = new SleeperStatsProvider();

export function getStatsProvider(): PlayerStatsProvider {
  return provider;
}
