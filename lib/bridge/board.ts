/**
 * Draft Bridge — server-side board builder.
 *
 * Given ONE league key, this resolves that league's frozen profile, fetches
 * that league's own live Sleeper data, and returns everything the Bridge UI
 * needs to render a board and build a self-identifying ChatGPT snapshot:
 *
 *   - the resolved league identity (profile + live-confirmed rules, with drift
 *     warnings where the two disagree)
 *   - the authoritative live scoring identity hash
 *   - draft geometry inputs (team count, rounds, order, picks already made)
 *   - the ranked available-player pool for THIS league's ranking source
 *   - the live Sleeper pick feed, already reconciled to this league's draft id
 *
 * Nothing here reads or merges another league. Every fetch is scoped to the one
 * resolved `platform_league_id` / `platform_draft_id`.
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
  type PlayerIndex,
} from "@/lib/sleeper/client";
import type {
  NormalizedPlayer,
  RawDraft,
  RawDraftPick,
  ResponseWarning,
} from "@/lib/sleeper/types";
import { draftablePositions, eligiblePositions } from "@/lib/sleeper/draft";
import { scoringIdentityHash } from "./hash";
import { rankPlayers, type RankedPlayer, type RankingSourceKind } from "./rankings";
import { reconcileDraftSource, type ReconcileResult } from "./state";
import {
  loadRankingPack,
  rankPoolByPack,
  validateRankingPack,
  type PackValidation,
} from "./ranking-packs";
import type { BridgeLeagueProfile } from "./profiles";
import { findBridgeProfile } from "./profiles";

/** How the board's available pool is ordered. */
export type BoardRankingSource =
  | "model_pack"
  | "custom_upload"
  | "sleeper_search_rank"
  | "sleeper_fallback";

/** Hard cap on the ranked pool returned to the client, for payload size. */
export const BOARD_POOL_LIMIT = 700;

export interface ResolvedLeagueRules {
  roster_positions: string[];
  starters: Record<string, number>;
  bench: number;
  reserve: number;
  flex_positions: string[];
  team_count: number;
  rounds: number;
  draft_type: string;
  /** True when live Sleeper rules match the frozen profile exactly. */
  matches_profile: boolean;
}

export interface BoardScoringIdentity {
  provider: "sleeper_live";
  /** SHA-256 over canonical `scoring_settings` + `roster_positions`. */
  scoring_sha256: string;
  captured_at: string;
  rec_points: number | null;
  passing_td_points: number | null;
  /** Rough label only; never used as a model input. */
  ppr_label: "full_ppr" | "half_ppr" | "standard" | "custom";
}

export interface BoardDraftFeed {
  draft_id: string;
  status: string;
  order: "snake" | "linear";
  /** user_id -> slot, from Sleeper's live draft_order. */
  draft_order: Record<string, number>;
  /** slot -> { user_id, display_name, roster_id }, resolved. */
  slots: Array<{
    slot: number;
    user_id: string | null;
    display_name: string | null;
    roster_id: number | null;
    is_me: boolean;
  }>;
  picks: Array<{
    pick_no: number;
    round: number;
    draft_slot: number;
    player_id: string | null;
    player_name: string | null;
    picked_by_user_id: string | null;
  }>;
  overall_picks_made: number;
  /** Result of validating this feed against the resolved profile. */
  source_check: ReconcileResult;
}

export interface BoardPlayer {
  player_id: string;
  name: string;
  position: string | null;
  fantasy_positions: string[];
  team: string | null;
  injury_status: string | null;
  bye_week: number | null;
  /** Primary rank shown on the board — from the active ranking source. */
  rank: number | null;
  /** Primary tier — a number for a custom file, a label for a model pack. */
  tier: number | string | null;
  sleeper_search_rank: number | null;
  /** Model-pack fields — populated only when a ranking pack is ACTIVE. */
  model_rank: number | null;
  model_pos_rank: number | null;
  model_tier: string | null;
  model_value: number | null;
  market_adp: number | null;
  model_action: string | null;
  model_note: string | null;
}

