/**
 * Post-Draft Intelligence I — shared analytical types.
 *
 * Everything here is built on the CANONICAL fantasy models (`lib/canonical/*`).
 * No Sleeper- or Yahoo-native object appears in this layer or anything that
 * consumes it. The same engine works for Yahoo once Yahoo auth is live.
 *
 * Three connected systems share one `WeeklyTeamContext`:
 *   Matchup Intelligence · Lineup Intelligence · Waiver / Free-Agent Intelligence
 */

import type {
  CanonicalFantasyTeam,
  CanonicalLeague,
  CanonicalManager,
  CanonicalPlayer,
  CanonicalRoster,
  CanonicalStanding,
} from "@/lib/canonical/schema";

export const WEEKLY_ENGINE_VERSION = "post-draft-intel-2026.1" as const;

/** Analytical-health vocabulary carried on every recommendation response. */
export type DataQualityStatus =
  | "READY"
  | "DEGRADED"
  | "PROJECTIONS_UNAVAILABLE"
  | "PROJECTIONS_PARTIAL"
  | "INJURY_DATA_STALE"
  | "PLAYER_IDENTITY_UNRESOLVED"
  | "PARTIAL_ROSTER"
  | "NO_OPPONENT"
  | "PERSISTENCE_UNAVAILABLE"
  | "PROVIDER_ERROR"
  | "AUTH_REQUIRED"
  | "NOT_CONFIGURED";

export type Confidence = "HIGH" | "MEDIUM" | "LOW";
export type Priority = "HIGH" | "MEDIUM" | "LOW";

export interface WeeklyWarning {
  code: string;
  message: string;
  severity: "info" | "warning" | "error";
}

/* -------------------------------------------------------------------------- */
/* Projections                                                                 */
/* -------------------------------------------------------------------------- */

export type ProjectionStatus = "projected" | "unavailable" | "bye" | "out";

/**
 * Rest-of-season signal for a player. Absolute points come from the EXTERNAL
 * (Sleeper/RotoWire) season projection, prorated by remaining weeks — the
 * repo's Roster Intel (RI) season model has a known absolute-level calibration
 * caveat, so RI is used ORDINALLY (position/VOR rank, tier) plus as a
 * disagreement/confidence signal, never numerically ensembled with Sleeper.
 */
export interface RosSignal {
  /** Absolute rest-of-season points in league scoring (external, prorated). */
  points: number | null;
  source: string;
  /** External (Sleeper) full-season projection in league scoring. */
  external_season_points: number | null;
  /** RI's independent full-season projection in league scoring (absolute — use with care). */
  ri_season_points: number | null;
  ri_position_rank: number | null;
  ri_vor: number | null;
  ri_tier: number | null;
  ri_confidence: "HIGH" | "MEDIUM" | "LOW" | "VERY_LOW" | null;
  /** RI vs external, as a fraction of the external season projection. Null unless both exist. */
  disagreement_pct: number | null;
  disagreement_direction: "RI_ABOVE" | "RI_BELOW" | "AGREE" | "ONE_SOURCE" | "NONE";
  /** Confidence in the ROS signal — downgraded on large RI/external disagreement. */
  confidence: Confidence;
  warnings: string[];
}

/**
 * A weekly projection for ONE player in ONE league's scoring. `projected_points`
 * is `null` (never 0) when the source has no projection — the caller degrades
 * explicitly. Floor/ceiling come from a documented position-volatility band when
 * the source gives no distribution (`uncertainty_source` says which).
 */
export interface WeeklyProjection {
  canonical_player_id: string;
  week: number;
  season: number;
  position: string;
  nfl_team: string | null;
  opponent: string | null;
  is_home: boolean | null;

  projected_points: number | null;
  floor_points: number | null;
  ceiling_points: number | null;
  std_dev: number | null;

  projection_status: ProjectionStatus;
  /** 0..1 chance the player is active and in a real role this week. */
  expected_availability: number;
  is_bye: boolean;
  injury_status: string | null;

  /** Rest-of-season points in league scoring (external, prorated). Alias of `ros?.points`. */
  rest_of_season_points: number | null;
  /** Full rest-of-season signal (external + RI ordinal + disagreement). Null if unattempted. */
  ros: RosSignal | null;

  source: string;
  model_version: string;
  uncertainty_source: "source_distribution" | "position_volatility_heuristic" | "none";
  warnings: string[];
}

