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

export const COMPETITIVE_TRADE_VERSION = "ri-competitive-trade-2026.2" as const;

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
  | "ANALYTICAL_ONLY_NO_ACQUISITION_MODEL"
  // ---- Checkpoint B.5: dynamic market / evidence maturation ----
  | "PRIVATE_MARKET_HORIZON_MISMATCH"
  | "STALE_MARKET_HORIZON"
  | "ROS_NORMALIZATION_UNAVAILABLE"
  | "REMAINING_GAMES_UNKNOWN"
  | "PRESEASON_PRIOR_DOMINATES"
  | "CURRENT_SEASON_EVIDENCE_THIN"
  | "CURRENT_SEASON_EVIDENCE_MATURING"
  | "MARKET_CORRECTED"
  | "MARKET_PARTIALLY_CORRECTED"
  | "MARKET_NOT_CORRECTED"
  | "MARKET_OVERSHOT"
  | "MARKET_TRAJECTORY_RISING"
  | "MARKET_TRAJECTORY_FALLING"
  | "USAGE_BREAKOUT_SUPPORTS_PRIVATE"
  | "SCORING_BREAKOUT_MOVES_MARKET"
  | "OPPONENT_ADJUSTED_OUTPERFORMANCE"
  | "WEAK_SCHEDULE_INFLATION"
  | "TOUCHDOWN_MIRAGE_RISK"
  | "PRIVATE_MARKET_DIVERGENCE_EXTREME"
  | "PROVIDER_ROS_ANOMALY"
  | "PRIVATE_PROJECTION_ANOMALY"
  | "SOURCE_DISAGREEMENT_EXTREME"
  | "INSUFFICIENT_CURRENT_EVIDENCE"
  | "TEMPORAL_BASIS_MISMATCH"
  | "MULTI_SOURCE_CORROBORATION"
  | "REVIEW_REQUIRED_UNSUPPORTED_CONVICTION";

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

  // ---- Checkpoint B.5 additive fields (absent ⇒ Checkpoint B static edge) ----
  /**
   * Data-quality gate on the edge itself. `REVIEW_REQUIRED` means an extreme
   * discrepancy is not supported by confidence — treat as a possible model /
   * source problem, NOT an automatic high-conviction trade.
   */
  quality_status?: QualityStatus;
  /** the edge vs the preseason market prior (ADP / league draft cost) */
  edge_vs_preseason_market?: number | null;
  /** the edge vs the dynamic current-market proxy (the B.5 primary comparison) */
  edge_vs_current_market?: number | null;
  /** has the market already moved toward our earlier private view? */
  market_correction?: MarketCorrectionStatus;
  market_trajectory?: MarketTrajectory;
  /** how mature / recency-weighted the evidence behind this edge is */
  temporal?: TemporalContext;
}

/* -------------------------------------------- Checkpoint B.5: time awareness */

export type QualityStatus = "NORMAL" | "CAUTION" | "REVIEW_REQUIRED";

export type MarketCorrectionStatus =
  | "MARKET_NOT_CORRECTED"
  | "MARKET_PARTIALLY_CORRECTED"
  | "MARKET_CORRECTED"
  | "MARKET_OVERSHOT"
  | "UNKNOWN";

export type MarketTrajectory =
  | "RISING_FAST"
  | "RISING"
  | "STABLE"
  | "FALLING"
  | "FALLING_FAST"
  | "UNKNOWN";

/**
 * How far into the season the evidence is, and how much authority current-season
 * data carries relative to the preseason prior. `meaningful_games_observed` is
 * NOT the NFL week — it is games the player was actually in a real role.
 */
export interface TemporalContext {
  as_of_week: number;
  season: number;
  meaningful_games_observed: number;
  games_source:
    | "ROLE_OBSERVED_GAMES"
    | "SNAP_GAMES"
    | "GAMES_PLAYED"
    | "WEEK_NUMBER_FALLBACK";
  /** 0..1 — weight on current-season evidence vs the preseason prior (nonlinear in games) */
  season_maturity_weight: number;
  season_maturity_family: SeasonMaturityFamily;
  /** within-season recency: half-life in games for weighting older observations */
  recency_half_life_games: number;
  recency_family: RecencyFamily;
  evidence_readiness: EvidenceReadiness;
  calibration_status: CalibrationStatus;
  reasons: string[];
}

