/**
 * Static metadata about the Book-Ready evidence topics the planner may use. It is a MIRROR, not a source of truth:
 * test/analysis-book-capability.test.ts asserts every entry against the real Book-Ready TOPICS and registry, so the
 * planner can never quietly invent (or forget) a capability. Nothing here queries evidence.
 */
import type { CostClass } from "./schema";

export interface TopicMeta {
  surface: string;
  /** request params Book-Ready requires */
  required: string[];
  /** Book-Ready cost_class */
  bookready_cost: "ARTIFACT_READ" | "REQUEST_SCOPED_BUILD";
  /** planner cost, from 3.5C production measurements (artifact ~0.1-0.3 s; matchup/roster/schedule ~1 s; Start/Sit ~1-6 s; waiver up to ~4 s) */
  cost: CostClass;
  est_ms: number;
  /** known standing caveats surfaced as researchability reasons */
  flags?: Array<"SOURCE_CONFLICT_PARTIAL" | "PROVIDER_LIMIT_PARTIAL">;
  flag_reason?: string;
  /** what the topic is scoped to (used to reject nonsense bindings) */
  scope: "PLAYER" | "TEAM" | "QB" | "MANAGER" | "LEAGUE" | "SCENARIO";
  /** the topic actually returns history points / comparison populations when asked (verified against Book-Ready by test) */
  history_capable: boolean;
  comparison_capable: boolean;
}