export interface WeeklyProjectionBatch {
  league_slug: string;
  season: number;
  week: number;
  status: Extract<DataQualityStatus, "READY" | "PROJECTIONS_PARTIAL" | "PROJECTIONS_UNAVAILABLE">;
  by_player: Map<string, WeeklyProjection>;
  /** Canonical player metadata for every id in `by_player` (names, positions, ids). */
  resolved_players: Map<string, CanonicalPlayer>;
  source: string;
  model_version: string;
  /** canonical_player_ids that were requested but have no usable projection. */
  missing: string[];
  /** NFL team abbreviations with a game this week — lets the caller tell a bye
   *  (team not here) from a genuine missing projection. Empty if unknown. */
  teams_with_games: string[];
  warnings: WeeklyWarning[];
  /**
   * Phase 5 canonical projection-snapshot provenance. Additive: projection
   * values/source/model_version remain the model's own semantics.
   */
  canonical_snapshot?: {
    read_path:
      | "SUPABASE_HIT"
      | "LIVE_FALLBACK"
      | "LIVE_REFRESH"
      | "LIVE_BYPASS"
      /** W1.P4: refresh failed; the last known snapshot is served and MUST be treated as stale */
      | "SUPABASE_STALE_FALLBACK"
      /** W1.P4: the same logical request already resolved this batch (request-scoped consistency) */
      | "REQUEST_MEMO";
    artifact_id: string | null;
    /** when this snapshot's pointer was last advanced (snapshot-creation/confirmation time — NOT source observation time) */
    observed_at: string | null;
    age_ms: number | null;
    durable: boolean;
    /** W1.P4: when BLOODLINE observed the upstream source state this snapshot was built from. null = unknown (legacy pointer). */
    source_observed_at?: string | null;
  };

  /**
   * W1.P4 source observation identity (league-INDEPENDENT): one upstream fetch, shared by every league that rescored it.
   * `observed_at` is Bloodline's fetch instant (oldest segment), never a snapshot time.
   */
  source_observation?: {
    provider: string;
    observed_at: string | null;
    observation_id: string | null;
    content_hash: string | null;
    fetch_path: "LIVE_FETCH" | "PROCESS_CACHE" | "MIXED" | "SNAPSHOT";
    by_segment?: Record<string, string>;
  };

  /**
   * W1.P4 inputs the freshness authority needs, attached by the provider layer that owns the clock and the kickoff source.
   * Absent (tests, fake providers) => freshness is computed as UNKNOWN rather than guessed.
   */
  freshness_context?: {
    /**
     * The instant the provider STARTED resolving this batch (batch freshness policy, kickoff tier, events in horizon). It is NOT the forecast's
     * composition time: a live fetch completes — and its source observation is stamped — after it (W1.R2 / P1-A). Composition reads the
     * provider clock when the forecast is actually composed.
     */
    now_ms: number | null;
    /** W1.R2: explicit alias of `now_ms` (request start), so request time and composition time are never confused again. */
    request_started_ms?: number | null;
    game_clock: { games: Array<{ game_id: string; home_team: string; away_team: string; kickoff_at: string | null; status: string }>; source: string } | null;
    events: import("./freshness/events").InvalidationEvent[];
    refresh: import("./freshness/policy").RefreshOutcome | null;
    batch_policy: { tier: string; required_max_age_ms: number } | null;
  };
}

/* -------------------------------------------------------------------------- */
/* Replacement value (shared by lineup + waiver engines)                       */
/* -------------------------------------------------------------------------- */

export interface ReplacementLevel {
  position: string;
  /** Weekly league points of the best realistically available replacement. */
  replacement_points: number | null;
  /** How the level was derived. */
  basis: "available_pool_marginal" | "position_rank_fallback" | "unavailable";
  /** Rank in the combined pool this level corresponds to (for inspection). */
  derived_from_rank: number | null;
  sample_size: number;
}

export interface WeeklyReplacement {
  league_slug: string;
  week: number;
  by_position: Record<string, ReplacementLevel>;
  /** FLEX-eligible positions and how many flex slots the league starts. */
  flex_positions: string[];
  flex_slots: number;
  bench_slots: number;
  warnings: WeeklyWarning[];
}

/** Weekly value-over-replacement for one player on one roster. */
export interface WeeklyVOR {
  canonical_player_id: string;
  position: string;
  projected_points: number | null;
  replacement_points: number | null;
  vor: number | null;
  /** VOR against the FLEX replacement level, for flex-eligible players. */
  flex_vor: number | null;
}