export type SeasonMaturityFamily =
  | "EXPONENTIAL_SATURATION"
  | "LOGISTIC"
  | "LINEAR_CAPPED";

export type RecencyFamily = "EXPONENTIAL_DECAY" | "LINEAR_DECAY" | "UNIFORM";

export type EvidenceReadiness =
  | "PRESEASON_ONLY"
  | "EARLY_SEASON"
  | "PARTIAL_CURRENT"
  | "CURRENT"
  | "STALE"
  | "UNAVAILABLE";

export type CalibrationStatus =
  | "CALIBRATED"
  | "PARTIALLY_CALIBRATED"
  | "DEFAULT_PRIOR"
  | "INSUFFICIENT_CALIBRATION_DATA";

/**
 * Per-component calibration honesty (Checkpoint C §1 correction): the top-level
 * status must NOT imply every dynamic-market component is empirically fitted.
 *   CALIBRATED            — fitted to historical outcomes, beat the baseline OOS
 *   CALIBRATION_UNRESOLVED — attempted, inconclusive (e.g. grid saturated)
 *   HEURISTIC             — a reasoned rule, never fitted
 *   DEFAULT_PRIOR         — the documented fallback parameters
 */
export type ComponentCalibrationStatus =
  | "CALIBRATED"
  | "CALIBRATION_UNRESOLVED"
  | "HEURISTIC"
  | "DEFAULT_PRIOR";

export interface CalibrationComponent {
  status: ComponentCalibrationStatus;
  note: string;
}

/* ---- evidence families (role / efficiency / result / context) ---- */

export type EvidenceFamily = "ROLE" | "EFFICIENCY" | "RESULT" | "CONTEXT";

export interface EvidenceSignal {
  family: EvidenceFamily;
  metric: string;
  /** normalized to a within-position z-ish scale where possible, else raw with `unit` */
  value: number | null;
  unit: string | null;
  games_contributing: number;
  /** recency-weighted where a series was available */
  recency_weighted: boolean;
  source: string;
  as_of_week: number | null;
  notes: string[];
}

export type BreakoutCredibility =
  | "NO_BREAKOUT_SIGNAL"
  | "EARLY_SIGNAL"
  | "EMERGING"
  | "SUPPORTED"
  | "HIGH_CONFIDENCE";

export interface OpponentAdjustedResidual {
  baseline_expected: number | null;
  opponent_adjusted_expected: number | null;
  actual: number | null;
  residual_vs_baseline: number | null;
  residual_vs_opponent_expectation: number | null;
  opponent_difficulty_index: number | null; // −1 (hard) .. +1 (easy), avg over games observed
  games_vs_tough_defenses: number;
  outperformed_tough_count: number;
  notes: string[];
}

/**
 * Time-indexed market state — the four distinct concepts kept physically
 * separate (§7). `current_market_proxy` is an ESTIMATE of current fantasy trade
 * pricing, NOT a measured price and NOT our private forecast.
 */
export interface MarketState {
  canonical_player_id: string;
  as_of_week: number;
  season: number;

  /** A: what the market believed before games (ADP consensus + league draft cost) */
  preseason_market_prior: { position_rank: number | null; normalized_value: number | null; sources: string[] };
  /** current public ROS projection (Sleeper/RotoWire) — a source, not the proxy */
  current_public_projection: { position_rank: number | null; normalized_value: number | null; source: string; readiness: MarketReadiness };
  /** current realized fantasy standing (positional finish / recent rank) */
  current_performance_signal: { season_points_rank: number | null; recent_rank: number | null; games: number };

  /** B: derived estimate of current fantasy-manager trade pricing */
  current_market_proxy: { position_rank: number | null; normalized_value: number | null; components: string[]; is_estimate: true };
  market_trajectory: MarketTrajectory;

