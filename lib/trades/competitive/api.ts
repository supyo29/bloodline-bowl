/**
 * Competitive Trade Intelligence — HTTP request orchestrator (Checkpoint G).
 *
 * The single library entry point behind `POST /api/trades/competitive`. It
 * exposes the certified competitive engine WITHOUT weakening its semantics:
 *
 *   - NO_ACTION is a first-class successful result, never an error.
 *   - REVIEW_REQUIRED survives serialization — it is never softened to a
 *     recommendation.
 *   - confidence and readiness are passed through, never upgraded.
 *   - a small negative normalized reservation is described in words
 *     ("very low owner reservation value relative to the league baseline"),
 *     never as raw "-0.41 z" in a human-facing field.
 *
 * ONE league snapshot read per request (`buildTradeAnalysisContext`), then ONE
 * `CompetitiveTradeEvaluationContext` reused across every proposal the mode
 * evaluates — the Checkpoint F performance foundation is preserved end to end.
 *
 * READ-ONLY. This module never submits, accepts, or modifies a trade, never
 * creates a provider transaction, and never sends a message.
 */

import { resolveManager } from "@/lib/canonical/manager-context";
import { runInLeagueStateScope } from "@/lib/canonical/request-scope";
import { snapshotLineage } from "@/lib/canonical/snapshot-lineage";
import type { SnapshotLineage } from "@/lib/canonical/lineage";
import type { CanonicalPlayer } from "@/lib/canonical/schema";
import { buildTradeAnalysisContext } from "../context";
import { resolveTradeConfig } from "../config";
import { buildDiscoveryEvalContext, evaluateCandidate } from "../discovery/candidate-eval";
import { generateStructuralTradeCandidates } from "./candidates";
import {
  buildCompetitiveTradeEvaluationContext,
  assertContextMatchesSnapshot,
  type CompetitiveTradeEvaluationContext,
} from "./eval-context";
import { evaluateCompetitiveTrade } from "./evaluate";
import { evaluateNegotiationEnvelopeInner } from "./negotiation-eval";
import { buildStrategyPathComparison } from "./path-search";
import {
  describeReservationLevel,
  transactionReadiness,
  describeTransactionReadiness,
  COMPETITIVE_TRADE_VERSION,
} from "./schema";
import type { TradeAnalysisContext } from "../context";
import type {
  AcceptanceLikelihood,
  CompetitiveBlock,
  NegotiationAggressiveness,
  StrategyPathComparison,
  TransactionReadiness,
  ValueConfidence,
} from "./schema";

export type { NegotiationAggressiveness } from "./schema";

export const COMPETITIVE_TRADE_API_VERSION = "ri-competitive-trade-api-2026.2" as const;

export type CompetitiveTradeMode = "evaluate" | "negotiate" | "discover" | "strategy_path";

/** how far the analytical layer got — HTTP 200 for every one of these. */
export type CompetitiveApiStatus =
  | "READY"
  | "PARTIAL"
  | "REVIEW_REQUIRED"
  | "NO_ACTION"
  | "VALIDATION_FAILED"
  | "CONTEXT_UNAVAILABLE";

/** distinguishes a bad request from an unavailable-upstream — the route maps this to an HTTP code. */
export type CompetitiveApiErrorKind =
  | "NONE"
  | "MALFORMED"
  | "NOT_FOUND"
  | "OWNERSHIP"
  | "STRUCTURAL"
  | "CONTEXT_UNAVAILABLE"
  | "INTERNAL";

export interface CompetitiveTradeApiRequest {
  league: string;
  manager: string;
  mode: CompetitiveTradeMode;
  /** the other side of an explicit proposal (evaluate / negotiate) */
  counterparty?: string;
  /** ids/slugs/names of players WE give up */
  give_assets?: string[];
  /** ids/slugs/names of players WE receive */
  receive_assets?: string[];
  /** a player we want to acquire (discover / strategy_path focus) */
  target_player?: string;
  negotiation_aggressiveness?: NegotiationAggressiveness;
  search_limits?: {
    max_results?: number;
  };
}

interface Diag {
  code: string;
  message: string;
  severity: "error" | "warning" | "info";
}

export interface CompetitiveTradeApiResponse {
  status: CompetitiveApiStatus;
  error_kind: CompetitiveApiErrorKind;
  mode: CompetitiveTradeMode;
  league_slug: string;
  manager_slug: string | null;
  /** the source snapshot — visible enough to audit whether the answer is stale */
  snapshot: SnapshotLineage | null;
  readiness: string;
  confidence: ValueConfidence | null;
  /**
   * Part B — the one authoritative "should I act on this trade now?" contract,
   * distinct from the competitive classification. Present for evaluate /
   * negotiate; for discover / strategy_path it is the best available across the
   * surfaced candidates.
   */
  transaction_readiness?: TransactionReadiness;
  /** for discover / strategy_path */
  recommended_strategy?: string;
  evaluation?: EvaluateView;
  negotiation?: NegotiationView;
  discovery?: DiscoveryView;
  strategy_paths?: StrategyPathComparison;
  reasons: string[];
  diagnostics: Diag[];
  limitations: string[];
  access: "READ_ONLY_ANALYTICS";
  versions: {
    api: string;
    competitive_engine: string;
    trade_context: string;
    weekly_engine: string;
  };
  generated_at: string;
}