/* -------------------------------------------------------------------------- */
/* Roster availability                                                         */
/* -------------------------------------------------------------------------- */

export type OwnershipState = "rostered_by_manager" | "rostered_other" | "free_agent" | "waiver" | "locked_ineligible";

export interface AvailablePlayer {
  canonical_player_id: string;
  player: CanonicalPlayer;
  ownership: OwnershipState;
  /** Canonical team id when rostered. */
  owned_by_team_id: string | null;
  /** Present only when identity could NOT be resolved to a stable id. */
  unresolved_note: string | null;
  /**
   * Present only for a player certified by PROVIDER evidence (Yahoo FA / W): how he can be acquired. `FREE_AGENT_ADD` = addable now,
   * `WAIVER_CLAIM` = claim-only. Absent on Sleeper, whose availability is inferred.
   */
  acquisition?: { method: "FREE_AGENT_ADD" | "WAIVER_CLAIM"; provider_status: string; waiver_clears_on: string | null };
}

/**
 * Readiness AXES, structurally identical to the Market State substrate's (kept local so the weekly schema never imports the substrate: only the one
 * adapter does — see the production-isolation test).
 */
export type WeeklyAxisStatus = "READY" | "PARTIAL" | "NOT_READY" | "UNKNOWN";
export interface WeeklyReadinessAxes { availability: WeeklyAxisStatus; valuation: WeeklyAxisStatus; transaction: WeeklyAxisStatus; recommendation: WeeklyAxisStatus }
export interface WeeklyManagerAcquisition {
  team_id: string; system: string; faab_remaining: number | null; waiver_priority: number | null; roster_size: number; roster_limit: number | null;
  open_roster_slots: number | null; requires_drop: boolean | null; waiver_clear_days: number | null; status: string;
}

/** Structured evidence of the verified acquirable pool, exposed on the context and every waiver response (clients never parse prose). */
export interface MarketPoolSummary {
  provider: string;
  /** PROVIDER_STATUS = the provider states each player's availability (Yahoo); INFERRED = derived from rosters + transactions (Sleeper). */
  basis: "PROVIDER_STATUS" | "INFERRED";
  market_content_id: string;
  pool_id: string;
  observed_at: string | null;
  age_ms: number | null;
  freshness: "FRESH" | "STALE" | "UNKNOWN";
  verified_free_agents: number;
  verified_waivers: number;
  unknown_availability: number;
  rostered: number;
  /** verified acquirable players that have a weekly projection and are evaluated by the waiver engine */
  evaluated_with_projection: number;
  /** verified acquirable players with a resolved identity but NO projection: still in the pool, valuation unknown (never dropped as unavailable) */
  verified_without_projection: number;
  /** verified acquirable players with no canonical identity: availability verified, cannot be valued until identity resolves */
  verified_identity_unresolved: number;
  by_position: Record<string, { free_agents: number; waivers: number; with_projection: number }>;
  axes: WeeklyReadinessAxes;
  rules: { system: string; waiver_type: string | null; waiver_rule: string | null; waiver_time_days: number | null; add_limits: { season: number | null; weekly: number | null } | null };
  pending_claims: { status: string; reason: string };
  game_lock_semantics: string | null;
  pool_evidence: Record<string, { returned: number; complete: boolean; pages_fetched: number; stopped_reason: string }> | null;
  limitations: string[];
  /** names of up to 25 verified acquirable players with NO weekly projection (still in the pool; valuation unknown) */
  verified_without_projection_sample?: string[];
  /**
   * Scoring compatibility for the valuation of this pool: the league's exact scoring fingerprint, and an honest statement of how K / D-ST WEEKLY points are
   * produced (the provider feed's standard precomputed points, NOT re-scored with the league's rules). Availability is unaffected by this limitation.
   */
  scoring?: { fingerprint: string | null; k_dst_weekly_projection: "APPROXIMATED_FROM_PROVIDER_STANDARD_POINTS" | "NOT_FLAGGED"; note: string };
  /** This manager's acquisition context from the market (FAAB remaining / waiver priority / roster room); null when the team is not in the market's roster read. */
  manager?: WeeklyManagerAcquisition | null;
}

