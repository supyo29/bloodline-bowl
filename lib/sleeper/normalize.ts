/**
 * Normalization: turns raw Sleeper payloads into one analysis-friendly document.
 *
 * These functions are deliberately pure and free of HTTP concerns so the route
 * handler stays thin and this logic stays testable.
 */

import { slimPlayer, type PlayerIndex } from "./client";
import type {
  LeagueResponse,
  NormalizedDraft,
  NormalizedDraftPick,
  NormalizedDraftPickAsset,
  NormalizedManager,
  NormalizedPlayer,
  NormalizedRecord,
  NormalizedStarterSlot,
  NormalizedTeam,
  NormalizedTeamSummary,
  NormalizedTradedPick,
  RawDraft,
  RawDraftPick,
  RawLeague,
  RawLeagueUser,
  RawNflState,
  RawRoster,
  RawRosterSettings,
  RawTradedPick,
  ResponseWarning,
} from "./types";

/** Sleeper writes `"0"` into `starters` for a lineup slot nobody occupies. */
const EMPTY_STARTER_SENTINEL = "0";

/** Roster positions that are not part of the starting lineup. */
const NON_STARTING_SLOTS = new Set(["BN", "TAXI", "IR"]);

const LEAGUE_STATUS_DESCRIPTIONS: Record<string, string> = {
  pre_draft: "League has been created but the draft has not started yet.",
  drafting: "The draft is currently in progress.",
  in_season: "The regular season is underway.",
  post_season: "The league is in its playoff bracket.",
  complete: "The season has finished.",
};

/* -------------------------------------------------------------------------- */
/* Small helpers                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Sleeper splits fantasy points into an integer part and a decimal part
 * (`fpts: 102`, `fpts_decimal: 45` -> 102.45).
 */
function combinePoints(
  whole: number | undefined,
  decimal: number | undefined,
): number {
  const base = typeof whole === "number" && Number.isFinite(whole) ? whole : 0;
  const fraction =
    typeof decimal === "number" && Number.isFinite(decimal) ? decimal : 0;
  return Math.round((base + fraction / 100) * 100) / 100;
}

