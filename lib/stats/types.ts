/**
 * NFL weekly player stats provider abstraction.
 *
 * A provider returns RAW counting stats (yards, completions, receptions —
 * whatever it has), never precomputed fantasy points. Bloodline Bowl's own
 * scoring engine (`lib/scoring/calculate.ts`) is always applied locally, so
 * the league's actual scoring rules are the only source of truth for points.
 */

export interface PlayerStatLine {
  player_id: string;
  season: string;
  week: number;
  /** Raw counting stats, keyed the same way as Sleeper's scoring_settings. */
  stats: Record<string, number>;
}

export interface PlayerStatsProvider {
  readonly name: string;
  isAvailable(): boolean;
  unavailableReason(): string | null;
  getWeeklyStats(season: string, week: number): Promise<PlayerStatLine[]>;
}