export interface LeagueAvailability {
  league_slug: string;
  week: number;
  /** Every player the analytical engines may consider, with ownership. */
  players: AvailablePlayer[];
  free_agents: AvailablePlayer[];
  /** Raw provider ids of rostered players that failed identity resolution —
   *  excluded from free agency conservatively, surfaced here. */
  unresolved_rostered: Array<{ provider: string; provider_player_id: string | null; observed_name: string | null }>;
  warnings: WeeklyWarning[];
}

/* -------------------------------------------------------------------------- */
/* Positional needs / roster constraints                                       */
/* -------------------------------------------------------------------------- */

export interface RosterConstraints {
  starting_slots: string[];
  slot_requirements: Record<string, number>;
  bench_slots: number;
  ir_slots: number;
  taxi_slots: number;
  /** starters + bench + ir + taxi (kept for reference). */
  roster_size_limit: number | null;
  /** starters + bench — the seats a HEALTHY player must occupy. */
  active_roster_capacity: number;
  /** ir seats — a healthy player may NOT occupy these. */
  reserve_ir_capacity: number;
  taxi_capacity: number;
  flex_positions: string[];
  flex_slots: number;
}

export interface PositionalNeed {
  /** a base position ("RB") or a flex slot label ("FLEX", "SUPER_FLEX", "W/R/T") */
  position: string;
  /** which base positions can actually fill this need (self for a base position;
   *  the flex slot's eligibility set for a flex label). */
  eligible_positions: string[];
  /** startable players the manager currently rosters at this position */
  have_startable: number;
  /** starter slots that require this position (base requirement, or the count of
   *  this flex slot label) */
  need: number;
  /** projected points of the marginal starter actually needed to satisfy `need` */
  current_best_points: number | null;
  /** gap between the marginal starter and the league replacement level */
  gap_vs_replacement: number | null;
  severity: "critical" | "weak" | "adequate" | "strong";
}

/* -------------------------------------------------------------------------- */
/* The shared weekly context                                                   */
/* -------------------------------------------------------------------------- */

export interface ByeInfo {
  /** Whether an authoritative schedule was available to VERIFY byes this run. */
  bye_status: "VERIFIED" | "UNVERIFIED";
  schedule_source: string | null;
  /** canonical_player_id -> the week its NFL team is on bye. Only set when VERIFIED. */
  by_player: Record<string, number | null>;
  /** manager starters on a SCHEDULE-VERIFIED bye THIS week */
  starters_on_bye_this_week: string[];
  /** teams the schedule proved are on bye this week (empty when UNVERIFIED) */
  teams_on_bye: string[];
}

/**
 * Phase 4 availability/readiness contract.
 *
 * These axes are deliberately orthogonal. A PARTIAL projection source is not a
 * market outage; an unavailable ROS signal is not an ownership failure; a
 * generic canonical snapshot may lack a materialized waiver_state while the
 * dedicated Market State substrate is fully actionable.
 */
export interface WeeklyReadinessContract {
  live_provider: {
    status: "READY" | "PARTIAL";
    usable: boolean;
  };
  ownership: {
    status: "READY" | "DEGRADED" | "UNAVAILABLE";
    usable: boolean;
    reasons: string[];
    missing_inputs: string[];
  };
  market: {
    status: "READY" | "PARTIAL" | "NOT_READY";
    actionable: boolean;
    source: "canonical_snapshot" | "market_state";
    reasons: string[];
    blocking_reasons: string[];
    limitations: string[];
    /** Separate readiness axes (provider-evidence markets): availability / valuation / transaction / recommendation. */
    axes?: WeeklyReadinessAxes;
  };
  weekly_projections: {
    status: "READY" | "PARTIAL" | "UNAVAILABLE";
    usable: boolean;
    roster_players_projected: number;
    roster_players_total: number;
    missing_roster_players: number;
  };
  rest_of_season: {
    status: "READY" | "PARTIAL" | "UNAVAILABLE" | "NOT_REQUESTED";
    usable: boolean;
    external_players_available: number;
    roster_players_total: number;
    ri_status: "READY" | "UNAVAILABLE" | "NOT_REQUESTED";
  };
  waiver_recommendations: {
    status: "READY" | "READY_WITH_LIMITATIONS" | "NOT_READY";
    actionable: boolean;
    blocked_by: string[];
    limitations: string[];
  };
}

export interface WeeklyTeamContext {
  engine_version: typeof WEEKLY_ENGINE_VERSION;
  generated_at: string;

