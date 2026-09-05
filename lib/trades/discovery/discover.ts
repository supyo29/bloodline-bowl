/**
 * Trade Engine — Phase 4: discovery orchestrator.
 *
 * The single entry point (`discoverTrades`) mirrors `analyzeTrade`'s shape:
 * ONE league-state read (`buildTradeAnalysisContext`, reused unchanged from
 * Phase 2A) feeds every search mode below, so a discovery request never
 * re-fetches provider state per candidate (Phase 4 performance requirement).
 */

import { resolveManager } from "@/lib/canonical/manager-context";
import { buildTradeAnalysisContext, TRADE_CONTEXT_VERSION, type BuildTradeContextOptions } from "../context";
import { resolveTradeConfig, type PartialTradeConfig } from "../config";
import { TRADE_ENGINE_VERSION } from "../schema";
import { TRADE_CALIBRATED_VERSION } from "../phase3";
import { TRADE_DATA_LAYER_VERSION } from "../data-readiness";
import { loadRealHistoricalTradeRecords } from "../historical-loader";
import { buildDiscoveryEvalContext } from "./candidate-eval";
import { runBilateralSearch, emptyCounters } from "./bilateral";
import { runThreeTeamSearch } from "./three-team";
import { TRADE_DISCOVERY_VERSION, TRADE_CALIBRATION_MIN_REAL_TRADES, DEFAULT_SEARCH_LIMITS } from "./config";
import type { TradeDiscoveryRequest, TradeDiscoveryResponse, TradeDiscoveryResult } from "./types";

export interface DiscoverTradesOptions extends BuildTradeContextOptions {
  config?: PartialTradeConfig;
}

function calibrationStatus() {
  const real = loadRealHistoricalTradeRecords();
  const remaining = Math.max(0, TRADE_CALIBRATION_MIN_REAL_TRADES - real.total_records);
  return {
    real_trade_count: real.total_records,
    required_trade_count: TRADE_CALIBRATION_MIN_REAL_TRADES,
    remaining_trade_count: remaining,
    review_available: real.total_records >= TRADE_CALIBRATION_MIN_REAL_TRADES,
  };
}

function baseResponse(req: TradeDiscoveryRequest, extra: Partial<TradeDiscoveryResponse>): TradeDiscoveryResponse {
  return {
    status: "OK",
    league_slug: req.league,
    manager_slug: req.manager,
    mode: req.mode,
    versions: { foundation: TRADE_ENGINE_VERSION, contextual: TRADE_CONTEXT_VERSION, calibrated: TRADE_CALIBRATED_VERSION, data: TRADE_DATA_LAYER_VERSION, discovery: TRADE_DISCOVERY_VERSION },
    calibration_status: calibrationStatus(),
    results: [],
    search_metadata: { ...emptyCounters(), truncated: false },
    diagnostics: [],
    ...extra,
  };
}

