/**
 * Draft Bridge — league ranking packs.
 *
 * A ranking pack is a portable, league-specific ranking table produced by an
 * external model (e.g. the Roster Intel DarthMarker draft board) and vendored
 * into this repo as a static JSON file. When a league has a pack that validates
 * against the live league identity, scoring, and roster rules, the Bridge ranks
 * that league's board by the pack instead of Sleeper's `search_rank`.
 *
 * Fail-closed: a pack that is missing, is for the wrong league, or was built for
 * different scoring / roster rules is NOT applied. The board falls back to
 * Sleeper order and flags the ranking quality as FALLBACK — loudly, never
 * silently.
 *
 * Framework-free; safe in the browser bundle and in `node --test`.
 */

import type { NormalizedPlayer } from "@/lib/sleeper/types";
import { scoringIdentityHash } from "./hash";
import { darthmarker2026 } from "./ranking-packs/darthmarker-2026";

export interface RankingPackPlayer {
  sleeper_id: string;
  source_player_id: string;
  player: string;
  team: string | null;
  position: string;
  overall_rank: number;
  position_rank: number | null;
  tier: string | null;
  model_value: number | null;
  vorp: number | null;
  adp: number | null;
  market_source: string | null;
  market_vs_model: number | null;
  action: string | null;
  target_note: string | null;
  flags: string[];
}

export interface RankingPack {
  schema_version: string;
  league_identity: {
    league_key: string;
    registry_key: string;
    league_name: string;
    manager_key: string;
    manager_name: string;
    draft_slot: number;
    season: number;
    platform_league_id: string;
    platform_draft_id: string;
  };
  ranking_identity: {
    source: string;
    source_artifact: string;
    source_project: string;
    source_board_sha256: string;
    source_scoring_sha256: string;
    model_version: string;
    model_release_gate: string | null;
    model_release_note: string;
    scoring_status: string | null;
    market_proxy_status: string | null;
    generated_at: string;
    scoring_settings: Record<string, number>;
    scoring_settings_sha256: string;
    expected_roster: {
      QB: number; RB: number; WR: number; TE: number;
      FLEX: number; K: number; DEF: number; BN: number;
      flex_positions: string[];
      teams: number;
      rounds: number;
      draft_type: string;
      ppr: string;
    };
    pick_path: number[] | null;
    verified: boolean;
    verified_note: string;
  };
  players: RankingPackPlayer[];
}

const PACKS: Record<string, RankingPack> = {
  darthmarker_2026: darthmarker2026,
};

export function loadRankingPack(packId: string | null | undefined): RankingPack | null {
  if (!packId) return null;
  return PACKS[packId] ?? null;
}

/* -------------------------------------------------------------------------- */
/* Validation                                                                  */
/* -------------------------------------------------------------------------- */

export interface PackValidationInput {
  leagueKey: string;
  rosterPositions: string[];
  teamCount: number;
  rounds: number;
  draftType: string;
  flexPositions: string[];
  /** The board's live {scoring_settings, roster_positions} identity hash. */
  liveScoringSha256: string;
}

export interface PackValidation {
  status: "ACTIVE" | "BLOCKED";
  scoring_status: "MATCH" | "VERIFIED_FROM_SETTINGS" | "UNVERIFIED";
  roster_status: "MATCH" | "MISMATCH";
  reasons: string[];
}

function rosterCountsFromPositions(positions: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const p of positions) counts[p] = (counts[p] ?? 0) + 1;
  return counts;
}