  /**
   * Traceable lineage: the canonical `league_snapshot_id` this context was built
   * from, its fingerprints, and the projection model(s) it consumed. Every
   * engine result derived from this context echoes `lineage.snapshot.league_snapshot_id`.
   */
  lineage: import("@/lib/canonical/lineage").RecommendationLineage;

  league: {
    slug: string;
    name: string;
    provider: string;
    season: number;
    week: number;
    scoring_rules: CanonicalLeague["scoring_rules"];
    raw_scoring: Record<string, number>;
    roster_constraints: RosterConstraints;
    waiver_settings: CanonicalLeague["waiver_settings"];
  };

  manager: CanonicalManager;
  fantasy_team: CanonicalFantasyTeam;
  standing: CanonicalStanding | null;
  roster: CanonicalRoster;

  starters: CanonicalPlayer[];
  bench: CanonicalPlayer[];
  reserve_ir: CanonicalPlayer[];
  taxi: CanonicalPlayer[];
  all_rostered: CanonicalPlayer[];

  opponent: {
    fantasy_team: CanonicalFantasyTeam;
    manager_ids: string[];
    roster: CanonicalRoster | null;
    starters: CanonicalPlayer[];
    all_rostered: CanonicalPlayer[];
  } | null;

  projections: WeeklyProjectionBatch;
  /**
   * W1.P1 canonical weekly player forecast: the authoritative, provenance-carrying representation of each player's
   * week. Additive and numerically identical to `projections` for `expected_points` (golden-tested). New decision code
   * should read this; reading `projections` directly is the legacy path (see the architecture ratchet test).
   */
  forecasts?: import("./forecast/schema").CanonicalWeeklyForecastBatch;
  /**
   * W1.R2: the outcome of the final-pregame capture for this context — never silent. A store failure does not fail the analysis, but it is
   * reported here (and as a context warning), with the per-decision counts (RECORDED / CONFIRMED / REJECTED_*).
   */
  /** W2.R1 current-intelligence metadata for this context (qualified D/ST application; per-component qualification lives in lib/w2r1/qualification.ts). */
  w2r1?: { dst: { state: string; applied: number; capture_week: number | null; reason: string | null; replaced: Array<{ canonical_player_id: string; team: string; provider_value: number | null; w2r1_value: number }> } };
  final_pregame_capture?: {
    status: "CAPTURED" | "NOTHING_TO_CAPTURE" | "NO_COMPOSITION_CLOCK" | "STORE_NOT_CONFIGURED" | "FAILED";
    candidates: number;
    counts: Partial<Record<import("./freshness/final-pregame").FinalPregameWrite, number>> | null;
    error: string | null;
  };
  replacement: WeeklyReplacement;
  availability: LeagueAvailability;
  /** Structured evidence of the certified acquirable pool (present when Market State enrichment ran and the pool was actionable). */
  market_pool?: MarketPoolSummary;

  /**
   * Authoritative readiness of the league free-agent / waiver pool, derived from
   * the canonical capability model (`assessFreeAgentPoolReadiness`). Any waiver /
   * pickup / add-drop / claim surface MUST gate ACTIONABLE output on
   * `free_agent_pool_readiness.actionable`. `availability` above being populated
   * (unrostered players exist in ownership data) does NOT make the pool
   * actionable — UNROSTERED != CERTIFIED_FREE_AGENT.
   */
  free_agent_pool_readiness: import("@/lib/canonical/capabilities").FreeAgentPoolReadiness;

  /**
   * Machine-readable orthogonal readiness axes. Consumers deciding whether
   * waiver recommendations are usable should read
   * `readiness.waiver_recommendations`, not infer actionability from the
   * aggregate context `status`.
   */
  readiness: WeeklyReadinessContract;

  /** How the rest-of-season signal was assembled (external + RI ordinal). */
  ros_signal: {
    status: "READY" | "UNAVAILABLE";
    ri_model_version: string | null;
    external_source: string;
    players_with_ri: number;
    players_with_disagreement: number;
  } | null;

  byes: ByeInfo;
  positional_needs: PositionalNeed[];

  /** Analytical health of THIS context. */
  status: DataQualityStatus;
  persistence_status: string;
  data_quality: {
    projections: WeeklyProjectionBatch["status"];
    roster_players_projected: number;
    roster_players_total: number;
    identity_unresolved: number;
    opponent_available: boolean;
    /** Phase 5: durable canonical projection read provenance, when available. */
    projection_snapshot?: WeeklyProjectionBatch["canonical_snapshot"] | null;
  };
  warnings: WeeklyWarning[];
}