export async function discoverTrades(req: TradeDiscoveryRequest, options: DiscoverTradesOptions = {}): Promise<TradeDiscoveryResponse> {
  const config = resolveTradeConfig(options.config);
  const limits = DEFAULT_SEARCH_LIMITS;
  const maxResults = Math.min(req.max_results ?? limits.max_results_default, 25);

  const ctxResult = await buildTradeAnalysisContext(req.league, options);
  if (!ctxResult.context) {
    return baseResponse(req, {
      status: "CONTEXT_UNAVAILABLE",
      diagnostics: [{ code: "TRADE_ANALYSIS_DEGRADED", message: ctxResult.detail ?? `Trade-analysis context for "${req.league}" is unavailable (${ctxResult.code}).`, severity: "error" }],
    });
  }
  const ctx = ctxResult.context;

  const manager = resolveManager(ctx.snapshot.managers, req.manager);
  if (!manager) {
    return baseResponse(req, { status: "VALIDATION_FAILED", diagnostics: [{ code: "UNKNOWN_MANAGER", message: `Manager "${req.manager}" not found in league "${req.league}".`, severity: "error" }] });
  }
  const myManagerId = manager.canonical_manager_id;
  const myManagerSlug = manager.manager_slug;

  const evalCtx = buildDiscoveryEvalContext(ctx);
  const diagnostics: TradeDiscoveryResponse["diagnostics"] = [];

  let results: TradeDiscoveryResult[] = [];
  const counters = emptyCounters();

  // `include_three_team` on a non-THREE_TEAM mode is deferred (documented limitation, see
  // docs/TRADE_ENGINE_PHASE4.md "Remaining limitations") — mixing a 2-team and 3-team
  // funnel's counters/ranking cleanly needs more design than this pass allotted;
  // request mode "THREE_TEAM" explicitly for three-team results today.
  if (req.mode === "THREE_TEAM") {
    results = runThreeTeamSearch({ ctx, evalCtx, config, myManagerId, myManagerSlug, limits, constraints: req.constraints, maxResults }, counters);
  } else if (req.mode === "BUY_PLAYER") {
    if (!req.target_player_id) {
      return baseResponse(req, { status: "VALIDATION_FAILED", diagnostics: [{ code: "TARGET_PLAYER_REQUIRED", message: "BUY_PLAYER mode requires target_player_id.", severity: "error" }] });
    }
    const ownerTeamId = evalCtx.ownership.get(req.target_player_id);
    if (!ownerTeamId) {
      return baseResponse(req, { status: "OK", diagnostics: [{ code: "TARGET_NOT_ROSTERED", message: `Player ${req.target_player_id} is not rostered by any team in this league — not a trade-discovery candidate (free agent).`, severity: "warning" }] });
    }
    const ownerManagerId = [...ctx.rosters_by_manager.entries()].find(([, r]) => r.all_players.includes(req.target_player_id!))?.[0] ?? null;
    if (ownerManagerId === myManagerId) {
      return baseResponse(req, { status: "OK", diagnostics: [{ code: "TARGET_ALREADY_OWNED", message: `You already own player ${req.target_player_id}.`, severity: "info" }] });
    }
    const constraints = { ...req.constraints, required_incoming_player_ids: [...(req.constraints?.required_incoming_player_ids ?? []), req.target_player_id], allowed_trade_partner_ids: ownerManagerId ? [ownerManagerId] : undefined };
    const { results: r, counters: c } = runBilateralSearch({ ctx, evalCtx, config, mode: req.mode, myManagerId, myManagerSlug, limits, constraints, maxResults });
    results = r;
    Object.assign(counters, mergeCounters(counters, c));
  } else if (req.mode === "SELL_PLAYER") {
    if (!req.sell_player_id) {
      return baseResponse(req, { status: "VALIDATION_FAILED", diagnostics: [{ code: "SELL_PLAYER_REQUIRED", message: "SELL_PLAYER mode requires sell_player_id.", severity: "error" }] });
    }
    if (!ctx.rosters_by_manager.get(myManagerId)?.all_players.includes(req.sell_player_id)) {
      return baseResponse(req, { status: "VALIDATION_FAILED", diagnostics: [{ code: "SELL_PLAYER_NOT_OWNED", message: `You do not own player ${req.sell_player_id}.`, severity: "error" }] });
    }
    const constraints = { ...req.constraints, required_outgoing_player_ids: [...(req.constraints?.required_outgoing_player_ids ?? []), req.sell_player_id] };
    const { results: r, counters: c } = runBilateralSearch({ ctx, evalCtx, config, mode: req.mode, myManagerId, myManagerSlug, limits, constraints, maxResults });
    results = r;
    Object.assign(counters, mergeCounters(counters, c));
  } else if (req.mode === "POSITIONAL_NEED") {
    if (!req.target_position) {
      return baseResponse(req, { status: "VALIDATION_FAILED", diagnostics: [{ code: "TARGET_POSITION_REQUIRED", message: "POSITIONAL_NEED mode requires target_position.", severity: "error" }] });
    }
    const { results: r, counters: c } = runBilateralSearch({ ctx, evalCtx, config, mode: req.mode, myManagerId, myManagerSlug, limits, constraints: req.constraints, maxResults, targetPositions: [req.target_position] });
    results = r;
    Object.assign(counters, mergeCounters(counters, c));
  } else {
    // BEST_AVAILABLE, CONSOLIDATE, FAIR_TRADES, EASY_TO_ACCEPT, BLOCKBUSTER
    const { results: r, counters: c } = runBilateralSearch({ ctx, evalCtx, config, mode: req.mode, myManagerId, myManagerSlug, limits, constraints: req.constraints, maxResults });
    results = req.mode === "CONSOLIDATE" ? r.filter((x) => x.shape === "TWO_FOR_ONE" || x.shape === "ONE_FOR_TWO") : r;
    Object.assign(counters, mergeCounters(counters, c));
  }

  const truncated = counters.packages_evaluated >= limits.max_evaluated_candidates;
  if (truncated) diagnostics.push({ code: "SEARCH_TRUNCATED", message: `Search stopped after evaluating ${limits.max_evaluated_candidates} candidates (max_evaluated_candidates) — results may not include every possible package.`, severity: "info" });

  return baseResponse(req, { results, search_metadata: { ...counters, truncated }, diagnostics });
}

function mergeCounters(a: ReturnType<typeof emptyCounters>, b: ReturnType<typeof emptyCounters>): ReturnType<typeof emptyCounters> {
  return {
    partners_considered: a.partners_considered + b.partners_considered,
    assets_considered: a.assets_considered + b.assets_considered,
    packages_generated: a.packages_generated + b.packages_generated,
    packages_pruned: a.packages_pruned + b.packages_pruned,
    packages_evaluated: a.packages_evaluated + b.packages_evaluated,
    valid_results: a.valid_results + b.valid_results,
  };
}
