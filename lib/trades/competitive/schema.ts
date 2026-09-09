/**
 * Competitive Trade Intelligence — schema (Checkpoint B: Market Edge Layer).
 *
 * This layer NEVER modifies `evaluateTrade`. `evaluateCompetitiveTrade`
 * (`./evaluate.ts`) consumes a finished `TradeEvaluationOutput` as its
 * `baseline` and adds an additive `competitive` block. Blocks for later
 * checkpoints (owner perception, acceptance, extraction, opponent cost,
 * liquidity, appreciation, negotiation) are INTENTIONALLY ABSENT from the type
 * until implemented — never stubbed with fake data.
 *
 * Core Checkpoint B distinction, encoded in the names below:
 *   `MarketEdge`  — where our model's valuation differs from outside-market
 *                   pricing. ANALYTICAL. It does NOT assert the player is
 *                   obtainable, nor at what price, nor that any owner would
 *                   accept. That is Checkpoint C+.
 */

import type { TradeEvaluationOutput } from "../evaluate";

/* ------------------------------------------------------------------ lineage */

export const COMPETITIVE_TRADE_VERSION = "ri-competitive-trade-2026.1" as const;

export type MarketSourceType =
  | "provider_benchmark" // Sleeper / RotoWire weekly+ROS projection (in-season, league scoring)
  | "draft_market" // preseason ADP consensus (Underdog / Yahoo / published / search_rank)
  | "league_draft_value" // this league's own draft — overall pick a player actually cost
  | "owner_draft_anchor"; // which manager drafted the player, and where (feeds Checkpoint C)

export type MarketReadiness = "CURRENT" | "PARTIAL" | "STALE" | "UNAVAILABLE";

export interface MarketSourceRecord {
  source: string;
  source_type: MarketSourceType;
  /** ISO date/label of the data, or null when the source cannot date itself. */
  as_of: string | null;
  /** Scoring format the raw source is expressed in, before normalization. */
  scoring_format: string | null;
  readiness: MarketReadiness;
  /** Raw signal this source contributes, in its own units (overall pick, points, …). */
  raw_value: number | null;
  raw_unit: "overall_pick" | "season_points" | "ros_points" | "weekly_points" | null;
  /** Implied positional rank this source assigns the player (for cross-source dispersion). */
  implied_position_rank: number | null;
  notes: string[];
}

export interface MarketLineage {
  /** Every source consulted for this player — present even when it contributed nothing. */
  sources: MarketSourceRecord[];
  /** The source_type that drove the primary normalized market value. */
  primary_source_type: MarketSourceType | null;
  /** Count of sources that produced a usable positional rank. */
  usable_source_count: number;
  /** MAD of the sources' implied positional ranks (0 with <2 sources). */
  dispersion: number;
  /** Worst readiness across contributing sources (CURRENT > PARTIAL > STALE > UNAVAILABLE). */
  worst_readiness: MarketReadiness;
  scoring_normalization: string;
}

/* --------------------------------------------------------- normalized value */

export type ValueConfidence = "HIGH" | "MEDIUM" | "LOW" | "VERY_LOW";

/**
 * A value expressed on a common, scarcity-aware continuous scale so that
 * "RB7 → RB15" and "RB32 → RB40" are NOT treated as equal moves.
 *
 * `normalized_value` is a within-position z-score of a value-over-replacement
 * basis (see `./normalize.ts`). `percentile` is the same distribution as a
 * 0..1 rank for human explanation. `position_rank` is kept ONLY for
 * explanation — it is never the mathematical input to the edge.
 */
export interface NormalizedValue {
  basis: "weekly_vor" | "ros_weekly_vor" | "ri_ros_weekly_vor" | "unavailable";
  /** raw value on the basis' own scale (weekly league points over replacement, etc.) */
  raw: number | null;
  /** within-position z-score; null when the basis is unavailable */
  normalized_value: number | null;
  /** 0..1 within-position percentile (for explanation) */
  percentile: number | null;
  /** within-position rank (1 = best) — EXPLANATION ONLY */
  position_rank: number | null;
  confidence: ValueConfidence;
  as_of: string | null;
  model_version: string | null;
}

/* ------------------------------------------------------------- market edge */

export type MarketEdgeDirection =
  | "STRONG_BUY"
  | "BUY"
  | "FAIR"
  | "SELL"
  | "STRONG_SELL"
  | "INSUFFICIENT_DATA";

/**
 * Reason codes — repo-native style (see `lib/trades/schema.ts` diagnostic codes).
 */
export type MarketEdgeReasonCode =
  | "PRIVATE_ABOVE_MARKET"
  | "MARKET_ABOVE_PRIVATE"
  | "VALUES_ALIGN"
  | "MARKET_DATA_UNAVAILABLE"
  | "PRIVATE_VALUE_UNAVAILABLE"
  | "PRIVATE_VALUE_LOW_CONFIDENCE"
  | "MARKET_DATA_STALE"
  | "MARKET_DATA_PARTIAL"
  | "MARKET_SOURCE_DISAGREEMENT"
  | "SCORING_FORMAT_MISMATCH"
  | "POSITION_SCARCITY_AMPLIFIES"
  | "POSITION_DEPTH_DAMPENS"
  | "CONFIDENCE_GATE_APPLIED"
  | "SPECULATIVE_LOW_CONFIDENCE"
  | "RI_SLEEPER_DISAGREEMENT_CORROBORATES"
  | "ANALYTICAL_ONLY_NO_ACQUISITION_MODEL";

