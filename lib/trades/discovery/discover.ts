/**
 * Trade Engine — Phase 4: discovery orchestrator.
 *
 * The single entry point (`discoverTrades`) mirrors `analyzeTrade`'s shape:
 * ONE league-state read (`buildTradeAnalysisContext`, reused unchanged from
 * Phase 2A) feeds every search mode below, so a discovery request never
 * re-fetches provider state per candidate (Phase 4 performance requirement).
 *
 * Audit fix (§47): mode-specific required-field validation (BUY_PLAYER needs
 * `target_player_id`, etc.) now runs BEFORE the league-state read, not after
 * — a malformed request fails fast without a network round-trip, and the
 * check is independently testable without a live provider.
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
import { TRADE_STRATEGY_VERSION } from "../strategy/config";
import { buildManagerStrategicProfile } from "../strategy/profile";
import { assessDiscoveryResult } from "../strategy/assess";

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

/** Mode-specific required-field check — pure, no I/O, checked before any provider read. */
function validateModeFields(req: TradeDiscoveryRequest): { code: string; message: string } | null {
  if (req.mode === "BUY_PLAYER" && !req.target_player_id) return { code: "TARGET_PLAYER_REQUIRED", message: "BUY_PLAYER mode requires target_player_id." };
  if (req.mode === "SELL_PLAYER" && !req.sell_player_id) return { code: "SELL_PLAYER_REQUIRED", message: "SELL_PLAYER mode requires sell_player_id." };
  if (req.mode === "POSITIONAL_NEED" && !req.target_position) return { code: "TARGET_POSITION_REQUIRED", message: "POSITIONAL_NEED mode requires target_position." };
  return null;
}