/* ------------------------------------------------------------------ views  */

interface EvaluateView {
  proposal: { give: string[]; receive: string[]; counterparty_manager_slug: string | null };
  private_trade: {
    immediate_impact: number | null;
    permanent_rest_of_season_impact: number | null;
    horizon_classification: string | null;
  };
  market: {
    net_market_edge: number | null;
    outgoing: Array<{ player: string; direction: string; confidence: ValueConfidence }>;
    incoming: Array<{ player: string; direction: string; confidence: ValueConfidence }>;
  };
  counterparty: {
    owner_perceived_value_received: number | null;
    reservation_value_surrendered: number | null;
    reservation_descriptor: string;
    raw_perceived_value_surplus: number | null;
    acceptance_context_adjustments: unknown | null;
    overall_acceptance_likelihood: AcceptanceLikelihood | null;
    accepts_despite_negative_value_perception: boolean;
  } | null;
  opponent: {
    actual_roster_delta: number | null;
    threat_band: string | null;
    threat_relative_to_us: number | null;
    competitive_externality: number | null;
  } | null;
  liquidity: CompetitiveBlock["liquidity"];
  appreciation: CompetitiveBlock["appreciation"];
  buy_and_hold: CompetitiveBlock["hold"];
  result: {
    classification: string | null;
    /**
     * `actionable` = COMPETITIVELY actionable: the trade passes the competitive
     * score + acceptance-feasibility gate. This is NOT the same as "you should
     * execute this trade now" — see `transaction_readiness`.
     */
    actionable: boolean;
    /** the "should I act on this now?" contract (Part B) */
    transaction_readiness: TransactionReadiness;
    transaction_readiness_explanation: string;
    confidence: ValueConfidence | null;
    readiness: string | null;
    reasons: string[];
  };
}

interface NegotiationView {
  base_trade_certified: boolean;
  base_transaction_readiness: TransactionReadiness;
  extraction_band: string;
  opening_offer: unknown;
  target_settlement: unknown;
  acceptable_deal: unknown;
  walk_away: unknown;
  frontier: unknown[];
  internal_explanation: unknown;
  raw_vs_overall_acceptance_note: string;
}

interface DiscoveryCandidate {
  counterparty_manager_slug: string;
  give: string[];
  receive: string[];
  permanent_rest_of_season_impact: number | null;
  overall_acceptance_likelihood: AcceptanceLikelihood | null;
  competitive_classification: string | null;
  /** COMPETITIVELY actionable (passes the competitive gate) — NOT the same as transaction-ready */
  competitively_actionable: boolean;
  transaction_readiness: TransactionReadiness;
  competitive_externality: number | null;
  confidence: ValueConfidence | null;
  reasons: string[];
}

interface DiscoveryView {
  /** analytically positive direct trades — each labelled with its own transaction readiness */
  direct_trade_candidates: DiscoveryCandidate[];
  structural_candidates_evaluated: number;
  analytical_candidate_count: number;
  negotiation_worth_exploring_count: number;
  transaction_ready_count: number;
  note: string;
}

/* ------------------------------------------------------------------- impl  */

const BASE_LIMITATIONS = [
  "Read-only analytics: this endpoint never submits, accepts, or modifies a trade and never sends a message.",
  "Acceptance likelihood is a heuristic — only one real league trade exists to calibrate against.",
  "Opponent threat is a heuristic forward-looking roster-strength estimate.",
  "Market appreciation potential is speculative and is never counted as guaranteed value.",
  "At the start of the season the dynamic in-season market evidence is preseason-only; classifications are correspondingly cautious.",
  "Multi-step trade paths are bounded to a maximum of two completed trades — this is not open-ended graph search.",
];

export interface EvaluateCompetitiveTradeRequestOptions {
  /** test seam — inject a prebuilt context instead of reading league state. */
  contextOverride?: TradeAnalysisContext;
}

export async function evaluateCompetitiveTradeRequest(
  req: CompetitiveTradeApiRequest,
  options: EvaluateCompetitiveTradeRequestOptions = {},
): Promise<CompetitiveTradeApiResponse> {
  return runInLeagueStateScope(() => evaluateInner(req, options));
}

function shell(req: CompetitiveTradeApiRequest, extra: Partial<CompetitiveTradeApiResponse>): CompetitiveTradeApiResponse {
  return {
    status: "VALIDATION_FAILED",
    error_kind: "NONE",
    mode: req.mode,
    league_slug: req.league,
    manager_slug: null,
    snapshot: null,
    readiness: "UNAVAILABLE",
    confidence: null,
    reasons: [],
    diagnostics: [],
    limitations: BASE_LIMITATIONS,
    access: "READ_ONLY_ANALYTICS",
    versions: {
      api: COMPETITIVE_TRADE_API_VERSION,
      competitive_engine: COMPETITIVE_TRADE_VERSION,
      trade_context: "ri-trade-contextual-2026.2",
      weekly_engine: "n/a",
    },
    generated_at: new Date().toISOString(),
    ...extra,
  };
}