export interface MarketEdge {
  canonical_player_id: string;
  name: string;
  position: string;
  nfl_team: string | null;

  private_value: NormalizedValue;
  market_value: NormalizedValue | null; // null ⇒ INSUFFICIENT_DATA

  direction: MarketEdgeDirection;
  /**
   * Signed magnitude of the mispricing on the normalized scale, AFTER position
   * scarcity weighting but BEFORE the confidence actionability factor.
   * Positive ⇒ we value the player above market (buy-side); negative ⇒ market
   * above us (sell-side). `null` when direction is INSUFFICIENT_DATA.
   */
  edge_score: number | null;
  /**
   * `edge_score` scaled by the confidence actionability factor — the number to
   * RANK by. Low-confidence discrepancies rank below high-confidence ones of
   * the same raw magnitude (Checkpoint B monotonicity requirement).
   */
  actionable_edge: number | null;
  confidence: ValueConfidence;

  reason_codes: MarketEdgeReasonCode[];
  reasons: string[];
  lineage: MarketLineage;

  /** Always true for Checkpoint B — there is no acquisition/perception model yet. */
  analytical_only: true;
}

/* --------------------------------------------------------------- readiness */

export type CompetitiveCapabilityState = "READY" | "PARTIAL" | "UNAVAILABLE";

export interface CompetitiveCapability {
  state: CompetitiveCapabilityState;
  reasons: string[];
}

export interface CompetitiveReadiness {
  /** Overall — UNAVAILABLE if any REQUIRED capability is UNAVAILABLE. */
  overall: CompetitiveCapabilityState;
  private_projection: CompetitiveCapability;
  market_data: CompetitiveCapability;
  scoring_compatible: CompetitiveCapability;
  player_identity: CompetitiveCapability;
  ownership: CompetitiveCapability;
  /** Human summary of what a partial/unavailable state means for the output. */
  summary: string;
}

/* -------------------------------------------------------------- the boards */

/**
 * Checkpoint-B sell-side label. Deliberately NOT the eventual strategic labels
 * (CORE_HOLD / LIQUID_TRADE_CHIP / SPECULATIVE_HOLD) — those need the
 * liquidity + strategy layers (later checkpoints). This label answers ONE
 * question: does outside-market pricing exceed our private valuation enough to
 * create potential trade leverage?
 */
export type SellSignal =
  | "STRONG_MARKET_SELL"
  | "MARKET_SELL"
  | "FAIR"
  | "HOLD_SIGNAL" // private ≥ market — no sell leverage; not a strategic "hold"
  | "INSUFFICIENT_DATA";

export type BuySignal =
  | "STRONG_MODEL_BUY_CANDIDATE"
  | "MODEL_BUY_CANDIDATE"
  | "FAIR"
  | "NO_DISCOUNT" // market ≥ private
  | "INSUFFICIENT_DATA";

export interface SellBoardEntry {
  edge: MarketEdge;
  signal: SellSignal;
  /** Marks that this is analysis, not a call to trade or drop. */
  status: "ANALYTICAL_ONLY";
}

export interface BuyBoardEntry {
  edge: MarketEdge;
  owner_manager_id: string;
  owner_manager_slug: string;
  signal: BuySignal;
  status: "ANALYTICAL_ONLY";
}

/* ------------------------------------------------ competitive evaluation */

export interface CompetitivePlayerValue {
  canonical_player_id: string;
  name: string;
  position: string;
  nfl_team: string | null;
  direction_for_us: "INCOMING" | "OUTGOING";
  edge: MarketEdge;
}

export interface AggregateEdge {
  /** Σ actionable_edge over incoming players (buy-side we gain). */
  incoming_actionable_edge: number;
  /** Σ actionable_edge over outgoing players (sell-side we give up — negative is bad for us). */
  outgoing_actionable_edge: number;
  /**
   * incoming_actionable_edge − outgoing_actionable_edge. Positive ⇒ we are
   * acquiring more market inefficiency than we surrender. NOT a recommendation.
   */
  net_actionable_edge: number;
  players_with_market_data: number;
  players_missing_market_data: number;
  confidence: ValueConfidence;
}

export interface CompetitiveBlock {
  version: typeof COMPETITIVE_TRADE_VERSION;
  readiness: CompetitiveReadiness;
  assets: {
    outgoing: CompetitivePlayerValue[];
    incoming: CompetitivePlayerValue[];
  };
  market_edge: {
    outgoing: MarketEdge[];
    incoming: MarketEdge[];
    aggregate_edge: AggregateEdge | null; // null when readiness.overall === UNAVAILABLE
  };
  notes: string[];
  // ---- reserved for later checkpoints; ABSENT until implemented:
  //   owner_perception?  (Checkpoint C)
  //   acceptance?        (Checkpoint C)
  //   extraction?        (Checkpoint C)
  //   competitive_cost?  (Checkpoint D)
  //   liquidity?         (Checkpoint F)
  //   appreciation?      (Checkpoint F)
  //   negotiation?       (Checkpoint E)
}

export interface CompetitiveTradeEvaluation {
  baseline: TradeEvaluationOutput;
  competitive: CompetitiveBlock;
}
