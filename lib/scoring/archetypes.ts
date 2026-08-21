/**
 * Diagnostic player-archetype stat lines.
 *
 * These are NOT rankings or value judgments — just fixed, representative stat
 * lines run through the same {@link calculateFantasyPoints} engine as everything
 * else, so an AI can compare how the league's actual scoring rules treat
 * different kinds of statistical production.
 */

import { calculateFantasyPoints } from "./calculate";
import type { ArchetypeKey, ArchetypeResult, StatLine } from "./types";

export const ARCHETYPE_STAT_LINES: Record<
  ArchetypeKey,
  { description: string; stats: StatLine }
> = {
  pocket_qb: {
    description:
      "300 passing yards, 2 passing TD, 1 interception, 10 rushing yards",
    stats: { pass_yd: 300, pass_td: 2, pass_int: 1, rush_yd: 10 },
  },
  rushing_qb: {
    description:
      "220 passing yards, 1 passing TD, 1 interception, 80 rushing yards, 1 rushing TD",
    stats: { pass_yd: 220, pass_td: 1, pass_int: 1, rush_yd: 80, rush_td: 1 },
  },
  workhorse_rb: {
    description:
      "100 rushing yards, 1 rushing TD, 3 receptions, 20 receiving yards",
    stats: { rush_yd: 100, rush_td: 1, rec: 3, rec_yd: 20 },
  },
  receiving_rb: {
    description: "50 rushing yards, 8 receptions, 70 receiving yards",
    stats: { rush_yd: 50, rec: 8, rec_yd: 70 },
  },
  volume_wr: {
    description: "10 receptions, 100 receiving yards",
    stats: { rec: 10, rec_yd: 100 },
  },
  big_play_wr: {
    description: "4 receptions, 100 receiving yards, 1 receiving TD",
    stats: { rec: 4, rec_yd: 100, rec_td: 1 },
  },
  typical_te: {
    description: "5 receptions, 60 receiving yards",
    stats: { rec: 5, rec_yd: 60 },
  },
  elite_te_game: {
    description: "8 receptions, 90 receiving yards, 1 receiving TD",
    stats: { rec: 8, rec_yd: 90, rec_td: 1 },
  },
};

/**
 * Run every archetype stat line through the league's actual scoring settings.
 * Warnings are intentionally dropped here — an unsupported key in an archetype
 * stat line would indicate a bug in this file, not a caller error, and is
 * covered by tests rather than surfaced in every `/api/scoring` response.
 */
export function buildArchetypeExamples(
  scoringSettings: Record<string, number>,
): Record<ArchetypeKey, ArchetypeResult> {
  const entries = Object.entries(ARCHETYPE_STAT_LINES).map(
    ([key, { description, stats }]) => {
      const result = calculateFantasyPoints(stats, scoringSettings);
      return [
        key,
        {
          description,
          stats,
          fantasy_points: result.fantasy_points,
          breakdown: result.breakdown,
        },
      ] as const;
    },
  );

  return Object.fromEntries(entries) as Record<ArchetypeKey, ArchetypeResult>;
}