async function evaluateInner(
  req: CompetitiveTradeApiRequest,
  options: EvaluateCompetitiveTradeRequestOptions,
): Promise<CompetitiveTradeApiResponse> {
  // ---- context (one snapshot read) ----
  let ctx: TradeAnalysisContext;
  if (options.contextOverride) {
    ctx = options.contextOverride;
  } else {
    const ctxRes = await buildTradeAnalysisContext(req.league);
    if (!ctxRes.context) {
      return shell(req, {
        status: "CONTEXT_UNAVAILABLE",
        error_kind: "CONTEXT_UNAVAILABLE",
        diagnostics: [{ code: ctxRes.code ?? "CONTEXT_UNAVAILABLE", message: ctxRes.detail ?? `Trade-analysis context for "${req.league}" is unavailable.`, severity: "error" }],
      });
    }
    ctx = ctxRes.context;
  }

  const lineage = snapshotLineage(ctx.snapshot);

  const base = (extra: Partial<CompetitiveTradeApiResponse>): CompetitiveTradeApiResponse =>
    shell(req, {
      snapshot: lineage,
      versions: {
        api: COMPETITIVE_TRADE_API_VERSION,
        competitive_engine: COMPETITIVE_TRADE_VERSION,
        trade_context: ctx.versions.trade_context_version,
        weekly_engine: ctx.versions.weekly_engine_version,
      },
      ...extra,
    });

  // ---- requester identity ----
  const me = resolveManager(ctx.snapshot.managers, req.manager);
  if (!me) {
    return base({ status: "VALIDATION_FAILED", error_kind: "NOT_FOUND", diagnostics: [{ code: "UNKNOWN_MANAGER", message: `Manager "${req.manager}" not found in league "${req.league}".`, severity: "error" }] });
  }

  const ownership = new Map<string, string>(); // canonical_player_id -> canonical_team_id
  for (const r of ctx.snapshot.rosters) for (const id of r.all_players) ownership.set(id, r.canonical_team_id);
  const teamManager = new Map<string, string>();
  for (const t of ctx.snapshot.teams) if (t.canonical_manager_ids[0]) teamManager.set(t.canonical_team_id, t.canonical_manager_ids[0]);
  const ownerManagerOf = (pid: string): string | null => {
    const tid = ownership.get(pid);
    return tid ? teamManager.get(tid) ?? null : null;
  };

  const resolvePlayer = (raw: string): CanonicalPlayer | null => {
    const needle = raw.trim().toLowerCase();
    const players = ctx.snapshot.players;
    return (
      players.find((p) => p.canonical_player_id.toLowerCase() === needle) ??
      players.find((p) => Object.values(p.identifiers).some((v) => typeof v === "string" && v.toLowerCase() === needle)) ??
      players.find((p) => p.full_name.toLowerCase() === needle) ??
      null
    );
  };

  // ---- shared evaluation context (built once, reused for every proposal) ----
  const buildEc = (): CompetitiveTradeEvaluationContext => {
    const ec = buildCompetitiveTradeEvaluationContext(ctx);
    assertContextMatchesSnapshot(ec, ctx); // §9 — never evaluate B with A's cached context
    return ec;
  };

  try {
    switch (req.mode) {
      case "evaluate":
        return runEvaluate(req, base, ctx, me, resolvePlayer, ownerManagerOf, buildEc);
      case "negotiate":
        return runNegotiate(req, base, ctx, me, resolvePlayer, ownerManagerOf, buildEc);
      case "discover":
        return runDiscover(req, base, ctx, me, buildEc);
      case "strategy_path":
        return runStrategyPath(req, base, me, buildEc);
      default:
        return base({ status: "VALIDATION_FAILED", error_kind: "MALFORMED", diagnostics: [{ code: "INVALID_MODE", message: `Unknown mode "${String(req.mode)}".`, severity: "error" }] });
    }
  } catch (err) {
    return base({
      status: "CONTEXT_UNAVAILABLE",
      error_kind: "INTERNAL",
      diagnostics: [{ code: "COMPETITIVE_EVALUATION_ERROR", message: err instanceof Error ? err.message : "Unknown error", severity: "error" }],
    });
  }
}

/* ------------------------------------------------------------- evaluate    */

type BaseFn = (extra: Partial<CompetitiveTradeApiResponse>) => CompetitiveTradeApiResponse;
type Manager = ReturnType<typeof resolveManager> & object;

function resolveProposalAssets(
  give: string[] | undefined,
  receive: string[] | undefined,
  resolvePlayer: (raw: string) => CanonicalPlayer | null,
): { giveIds: string[]; receiveIds: string[]; error: Diag | null } {
  const g = give ?? [];
  const r = receive ?? [];
  if (g.length === 0 && r.length === 0) {
    return { giveIds: [], receiveIds: [], error: { code: "EMPTY_PROPOSAL", message: "`give_assets` and `receive_assets` cannot both be empty for this mode.", severity: "error" } };
  }
  const giveIds: string[] = [];
  const receiveIds: string[] = [];
  for (const raw of g) {
    const p = resolvePlayer(raw);
    if (!p) return { giveIds: [], receiveIds: [], error: { code: "UNKNOWN_PLAYER", message: `Outgoing asset "${raw}" could not be resolved to a rostered player.`, severity: "error" } };
    giveIds.push(p.canonical_player_id);
  }
  for (const raw of r) {
    const p = resolvePlayer(raw);
    if (!p) return { giveIds: [], receiveIds: [], error: { code: "UNKNOWN_PLAYER", message: `Incoming asset "${raw}" could not be resolved to a rostered player.`, severity: "error" } };
    receiveIds.push(p.canonical_player_id);
  }
  if (new Set([...giveIds, ...receiveIds]).size !== giveIds.length + receiveIds.length) {
    return { giveIds: [], receiveIds: [], error: { code: "DUPLICATE_ASSET", message: "A player appears on both sides of the trade or twice on one side.", severity: "error" } };
  }
  return { giveIds, receiveIds, error: null };
}

