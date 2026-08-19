/**
 * Applies Bloodline Bowl's own scoring engine to raw NFL weekly stats, and
 * ranks the result. Ranks are computed only over the player pool actually
 * returned by the stats provider for that week (i.e. players with a stat
 * line) — documented explicitly in the response, since a "rank" is only
 * meaningful alongside the pool it was computed against.
 */

import { calculateFantasyPoints } from "@/lib/scoring/calculate";
import { slimPlayer, type PlayerIndex } from "@/lib/sleeper/client";
import type { NormalizedPlayer } from "@/lib/sleeper/types";
import type { PlayerStatLine } from "@/lib/stats/types";

export interface WeeklyPlayerFacts {
  player: NormalizedPlayer;
  season: string;
  week: number;
  stats: Record<string, number>;
  bloodline_points: {
    total: number;
    breakdown: ReturnType<typeof calculateFantasyPoints>["breakdown"];
  };
  overall_weekly_rank: string | null;
  position_weekly_rank: string | null;
}

export interface RankMethodology {
  pool_size: number;
  description: string;
}

/**
 * Score every stat line through the league's live scoring settings and rank
 * the result. Standard competition ranking (ties share a rank; the next
 * distinct score skips accordingly).
 */
export function buildWeeklyPlayerFacts(
  statLines: PlayerStatLine[],
  scoringSettings: Record<string, number>,
  playerIndex: PlayerIndex,
): { facts: WeeklyPlayerFacts[]; methodology: RankMethodology } {
  const scored = statLines.map((line) => {
    const player = playerIndex.get(line.player_id) ?? slimPlayer(line.player_id, undefined);
    const result = calculateFantasyPoints(line.stats, scoringSettings);
    return { line, player, result };
  });

  const overallRanked = [...scored].sort((a, b) => b.result.fantasy_points - a.result.fantasy_points);
  const overallRankById = new Map<string, number>();
  overallRanked.forEach((entry, index) => {
    const prev = overallRanked[index - 1];
    const rank =
      index > 0 && prev && prev.result.fantasy_points === entry.result.fantasy_points
        ? (overallRankById.get(prev.line.player_id) ?? index + 1)
        : index + 1;
    overallRankById.set(entry.line.player_id, rank);
  });

  const byPosition = new Map<string, typeof scored>();
  for (const entry of scored) {
    const position = entry.player.position ?? "UNKNOWN";
    const bucket = byPosition.get(position) ?? [];
    bucket.push(entry);
    byPosition.set(position, bucket);
  }
  const positionRankById = new Map<string, number>();
  const positionPoolSize = new Map<string, number>();
  for (const [position, entries] of byPosition) {
    const ranked = [...entries].sort(
      (a, b) => b.result.fantasy_points - a.result.fantasy_points,
    );
    positionPoolSize.set(position, ranked.length);
    ranked.forEach((entry, index) => {
      const prev = ranked[index - 1];
      const rank =
        index > 0 && prev && prev.result.fantasy_points === entry.result.fantasy_points
          ? (positionRankById.get(prev.line.player_id) ?? index + 1)
          : index + 1;
      positionRankById.set(entry.line.player_id, rank);
    });
  }

  const facts = scored.map(({ line, player, result }): WeeklyPlayerFacts => {
    const overallRank = overallRankById.get(line.player_id);
    const positionRank = positionRankById.get(line.player_id);
    const positionPool = positionPoolSize.get(player.position ?? "UNKNOWN") ?? 0;

    return {
      player,
      season: line.season,
      week: line.week,
      stats: line.stats,
      bloodline_points: { total: result.fantasy_points, breakdown: result.breakdown },
      overall_weekly_rank: overallRank ? `${overallRank} of ${scored.length}` : null,
      position_weekly_rank:
        positionRank && player.position ? `${positionRank} of ${positionPool}` : null,
    };
  });

  return {
    facts,
    methodology: {
      pool_size: scored.length,
      description:
        "Ranks are computed only among players with a returned stat line for this week (i.e. players who recorded at least one tracked statistic), not the full NFL player pool.",
    },
  };
}