export async function discoverTrades(req: TradeDiscoveryRequest, options: DiscoverTradesOptions = {}): Promise<TradeDiscoveryResponse> {
  const fieldError = validateModeFields(req);
  if (fieldError) {
    return baseResponse(req, { status: "VALIDATION_FAILED", diagnostics: [{ code: fieldError.code, message: fieldError.message, severity: "error" }] });
  }

  const config = resolveTradeConfig(options.config);
  const limits = DEFAULT_SEARCH_LIMITS;
  const maxResults = Math.min(req.max_results ?? limits.max_results_default, 25);
  const preDiagnostics: TradeDiscoveryResponse["diagnostics"] = [];

  // Audit fix (§48): `include_three_team` on a non-THREE_TEAM mode is a real,
  // parsed request field that currently does nothing — rather than silently
  // ignore it, say so explicitly (documented limitation, see
  // docs/TRADE_ENGINE_PHASE4_AUDIT.md — mixing two funnels' counters/ranking
  // cleanly is deferred). Request mode "THREE_TEAM" for three-team results.
  if (req.mode !== "THREE_TEAM" && req.include_three_team) {
    preDiagnostics.push({ code: "INCLUDE_THREE_TEAM_NOT_IMPLEMENTED", message: "`include_three_team` on a non-THREE_TEAM mode is not implemented — it was ignored, not silently applied. Request mode: \"THREE_TEAM\" explicitly for three-team results.", severity: "warning" });
  }

  const ctxResult = await buildTradeAnalysisContext(req.league, options);
  if (!ctxResult.context) {
    return baseResponse(req, {
      status: "CONTEXT_UNAVAILABLE",
      diagnostics: [...preDiagnostics, { code: "TRADE_ANALYSIS_DEGRADED", message: ctxResult.detail ?? `Trade-analysis context for "${req.league}" is unavailable (${ctxResult.code}).`, severity: "error" }],
    });
  }
  const ctx = ctxResult.context;

  const manager = resolveManager(ctx.snapshot.managers, req.manager);
  if (!manager) {
    return baseResponse(req, { status: "VALIDATION_FAILED", diagnostics: [...preDiagnostics, { code: "UNKNOWN_MANAGER", message: `Manager "${req.manager}" not found in league "${req.league}".`, severity: "error" }] });
  }
  const myManagerId = manager.canonical_manager_id;
  const myManagerSlug = manager.manager_slug;

  const evalCtx = buildDiscoveryEvalContext(ctx);
  const diagnostics: TradeDiscoveryResponse["diagnostics"] = [...preDiagnostics];

  let results: TradeDiscoveryResult[] = [];
  let counters = emptyCounters();

  if (req.mode === "THREE_TEAM") {
    results = runThreeTeamSearch({ ctx, evalCtx, config, myManagerId, myManagerSlug, limits, constraints: req.constraints, maxResults }, counters);
  } else if (req.mode === "BUY_PLAYER") {
    const ownerTeamId = evalCtx.ownership.get(req.target_player_id!);
    if (!ownerTeamId) {
      return baseResponse(req, { status: "OK", diagnostics: [...diagnostics, { code: "TARGET_NOT_ROSTERED", message: `Player ${req.target_player_id} is not rostered by any team in this league — not a trade-discovery candidate (free agent).`, severity: "warning" }] });
    }
    const ownerManagerId = [...ctx.rosters_by_manager.entries()].find(([, r]) => r.all_players.includes(req.target_player_id!))?.[0] ?? null;
    if (ownerManagerId === myManagerId) {
      return baseResponse(req, { status: "OK", diagnostics: [...diagnostics, { code: "TARGET_ALREADY_OWNED", message: `You already own player ${req.target_player_id}.`, severity: "info" }] });
    }
    const constraints = { ...req.constraints, required_incoming_player_ids: [...(req.constraints?.required_incoming_player_ids ?? []), req.target_player_id!], allowed_trade_partner_ids: ownerManagerId ? [ownerManagerId] : undefined };
    const { results: r, counters: c, diagnostics: d } = runBilateralSearch({ ctx, evalCtx, config, mode: req.mode, myManagerId, myManagerSlug, limits, constraints, maxResults, maxAssetsPerSide: req.max_assets_per_side });
    results = r;
    counters = mergeCounters(counters, c);
    diagnostics.push(...d);
  } else if (req.mode === "SELL_PLAYER") {
    if (!ctx.rosters_by_manager.get(myManagerId)?.all_players.includes(req.sell_player_id!)) {
      return baseResponse(req, { status: "VALIDATION_FAILED", diagnostics: [...diagnostics, { code: "SELL_PLAYER_NOT_OWNED", message: `You do not own player ${req.sell_player_id}.`, severity: "error" }] });
    }
    const constraints = { ...req.constraints, required_outgoing_player_ids: [...(req.constraints?.required_outgoing_player_ids ?? []), req.sell_player_id!] };
    const { results: r, counters: c, diagnostics: d } = runBilateralSearch({ ctx, evalCtx, config, mode: req.mode, myManagerId, myManagerSlug, limits, constraints, maxResults, maxAssetsPerSide: req.max_assets_per_side });
    results = r;
    counters = mergeCounters(counters, c);
    diagnostics.push(...d);
  } else if (req.mode === "POSITIONAL_NEED") {
    const { results: r, counters: c, diagnostics: d } = runBilateralSearch({ ctx, evalCtx, config, mode: req.mode, myManagerId, myManagerSlug, limits, constraints: req.constraints, maxResults, targetPositions: [req.target_position!], maxAssetsPerSide: req.max_assets_per_side });
    results = r;
    counters = mergeCounters(counters, c);
    diagnostics.push(...d);
  } else {
    // BEST_AVAILABLE, CONSOLIDATE, FAIR_TRADES, EASY_TO_ACCEPT, BLOCKBUSTER
    const { results: r, counters: c, diagnostics: d } = runBilateralSearch({ ctx, evalCtx, config, mode: req.mode, myManagerId, myManagerSlug, limits, constraints: req.constraints, maxResults, maxAssetsPerSide: req.max_assets_per_side });
    // Audit fix (§19/§20): CONSOLIDATE means the REQUESTER sends multiple assets for
    // fewer in return — that is TWO_FOR_ONE only. ONE_FOR_TWO is deconsolidation (the
    // requester ends up with MORE assets), the semantic opposite; it was previously
    // included here by mistake and is now correctly excluded from CONSOLIDATE results
    // (it still surfaces under BEST_AVAILABLE/SELL_PLAYER, where it belongs).
    results = req.mode === "CONSOLIDATE" ? r.filter((x) => x.shape === "TWO_FOR_ONE") : r;
    counters = mergeCounters(counters, c);
    diagnostics.push(...d);
  }

  const truncated = counters.packages_evaluated >= limits.max_evaluated_candidates;
  if (truncated) diagnostics.push({ code: "SEARCH_TRUNCATED", message: `Search stopped after evaluating ${limits.max_evaluated_candidates} candidates (max_evaluated_candidates) — results may not include every possible package.`, severity: "info" });

  // Phase 6 (`ri-trade-strategy-2026.2`) — ADDITIVE and opt-in only
  // (`include_strategic`). Never changes `results`' order, `rank`, `my_gain`,
  // or any base-evaluation field above — see lib/trades/strategy/assess.ts.
  let manager_strategic_profile: TradeDiscoveryResponse["manager_strategic_profile"] = undefined;
  if (req.include_strategic) {
    try {
      const profile = buildManagerStrategicProfile(ctx, myManagerId, myManagerSlug);
      manager_strategic_profile = profile;
      for (const result of results) {
        result.strategic = assessDiscoveryResult(result, profile, myManagerSlug);
      }
      // Audit fix (spec §17/§36, P2 — a required diagnostic was specified but
      // never implemented): a mathematically ELIMINATED redraft team is not
      // given fabricated "rebuilding" logic (there is none to give — see
      // archetype.ts), but discovery should not run silently for one either.
      // Surface an explicit, honest caution rather than pretending season
      // context is neutral for a team that is out of contention.
      if (profile.archetype === "ELIMINATED") {
        diagnostics.push({ code: "ELIMINATED_TEAM_TRADE_CAUTION", message: "This manager is mathematically eliminated from the playoffs. Strategic context does not fabricate a rebuilding or future-value framing (this is a redraft league) — trades are still evaluated purely on roster economics; season-state preference beyond that has limited meaning for an eliminated team.", severity: "info" });
      }
    } catch {
      diagnostics.push({ code: "STRATEGIC_CONTEXT_UNAVAILABLE", message: "Phase 6 strategic context could not be computed for this request — base discovery results are unaffected.", severity: "warning" });
    }
  }

  return baseResponse(req, {
    results,
    search_metadata: { ...counters, truncated },
    diagnostics,
    ...(req.include_strategic ? { manager_strategic_profile, strategy_version: TRADE_STRATEGY_VERSION } : {}),
  });
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