function runEvaluate(
  req: CompetitiveTradeApiRequest,
  base: BaseFn,
  ctx: TradeAnalysisContext,
  me: Manager,
  resolvePlayer: (raw: string) => CanonicalPlayer | null,
  ownerManagerOf: (pid: string) => string | null,
  buildEc: () => CompetitiveTradeEvaluationContext,
): CompetitiveTradeApiResponse {
  const { giveIds, receiveIds, error } = resolveProposalAssets(req.give_assets, req.receive_assets, resolvePlayer);
  if (error) return base({ status: "VALIDATION_FAILED", error_kind: error.code === "UNKNOWN_PLAYER" ? "NOT_FOUND" : "MALFORMED", diagnostics: [error] });

  if (!req.counterparty) {
    return base({ status: "VALIDATION_FAILED", error_kind: "MALFORMED", diagnostics: [{ code: "COUNTERPARTY_REQUIRED", message: "`counterparty` is required for evaluate mode.", severity: "error" }] });
  }
  const cp = resolveManager(ctx.snapshot.managers, req.counterparty);
  if (!cp) return base({ status: "VALIDATION_FAILED", error_kind: "NOT_FOUND", manager_slug: me.manager_slug, diagnostics: [{ code: "UNKNOWN_COUNTERPARTY", message: `Counterparty "${req.counterparty}" not found in league "${req.league}".`, severity: "error" }] });
  if (cp.canonical_manager_id === me.canonical_manager_id) {
    return base({ status: "VALIDATION_FAILED", error_kind: "MALFORMED", manager_slug: me.manager_slug, diagnostics: [{ code: "SAME_MANAGER", message: "The requester and the counterparty must be different managers.", severity: "error" }] });
  }

  // §6 — ownership validation from the snapshot, not caller assertions
  for (const id of giveIds) {
    if (ownerManagerOf(id) !== me.canonical_manager_id) {
      return base({ status: "VALIDATION_FAILED", error_kind: "OWNERSHIP", manager_slug: me.manager_slug, diagnostics: [{ code: "OUTGOING_NOT_OWNED", message: `Outgoing player ${id} is not on ${me.manager_slug}'s roster.`, severity: "error" }] });
    }
  }
  for (const id of receiveIds) {
    if (ownerManagerOf(id) !== cp.canonical_manager_id) {
      return base({ status: "VALIDATION_FAILED", error_kind: "OWNERSHIP", manager_slug: me.manager_slug, diagnostics: [{ code: "INCOMING_NOT_OWNED", message: `Incoming player ${id} is not on ${cp.manager_slug}'s roster.`, severity: "error" }] });
    }
  }

  const ec = buildEc();
  const evalCtx = buildDiscoveryEvalContext(ctx);
  const tradeConfig = resolveTradeConfig();
  const transfers = [
    ...giveIds.map((id) => ({ from_manager_id: me.canonical_manager_id, to_manager_id: cp.canonical_manager_id, canonical_player_id: id })),
    ...receiveIds.map((id) => ({ from_manager_id: cp.canonical_manager_id, to_manager_id: me.canonical_manager_id, canonical_player_id: id })),
  ];
  const cand = evaluateCandidate([me.canonical_manager_id, cp.canonical_manager_id], transfers, ctx, evalCtx, tradeConfig);
  if (!cand.ok || !cand.evaluation) {
    return base({ status: "VALIDATION_FAILED", error_kind: "STRUCTURAL", manager_slug: me.manager_slug, diagnostics: [{ code: "STRUCTURALLY_INVALID", message: cand.rejection_reason ?? "The proposed trade is not structurally valid.", severity: "error" }] });
  }

  const out = evaluateCompetitiveTrade({
    baseline: cand.evaluation,
    ctx,
    my_manager_id: me.canonical_manager_id,
    incoming_player_ids: receiveIds,
    outgoing_player_ids: giveIds,
    counterparty_manager_id: cp.canonical_manager_id,
    eval_context: ec,
    include_liquidity_and_appreciation: true,
  });
  const c = out.competitive;

  const nameOf = (id: string) => ctx.players_by_id.get(id)?.full_name ?? id;
  const acc = c.acceptance ?? null;
  const res = c.competitive_result ?? null;

  const horizonReview =
    c.our_trade_horizons?.horizon_classification === "REVIEW_REQUIRED" ||
    c.appreciation?.some((a) => a.classification === "REVIEW_REQUIRED") === true;
  const txReadiness = transactionReadiness({
    classification: res?.classification ?? null,
    competitively_actionable: res?.actionable ?? false,
    confidence: res?.confidence ?? null,
    acceptance: acc?.overall_acceptance_likelihood ?? acc?.likelihood ?? null,
    permanent_trade_utility: c.our_trade_horizons?.permanent_trade_utility ?? null,
    horizon_review_required: horizonReview,
  });

  const view: EvaluateView = {
    proposal: { give: giveIds.map(nameOf), receive: receiveIds.map(nameOf), counterparty_manager_slug: cp.manager_slug },
    private_trade: {
      immediate_impact: c.our_trade_horizons?.immediate.total_delta ?? null,
      permanent_rest_of_season_impact: c.our_trade_horizons?.permanent_trade_utility ?? null,
      horizon_classification: c.our_trade_horizons?.horizon_classification ?? null,
    },
    market: {
      net_market_edge: c.market_edge.aggregate_edge?.net_actionable_edge ?? null,
      outgoing: c.market_edge.outgoing.map((e) => ({ player: e.name, direction: e.direction, confidence: e.confidence })),
      incoming: c.market_edge.incoming.map((e) => ({ player: e.name, direction: e.direction, confidence: e.confidence })),
    },
    counterparty: acc
      ? {
          owner_perceived_value_received: c.owner_perception?.perceived_incoming_value ?? null,
          reservation_value_surrendered: c.owner_perception?.perceived_outgoing_reservation ?? null,
          reservation_descriptor: describeReservationLevel(c.owner_perception?.perceived_outgoing_reservation ?? null),
          raw_perceived_value_surplus: acc.raw_perceived_value_surplus,
          acceptance_context_adjustments: acc.acceptance_context_adjustments,
          overall_acceptance_likelihood: acc.overall_acceptance_likelihood,
          accepts_despite_negative_value_perception: acc.accepts_despite_negative_value_perception,
        }
      : null,
    opponent: c.opponent_impact
      ? {
          actual_roster_delta: c.opponent_impact.private_delta ?? null,
          threat_band: c.opponent_threat?.band ?? null,
          threat_relative_to_us: c.opponent_threat?.relative_to_us ?? null,
          competitive_externality: c.competitive_externality?.score ?? null,
        }
      : null,
    liquidity: c.liquidity,
    appreciation: c.appreciation,
    buy_and_hold: c.hold,
    result: {
      classification: res?.classification ?? null,
      actionable: res?.actionable ?? false,
      transaction_readiness: txReadiness,
      transaction_readiness_explanation: describeTransactionReadiness(txReadiness),
      confidence: res?.confidence ?? null,
      readiness: res?.readiness ?? null,
      reasons: res?.reasons ?? [],
    },
  };

  // ---- status derivation — preserves the engine's judgment, never inflates it ----
  const reviewRequired = horizonReview;
  const readiness = c.readiness.overall;
  const confidence = res?.confidence ?? c.acceptance?.confidence ?? c.owner_perception?.confidence ?? null;

  let status: CompetitiveApiStatus;
  if (reviewRequired) status = "REVIEW_REQUIRED";
  else if (readiness === "READY") status = "READY";
  else if (readiness === "UNAVAILABLE") status = "PARTIAL";
  else status = "PARTIAL";

  const reasons: string[] = [];
  reasons.push(
    `Competitive classification ${res?.classification ?? "n/a"}; transaction readiness ${txReadiness} — ${describeTransactionReadiness(txReadiness)}. A positive classification does not by itself mean you should execute the trade.`,
  );
  if (res && !res.actionable) reasons.push(`Not competitively actionable: ${res.reasons[0] ?? "see reasons"}.`);
  if (reviewRequired) reasons.push("The season-long and current-week valuations conflict at low confidence — REVIEW_REQUIRED, not a recommendation.");
  if (acc?.accepts_despite_negative_value_perception) {
    reasons.push(
      "The nominal value balance slightly favours what the counterparty surrenders, but roster-fit benefits keep the proposal moderately attractive to them — they would not perceive this as winning on value.",
    );
  }

  return base({
    status,
    error_kind: "NONE",
    manager_slug: me.manager_slug,
    readiness,
    confidence,
    transaction_readiness: txReadiness,
    evaluation: view,
    reasons,
    diagnostics: reviewRequired ? [{ code: "REVIEW_REQUIRED", message: "Conflicting rest-of-season vs current-week valuation at low confidence.", severity: "warning" }] : [],
  });
}

