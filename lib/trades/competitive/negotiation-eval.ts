/**
 * Competitive Trade Intelligence — Checkpoint E orchestrator.
 *
 * Wires `evaluateCompetitiveTrade` (which already produces permanent utility,
 * perceived surplus, acceptance, opponent impact and competitive externality)
 * into the value-extraction + negotiation-frontier logic. Every frontier point
 * is a full re-evaluation. Read-only; nothing is persisted or sent.
 */

import { runInLeagueStateScope } from "@/lib/canonical/request-scope";
import type { TradeAnalysisContext } from "../context";
import { resolveTradeConfig, type TradeConfig } from "../config";
import { buildDiscoveryEvalContext, evaluateCandidate } from "../discovery/candidate-eval";
import { evaluateCompetitiveTrade, buildLeagueMarketEdgeTable, type LeagueMarketEdgeTable } from "./evaluate";
import { buildDynamicMarketEdges } from "./dynamic";
import { buildLeagueThreat } from "./threat";
import { DEFAULT_COMPETITIVE_D_CONFIG } from "./config";
import { makeOwnerContextCache } from "./owner-context";
import {
  buildValueExtraction,
  baseTradeCertified,
  type BaseTradeSummary,
} from "./extraction";
import { buildNegotiationFrontier } from "./negotiation";
import {
  resolveNegotiationConfig,
  type NegotiationConfig,
  type PartialNegotiationConfig,
} from "./config";
import type {
  CompetitiveTradeEvaluation,
  NegotiationAggressiveness,
  NegotiationEnvelope,
  NegotiationProposal,
  ThreatBand,
  ValueConfidence,
} from "./schema";

export interface NegotiationEvalInput {
  ctx: TradeAnalysisContext;
  my_manager_id: string;
  counterparty_manager_id: string;
  /** the BASE trade — ids WE give up / receive */
  our_assets: string[];
  their_assets: string[];
  aggressiveness?: NegotiationAggressiveness;
  config?: PartialNegotiationConfig;
  /** reuse the league market-edge table across frontier points */
  precomputed?: LeagueMarketEdgeTable;
}

function toProposal(
  label: string,
  ourAssets: string[],
  theirAssets: string[],
  ev: CompetitiveTradeEvaluation | null,
): NegotiationProposal {
  if (!ev) {
    return {
      label, our_assets: ourAssets, their_assets: theirAssets,
      our_permanent_utility: null, counterparty_perceived_surplus: null, counterparty_reservation_burden: null,
      acceptance_likelihood: null, opponent_actual_impact: null, competitive_externality: null,
      competitive_classification: null, confidence: "VERY_LOW", horizon_classification: null,
      dominated: false, extraction_efficiency: null,
      reason_codes: [], reasons: ["proposal is structurally invalid or could not be evaluated"],
    };
  }
  const c = ev.competitive;
  return {
    label,
    our_assets: ourAssets,
    their_assets: theirAssets,
    our_permanent_utility: c.our_trade_horizons?.permanent_trade_utility ?? null,
    counterparty_perceived_surplus: c.owner_perception?.perceived_surplus ?? null,
    counterparty_reservation_burden: c.owner_perception?.perceived_outgoing_reservation ?? null,
    acceptance_likelihood: c.acceptance?.likelihood ?? null,
    opponent_actual_impact: c.opponent_impact?.private_delta ?? null,
    competitive_externality: c.competitive_externality?.score ?? null,
    competitive_classification: c.competitive_result?.classification ?? null,
    confidence: c.competitive_result?.confidence ?? c.acceptance?.confidence ?? "VERY_LOW",
    horizon_classification: c.our_trade_horizons?.horizon_classification ?? null,
    dominated: false,
    extraction_efficiency: null,
    reason_codes: [],
    reasons: [],
  };
}

export function evaluateNegotiationEnvelope(input: NegotiationEvalInput): Promise<NegotiationEnvelope> {
  return runInLeagueStateScope(() => Promise.resolve(evaluateNegotiationEnvelopeInner(input)));
}