  evidence_readiness: EvidenceReadiness;
  confidence: ValueConfidence;
  lineage: MarketLineage;
  /** which source tier drove `current_market_proxy` (§34 hierarchy) */
  proxy_source_tier:
    | "DIRECT_CURRENT_MARKET"
    | "CURRENT_PUBLIC_ROS_CONSENSUS"
    | "CURRENT_PROVIDER_PROJECTION"
    | "CURRENT_PERFORMANCE_PROXY"
    | "PRESEASON_ADP";
}

/**
 * C: our internal forward-looking valuation — physically separate module from
 * `MarketState` so private model knowledge can never leak into the estimated
 * public price.
 */
export interface PrivateForwardValue {
  canonical_player_id: string;
  as_of_week: number;
  remaining_games_expected: number | null;
  prior_value: NormalizedValue;
  /** current-season signals, season-maturity-blended into the prior */
  current_role_signal: number | null;
  current_efficiency_signal: number | null;
  opponent_adjusted_signal: number | null;
  /** the blended forward value on the same within-position z-scale as `NormalizedValue` */
  projected_ros_value: NormalizedValue;
  breakout_credibility: BreakoutCredibility;
  confidence: ValueConfidence;
  reasons: string[];
}

/* ======================================================================== */
/* Checkpoint C — owner-perceived value, reservation price, acceptance        */
/* ======================================================================== */

/**
 * THE Checkpoint C value chain — four DISTINCT concepts:
 *   our private value        (evaluateTrade — what the roster is actually worth to us)
 *   global current market    (B.5 current_market_proxy — what the market appears to think)
 *   owner-perceived value    (global market + this owner's modifiers)
 *   owner reservation price   (owner-perceived + roster-consequence costs of losing him)
 */

export type OwnerContextReadiness =
  | "FULL_OWNER_CONTEXT"
  | "PARTIAL_OWNER_CONTEXT"
  | "GLOBAL_MARKET_ONLY"
  | "STALE"
  | "UNAVAILABLE";

export type DraftAnchorState =
  | "STRONG_ANCHOR"
  | "MODERATE_ANCHOR"
  | "WEAK_ANCHOR"
  | "MINIMAL_ANCHOR"
  | "UNKNOWN";

export type StarterImportance =
  | "LOCKED_STARTER"
  | "REGULAR_STARTER"
  | "FLEX_STARTER"
  | "ROTATIONAL"
  | "BENCH_DEPTH"
  | "IR"
  | "UNKNOWN";

export type AcceptanceLikelihood = "VERY_LOW" | "LOW" | "MODERATE" | "HIGH";

export interface DraftAnchorInfo {
  /** the pick THIS manager spent — round / overall / slot */
  league_draft_round: number | null;
  league_draft_pick: number | null;
  draft_position_z: number | null; // the draft cost as a within-position z (better pick = higher)
  /** consensus ADP-implied positional rank at draft time */
  market_adp_position_rank_at_draft: number | null;
  /** draft_position_z − market-implied z. positive ⇒ reached (drafted ahead of market) */
  draft_reach_delta: number | null;
  anchor_state: DraftAnchorState;
  /** 0..1 — current weight on the personal anchor, decayed by meaningful games */
  anchor_weight: number;
  calibration_status: ComponentCalibrationStatus; // always HEURISTIC / DEFAULT_PRIOR at Checkpoint C
}

export interface OwnerPerceivedValueComponents {
  global_market_baseline: number;
  personal_draft_anchor_adjustment: number;
  starter_importance_adjustment: number;
  recent_performance_salience: number;
  name_salience_adjustment: number;
  behavioral_adjustment: number | null; // null ⇒ insufficient transaction history
}

export interface OwnerPerceivedValue {
  canonical_player_id: string;
  owner_manager_id: string;
  /** starting point — the B.5 dynamic global market value (z within position) */
  global_market_value: number | null;
  /** what this owner likely believes the player is worth (z within position) */
  owner_perceived_value: number | null;
  components: OwnerPerceivedValueComponents;
  starter_importance: StarterImportance;
  draft_anchor: DraftAnchorInfo;
  readiness: OwnerContextReadiness;
  confidence: ValueConfidence;
  reasons: string[];
}

