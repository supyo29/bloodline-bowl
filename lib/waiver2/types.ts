/** Phase 4 — Waiver Intelligence 2.0 types. The TRANSACTION (add + drop + cost) is the central object, not the player. */
import type { WeeklyTeamContext, AvailablePlayer } from "@/lib/weekly/schema";
import type { CanonicalPlayer, CanonicalTransaction } from "@/lib/canonical/schema";
import type { PlayerRoleProfile } from "@/lib/player-role-intelligence/schema";
import type { OpportunityPropagationScenarioResult } from "@/lib/opportunity-propagation-intelligence/schema";

export type PoolCertification = "CERTIFIED" | "UNCERTIFIED_UNROSTERED";
export interface TeamView { team_id: string; name: string | null; manager_ids: string[]; active_player_ids: string[]; faab_remaining: number | null; waiver_priority: number | null }

/** Role Intelligence as consumed (never recomputed). */
export interface RoleEvidence { version: string | null; through_week: number | null; season: number | null; profile: (p: CanonicalPlayer) => PlayerRoleProfile | null }
/** A Football Intelligence opponent-environment reading, already routed by predictive status. */
export interface FiOpponentReading { team: string; metric: string; league_percentile: number | null; predictive_status: string; modeled: number | null }
export interface FiEvidence { version: string | null; through_week: number | null; week_state: string | null; defense: (team: string) => FiOpponentReading[] }
export type OppEvaluator = (team: string, unavailableGsis: string[]) => OpportunityPropagationScenarioResult | null;
export interface ScheduleEvidence { opponent: (team: string, week: number) => string | null; bye_week: (team: string) => number | null; last_week: number }

export interface WaiverInput {
  weekly: WeeklyTeamContext;
  teams: TeamView[];
  my_team_id: string;
  transactions: CanonicalTransaction[];
  pool: { certification: PoolCertification; candidates: AvailablePlayer[] };
  role: RoleEvidence | null;
  fi: FiEvidence | null;
  opp: OppEvaluator | null;
  schedule: ScheduleEvidence | null;
  /** optional realized fantasy points by canonical id, chronological (most recent last). Absent => that evidence is UNAVAILABLE, never invented. */
  recent_points?: Record<string, number[]>;
}

export type Availability = "AVAILABLE" | "UNAVAILABLE";
export interface Component { key: string; label: string; value: number | null; unit: string; weight?: number; contribution?: number | null; status: Availability; note?: string; basis?: string }

export interface UncertaintyComponent { source: string; level: number; weight: number; reason: string }
export interface Uncertainty { total: number; components: UncertaintyComponent[]; value_low: number; value_high: number }

export type Archetype =
  | "IMMEDIATE_STARTER" | "SHORT_TERM_INJURY_REPLACEMENT" | "ROLE_GROWTH_BREAKOUT" | "CONTINGENT_HANDCUFF" | "UPSIDE_BENCH_STASH"
  | "SCHEDULE_STREAMER" | "FLOOR_DEPTH" | "RETURN_SPECIALIST_VALUE" | "SPECULATIVE_ROOKIE" | "DECLINING_TRAP" | "FLUKE_RISK" | "NO_CLEAR_ROLE";

export interface HorizonValues { next_week: number; next_3: number; ros: number; playoffs: number; stash: number }
export interface ValueByKind { starter: number; bench_option: number; contingency_payoff: number; contingency_counted: number }

export interface RoleAssessment {
  status: Availability; level: string | null; trend: string | null; evidence: string | null; confidence: string | null;
  role_delta_points: number; persisted_points: number; capped: boolean; components: Component[]; through_week: number | null; version: string | null;
}
export interface OppAssessment {
  status: "NOT_ESTABLISHED" | "ESTABLISHED" | "UNAVAILABLE"; condition: string | null; unavailable: Array<{ player: string; designation: string; play_probability: number }>;
  conditional_payoff_points: number; counted_points: number; residual_note: string | null; version: string | null; support_level: string | null;
}
export interface ScheduleAssessment { status: Availability; bye_week: number | null; games_remaining: number | null; next_opponents: Array<{ week: number; opponent: string | null }>; fi_adjustment_points: number; fi_numeric: boolean; notes: string[]; playoff_opponents_known: number }