export const TOPIC_META: Record<string, TopicMeta> = {
  "fi.team_metric": { surface: "football-intelligence", required: ["team"], bookready_cost: "ARTIFACT_READ", cost: "FAST", est_ms: 250, scope: "TEAM", history_capable: true, comparison_capable: true },
  "fi.player_usage": { surface: "football-intelligence", required: [], bookready_cost: "ARTIFACT_READ", cost: "FAST", est_ms: 250, scope: "PLAYER", history_capable: false, comparison_capable: false },
  "role.player_profile": { surface: "role-opportunity", required: [], bookready_cost: "ARTIFACT_READ", cost: "FAST", est_ms: 250, scope: "PLAYER", history_capable: true, comparison_capable: true },
  "role.role_change": { surface: "role-opportunity", required: [], bookready_cost: "ARTIFACT_READ", cost: "FAST", est_ms: 150, scope: "PLAYER", history_capable: false, comparison_capable: false },
  "opp.scenario": { surface: "opportunity-propagation", required: ["team", "season", "week", "unavailable"], bookready_cost: "ARTIFACT_READ", cost: "FAST", est_ms: 300, scope: "SCENARIO", history_capable: false, comparison_capable: false },
  "scheme.qb_progression": { surface: "player-scheme", required: ["gsis_id"], bookready_cost: "ARTIFACT_READ", cost: "FAST", est_ms: 250, scope: "QB", history_capable: false, comparison_capable: true, flags: ["SOURCE_CONFLICT_PARTIAL"], flag_reason: "numeric RAW_* read codes are an unresolved source conflict (no first/second/third-read mapping); named buckets are verified" },
  "scheme.qb_spatial": { surface: "player-scheme", required: ["gsis_id"], bookready_cost: "ARTIFACT_READ", cost: "FAST", est_ms: 250, scope: "QB", history_capable: false, comparison_capable: false },
  "scheme.qb_formation": { surface: "player-scheme", required: ["gsis_id"], bookready_cost: "ARTIFACT_READ", cost: "FAST", est_ms: 250, scope: "QB", history_capable: false, comparison_capable: false },
  "scheme.defense_coverage": { surface: "player-scheme", required: ["team"], bookready_cost: "ARTIFACT_READ", cost: "FAST", est_ms: 250, scope: "TEAM", history_capable: false, comparison_capable: true },
  "startsit.shadow": { surface: "start-sit-fi", required: ["league", "manager"], bookready_cost: "REQUEST_SCOPED_BUILD", cost: "EXPENSIVE", est_ms: 6000, scope: "MANAGER", history_capable: false, comparison_capable: false },
  "matchup.shadow": { surface: "matchup-intelligence", required: ["league", "manager"], bookready_cost: "REQUEST_SCOPED_BUILD", cost: "MODERATE", est_ms: 1500, scope: "MANAGER", history_capable: false, comparison_capable: false },
  "waiver.status": { surface: "waiver-foundations", required: ["league", "manager"], bookready_cost: "REQUEST_SCOPED_BUILD", cost: "EXPENSIVE", est_ms: 4000, scope: "MANAGER", history_capable: false, comparison_capable: false },
  "roster_health.team": { surface: "roster-health", required: ["league", "manager"], bookready_cost: "REQUEST_SCOPED_BUILD", cost: "MODERATE", est_ms: 1500, scope: "MANAGER", history_capable: false, comparison_capable: false },
  "schedule_planning.team": { surface: "schedule-planning", required: ["league", "manager"], bookready_cost: "REQUEST_SCOPED_BUILD", cost: "MODERATE", est_ms: 1500, scope: "MANAGER", history_capable: false, comparison_capable: false },
  "audit.weekly_model": { surface: "weekly-model-audit", required: ["season", "week"], bookready_cost: "ARTIFACT_READ", cost: "FAST", est_ms: 150, scope: "LEAGUE", history_capable: false, comparison_capable: false },
  "fi.certification": { surface: "fi-recertification", required: [], bookready_cost: "ARTIFACT_READ", cost: "FAST", est_ms: 150, scope: "LEAGUE", history_capable: false, comparison_capable: false },
  "player.team_membership": { surface: "temporal-team-membership", required: ["gsis_id"], bookready_cost: "REQUEST_SCOPED_BUILD", cost: "MODERATE", est_ms: 900, scope: "PLAYER", history_capable: false, comparison_capable: false },
  "scoring.league_contract": { surface: "league-scoring-contract", required: ["league"], bookready_cost: "REQUEST_SCOPED_BUILD", cost: "MODERATE", est_ms: 800, scope: "LEAGUE", history_capable: false, comparison_capable: false },
  "market.state": { surface: "league-market-state", required: ["league"], bookready_cost: "REQUEST_SCOPED_BUILD", cost: "MODERATE", est_ms: 800, scope: "LEAGUE", history_capable: false, comparison_capable: false },
  "matchup2.player.coverage": { surface: "matchup-intelligence-2", required: ["gsis_id"], bookready_cost: "REQUEST_SCOPED_BUILD", cost: "MODERATE", est_ms: 900, scope: "PLAYER", history_capable: false, comparison_capable: false },
  "matchup2.player.pass_area": { surface: "matchup-intelligence-2", required: ["gsis_id"], bookready_cost: "REQUEST_SCOPED_BUILD", cost: "MODERATE", est_ms: 900, scope: "PLAYER", history_capable: false, comparison_capable: false },
  "matchup2.player.pressure": { surface: "matchup-intelligence-2", required: ["gsis_id"], bookready_cost: "REQUEST_SCOPED_BUILD", cost: "MODERATE", est_ms: 900, scope: "PLAYER", history_capable: false, comparison_capable: false },
  "matchup2.player.run": { surface: "matchup-intelligence-2", required: ["gsis_id"], bookready_cost: "REQUEST_SCOPED_BUILD", cost: "MODERATE", est_ms: 900, scope: "PLAYER", history_capable: false, comparison_capable: false },
  "matchup2.player.scoring": { surface: "matchup-intelligence-2", required: ["gsis_id"], bookready_cost: "REQUEST_SCOPED_BUILD", cost: "MODERATE", est_ms: 900, scope: "PLAYER", history_capable: false, comparison_capable: false },
  "matchup2.player.summary": { surface: "matchup-intelligence-2", required: ["gsis_id"], bookready_cost: "REQUEST_SCOPED_BUILD", cost: "MODERATE", est_ms: 900, scope: "PLAYER", history_capable: false, comparison_capable: false },
  "matchup2.defense.coverage": { surface: "matchup-intelligence-2", required: ["team"], bookready_cost: "ARTIFACT_READ", cost: "FAST", est_ms: 150, scope: "TEAM", history_capable: false, comparison_capable: true },
  "matchup2.defense.front": { surface: "matchup-intelligence-2", required: ["team"], bookready_cost: "ARTIFACT_READ", cost: "FAST", est_ms: 150, scope: "TEAM", history_capable: false, comparison_capable: true, flags: ["PROVIDER_LIMIT_PARTIAL"], flag_reason: "provider-limited: run direction, gap and box counts only — front alignment, run-fit responsibility and short-yardage/goal-line splits are not published, so this evidence answers only part of the question" },
  "matchup2.defense.pressure": { surface: "matchup-intelligence-2", required: ["team"], bookready_cost: "ARTIFACT_READ", cost: "FAST", est_ms: 150, scope: "TEAM", history_capable: false, comparison_capable: true },
  "matchup2.defense.explosive": { surface: "matchup-intelligence-2", required: ["team"], bookready_cost: "ARTIFACT_READ", cost: "FAST", est_ms: 150, scope: "TEAM", history_capable: false, comparison_capable: true },
  "waiver2.actions": { surface: "waiver-intelligence-2", required: ["league", "manager"], bookready_cost: "REQUEST_SCOPED_BUILD", cost: "EXPENSIVE", est_ms: 5000, scope: "MANAGER", history_capable: false, comparison_capable: false },
  "waiver2.market": { surface: "waiver-intelligence-2", required: ["league", "manager"], bookready_cost: "REQUEST_SCOPED_BUILD", cost: "EXPENSIVE", est_ms: 5000, scope: "MANAGER", history_capable: false, comparison_capable: false, flags: ["PROVIDER_LIMIT_PARTIAL"], flag_reason: "provider-limited: pending claims and per-player waiver-clear times are not exposed by the provider, competitor need is structural only, and FAAB ranges are UNCALIBRATED shadow priors — this evidence answers only part of the question" },
  "waiver2.replacement": { surface: "waiver-intelligence-2", required: ["league", "manager"], bookready_cost: "REQUEST_SCOPED_BUILD", cost: "EXPENSIVE", est_ms: 5000, scope: "MANAGER", history_capable: false, comparison_capable: false },
  "trade.evaluation": { surface: "trade-foundations", required: ["league", "manager"], bookready_cost: "ARTIFACT_READ", cost: "FAST", est_ms: 100, scope: "MANAGER", history_capable: false, comparison_capable: false },
};

