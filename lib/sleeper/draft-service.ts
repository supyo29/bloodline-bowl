/**
 * Orchestration for `GET /api/draft`.
 *
 * Fetch freshness is tiered: league/users/rosters change slowly and reuse the
 * normal cache, while the draft object and its picks are fetched with no cache
 * so a live auction is reported within seconds. The player database is never
 * re-downloaded per request — it comes from the module-scoped index in
 * `client.ts`.
 */

import {
  SleeperError,
  getDraft,
  getDraftPicks,
  getLeague,
  getLeagueDrafts,
  getLeagueRosters,
  getLeagueUsers,
  getPlayerIndex,
  slimPlayer,
  type PlayerIndex,
} from "./client";
import { DEFAULT_MINIMUM_BID } from "./budget";
import {
  MIN_PER_REQUIRED_POSITION,
  assembleDraftTeams,
  buildAvailablePlayerPool,
  draftablePositions,
  parsePickPrice,
  selectActiveDraft,
} from "./draft";
import { ELIGIBILITY_RULE_TEXT } from "./eligibility";
import type {
  DraftAcquisition,
  DraftBudgetInfo,
  DraftResponse,
  NormalizedPlayer,
  RawDraft,
  RawDraftPick,
  RawLeagueUser,
  RawRoster,
  ResponseWarning,
} from "./types";

export const DEFAULT_AVAILABLE_LIMIT = 300;
export const MAX_AVAILABLE_LIMIT = 1000;

/** How long the CDN may serve this response, by draft status. */
export const CACHE_SECONDS_BY_STATUS: Record<string, number> = {
  drafting: 5,
  paused: 5,
  pre_draft: 30,
  complete: 300,
};

const DRAFT_STATUS_DESCRIPTIONS: Record<string, string> = {
  pre_draft: "The draft has not started yet.",
  drafting: "The draft is live and in progress.",
  paused: "The draft is paused.",
  complete: "The draft has finished.",
};

export function cacheSecondsForStatus(status: string | undefined): number {
  return CACHE_SECONDS_BY_STATUS[status ?? ""] ?? 30;
}

export interface DraftQuery {
  availableLimit: number;
  position: string | null;
}

/** Validate `?available_limit=` and `?position=` against the league's positions. */
export function parseDraftQuery(
  params: URLSearchParams,
  allowedPositions: ReadonlySet<string>,
): { query: DraftQuery } | { error: string } {
  const rawLimit = params.get("available_limit");
  let availableLimit = DEFAULT_AVAILABLE_LIMIT;

  if (rawLimit !== null) {
    if (!/^\d{1,5}$/.test(rawLimit)) {
      return { error: "available_limit must be a positive integer." };
    }
    const parsed = Number.parseInt(rawLimit, 10);
    if (parsed < 1 || parsed > MAX_AVAILABLE_LIMIT) {
      return {
        error: `available_limit must be between 1 and ${MAX_AVAILABLE_LIMIT}.`,
      };
    }
    availableLimit = parsed;
  }

  const rawPosition = params.get("position");
  let position: string | null = null;
  if (rawPosition !== null && rawPosition !== "") {
    const upper = rawPosition.toUpperCase();
    if (!allowedPositions.has(upper)) {
      return {
        error: `position must be one of: ${[...allowedPositions].sort().join(", ")}`,
      };
    }
    position = upper;
  }

  return { query: { availableLimit, position } };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function optional<T>(
  resource: string,
  code: string,
  warnings: ResponseWarning[],
  fallback: T,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    warnings.push({ code, resource, message: describeError(error) });
    return fallback;
  }
}

function resolvePlayer(
  playerId: string,
  playerIndex: PlayerIndex,
): NormalizedPlayer {
  return playerIndex.get(playerId) ?? slimPlayer(playerId, undefined);
}

function normalizeAcquisition(
  pick: RawDraftPick,
  playerIndex: PlayerIndex,
  usersById: Map<string, RawLeagueUser>,
): DraftAcquisition {
  const rosterId =
    typeof pick.roster_id === "number"
      ? pick.roster_id
      : typeof pick.roster_id === "string" && pick.roster_id.length > 0
        ? Number.parseInt(pick.roster_id, 10)
        : null;

  const user = pick.picked_by ? usersById.get(pick.picked_by) : undefined;

  return {
    pick_no: pick.pick_no,
    round: pick.round,
    draft_slot: pick.draft_slot,
    roster_id: rosterId !== null && Number.isFinite(rosterId) ? rosterId : null,
    manager: {
      user_id: pick.picked_by ?? null,
      display_name: user?.display_name ?? null,
    },
    player: pick.player_id ? resolvePlayer(pick.player_id, playerIndex) : null,
    price: parsePickPrice(pick),
    is_keeper: pick.is_keeper === true,
  };
}

export interface DraftBundle {
  response: DraftResponse;
  cacheSeconds: number;
}