export interface BridgeBoardResponse {
  generated_at: string;
  schema: "bridge.board.v1";
  league_identity: {
    league_key: string;
    league_name: string;
    display_label: string;
    short_label: string;
    season: number;
    platform: "sleeper";
    platform_league_id: string;
    platform_draft_id: string;
    manager_key: string;
    manager_display_name: string;
    manager_sleeper_user_id: string;
    /** Best-known slot: user override wins, then live draft_order, then profile. */
    draft_slot: number | null;
    draft_slot_source: "user_override" | "sleeper_draft_order" | "unconfirmed";
    team_count: number;
    draft_type: string;
  };
  model_profile: BridgeLeagueProfile["model"] & {
    /** The live hash that IS authoritative for cross-checks this session. */
    live_scoring_sha256: string;
    ranking_source: BoardRankingSource;
    /**
     * True only when a league that SHOULD have an active model ranking is
     * running on the Sleeper fallback instead (pack missing or failed to
     * validate). It is NOT set merely because no frozen survival engine exists.
     */
    ranking_fallback_active: boolean;
  };
  /** Identity + verification of the active ranking pack, or null. */
  ranking_pack: {
    pack_id: string;
    model_version: string;
    source: string;
    source_artifact: string;
    source_project: string;
    source_board_sha256: string;
    model_release_gate: string | null;
    model_release_note: string;
    generated_at: string;
    scoring_status: PackValidation["scoring_status"];
    roster_status: PackValidation["roster_status"];
    status: PackValidation["status"];
    reasons: string[];
    verified: boolean;
    verified_note: string;
    player_count: number;
    matched_to_pool: number;
    missing_from_sleeper: Array<{ overall_rank: number; player: string; position: string }>;
    top_players_off_board: number;
  } | null;
  /** Plain-language quality flag for the ranking currently in effect. */
  ranking_quality: {
    /** MODEL = a validated league ranking pack. MARKET = Sleeper's ordering as
     * this league's intended baseline. FALLBACK = Sleeper's ordering because a
     * pack that should be active failed. CUSTOM = user-uploaded file. */
    status: "MODEL" | "MARKET" | "FALLBACK" | "CUSTOM";
    source_label: string;
    warning: string | null;
  };
  rules: ResolvedLeagueRules;
  scoring: BoardScoringIdentity;
  draft_feed: BoardDraftFeed;
  pool: BoardPlayer[];
  pool_truncated: boolean;
  opponent_modeling: BridgeLeagueProfile["opponent_modeling"];
  warnings: ResponseWarning[];
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

function pprLabel(rec: number | undefined): BoardScoringIdentity["ppr_label"] {
  if (rec === undefined) return "custom";
  if (rec >= 1) return "full_ppr";
  if (rec >= 0.5) return "half_ppr";
  if (rec === 0) return "standard";
  return "custom";
}

/**
 * Sleeper's slim player record carries no bye week. The field is kept in the
 * board/snapshot schema (as a stable null) so a future source can populate it
 * without a schema change.
 */
const BYE_WEEK_UNAVAILABLE: number | null = null;

/**
 * Build the board for exactly one league.
 *
 * @param leagueKey  A Bridge league key / registry key / alias.
 * @param options.rankingSource  Overrides the profile default.
 * @param options.customRankings  Matched custom rankings, when the source is custom.
 * @param options.slotOverride  A user-confirmed draft slot.
 */
export async function buildBridgeBoard(
  leagueKey: string,
  options: {
    rankingSource?: RankingSourceKind;
    customRankings?: import("./state").CustomRanking[] | null;
    slotOverride?: number | null;
  } = {},
): Promise<BridgeBoardResponse> {
  const profile = findBridgeProfile(leagueKey);
  if (!profile) {
    throw new SleeperError(
      `No Bridge league profile resolves from "${leagueKey}".`,
      "bridge/profiles",
      404,
    );
  }

  const warnings: ResponseWarning[] = [];
  const leagueId = profile.platform_league_id;

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
  const listedDraft =
    (Array.isArray(drafts) ? drafts : []).find(
      (d) => d.draft_id === profile.platform_draft_id,
    ) ?? null;

  let draft: RawDraft | null = listedDraft;
  let picks: RawDraftPick[] = [];
  if (profile.platform_draft_id) {
    const [freshDraft, freshPicks] = await Promise.all([
      optional<RawDraft | null>(
        `/draft/${profile.platform_draft_id}`,
        "draft_unavailable",
        warnings,
        listedDraft,
        () => getDraft(profile.platform_draft_id, { noStore: true }),
      ),
      optional<RawDraftPick[]>(
        `/draft/${profile.platform_draft_id}/picks`,
        "draft_picks_unavailable",
        warnings,
        [],
        () => getDraftPicks(profile.platform_draft_id, { noStore: true }),
      ),
    ]);
    draft = freshDraft ?? listedDraft;
    picks = Array.isArray(freshPicks) ? freshPicks : [];
  }

  const playerIndex = await optional<PlayerIndex>(
    "/players/nfl",
    "player_database_unavailable",
    warnings,
    new Map(),
    getPlayerIndex,
  );

  /* ---- rules: live vs. frozen ------------------------------------------- */

  const liveRosterPositions = league.roster_positions ?? [];
  const liveTeamCount = league.total_rosters ?? profile.draft.team_count;
  const liveRounds =
    draft?.settings?.rounds ??
    liveRosterPositions.length ??
    profile.draft.rounds;
  const liveDraftType = draft?.type ?? profile.draft.type;

  const rulesMatch =
    JSON.stringify(liveRosterPositions) ===
      JSON.stringify(profile.roster_rules.roster_positions) &&
    liveTeamCount === profile.draft.team_count &&
    liveRounds === profile.draft.rounds &&
    liveDraftType === profile.draft.type;

  if (!rulesMatch) {
    warnings.push({
      code: "profile_rules_drift",
      resource: "bridge/profiles",
      message:
        `Live Sleeper rules differ from the frozen ${profile.league_key} profile ` +
        `(live: ${liveTeamCount} teams, ${liveRounds} rounds, ${liveDraftType}, ` +
        `positions [${liveRosterPositions.join(",")}]). The board uses the LIVE values.`,
    });
  }

  const rules: ResolvedLeagueRules = {
    roster_positions: liveRosterPositions,
    starters: profile.roster_rules.starters,
    bench: liveRosterPositions.filter((p) => p === "BN").length,
    reserve: liveRosterPositions.filter((p) => p === "IR" || p === "TAXI").length,
    flex_positions: profile.roster_rules.flex_positions,
    team_count: liveTeamCount,
    rounds: liveRounds,
    draft_type: liveDraftType,
    matches_profile: rulesMatch,
  };

  /* ---- scoring identity ----------------------------------------------- */

  const scoringSettings = league.scoring_settings ?? {};
  const scoring: BoardScoringIdentity = {
    provider: "sleeper_live",
    scoring_sha256: scoringIdentityHash(scoringSettings, liveRosterPositions),
    captured_at: new Date().toISOString(),
    rec_points: scoringSettings.rec ?? null,
    passing_td_points: scoringSettings.pass_td ?? null,
    ppr_label: pprLabel(scoringSettings.rec),
  };

  /* ---- draft feed ---------------------------------------------------- */

  const usersById = new Map(
    (Array.isArray(users) ? users : []).map((u) => [u.user_id, u]),
  );
  const rosterByOwner = new Map(
    (Array.isArray(rosters) ? rosters : [])
      .filter((r) => r.owner_id)
      .map((r) => [r.owner_id as string, r.roster_id]),
  );
  const draftOrder = draft?.draft_order ?? {};
  const meUserId = profile.manager.sleeper_user_id;

  const slots = Object.entries(draftOrder)
    .map(([userId, slot]) => ({
      slot,
      user_id: userId,
      display_name: usersById.get(userId)?.display_name ?? null,
      roster_id: rosterByOwner.get(userId) ?? null,
      is_me: userId === meUserId,
    }))
    .sort((a, b) => a.slot - b.slot);

  const liveSlot =
    typeof draftOrder[meUserId] === "number" ? draftOrder[meUserId]! : null;
  const resolvedSlot =
    options.slotOverride != null
      ? options.slotOverride
      : (liveSlot ?? profile.manager.draft_slot);
  const slotSource: BridgeBoardResponse["league_identity"]["draft_slot_source"] =
    options.slotOverride != null
      ? "user_override"
      : liveSlot != null
        ? "sleeper_draft_order"
        : "unconfirmed";

  const sortedPicks = [...picks].sort((a, b) => a.pick_no - b.pick_no);
  const feedPicks = sortedPicks.map((p) => ({
    pick_no: p.pick_no,
    round: p.round,
    draft_slot: p.draft_slot,
    player_id: p.player_id,
    player_name: p.player_id
      ? (playerIndex.get(p.player_id)?.full_name ?? p.player_id)
      : null,
    picked_by_user_id: p.picked_by ?? null,
  }));

  const draftFeed: BoardDraftFeed = {
    draft_id: profile.platform_draft_id,
    status: draft?.status ?? "unknown",
    order: liveDraftType === "linear" ? "linear" : "snake",
    draft_order: draftOrder,
    slots,
    picks: feedPicks,
    overall_picks_made: feedPicks.filter((p) => p.player_id).length,
    source_check: reconcileDraftSource(profile, {
      draft_id: draft?.draft_id ?? profile.platform_draft_id,
      league_id: draft?.league_id ?? leagueId,
    }),
  };

  /* ---- ranked available pool --------------------------------------- */

  const takenIds = new Set<string>();
  for (const pick of sortedPicks) {
    if (pick.player_id) takenIds.add(pick.player_id);
  }
  for (const roster of Array.isArray(rosters) ? rosters : []) {
    for (const pid of roster.players ?? []) {
      if (typeof pid === "string" && pid !== "0") takenIds.add(pid);
    }
  }

  const draftable = draftablePositions(liveRosterPositions);
  const available: NormalizedPlayer[] = [];
  for (const player of playerIndex.values()) {
    if (takenIds.has(player.player_id)) continue;
    if (player.active === false) continue;
    const positions = eligiblePositions(player);
    if (positions.length === 0) continue;
    if (!positions.some((p) => draftable.has(p))) continue;
    // Drop unsigned/retired skill players (no NFL team) that Sleeper still
    // carries with a stale search_rank — a team defense legitimately has none.
    if (!player.team && !positions.includes("DEF")) continue;
    available.push(player);
  }

  const requestedSource: RankingSourceKind =
    options.rankingSource ?? profile.model.default_ranking_source;

  let rankingSource: BoardRankingSource;
  let pool: BoardPlayer[];
  let truncated: boolean;
  let rankingPack: BridgeBoardResponse["ranking_pack"] = null;
  let rankingQuality: BridgeBoardResponse["ranking_quality"];

  const pack =
    requestedSource === "custom_upload"
      ? null
      : loadRankingPack(profile.ranking_pack_id);
  const packValidation: PackValidation | null = pack
    ? validateRankingPack(pack, {
        leagueKey: profile.league_key,
        rosterPositions: liveRosterPositions,
        teamCount: liveTeamCount,
        rounds: liveRounds,
        draftType: liveDraftType,
        flexPositions: profile.roster_rules.flex_positions,
        liveScoringSha256: scoring.scoring_sha256,
      })
    : null;

  if (pack && packValidation && packValidation.status === "ACTIVE") {
    rankingSource = "model_pack";
    const { ranked, diagnostics } = rankPoolByPack(available, pack, playerIndex);
    truncated = ranked.length > BOARD_POOL_LIMIT;
    pool = ranked.slice(0, BOARD_POOL_LIMIT).map((r) => ({
      player_id: r.player.player_id,
      name: r.player.full_name,
      position: r.player.position,
      fantasy_positions: r.player.fantasy_positions,
      team: r.player.team,
      injury_status: r.player.injury_status,
      bye_week: BYE_WEEK_UNAVAILABLE,
      rank: r.overall_rank,
      tier: r.tier,
      sleeper_search_rank: r.player.search_rank,
      model_rank: r.overall_rank,
      model_pos_rank: r.position_rank,
      model_tier: r.tier,
      model_value: r.model_value,
      market_adp: r.adp,
      model_action: r.action,
      model_note: r.target_note,
    }));
    rankingPack = {
      pack_id: profile.ranking_pack_id as string,
      model_version: pack.ranking_identity.model_version,
      source: pack.ranking_identity.source,
      source_artifact: pack.ranking_identity.source_artifact,
      source_project: pack.ranking_identity.source_project,
      source_board_sha256: pack.ranking_identity.source_board_sha256,
      model_release_gate: pack.ranking_identity.model_release_gate,
      model_release_note: pack.ranking_identity.model_release_note,
      generated_at: pack.ranking_identity.generated_at,
      scoring_status: packValidation.scoring_status,
      roster_status: packValidation.roster_status,
      status: packValidation.status,
      reasons: packValidation.reasons,
      verified: pack.ranking_identity.verified,
      verified_note: pack.ranking_identity.verified_note,
      player_count: pack.players.length,
      matched_to_pool: diagnostics.matched,
      missing_from_sleeper: diagnostics.missing_from_sleeper,
      top_players_off_board: diagnostics.top_players_off_board,
    };
    rankingQuality = {
      status: "MODEL",
      source_label: `${pack.league_identity.manager_name} ${pack.league_identity.season} Model (${pack.ranking_identity.model_version})`,
      warning: null,
    };
    if (diagnostics.missing_from_sleeper.length > 0) {
      warnings.push({
        code: "ranking_pack_players_unmatched",
        resource: "bridge/ranking-packs",
        message:
          `${diagnostics.missing_from_sleeper.length} ranking-pack player(s) are not in Sleeper's ` +
          `player database (top example: ${diagnostics.missing_from_sleeper[0]?.player}).`,
      });
    }
  } else {
    const ranked: RankedPlayer[] = rankPlayers(available, {
      source: requestedSource === "custom_upload" ? "custom_upload" : "sleeper_search_rank",
      customRankings: options.customRankings ?? null,
    });
    truncated = ranked.length > BOARD_POOL_LIMIT;
    pool = ranked.slice(0, BOARD_POOL_LIMIT).map((r) => ({
      player_id: r.player.player_id,
      name: r.player.full_name,
      position: r.player.position,
      fantasy_positions: r.player.fantasy_positions,
      team: r.player.team,
      injury_status: r.player.injury_status,
      bye_week: BYE_WEEK_UNAVAILABLE,
      rank: r.rank,
      tier: r.tier,
      sleeper_search_rank: r.player.search_rank,
      model_rank: null,
      model_pos_rank: null,
      model_tier: null,
      model_value: null,
      market_adp: null,
      model_action: null,
      model_note: null,
    }));

    if (requestedSource === "custom_upload") {
      rankingSource = "custom_upload";
      rankingQuality = {
        status: "CUSTOM",
        source_label: "Your uploaded rankings file",
        warning: null,
      };
    } else if (profile.ranking_pack_id) {
      // A pack SHOULD have been active for this league but did not validate.
      rankingSource = "sleeper_fallback";
      const reasons = packValidation?.reasons ?? ["Ranking pack file could not be loaded."];
      rankingPack = pack
        ? {
            pack_id: profile.ranking_pack_id,
            model_version: pack.ranking_identity.model_version,
            source: pack.ranking_identity.source,
            source_artifact: pack.ranking_identity.source_artifact,
            source_project: pack.ranking_identity.source_project,
            source_board_sha256: pack.ranking_identity.source_board_sha256,
            model_release_gate: pack.ranking_identity.model_release_gate,
            model_release_note: pack.ranking_identity.model_release_note,
            generated_at: pack.ranking_identity.generated_at,
            scoring_status: packValidation?.scoring_status ?? "UNVERIFIED",
            roster_status: packValidation?.roster_status ?? "MISMATCH",
            status: "BLOCKED",
            reasons,
            verified: false,
            verified_note: pack.ranking_identity.verified_note,
            player_count: pack.players.length,
            matched_to_pool: 0,
            missing_from_sleeper: [],
            top_players_off_board: 0,
          }
        : null;
      rankingQuality = {
        status: "FALLBACK",
        source_label: "Sleeper search_rank — FALLBACK",
        warning:
          `${profile.manager.display_name} canonical ranking pack is not active: ${reasons.join(" ")}`,
      };
      warnings.push({
        code: "ranking_pack_not_active",
        resource: "bridge/ranking-packs",
        message:
          `${profile.manager.display_name.toUpperCase()} MODEL NOT LOADED — USING SLEEPER FALLBACK RANKINGS. ${reasons.join(" ")}`,
      });
    } else {
      rankingSource = "sleeper_search_rank";
      rankingQuality = {
        status: "MARKET",
        source_label: "Sleeper search_rank (market baseline)",
        warning: null,
      };
    }
  }

  const darthmarkerMissing =
    profile.league_key === "devoted_to_the_game" &&
    rankingSource !== "model_pack";

  return {
    generated_at: new Date().toISOString(),
    schema: "bridge.board.v1",
    league_identity: {
      league_key: profile.league_key,
      league_name: league.name ?? profile.league_name,
      display_label: profile.display_label,
      short_label: profile.short_label,
      season: Number(league.season) || profile.season,
      platform: "sleeper",
      platform_league_id: leagueId,
      platform_draft_id: profile.platform_draft_id,
      manager_key: profile.manager.manager_key,
      manager_display_name: profile.manager.display_name,
      manager_sleeper_user_id: meUserId,
      draft_slot: resolvedSlot,
      draft_slot_source: slotSource,
      team_count: liveTeamCount,
      draft_type: liveDraftType,
    },
    model_profile: {
      ...profile.model,
      live_scoring_sha256: scoring.scoring_sha256,
      ranking_source: rankingSource,
      ranking_fallback_active: darthmarkerMissing,
    },
    ranking_pack: rankingPack,
    ranking_quality: rankingQuality,
    rules,
    scoring,
    draft_feed: draftFeed,
    pool,
    pool_truncated: truncated,
    opponent_modeling: profile.opponent_modeling,
    warnings,
  };
}
