/**
 * Trade validation — a proposal is rejected explicitly, never silently
 * corrected. Every failure carries a stable machine code.
 *
 * Checks (in order):
 *   - at least 2 distinct, known participants, each with a team
 *   - at least one transfer
 *   - every transfer endpoint is in the participant set
 *   - sender != receiver
 *   - every transferred player resolves to a known canonical player
 *   - no player transferred more than once
 *   - every transferred player is owned by the sending team pre-trade
 *   - post-trade: no player on two rosters, size within league limit,
 *     a legal starting lineup can still be fielded
 */

import type { CanonicalRoster } from "@/lib/canonical/schema";
import type { RosterConstraints } from "@/lib/weekly/schema";
import { maxSlotMatching } from "@/lib/weekly/slots";
import type {
  NormalizedProposal,
  TradeValidationFailure,
  TradeValidationResult,
} from "./schema";
import { reconstructRosters } from "./reconstruct";

export interface ResolvedParticipant {
  input_id: string;
  canonical_manager_id: string | null;
  manager_slug: string | null;
  canonical_team_id: string | null;
}

export interface TradeResolution {
  league_slug: string;
  participants: ResolvedParticipant[];
  transfers: Array<{
    from_input: string;
    to_input: string;
    from_manager_id: string | null;
    to_manager_id: string | null;
    input_player_id: string;
    canonical_player_id: string | null;
  }>;
  /** canonical_player_id -> owning canonical_team_id (pre-trade, whole league) */
  ownership: Map<string, string>;
  /** canonical_manager_id -> pre-trade roster */
  roster_by_manager: Map<string, CanonicalRoster>;
  constraints: RosterConstraints;
  /** canonical_player_id -> [position, ...eligible_positions] for the structural check */
  player_positions?: Map<string, string[]>;
}

