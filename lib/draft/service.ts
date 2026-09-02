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

import {
  SleeperError,
  getDraftLive,
  getDraftPicksLive,
  getLeagueRostersLive,
  getPlayerIndex,
  slimPlayer,
} from "@/lib/sleeper/client";
import { buildDraftBundle } from "@/lib/sleeper/draft-service";
import { loadLeagueConfig } from "@/lib/projections/service";
import { buildBaseProjections, buildLeagueProjections } from "@/lib/projections/build";
import { leagueScoringContext } from "@/lib/projections/league";
import { buildSpecialTeamsProjections, withoutRosteredSpecialTeams } from "@/lib/projections/special-teams";
import { PROJECTION_MODEL_VERSION, type FantasyPosition } from "@/lib/projections/schema";
import type { ResolvedManager } from "@/lib/leagues/resolve";
import type { NormalizedPlayer } from "@/lib/sleeper/types";

import { recommendDraft, type CompletedPick, type EngineInput } from "./engine";
import {
  assembleRehearsalResponse,
  deriveMockDraftState,
  type MockDraftDiagnostics,
  type MockDraftInfo,
} from "./mock-draft";
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
  /**
   * REHEARSAL ONLY (never on production — the route gates this). Consume the
   * live pick state from a STANDALONE Sleeper mock draft instead of the
   * Bloodline league's own draft. Every model layer (scoring, projections,
   * market, survival, tiers, replacement levels, K/DEF policy) and the snake
   * geometry frame stay Bloodline. Absent ⇒ ZERO behaviour change.
   */
  mockDraft?: { draftId: string; requestedSlot: number | null };
}

