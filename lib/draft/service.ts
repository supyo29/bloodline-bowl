/**
 * PHASE 4 — HTTP orchestration for the snake recommendation engine.
 *
 * Assembles the LIVE inputs (frozen projections + league scoring + draft state
 * + manager roster + market snapshot) and calls the pure `recommendDraft`
 * engine. Route handlers stay thin.
 *
 * SNAKE_ONLY (§0, §33): an auction draft returns `UnsupportedModeResponse` —
 * the engine is never asked to apply snake logic to an auction.
 */

import { getLeagueRosters, getPlayerIndex, slimPlayer } from "@/lib/sleeper/client";
import { buildDraftBundle } from "@/lib/sleeper/draft-service";
import { loadLeagueConfig } from "@/lib/projections/service";
import { buildBaseProjections, buildLeagueProjections } from "@/lib/projections/build";
import type { FantasyPosition } from "@/lib/projections/schema";
import type { ResolvedManager } from "@/lib/leagues/resolve";
import type { NormalizedPlayer } from "@/lib/sleeper/types";

import { recommendDraft, type CompletedPick, type EngineInput } from "./engine";
import { buildMarketConsensusSnapshot } from "./survival";
import {
  RECOMMENDATION_MODEL_VERSION,
  type DraftEngineReadiness,
  type RecommendationResponse,
  type UnsupportedModeResponse,
  type UtilityWeights,
} from "./schema";

const PROJECTION_SEASON = 2026;
const SKILL = new Set<FantasyPosition>(["QB", "RB", "WR", "TE", "K", "DEF"]);

function asSkill(pos: string | null | undefined): FantasyPosition | null {
  return pos && SKILL.has(pos as FantasyPosition) ? (pos as FantasyPosition) : null;
}

function readiness(status: DraftEngineReadiness["snake_engine_status"], degraded: string[], blocked: string[]): DraftEngineReadiness {
  return {
    draft_engine_mode: "SNAKE_ONLY",
    snake_engine_status: status,
    auction_engine_status: "UNSUPPORTED_2026",
    degraded_reasons: degraded,
    blocked_reasons: blocked,
  };
}

export interface RecommendationServiceOptions {
  weights?: UtilityWeights;
  limits?: EngineInput["limits"];
}

export async function buildManagerRecommendationResponse(
  manager: ResolvedManager,
  options: RecommendationServiceOptions = {},
): Promise<RecommendationResponse | UnsupportedModeResponse> {
  const [cfg, base, rosters, playerIndex, draftBundle] = await Promise.all([
    loadLeagueConfig(manager.league_slug, manager.league_id),
    buildBaseProjections({ season: PROJECTION_SEASON }),
    getLeagueRosters(manager.league_id),
    getPlayerIndex(),
    buildDraftBundle(manager.league_id, { availableLimit: 1, position: null }),
  ]);

  const draft = draftBundle.response.draft;
  const draftType = draft?.type ?? null;

  // ---- SNAKE_ONLY gate (§0, §33) ------------------------------------
  if (draftType && draftType !== "snake" && draftType !== "linear") {
    return {
      readiness: readiness("BLOCKED", [], [`draft type "${draftType}" is not supported by the 2026 engine`]),
      recommendation_model_version: RECOMMENDATION_MODEL_VERSION,
      error: "UNSUPPORTED_MODE",
      draft_type: draftType,
      detail:
        `The 2026 Bloodline Bowl draft engine is SNAKE_ONLY. Draft type "${draftType}" ` +
        `(e.g. auction) is not supported — no snake recommendation logic is applied. ` +
        `auction_engine_status = UNSUPPORTED_2026.`,
    };
  }

  const league = buildLeagueProjections(base, cfg);

  // ---- draft state ------------------------------------------------
  const picks = draftBundle.response.picks;
  const completedPicks: CompletedPick[] = picks.map((p) => ({
    overall: p.pick_no,
    roster_id: p.roster_id,
    player_id: p.player?.player_id ?? null,
    position: asSkill(p.player?.position),
  }));
  const rounds = draft?.rounds ?? cfg.roster_positions.filter((s) => !["BN", "IR", "TAXI"].includes(s)).length + 5;

  // ---- manager roster --------------------------------------------
  const mine = rosters.find((r) => r.roster_id === manager.roster_id);
  const ownedIds = (mine?.players ?? []).filter((id): id is string => typeof id === "string" && id !== "0");
  const rosterPlayers: NormalizedPlayer[] =
    ownedIds.length > 0
      ? ownedIds.map((id) => playerIndex.get(id) ?? slimPlayer(id, undefined))
      : picks
          .filter((p) => p.roster_id === manager.roster_id)
          .map((p) => p.player)
          .filter((p): p is NormalizedPlayer => p !== null);

  // ---- market snapshot (Phase 5) — calibrated ADP consensus + search_rank fallback
  const searchRankByPlayer = new Map<string, number | null>();
  for (const lp of league.projections) {
    searchRankByPlayer.set(lp.player_id, playerIndex.get(lp.player_id)?.search_rank ?? null);
  }
  const market = buildMarketConsensusSnapshot({ searchRankByPlayer });

  // ---- run the engine -------------------------------------------
  const response = recommendDraft({
    leaguePool: league.projections,
    rosterPositions: cfg.roster_positions,
    numTeams: cfg.num_teams,
    draftType: draftType ?? "snake",
    rounds,
    completedPicks,
    manager: {
      roster_id: manager.roster_id,
      sleeper_user_id: manager.sleeper_user_id,
      manager_slug: manager.manager_slug,
      draft_slot: manager.draft_slot,
    },
    rosterPlayers,
    market,
    provenance: {
      projection_source: "roster-intel",
      projection_version: base.model_version,
      projection_timestamp: base.generated_at,
      league_scoring_hash: league.scoring_hash,
      draft_state_timestamp: draftBundle.response.generated_at,
    },
    weights: options.weights,
    limits: options.limits,
  });

  return response;
}