export interface ReservationPriceComponents {
  owner_perceived_value: number;
  /** OUR estimate of the lineup damage if they lose the player — a behavioral proxy, NOT their perceived value */
  replacement_cost: number;
  positional_scarcity_cost: number;
  surplus_discount: number; // ≤ 0
  /** bundle-only: extra cost beyond the sum of individual reservations */
  bundle_nonadditivity: number;
}

export interface ReservationPrice {
  /** one or more outgoing assets from the SAME owner */
  canonical_player_ids: string[];
  owner_manager_id: string;
  /** minimum perceived value the owner would likely need to give these up (z within position, summed) */
  reservation_price: number | null;
  /** Σ owner_perceived_value of the assets (for the perceived ledger) */
  perceived_value: number | null;
  components: ReservationPriceComponents;
  readiness: OwnerContextReadiness;
  confidence: ValueConfidence;
  reasons: string[];
}

export interface PerceivedLedgerSide {
  entries: Array<{ canonical_player_id: string; name: string; value: number | null; approx_points: number | null }>;
  total: number | null;
}

export interface CounterpartyPerceivedLedger {
  owner_manager_id: string;
  /** what they perceive they RECEIVE (our outgoing) — owner-perceived value */
  received: PerceivedLedgerSide;
  /** what they perceive they SURRENDER (our incoming) — reservation value */
  surrendered: PerceivedLedgerSide;
  /** received.total − surrendered.total */
  perceived_surplus: number | null;
}

export interface AcceptanceComponents {
  perceived_surplus: number;
  need_relief: number; // ≥ 0 — incoming assets fill their startable gaps
  roster_slot_pressure: number; // ≤ 0 — net asset gain forces drops
  structure_fit: number; // ± — consolidation vs fragmentation given their depth
  market_trajectory_adjustment: number;
}

export interface AcceptanceEstimate {
  owner_manager_id: string;
  perceived_ledger: CounterpartyPerceivedLedger;
  likelihood: AcceptanceLikelihood;
  /** internal, deterministic, decomposed — NOT a probability, never shown as % */
  internal_score: number;
  components: AcceptanceComponents;
  /** distinct from `likelihood` (§33): how much we trust this estimate */
  confidence: ValueConfidence;
  readiness: OwnerContextReadiness;
  /** heuristic, not calibrated — only 1 real trade exists */
  calibration_status: "INSUFFICIENT_TRADE_HISTORY";
  reasons: string[];
}

export interface OwnerPerceptionBlock {
  counterparty_id: string;
  readiness: OwnerContextReadiness;
  perceived_asset_values: OwnerPerceivedValue[]; // our OUTGOING (they receive) + our INCOMING (they give)
  reservation: ReservationPrice[]; // bundled by the incoming (their-side) assets
  perceived_incoming_value: number | null; // they receive
  perceived_outgoing_reservation: number | null; // they give
  perceived_surplus: number | null;
  confidence: ValueConfidence;
  reasons: string[];
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

  // ---- Checkpoint C (present only when a counterparty was supplied) ----
  /** what THIS counterparty likely believes each traded player is worth + their reservation price */
  owner_perception?: OwnerPerceptionBlock;
  /** how likely the counterparty is to accept — from THEIR perceived economics, heuristic */
  acceptance?: AcceptanceEstimate;

  // ---- reserved for later checkpoints; ABSENT until implemented:
  //   extraction?        (Checkpoint C+ / negotiation)
  //   competitive_cost?  (Checkpoint D)
  //   liquidity?         (Checkpoint F)
  //   appreciation?      (Checkpoint F)
  //   negotiation?       (Checkpoint E)
}

export interface CompetitiveTradeEvaluation {
  baseline: TradeEvaluationOutput;
  competitive: CompetitiveBlock;
}
