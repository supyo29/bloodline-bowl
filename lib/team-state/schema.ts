/**
 * Phase 2 — the shared Team-State / Management Context contract.
 *
 * Answers "WHAT IS TRUE about this fantasy team right now?" — never "what should
 * the manager do?". Every value here is a deterministic, projection-FREE fact or
 * a structural derivation of facts, computed from ONE immutable
 * `CanonicalLeagueSnapshot`. Strategic interpretation (replacement value, VOR,
 * projected points, start/sit, win probability, trade/waiver recommendations)
 * lives in the domain engines that CONSUME this layer, not here.
 *
 * Ownership boundary (see docs/TEAM_MANAGEMENT_PHASE_2.md §3):
 *   - canonical snapshot   owns: raw league state (rosters, players, scoring, matchups)
 *   - THIS layer           owns: manager-centric structural facts + stable derived state
 *   - weekly / trade / …   own : projection-weighted evaluation, recommendations
 *
 * No provider reads. No projections. No `severity: HIGH` style opinions unless
 * they are an explicit deterministic structural rule with a reason code and the
 * raw supporting facts attached.
 */

import type { RecommendationLineage } from "@/lib/canonical/lineage";
import type { CanonicalPosition } from "@/lib/canonical/schema";

export const TEAM_STATE_VERSION = "team-state-2026.1" as const;

/* -------------------------------------------------------------- player summary */

/**
 * A compact, JOIN-KEY-RICH view of one rostered player. Deliberately NOT the
 * full `CanonicalPlayer` (no `resolution` internals, no `first/last_name` split).
 * The identifier block is sized so a future Football Intelligence / R engine can
 * attach NFL-level data without changing this contract.
 */
export interface TeamStatePlayer {
  canonical_player_id: string;
  /** provider ids for cross-system joins — only keys that actually resolved. */
  ids: {
    sleeper_id?: string;
    yahoo_id?: string;
    gsis_id?: string;
    pfr_id?: string;
    espn_id?: string;
  };
  full_name: string;
  position: CanonicalPosition;
  /** every fantasy position this player may be STARTED at (position + eligible). */
  eligible_positions: CanonicalPosition[];
  nfl_team: string | null;
  is_team_defense: boolean;
  status: string | null;
  injury_status: string | null;
  /** true when identity could not be lined up cross-provider (still rostered). */
  identity_unresolved: boolean;
  /** where this player currently sits on the roster. */
  roster_slot: "starter" | "bench" | "ir" | "taxi";
  /** the starting-slot label this player fills, when `roster_slot === "starter"`. */
  starting_slot_label: string | null;
  /** current-week NFL opponent abbr, when a schedule is available; null otherwise. */
  nfl_opponent: string | null;
  /** true only when a schedule-verified bye is known for this player's NFL team this week. */
  on_bye_this_week: boolean;
}

/* ------------------------------------------------------ positional inventory */

/**
 * Pure counts for ONE position or ONE flex-slot label. No quality judgement —
 * "5 WRs rostered" is a fact, not a surplus.
 */
export interface PositionInventoryEntry {
  /** a base position ("RB") or a flex-slot label ("FLEX", "SUPER_FLEX", "W/R/T"). */
  slot_key: string;
  /** base positions that may fill this key (self for a base position; the flex eligibility set). */
  eligible_positions: string[];
  /** dedicated starting slots that require this exact key. */
  required_starters: number;
  /** rostered players eligible for this key, by roster location. */
  rostered: number;
  active: number; // rostered and NOT on ir/taxi
  starting: number; // currently assigned to a starting slot of this key
  benched: number; // active, eligible, not starting
  ir: number;
  taxi: number;
  /**
   * Structural starter coverage: can the ACTIVE eligible players cover
   * `required_starters` of this key WITHOUT borrowing players another base slot
   * strictly needs? Derived from the shared `maxSlotMatching`.
   */
  starter_slots_covered: number;
  /** active eligible players beyond `starter_slots_covered` (raw bench bodies — NOT a value claim). */
  bench_bodies: number;
}

export interface PositionInventory {
  /** one entry per base position the league actually uses + one per distinct flex label. */
  by_key: PositionInventoryEntry[];
  /** raw rostered count per canonical position (incl. IR/taxi), e.g. `{ RB: 5, WR: 6 }`. */
  rostered_by_position: Record<string, number>;
  /** active (non-IR/taxi) count per canonical position. */
  active_by_position: Record<string, number>;
}

/* ----------------------------------------------------------- structural flags */