export interface AssetValue {
  player_id: string; name: string; position: string;
  weekly_level: number | null; level_basis: string;
  horizons: HorizonValues; by_kind: ValueByKind;
  role: RoleAssessment; opp: OppAssessment; schedule: ScheduleAssessment;
  components: Component[]; uncertainty: Uncertainty; archetype: Archetype; archetype_evidence: string[];
  realized_vs_opportunity: { status: Availability; signal: "SUPPORTED_BY_ROLE" | "POINTS_ABOVE_ROLE" | "POINTS_BELOW_ROLE" | "UNKNOWN"; note: string };
}

export interface ReplacementView {
  position: string; free_agent_replacement: number | null; free_agent_depth: number; rostered_replacement: number | null; starter_baseline: number | null;
  bench_replacement: number | null; scarcity: number; basis: string;
}

export interface CompetitorView { team_id: string; manager: string | null; need_strength: number; marginal_starter_gap: number; positional_weakness: string; budget_remaining: number | null; budget_context: string; evidence: string[] }
export interface FaabRange { status: "AVAILABLE" | "NOT_APPLICABLE" | "UNAVAILABLE"; unit: "dollars"; min_useful: number | null; expected_competitive: number | null; aggressive: number | null; walk_away: number | null; uncertainty: string[]; calibration: "VISIBLE_WINNING_BIDS" | "UNCALIBRATED_PRIOR" | "NONE"; method: string[] }
export interface PriorityAdvice { status: "SPEND" | "HOLD" | "NOT_APPLICABLE"; current: number | null; reason: string }

export type Tier = "A" | "B" | "C" | "PASS";
export interface WaiverAction {
  id: string; kind: "ADD_DROP" | "ADD_OPEN_SPOT" | "PASS";
  manager_team_id: string;
  candidate: { player_id: string; name: string; position: string; nfl_team: string | null } | null;
  drop: { player_id: string; name: string; position: string } | null;
  gross_add_value: number; drop_cost: number; acquisition_cost: number; risk_penalty: number; net_action_value: number;
  net_low: number; net_high: number;
  horizons: HorizonValues; value_by_kind: ValueByKind;
  lineup_delta_next_week: { value: number | null; status: "RESOLVED" | "UNRESOLVED" };
  candidate_asset: AssetValue | null; drop_asset: AssetValue | null;
  market: { scarcity: number; competitors: CompetitorView[]; faab: FaabRange; priority: PriorityAdvice };
  uncertainty: Uncertainty; confidence: "HIGH" | "MEDIUM" | "LOW";
  tier: Tier; reasons: string[]; alternatives: Array<{ candidate_id: string; name: string; net_action_value: number; acquisition_cost: number; why: string }>;
  components: Component[]; content_id: string;
}

export interface WaiverEvaluation {
  engine_version: string; contract: string; generated_at: string; deployment: "SHADOW_ONLY";
  availability: { status: "AVAILABLE" | "UNAVAILABLE" | "UNCERTIFIED_POOL"; certification: PoolCertification; reasons: string[] };
  manager_team_id: string; week: number; scoring_fingerprint: string | null;
  actions: WaiverAction[]; recommended: WaiverAction | null; pass: WaiverAction;
  replacement: ReplacementView[]; market_summary: { budgets: Array<{ team_id: string; faab_remaining: number | null }>; visible_winning_bids: number; calibration: string };
  lineage: { snapshot: string | null; role: string | null; fi: string | null; opp: string | null; projection_model: string | null; params_hash: string };
  counters: RetrievalCounters; evaluation_hash: string; warnings: string[];
}
export interface RetrievalCounters { role_lookups: number; role_cache_hits: number; opp_calls: number; opp_cache_hits: number; fi_calls: number; lineup_builds: number; assets_built: number; candidates: number; droppables: number }
