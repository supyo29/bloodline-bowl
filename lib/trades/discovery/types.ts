/**
 * Trade Engine — Phase 4: trade discovery and counteroffer intelligence.
 *
 * CORE INVARIANT (repeated everywhere it matters — see discover.ts): discovery
 * SEARCHES the transaction space; it does NOT replace the canonical trade
 * evaluator. Every candidate this module produces is validated by
 * `validateTrade` and scored by `evaluateTrade` (`lib/trades/evaluate.ts`) —
 * the SAME functions `POST /api/trades/analyze` uses. There is no second,
 * discovery-only valuation model.
 *
 * CALIBRATION RULE: because trade-level Phase 3 calibration remains deferred
 * (`lib/trades/data-readiness.ts`; 1 real trade vs. a 50-trade reopen floor),
 * ranking uses ONLY the Phase 1/2 utility already computed by `evaluateTrade`
 * (`roster_utility_delta` / `contextual_utility_delta` when a context is
 * supplied). Phase 3 shadow intelligence may be ATTACHED to a result for
 * explanation, always labeled `SHADOW INTELLIGENCE — NOT INCLUDED IN TRADE
 * SCORE`, and never read by the ranking formula.
 */

import type { AcceptanceClass, TradeViability, ParticipantTradeResult, TradeSummary, Phase2Summary, Phase3Summary } from "../schema";

export type SearchMode =
  | "BEST_AVAILABLE"
  | "BUY_PLAYER"
  | "SELL_PLAYER"
  | "POSITIONAL_NEED"
  | "CONSOLIDATE"
  | "FAIR_TRADES"
  | "EASY_TO_ACCEPT"
  | "BLOCKBUSTER"
  | "THREE_TEAM";

export interface TradeSearchConstraints {
  untouchable_player_ids?: string[];
  required_incoming_player_ids?: string[];
  required_outgoing_player_ids?: string[];
  excluded_trade_partner_ids?: string[];
  allowed_trade_partner_ids?: string[];
  max_assets_sent?: number;
  max_assets_received?: number;
  minimum_my_utility_delta?: number;
  minimum_partner_utility_delta?: number;
}

export interface TradeDiscoveryRequest {
  league: string;
  manager: string;
  mode: SearchMode;
  target_player_id?: string;
  sell_player_id?: string;
  target_position?: string;
  max_results?: number;
  max_assets_per_side?: number;
  include_three_team?: boolean;
  constraints?: TradeSearchConstraints;
}

export type NeedSeverity = "CRITICAL" | "HIGH" | "MODERATE" | "LOW" | "NONE";

export interface PositionalNeedProfile {
  position: string;
  severity: NeedSeverity;
}
export interface PositionalSurplusProfile {
  position: string;
  /** count of bench-quality-or-better players at this position beyond what the roster can plausibly use */
  surplus_count: number;
}

export interface AssetValue {
  canonical_player_id: string;
  position: string;
  /** current-week VOR if it started (weeklyVOR against the league replacement frontier) — the same Phase 1 unit used everywhere else */
  starter_vor: number | null;
  /** current-week projected points */
  projected_points: number | null;
  is_current_starter: boolean;
}

export interface TradeSearchProfile {
  manager_id: string;
  manager_slug: string;
  needs: PositionalNeedProfile[];
  surpluses: PositionalSurplusProfile[];
  /** best players by starter VOR, descending — used for BUY_PLAYER/CONSOLIDATE targets */
  premium_assets: AssetValue[];
  /** bench players at NONE/LOW-severity positions, ascending value (most expendable first) */
  expendable_assets: AssetValue[];
  /** true when the roster has meaningfully more startable depth than needed at 2+ positions (Phase 2 fragility-informed) */
  consolidation_candidate: boolean;
  /** true when the roster is fragile enough that giving up depth for one star is risky (Phase 2 fragility-informed) */
  fragility_sensitive: boolean;
}

export type PartnerFitLevel = "HIGH" | "MODERATE" | "LOW";

export interface PartnerFitScore {
  partner_manager_id: string;
  score: number;
  level: PartnerFitLevel;
  need_complementarity: number;
  surplus_complementarity: number;
  reasons: string[];
}

/**
 * Audit fix (§18): a three-team cycle is NOT a bilateral package shape — it
 * was previously mislabeled `ONE_FOR_ONE` even though it has 3 participants
 * and 3 transfers. `THREE_TEAM_CYCLE` is used for every `runThreeTeamSearch`
 * result; the three bilateral shapes are reserved for exactly 2 participants.
 */
export type PackageShape = "ONE_FOR_ONE" | "TWO_FOR_ONE" | "ONE_FOR_TWO" | "THREE_TEAM_CYCLE";

export interface CandidatePackage {
  shape: PackageShape;
  /** canonical_manager_id -> canonical_player_id[] given away by that manager */
  transfers: Array<{ from_manager_id: string; to_manager_id: string; canonical_player_id: string }>;
  participant_manager_ids: string[];
}

export interface TradeDiscoveryResultParticipant {
  manager_id: string;
  manager_slug: string;
  utility_delta: number;
  acceptance: AcceptanceClass;
}

export interface Phase3ShadowNote {
  label: "SHADOW INTELLIGENCE — NOT INCLUDED IN TRADE SCORE";
  warnings: string[];
}

export interface TradeDiscoveryResult {
  rank: number;
  shape: PackageShape;
  transfers: Array<{ from_manager_id: string; to_manager_id: string; canonical_player_id: string }>;
  participants: TradeDiscoveryResultParticipant[];
  my_gain: number;
  minimum_partner_gain: number;
  trade_viability: TradeViability;
  rationale: string[];
  phase3_shadow: Phase3ShadowNote;
  search_metadata: {
    mode: SearchMode;
    complexity: number;
    partner_fit: number | null;
  };
  /** the full canonical evaluation, for a caller that wants every detail (trade_summary, phase2, phase3, etc.) */
  full_evaluation: {
    trade_summary: TradeSummary;
    phase2_summary: Phase2Summary | null;
    phase3_summary: Phase3Summary | null;
    participants: Record<string, ParticipantTradeResult>;
  };
}

export interface SearchFunnelDiagnostics {
  partners_considered: number;
  assets_considered: number;
  packages_generated: number;
  packages_pruned: number;
  packages_evaluated: number;
  valid_results: number;
}

export interface TradeDiscoveryResponse {
  status: "OK" | "VALIDATION_FAILED" | "CONTEXT_UNAVAILABLE";
  league_slug: string;
  manager_slug: string;
  mode: SearchMode;
  versions: {
    foundation: string;
    contextual: string | null;
    calibrated: string | null;
    data: string | null;
    discovery: string;
  };
  calibration_status: {
    real_trade_count: number;
    required_trade_count: number;
    remaining_trade_count: number;
    review_available: boolean;
  };
  results: TradeDiscoveryResult[];
  search_metadata: SearchFunnelDiagnostics & { truncated: boolean };
  diagnostics: Array<{ code: string; message: string; severity: "info" | "warning" | "error" }>;
}
