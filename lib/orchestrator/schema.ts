/**
 * Phase 8 — Team Management Orchestrator (Scope 2, ADVISORY_ONLY).
 *
 * The Orchestrator answers "what, if anything, should this manager do right now?"
 * by COORDINATING and PRIORITISING the already-certified Phase 1–7 specialists.
 * It adds NO projection, valuation, or simulation model of its own.
 *
 * Deployment: `ADVISORY_ONLY` — it produces user-facing management
 * recommendations; it NEVER executes a transaction (no lineup set, no add/drop,
 * no waiver claim, no trade offer/accept) and NEVER mutates a specialist
 * engine's behaviour. `orchestratorMayExecuteTransactions()` is always `false`.
 *
 * Hard boundaries (enforced in code, not just docs):
 *   - `SHADOW_ONLY` evidence (Phase 4 Start/Sit FI, Phase 5 Matchup Intelligence)
 *     can NEVER be the deciding evidence for an `ACTION` — it may only appear as
 *     a `WATCH` item / diagnostic disagreement. See `policy.ts` + `candidates.ts`.
 *   - `SHARED_CONTEXT` evidence (Phase 6 Roster Health, Phase 7 Schedule Planning)
 *     may establish a CONDITION + its materiality / urgency, but never a remedy;
 *     a concrete remedy must originate from a production specialist (lineup /
 *     waiver / trade).
 *   - Specialist raw scores are NEVER compared across domains. Every candidate is
 *     mapped into the audited common decision dimensions (see `DecisionDimensions`).
 */

export const ORCHESTRATOR_VERSION = "team-management-orchestrator-2026.1";

/** The Orchestrator's deployment contract. */
export type OrchestratorDeployment = "ADVISORY_ONLY";
export const ORCHESTRATOR_DEPLOYMENT: OrchestratorDeployment = "ADVISORY_ONLY";

/**
 * THE execution guard. Always `false` in 2026.1. Any future autonomous
 * "action layer" requires a separate certified phase + an explicit versioned
 * deployment change — never an auto-promotion. Mirrors
 * `fiMayInfluenceProduction()` / `matchupMayInfluenceProduction()`.
 */
export function orchestratorMayExecuteTransactions(): boolean {
  return false;
}

/* -------------------------------------------------------------------------- */
/* Verdicts + action classes                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Top-level verdict.
 *   ACTION — a concrete certified remedy exists, is legal/actionable under known
 *            state, material, sufficiently supported, and timely enough to
 *            deserve the manager's attention now.
 *   WATCH  — a meaningful condition/opportunity exists but acting now is
 *            premature: no good remedy, not urgent yet, evidence insufficient
 *            for action, or shadow/context-only signal.
 *   HOLD   — nothing material currently warrants attention beyond normal
 *            monitoring. A deliberate, successful outcome — NOT a failure.
 *   INSUFFICIENT_EVIDENCE — a required specialist failed / the state is too
 *            degraded to judge. Distinct from HOLD (see `degradation`).
 */
export type OrchestratorVerdict = "ACTION" | "WATCH" | "HOLD" | "INSUFFICIENT_EVIDENCE";

/** Concrete v1 action classes. `TRADE_EXPLORATION` is a path to investigate — never an executable trade. */
export type OrchestratorActionClass = "LINEUP" | "WAIVER" | "TRADE_EXPLORATION";

/* -------------------------------------------------------------------------- */
/* Common decision dimensions (§14 / §15 of the approved plan)                 */
/* -------------------------------------------------------------------------- */

/**
 * A cardinal effect that keeps its SOURCE UNIT. Never rescaled to an arbitrary
 * 0–100. `value === null` ⇒ the dimension could not be quantified (degraded) —
 * it is NOT fabricated.
 */
export interface CardinalEffect {
  value: number | null;
  unit: "fantasy_points" | "fantasy_points_per_week" | "probability" | "percentile";
  /** the specialist field this came from, e.g. "lineup.projected_points_gained". */
  source: string;
  /** projection basis where the number is projection-driven. */
  basis?: "WEEKLY" | "ROS_PROJECTION" | "NONE";
  horizon?: OrchestratorHorizon;
}

/** A categorical effect used where cardinal normalisation is unsupported. */
export interface CategoricalEffect {
  direction: "POSITIVE" | "NEGATIVE" | "NEUTRAL";
  magnitude_class: "MAJOR" | "MATERIAL" | "MINOR" | "NEGLIGIBLE" | "UNKNOWN";
  source: string;
}

