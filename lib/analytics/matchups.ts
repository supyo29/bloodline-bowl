/**
 * Normalizes Sleeper's per-roster weekly matchup rows into paired games.
 *
 * Sleeper returns one row per roster per week; two rows sharing a
 * `matchup_id` are the two sides of one game. This module pairs them and
 * exposes each side's result as a fact — win/loss/tie and margin, never a
 * qualitative read on the result.
 */

import type { ManagerRef } from "./types";
import type { RawLeagueUser, RawMatchup, RawRoster } from "@/lib/sleeper/types";

export interface MatchupFact {
  season: string;
  week: number;
  matchup_id: number | null;
  team: { roster_id: number; manager: ManagerRef };
  opponent: { roster_id: number; manager: ManagerRef } | null;
  points: number | null;
  opponent_points: number | null;
  result: "win" | "loss" | "tie" | null;
  margin: number | null;
  /** e.g. "2 of 10" — this roster's rank among all scores that week. */
  weekly_score_rank: string | null;
}

function managerRef(
  roster: RawRoster | undefined,
  usersById: Map<string, RawLeagueUser>,
): ManagerRef {
  const user = roster?.owner_id ? usersById.get(roster.owner_id) : undefined;
  return {
    user_id: roster?.owner_id ?? null,
    display_name: user?.display_name ?? null,
    team_name: (user?.metadata?.team_name as string | undefined) ?? null,
  };
}

/**
 * Pair one week's raw matchup rows into games and compute each side's facts,
 * including a rank of every roster's score that week (ties share a rank).
 */
export function buildWeekMatchupFacts(
  season: string,
  week: number,
  rawMatchups: RawMatchup[],
  rosters: RawRoster[],
  usersById: Map<string, RawLeagueUser>,
): MatchupFact[] {
  const rostersById = new Map(
    rosters.map((roster) => [roster.roster_id, roster]),
  );

  // Rank every roster's score that week, highest first; ties share a rank.
  const scored = rawMatchups
    .filter((row) => typeof row.points === "number")
    .map((row) => ({ roster_id: row.roster_id, points: row.points as number }))
    .sort((a, b) => b.points - a.points);
  const rankByRoster = new Map<number, number>();
  scored.forEach((entry, index) => {
    // Standard competition ranking: equal scores share the same rank.
    const rank =
      index > 0 && scored[index - 1]?.points === entry.points
        ? (rankByRoster.get(scored[index - 1]!.roster_id) ?? index + 1)
        : index + 1;
    rankByRoster.set(entry.roster_id, rank);
  });
  const totalScored = scored.length;

  const byMatchupId = new Map<number, RawMatchup[]>();
  const unpaired: RawMatchup[] = [];
  for (const row of rawMatchups) {
    if (row.matchup_id === null) {
      unpaired.push(row);
      continue;
    }
    const bucket = byMatchupId.get(row.matchup_id) ?? [];
    bucket.push(row);
    byMatchupId.set(row.matchup_id, bucket);
  }

  const facts: MatchupFact[] = [];

  const buildFact = (
    row: RawMatchup,
    opponentRow: RawMatchup | null,
  ): MatchupFact => {
    const points = row.points;
    const opponentPoints = opponentRow?.points ?? null;
    let result: MatchupFact["result"] = null;
    let margin: number | null = null;
    if (typeof points === "number" && typeof opponentPoints === "number") {
      margin = Math.round((points - opponentPoints) * 100) / 100;
      result = margin > 0 ? "win" : margin < 0 ? "loss" : "tie";
    }

    const rank = rankByRoster.get(row.roster_id);
    return {
      season,
      week,
      matchup_id: row.matchup_id,
      team: {
        roster_id: row.roster_id,
        manager: managerRef(rostersById.get(row.roster_id), usersById),
      },
      opponent: opponentRow
        ? {
            roster_id: opponentRow.roster_id,
            manager: managerRef(
              rostersById.get(opponentRow.roster_id),
              usersById,
            ),
          }
        : null,
      points: points ?? null,
      opponent_points: opponentPoints,
      result,
      margin,
      weekly_score_rank: rank ? `${rank} of ${totalScored}` : null,
    };
  };

  for (const rows of byMatchupId.values()) {
    if (rows.length === 2) {
      const [a, b] = rows as [RawMatchup, RawMatchup];
      facts.push(buildFact(a, b));
      facts.push(buildFact(b, a));
    } else {
      // Odd group (bye week, or a Sleeper data quirk) — report with no opponent.
      for (const row of rows) facts.push(buildFact(row, null));
    }
  }
  for (const row of unpaired) facts.push(buildFact(row, null));

  return facts.sort((a, b) => a.team.roster_id - b.team.roster_id);
}