/* ------------------------------------------------------------- negotiate   */

function runNegotiate(
  req: CompetitiveTradeApiRequest,
  base: BaseFn,
  ctx: TradeAnalysisContext,
  me: Manager,
  resolvePlayer: (raw: string) => CanonicalPlayer | null,
  ownerManagerOf: (pid: string) => string | null,
  buildEc: () => CompetitiveTradeEvaluationContext,
): CompetitiveTradeApiResponse {
  const { giveIds, receiveIds, error } = resolveProposalAssets(req.give_assets, req.receive_assets, resolvePlayer);
  if (error) return base({ status: "VALIDATION_FAILED", error_kind: error.code === "UNKNOWN_PLAYER" ? "NOT_FOUND" : "MALFORMED", diagnostics: [error] });
  if (!req.counterparty) return base({ status: "VALIDATION_FAILED", error_kind: "MALFORMED", diagnostics: [{ code: "COUNTERPARTY_REQUIRED", message: "`counterparty` is required for negotiate mode.", severity: "error" }] });
  const cp = resolveManager(ctx.snapshot.managers, req.counterparty);
  if (!cp) return base({ status: "VALIDATION_FAILED", error_kind: "NOT_FOUND", manager_slug: me.manager_slug, diagnostics: [{ code: "UNKNOWN_COUNTERPARTY", message: `Counterparty "${req.counterparty}" not found.`, severity: "error" }] });
  if (cp.canonical_manager_id === me.canonical_manager_id) return base({ status: "VALIDATION_FAILED", error_kind: "MALFORMED", manager_slug: me.manager_slug, diagnostics: [{ code: "SAME_MANAGER", message: "Requester and counterparty must differ.", severity: "error" }] });
  for (const id of giveIds) if (ownerManagerOf(id) !== me.canonical_manager_id) return base({ status: "VALIDATION_FAILED", error_kind: "OWNERSHIP", manager_slug: me.manager_slug, diagnostics: [{ code: "OUTGOING_NOT_OWNED", message: `Outgoing player ${id} is not on ${me.manager_slug}'s roster.`, severity: "error" }] });
  for (const id of receiveIds) if (ownerManagerOf(id) !== cp.canonical_manager_id) return base({ status: "VALIDATION_FAILED", error_kind: "OWNERSHIP", manager_slug: me.manager_slug, diagnostics: [{ code: "INCOMING_NOT_OWNED", message: `Incoming player ${id} is not on ${cp.manager_slug}'s roster.`, severity: "error" }] });

  const ec = buildEc();
  const env = evaluateNegotiationEnvelopeInner({
    ctx,
    my_manager_id: me.canonical_manager_id,
    counterparty_manager_id: cp.canonical_manager_id,
    our_assets: giveIds,
    their_assets: receiveIds,
    aggressiveness: req.negotiation_aggressiveness,
    eval_context: ec,
  });

  const rawSurplus = env.base_proposal.counterparty_perceived_surplus;
  const note =
    rawSurplus != null && rawSurplus < 0
      ? "The nominal value balance slightly favours what the counterparty surrenders; any acceptance is driven by roster fit and need relief, not by their believing they win on value."
      : "The counterparty's raw perceived value surplus and their overall acceptance likelihood are reported separately — do not conflate them.";

  const bp = env.base_proposal;
  const baseTx = transactionReadiness({
    classification: bp.competitive_classification,
    competitively_actionable: env.base_trade_certified,
    confidence: bp.confidence,
    acceptance: bp.acceptance_likelihood,
    permanent_trade_utility: bp.our_permanent_utility,
    horizon_review_required: bp.horizon_classification === "REVIEW_REQUIRED",
  });

  const view: NegotiationView = {
    base_trade_certified: env.base_trade_certified,
    base_transaction_readiness: baseTx,
    extraction_band: env.extraction.band,
    opening_offer: env.opening_offer,
    target_settlement: env.target_settlement,
    acceptable_deal: env.acceptable_deal,
    walk_away: env.walk_away,
    frontier: env.frontier,
    internal_explanation: env.internal_explanation,
    raw_vs_overall_acceptance_note: note,
  };

  const status: CompetitiveApiStatus =
    env.readiness === "EXTRACTION_GATED" ? "REVIEW_REQUIRED" : env.readiness === "BASE_TRADE_ONLY" ? "PARTIAL" : "READY";

  const reasons: string[] = [];
  if (!env.base_trade_certified) reasons.push("The base trade is not certified — no aggressive extraction is offered; only the base deal is analysed.");
  reasons.push(`Base trade transaction readiness: ${baseTx} — ${describeTransactionReadiness(baseTx)}. An opening offer can still be generated for a trade that is only worth exploring.`);
  reasons.push(...env.reasons.slice(0, 2));

  return base({
    status,
    error_kind: "NONE",
    manager_slug: me.manager_slug,
    readiness: env.readiness,
    confidence: env.confidence,
    transaction_readiness: baseTx,
    negotiation: view,
    reasons,
    diagnostics: env.readiness === "EXTRACTION_GATED" ? [{ code: "EXTRACTION_GATED", message: "The base trade did not certify; extraction/negotiation is not offered.", severity: "warning" }] : [],
  });
}

