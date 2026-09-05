/**
 * Trade Engine — Phase 6: strategic context and season-state intelligence.
 *
 * Every type here is DIAGNOSTIC/PREFERENCE layered on top of the canonical
 * trade evaluator (Phase 1/2), Phase 3's shadow player-intelligence, Phase 4's
 * discovery, and Phase 5's negotiation ladder. Nothing here computes trade
 * value — it answers "given where this manager stands in the season, which
 * otherwise-rational trade should they prefer?" See the Core Phase 6
 * Invariant in docs/TRADE_ENGINE_PHASE6.md: strategic context can change
 * WHICH good trade is best; it can never turn a bad trade into a good one.
 */

import type { AcceptanceClass } from "../schema";

/* -------------------------------------------------------------------------- */
/* 6A — Season state                                                           */
/* -------------------------------------------------------------------------- */

export type SeasonStage =
  | "PRESEASON"
  | "EARLY_SEASON"
  | "MIDSEASON"
  | "PLAYOFF_PUSH"
  | "FANTASY_PLAYOFFS"
  | "SEASON_COMPLETE"
  | "UNKNOWN";

export type TradeDeadlineStatus = "OPEN" | "APPROACHING" | "FINAL_WINDOW" | "CLOSED" | "UNKNOWN";

export interface LeagueSeasonContext {
  season: number;
  week: number;
  regular_season_start_week: number;
  regular_season_end_week: number | null;
  playoff_start_week: number | null;
  championship_week: number | null;
  weeks_remaining_regular: number;
  weeks_remaining_total: number;
  playoff_team_count: number | null;
  season_stage: SeasonStage;
  /** Sleeper league settings do not surface a resolvable deadline in this pipeline today — never fabricated. */
  trade_deadline_week: number | null;
  trade_deadline_status: TradeDeadlineStatus;
}

/* -------------------------------------------------------------------------- */
/* 6B — Standings and playoff context                                         */
/* -------------------------------------------------------------------------- */

export interface ManagerStandingsContext {
  canonical_team_id: string | null;
  rank: number | null;
  wins: number;
  losses: number;
  ties: number;
  points_for: number;
  points_against: number;
  games_played: number;
  win_percentage: number | null;
  /** Real Sleeper `playoff_seed` is never populated upstream — always null; do not fabricate. */
  playoff_seed: number | null;
  standings_available: boolean;
}

export type PlayoffStatus = "CLINCHED" | "STRONG_POSITION" | "BUBBLE" | "LONG_SHOT" | "ELIMINATED" | "UNKNOWN";

/** Categorical band, used instead of a fabricated percentage when odds are not rigorously simulated. */
export type PlayoffOddsBand = "VERY_HIGH" | "HIGH" | "MEDIUM" | "LOW" | "VERY_LOW";

export interface PlayoffContext {
  status: PlayoffStatus;
  /** Games back of the last playoff spot by win_percentage (0 if in a playoff spot); null if standings unavailable. */
  games_back: number | null;
  playoff_odds: number | null;
  playoff_odds_band: PlayoffOddsBand | null;
  diagnostics: string[];
}

/* -------------------------------------------------------------------------- */
/* 6C — Strategic archetype                                                    */
/* -------------------------------------------------------------------------- */

export type StrategicArchetype = "FRONT_RUNNER" | "CONTENDER" | "BUBBLE" | "MUST_WIN" | "LONG_SHOT" | "ELIMINATED" | "UNKNOWN";

/* -------------------------------------------------------------------------- */
/* 6D — Urgency and time horizon                                              */
/* -------------------------------------------------------------------------- */

export type TimeHorizon = "CURRENT_WEEK" | "NEXT_3_WEEKS" | "REST_OF_REGULAR_SEASON" | "FANTASY_PLAYOFFS" | "FULL_REMAINING_SEASON";

export interface UrgencyResult {
  /** bounded [0, 1] — 0 = no immediate urgency, 1 = extreme immediate urgency */
  score: number;
  components: {
    playoff_status_component: number;
    time_pressure_component: number;
    record_component: number;
  };
  reasons: string[];
}

export type HorizonWeights = Record<TimeHorizon, number>;

/* -------------------------------------------------------------------------- */
/* 6C/6D/6B combined — one manager's strategic profile, built ONCE per snapshot */
/* -------------------------------------------------------------------------- */

export interface ManagerStrategicProfile {
  manager_id: string;
  manager_slug: string;
  season: LeagueSeasonContext;
  standings: ManagerStandingsContext;
  playoff: PlayoffContext;
  archetype: StrategicArchetype;
  archetype_reasons: string[];
  urgency: UrgencyResult;
  preferred_horizons: TimeHorizon[];
  horizon_weights: HorizonWeights;
  diagnostics: string[];
}

/* -------------------------------------------------------------------------- */
/* 6F — Strategic adjustment on a single trade candidate                      */
/* -------------------------------------------------------------------------- */

export interface StrategicAdjustmentComponents {
  immediate_need_adjustment: number;
  short_horizon_adjustment: number;
  playoff_window_adjustment: number;
  depth_resilience_adjustment: number;
  ceiling_preference_adjustment: number;
  floor_preference_adjustment: number;
  bye_urgency_adjustment: number;
}

export type StrategicRecommendation = "STRONGLY_PRIORITIZE" | "PRIORITIZE" | "CONSIDER" | "LOW_PRIORITY" | "AVOID";

export interface StrategicTradeAssessment {
  base_utility_delta: number;
  base_acceptance: AcceptanceClass;
  components: StrategicAdjustmentComponents;
  /** sum of components, capped to `strategic_adjustment_cap_fraction * |base_utility_delta scale|` — see config.ts */
  strategic_adjustment: number;
  strategic_adjustment_capped: boolean;
  strategic_trade_score: number;
  /** never harsher than base_acceptance; promotion bounded by the rationality-floor policy (config.ts) */
  strategic_acceptance: AcceptanceClass;
  strategic_recommendation: StrategicRecommendation;
  reasons: string[];
}

/* -------------------------------------------------------------------------- */
/* 6G — Discovery integration                                                  */
/* -------------------------------------------------------------------------- */

export type StrategySearchMode = "WIN_NOW" | "PLAYOFF_PUSH" | "PLAYOFF_OPTIMIZE" | "PROTECT_LEAD" | "MUST_WIN";

/* -------------------------------------------------------------------------- */
/* 6H — Negotiation integration                                               */
/* -------------------------------------------------------------------------- */

export interface StrategicOfferGuidance {
  recommended_tier: "OPENING" | "BALANCED" | "STRONG_ACCEPT" | "MAXIMUM_RATIONAL" | null;
  reasons: string[];
  /** always false by construction — Phase 6 only selects among tiers Phase 5 already produced */
  exceeded_maximum_rational: boolean;
}
