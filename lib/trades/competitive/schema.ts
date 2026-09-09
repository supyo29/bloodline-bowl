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
  /** Checkpoint D §36 — true when a sanity bound clamped the reservation */
  sanity_floor_applied: boolean;
  /**
   * Checkpoint F §72 — human-facing phrasing of the reservation level. The
   * normalized scale is centered, so a reservation can be a small negative
   * number; that means "very low owner reservation value relative to the league
   * baseline", NEVER "the owner assigns this player negative fantasy value".
   * Consumers rendering text for a human MUST use this string, not the raw z.
   */
  reservation_descriptor: string;
  readiness: OwnerContextReadiness;
  confidence: ValueConfidence;
  reasons: string[];
}

/** §72 — safe human phrasing for a centered-scale reservation value. */
export function describeReservationLevel(z: number | null): string {
  if (z == null) return "owner reservation value could not be estimated";
  if (z >= 1.0) return "very high owner reservation value relative to league baseline";
  if (z >= 0.35) return "high owner reservation value relative to league baseline";
  if (z >= -0.15) return "around the league-baseline owner reservation value";
  if (z >= -0.6) return "low owner reservation value relative to league baseline";
  return "very low owner reservation value relative to league baseline";
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
  /**
   * Checkpoint F §73 — raw perceived value surplus BEFORE any acceptance-context
   * adjustments (owner-perceived value received − reservation surrendered).
   * A NEGATIVE value here means the counterparty does NOT believe they win on
   * pure value; any positive acceptance is then driven by the context
   * adjustments below, not by their thinking they are "winning the trade".
   */
  raw_perceived_value_surplus: number | null;
  /**
   * Checkpoint F §73 — the non-value factors that move acceptance away from the
   * raw perceived-value surplus (need relief, roster-slot pressure, structure
   * fit, market trajectory), and their signed total.
   */
  acceptance_context_adjustments: {
    need_relief: number;
    roster_slot_pressure: number;
    structure_fit: number;
    market_trajectory_adjustment: number;
    total: number;
  };
  /** Checkpoint F §73 — alias of `likelihood`: the blended feasibility after context. */
  overall_acceptance_likelihood: AcceptanceLikelihood;
  /**
   * Checkpoint F §73 — true when raw_perceived_value_surplus < 0 but
   * overall_acceptance_likelihood is MODERATE or better. Consumers MUST NOT then
   * say "they think they are winning on value".
   */
  accepts_despite_negative_value_perception: boolean;
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

/* ======================================================================== */
/* Checkpoint D.5 — horizon-aware permanent-trade utility                     */
/* ======================================================================== */

/**
 * A start/sit decision asks "who helps me THIS WEEK?". A permanent trade asks
 * "which set of player rights gives me the stronger roster over the REMAINING
 * SEASON?". These are different problems. `evaluateTrade`'s
 * `roster_utility_delta` measures the immediate week; this block adds the ROS
 * horizon and the blended permanent-trade utility.
 */

export type HorizonClassification =
  | "CONSISTENT_POSITIVE"
  | "CONSISTENT_NEGATIVE"
  | "SHORT_TERM_GAIN_LONG_TERM_LOSS"
  | "SHORT_TERM_LOSS_LONG_TERM_GAIN"
  | "MIXED"
  | "REVIEW_REQUIRED";

export type HorizonReadiness =
  | "FULL_ROS_CONTEXT"
  | "PARTIAL_ROS_CONTEXT"
  | "CURRENT_WEEK_ONLY"
  | "HORIZON_MISMATCH"
  | "UNAVAILABLE";

export interface ImmediateHorizon {
  /** current-week optimal-lineup points delta */
  starter_delta: number | null;
  /** current-week bench/depth VOR delta */
  depth_delta: number;
  positional_need_delta: number;
  /** = evaluateTrade's roster_utility_delta (weekly) */
  total_delta: number;
}

export interface RosHorizon {
  /** Σ optimal-lineup ROS delta ÷ remaining weeks (weekly-equivalent). External (Sleeper) prorated. */
  starter_delta: number;
  /** stranded (bench) ROS production delta ÷ remaining weeks */
  depth_delta: number;
  /** adjustment for the traded players' expected availability (injury), weekly-equiv */
  availability_delta: number;
  /** playoff-window usable-value delta, per playoff week (null when unavailable) */
  playoff_window_delta: number | null;
  /** ROS bye-hole (slot × week) reduction */
  bye_coverage_delta: number;
  /** weighted blend of the above (weekly-equivalent) */
  total_delta: number;
  /** naive standalone incoming − outgoing ROS points (season total) — for the roster-context contrast */
  standalone_ros_swing: number;
  /** season-total optimal-lineup ROS delta (roster-context) */
  usable_ros_value_delta_season: number;
}

export interface RiOrdinalReconciliation {
  /** Σ incoming ri_vor − Σ outgoing ri_vor (RI season model) */
  ri_vor_delta: number | null;
  /** incoming/outgoing RI position ranks (explanatory) */
  incoming_ri_ranks: Array<{ id: string; position: string; ri_position_rank: number | null }>;
  outgoing_ri_ranks: Array<{ id: string; position: string; ri_position_rank: number | null }>;
  /** worst RI-vs-external season disagreement among the traded players (fraction) */
  max_disagreement_pct: number | null;
  /** true when RI's VOR-implied direction contradicts the external ROS direction */
  sign_conflict: boolean;
  note: string;
}

export interface TradeHorizonEvaluation {
  manager_slug: string;
  immediate: ImmediateHorizon;
  ros: RosHorizon;
  ri_ordinal: RiOrdinalReconciliation;
  /** ROS-dominant blend: ros_weight·ros.total_delta + immediate_weight·immediate.total_delta (weekly-equiv) */
  permanent_trade_utility: number;
  ros_weight: number;
  immediate_weight: number;
  horizon_classification: HorizonClassification;
  horizon_readiness: HorizonReadiness;
  confidence: ValueConfidence;
  reasons: string[];
}

/* ======================================================================== */
/* Checkpoint D — opponent actual impact, threat, externality, competitive    */
/* result                                                                     */
/* ======================================================================== */

/**
 * Checkpoint D.5 §18–§20: distinct semantics. A generic starter upgrade is NOT
 * a repaired hole. `PREEXISTING_STARTER_HOLE_FILLED` / `CRITICAL_WEAKNESS_REPAIRED`
 * require a genuine pre-trade deficiency (need severity critical/weak AND the
 * lineup slot materially below the replacement/adequate threshold).
 */
export type WeaknessRepair =
  | "CRITICAL_WEAKNESS_REPAIRED" // pre-trade need CRITICAL + our asset resolves it
  | "HIGH_NEED_REPAIRED" // pre-trade need weak/HIGH + resolved
  | "PREEXISTING_STARTER_HOLE_FILLED" // a required slot was below acceptable and is now filled
  | "STARTER_UPGRADED" // entered the lineup but the position was already adequate/strong
  | "DEPTH_IMPROVED"
  | "SURPLUS_REINFORCED"
  | "NONE";

/**
 * The COUNTERPARTY's ACTUAL roster delta according to OUR private models
 * (`evaluateTrade`) — NOT their perceived value, NOT their acceptance. Positive
 * `private_delta` ⇒ the trade improves them; negative ⇒ it weakens them.
 */
export interface OpponentImpact {
  owner_manager_id: string;
  /** authoritative per-participant utility delta from evaluateTrade (weekly pts) */
  private_delta: number | null;
  /** optimal starting-lineup points delta */
  starter_delta: number | null;
  /** bench / usable-depth value delta */
  bench_delta: number | null;
  /** rest-of-season usable-value delta (Phase 2) */
  ros_delta: number | null;
  /** roster fragility improvement (Phase 2) — positive = less fragile */
  fragility_delta: number | null;
  /** positional needs that IMPROVED for them */
  needs_improved: string[];
  /** positional needs that WORSENED for them */
  needs_worsened: string[];
  weakness_repair: WeaknessRepair;
  /** the position(s) where our outgoing asset repairs a hole for them */
  weakness_repair_positions: string[];
  reason_codes: CompetitiveReasonCode[];
  reasons: string[];
}

export type ThreatBand = "LOW" | "MODERATE" | "HIGH" | "ELITE";

export interface ThreatComponents {
  /** projected roster strength z (ROS starting-lineup value + depth + balance) */
  projected_strength_z: number;
  /** temporal basis of `projected_strength_z` (D.5 §26) */
  projected_strength_horizon: "ROS" | "CURRENT_WEEK" | "MIXED";
  /** current-season results strength z (win% + points-for percentile) — null pre-games */
  results_strength_z: number | null;
  /** weight on results vs projection — grows with weeks played (season maturity) */
  results_weight: number;
  /** blended forward-looking strength z */
  blended_strength_z: number;
  /** positional balance / bottleneck penalty (a catastrophic hole lowers threat) */
  balance_penalty: number;
}

export interface OpponentThreat {
  owner_manager_id: string;
  score: number; // normalized internal threat score
  band: ThreatBand;
  components: ThreatComponents;
  /** 0..1 percentile of this roster's strength across the league */
  league_strength_percentile: number | null;
  /** their blended strength z minus OUR blended strength z (positive ⇒ stronger than us) */
  relative_to_us: number | null;
  contender_band: "BOTTOM_TIER" | "MID_TIER" | "CONTENDER" | "TOP_CONTENDER" | "UNKNOWN";
  readiness: CompetitiveReadinessState;
  /** always HEURISTIC — no trade-to-title outcome data */
  calibration_status: "HEURISTIC";
  reasons: string[];
}

export interface CompetitiveExternalityComponents {
  /** opponent starter improvement × starter weight (≥ 0 when they improve) */
  starter_cost: number;
  /** opponent depth improvement × depth weight */
  depth_cost: number;
  /** multiplier from the threat band (LOW ≈ small, ELITE ≈ large) */
  threat_multiplier: number;
  /** multiplier from weakness repair (repairing a hole > reinforcing a surplus) */
  weakness_repair_multiplier: number;
  /** multiplier from relative strength (strengthening someone above us costs more) */
  relative_strength_multiplier: number;
}

export interface CompetitiveExternality {
  /** ≥ 0 ⇒ helping a rival (a COST to us); < 0 ⇒ we weakened them (FAVORABLE) */
  score: number;
  components: CompetitiveExternalityComponents;
  reason_codes: CompetitiveReasonCode[];
  reasons: string[];
}

export type CompetitiveClassification =
  | "STRONG_COMPETITIVE_BUY"
  | "COMPETITIVE_BUY"
  | "ACCEPTABLE"
  | "MARGINAL"
  | "AVOID_COMPETITIVE_COST"
  | "REJECT";

export type CompetitiveReadinessState =
  | "FULL_COMPETITIVE_CONTEXT"
  | "PARTIAL_COMPETITIVE_CONTEXT"
  | "NO_THREAT_CONTEXT"
  | "UNAVAILABLE";

export type CompetitiveReasonCode =
  | "OPPONENT_STARTER_GAIN"
  | "OPPONENT_DEPTH_GAIN"
  | "OPPONENT_ACTUALLY_WEAKENED"
  | "CRITICAL_WEAKNESS_REPAIRED"
  | "HIGH_NEED_REPAIRED"
  | "PREEXISTING_STARTER_HOLE_FILLED"
  | "STARTER_UPGRADED"
  | "DEPTH_IMPROVED"
  | "SURPLUS_REINFORCED"
  | "ELITE_RIVAL_STRENGTHENED"
  | "SHORT_TERM_LOSS_LONG_TERM_GAIN"
  | "SHORT_TERM_GAIN_LONG_TERM_LOSS"
  | "HORIZON_REVIEW_REQUIRED"
  | "ROS_HORIZON_USED"
  | "LOW_THREAT_COUNTERPARTY"
  | "STRONGER_THAN_US"
  | "WEAKER_THAN_US"
  | "OUR_GAIN_DOMINATES_EXTERNALITY"
  | "EXTERNALITY_TOO_HIGH"
  | "OUR_GAIN_INSUFFICIENT"
  | "ACCEPTANCE_BELOW_THRESHOLD"
  | "ASYMMETRIC_TRADE"
  | "MARKET_EDGE_SUPPORTS"
  | "WEEK1_RECORD_IGNORED"
  | "THREAT_CONTEXT_PARTIAL";

export interface CompetitiveResultComponents {
  our_private_gain: number;
  market_edge_bonus: number;
  competitive_externality: number;
  uncertainty_penalty: number;
}

export interface CompetitiveResult {
  /** decomposed final competitive value — our gain minus the cost of helping them */
  score: number;
  classification: CompetitiveClassification;
  /** true only when acceptance clears the feasibility threshold (§19, §33) */
  actionable: boolean;
  components: CompetitiveResultComponents;
  /** the staged decision flow outcome (§18) */
  gate_trace: Array<{ stage: string; pass: boolean; note: string }>;
  confidence: ValueConfidence;
  readiness: CompetitiveReadinessState;
  reason_codes: CompetitiveReasonCode[];
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

  // ---- Checkpoint D.5 (present only when a counterparty was supplied) ----
  /** OUR trade valued over the rest of season: immediate vs ROS vs permanent utility */
  our_trade_horizons?: TradeHorizonEvaluation;
  /** the counterparty's trade valued over the rest of season */
  opponent_trade_horizons?: TradeHorizonEvaluation;

  // ---- Checkpoint D (present only when a counterparty was supplied) ----
  /** the counterparty's ACTUAL roster delta per OUR private models (not their perception) */
  opponent_impact?: OpponentImpact;
  /** forward-looking opponent roster strength + threat band */
  opponent_threat?: OpponentThreat;
  /** decomposed competitive cost of strengthening (or benefit of weakening) this counterparty */
  competitive_externality?: CompetitiveExternality;
  /** final competitive desirability — our gain net of the externality, acceptance-gated */
  competitive_result?: CompetitiveResult;

  // ---- Checkpoint E (present only when negotiation analysis was requested) ----
  /** value extraction + the negotiation envelope (opening / target / acceptable / walk-away) */
  negotiation?: NegotiationEnvelope;

  // ---- Checkpoint F (present only when the relevant analysis was requested) ----
  /** how broadly tradable each traded player is across the league near its current price */
  liquidity?: TradeLiquidity[];
  /** how likely each traded player's market price is to move toward our private valuation */
  appreciation?: MarketAppreciation[];
  /** the buy-and-hold case for the assets WE would acquire */
  hold?: HoldEvaluation;
  /** direct vs two-step vs hold vs no-action strategy comparison */
  strategy_paths?: StrategyPathComparison;
}

/* ======================================================================== */
/* Checkpoint F — trade liquidity (§5–§9)                                     */
/* ======================================================================== */

export type LiquidityClassification =
  | "VERY_LOW"
  | "LOW"
  | "MODERATE"
  | "HIGH"
  | "VERY_HIGH";

export type BuyerFit = "HIGH_FIT" | "MODERATE_FIT";

export interface LiquidityBuyer {
  manager_id: string;
  manager_slug: string;
  fit: BuyerFit;
  /** optimal-lineup points/wk the player would add to this manager's roster */
  lineup_gain: number | null;
  /** does the player fill a MODERATE+ positional need for this manager */
  fills_need: boolean;
  /** does this manager plausibly have the assets to pay near the current price */
  plausible_economics: boolean;
  reasons: string[];
}

export interface TradeLiquidity {
  canonical_player_id: string;
  name: string;
  position: string;
  /**
   * §9 — this is estimated for a HYPOTHETICAL owner (US, post-acquisition), NOT
   * the player's current owner. It answers "if we acquire this player, how
   * tradable is he from our roster?". The current owner's reservation price is
   * NOT reused.
   */
  hypothetical_owner: "US_POST_ACQUISITION";
  classification: LiquidityClassification;
  potential_buyers: LiquidityBuyer[];
  buyer_count: number;
  high_fit_buyers: number;
  moderate_fit_buyers: number;
  /** startable supply ÷ demand at the position across the league (low ⇒ scarce ⇒ more liquid) */
  positional_scarcity_ratio: number | null;
  /** market perception input — the dynamic-market confidence for this player */
  market_perception_confidence: ValueConfidence;
  readiness: "FULL_LIQUIDITY_CONTEXT" | "PARTIAL_LIQUIDITY_CONTEXT" | "UNAVAILABLE";
  reasons: string[];
}

/* ======================================================================== */
/* Checkpoint F — market appreciation potential (§10–§16)                     */
/* ======================================================================== */

export type AppreciationClassification =
  | "HIGH_APPRECIATION_POTENTIAL"
  | "MODERATE_APPRECIATION_POTENTIAL"
  | "LIMITED_APPRECIATION_POTENTIAL"
  | "MARKET_ALREADY_CORRECTED"
  | "DEPRECIATION_RISK"
  | "REVIEW_REQUIRED"
  | "UNKNOWN";

export type AppreciationCatalyst =
  | "ROLE_EXPANSION"
  | "USAGE_PERSISTENCE"
  | "STARTER_ROLE"
  | "RETURN_FROM_INJURY"
  | "TOUCHDOWN_REGRESSION_UPWARD"
  | "DIFFICULT_SCHEDULE_ENDING"
  | "PUBLIC_PROJECTION_LAG"
  | "MARKET_NOT_YET_CORRECTED";

export type AppreciationInvalidation =
  | "ROLE_SHRINKS"
  | "STARTER_RETURNS"
  | "INJURY_WORSENS"
  | "USAGE_SPIKE_PROVES_TEMPORARY"
  | "PUBLIC_MARKET_ALREADY_REPRICES"
  | "MODEL_DISAGREEMENT_REMAINS_EXTREME";

export interface MarketAppreciation {
  canonical_player_id: string;
  name: string;
  position: string;
  classification: AppreciationClassification;
  /** private − current-market gap on the normalized scale (positive ⇒ we're higher) */
  private_market_gap: number | null;
  /** reused from Checkpoint B.5 — NOT recomputed here */
  market_correction_state: MarketCorrectionStatus;
  market_trajectory: MarketTrajectory;
  evidence_readiness: EvidenceReadiness;
  /** confidence that the gap is real and directionally trustworthy */
  confidence: ValueConfidence;
  catalysts: AppreciationCatalyst[];
  invalidation_conditions: AppreciationInvalidation[];
  /** §30 — this is NOT counted as guaranteed value anywhere downstream */
  is_speculative: true;
  reasons: string[];
}

/* ======================================================================== */
/* Checkpoint F — future optionality + buy-and-hold (§17–§19, §34)            */
/* ======================================================================== */

export interface FutureOptionality {
  /** distinct from current permanent roster utility — this is downstream trade flexibility */
  score: number;
  buyer_count: number;
  buyer_quality: LiquidityClassification;
  appreciation: AppreciationClassification;
  positional_scarcity_ratio: number | null;
  confidence: ValueConfidence;
  reasons: string[];
}

export type HoldDecision =
  | "ACQUIRE_AND_HOLD"
  | "DO_NOTHING"
  | "ACQUIRE_AND_FLIP"
  | "REVIEW_REQUIRED";

export interface HoldEvaluation {
  decision: HoldDecision;
  /** decomposed — NO fake expected-dollar value */
  components: {
    current_permanent_roster_gain: number | null;
    expected_optionality: number;
    appreciation_potential: number;
    injury_risk: number; // ≥ 0, subtracted
    market_uncertainty: number; // ≥ 0, subtracted
    time_risk: number; // ≥ 0, subtracted
  };
  /** components combined by the configured weights — a ranking key, not a dollar figure */
  hold_score: number | null;
  future_optionality: FutureOptionality;
  hold_until_conditions: string[];
  reassess_if_conditions: string[];
  confidence: ValueConfidence;
  reasons: string[];
}

/* ======================================================================== */
/* Checkpoint F — bounded multi-step trade paths (§20–§54, §77)               */
/* ======================================================================== */

export type PathStrategy =
  | "DIRECT_ACQUISITION"
  | "BUY_AND_HOLD"
  | "INTERMEDIATE_TRADE"
  | "TWO_STEP_UPGRADE"
  | "HOLD_CURRENT_ASSET"
  | "NO_ACTION"
  | "REVIEW_REQUIRED";

export type PathReadiness =
  | "FULL_PATH_CONTEXT"
  | "PARTIAL_PATH_CONTEXT"
  | "DIRECT_ONLY"
  | "UNAVAILABLE";

export interface PathStep {
  counterparty_manager_id: string;
  counterparty_slug: string;
  give: string[];
  receive: string[];
  permanent_trade_utility: number | null;
  acceptance: AcceptanceLikelihood | null;
  opponent_externality: number | null;
  transaction_friction: number;
  reasons: string[];
}

export interface PathFinalState {
  permanent_roster_delta: number | null;
  liquidity: LiquidityClassification | null;
  appreciation: AppreciationClassification | null;
  future_optionality: number | null;
}

export interface PathAggregate {
  transactions: number;
  competitive_externality: number;
  /** externality attributed to each completed trade + the aggregate (§39) */
  externality_trade_1: number | null;
  externality_trade_2: number | null;
  friction: number;
  /** qualitative composition, NOT a multiplied probability (§40–§42) */
  feasibility: AcceptanceLikelihood;
  edge_feasibility: AcceptanceLikelihood[];
  score: number;
}

export interface StrategyPath {
  strategy: PathStrategy;
  readiness: PathReadiness;
  confidence: ValueConfidence;
  starting_state: string;
  steps: PathStep[];
  final_state: PathFinalState;
  aggregate: PathAggregate;
  reasons: string[];
}

export interface StrategyPathComparison {
  readiness: PathReadiness;
  /** always includes DIRECT_ACQUISITION (if any direct trade is plausible), NO_ACTION and HOLD_CURRENT_ASSET (§45–§47) */
  paths: StrategyPath[];
  /** the highest-ranked path after §44 ranking + §26/§27 direct-path preference */
  recommended: PathStrategy;
  /** §27 — true when a two-step path was NOT preferred because a direct path is equivalent */
  direct_path_preferred: boolean;
  /** search-cost instrumentation (§83) */
  search_stats: {
    first_step_states_evaluated: number;
    second_step_paths_evaluated: number;
    dominated_paths_pruned: number;
    circular_paths_blocked: number;
    elapsed_ms: number;
  };
  reasons: string[];
}

/* ======================================================================== */
/* Checkpoint E — value extraction & negotiation envelope                     */
/* ======================================================================== */

/**
 * The information advantage: we NEGOTIATE using the counterparty's PERCEIVED
 * economics (owner-perceived value vs their reservation price) and DECIDE using
 * our private permanent rest-of-season utility. A trade the counterparty already
 * perceives as favourable may contain unclaimed negotiation surplus.
 */

export type ExtractionBand =
  | "NO_EXTRACTION_ROOM"
  | "LIMITED_EXTRACTION"
  | "MODERATE_EXTRACTION"
  | "HIGH_EXTRACTION"
  | "EXTRACTION_GATED";

export type NegotiationAggressiveness = "CONSERVATIVE" | "BALANCED" | "AGGRESSIVE_BUT_CREDIBLE";

export type ExtractionReadinessState =
  | "FULL_EXTRACTION_CONTEXT"
  | "PARTIAL_EXTRACTION_CONTEXT"
  | "BASE_TRADE_ONLY"
  | "EXTRACTION_GATED"
  | "UNAVAILABLE";

export type NegotiationReasonCode =
  | "BASE_TRADE_FAILS_GATE"
  | "BASE_TRADE_CERTIFIED"
  | "EXTRACTION_GATED"
  | "STRAIGHT_SWAP_LEAVES_VALUE_UNCAPTURED"
  | "DO_NOT_BID_AGAINST_SELF"
  | "LIMITED_EXTRACTION_PROTECT_BASE"
  | "OVERPAY_DESTROYS_MARKET_EDGE"
  | "ACCEPTANCE_COLLAPSES_BEYOND_HERE"
  | "BUNDLE_RESERVATION_RISES_SHARPLY"
  | "SECONDARY_ASSET_WEAKENS_RIVAL"
  | "SECONDARY_ASSET_HIGH_VALUE_TO_US"
  | "SECONDARY_ASSET_EXPENDABLE_TO_THEM"
  | "SECONDARY_ASSET_POOR_ROSTER_FIT"
  | "ROSTER_SLOT_PRESSURE_ON_US"
  | "NEED_RELIEF_ASSET"
  | "ROSTER_BALANCE_ASSET"
  | "PERCEIVED_VALUE_BRIDGE"
  | "CONFIDENCE_LIMITS_AGGRESSION";

/** One point on the negotiation frontier — a fully re-evaluated proposal. */
export interface NegotiationProposal {
  label: string;
  /** ids WE give up */
  our_assets: string[];
  /** ids WE receive */
  their_assets: string[];
  /** our horizon-aware permanent rest-of-season utility (weekly-equivalent) */
  our_permanent_utility: number | null;
  /** the counterparty's perceived surplus (owner-perceived received − reservation surrendered) */
  counterparty_perceived_surplus: number | null;
  /** the counterparty's reservation burden for what they give up (z within position, summed) */
  counterparty_reservation_burden: number | null;
  acceptance_likelihood: AcceptanceLikelihood | null;
  /** the counterparty's ACTUAL roster impact per our models (permanent) */
  opponent_actual_impact: number | null;
  /** Checkpoint D competitive externality (recalculated for this proposal) */
  competitive_externality: number | null;
  /** Checkpoint D competitive classification for this proposal */
  competitive_classification: CompetitiveClassification | null;
  confidence: ValueConfidence;
  /** our horizon classification for this proposal (REVIEW_REQUIRED gates extraction) */
  horizon_classification: HorizonClassification | null;
  /** dominated by another frontier point (§44) */
  dominated: boolean;
  /** additional private value to us vs the base deal ÷ their perceived surplus consumed */
  extraction_efficiency: number | null;
  reason_codes: NegotiationReasonCode[];
  reasons: string[];
}

export interface ValueExtraction {
  /** the counterparty's perceived surplus in the BASE deal */
  base_perceived_surplus: number | null;
  /** the largest perceived value we could theoretically request (their whole surplus) */
  maximum_theoretical_extraction: number | null;
  /** what we actually recommend requesting (leaves the counterparty a credible reason to accept) */
  recommended_extraction: number | null;
  /** perceived surplus we intentionally leave with the counterparty */
  remaining_counterparty_surplus: number | null;
  band: ExtractionBand;
  aggressiveness: NegotiationAggressiveness;
  /** the secondary assets ranked by extraction efficiency (before full evaluation) */
  ranked_secondary_assets: Array<{
    canonical_player_id: string;
    name: string;
    position: string;
    our_private_value: number | null;
    their_reservation: number | null;
    their_starter_importance: StarterImportance;
    efficiency: number | null;
    reason_codes: NegotiationReasonCode[];
  }>;
  reason_codes: NegotiationReasonCode[];
  reasons: string[];
}

export interface CounterofferAssessment {
  our_assets: string[];
  their_assets: string[];
  our_permanent_utility: number | null;
  verdict: "ACCEPT" | "COUNTER" | "WALK_AWAY";
  reasons: string[];
}

export interface NegotiationEnvelope {
  readiness: ExtractionReadinessState;
  confidence: ValueConfidence;
  aggressiveness: NegotiationAggressiveness;

  /** the certified base trade this envelope is built around */
  base_proposal: NegotiationProposal;
  base_trade_certified: boolean;

  extraction: ValueExtraction;

  /** the bounded, dominance-pruned negotiation frontier (opening → walk-away) */
  frontier: NegotiationProposal[];

  opening_offer: NegotiationProposal | null;
  target_settlement: NegotiationProposal | null;
  acceptable_deal: NegotiationProposal | null;
  /** human-readable walk-away boundary */
  walk_away: {
    /** minimum permanent utility (weekly-equivalent) below which we reject */
    min_permanent_utility: number;
    /** the first outgoing add-on that would push us below the floor, if any */
    breaking_asset: { canonical_player_id: string; name: string } | null;
    explanation: string;
  };

  reason_codes: NegotiationReasonCode[];
  reasons: string[];

  /** internal rationale — NOT for external negotiation copy (§42) */
  internal_explanation: {
    why_base_worth_pursuing: string[];
    why_they_may_accept: string[];
    why_more_can_be_requested: string[];
    why_the_frontier_stops: string[];
  };
}

export interface CompetitiveTradeEvaluation {
  baseline: TradeEvaluationOutput;
  competitive: CompetitiveBlock;
}
