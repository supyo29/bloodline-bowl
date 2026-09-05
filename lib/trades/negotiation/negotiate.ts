/**
 * Trade Engine — Phase 5: negotiation orchestrator.
 *
 * Mirrors `discoverTrades`'s shape: ONE league-state read feeds every
 * negotiation mode. Reuses Phase 4's discovery context/profile/evaluation
 * machinery throughout — this file adds MODE DISPATCH and result assembly
 * only, never a new valuation path.
 */

import { resolveManager } from "@/lib/canonical/manager-context";
import { buildTradeAnalysisContext, TRADE_CONTEXT_VERSION, type BuildTradeContextOptions } from "../context";
import { resolveTradeConfig, type PartialTradeConfig } from "../config";
import { TRADE_ENGINE_VERSION } from "../schema";
import { TRADE_CALIBRATED_VERSION } from "../phase3";
import { TRADE_DATA_LAYER_VERSION } from "../data-readiness";
import { loadRealHistoricalTradeRecords } from "../historical-loader";
import { TRADE_DISCOVERY_VERSION, TRADE_CALIBRATION_MIN_REAL_TRADES, DEFAULT_SEARCH_LIMITS } from "../discovery/config";
import { buildDiscoveryEvalContext } from "../discovery/candidate-eval";
import { buildTradeSearchProfile } from "../discovery/profiles";
import { runBilateralSearch } from "../discovery/bilateral";
import { DEFAULT_NEGOTIATION_LIMITS, TRADE_NEGOTIATION_VERSION } from "./config";
import { computePlayerDependency } from "./dependency";
import { computeLeverage, countAlternativePartners } from "./leverage";
import { buildOfferLadder } from "./offer-ladder";
import { findSweeteners, findOverpayReduction } from "./concessions";
import { buildCounterStrategy } from "./counter-strategy";
import { analyzeWalkAway } from "./walk-away";
import { paretoFrontier, selectOfferTiers } from "./pareto";
import { buildManagerBehaviorEvidence } from "./behavior";
import type { NegotiationRequest, NegotiationResponse, NegotiationMode } from "./types";
import { TRADE_STRATEGY_VERSION } from "../strategy/config";
import { buildManagerStrategicProfile } from "../strategy/profile";
import { recommendOfferTier } from "../strategy/assess";

export interface NegotiateTradesOptions extends BuildTradeContextOptions {
  config?: PartialTradeConfig;
}

function calibrationStatus() {
  const real = loadRealHistoricalTradeRecords();
  return { real_trade_count: real.total_records, required_trade_count: TRADE_CALIBRATION_MIN_REAL_TRADES, behavioral_intelligence_status: "INSUFFICIENT_DATA" as const };
}

function base(req: NegotiationRequest, extra: Partial<NegotiationResponse>): NegotiationResponse {
  return {
    status: "OK",
    league_slug: req.league,
    manager_slug: req.manager,
    mode: req.mode ?? null,
    versions: { foundation: TRADE_ENGINE_VERSION, contextual: TRADE_CONTEXT_VERSION, calibrated: TRADE_CALIBRATED_VERSION, data: TRADE_DATA_LAYER_VERSION, discovery: TRADE_DISCOVERY_VERSION, negotiation: TRADE_NEGOTIATION_VERSION },
    calibration_status: calibrationStatus(),
    target_dependency: null,
    leverage: null,
    offers: {},
    sweeteners: [],
    overpay_reduction: null,
    counter_strategy: null,
    walk_away: null,
    alternative_targets: [],
    behavioral_intelligence: buildManagerBehaviorEvidence(req.manager),
    phase3_shadow: { label: "SHADOW INTELLIGENCE — NOT INCLUDED IN NEGOTIATION VALUE", notes: [] },
    diagnostics: [],
    ...extra,
  };
}