export function evaluateNegotiationEnvelopeInner(input: NegotiationEvalInput): NegotiationEnvelope {
  const { ctx, my_manager_id, counterparty_manager_id } = input;
  const config: NegotiationConfig = resolveNegotiationConfig(input.config);
  const aggressiveness: NegotiationAggressiveness = input.aggressiveness ?? "AGGRESSIVE_BUT_CREDIBLE";
  const tradeConfig: TradeConfig = resolveTradeConfig();

  const table = input.precomputed ?? buildLeagueMarketEdgeTable(ctx);
  const dyn = buildDynamicMarketEdges({ table, season: ctx.season, as_of_week: ctx.week, remaining_games_expected: Math.max(1, ctx.ros.weeks.length), config: table.config });
  const evalCtx = buildDiscoveryEvalContext(ctx);
  const ownerCache = makeOwnerContextCache(ctx);
  const threat = buildLeagueThreat(ctx, DEFAULT_COMPETITIVE_D_CONFIG, my_manager_id, ownerCache);
  const cpThreatBand: ThreatBand = threat.by_manager.get(counterparty_manager_id)?.band ?? "MODERATE";

  const evaluateProposal = (ourAssets: string[], theirAssets: string[], label: string): NegotiationProposal | null => {
    const transfers = [
      ...ourAssets.map((id) => ({ from_manager_id: my_manager_id, to_manager_id: counterparty_manager_id, canonical_player_id: id })),
      ...theirAssets.map((id) => ({ from_manager_id: counterparty_manager_id, to_manager_id: my_manager_id, canonical_player_id: id })),
    ];
    const res = evaluateCandidate([my_manager_id, counterparty_manager_id], transfers, ctx, evalCtx, tradeConfig);
    if (!res.ok || !res.evaluation) return null;
    const comp = evaluateCompetitiveTrade({
      baseline: res.evaluation,
      ctx,
      my_manager_id,
      incoming_player_ids: theirAssets,
      outgoing_player_ids: ourAssets,
      counterparty_manager_id,
      precomputed: table,
      owner_context_cache: ownerCache,
    });
    return toProposal(label, ourAssets, theirAssets, comp);
  };

  // ---- base proposal ----
  const base = evaluateProposal(input.our_assets, input.their_assets, "base") ?? toProposal("base", input.our_assets, input.their_assets, null);

  const baseSummary: BaseTradeSummary = {
    our_permanent_utility: base.our_permanent_utility,
    our_horizon_classification: base.horizon_classification ?? "MIXED",
    counterparty_perceived_surplus: base.counterparty_perceived_surplus,
    acceptance_likelihood: base.acceptance_likelihood,
    competitive_classification: base.competitive_classification,
    confidence: base.confidence,
    base_market_edge: null,
  };

  const cert = baseTradeCertified(baseSummary, config);

  const extraction = buildValueExtraction({
    ctx,
    base: baseSummary,
    counterparty: ownerCache(counterparty_manager_id),
    base_their_assets: input.their_assets,
    base_our_assets: input.our_assets,
    us: ownerCache(my_manager_id),
    market_edges: dyn.by_player,
    counterparty_threat_band: cpThreatBand,
    config,
    aggressiveness,
  });

  const fr = buildNegotiationFrontier({ base, extraction, evaluateProposal, config });

  // ---- readiness / confidence ----
  const readiness: NegotiationEnvelope["readiness"] = !cert.ok
    ? extraction.band === "EXTRACTION_GATED"
      ? "EXTRACTION_GATED"
      : "BASE_TRADE_ONLY"
    : extraction.ranked_secondary_assets.length === 0
      ? "BASE_TRADE_ONLY"
      : fr.frontier.length > 1
        ? "FULL_EXTRACTION_CONTEXT"
        : "PARTIAL_EXTRACTION_CONTEXT";

  const confidence: ValueConfidence = base.confidence;

  // ---- internal explanation (§73) ----
  const internal = {
    why_base_worth_pursuing: cert.ok
      ? [
          `permanent rest-of-season roster gain +${base.our_permanent_utility?.toFixed(2)} weekly-equivalent`,
          base.competitive_classification ? `competitive result: ${base.competitive_classification}` : "",
          `confidence: ${base.confidence}`,
        ].filter(Boolean)
      : cert.reasons,
    why_they_may_accept: base.counterparty_perceived_surplus != null
      ? [
          `their perceived ledger favours them by ${base.counterparty_perceived_surplus.toFixed(2)} (owner-perceived value received vs their reservation price)`,
          `acceptance likelihood: ${base.acceptance_likelihood}`,
        ]
      : ["counterparty perception unavailable"],
    why_more_can_be_requested:
      extraction.band === "EXTRACTION_GATED" || extraction.band === "NO_EXTRACTION_ROOM"
        ? []
        : [
            `the counterparty perceives ~${(base.counterparty_perceived_surplus ?? 0).toFixed(2)} of surplus in a straight swap`,
            ...extraction.ranked_secondary_assets.slice(0, 2).map(
              (a) => `${a.name} is ${a.their_starter_importance.replace("_", " ").toLowerCase()} for them (reservation ${a.their_reservation?.toFixed(2)}) but worth ${a.our_private_value?.toFixed(2)} to us`,
            ),
          ],
    why_the_frontier_stops: fr.why_stops,
  };

  return {
    readiness,
    confidence,
    aggressiveness,
    base_proposal: base,
    base_trade_certified: cert.ok,
    extraction,
    frontier: fr.frontier,
    opening_offer: cert.ok ? fr.opening : base,
    target_settlement: cert.ok ? fr.target : base,
    acceptable_deal: cert.ok ? fr.acceptable : base,
    walk_away: fr.walk_away,
    reason_codes: [...new Set([...extraction.reason_codes, ...fr.reason_codes])],
    reasons: [...extraction.reasons, ...fr.reasons],
    internal_explanation: internal,
  };
}