export type StructuralFlagCode =
  | "UNFILLED_STARTER_SLOT"
  | "ILLEGAL_CURRENT_LINEUP"
  | "NO_ACTIVE_BACKUP"
  | "SINGLE_POINT_OF_FAILURE"
  | "CURRENT_WEEK_BYE_GAP"
  | "SHARED_BYE_WEEK"
  | "IR_DEPTH_REDUCTION"
  | "OPEN_ROSTER_SLOT"
  | "OVER_ROSTER_LIMIT";

export type StructuralFlagSeverity = "critical" | "warning" | "info";

/**
 * A deterministic STRUCTURAL risk read directly off current state. Never a
 * recommendation. `facts` carries the raw numbers so a consumer can re-derive or
 * override the classification.
 */
export interface StructuralFlag {
  code: StructuralFlagCode;
  severity: StructuralFlagSeverity;
  /** base positions / slot labels the flag concerns. */
  positions: string[];
  /** canonical player ids the flag concerns (e.g. the sole backup, the IR'd depth piece). */
  player_ids: string[];
  message: string;
  facts: Record<string, number | string | boolean | string[]>;
}

/* -------------------------------------------------- structural depth pressure */

export type DepthPressureLevel = "none" | "thin" | "bare" | "broken";

/**
 * A PROJECTION-FREE structural read of how much slack a slot key has. It is
 * NOT a claim about player quality — a position can be `thin` while holding a
 * great starter, or `none` while holding six mediocre bodies.
 *
 *   broken : cannot structurally field `required_starters` from active players
 *   bare   : exactly meets the requirement, zero eligible active backup
 *   thin   : meets the requirement with 1 eligible active backup, OR a flex key
 *            whose backup pool is below the number of flex slots it feeds
 *   none   : 2+ eligible active backups beyond the requirement
 */
export interface DepthPressureEntry {
  slot_key: string;
  level: DepthPressureLevel;
  required_starters: number;
  active_eligible: number;
  backup_count: number;
  /** true when this key sits ABOVE its structural need with surplus active bodies. */
  structural_surplus: boolean;
  surplus_count: number;
  reason_code:
    | "BELOW_REQUIREMENT"
    | "NO_BACKUP"
    | "SINGLE_BACKUP"
    | "FLEX_POOL_SHALLOW"
    | "ADEQUATE"
    | "SURPLUS";
}

export interface DepthPressure {
  by_key: DepthPressureEntry[];
  /** slot keys at `broken`/`bare`/`thin`, worst first — a factual list, not advice. */
  pressured_keys: string[];
  /** slot keys with a `structural_surplus`. */
  surplus_keys: string[];
}

/* -------------------------------------------------------------- matchup facts */

export interface TeamStateMatchup {
  matchup_id: string | null;
  week: number;
  status: "pre" | "in_progress" | "final" | "unknown";
  opponent_team_id: string | null;
  opponent_roster_id: number | null;
  opponent_manager_ids: string[];
  /** true when the current week has no fantasy opponent for this team (bye / odd league). */
  is_bye: boolean;
}

/* --------------------------------------------------------- schedule/bye facts */

export interface TeamStateScheduleFacts {
  /** "READY" only when an authoritative full-league NFL schedule backed these facts. */
  status: "READY" | "UNVERIFIED";
  schedule_source: string | null;
  /** NFL team abbrs on a bye this week (schedule-verified). Empty when UNVERIFIED. */
  teams_on_bye_this_week: string[];
  /** canonical player id -> current-week NFL opponent abbr (present players only). */
  opponent_by_player: Record<string, string | null>;
  /** starters whose NFL team is on a schedule-verified bye this week. */
  starters_on_bye: string[];
}

/* ------------------------------------------------------ ownership context ref */

export interface TeamStateOwnershipContext {
  /** canonical player id -> owning canonical_team_id, for every rostered player in the league. */
  owned_by_team: Record<string, string>;
  /** roster_id of every team in the league (for opponent / competitor lookups). */
  league_roster_ids: number[];
  /**
   * Free-agent facts are NOT materialised here — the canonical `waiver_state` is
   * still `null` (documented Phase 2 deferral). A consumer that needs the FA pool
   * calls the weekly availability layer.
   */
  free_agent_pool: "NOT_MATERIALIZED";
}

/* --------------------------------------------------------------- team state */

export interface TeamManagementState {
  version: typeof TEAM_STATE_VERSION;
  lineage: RecommendationLineage;

  identity: {
    league_slug: string;
    league_snapshot_id: string;
    provider: string;
    season: number;
    week: number;
    canonical_manager_id: string;
    canonical_team_id: string;
    roster_id: number;
    manager_slug: string;
    manager_display_name: string | null;
    team_name: string | null;
    provider_owner_id: string | null;
    is_co_managed: boolean;
    is_vacant: boolean;
  };