export function validateRankingPack(
  pack: RankingPack,
  input: PackValidationInput,
): PackValidation {
  const reasons: string[] = [];

  // 1. League identity — never apply another league's pack.
  if (pack.league_identity.league_key !== input.leagueKey) {
    reasons.push(
      `Pack league_key "${pack.league_identity.league_key}" != active league "${input.leagueKey}".`,
    );
  }

  // 2. Scoring identity.
  let scoringStatus: PackValidation["scoring_status"] = "UNVERIFIED";
  const packIdentityHash = scoringIdentityHash(
    pack.ranking_identity.scoring_settings,
    input.rosterPositions,
  );
  if (packIdentityHash === input.liveScoringSha256) {
    scoringStatus = "MATCH";
  } else {
    // Settings present but hash differs — could be roster-position ordering.
    // Fall back to a direct key-by-key settings comparison against live is not
    // possible here (we only have the hash), so mark UNVERIFIED and block.
    scoringStatus = "UNVERIFIED";
    reasons.push(
      `Pack scoring identity ${packIdentityHash.slice(0, 12)}… does not match live ${input.liveScoringSha256.slice(0, 12)}….`,
    );
  }

  // 3. Roster settings.
  const want = pack.ranking_identity.expected_roster;
  const live = rosterCountsFromPositions(input.rosterPositions);
  const liveFlex =
    (live.FLEX ?? 0) +
    (live.WRRB_FLEX ?? 0) +
    (live.REC_FLEX ?? 0) +
    (live.WRRB_WRT ?? 0);
  const rosterChecks: Array<[string, number, number]> = [
    ["QB", want.QB, live.QB ?? 0],
    ["RB", want.RB, live.RB ?? 0],
    ["WR", want.WR, live.WR ?? 0],
    ["TE", want.TE, live.TE ?? 0],
    ["FLEX", want.FLEX, liveFlex],
    ["K", want.K, live.K ?? 0],
    ["DEF", want.DEF, (live.DEF ?? 0) + (live.DST ?? 0)],
    ["BN", want.BN, live.BN ?? 0],
  ];
  let rosterStatus: PackValidation["roster_status"] = "MATCH";
  for (const [slot, expected, actual] of rosterChecks) {
    if (expected !== actual) {
      rosterStatus = "MISMATCH";
      reasons.push(`Roster ${slot}: pack expects ${expected}, live has ${actual}.`);
    }
  }
  if (want.teams !== input.teamCount) {
    rosterStatus = "MISMATCH";
    reasons.push(`Teams: pack expects ${want.teams}, live has ${input.teamCount}.`);
  }
  if (want.rounds !== input.rounds) {
    rosterStatus = "MISMATCH";
    reasons.push(`Rounds: pack expects ${want.rounds}, live has ${input.rounds}.`);
  }
  if (want.draft_type !== input.draftType) {
    rosterStatus = "MISMATCH";
    reasons.push(
      `Draft type: pack expects ${want.draft_type}, live is ${input.draftType}.`,
    );
  }

  const status: PackValidation["status"] =
    reasons.length === 0 && scoringStatus === "MATCH" && rosterStatus === "MATCH"
      ? "ACTIVE"
      : "BLOCKED";

  return { status, scoring_status: scoringStatus, roster_status: rosterStatus, reasons };
}

/* -------------------------------------------------------------------------- */
/* Identity matching + ranking                                                 */
/* -------------------------------------------------------------------------- */

export interface PackMatchDiagnostics {
  matched: number;
  /** Pack players whose Sleeper id is not in Sleeper's player database at all. */
  missing_from_sleeper: Array<{ overall_rank: number; player: string; position: string }>;
  /** Top-72 pack players not present in the available pool (usually already drafted). */
  top_players_off_board: number;
}

export interface PackRankedPlayer {
  player: NormalizedPlayer;
  /** null for players not in the pack (they trail, in Sleeper order). */
  overall_rank: number | null;
  position_rank: number | null;
  tier: string | null;
  model_value: number | null;
  adp: number | null;
  action: string | null;
  target_note: string | null;
  flags: string[];
  ranking_source: "model_pack";
}

const TOP_HORIZON = 72;

/**
 * Order the available pool by pack `overall_rank`. Players present in the pack
 * come first in pack order; players not in the pack follow, ordered by Sleeper
 * `search_rank`, with `overall_rank: null`.
 */
export function rankPoolByPack(
  available: NormalizedPlayer[],
  pack: RankingPack,
  fullPlayerIndex: ReadonlyMap<string, NormalizedPlayer>,
): { ranked: PackRankedPlayer[]; diagnostics: PackMatchDiagnostics } {
  const byId = new Map(pack.players.map((p) => [p.sleeper_id, p]));
  const availableIds = new Set(available.map((p) => p.player_id));

  const inPack: PackRankedPlayer[] = [];
  const rest: NormalizedPlayer[] = [];
  for (const player of available) {
    const entry = byId.get(player.player_id);
    if (entry) {
      inPack.push({
        player,
        overall_rank: entry.overall_rank,
        position_rank: entry.position_rank,
        tier: entry.tier,
        model_value: entry.model_value,
        adp: entry.adp,
        action: entry.action,
        target_note: entry.target_note,
        flags: entry.flags,
        ranking_source: "model_pack",
      });
    } else {
      rest.push(player);
    }
  }
  inPack.sort((a, b) => (a.overall_rank ?? 0) - (b.overall_rank ?? 0));
  rest.sort(
    (a, b) =>
      (a.search_rank ?? Number.MAX_SAFE_INTEGER) -
      (b.search_rank ?? Number.MAX_SAFE_INTEGER),
  );

  const missing: PackMatchDiagnostics["missing_from_sleeper"] = [];
  let topOffBoard = 0;
  for (const entry of pack.players) {
    if (!fullPlayerIndex.has(entry.sleeper_id)) {
      missing.push({
        overall_rank: entry.overall_rank,
        player: entry.player,
        position: entry.position,
      });
    } else if (entry.overall_rank <= TOP_HORIZON && !availableIds.has(entry.sleeper_id)) {
      topOffBoard += 1;
    }
  }

  return {
    ranked: [
      ...inPack,
      ...rest.map(
        (player): PackRankedPlayer => ({
          player,
          overall_rank: null,
          position_rank: null,
          tier: null,
          model_value: null,
          adp: null,
          action: null,
          target_note: null,
          flags: [],
          ranking_source: "model_pack",
        }),
      ),
    ],
    diagnostics: {
      matched: inPack.length,
      missing_from_sleeper: missing,
      top_players_off_board: topOffBoard,
    },
  };
}
