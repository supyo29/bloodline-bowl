/**
 * Normalizes Sleeper transactions (trades, waivers, free-agent moves, drops,
 * commissioner actions) into a consistent shape with players and picks
 * resolved. No evaluation of trade fairness — only what moved and between whom.
 */

import { slimPlayer, type PlayerIndex } from "@/lib/sleeper/client";
import type { ManagerRef } from "./types";
import type { RawLeagueUser, RawRoster, RawTransaction } from "@/lib/sleeper/types";
import type { NormalizedPlayer } from "@/lib/sleeper/types";

export interface TransactionPlayerMove {
  roster_id: number;
  player: NormalizedPlayer;
}

export interface TransactionDraftPickMove {
  season: string;
  round: number;
  original_roster_id: number;
  previous_owner_roster_id: number;
  new_owner_roster_id: number;
}

export interface TransactionSide {
  roster_id: number;
  manager: ManagerRef;
  received_players: NormalizedPlayer[];
  received_picks: TransactionDraftPickMove[];
  received_faab: number;
}

export interface TransactionFact {
  transaction_id: string;
  season: string;
  week: number | null;
  type: string;
  status: string;
  created_at: string | null;

  rosters_involved: number[];
  adds: TransactionPlayerMove[];
  drops: TransactionPlayerMove[];
  faab: { spent: number | null };
  draft_picks: TransactionDraftPickMove[];

  /** Populated for trades: each participating roster's side of the deal. */
  sides: TransactionSide[] | null;
}

function managerRef(
  rosterId: number,
  rostersById: Map<number, RawRoster>,
  usersById: Map<string, RawLeagueUser>,
): ManagerRef {
  const roster = rostersById.get(rosterId);
  const user = roster?.owner_id ? usersById.get(roster.owner_id) : undefined;
  return {
    user_id: roster?.owner_id ?? null,
    display_name: user?.display_name ?? null,
    team_name: (user?.metadata?.team_name as string | undefined) ?? null,
  };
}

function resolvePlayer(playerId: string, playerIndex: PlayerIndex): NormalizedPlayer {
  return playerIndex.get(playerId) ?? slimPlayer(playerId, undefined);
}

/** Build a trade's per-side breakdown: what each roster received. */
function buildTradeSides(
  transaction: RawTransaction,
  playerIndex: PlayerIndex,
  rostersById: Map<number, RawRoster>,
  usersById: Map<string, RawLeagueUser>,
): TransactionSide[] {
  const sides = new Map<number, TransactionSide>();
  for (const rosterId of transaction.roster_ids) {
    sides.set(rosterId, {
      roster_id: rosterId,
      manager: managerRef(rosterId, rostersById, usersById),
      received_players: [],
      received_picks: [],
      received_faab: 0,
    });
  }

  for (const [playerId, rosterId] of Object.entries(transaction.adds ?? {})) {
    sides.get(rosterId)?.received_players.push(resolvePlayer(playerId, playerIndex));
  }
  for (const pick of transaction.draft_picks ?? []) {
    sides.get(pick.owner_id)?.received_picks.push({
      season: pick.season,
      round: pick.round,
      original_roster_id: pick.roster_id,
      previous_owner_roster_id: pick.previous_owner_id,
      new_owner_roster_id: pick.owner_id,
    });
  }
  for (const budget of transaction.waiver_budget ?? []) {
    const receiver = sides.get(budget.receiver);
    if (receiver) receiver.received_faab += budget.amount;
  }

  return [...sides.values()].sort((a, b) => a.roster_id - b.roster_id);
}

export function normalizeTransaction(
  transaction: RawTransaction,
  season: string,
  playerIndex: PlayerIndex,
  rostersById: Map<number, RawRoster>,
  usersById: Map<string, RawLeagueUser>,
): TransactionFact {
  const adds: TransactionPlayerMove[] = Object.entries(transaction.adds ?? {}).map(
    ([playerId, rosterId]) => ({
      roster_id: rosterId,
      player: resolvePlayer(playerId, playerIndex),
    }),
  );
  const drops: TransactionPlayerMove[] = Object.entries(transaction.drops ?? {}).map(
    ([playerId, rosterId]) => ({
      roster_id: rosterId,
      player: resolvePlayer(playerId, playerIndex),
    }),
  );
  const draftPicks: TransactionDraftPickMove[] = (transaction.draft_picks ?? []).map(
    (pick) => ({
      season: pick.season,
      round: pick.round,
      original_roster_id: pick.roster_id,
      previous_owner_roster_id: pick.previous_owner_id,
      new_owner_roster_id: pick.owner_id,
    }),
  );

  // A waiver claim's own bid amount lives in `settings.waiver_bid`, distinct
  // from `waiver_budget`, which records FAAB moved as part of a trade.
  const waiverBid =
    typeof transaction.settings?.waiver_bid === "number"
      ? transaction.settings.waiver_bid
      : null;

  return {
    transaction_id: transaction.transaction_id,
    season,
    week: transaction.leg,
    type: transaction.type,
    status: transaction.status,
    created_at: transaction.created ? new Date(transaction.created).toISOString() : null,
    rosters_involved: transaction.roster_ids,
    adds,
    drops,
    faab: { spent: waiverBid },
    draft_picks: draftPicks,
    sides:
      transaction.type === "trade"
        ? buildTradeSides(transaction, playerIndex, rostersById, usersById)
        : null,
  };
}