  league: {
    scoring_fingerprint: string;
    roster_fingerprint: string;
    team_count: number;
    status: string;
    starting_slots: string[];
    slot_requirements: Record<string, number>;
    bench_slots: number;
    ir_slots: number;
    taxi_slots: number;
    roster_size_limit: number | null;
    flex_slots: { label: string; eligible_positions: string[]; count: number }[];
    playoff: {
      playoff_team_count: number | null;
      playoff_start_week: number | null;
      championship_week: number | null;
    };
  };

  roster: {
    players: TeamStatePlayer[];
    starters: string[];
    bench: string[];
    ir: string[];
    taxi: string[];
    all_players: string[];
    /** starting-slot labels with no player assigned right now. */
    unfilled_starter_slots: string[];
    /** active roster spots still open (roster_size_limit − active players), or null when unbounded. */
    open_active_slots: number | null;
    /** true when `maxSlotMatching` cannot field every starting slot from ACTIVE players. */
    can_field_legal_lineup: boolean;
  };

  standing: {
    rank: number | null;
    wins: number;
    losses: number;
    ties: number;
    points_for: number;
    points_against: number;
    games_played: number;
    playoff_seed: number | null;
  } | null;

  position_inventory: PositionInventory;
  structural_flags: StructuralFlag[];
  depth_pressure: DepthPressure;
  matchup: TeamStateMatchup | null;
  schedule_facts: TeamStateScheduleFacts;

  /**
   * Extension point for the future R Football Intelligence Engine. NOT populated
   * in Phase 2 — the field is documented, not stubbed. A future phase attaches:
   *   { version, generated_at, player_profiles: Record<canonical_player_id, {...}>,
   *     team_profile_id, opponent_profile_id }
   * without changing anything above.
   */
  football_context: null;
}

/* ------------------------------------------------- league management context */

export interface LeagueManagementContext {
  version: typeof TEAM_STATE_VERSION;
  lineage: RecommendationLineage;
  league: TeamManagementState["league"] & { league_slug: string; league_snapshot_id: string; season: number; week: number };
  /** every manager's Team-State, keyed order = ascending roster_id. */
  teams: TeamManagementState[];
  /** canonical_manager_id -> index into `teams`. */
  manager_index: Record<string, number>;
  /** roster_id -> index into `teams`. */
  roster_index: Record<number, number>;
  ownership: TeamStateOwnershipContext;
  /** current-week matchup pairs by roster_id. `[a, b]` or `[a, null]` for a bye. */
  matchup_pairs: [number, number | null][];
  /** league-wide factual position summary: Σ counts + how many teams are `broken`/`bare` at each key. */
  league_position_summary: {
    slot_key: string;
    total_active: number;
    teams_broken: number;
    teams_bare: number;
    teams_thin: number;
    teams_surplus: number;
  }[];
  warnings: string[];
}

/* ------------------------------------------------------------ change events */

export type TeamStateChangeType =
  | "PLAYER_ADDED"
  | "PLAYER_DROPPED"
  | "PLAYER_OWNERSHIP_CHANGED"
  | "PLAYER_MOVED_TO_STARTER"
  | "PLAYER_MOVED_TO_BENCH"
  | "PLAYER_MOVED_TO_IR"
  | "PLAYER_RETURNED_FROM_IR"
  | "PLAYER_INJURY_STATUS_CHANGED"
  | "PLAYER_NFL_TEAM_CHANGED"
  | "MANAGER_NAME_CHANGED"
  | "TEAM_NAME_CHANGED"
  | "SCORING_CHANGED"
  | "ROSTER_CONFIG_CHANGED"
  | "MATCHUP_CHANGED"
  | "WEEK_ADVANCED"
  | "LEAGUE_STATUS_CHANGED";

export interface TeamStateChange {
  type: TeamStateChangeType;
  /** the team the change concerns (null for league-wide changes). */
  roster_id: number | null;
  canonical_team_id: string | null;
  /** the player the change concerns, when player-scoped. */
  player_id: string | null;
  player_name: string | null;
  before: string | number | null;
  after: string | number | null;
  /** the two snapshot ids this diff was computed between. */
  from_snapshot_id: string;
  to_snapshot_id: string;
}

export interface TeamStateDiff {
  from_snapshot_id: string;
  to_snapshot_id: string;
  week_changed: boolean;
  scoring_changed: boolean;
  roster_config_changed: boolean;
  changes: TeamStateChange[];
}