export type OrchestratorHorizon =
  | "CURRENT_WEEK"
  | "NEXT_2_3_WEEKS"
  | "REST_OF_REGULAR_SEASON"
  | "FANTASY_PLAYOFFS"
  | "FULL_REMAINING_SEASON";

/**
 * Timing granularity supported by ACTUAL data (P8-1: no certified player lock /
 * kickoff fact exists). `NOW` is reserved for a truly current *structural*
 * condition (illegal lineup, empty starter slot, a starter on a bye) that does
 * not depend on kickoff timing. The Orchestrator NEVER claims "before tonight",
 * "before the 7:20 kickoff", "before Player X locks", or "you have 45 minutes".
 */
export type OrchestratorUrgency =
  | "NOW"
  | "THIS_WEEK"
  | "BEFORE_WAIVERS"
  | "NEAR_TERM"
  | "FUTURE"
  | "INFORMATIONAL";

/** Why finer timing is unavailable — carried whenever exact timing would matter. */
export type TimingDegradationReason = "EXACT_LOCK_TIME_UNAVAILABLE" | "WAIVER_DAY_UNKNOWN" | "TRADE_DEADLINE_UNKNOWN";

export type OrchestratorConfidence = "HIGH" | "MEDIUM" | "LOW";

export interface EvidenceConfidence {
  projection_basis: "WEEKLY" | "ROS_PROJECTION" | "NONE";
  data_quality: string;
  specialist_confidence: string;
  horizon: OrchestratorHorizon;
  /** the weakest link — the resulting action confidence cannot exceed this. */
  floor: OrchestratorConfidence;
}

export type ActionCostBand = "ZERO" | "LOW" | "MEDIUM" | "HIGH";

export interface ActionCost {
  band: ActionCostBand;
  /** the concrete resource consumed, e.g. "waiver_priority", "faab", "bench_slot", "roster_asset", null. */
  consumes: string | null;
  reasons: string[];
}

export type Irreversibility = "REVERSIBLE" | "PARTLY_REVERSIBLE" | "IRREVERSIBLE";

export interface DecisionDimensions {
  /** expected change to this manager's best-legal-lineup points over the horizon. */
  expected_weekly_effect: CardinalEffect | null;
  /** reduction in one-loss damage / SPOF removal / future coverage added. */
  risk_reduction: CategoricalEffect | CardinalEffect | null;
  urgency: OrchestratorUrgency;
  timing_degradation: TimingDegradationReason[];
  confidence: OrchestratorConfidence;
  evidence_confidence: EvidenceConfidence;
  cost: ActionCost;
  irreversibility: Irreversibility;
}

/* -------------------------------------------------------------------------- */
/* Conditions (specialist-detected facts)                                      */
/* -------------------------------------------------------------------------- */

export type ConditionSource =
  | "team_state"
  | "roster_health"
  | "schedule_planning"
  | "lineup"
  | "start_sit"
  | "matchup"
  | "waiver"
  | "strategy"
  | "start_sit_shadow"
  | "matchup_shadow"
  | "aggregate";

export type ConditionMateriality = "MATERIAL" | "MINOR" | "INFORMATIONAL";

export type ConditionDisposition =
  | "ACTIONED"
  | "WATCH"
  | "NO_MATERIAL_REMEDY"
  | "NOT_URGENT"
  | "NOT_MATERIAL"
  | "INTERNALLY_COVERED"
  | "SHADOW_DIAGNOSTIC_ONLY"
  | "DEGRADED_EVIDENCE";

/** One provenance link: a fact taken verbatim from a specialist output. */
export interface EvidenceRef {
  specialist: ConditionSource;
  fact: string;
  data: Record<string, number | string | boolean | string[] | null>;
}

export interface OrchestratorCondition {
  /** stable code, e.g. QB_DEPTH_VULNERABILITY, LINEUP_SUBOPTIMAL, WEEK_N_BYE_HOLE. */
  code: string;
  title: string;
  sources: ConditionSource[];
  /** all supporting evidence — never discarded, even when aggregated (§32). */
  evidence: EvidenceRef[];
  materiality: ConditionMateriality;
  urgency: OrchestratorUrgency;
  timing_degradation: TimingDegradationReason[];
  horizon: OrchestratorHorizon;
  has_available_remedy: boolean;
  disposition: ConditionDisposition;
  /** negative-evidence codes explaining a non-ACTION disposition (§23). */
  suppression_reasons: string[];
}

