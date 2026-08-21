/**
 * Historical weekly player fantasy scoring, backing `GET /api/player-weekly`.
 *
 * Two sources, used in priority order, per player-week:
 *
 *  1. **Sleeper's own matchup-scored points** (`players_points` on
 *     `/league/{id}/matchups/{week}`) for any player who was on a roster that
 *     week. This is Sleeper's own scoring engine applying that league's own
 *     `scoring_settings` at the time — the single most authoritative source
 *     available, and exactly what the task calls for: "If Sleeper already
 *     exposes league-scored player points directly, use that authoritative
 *     source." No recomputation, no assumptions about which categories were
 *     enabled — DEF/K distance tiers, points-allowed bands, everything the
 *     league actually configured is already baked in.
 *
 *  2. **This bridge's own scoring engine** (`calculateFantasyPoints`,
 *     shared with `/api/scoring` and `/api/weekly-stats`) applied to raw
 *     counting stats from Sleeper's stats endpoint, for players who were on
 *     nobody's roster that week. Rostered-player scoring never needs this
 *     path; it exists because "waiver value" and "replacement value"
 *     analysis is meaningless without knowing what unrostered players scored
 *     too. The resolved historical league's OWN `scoring_settings` are always
 *     used here — never the current season's.
 */

import { slimPlayer, type PlayerIndex } from "@/lib/sleeper/client";
import { calculateFantasyPoints } from "@/lib/scoring/calculate";
import { draftablePositions, eligiblePositions } from "@/lib/sleeper/draft";
import type { PlayerStatLine } from "@/lib/stats/types";
import type { NormalizedPlayer, RawMatchup } from "@/lib/sleeper/types";

export type ScoringSource =
  "sleeper_matchup_points" | "bridge_calculated_from_raw_stats";
export type ScoringMethod = "sleeper_authoritative" | "local_scoring_engine";

export interface PlayerWeeklyRow {
  league_selector: string;
  league_id: string;
  season: string;
  week: number;
  player_id: string;
  full_name: string;
  position: string | null;
  fantasy_positions: string[];
  /**
   * The player's CURRENT Sleeper metadata team, kept only for stable
   * identity — never asserted as the historical team. `nfl_team_this_week`
   * is null when the historical team for that specific week isn't knowable
   * from the data this bridge has (Sleeper does not expose historical
   * weekly team assignment separately from the current player record).
   */
  nfl_team_this_week: string | null;
  fantasy_points: number;
  scoring_source: ScoringSource;
  scoring_method: ScoringMethod;
  resolved: boolean;
  game_played: boolean | null;
  raw_stats: Record<string, number> | null;
  source_timestamp: string;
  scoring_settings_hash: string;
  source_provider: "Sleeper";
}

/** Cheap, deterministic fingerprint of a scoring_settings object for provenance. */
export function hashScoringSettings(
  scoringSettings: Record<string, number>,
): string {
  const sorted = Object.entries(scoringSettings)
    .filter(([, value]) => typeof value === "number")
    .sort(([a], [b]) => a.localeCompare(b));
  const serialized = sorted.map(([key, value]) => `${key}=${value}`).join("|");
  let hash = 0;
  for (let i = 0; i < serialized.length; i += 1) {
    hash = (hash * 31 + serialized.charCodeAt(i)) | 0;
  }
  return `sha_${(hash >>> 0).toString(16)}_n${sorted.length}`;
}

function resolvePlayer(
  playerId: string,
  playerIndex: PlayerIndex,
): NormalizedPlayer {
  return playerIndex.get(playerId) ?? slimPlayer(playerId, undefined);
}

export interface BuildPlayerWeeklyRowsInput {
  leagueSelector: string;
  leagueId: string;
  season: string;
  week: number;
  matchups: RawMatchup[];
  /** Raw counting stats for the same week; null when the provider had none. */
  statLines: PlayerStatLine[] | null;
  scoringSettings: Record<string, number>;
  playerIndex: PlayerIndex;
  generatedAt: string;
  /**
   * This league's own `roster_positions`. Bounds the free-agent (unrostered)
   * fallback pool to positions this league can actually draft/start —
   * Sleeper's raw stats endpoint returns a stat line for every NFL player who
   * recorded anything that week, including offensive linemen, IDP positions,
   * and punters, none of which belong in a standard-lineup fantasy analysis.
   * Rostered players (Source 1) are never filtered this way: if a manager
   * actually owned the player, that ownership is reported regardless.
   */
  rosterPositions: string[];
}

