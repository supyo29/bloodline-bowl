/**
 * Historical weekly roster ownership and starter snapshots, backing
 * `GET /api/lineups`.
 *
 * Source: `/league/{id}/matchups/{week}` per roster — `players` (full roster
 * that week, starters + bench) and `starters` (ordered starter player ids).
 * This is a genuine weekly snapshot, not an inference from end-of-season
 * rosters, so it correctly reflects mid-season trades/waiver moves.
 *
 * Slot mapping: Sleeper positionally aligns `starters` with the league's
 * roster_positions (BN/TAXI/IR excluded) — the exact same convention
 * `lib/sleeper/normalize.ts#normalizeStarters` already relies on for the
 * live league, verified here against real 2025 historical data before
 * reuse. A flex slot is labeled "FLEX" (its true Sleeper roster_position),
 * never a fabricated "FLEX1"/"RB3" distinction Sleeper doesn't make. Any
 * starter that can't be matched to a known slot position falls back to
 * `"STARTER_UNKNOWN"` rather than guessing.
 *
 * Not available from this source, and therefore not fabricated: which
 * specific historical week a player was on IR (Sleeper's `reserve` field only
 * exists on the *current* `/rosters` snapshot, not per historical week) — see
 * `ownership_status`.
 */

import { slimPlayer, type PlayerIndex } from "@/lib/sleeper/client";
import { startingSlots } from "@/lib/sleeper/normalize";
import type { NormalizedPlayer, RawLeagueUser, RawMatchup, RawRoster } from "@/lib/sleeper/types";

export type OwnershipStatus = "starter" | "bench" | "not_owned";

export interface LineupRow {
  league_selector: string;
  league_id: string;
  season: string;
  week: number;
  roster_id: number;
  user_id: string | null;
  manager_display_name: string | null;
  team_name: string | null;
  player_id: string;
  full_name: string;
  position: string | null;
  is_starter: boolean;
  roster_slot: string | null;
  starter_index: number | null;
  ownership_status: OwnershipStatus;
  bench: boolean;
  ir: boolean | null;
  matchup_id: number | null;
  resolved: boolean;
}

function resolvePlayer(playerId: string, playerIndex: PlayerIndex): NormalizedPlayer {
  return playerIndex.get(playerId) ?? slimPlayer(playerId, undefined);
}

function managerInfo(
  roster: RawRoster | undefined,
  usersById: Map<string, RawLeagueUser>,
): { user_id: string | null; display_name: string | null; team_name: string | null } {
  const user = roster?.owner_id ? usersById.get(roster.owner_id) : undefined;
  return {
    user_id: roster?.owner_id ?? null,
    display_name: user?.display_name ?? null,
    team_name: (user?.metadata?.team_name as string | undefined) ?? null,
  };
}

export interface BuildLineupRowsInput {
  leagueSelector: string;
  leagueId: string;
  season: string;
  week: number;
  matchups: RawMatchup[];
  rosters: RawRoster[];
  users: RawLeagueUser[];
  rosterPositions: string[];
  playerIndex: PlayerIndex;
}

export function buildLineupRows(input: BuildLineupRowsInput): {
  rows: LineupRow[];
  unresolvedPlayerIds: string[];
} {
  const { leagueSelector, leagueId, season, week, matchups, rosters, users, rosterPositions, playerIndex } =
    input;

  const usersById = new Map(users.map((u) => [u.user_id, u]));
  const rostersById = new Map(rosters.map((r) => [r.roster_id, r]));
  // Positionally aligned with a week's `starters` array, same convention the
  // live-league normalizer already relies on (verified against 2025 data).
  const expectedSlots = startingSlots(rosterPositions);

  const unresolved = new Set<string>();
  const rows: LineupRow[] = [];

  for (const row of matchups) {
    const roster = rostersById.get(row.roster_id);
    const manager = managerInfo(roster, usersById);

    const starterIds = (row.starters ?? []).filter((id) => id !== "0");
    const starterIndexById = new Map<string, number>();
    const starterSlotById = new Map<string, string>();
    (row.starters ?? []).forEach((playerId, index) => {
      if (playerId === "0") return;
      starterIndexById.set(playerId, index);
      starterSlotById.set(playerId, expectedSlots[index] ?? "STARTER_UNKNOWN");
    });

    const playerIds = (row.players ?? []).filter((id) => id !== "0");

    for (const playerId of playerIds) {
      const player = resolvePlayer(playerId, playerIndex);
      if (!player.resolved) unresolved.add(playerId);

      const isStarter = starterIds.includes(playerId);

      rows.push({
        league_selector: leagueSelector,
        league_id: leagueId,
        season,
        week,
        roster_id: row.roster_id,
        user_id: manager.user_id,
        manager_display_name: manager.display_name,
        team_name: manager.team_name,
        player_id: playerId,
        full_name: player.full_name,
        position: player.position,
        is_starter: isStarter,
        roster_slot: isStarter ? (starterSlotById.get(playerId) ?? "STARTER_UNKNOWN") : null,
        starter_index: isStarter ? (starterIndexById.get(playerId) ?? null) : null,
        ownership_status: isStarter ? "starter" : "bench",
        bench: !isStarter,
        // Sleeper does not expose a per-historical-week IR flag (only the
        // *current* /rosters snapshot has `reserve`), so this is honestly
        // null rather than guessed — see module docstring.
        ir: null,
        matchup_id: row.matchup_id,
        resolved: player.resolved,
      });
    }
  }

  rows.sort(
    (a, b) =>
      a.roster_id - b.roster_id ||
      (b.is_starter ? 1 : 0) - (a.is_starter ? 1 : 0) ||
      a.player_id.localeCompare(b.player_id),
  );

  return { rows, unresolvedPlayerIds: [...unresolved].sort() };
}