/* -------------------------------------------------------------------------- */
/* Actions                                                                     */
/* -------------------------------------------------------------------------- */

export type NegativeEvidenceCode =
  | "IMPROVEMENT_BELOW_MATERIALITY"
  | "NO_MATERIAL_WAIVER_REMEDY"
  | "NO_VIABLE_TRADE_PATH"
  | "INTERNAL_BACKUP_SUFFICIENT"
  | "CONDITION_NOT_URGENT"
  | "FUTURE_CONCERN_TOO_DISTANT"
  | "SPECIALIST_CONFIDENCE_DEGRADED"
  | "ACTION_DUPLICATES_OTHER"
  | "DOMINATED_BY_LINEUP"
  | "DOMINATED_BY_CHEAPER_ACTION"
  | "TRADE_PARTNER_INVALID_OR_UNLIKELY"
  | "DROP_COST_EXCEEDS_BENEFIT"
  | "ROSTER_ALREADY_OPTIMAL"
  | "ROSTER_HEALTH_RESILIENT"
  | "SHADOW_ONLY_EVIDENCE"
  | "ILLEGAL_OR_UNAVAILABLE"
  | "REQUIRED_SPECIALIST_UNAVAILABLE"
  | "STALE_SNAPSHOT";

/** A concrete LINEUP remedy: exact slot + in/out player ids from the frozen optimiser. */
export interface LineupRemedy {
  kind: "LINEUP";
  changes: Array<{ slot: string; start_player_id: string; start_player_name: string; sit_player_id: string | null; sit_player_name: string | null }>;
  is_reshuffle: boolean;
  /** IR-move opportunity: move an injured active player to a free IR slot. */
  ir_move?: { player_id: string; player_name: string; frees_slot: true } | null;
}

/** A concrete WAIVER remedy: the add/drop pair from the frozen waiver engine. */
export interface WaiverRemedy {
  kind: "WAIVER";
  add_player_id: string;
  add_player_name: string;
  add_position: string;
  drop_player_id: string | null;
  drop_player_name: string | null;
  immediate_role: string;
  waiver_engine_priority: "HIGH" | "MEDIUM" | "LOW";
}

/** A TRADE_EXPLORATION pointer — a path to investigate, NOT an executable trade. */
export interface TradeExplorationRemedy {
  kind: "TRADE_EXPLORATION";
  /**
   * true  → a bare pointer ("this is a worthwhile path to investigate"); it is a
   *         WATCH item, never an ACTION on its own (§27 — a pointer is not a
   *         concrete remedy).
   * false → a concrete package was discovered + validated by the canonical
   *         evaluator; it may become an ACTION when the condition is material
   *         and timely.
   */
  pointer_only: boolean;
  target_problem: string;
  /** the discovery mode to run, e.g. POSITIONAL_NEED. */
  suggested_search_mode: string;
  target_position: string | null;
  /** populated only when `include_trade_search` ran a concrete discovery. */
  discovered_partner_id: string | null;
  discovered_partner_slug: string | null;
  discovered_assets_in: string[];
  discovered_assets_out: string[];
  partner_fit: "HIGH" | "MODERATE" | "LOW" | null;
  trade_viability: "HIGH" | "MODERATE" | "LOW" | "NON_VIABLE" | null;
  /** never a claim of acceptance. */
  note: string;
}

export type OrchestratorRemedy = LineupRemedy | WaiverRemedy | TradeExplorationRemedy;

export interface OrchestratorAction {
  action_class: OrchestratorActionClass;
  /** the condition code this action addresses. */
  target_condition: string;
  target_problem: string;
  originating_specialist: ConditionSource;
  remedy: OrchestratorRemedy;
  dimensions: DecisionDimensions;
  priority: "HIGH" | "MEDIUM" | "LOW";
  reason_codes: string[];
  /** reasons this action is NOT stronger / was nearly suppressed (§23). */
  negative_evidence: NegativeEvidenceCode[];
  /** structured provenance — the API/assistant renders prose from this, never a second logic path (§31). */
  explanation_chain: EvidenceRef[];
  /** triggers that invalidate this recommendation (§23 opportunity expiration). */
  expires_when: string[];
}

/* -------------------------------------------------------------------------- */
/* Lineage + degradation                                                       */
/* -------------------------------------------------------------------------- */

export type SpecialistUsage = "USED_FOR_ACTION" | "USED_AS_CONTEXT" | "SHADOW_CONTEXT_ONLY" | "NOT_USED" | "UNAVAILABLE";