export function buildPlayerWeeklyRows(input: BuildPlayerWeeklyRowsInput): {
  rows: PlayerWeeklyRow[];
  unresolvedPlayerIds: string[];
} {
  const {
    leagueSelector,
    leagueId,
    season,
    week,
    matchups,
    statLines,
    scoringSettings,
    playerIndex,
    generatedAt,
    rosterPositions,
  } = input;

  const settingsHash = hashScoringSettings(scoringSettings);
  const unresolved = new Set<string>();
  const draftable = draftablePositions(rosterPositions);

  // Rostered players this week, keyed by player_id -> Sleeper's own scored points.
  const rosteredPoints = new Map<string, number>();
  const rosteredPlayerIds = new Set<string>();
  for (const row of matchups) {
    for (const playerId of row.players ?? []) {
      if (playerId === "0") continue;
      rosteredPlayerIds.add(playerId);
      const points = row.players_points?.[playerId];
      if (typeof points === "number") rosteredPoints.set(playerId, points);
    }
  }

  const rows: PlayerWeeklyRow[] = [];

  const pushRow = (
    playerId: string,
    fantasyPoints: number,
    source: ScoringSource,
    method: ScoringMethod,
    rawStats: Record<string, number> | null,
    gamePlayed: boolean | null,
  ) => {
    const player = resolvePlayer(playerId, playerIndex);
    if (!player.resolved) unresolved.add(playerId);

    rows.push({
      league_selector: leagueSelector,
      league_id: leagueId,
      season,
      week,
      player_id: playerId,
      full_name: player.full_name,
      position: player.position,
      fantasy_positions: player.fantasy_positions,
      nfl_team_this_week: player.team,
      fantasy_points: fantasyPoints,
      scoring_source: source,
      scoring_method: method,
      resolved: player.resolved,
      game_played: gamePlayed,
      raw_stats: rawStats,
      source_timestamp: generatedAt,
      scoring_settings_hash: settingsHash,
      source_provider: "Sleeper",
    });
  };

  // Source 1: rostered players, Sleeper's own authoritative matchup scoring.
  for (const playerId of rosteredPlayerIds) {
    const points = rosteredPoints.get(playerId);
    // A rostered player with no points entry that week (commonly a bye or a
    // player added mid-week with no snap) is 0, not missing — the roster
    // snapshot itself is the evidence they were owned, per Phase 6.
    const resolvedPoints = typeof points === "number" ? points : 0;
    pushRow(
      playerId,
      Math.round(resolvedPoints * 100) / 100,
      "sleeper_matchup_points",
      "sleeper_authoritative",
      null,
      typeof points === "number",
    );
  }

  // Source 2: unrostered players (free agents that week), scored locally from
  // raw stats using the resolved historical league's own scoring settings.
  // Bounded to this league's actual draftable positions — see the
  // `rosterPositions` field docstring above for why.
  if (statLines) {
    for (const line of statLines) {
      if (rosteredPlayerIds.has(line.player_id)) continue; // already covered above
      const candidate = resolvePlayer(line.player_id, playerIndex);
      const eligible = eligiblePositions(candidate);
      if (!eligible.some((position) => draftable.has(position))) continue;
      const result = calculateFantasyPoints(line.stats, scoringSettings);
      pushRow(
        line.player_id,
        result.fantasy_points,
        "bridge_calculated_from_raw_stats",
        "local_scoring_engine",
        line.stats,
        Object.keys(line.stats).length > 0,
      );
    }
  }

  rows.sort(
    (a, b) =>
      b.fantasy_points - a.fantasy_points ||
      a.player_id.localeCompare(b.player_id),
  );

  return { rows, unresolvedPlayerIds: [...unresolved].sort() };
}
