/**
 * Trade Engine — Phase 1: Multi-Team Trade Foundation.
 *
 * The engine answers ONE question: *how does this transaction change the actual
 * utility of each manager's roster?* — never "what are the standalone
 * trade-chart values of the players involved?".
 *
 * A trade is represented as a generalized N-party transaction: `participants` +
 * `transfers`. A 2-team trade is a proposal with two participants; a 3-team
 * trade is a proposal with three. There is NO `twoWayTradeEngine` /
 * `threeWayTradeEngine` split, and the system never assumes bilateral
 * reciprocity between every pair of participants.
 *
 * Every participating roster is reconstructed before/after and re-run through
 * the SAME roster intelligence the rest of Bloodline Bowl uses
 * (`buildOptimalLineup`, `computeWeeklyReplacement` / `weeklyVOR`,
 * `computePositionalNeeds`). The marginal effect — not a summed player value —
 * is the result.
 */

import type {
  CanonicalManager,
  CanonicalFantasyTeam,
  CanonicalRoster,
} from "@/lib/canonical/schema";
import type { PositionalNeed } from "@/lib/weekly/schema";

/**
 * Trade-model behavior version (not a deployment version). Bump on any change
 * that can alter a trade analysis result.
 *   2026.1 — initial Phase 1 foundation
 *   2026.2 — audit pass: contiguous acceptance bands (RELUCTANT now reachable),
 *            starter_vor removed from the default composite weight (exposed, not
 *            summed — was double-counting the starter-points term), positional
 *            pressure summed over base positions only (was triple-counting a hole
 *            via flex-label + STRUCTURAL entries), order-invariant tie-breaks.
 */
export const TRADE_ENGINE_VERSION = "ri-trade-foundation-2026.2" as const;

/* -------------------------------------------------------------------------- */
/* Proposal representation (the generalized N-party model)                     */
/* -------------------------------------------------------------------------- */

export interface TradeParticipant {
  /** A manager slug/id/username — resolved through canonical manager resolution. */
  manager_id: string;
}

export type TradeAsset = {
  type: "PLAYER";
  /** Sleeper id, canonical id, or name-key — resolved through the crosswalk. */
  player_id: string;
};

export interface TradeTransfer {
  from_manager_id: string;
  to_manager_id: string;
  asset: TradeAsset;
}

export interface TradeProposal {
  /** League the trade happens in (registry slug). */
  league: string;
  participants: TradeParticipant[];
  transfers: TradeTransfer[];
}

/** A proposal after identity resolution — every id is canonical. */
export interface NormalizedTransfer {
  from_manager_id: string;
  to_manager_id: string;
  canonical_player_id: string;
  /** what the caller originally passed, for diagnostics */
  input_player_id: string;
}

export interface NormalizedProposal {
  league_slug: string;
  /** canonical_manager_id per participant, in the caller's order */
  participant_manager_ids: string[];
  transfers: NormalizedTransfer[];
}

/* -------------------------------------------------------------------------- */
/* Validation                                                                  */
/* -------------------------------------------------------------------------- */

export type TradeValidationCode =
  | "NO_PARTICIPANTS"
  | "TOO_FEW_PARTICIPANTS"
  | "NO_TRANSFERS"
  | "UNKNOWN_MANAGER"
  | "DUPLICATE_PARTICIPANT"
  | "MANAGER_HAS_NO_TEAM"
  | "UNKNOWN_PLAYER"
  | "INVALID_PARTICIPANT"
  | "SELF_TRANSFER"
  | "DUPLICATE_TRANSFER"
  | "PLAYER_NOT_OWNED_BY_SENDER"
  | "PLAYER_ON_MULTIPLE_POST_TRADE_ROSTERS"
  | "POST_TRADE_ROSTER_OVER_SIZE_LIMIT"
  | "POST_TRADE_ROSTER_ILLEGAL";

export interface TradeValidationFailure {
  code: TradeValidationCode;
  message: string;
  /** the offending transfer / manager / player, when applicable */
  subject?: string;
}

export interface TradeValidationResult {
  ok: boolean;
  failures: TradeValidationFailure[];
}

/* -------------------------------------------------------------------------- */
/* Per-participant before/after evaluation                                     */
/* -------------------------------------------------------------------------- */

export type AcceptanceClass =
  | "STRONG_ACCEPT"
  | "ACCEPT"
  | "NEUTRAL"
  | "RELUCTANT"
  | "REJECT"
  | "HARD_REJECT";

