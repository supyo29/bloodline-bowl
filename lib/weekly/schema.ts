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

export interface WeeklyTeamContext {
  engine_version: typeof WEEKLY_ENGINE_VERSION;
  generated_at: string;

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
  replacement: WeeklyReplacement;
  availability: LeagueAvailability;

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
  };
  warnings: WeeklyWarning[];
}