export async function buildDraftBundle(
  leagueId: string,
  query: DraftQuery,
): Promise<DraftBundle> {
  const startedAt = Date.now();
  const warnings: ResponseWarning[] = [];

  // Slow-moving context, served from the normal cache.
  const [league, users, rosters] = await Promise.all([
    getLeague(leagueId),
    getLeagueUsers(leagueId),
    getLeagueRosters(leagueId),
  ]);

  const drafts = await optional<RawDraft[]>(
    `/league/${leagueId}/drafts`,
    "drafts_unavailable",
    warnings,
    [],
    () => getLeagueDrafts(leagueId),
  );

  const selected = selectActiveDraft(Array.isArray(drafts) ? drafts : []);

  // Live data: no cache, so an in-progress auction is current.
  let draft: RawDraft | null = selected;
  let picks: RawDraftPick[] = [];

  if (selected) {
    const [freshDraft, freshPicks] = await Promise.all([
      optional<RawDraft | null>(
        `/draft/${selected.draft_id}`,
        "draft_unavailable",
        warnings,
        selected,
        () => getDraft(selected.draft_id, { noStore: true }),
      ),
      optional<RawDraftPick[]>(
        `/draft/${selected.draft_id}/picks`,
        "draft_picks_unavailable",
        warnings,
        [],
        () => getDraftPicks(selected.draft_id, { noStore: true }),
      ),
    ]);
    draft = freshDraft ?? selected;
    picks = Array.isArray(freshPicks) ? freshPicks : [];
  } else {
    warnings.push({
      code: "no_draft_found",
      resource: `/league/${leagueId}/drafts`,
      message: "This league has no draft associated with it.",
    });
  }

  const playerIndex = await optional<PlayerIndex>(
    "/players/nfl",
    "player_database_unavailable",
    warnings,
    new Map(),
    getPlayerIndex,
  );

  const usersById = new Map(
    (Array.isArray(users) ? users : []).map((user) => [user.user_id, user]),
  );
  const rosterList: RawRoster[] = Array.isArray(rosters) ? rosters : [];
  const rosterPositions = league.roster_positions ?? [];

  const acquisitions = picks
    .map((pick) => normalizeAcquisition(pick, playerIndex, usersById))
    .sort((a, b) => a.pick_no - b.pick_no);

  /* ---------------------------------------------------------------------- */
  /* Budget                                                                  */
  /* ---------------------------------------------------------------------- */

  const isAuction = draft?.type === "auction";
  const startingBudget = draft?.settings?.budget ?? null;
  const budgetSupported =
    isAuction && typeof startingBudget === "number" && startingBudget > 0;

  const picksMissingPrice = acquisitions.filter(
    (pick) => pick.price === null,
  ).length;
  const pricesAvailable =
    acquisitions.length === 0
      ? null
      : acquisitions.some((pick) => pick.price !== null);

  if (budgetSupported && picksMissingPrice > 0) {
    warnings.push({
      code: "missing_auction_prices",
      resource: `/draft/${draft?.draft_id}/picks`,
      message: `Sleeper did not expose an auction price for ${picksMissingPrice} completed pick(s); those are counted as $0 spent and reported with price: null.`,
    });
  }

  const budgetInfo: DraftBudgetInfo = {
    supported: budgetSupported,
    source: budgetSupported ? "sleeper_pick_metadata" : null,
    ...(budgetSupported
      ? {}
      : {
          reason: !draft
            ? "No draft found for this league."
            : !isAuction
              ? `Draft type is "${draft.type}", not an auction, so there is no bidding budget.`
              : "Sleeper did not expose a per-team budget on this draft.",
        }),
    starting_budget_per_team: budgetSupported ? startingBudget : null,
    minimum_bid: DEFAULT_MINIMUM_BID,
    minimum_bid_source: "assumed_default",
    prices_available: budgetSupported ? pricesAvailable : null,
    picks_missing_price: picksMissingPrice,
  };

  /* ---------------------------------------------------------------------- */
  /* Teams                                                                   */
  /* ---------------------------------------------------------------------- */

  const slotByRosterId = new Map<number, number>();
  for (const [slot, rosterId] of Object.entries(
    draft?.slot_to_roster_id ?? {},
  )) {
    if (typeof rosterId === "number") {
      slotByRosterId.set(rosterId, Number.parseInt(slot, 10));
    }
  }

  const acquisitionsByRoster = new Map<number, DraftAcquisition[]>();
  for (const acquisition of acquisitions) {
    if (acquisition.roster_id === null) continue;
    const bucket = acquisitionsByRoster.get(acquisition.roster_id) ?? [];
    bucket.push(acquisition);
    acquisitionsByRoster.set(acquisition.roster_id, bucket);
  }

  // In an auction every team fills the same number of slots.
  const slotsRequired = draft?.settings?.rounds ?? rosterPositions.length ?? 0;

  const teams = assembleDraftTeams({
    rosters: rosterList,
    usersById,
    acquisitionsByRoster,
    slotByRosterId,
    slotsRequired,
    startingBudget: budgetSupported ? (startingBudget as number) : null,
    minimumBid: DEFAULT_MINIMUM_BID,
    rosterPositions,
  });

  /* ---------------------------------------------------------------------- */
  /* Available players                                                       */
  /* ---------------------------------------------------------------------- */

  const takenPlayerIds = new Set<string>();
  for (const acquisition of acquisitions) {
    if (acquisition.player) takenPlayerIds.add(acquisition.player.player_id);
  }
  // Keepers or pre-existing rostered players are unavailable too.
  for (const roster of rosterList) {
    for (const playerId of roster.players ?? []) {
      if (typeof playerId === "string" && playerId !== "0") {
        takenPlayerIds.add(playerId);
      }
    }
  }

  // Full matching pool (no limit, so no coverage pass) for an honest count +
  // the integrity diagnostics (identical regardless of `limit`).
  const fullPool = buildAvailablePlayerPool({
    playerIndex,
    takenPlayerIds,
    rosterPositions,
    position: query.position,
    limit: Number.MAX_SAFE_INTEGER,
  });
  const allMatching = fullPool.players;
  const poolDiagnostics = fullPool.diagnostics;
  const availablePlayers = buildAvailablePlayerPool({
    playerIndex,
    takenPlayerIds,
    rosterPositions,
    position: query.position,
    limit: query.availableLimit,
  }).players;

  /* ---------------------------------------------------------------------- */
  /* Market                                                                  */
  /* ---------------------------------------------------------------------- */

  const biddableTeams = teams.filter((team) => team.budget !== null);
  const remainingBudgets = biddableTeams.map(
    (team) => team.budget?.remaining ?? 0,
  );
  const maxBids = biddableTeams.map(
    (team) => team.budget?.maximum_single_bid ?? 0,
  );

  const topBidders = biddableTeams
    .map((team) => ({
      roster_id: team.roster_id,
      display_name: team.manager.team_name ?? team.manager.display_name,
      maximum_single_bid: team.budget?.maximum_single_bid ?? 0,
      remaining: team.budget?.remaining ?? 0,
      slots_remaining: team.roster.slots_remaining,
    }))
    .sort((a, b) => b.maximum_single_bid - a.maximum_single_bid)
    .slice(0, 5);

  const cacheSeconds = cacheSecondsForStatus(draft?.status);

  const response: DraftResponse = {
    generated_at: new Date().toISOString(),
    source: "Sleeper",
    league_id: leagueId,
    draft: draft
      ? {
          draft_id: draft.draft_id,
          season: draft.season,
          status: draft.status,
          status_description:
            DRAFT_STATUS_DESCRIPTIONS[draft.status] ?? "Unrecognized status.",
          type: draft.type,
          rounds: draft.settings?.rounds ?? 0,
          total_picks: slotsRequired * rosterList.length,
          completed_picks: acquisitions.length,
          remaining_picks: Math.max(
            0,
            slotsRequired * rosterList.length - acquisitions.length,
          ),
          last_picked_at: draft.last_picked
            ? new Date(draft.last_picked).toISOString()
            : null,
          nomination_timer_seconds: draft.settings?.nomination_timer ?? null,
          pick_timer_seconds: draft.settings?.pick_timer ?? null,
        }
      : null,
    budget: budgetInfo,
    last_pick:
      acquisitions.length > 0 ? acquisitions[acquisitions.length - 1]! : null,
    teams,
    picks: acquisitions,
    available_players: availablePlayers,
    market: {
      highest_remaining_budget:
        remainingBudgets.length > 0 ? Math.max(...remainingBudgets) : null,
      lowest_remaining_budget:
        remainingBudgets.length > 0 ? Math.min(...remainingBudgets) : null,
      largest_max_bid: maxBids.length > 0 ? Math.max(...maxBids) : null,
      top_bidders: topBidders,
    },
    metadata: {
      polling_safe: true,
      cache_seconds: cacheSeconds,
      team_count: teams.length,
      available_players: {
        returned: availablePlayers.length,
        total_matching: allMatching.length,
        limit: query.availableLimit,
        position_filter: query.position,
        ordering:
          "Sleeper search_rank ascending; unranked players last. Unfiltered responses guarantee at least " +
          `${MIN_PER_REQUIRED_POSITION} candidates per required starting position, because Sleeper leaves search_rank null on all team defenses.`,
        integrity: {
          eligibility_rule: ELIGIBILITY_RULE_TEXT,
          player_pool_total: poolDiagnostics.player_pool_total,
          eligible_player_count: poolDiagnostics.eligible_player_count,
          excluded_player_count: poolDiagnostics.excluded_player_count,
          already_drafted_count: poolDiagnostics.already_drafted_count,
          stale_or_invalid_player_count:
            poolDiagnostics.stale_or_invalid_player_count,
          excluded_by_reason: poolDiagnostics.excluded_by_reason,
        },
      },
      player_database_size: playerIndex.size,
      warnings,
      build_ms: Date.now() - startedAt,
    },
  };

  return { response, cacheSeconds };
}

/** Positions this league can draft, used to validate `?position=`. */
export async function getAllowedPositions(
  leagueId: string,
): Promise<Set<string>> {
  const league = await getLeague(leagueId);
  return draftablePositions(league.roster_positions ?? []);
}

export { SleeperError };