export interface RosterSnapshotView {
  /** canonical ids of the optimal legal starting lineup (starter SET, order-free) */
  optimal_starters: string[];
  /** projected points of the optimal legal lineup; null when an UNKNOWN starter
   *  makes it unquantifiable (never a silently-low number) */
  optimal_starter_points: number | null;
  /** sum of positive weekly VOR across the optimal starters */
  starter_vor: number | null;
  /** sum of positive weekly VOR across rostered players NOT in the optimal lineup */
  bench_value: number;
  all_player_ids: string[];
  incoming_player_ids: string[];
  outgoing_player_ids: string[];
  /** structural: can a legal lineup still be fielded? */
  fieldable: boolean;
  roster_size: number;
}

export interface LineupDisplacement {
  entered_starting_lineup: string[];
  left_starting_lineup: string[];
  moved_to_bench: string[];
  bench_promotions: string[];
}

export type PositionalNeedChangeKind =
  | "IMPROVES_NEED"
  | "NEUTRAL"
  | "WORSENS_POSITION"
  | "CREATES_NEW_WEAKNESS";

export interface PositionalNeedChange {
  position: string;
  before_severity: PositionalNeed["severity"] | "absent";
  after_severity: PositionalNeed["severity"] | "absent";
  kind: PositionalNeedChangeKind;
}

export interface ParticipantTradeResult {
  manager_id: string;
  manager_slug: string;
  canonical_team_id: string;

  before: RosterSnapshotView;
  after: RosterSnapshotView;

  /** after.optimal_starter_points - before.optimal_starter_points; null if unresolved */
  starter_points_delta: number | null;
  starter_points_delta_status: "RESOLVED" | "UNRESOLVED";
  /** after.starter_vor - before.starter_vor; null if unresolved */
  starter_vor_delta: number | null;
  bench_value_delta: number;

  /** Phase 1 composite — a weighted blend of the components above, all of which
   *  are also exposed individually. Configurable weights (see TradeConfig). */
  roster_utility_delta: number;
  roster_utility_components: {
    starter_points: number;
    starter_vor: number;
    bench_value: number;
    positional_need: number;
  };

  positional_need_changes: PositionalNeedChange[];
  lineup_displacement: LineupDisplacement;

  acceptance: AcceptanceClass;
  /** roster_utility_delta >= config.acceptance_floor */
  above_acceptance_floor: boolean;

  diagnostics: TradeDiagnostic[];
}

/* -------------------------------------------------------------------------- */
/* Trade-level verdict                                                         */
/* -------------------------------------------------------------------------- */

export type TradeViability = "HIGH" | "MODERATE" | "LOW" | "NON_VIABLE";

export interface TradeSummary {
  all_teams_improve: boolean;
  all_teams_above_acceptance_floor: boolean;
  largest_beneficiary: string | null;
  largest_negative: string | null;
  /** population variance of the participants' roster_utility_delta */
  utility_gain_variance: number;
  /** max - min of the participants' roster_utility_delta */
  utility_gain_spread: number;
  trade_viability: TradeViability;
  /** rationality is per-roster improvement; fairness is distribution — kept separate */
  rationality: {
    every_participant_rational: boolean;
    rational_count: number;
    participant_count: number;
  };
  fairness: {
    /** 0 = perfectly even gains, 1 = maximally lopsided */
    imbalance_index: number;
    note: string;
  };
}

/* -------------------------------------------------------------------------- */
/* Diagnostics / degradation                                                   */
/* -------------------------------------------------------------------------- */

export type TradeDiagnosticCode =
  | "TRADE_ANALYSIS_DEGRADED"
  | "STARTER_PROJECTION_UNAVAILABLE"
  | "VOR_FALLBACK_USED"
  | "POSITIONAL_NEED_MODEL_UNAVAILABLE"
  | "LINEUP_PROVISIONAL"
  | "PROJECTIONS_PARTIAL"
  | "ROSTER_UNKNOWN_PLAYER";

export interface TradeDiagnostic {
  code: TradeDiagnosticCode;
  message: string;
  severity: "info" | "warning" | "error";
}

/* -------------------------------------------------------------------------- */
/* Top-level analysis result                                                   */
/* -------------------------------------------------------------------------- */

export interface TradeAnalysis {
  status: "OK" | "VALIDATION_FAILED" | "CONTEXT_UNAVAILABLE";
  trade_version: typeof TRADE_ENGINE_VERSION;
  league_slug: string;
  week: number;
  config: import("./config").TradeConfig;

  validation: TradeValidationResult;
  /** the resolved, canonical form of the proposal (present when validation passed) */
  normalized: NormalizedProposal | null;

  participants: Record<string, ParticipantTradeResult>;
  trade_summary: TradeSummary | null;
  diagnostics: TradeDiagnostic[];
  generated_at: string;
}

/* -------------------------------------------------------------------------- */
/* Engine input (what analyze.ts assembles and evaluate.ts consumes)           */
/* -------------------------------------------------------------------------- */

export interface TradeParticipantInput {
  manager: CanonicalManager;
  team: CanonicalFantasyTeam;
  roster: CanonicalRoster;
}