/* ------------------------------------------------------------- discover    */

function runDiscover(
  req: CompetitiveTradeApiRequest,
  base: BaseFn,
  ctx: TradeAnalysisContext,
  me: Manager,
  buildEc: () => CompetitiveTradeEvaluationContext,
): CompetitiveTradeApiResponse {
  const ec = buildEc();
  const tradeConfig = resolveTradeConfig();
  const maxResults = clampInt(req.search_limits?.max_results, 1, 15, 5);

  // structural candidates — this consumes candidates AFTER the shared structural
  // stage but BEFORE the legacy mutual-benefit / partner-acceptance / fairness
  // gate (the competitive-engine invariant).
  const struct = generateStructuralTradeCandidates({
    ctx,
    config: tradeConfig,
    my_manager_id: me.canonical_manager_id,
    max_evaluated: 120,
  });

  const nameOf = (id: string) => ctx.players_by_id.get(id)?.full_name ?? id;
  const candidates: DiscoveryCandidate[] = [];

  for (const cand of struct.candidates) {
    if (cand.my_utility_delta <= 0) continue; // cheap prune before the competitive eval
    // bilateral only for discover
    const parts = cand.package.participant_manager_ids;
    if (parts.length !== 2) continue;
    const cpId = parts.find((p) => p !== me.canonical_manager_id);
    if (!cpId) continue;
    const outgoing = cand.package.transfers.filter((t) => t.from_manager_id === me.canonical_manager_id).map((t) => t.canonical_player_id);
    const incoming = cand.package.transfers.filter((t) => t.to_manager_id === me.canonical_manager_id).map((t) => t.canonical_player_id);
    const out = evaluateCompetitiveTrade({
      baseline: cand.evaluation,
      ctx,
      my_manager_id: me.canonical_manager_id,
      incoming_player_ids: incoming,
      outgoing_player_ids: outgoing,
      counterparty_manager_id: cpId,
      eval_context: ec,
    });
    const c = out.competitive;
    const res = c.competitive_result;
    if (!res) continue;
    // keep analytically positive, non-rejected candidates; the transaction
    // readiness field (not this filter) tells the caller whether to act.
    if (res.classification === "REJECT" || res.classification === "AVOID_COMPETITIVE_COST") continue;
    if (c.our_trade_horizons?.horizon_classification === "REVIEW_REQUIRED") continue;
    if ((c.our_trade_horizons?.permanent_trade_utility ?? 0) <= 0) continue;
    const acceptance = c.acceptance?.overall_acceptance_likelihood ?? c.acceptance?.likelihood ?? null;
    const tx = transactionReadiness({
      classification: res.classification,
      competitively_actionable: res.actionable,
      confidence: res.confidence,
      acceptance,
      permanent_trade_utility: c.our_trade_horizons?.permanent_trade_utility ?? null,
      horizon_review_required: false,
    });
    if (tx === "NOT_RECOMMENDED") continue;
    candidates.push({
      counterparty_manager_slug: ctx.snapshot.managers.find((m) => m.canonical_manager_id === cpId)?.manager_slug ?? cpId,
      give: outgoing.map(nameOf),
      receive: incoming.map(nameOf),
      permanent_rest_of_season_impact: c.our_trade_horizons?.permanent_trade_utility ?? null,
      overall_acceptance_likelihood: acceptance,
      competitive_classification: res.classification,
      competitively_actionable: res.actionable,
      transaction_readiness: tx,
      competitive_externality: c.competitive_externality?.score ?? null,
      confidence: res.confidence,
      reasons: res.reasons.slice(0, 2),
    });
  }

  const RANK: Record<TransactionReadiness, number> = { TRANSACTION_READY: 3, NEGOTIATION_WORTH_EXPLORING: 2, EXPLORATORY: 1, REVIEW_REQUIRED: 0, NOT_RECOMMENDED: 0 };
  candidates.sort(
    (a, b) => RANK[b.transaction_readiness] - RANK[a.transaction_readiness] || (b.permanent_rest_of_season_impact ?? 0) - (a.permanent_rest_of_season_impact ?? 0),
  );
  const top = candidates.slice(0, maxResults);
  const transactionReady = top.filter((t) => t.transaction_readiness === "TRANSACTION_READY");

  const view: DiscoveryView = {
    direct_trade_candidates: top,
    structural_candidates_evaluated: struct.evaluated,
    analytical_candidate_count: candidates.length,
    negotiation_worth_exploring_count: candidates.filter((t) => t.transaction_readiness === "NEGOTIATION_WORTH_EXPLORING").length,
    transaction_ready_count: candidates.filter((t) => t.transaction_readiness === "TRANSACTION_READY").length,
    note:
      "Competitive discovery consumes structurally valid candidates BEFORE the legacy mutual-benefit / partner-acceptance / fairness gate — asymmetric 'we gain more than they perceive' trades are retained. Each candidate carries its own `transaction_readiness`: EXPLORATORY / NEGOTIATION_WORTH_EXPLORING candidates are leads to investigate, NOT deals to execute. Only a TRANSACTION_READY candidate clears full confidence + acceptance gates.",
  };

  if (top.length === 0) {
    return base({
      status: "NO_ACTION",
      error_kind: "NONE",
      manager_slug: me.manager_slug,
      readiness: "READY",
      confidence: null,
      transaction_readiness: "NOT_RECOMMENDED",
      recommended_strategy: "NO_ACTION",
      discovery: view,
      reasons: [
        `No analytically positive direct trade was found for ${me.manager_slug} from ${struct.evaluated} structurally valid candidates.`,
        "Doing nothing is a legitimate analytical result — it does not mean the analysis failed. Common causes early in the season: preseason-only market evidence, insufficient permanent rest-of-season gain, weak counterparty acceptance, low confidence, or an unresolved model disagreement.",
      ],
    });
  }

  const bestTx = top[0]!.transaction_readiness;
  const reasons: string[] = [
    `${candidates.length} analytically positive direct trade candidate(s) for ${me.manager_slug}: ${view.transaction_ready_count} transaction-ready, ${view.negotiation_worth_exploring_count} worth exploring, the rest exploratory leads. Best permanent rest-of-season impact ${(top[0]!.permanent_rest_of_season_impact ?? 0).toFixed(2)} weekly-equivalent.`,
  ];
  if (transactionReady.length === 0) {
    reasons.push(
      "None of these clears full transaction readiness — confidence and/or counterparty acceptance are too weak to recommend executing a trade now. Use these as negotiation leads (mode 'negotiate') rather than as trades to send.",
    );
  }

  return base({
    status: "READY",
    error_kind: "NONE",
    manager_slug: me.manager_slug,
    readiness: "READY",
    confidence: top[0]!.confidence,
    transaction_readiness: bestTx,
    // §24/§25 — the top-level strategy is DIRECT_ACQUISITION only when at least
    // one candidate is genuinely transaction-ready. Otherwise the best current
    // strategy is still NO_ACTION and the candidates are leads to investigate,
    // not deals to execute — this is what keeps discover and strategy_path
    // consistent.
    recommended_strategy: transactionReady.length > 0 ? "DIRECT_ACQUISITION" : "NO_ACTION",
    discovery: view,
    reasons,
  });
}