function inferMode(req: NegotiationRequest): NegotiationMode | null {
  if (req.mode) return req.mode;
  if (req.target_player_id) return "ACQUIRE_TARGET";
  if (req.sell_player_id) return "SELL_ASSET";
  if (req.proposal) return "IMPROVE_OFFER";
  return null;
}

export async function negotiateTrade(req: NegotiationRequest, options: NegotiateTradesOptions = {}): Promise<NegotiationResponse> {
  const mode = inferMode(req);
  if (!mode) {
    return base(req, { status: "VALIDATION_FAILED", diagnostics: [{ code: "MODE_UNDETERMINED", message: "Provide target_player_id, sell_player_id, or proposal (or an explicit mode).", severity: "error" }] });
  }
  if ((mode === "ACQUIRE_TARGET") && !req.target_player_id) {
    return base(req, { status: "VALIDATION_FAILED", mode, diagnostics: [{ code: "TARGET_PLAYER_REQUIRED", message: "ACQUIRE_TARGET requires target_player_id.", severity: "error" }] });
  }
  if (mode === "SELL_ASSET" && !req.sell_player_id) {
    return base(req, { status: "VALIDATION_FAILED", mode, diagnostics: [{ code: "SELL_PLAYER_REQUIRED", message: "SELL_ASSET requires sell_player_id.", severity: "error" }] });
  }
  if ((mode === "IMPROVE_OFFER" || mode === "REDUCE_OVERPAY" || mode === "COUNTER_PROPOSAL") && !req.proposal) {
    return base(req, { status: "VALIDATION_FAILED", mode, diagnostics: [{ code: "PROPOSAL_REQUIRED", message: `${mode} requires a proposal.`, severity: "error" }] });
  }

  const config = resolveTradeConfig(options.config);
  const ctxResult = await buildTradeAnalysisContext(req.league, options);
  if (!ctxResult.context) {
    return base(req, { status: "CONTEXT_UNAVAILABLE", mode, diagnostics: [{ code: "TRADE_ANALYSIS_DEGRADED", message: ctxResult.detail ?? `Trade-analysis context for "${req.league}" is unavailable (${ctxResult.code}).`, severity: "error" }] });
  }
  const ctx = ctxResult.context;

  const manager = resolveManager(ctx.snapshot.managers, req.manager);
  if (!manager) {
    return base(req, { status: "VALIDATION_FAILED", mode, diagnostics: [{ code: "UNKNOWN_MANAGER", message: `Manager "${req.manager}" not found in league "${req.league}".`, severity: "error" }] });
  }
  const myManagerId = manager.canonical_manager_id;
  const myManagerSlug = manager.manager_slug;
  const evalCtx = buildDiscoveryEvalContext(ctx);
  const diagnostics: NegotiationResponse["diagnostics"] = [];

  if (mode === "ACQUIRE_TARGET") {
    const targetId = req.target_player_id!;
    const ownerManagerId = [...ctx.rosters_by_manager.entries()].find(([, r]) => r.all_players.includes(targetId))?.[0] ?? null;
    if (!ownerManagerId) {
      return base(req, { status: "OK", mode, diagnostics: [{ code: "TARGET_NOT_ROSTERED", message: `Player ${targetId} is not rostered by any team in this league.`, severity: "warning" }] });
    }
    if (ownerManagerId === myManagerId) {
      return base(req, { status: "OK", mode, diagnostics: [{ code: "TARGET_ALREADY_OWNED", message: `You already own player ${targetId}.`, severity: "info" }] });
    }
    const ownerRoster = ctx.rosters_by_manager.get(ownerManagerId)!;
    const targetDependency = computePlayerDependency(targetId, ownerRoster, ctx);
    const targetPosition = ctx.players_by_id.get(targetId)?.position ?? "UNKNOWN";

    const requesterProfile = buildTradeSearchProfile(myManagerId, myManagerSlug, ctx);
    const ownerManager = ctx.snapshot.managers.find((m) => m.canonical_manager_id === ownerManagerId);
    const ownerProfile = buildTradeSearchProfile(ownerManagerId, ownerManager?.manager_slug ?? ownerManagerId, ctx);
    const altCount = countAlternativePartners(ctx, targetPosition, [myManagerId, ownerManagerId]);
    const leverage = computeLeverage({ requester: requesterProfile, partner: ownerProfile, targetPosition, targetDependency, alternativePartnerCount: altCount });

    const { ladder, candidates_considered, frontier_size } = buildOfferLadder({ ctx, evalCtx, config, myManagerId, myManagerSlug, ownerManagerId, targetPlayerId: targetId, untouchablePlayerIds: req.untouchable_player_ids });
    if (candidates_considered === 0) diagnostics.push({ code: "NO_VIABLE_PACKAGE_FOUND", message: `No canonically-evaluated package acquiring ${targetId} cleared even the RELUCTANT partner floor within the search bounds.`, severity: "info" });

    const outgoingDeps = Object.values(ladder).flatMap((r) => r!.transfers.filter((t) => t.from_manager_id === myManagerId).map((t) => computePlayerDependency(t.canonical_player_id, ctx.rosters_by_manager.get(myManagerId)!, ctx)));
    const walkAway = analyzeWalkAway({ ladder, myManagerSlug, outgoingDependencies: outgoingDeps });

    let sweeteners: ReturnType<typeof findSweeteners> = [];
    const opening = ladder.OPENING;
    if (opening) {
      sweeteners = findSweeteners({ ctx, evalCtx, config, myManagerId, myManagerSlug, baseTransfers: opening.transfers, partnerManagerId: ownerManagerId, maxCandidates: DEFAULT_NEGOTIATION_LIMITS.max_sweetener_candidates });
    }

    const shadowNotes: string[] = [];
    const mineOnOpening = opening ? Object.values(opening.full_evaluation.participants).find((p) => p.manager_slug === myManagerSlug) : undefined;
    if (mineOnOpening?.phase3) {
      for (const attr of mineOnOpening.phase3.player_attribution) {
        if (attr.canonical_player_id === targetId && attr.uncertainty !== "LOW") shadowNotes.push(`Target volatility: ${attr.uncertainty} (shadow signal — not included in trade value).`);
      }
    }

    // Phase 6 (`ri-trade-strategy-2026.2`) — ADDITIVE and opt-in only
    // (`include_strategic`). `recommendOfferTier` can only ever name a tier
    // already present in `ladder` above — it never redefines the ladder or
    // exceeds MAXIMUM_RATIONAL (see lib/trades/strategy/assess.ts).
    let strategicExtra: Partial<NegotiationResponse> = {};
    if (req.include_strategic) {
      try {
        const profile = buildManagerStrategicProfile(ctx, myManagerId, myManagerSlug);
        strategicExtra = { manager_strategic_profile: profile, strategic_offer_guidance: recommendOfferTier(ladder, profile), strategy_version: TRADE_STRATEGY_VERSION };
      } catch {
        diagnostics.push({ code: "STRATEGIC_CONTEXT_UNAVAILABLE", message: "Phase 6 strategic context could not be computed for this request — base negotiation results are unaffected.", severity: "warning" });
      }
    }

    return base(req, {
      status: "OK", mode,
      target_dependency: targetDependency,
      leverage,
      offers: ladder,
      sweeteners,
      walk_away: walkAway,
      phase3_shadow: { label: "SHADOW INTELLIGENCE — NOT INCLUDED IN NEGOTIATION VALUE", notes: shadowNotes },
      ...strategicExtra,
      diagnostics: [...diagnostics, { code: "SEARCH_SUMMARY", message: `${candidates_considered} candidate(s) considered, ${frontier_size} on the Pareto frontier.`, severity: "info" }],
    });
  }

  if (mode === "SELL_ASSET") {
    const sellId = req.sell_player_id!;
    const myRoster = ctx.rosters_by_manager.get(myManagerId);
    if (!myRoster?.all_players.includes(sellId)) {
      return base(req, { status: "VALIDATION_FAILED", mode, diagnostics: [{ code: "SELL_PLAYER_NOT_OWNED", message: `You do not own player ${sellId}.`, severity: "error" }] });
    }
    const myDependency = computePlayerDependency(sellId, myRoster, ctx);
    const { results } = runBilateralSearch({
      ctx, evalCtx, config, mode: "BLOCKBUSTER", myManagerId, myManagerSlug, limits: DEFAULT_SEARCH_LIMITS, maxResults: 25,
      constraints: { required_outgoing_player_ids: [sellId], untouchable_player_ids: req.untouchable_player_ids },
    });
    const frontier = paretoFrontier(results, myManagerSlug);
    const ladder = selectOfferTiers(frontier, myManagerSlug);
    const walkAway = analyzeWalkAway({ ladder, myManagerSlug, outgoingDependencies: [myDependency] });
    return base(req, {
      status: "OK", mode,
      target_dependency: myDependency,
      offers: ladder,
      walk_away: walkAway,
      diagnostics: [{ code: "SEARCH_SUMMARY", message: `${results.length} candidate(s) considered, ${frontier.length} on the Pareto frontier.`, severity: "info" }],
    });
  }

  // IMPROVE_OFFER / REDUCE_OVERPAY / COUNTER_PROPOSAL — operate on a supplied proposal
  const proposal = req.proposal!;
  /**
   * Audit fix (§56, P2): a 3+ participant (three-team) proposal was NOT
   * rejected here — `.find()` silently picked the first non-requester
   * participant as "the partner" and proceeded, discarding the rest of the
   * proposal's structure without ever telling the caller a leg was ignored.
   * Phase 5's negotiation modes are explicitly bilateral only (three-team
   * negotiation is out of scope, unlike Phase 4's discovery); a three-team
   * proposal must be explicitly rejected, never silently misinterpreted.
   */
  if (proposal.participants.length !== 2) {
    return base(req, { status: "VALIDATION_FAILED", mode, diagnostics: [{ code: "UNSUPPORTED_PARTICIPANT_COUNT", message: `Negotiation modes IMPROVE_OFFER/REDUCE_OVERPAY/COUNTER_PROPOSAL support bilateral (2-participant) proposals only; received ${proposal.participants.length}. Three-team negotiation is not supported.`, severity: "error" }] });
  }
  const partnerId = proposal.participants.find((p) => p !== myManagerId);
  if (!partnerId) {
    return base(req, { status: "VALIDATION_FAILED", mode, diagnostics: [{ code: "INVALID_PROPOSAL", message: "proposal.participants must include exactly one partner besides the requester.", severity: "error" }] });
  }

  if (mode === "REDUCE_OVERPAY") {
    const reduced = findOverpayReduction(ctx, evalCtx, config, myManagerId, myManagerSlug, partnerId, proposal.transfers);
    return base(req, { status: "OK", mode, overpay_reduction: reduced, diagnostics: reduced ? [] : [{ code: "NO_REDUCTION_AVAILABLE", message: "Every outgoing asset is load-bearing — removing any one drops the partner below their acceptance floor.", severity: "info" }] });
  }

  // IMPROVE_OFFER and COUNTER_PROPOSAL both use the counter-strategy engine
  const strategy = buildCounterStrategy({ ctx, evalCtx, config, myManagerId, myManagerSlug, originalTransfers: proposal.transfers, untouchablePlayerIds: req.untouchable_player_ids });
  return base(req, { status: "OK", mode, counter_strategy: strategy, diagnostics: strategy.problem === "NO_CONCESSION_NEEDED" ? [{ code: "NO_CONCESSION_NEEDED", message: "The original offer already clears ACCEPT for the partner with positive requester utility — no sweetening recommended.", severity: "info" }] : [] });
}