export function validateTrade(res: TradeResolution): {
  result: TradeValidationResult;
  normalized: NormalizedProposal | null;
} {
  const failures: TradeValidationFailure[] = [];
  const fail = (code: TradeValidationFailure["code"], message: string, subject?: string): void => {
    failures.push({ code, message, subject });
  };

  // ---- participants
  if (res.participants.length === 0) fail("NO_PARTICIPANTS", "A trade needs participants.");
  else if (res.participants.length < 2)
    fail("TOO_FEW_PARTICIPANTS", "A trade needs at least two participants.");

  const seenParticipant = new Set<string>();
  for (const p of res.participants) {
    if (!p.canonical_manager_id) {
      fail("UNKNOWN_MANAGER", `Manager "${p.input_id}" is not in league "${res.league_slug}".`, p.input_id);
      continue;
    }
    if (seenParticipant.has(p.canonical_manager_id)) {
      fail("DUPLICATE_PARTICIPANT", `Manager "${p.input_id}" appears twice in the participant set.`, p.input_id);
    }
    seenParticipant.add(p.canonical_manager_id);
    if (!p.canonical_team_id) {
      fail("MANAGER_HAS_NO_TEAM", `Manager "${p.input_id}" owns no team in "${res.league_slug}".`, p.input_id);
    }
  }

  const participantManagerIds = res.participants
    .map((p) => p.canonical_manager_id)
    .filter((x): x is string => Boolean(x));
  const participantSet = new Set(participantManagerIds);
  const teamOfManager = new Map(
    res.participants
      .filter((p) => p.canonical_manager_id && p.canonical_team_id)
      .map((p) => [p.canonical_manager_id!, p.canonical_team_id!]),
  );

  // ---- transfers
  if (res.transfers.length === 0) fail("NO_TRANSFERS", "A trade needs at least one player transfer.");

  const transferKey = new Set<string>();
  const movedPlayers = new Set<string>();
  for (const t of res.transfers) {
    if (!t.from_manager_id || !participantSet.has(t.from_manager_id)) {
      fail("INVALID_PARTICIPANT", `Transfer sender "${t.from_input}" is not in the participant set.`, t.from_input);
    }
    if (!t.to_manager_id || !participantSet.has(t.to_manager_id)) {
      fail("INVALID_PARTICIPANT", `Transfer receiver "${t.to_input}" is not in the participant set.`, t.to_input);
    }
    if (t.from_manager_id && t.to_manager_id && t.from_manager_id === t.to_manager_id) {
      fail("SELF_TRANSFER", `A player cannot be transferred from a manager to themselves ("${t.from_input}").`, t.from_input);
    }
    if (!t.canonical_player_id) {
      fail("UNKNOWN_PLAYER", `Player "${t.input_player_id}" could not be resolved to a known player.`, t.input_player_id);
      continue;
    }
    const key = `${t.canonical_player_id}`;
    if (movedPlayers.has(key)) {
      fail("DUPLICATE_TRANSFER", `Player "${t.input_player_id}" is transferred more than once.`, t.input_player_id);
    }
    movedPlayers.add(key);
    const dedupe = `${t.from_manager_id}|${t.to_manager_id}|${t.canonical_player_id}`;
    if (transferKey.has(dedupe)) {
      fail("DUPLICATE_TRANSFER", `Identical transfer of "${t.input_player_id}" listed twice.`, t.input_player_id);
    }
    transferKey.add(dedupe);

    // ownership pre-trade
    const owner = res.ownership.get(t.canonical_player_id) ?? null;
    const senderTeam = t.from_manager_id ? teamOfManager.get(t.from_manager_id) ?? null : null;
    if (senderTeam && owner !== senderTeam) {
      fail(
        "PLAYER_NOT_OWNED_BY_SENDER",
        `Player "${t.input_player_id}" is not on ${t.from_input}'s roster before the trade` +
          (owner ? ` (owned by team ${owner}).` : " (not rostered in this league)."),
        t.input_player_id,
      );
    }
  }

  if (failures.length > 0) return { result: { ok: false, failures }, normalized: null };

  // ---- everything resolved: build the normalized proposal and run post-trade checks
  const normalized: NormalizedProposal = {
    league_slug: res.league_slug,
    participant_manager_ids: participantManagerIds,
    transfers: res.transfers.map((t) => ({
      from_manager_id: t.from_manager_id!,
      to_manager_id: t.to_manager_id!,
      canonical_player_id: t.canonical_player_id!,
      input_player_id: t.input_player_id,
    })),
  };

  const recon = reconstructRosters(normalized, res.roster_by_manager);

  // no player on two post-trade rosters
  const postOwners = new Map<string, string[]>();
  for (const mid of normalized.participant_manager_ids) {
    for (const id of recon.by_manager.get(mid)!.after.all_players) {
      postOwners.set(id, [...(postOwners.get(id) ?? []), mid]);
    }
  }
  for (const [pid, owners] of postOwners) {
    if (owners.length > 1) {
      fail(
        "PLAYER_ON_MULTIPLE_POST_TRADE_ROSTERS",
        `Player ${pid} would be on ${owners.length} rosters after the trade.`,
        pid,
      );
    }
  }

  // size limit + structural legality per participant
  const limit = res.constraints.roster_size_limit;
  const startLabels = res.constraints.starting_slots;
  for (const mid of normalized.participant_manager_ids) {
    const after = recon.by_manager.get(mid)!.after;
    const slug = res.participants.find((p) => p.canonical_manager_id === mid)?.input_id ?? mid;
    if (limit != null && after.all_players.length > limit) {
      fail(
        "POST_TRADE_ROSTER_OVER_SIZE_LIMIT",
        `${slug}'s roster would hold ${after.all_players.length} players, over the league limit of ${limit}. ` +
          `Include the drop(s) in the proposal.`,
        slug,
      );
    }
    // structural fieldability uses ACTIVE players only (IR/taxi cannot start)
    const reserve = new Set([...after.ir, ...after.taxi]);
    const activeIds = after.all_players.filter((id) => !reserve.has(id));
    const cands = activeIds.map((id) => ({ id, positions: positionHintFor(id, res) }));
    const { unfilled } = maxSlotMatching(startLabels, cands);
    if (unfilled.length > 0) {
      const unfilledLabels = unfilled.map((i) => startLabels[i]).join(", ");
      fail(
        "POST_TRADE_ROSTER_ILLEGAL",
        `${slug}'s post-trade roster cannot field a legal starting lineup — unfilled: ${unfilledLabels}.`,
        slug,
      );
    }
  }

  if (failures.length > 0) return { result: { ok: false, failures }, normalized: null };
  return { result: { ok: true, failures: [] }, normalized };
}

/**
 * Best-effort position eligibility for the structural check. The full
 * `CanonicalPlayer` (with `eligible_positions`) is threaded via `res` when the
 * caller populates `player_positions`; absent that we fall back to a single
 * position so the matcher still runs.
 */
function positionHintFor(playerId: string, res: TradeResolution): string[] {
  return res.player_positions?.get(playerId) ?? ["UNKNOWN"];
}