/* --------------------------------------------------------- strategy path   */

function runStrategyPath(
  req: CompetitiveTradeApiRequest,
  base: BaseFn,
  me: Manager,
  buildEc: () => CompetitiveTradeEvaluationContext,
): CompetitiveTradeApiResponse {
  const ec = buildEc();
  const comparison = buildStrategyPathComparison({ ec, my_manager_id: me.canonical_manager_id });

  let recommended = comparison.recommended;
  let recPath = comparison.paths.find((p) => p.strategy === recommended);
  const reconciledReasons: string[] = [];

  // §17/§25 — the strategy layer is authoritative for a *full action*
  // recommendation. A trade path that the beam search ranked first but whose
  // confidence is below MEDIUM or whose path feasibility is below MODERATE is
  // NOT a transaction-ready recommendation — demote it to NO_ACTION here (the
  // path itself stays visible in `strategy_paths`).
  const CONF_RANK: Record<string, number> = { VERY_LOW: 0, LOW: 1, MEDIUM: 2, HIGH: 3 };
  const FEAS_RANK: Record<string, number> = { VERY_LOW: 0, LOW: 1, MODERATE: 2, HIGH: 3 };
  const isTrade = recommended === "DIRECT_ACQUISITION" || recommended === "TWO_STEP_UPGRADE" || recommended === "BUY_AND_HOLD" || recommended === "INTERMEDIATE_TRADE";
  if (isTrade && recPath) {
    const confOk = (CONF_RANK[recPath.confidence] ?? 0) >= 2;
    const feasOk = (FEAS_RANK[recPath.aggregate.feasibility] ?? 0) >= 2;
    if (!confOk || !feasOk) {
      reconciledReasons.push(
        `The highest-ranked path (${recommended}) is analytically positive but does not clear full transaction readiness (confidence ${recPath.confidence}, path feasibility ${recPath.aggregate.feasibility}) — the recommended action is NO_ACTION; the path stays visible as a lead.`,
      );
      recommended = "NO_ACTION";
      recPath = comparison.paths.find((p) => p.strategy === "NO_ACTION");
    }
  }

  const status: CompetitiveApiStatus =
    recommended === "NO_ACTION" || recommended === "HOLD_CURRENT_ASSET"
      ? "NO_ACTION"
      : recommended === "REVIEW_REQUIRED"
        ? "REVIEW_REQUIRED"
        : "READY";

  const txReadiness: TransactionReadiness =
    recommended === "NO_ACTION" || recommended === "HOLD_CURRENT_ASSET"
      ? "NOT_RECOMMENDED"
      : recommended === "REVIEW_REQUIRED"
        ? "REVIEW_REQUIRED"
        : "TRANSACTION_READY";

  const reasons = [...reconciledReasons, ...comparison.reasons.slice(0, 3)];
  if (status === "NO_ACTION") {
    // §25/§30 — reconcile with discover: a NO_ACTION recommendation does not
    // mean there are no analytically positive direct trades, only that none
    // clears full transaction readiness.
    reasons.push(
      "This does not mean no attractive trade candidates exist. Positive direct-trade candidates may still be surfaced by mode 'discover' — they just do not clear full transaction readiness (confidence and/or counterparty acceptance are too weak) to be recommended as an action now.",
    );
  }

  return base({
    status,
    error_kind: "NONE",
    manager_slug: me.manager_slug,
    readiness: comparison.readiness,
    confidence: recPath?.confidence ?? null,
    transaction_readiness: txReadiness,
    recommended_strategy: recommended,
    strategy_paths: comparison,
    reasons,
    diagnostics:
      status === "NO_ACTION"
        ? [{ code: "NO_ACTION_IS_A_RESULT", message: "The strongest strategy is to make no trade (or hold a current asset). Analytically positive candidates may still exist under mode 'discover'; they are leads, not transaction-ready recommendations.", severity: "info" }]
        : [],
  });
}

function clampInt(v: number | undefined, lo: number, hi: number, dflt: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return dflt;
  return Math.max(lo, Math.min(hi, Math.round(v)));
}