function numberOrNull(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Drop `"0"` sentinels and any non-string junk from a Sleeper id array. */
function cleanPlayerIds(ids: string[] | null | undefined): string[] {
  if (!Array.isArray(ids)) return [];
  return ids.filter(
    (id): id is string =>
      typeof id === "string" && id.length > 0 && id !== EMPTY_STARTER_SENTINEL,
  );
}

/* -------------------------------------------------------------------------- */
/* Players                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Resolve one player id against the index, recording ids Sleeper's database
 * does not know about so the caller can surface them in metadata.
 */
function resolvePlayer(
  playerId: string,
  playerIndex: PlayerIndex,
  unresolved: Set<string>,
): NormalizedPlayer {
  const player = playerIndex.get(playerId);
  if (player) return player;
  unresolved.add(playerId);
  return slimPlayer(playerId, undefined);
}

function resolvePlayers(
  playerIds: string[],
  playerIndex: PlayerIndex,
  unresolved: Set<string>,
): NormalizedPlayer[] {
  return playerIds.map((id) => resolvePlayer(id, playerIndex, unresolved));
}

/* -------------------------------------------------------------------------- */
/* Managers and records                                                        */
/* -------------------------------------------------------------------------- */

export function normalizeManager(
  roster: RawRoster,
  usersById: Map<string, RawLeagueUser>,
): NormalizedManager {
  const ownerId = roster.owner_id;
  const user = ownerId ? usersById.get(ownerId) : undefined;

  // A roster with no owner_id is an open seat in the league.
  if (!ownerId) {
    return {
      user_id: null,
      display_name: null,
      team_name: null,
      avatar: null,
      is_owner: false,
      is_bot: false,
      is_vacant: true,
      co_owner_user_ids: roster.co_owners ?? [],
    };
  }

  // An owner_id that is missing from /users means the manager left the league.
  if (!user) {
    return {
      user_id: ownerId,
      display_name: null,
      team_name: null,
      avatar: null,
      is_owner: false,
      is_bot: false,
      is_vacant: false,
      co_owner_user_ids: roster.co_owners ?? [],
    };
  }

  const teamName =
    (user.metadata?.team_name as string | undefined) ??
    (roster.metadata?.team_name as string | undefined) ??
    null;

  return {
    user_id: user.user_id,
    display_name: user.display_name ?? null,
    team_name: teamName,
    avatar: user.avatar ?? null,
    is_owner: user.is_owner === true,
    is_bot: user.is_bot === true,
    is_vacant: false,
    co_owner_user_ids: roster.co_owners ?? [],
  };
}

export function normalizeRecord(
  settings: RawRosterSettings | null,
): NormalizedRecord {
  const source = settings ?? {};
  return {
    wins: source.wins ?? 0,
    losses: source.losses ?? 0,
    ties: source.ties ?? 0,
    points_for: combinePoints(source.fpts, source.fpts_decimal),
    points_against: combinePoints(
      source.fpts_against,
      source.fpts_against_decimal,
    ),
    waiver_position: numberOrNull(source.waiver_position),
    waiver_budget_used: numberOrNull(source.waiver_budget_used),
    total_moves: numberOrNull(source.total_moves),
    division: numberOrNull(source.division),
  };
}

/* -------------------------------------------------------------------------- */
/* Starting lineup                                                             */
/* -------------------------------------------------------------------------- */

/** The ordered starting slots, with bench/taxi/IR removed. */
export function startingSlots(rosterPositions: string[]): string[] {
  return rosterPositions.filter(
    (position) => !NON_STARTING_SLOTS.has(position),
  );
}

/**
 * Pair each entry of the roster's `starters` array with the lineup slot it fills.
 * Sleeper keeps `starters` positionally aligned with the non-bench entries of
 * `roster_positions`, so index `i` of one lines up with index `i` of the other.
 */
export function normalizeStarters(
  starters: string[] | null,
  rosterPositions: string[],
  playerIndex: PlayerIndex,
  unresolved: Set<string>,
): NormalizedStarterSlot[] {
  const slots = startingSlots(rosterPositions);
  const rawStarters = Array.isArray(starters) ? starters : [];
  // Trust whichever list is longer so an unexpected mismatch loses no data.
  const length = Math.max(slots.length, rawStarters.length);

  const result: NormalizedStarterSlot[] = [];
  for (let index = 0; index < length; index += 1) {
    const playerId = rawStarters[index];
    const isEmpty =
      typeof playerId !== "string" ||
      playerId.length === 0 ||
      playerId === EMPTY_STARTER_SENTINEL;

    result.push({
      slot: index + 1,
      roster_position: slots[index] ?? null,
      player: isEmpty
        ? null
        : resolvePlayer(playerId as string, playerIndex, unresolved),
      is_empty: isEmpty,
    });
  }
  return result;
}

/** Count how many of each slot type the starting lineup requires. */
export function positionRequirements(
  rosterPositions: string[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const position of startingSlots(rosterPositions)) {
    counts[position] = (counts[position] ?? 0) + 1;
  }
  return counts;
}

function countRosterPosition(
  rosterPositions: string[],
  target: string,
): number {
  return rosterPositions.filter((position) => position === target).length;
}

/* -------------------------------------------------------------------------- */
/* Draft capital                                                               */
/* -------------------------------------------------------------------------- */

/** Pick inventory keyed by current owner, plus per-roster traded-away counts. */
export interface DraftCapital {
  byOwner: Map<number, NormalizedDraftPickAsset[]>;
  tradedAwayByRoster: Map<number, number>;
}

function tradedPickKey(
  season: string,
  round: number,
  originalRosterId: number,
): string {
  return `${season}|${round}|${originalRosterId}`;
}

/**
 * Build every roster's current draft-pick inventory.
 *
 * Sleeper's `/traded_picks` only returns picks that have *changed hands*; picks
 * still held by their original owner are never listed. To answer "what draft
 * capital does each team control", the full inventory is therefore synthesized
 * (every roster starts owning its own pick in every round) and then the traded
 * picks are applied on top.
 *
 * Seasons whose draft has already completed are excluded — those picks are
 * spent, and counting them as assets would misrepresent a team's capital.
 */
export function buildDraftCapital(
  rosters: RawRoster[],
  drafts: RawDraft[],
  tradedPicks: RawTradedPick[],
  league: RawLeague,
  nflState: RawNflState | null,
): DraftCapital {
  const rosterIds = rosters
    .map((roster) => roster.roster_id)
    .sort((a, b) => a - b);
  const byOwner = new Map<number, NormalizedDraftPickAsset[]>();
  const tradedAwayByRoster = new Map<number, number>();
  for (const rosterId of rosterIds) {
    byOwner.set(rosterId, []);
    tradedAwayByRoster.set(rosterId, 0);
  }

  if (rosterIds.length === 0) return { byOwner, tradedAwayByRoster };

  const completedDraftSeasons = new Set(
    drafts.filter((draft) => draft.status === "complete").map((d) => d.season),
  );

  // Rounds per season, most authoritative source first.
  const roundsBySeason = new Map<
    string,
    { rounds: number; source: NormalizedDraftPickAsset["rounds_source"] }
  >();

  for (const draft of drafts) {
    const rounds = draft.settings?.rounds;
    if (typeof rounds === "number" && rounds > 0) {
      roundsBySeason.set(draft.season, { rounds, source: "draft" });
    }
  }

  const maxTradedRoundBySeason = new Map<string, number>();
  for (const pick of tradedPicks) {
    const current = maxTradedRoundBySeason.get(pick.season) ?? 0;
    if (pick.round > current) {
      maxTradedRoundBySeason.set(pick.season, pick.round);
    }
  }

  const leagueDraftRounds = league.settings?.draft_rounds;
  const candidateSeasons = new Set<string>([
    ...drafts.map((draft) => draft.season),
    ...tradedPicks.map((pick) => pick.season),
  ]);
  // The upcoming season always matters, even before its draft object exists.
  if (nflState?.season) candidateSeasons.add(nflState.season);
  if (league.season) candidateSeasons.add(league.season);

  for (const season of candidateSeasons) {
    if (roundsBySeason.has(season)) continue;

    const tradedMax = maxTradedRoundBySeason.get(season);
    if (typeof leagueDraftRounds === "number" && leagueDraftRounds > 0) {
      roundsBySeason.set(season, {
        rounds: Math.max(leagueDraftRounds, tradedMax ?? 0),
        source: "league_settings",
      });
    } else if (tradedMax) {
      roundsBySeason.set(season, { rounds: tradedMax, source: "traded_picks" });
    }
  }

  const tradedByKey = new Map<string, RawTradedPick>();
  for (const pick of tradedPicks) {
    tradedByKey.set(
      tradedPickKey(pick.season, pick.round, pick.roster_id),
      pick,
    );
  }

  const seasons = [...roundsBySeason.keys()].sort();
  for (const season of seasons) {
    if (completedDraftSeasons.has(season)) continue;

    const config = roundsBySeason.get(season);
    if (!config) continue;

    for (let round = 1; round <= config.rounds; round += 1) {
      for (const originalRosterId of rosterIds) {
        const traded = tradedByKey.get(
          tradedPickKey(season, round, originalRosterId),
        );
        const currentOwner = traded ? traded.owner_id : originalRosterId;

        const asset: NormalizedDraftPickAsset = {
          season,
          round,
          original_roster_id: originalRosterId,
          current_owner_roster_id: currentOwner,
          previous_owner_roster_id: traded?.previous_owner_id ?? null,
          is_traded: Boolean(traded),
          is_acquired: currentOwner !== originalRosterId,
          rounds_source: config.source,
        };

        // A pick can be traded to a roster id that no longer exists; keep it
        // discoverable by filing it under the original owner in that case.
        const bucket =
          byOwner.get(currentOwner) ?? byOwner.get(originalRosterId);
        bucket?.push(asset);

        // Counted here so it shares the season scope used above: a pick from an
        // already-drafted season is spent, not an asset anyone gave up.
        if (asset.is_acquired) {
          tradedAwayByRoster.set(
            originalRosterId,
            (tradedAwayByRoster.get(originalRosterId) ?? 0) + 1,
          );
        }
      }
    }
  }

  for (const picks of byOwner.values()) {
    picks.sort(
      (a, b) =>
        a.season.localeCompare(b.season) ||
        a.round - b.round ||
        a.original_roster_id - b.original_roster_id,
    );
  }

  return { byOwner, tradedAwayByRoster };
}

/* -------------------------------------------------------------------------- */
/* Teams                                                                       */
/* -------------------------------------------------------------------------- */

function buildTeamSummary(
  players: NormalizedPlayer[],
  starters: NormalizedStarterSlot[],
  bench: NormalizedPlayer[],
  taxi: NormalizedPlayer[],
  reserve: NormalizedPlayer[],
  draftPicks: NormalizedDraftPickAsset[],
  picksTradedAway: number,
): NormalizedTeamSummary {
  const positionCounts: Record<string, number> = {};
  for (const player of players) {
    const position = player.position ?? "UNKNOWN";
    positionCounts[position] = (positionCounts[position] ?? 0) + 1;
  }

  return {
    position_counts: positionCounts,
    player_count: players.length,
    starter_count: starters.filter((slot) => !slot.is_empty).length,
    empty_starter_slots: starters.filter((slot) => slot.is_empty).length,
    bench_count: bench.length,
    taxi_count: taxi.length,
    reserve_count: reserve.length,
    own_picks_held: draftPicks.filter((pick) => !pick.is_acquired).length,
    picks_acquired: draftPicks.filter((pick) => pick.is_acquired).length,
    picks_traded_away: picksTradedAway,
    total_picks_held: draftPicks.length,
  };
}

export function normalizeTeam(
  roster: RawRoster,
  usersById: Map<string, RawLeagueUser>,
  rosterPositions: string[],
  playerIndex: PlayerIndex,
  draftCapital: DraftCapital,
  unresolved: Set<string>,
): NormalizedTeam {
  const playerIds = cleanPlayerIds(roster.players);
  const starterIds = cleanPlayerIds(roster.starters);
  const taxiIds = cleanPlayerIds(roster.taxi);
  const reserveIds = cleanPlayerIds(roster.reserve);
  const keeperIds = cleanPlayerIds(roster.keepers);

  const players = resolvePlayers(playerIds, playerIndex, unresolved);
  const starters = normalizeStarters(
    roster.starters,
    rosterPositions,
    playerIndex,
    unresolved,
  );

  // Bench = rostered players not starting, not on taxi, not on IR.
  const nonBenchIds = new Set([...starterIds, ...taxiIds, ...reserveIds]);
  const bench = players.filter((player) => !nonBenchIds.has(player.player_id));

  const taxi = resolvePlayers(taxiIds, playerIndex, unresolved);
  const reserve = resolvePlayers(reserveIds, playerIndex, unresolved);
  const keepers = resolvePlayers(keeperIds, playerIndex, unresolved);
  const picks = draftCapital.byOwner.get(roster.roster_id) ?? [];

  return {
    roster_id: roster.roster_id,
    manager: normalizeManager(roster, usersById),
    record: normalizeRecord(roster.settings),
    players,
    starters,
    bench,
    taxi,
    reserve,
    keepers,
    draft_picks: picks,
    summary: buildTeamSummary(
      players,
      starters,
      bench,
      taxi,
      reserve,
      picks,
      draftCapital.tradedAwayByRoster.get(roster.roster_id) ?? 0,
    ),
  };
}

/* -------------------------------------------------------------------------- */
/* Drafts                                                                      */
/* -------------------------------------------------------------------------- */

function parseAuctionAmount(
  metadata: Record<string, string> | null,
): number | null {
  const amount = metadata?.amount;
  if (typeof amount !== "string") return null;
  const parsed = Number.parseInt(amount, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

export function normalizeDraftPick(
  pick: RawDraftPick,
  playerIndex: PlayerIndex,
  usersById: Map<string, RawLeagueUser>,
  unresolved: Set<string>,
): NormalizedDraftPick {
  // `roster_id` arrives as a string on this endpoint but as a number elsewhere.
  const rosterId =
    typeof pick.roster_id === "number"
      ? pick.roster_id
      : typeof pick.roster_id === "string" && pick.roster_id.length > 0
        ? Number.parseInt(pick.roster_id, 10)
        : null;

  const pickedByUser = pick.picked_by
    ? usersById.get(pick.picked_by)
    : undefined;

  return {
    pick_no: pick.pick_no,
    round: pick.round,
    draft_slot: pick.draft_slot,
    roster_id: rosterId !== null && Number.isFinite(rosterId) ? rosterId : null,
    picked_by: {
      user_id: pick.picked_by ?? null,
      display_name: pickedByUser?.display_name ?? null,
    },
    is_keeper: pick.is_keeper === true,
    auction_amount: parseAuctionAmount(pick.metadata),
    player: pick.player_id
      ? resolvePlayer(pick.player_id, playerIndex, unresolved)
      : null,
  };
}

export function normalizeDraft(
  draft: RawDraft,
  picks: RawDraftPick[],
  playerIndex: PlayerIndex,
  usersById: Map<string, RawLeagueUser>,
  unresolved: Set<string>,
): NormalizedDraft {
  const slotToRoster = draft.slot_to_roster_id ?? {};
  const rosterToSlotUser = new Map<number, string>();
  for (const [userId, slot] of Object.entries(draft.draft_order ?? {})) {
    rosterToSlotUser.set(slot, userId);
  }

  const draftOrder = Object.entries(slotToRoster)
    .map(([slot, rosterId]) => {
      const draftSlot = Number.parseInt(slot, 10);
      const userId = rosterToSlotUser.get(draftSlot) ?? null;
      return {
        draft_slot: draftSlot,
        roster_id: typeof rosterId === "number" ? rosterId : null,
        user_id: userId,
        display_name: userId
          ? (usersById.get(userId)?.display_name ?? null)
          : null,
      };
    })
    .sort((a, b) => a.draft_slot - b.draft_slot);

  const normalizedPicks = picks
    .map((pick) => normalizeDraftPick(pick, playerIndex, usersById, unresolved))
    .sort((a, b) => a.pick_no - b.pick_no);

  return {
    draft_id: draft.draft_id,
    season: draft.season,
    season_type: draft.season_type,
    status: draft.status,
    type: draft.type,
    rounds: draft.settings?.rounds ?? 0,
    start_time: draft.start_time
      ? new Date(draft.start_time).toISOString()
      : null,
    created_at: draft.created ? new Date(draft.created).toISOString() : null,
    settings: draft.settings ?? {},
    metadata: draft.metadata ?? {},
    draft_order: draftOrder,
    pick_count: normalizedPicks.length,
    picks: normalizedPicks,
  };
}

/* -------------------------------------------------------------------------- */
/* Traded picks                                                                */
/* -------------------------------------------------------------------------- */

export function normalizeTradedPicks(
  tradedPicks: RawTradedPick[],
  displayNameByRosterId: Map<number, string | null>,
): NormalizedTradedPick[] {
  return tradedPicks
    .map((pick) => ({
      season: pick.season,
      round: pick.round,
      original_roster_id: pick.roster_id,
      original_owner_display_name:
        displayNameByRosterId.get(pick.roster_id) ?? null,
      previous_owner_roster_id: pick.previous_owner_id ?? null,
      previous_owner_display_name:
        pick.previous_owner_id !== null && pick.previous_owner_id !== undefined
          ? (displayNameByRosterId.get(pick.previous_owner_id) ?? null)
          : null,
      current_owner_roster_id: pick.owner_id,
      current_owner_display_name:
        displayNameByRosterId.get(pick.owner_id) ?? null,
    }))
    .sort(
      (a, b) =>
        a.season.localeCompare(b.season) ||
        a.round - b.round ||
        a.original_roster_id - b.original_roster_id,
    );
}

/* -------------------------------------------------------------------------- */
/* Settings gloss                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Surface the settings that actually matter for roster analysis, using readable
 * names. The complete raw `settings` object is preserved alongside this.
 */
function buildKeySettings(
  league: RawLeague,
): Record<string, string | number | boolean> {
  const settings = league.settings ?? {};
  const scoring = league.scoring_settings ?? {};

  const waiverTypeLabels: Record<number, string> = {
    0: "rolling_waivers",
    1: "reverse_standings",
    2: "faab",
  };

  const receptionPoints = scoring.rec ?? 0;
  const pprLabel =
    receptionPoints === 0
      ? "standard"
      : receptionPoints === 0.5
        ? "half_ppr"
        : receptionPoints === 1
          ? "full_ppr"
          : `custom_${receptionPoints}_ppr`;

  const startingQbs = countRosterPosition(league.roster_positions ?? [], "QB");
  const hasSuperflex = (league.roster_positions ?? []).includes("SUPER_FLEX");

  return {
    scoring_format: pprLabel,
    points_per_reception: receptionPoints,
    passing_td_points: scoring.pass_td ?? 0,
    is_superflex_or_2qb: hasSuperflex || startingQbs > 1,
    starting_qb_slots: startingQbs,
    teams: settings.num_teams ?? league.total_rosters,
    playoff_teams: settings.playoff_teams ?? 0,
    playoff_week_start: settings.playoff_week_start ?? 0,
    trade_deadline_week: settings.trade_deadline ?? 0,
    waiver_type: waiverTypeLabels[settings.waiver_type ?? -1] ?? "unknown",
    waiver_budget: settings.waiver_budget ?? 0,
    max_keepers: settings.max_keepers ?? 0,
    taxi_slots: settings.taxi_slots ?? 0,
    reserve_slots: settings.reserve_slots ?? 0,
    pick_trading_enabled: (settings.pick_trading ?? 0) === 1,
    trades_enabled: (settings.disable_trades ?? 0) === 0,
  };
}

/* -------------------------------------------------------------------------- */
/* Top-level assembly                                                          */
/* -------------------------------------------------------------------------- */

export interface BuildLeagueResponseInput {
  leagueId: string;
  league: RawLeague;
  users: RawLeagueUser[];
  rosters: RawRoster[];
  drafts: RawDraft[];
  draftPicksByDraftId: Map<string, RawDraftPick[]>;
  tradedPicks: RawTradedPick[];
  nflState: RawNflState | null;
  playerIndex: PlayerIndex;
  warnings: ResponseWarning[];
  startedAt: number;
}

export function buildLeagueResponse(
  input: BuildLeagueResponseInput,
): LeagueResponse {
  const {
    leagueId,
    league,
    users,
    rosters,
    drafts,
    draftPicksByDraftId,
    tradedPicks,
    nflState,
    playerIndex,
    warnings,
    startedAt,
  } = input;

  const unresolved = new Set<string>();
  const usersById = new Map(users.map((user) => [user.user_id, user]));
  const rosterPositions = league.roster_positions ?? [];

  const draftCapital = buildDraftCapital(
    rosters,
    drafts,
    tradedPicks,
    league,
    nflState,
  );

  const teams = rosters
    .map((roster) =>
      normalizeTeam(
        roster,
        usersById,
        rosterPositions,
        playerIndex,
        draftCapital,
        unresolved,
      ),
    )
    .sort((a, b) => a.roster_id - b.roster_id);

  const displayNameByRosterId = new Map<number, string | null>(
    teams.map((team) => [
      team.roster_id,
      team.manager.team_name ?? team.manager.display_name,
    ]),
  );

  const normalizedDrafts = drafts
    .map((draft) =>
      normalizeDraft(
        draft,
        draftPicksByDraftId.get(draft.draft_id) ?? [],
        playerIndex,
        usersById,
        unresolved,
      ),
    )
    .sort((a, b) => b.season.localeCompare(a.season));

  const totalRosteredPlayers = teams.reduce(
    (sum, team) => sum + team.players.length,
    0,
  );
  const totalPicksMade = normalizedDrafts.reduce(
    (sum, draft) => sum + draft.pick_count,
    0,
  );
  const claimedTeams = teams.filter((team) => !team.manager.is_vacant).length;
  const vacantTeams = teams.length - claimedTeams;

  // Flag conditions that would otherwise lead an analyst to wrong conclusions.
  const notes: string[] = [];
  if (league.status === "pre_draft") {
    notes.push(
      "League is in pre-draft state: rosters are empty until the draft happens, so roster-strength comparisons are not yet meaningful.",
    );
  }
  if (vacantTeams > 0) {
    notes.push(
      `${vacantTeams} of ${teams.length} teams have no manager assigned yet.`,
    );
  }
  if (totalRosteredPlayers === 0) {
    notes.push("No players are rostered on any team yet.");
  }
  if (totalPicksMade === 0 && normalizedDrafts.length > 0) {
    notes.push("No draft picks have been made yet.");
  }
  if (tradedPicks.length === 0) {
    notes.push(
      "No draft picks have been traded; every team still holds its own picks.",
    );
  }
  // Auction leagues have no ordered picks — budget is the real draft currency,
  // so the synthesized pick inventory should not be read as snake-draft capital.
  const upcomingAuction = drafts.find(
    (draft) => draft.type === "auction" && draft.status !== "complete",
  );
  if (upcomingAuction) {
    const budget = upcomingAuction.settings?.budget;
    notes.push(
      `The ${upcomingAuction.season} draft is an AUCTION${
        typeof budget === "number" ? ` with a ${budget} budget per team` : ""
      }, not a snake draft. Each team's draft_picks entries represent roster slots to fill, not ordered selections; bidding budget is the real draft currency.`,
    );
  }

  const uniquePlayerIds = new Set<string>();
  for (const team of teams) {
    for (const player of team.players) uniquePlayerIds.add(player.player_id);
    for (const player of team.taxi) uniquePlayerIds.add(player.player_id);
    for (const player of team.reserve) uniquePlayerIds.add(player.player_id);
    for (const slot of team.starters) {
      if (slot.player) uniquePlayerIds.add(slot.player.player_id);
    }
  }
  for (const draft of normalizedDrafts) {
    for (const pick of draft.picks) {
      if (pick.player) uniquePlayerIds.add(pick.player.player_id);
    }
  }

  return {
    generated_at: new Date().toISOString(),
    source: "Sleeper",
    league_id: leagueId,
    nfl_state: nflState,
    league: {
      league_id: league.league_id,
      name: league.name,
      season: league.season,
      season_type: league.season_type,
      sport: league.sport,
      status: league.status,
      status_description:
        LEAGUE_STATUS_DESCRIPTIONS[league.status] ?? "Unrecognized status.",
      total_rosters: league.total_rosters,
      avatar_url: league.avatar
        ? `https://sleepercdn.com/avatars/${league.avatar}`
        : null,
      previous_league_id: league.previous_league_id,
      roster_positions: rosterPositions,
      starting_lineup: {
        slots: startingSlots(rosterPositions),
        total_starters: startingSlots(rosterPositions).length,
        bench_slots: countRosterPosition(rosterPositions, "BN"),
        taxi_slots: league.settings?.taxi_slots ?? 0,
        reserve_slots: league.settings?.reserve_slots ?? 0,
        position_requirements: positionRequirements(rosterPositions),
      },
      scoring_settings: league.scoring_settings ?? {},
      settings: league.settings ?? {},
      key_settings: buildKeySettings(league),
    },
    teams,
    drafts: normalizedDrafts,
    traded_picks: normalizeTradedPicks(tradedPicks, displayNameByRosterId),
    league_state: {
      is_pre_draft: league.status === "pre_draft",
      rosters_filled: totalRosteredPlayers > 0,
      claimed_teams: claimedTeams,
      vacant_teams: vacantTeams,
      total_rostered_players: totalRosteredPlayers,
      total_draft_picks_made: totalPicksMade,
      notes,
    },
    metadata: {
      player_count: uniquePlayerIds.size,
      team_count: teams.length,
      draft_count: normalizedDrafts.length,
      traded_pick_count: tradedPicks.length,
      unresolved_player_ids: [...unresolved].sort(),
      player_database_size: playerIndex.size,
      warnings,
      build_ms: Date.now() - startedAt,
    },
  };
}