/**
 * Analytical capabilities the system does NOT have as Book-Ready evidence. A chapter may name one to expose an
 * important question honestly (state UNSUPPORTED) instead of dropping the question or pretending. The test asserts none
 * of these is also a Book-Ready topic and the reason is stated. 3.5C carry-forward limitations are listed explicitly.
 */
export const UNSUPPORTED_CAPABILITIES: Record<string, string> = {
  player_biographical_profile: "no age / draft-capital / biography evidence topic",
  multi_season_route_history: "Role history covers preserved 2026 states only; earlier seasons exist only in the R cache",
  receiver_scheme_profile: "receiver spatial / route / coverage-split data exists in Player-Scheme files but has NO Book-Ready topic (3.5C carry-forward; placeholder XX/blank identities' evidence lives there)",
  rb_scheme_profile: "RB gap / box / rush-matrix data exists in Player-Scheme files but has NO Book-Ready topic (3.5C carry-forward)",
  ol_player_level_pass_block: "no player-level offensive-line evidence; only team pressure/sack rates allowed",
  coach_specific_profile: "no coach-level tendency evidence beyond team FI tendencies",
  game_script_splits: "no leading/trailing or win-probability split evidence",
  player_efficiency_metrics: "no player-level efficiency evidence (yards/route, YAC, etc.); FI serves usage and team-level EPA only",
  player_explosive_play_rate: "no player-level explosive-play evidence",
  expected_fantasy_points_model: "no expected-vs-actual fantasy points model",
  player_projection_distribution: "Book-Ready serves no player projection / floor / median / ceiling topic (production projections are not exposed through /api/evidence)",
  slot_boundary_alignment_data: "no receiver alignment (slot vs boundary) evidence",
  safety_help_bracket_data: "no safety-help / bracket coverage evidence",
  cornerback_assignment_data: "no CB-to-receiver assignment (shadow) data",
  nfl_schedule_strength: "no NFL opponent-schedule evidence by team; schedule-planning is roster-level bye / lineup value",
  injury_probability: "no injury-probability evidence",
  play_call_intent: "no play-call intent evidence",
  personnel_groupings: "no personnel-grouping evidence",
  defensive_front_alignment: "no defensive front / alignment evidence",
  in_game_adjustments: "no in-game adjustment evidence",
  drive_level_scoring_data: "no drive-level scoring evidence",
  run_fit_evidence: "defense rush-gap data exists in Player-Scheme files but has NO Book-Ready topic",
  defense_position_vulnerability: "defense pass-vulnerability-by-position data exists in Player-Scheme files but has NO Book-Ready topic",
  qb_pressure_profile: "QB pressure-response data exists in Player-Scheme files but has NO Book-Ready topic",
  manager_weekly_results: "no manager weekly-result history evidence",
  manager_incentive_evidence: "no manager-incentive evidence",
  positional_scarcity_evidence: "no league-wide positional-scarcity evidence",
  betting_lines: "no spread / total / implied-team-total evidence",
};