export interface OrchestratorLineage {
  orchestrator_version: string;
  deployment: OrchestratorDeployment;
  league_snapshot_id: string | null;
  scoring_fingerprint: string | null;
  season: number;
  week: number;
  generated_at: string;
  /** every specialist + how it contributed to THIS result. */
  specialists: Record<string, { version: string | null; usage: SpecialistUsage }>;
  projection_lineage: {
    weekly: { source: string; model_version: string } | null;
    ros: { source: string; ri_model_version: string | null } | null;
  };
  planning_horizon: { current_week: number; last_regular_week: number | null; playoff_weeks: number[] };
}

export interface OrchestratorDegradation {
  /** specialists that failed / were unavailable for this request. */
  missing_specialists: string[];
  /** human-readable degradation reasons. */
  reasons: string[];
  /** true when the result is INSUFFICIENT_EVIDENCE rather than a real HOLD. */
  evidence_insufficient: boolean;
}

/* -------------------------------------------------------------------------- */
/* The result                                                                  */
/* -------------------------------------------------------------------------- */

export interface OrchestratorResult {
  orchestrator_version: string;
  lineage: OrchestratorLineage;
  league_slug: string;
  manager_slug: string;
  manager_display_name: string | null;
  team_name: string | null;
  roster_id: number;
  canonical_team_id: string;
  is_vacant: boolean;

  verdict: OrchestratorVerdict;

  primary_action: OrchestratorAction | null;
  secondary_actions: OrchestratorAction[];

  /** every specialist-detected fact considered this run. */
  current_conditions: OrchestratorCondition[];
  /** real but premature — the WATCH items (§3). */
  future_watch_items: OrchestratorCondition[];
  /** candidate actions that were generated then suppressed, with why (diagnostics). */
  suppressed_actions: Array<{ action: OrchestratorAction; reasons: NegativeEvidenceCode[] }>;

  confidence: OrchestratorConfidence;
  /** the negative evidence that supports a HOLD verdict (§23, §27). Non-empty when verdict === "HOLD". */
  hold_rationale: string[];

  degradation: OrchestratorDegradation;
}

/** A compact per-manager row for the league endpoint (§34 — no full payload per team). */
export interface OrchestratorLeagueRow {
  manager_slug: string;
  manager_display_name: string | null;
  team_name: string | null;
  roster_id: number;
  is_vacant: boolean;
  verdict: OrchestratorVerdict;
  primary_action: { action_class: OrchestratorActionClass; target_problem: string; priority: string; urgency: OrchestratorUrgency } | null;
  watch_count: number;
  top_condition_codes: string[];
  confidence: OrchestratorConfidence;
  degraded: boolean;
}

export interface OrchestratorLeagueResult {
  orchestrator_version: string;
  lineage: Omit<OrchestratorLineage, "specialists"> & { specialists: OrchestratorLineage["specialists"] };
  league_slug: string;
  season: number;
  week: number;
  rows: OrchestratorLeagueRow[];
  warnings: string[];
}

/* -------------------------------------------------------------------------- */
/* Decision capture (§36) — schema defined now; NullCaptureStore is the default */
/* -------------------------------------------------------------------------- */

export interface OrchestratorDecisionRecord {
  orchestrator_version: string;
  captured_at: string;
  league_slug: string;
  manager_slug: string;
  roster_id: number;
  league_snapshot_id: string | null;
  scoring_fingerprint: string | null;
  season: number;
  week: number;
  verdict: OrchestratorVerdict;
  primary_action: {
    action_class: OrchestratorActionClass;
    target_condition: string;
    remedy_kind: string;
    priority: string;
    urgency: OrchestratorUrgency;
    expected_weekly_effect: number | null;
    confidence: OrchestratorConfidence;
    cost_band: ActionCostBand;
    reason_codes: string[];
  } | null;
  secondary_action_count: number;
  suppressed: Array<{ action_class: OrchestratorActionClass; target_condition: string; reasons: NegativeEvidenceCode[] }>;
  condition_codes: string[];
  watch_codes: string[];
  hold_rationale: string[];
  specialist_versions: Record<string, string | null>;
  /** whether the recommendation was later acted upon — only set if that ever becomes observable. Never fabricated. */
  acted_upon: "UNKNOWN" | "ACTED" | "NOT_ACTED";
}

export type CaptureKind = "null" | "memory" | "custom";

export interface OrchestratorCaptureStore {
  readonly kind: CaptureKind;
  record(rec: OrchestratorDecisionRecord): Promise<void> | void;
}