export async function buildManagerRecommendationResponse(
  manager: ResolvedManager,
  options: RecommendationServiceOptions = {},
): Promise<RecommendationResponse | UnsupportedModeResponse> {
  const mock = options.mockDraft ?? null;

  const [cfg, base, rosters, playerIndex, draftBundle] = await Promise.all([
    loadLeagueConfig(manager.league_slug, manager.league_id),
    buildBaseProjections({ season: PROJECTION_SEASON }),
    // LIVE — the manager's current drafted-player state must never be cached
    // during the draft. (League config + projections above stay cached.)
    getLeagueRostersLive(manager.league_id),
    getPlayerIndex(),
    // The mock override does NOT touch the Bloodline draft bundle at all.
    mock ? Promise.resolve(null) : buildDraftBundle(manager.league_id, { availableLimit: 1, position: null }),
  ]);

  // Bloodline geometry frame — used for BOTH the real draft and a mock override.
  const bloodlineRounds =
    cfg.roster_positions.filter((s) => !["BN", "IR", "TAXI"].includes(s)).length + 5;

  // ---- draft state: real Bloodline draft, or a rehearsal mock override -----
  let draftType: string | null;
  let completedPicks: CompletedPick[];
  let rounds: number;
  let draftStateTimestamp: string;
  let mockRosterPlayers: NormalizedPlayer[] | null = null;
  let mockInfo: MockDraftInfo | null = null;
  let mockDiagnostics: MockDraftDiagnostics | null = null;
  let mockInvalid = false;

  if (mock) {
    let mockMeta;
    try {
      mockMeta = await getDraftLive(mock.draftId);
    } catch (error) {
      // NEVER fall back to the real Bloodline draft on a bad mock id.
      if (error instanceof SleeperError && (error.status === 404 || error.status === 400)) {
        throw new SleeperError(
          `No Sleeper draft with id ${mock.draftId} (Sleeper returned ${error.status}). ` +
            `The rehearsal mock-draft override does NOT fall back to the real Bloodline draft.`,
          `/draft/${mock.draftId}`,
          404,
        );
      }
      throw error;
    }
    const mockPicks = await getDraftPicksLive(mock.draftId);
    const state = deriveMockDraftState({
      meta: mockMeta,
      picks: mockPicks,
      playerIndex,
      managerUserId: manager.sleeper_user_id,
      requestedDraftId: mock.draftId,
      requestedSlot: mock.requestedSlot,
      numTeams: cfg.num_teams,
      rounds: bloodlineRounds,
    });
    mockInfo = state.info;
    mockDiagnostics = state.diagnostics;

    // Phase C — an INVALID source must NEVER feed corrupt pick state into the
    // engine. Run the pipeline on an EMPTY state (so the response is otherwise
    // well-formed) and force BLOCKED after the fact.
    mockInvalid = state.diagnostics.state_validation === "INVALID";
    draftType = mockInvalid ? "snake" : state.draft_type;
    completedPicks = mockInvalid ? [] : state.completed_picks;
    mockRosterPlayers = mockInvalid ? [] : state.roster_players;
    rounds = bloodlineRounds; // Bloodline frame, not the mock's round count
    draftStateTimestamp = new Date().toISOString();
  } else {
    const draft = draftBundle!.response.draft;
    draftType = draft?.type ?? null;
    const picks = draftBundle!.response.picks;
    completedPicks = picks.map((p) => ({
      overall: p.pick_no,
      roster_id: p.roster_id,
      player_id: p.player?.player_id ?? null,
      position: asSkill(p.player?.position),
    }));
    rounds = draft?.rounds ?? bloodlineRounds;
    draftStateTimestamp = draftBundle!.response.generated_at;
  }

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
        `auction_engine_status = UNSUPPORTED_2026.` +
        (mockDiagnostics ? ` (rehearsal mock draft ${mockDiagnostics.draft_id})` : ""),
      ...(mockDiagnostics ? { mock_draft_diagnostics: mockDiagnostics } : {}),
    };
  }

  const offense = buildLeagueProjections(base, cfg);

  // ---- K / DEF production coverage (ri-kicker-2026.1 / ri-defense-2026.1) --
  // The frozen offensive structural model never covered K/DEF. These rows are
  // built from a reproducible vendored snapshot, scored through the SAME live
  // `scoring_settings` + `calculateFantasyPoints` Layer 2 uses, and appended to
  // the pool. The engine re-derives replacement/VOR/tiers per position group, so
  // no QB/RB/WR/TE number changes. The K/DST hard gate still controls timing.
  const scoringCtx = leagueScoringContext(cfg.league_slug, cfg.league_id, cfg.scoring_settings);
  const specialTeams = buildSpecialTeamsProjections({ ctx: scoringCtx, playerIndex });

  const league = {
    ...offense,
    projections: [...offense.projections, ...specialTeams.kickers, ...specialTeams.defenses],
  };
  const projectionCoverage: Record<string, string | null> = {
    QB: PROJECTION_MODEL_VERSION,
    RB: PROJECTION_MODEL_VERSION,
    WR: PROJECTION_MODEL_VERSION,
    TE: PROJECTION_MODEL_VERSION,
    K: specialTeams.coverage.K.status === "VALID" ? specialTeams.coverage.K.version : null,
    DEF: specialTeams.coverage.DEF.status === "VALID" ? specialTeams.coverage.DEF.version : null,
  };

  // ---- manager roster --------------------------------------------
  let rosterPlayers: NormalizedPlayer[];
  if (mock) {
    rosterPlayers = mockRosterPlayers ?? [];
  } else {
    const mine = rosters.find((r) => r.roster_id === manager.roster_id);
    const ownedIds = (mine?.players ?? []).filter((id): id is string => typeof id === "string" && id !== "0");
    rosterPlayers =
      ownedIds.length > 0
        ? ownedIds.map((id) => playerIndex.get(id) ?? slimPlayer(id, undefined))
        : draftBundle!.response.picks
            .filter((p) => p.roster_id === manager.roster_id)
            .map((p) => p.player)
            .filter((p): p is NormalizedPlayer => p !== null);
  }

  // ---- market snapshot (Phase 5) — calibrated ADP consensus + search_rank fallback
  const searchRankByPlayer = new Map<string, number | null>();
  for (const lp of league.projections) {
    searchRankByPlayer.set(lp.player_id, playerIndex.get(lp.player_id)?.search_rank ?? null);
  }
  const market = buildMarketConsensusSnapshot({ searchRankByPlayer });

  // ---- "one K, one DEF" — never surface a second (Phase 7 K/DST policy) ----
  const enginePool = withoutRosteredSpecialTeams(league.projections, rosterPlayers);

  // ---- run the engine -------------------------------------------
  const response = recommendDraft({
    leaguePool: enginePool,
    rosterPositions: cfg.roster_positions,
    numTeams: cfg.num_teams,
    draftType: draftType ?? "snake",
    rounds,
    completedPicks,
    manager: {
      roster_id: manager.roster_id,
      sleeper_user_id: manager.sleeper_user_id,
      manager_slug: manager.manager_slug,
      // Only the snake SLOT follows the mock; identity stays Bloodline.
      draft_slot: mockInfo ? mockInfo.applied_slot : manager.draft_slot,
    },
    rosterPlayers,
    market,
    projectionCoverage,
    provenance: {
      projection_source: "roster-intel",
      projection_version: base.model_version,
      projection_timestamp: base.generated_at,
      league_scoring_hash: league.scoring_hash,
      draft_state_timestamp: draftStateTimestamp,
    },
    weights: options.weights,
    limits: options.limits,
  });

  // ---- rehearsal response assembly: banner, diagnostics, INVALID hard-stop ----
  // The frozen `recommendDraft()` result above is NEVER mutated: the production
  // path returns it as-is; a rehearsal wraps a fresh presentation layer around it.
  if (!mockDiagnostics) {
    return response;
  }
  return assembleRehearsalResponse(response, mockDiagnostics, mockInvalid);
}
