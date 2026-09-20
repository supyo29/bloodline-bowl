/**
 * Phase 4 — Waiver Intelligence 2.0: every tunable number lives HERE, declared with its basis and validation status.
 * Nothing is buried in the math. `PRIOR_UNVALIDATED` means "a documented starting value, not fitted": the historical
 * evaluation (docs §20) found waiver-pool history unusable, so no weight may be described as validated and the engine stays
 * SHADOW_ONLY until prospective evidence exists (docs §21).
 */
export const WAIVER2_ENGINE_VERSION = "waiver-2.0-shadow-2026.1" as const;
export const WAIVER2_CONTRACT = "waiver2-evidence-2026.1" as const;

export type ParamStatus = "PRIOR_UNVALIDATED" | "POLICY" | "DERIVED_FROM_LEAGUE";
export interface Param<T> { value: T; status: ParamStatus; basis: string }
const P = <T>(value: T, status: ParamStatus, basis: string): Param<T> => ({ value, status, basis });

export const PARAMS = {
  season_last_week: P(18, "POLICY", "NFL regular season length"),
  fantasy_playoff_weeks: P([15, 16, 17], "PRIOR_UNVALIDATED", "conventional fantasy playoff window; the canonical league record does not expose it"),
  /** share of a Role delta (recent vs season) expected to persist, by Role confidence */
  role_persistence: P({ HIGH: 0.65, MEDIUM: 0.45, LOW: 0.25, INSUFFICIENT_SAMPLE: 0.1 } as Record<string, number>, "PRIOR_UNVALIDATED", "shrinkage of an observed role change toward the season baseline; larger when Role Intelligence is confident"),
  role_delta_cap_points: P(3, "POLICY", "cap on the per-week points a role change can add (guards against double counting with an external projection that may already reflect it)"),
  /** typical team weekly opportunity volume (league-wide priors) */
  team_volume: P({ targets: 34, carries: 26 }, "PRIOR_UNVALIDATED", "league-wide typical team volume per game; a FI pace/PROE adjustment is a documented later refinement"),
  /** typical stat line PER OPPORTUNITY — scored with the league's own canonical scoring engine, never a private interpretation */
  yield_per_opportunity: P({
    target: { rec: 0.66, rec_yd: 7.7, rec_td: 0.045, rec_tgt: 1 },
    carry: { rush_att: 1, rush_yd: 4.3, rush_td: 0.032 },
  } as Record<string, Record<string, number>>, "PRIOR_UNVALIDATED", "NFL league-wide typical per-target and per-carry rates (order of magnitude); not fitted in this phase"),
  /** availability multiplier from an official designation (game-status conventions, not a model) */
  designation_play_probability: P({ OUT: 0, IR: 0, DOUBTFUL: 0.2, QUESTIONABLE: 0.75, PROBABLE: 0.95 } as Record<string, number>, "POLICY", "conventional game-status semantics; used only to weight a scenario whose condition an official designation establishes"),
  /** value of bench optionality per point of raw upside */
  option_weights: P({ role_growth: 0.35, variance_upside: 0.12, depth_chart_uncertainty: 0.2 }, "PRIOR_UNVALIDATED", "policy weights on optionality components; expressed in points/week-equivalent"),
  depth_need_probability: P(0.12, "PRIOR_UNVALIDATED", "weekly chance a bench player at a position is actually needed (starter injury, bye, rest); prices positional depth, not a projection"),
  option_horizon_weeks: P(6, "POLICY", "weeks over which optionality is realistically exercised"),
  horizon_discount_per_week: P(0.04, "PRIOR_UNVALIDATED", "forecast decay: further weeks are less certain"),
  bye_value: P(0, "POLICY", "a bye week contributes zero starter value"),
  // uncertainty
  uncertainty_weights: P({ role: 0.28, sample: 0.14, projection: 0.16, source_lag: 0.1, pool: 0.12, injury_contingency: 0.08, ros_disagreement: 0.06, depth_chart: 0.06 }, "PRIOR_UNVALIDATED", "relative weight of each uncertainty source in the 0..1 total; components are always exposed"),
  risk_penalty_per_uncertainty_point: P(0.6, "PRIOR_UNVALIDATED", "points/week of risk penalty per unit of uncertainty on the value being purchased"),
  // action policy
  pass_margin_points: P(0.75, "PRIOR_UNVALIDATED", "v1's MIN_NET_TO_RECOMMEND carried forward as the floor for a recommended action"),
  tier_a_min_net: P(3, "PRIOR_UNVALIDATED", "materially improves the roster"),
  tier_b_min_net: P(1.25, "PRIOR_UNVALIDATED", "useful alternative"),
  alternative_margin_points: P(0.6, "PRIOR_UNVALIDATED", "an alternative within this margin of a higher-ranked action is surfaced as a near-equivalent"),
  // market / FAAB
  market_prior_bid_fraction: P(0.06, "PRIOR_UNVALIDATED", "fraction of a budget a contested mid-value claim typically wins for, USED ONLY when no winning bids are visible (labelled UNCALIBRATED)"),
  faab_surplus_share: P({ min_useful: 0.12, aggressive: 0.55, walk_away: 0.9 }, "POLICY", "share of my surplus value the bid may consume at each rung; walk-away never exceeds the value being bought"),
  faab_max_fraction_of_remaining: P(0.6, "POLICY", "no single claim may recommend more than this fraction of remaining budget"),
  faab_spend_dollars_per_point: P(1.0, "DERIVED_FROM_LEAGUE", "shadow price: remaining budget divided by the total plausible surplus available across this week's tier-A/B actions, so price reflects scarcity of alternatives"),
  competitor_need_min_gap: P(0.75, "PRIOR_UNVALIDATED", "minimum marginal-starter gap (points) for a manager to count as having a structural need"),
  priority_hold_ratio: P(0.6, "PRIOR_UNVALIDATED", "spend claim priority only if candidate surplus >= this fraction of the best alternative's plus a premium; otherwise HOLD"),
} as const;

/** flat, hashable view of every parameter (value + status + basis) for lineage/capture */
export const PARAM_SNAPSHOT = Object.fromEntries(Object.entries(PARAMS).map(([k, v]) => [k, { value: v.value, status: v.status }]));
