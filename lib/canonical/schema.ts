/**
 * Canonical, provider-independent fantasy schema.
 *
 * THIS is the internal analytical model. Sleeper and Yahoo are data providers;
 * they do not define these shapes. Every provider adapter converts its native
 * payloads into the entities below, and every downstream analytical/persistence
 * consumer reads only these — never a `RawRoster`, never a Yahoo collection.
 *
 * Design rules:
 *  - Provenance is preserved. Every entity that came from a provider carries the
 *    `provider` name and the provider's own id(s) alongside the canonical id.
 *  - Missing data is `null` or an explicit warning, never invented.
 *  - Canonical ids are deterministic (see `lib/canonical/ids.ts`) so the same
 *    real-world entity gets the same id across runs and across providers where
 *    possible.
 *
 * Bump {@link CANONICAL_SCHEMA_VERSION} on any breaking shape change; persisted
 * snapshots record the version they were written under.
 */

export const CANONICAL_SCHEMA_VERSION = 1 as const;

/** Every provider this architecture is designed to accept. */
export type ProviderName = "sleeper" | "yahoo" | "espn";

/** Degraded-state vocabulary shared across the whole bridge. */
export type DegradedStatus =
  | "READY"
  | "DEGRADED"
  | "PARTIAL"
  | "NOT_CONFIGURED"
  | "AUTH_REQUIRED"
  | "PROVIDER_ERROR"
  | "PERSISTENCE_NOT_CONFIGURED"
  | "PERSISTENCE_ERROR";

export interface CanonicalWarning {
  /** Stable machine code, e.g. `HISTORY_PERSISTENCE_UNAVAILABLE`. */
  code: string;
  message: string;
  /** Optional pointer at the thing that degraded (a route, a provider call). */
  resource?: string;
}

/** Provenance stamped onto every provider-sourced entity. */
export interface Provenance {
  provider: ProviderName;
  /** The provider's own primary id for this entity, verbatim. */
  provider_id: string | null;
  /** When the provider's copy of this data was last known-good. */
  provider_synced_at: string | null;
}

/* -------------------------------------------------------------------------- */
/* Players + identity                                                          */
/* -------------------------------------------------------------------------- */

export type CanonicalPosition =
  | "QB"
  | "RB"
  | "WR"
  | "TE"
  | "K"
  | "DEF"
  | "DL"
  | "LB"
  | "DB"
  | "IDP_FLEX"
  | "UNKNOWN";

/**
 * One real NFL player (or team DST), identified independently of any fantasy
 * provider. `canonical_player_id` is the stable key the analytical system uses.
 */
export interface CanonicalPlayer {
  canonical_player_id: string;
  full_name: string;
  first_name: string | null;
  last_name: string | null;
  position: CanonicalPosition;
  /** All fantasy-eligible positions the player can fill. */
  eligible_positions: CanonicalPosition[];
  nfl_team: string | null;
  /** True for a team defense/special-teams entity rather than an individual. */
  is_team_defense: boolean;
  status: string | null;
  injury_status: string | null;
  /** Cross-provider id crosswalk. Only keys that actually resolved are present. */
  identifiers: PlayerIdentifiers;
  /** How this identity was established — never silently guessed. */
  resolution: PlayerResolution;
}

export interface PlayerIdentifiers {
  sleeper_id?: string;
  yahoo_id?: string;
  yahoo_player_key?: string;
  espn_id?: string;
  gsis_id?: string;
  pfr_id?: string;
  /** Slug of `full_name|position|team` used as a last-resort join key. */
  name_key?: string;
}

export interface PlayerResolution {
  method: "stable_id" | "name_position_team" | "name_position" | "unresolved";
  confidence: "exact" | "high" | "low" | "none";
  /** Populated when `method === "unresolved"`. */
  note: string | null;
}

/* -------------------------------------------------------------------------- */
/* League, managers, teams                                                     */
/* -------------------------------------------------------------------------- */

export interface CanonicalScoringRule {
  /** Canonical stat key (Sleeper's vocabulary is used as the canonical one). */
  key: string;
  points: number;
  category:
    | "passing"
    | "rushing"
    | "receiving"
    | "kicking"
    | "defense"
    | "special_teams"
    | "misc";
}

export interface CanonicalRosterSettings {
  /** Ordered starting lineup slots, e.g. `["QB","RB","RB","WR","WR","TE","FLEX","K","DEF"]`. */
  starting_slots: string[];
  bench_slots: number;
  ir_slots: number;
  taxi_slots: number;
  /** How many of each starting slot are required, e.g. `{ RB: 2, FLEX: 1 }`. */
  slot_requirements: Record<string, number>;
}

export interface CanonicalPlayoffSettings {
  playoff_team_count: number | null;
  playoff_start_week: number | null;
  championship_week: number | null;
}

export interface CanonicalWaiverSettings {
  type: "faab" | "rolling" | "reverse_standings" | "unknown";
  faab_budget: number | null;
  waiver_day: string | null;
}

export interface CanonicalLeague {
  canonical_league_id: string;
  /** Stable registry slug — the addressable identity everywhere in the bridge. */
  league_slug: string;
  name: string;
  season: number;
  /** `pre_draft | drafting | in_season | post_season | complete | unknown`. */
  status: string;
  sport: "nfl";
  team_count: number;
  current_week: number | null;
  scoring_rules: CanonicalScoringRule[];
  /** Verbatim provider scoring map, kept for the scoring engine + audit. */
  raw_scoring: Record<string, number>;
  roster_settings: CanonicalRosterSettings;
  playoff_settings: CanonicalPlayoffSettings;
  waiver_settings: CanonicalWaiverSettings;
  provenance: Provenance;
}

/** A person who manages a team. Identity is never inferred from a display name. */
export interface CanonicalManager {
  canonical_manager_id: string;
  /** Stable URL slug. */
  manager_slug: string;
  /** Provider account handle (Sleeper username, Yahoo guid), exact-cased. */
  provider_username: string | null;
  display_name: string | null;
  provider_user_id: string | null;
  is_commissioner: boolean;
  is_co_manager: boolean;
  provenance: Provenance;
}

export interface CanonicalRosterSlot {
  /** The starting slot label this entry fills, or `BN` / `IR` / `TAXI`. */
  slot: string;
  slot_index: number;
  canonical_player_id: string | null;
  /** True for an unfilled starting slot. */
  is_empty: boolean;
}

export interface CanonicalRoster {
  canonical_roster_id: string;
  canonical_team_id: string;
  /** Ordered lineup + bench + IR + taxi, as slots. */
  slots: CanonicalRosterSlot[];
  starters: string[];
  bench: string[];
  ir: string[];
  taxi: string[];
  /** Everything rostered, deduped. */
  all_players: string[];
  provenance: Provenance;
}

export interface CanonicalRecord {
  wins: number;
  losses: number;
  ties: number;
  points_for: number;
  points_against: number;
}

export interface CanonicalFantasyTeam {
  canonical_team_id: string;
  canonical_league_id: string;
  /** Provider-local team id (Sleeper roster_id as string, Yahoo team_key). */
  provider_team_id: string | null;
  team_name: string | null;
  canonical_manager_ids: string[];
  record: CanonicalRecord;
  faab_remaining: number | null;
  waiver_priority: number | null;
  provenance: Provenance;
}

export interface CanonicalStanding {
  canonical_team_id: string;
  rank: number | null;
  wins: number;
  losses: number;
  ties: number;
  win_percentage: number | null;
  points_for: number;
  points_against: number;
  games_played: number;
  playoff_seed: number | null;
}

/* -------------------------------------------------------------------------- */
/* Matchups                                                                    */
/* -------------------------------------------------------------------------- */

export interface CanonicalMatchupSide {
  canonical_team_id: string;
  canonical_manager_ids: string[];
  starters: string[];
  bench: string[];
  /** Points scored so far this week, if the provider reports them. */
  actual_points: number | null;
  /** Per-player points, keyed by canonical_player_id, if reported. */
  player_points: Record<string, number>;
  /** Reserved for a future projection layer; always null in this phase. */
  projected_points: number | null;
}

export interface CanonicalMatchup {
  canonical_matchup_id: string;
  canonical_league_id: string;
  week: number;
  status: "pre" | "in_progress" | "final" | "unknown";
  sides: CanonicalMatchupSide[];
  provenance: Provenance;
}

/* -------------------------------------------------------------------------- */
/* Transactions + draft                                                        */
/* -------------------------------------------------------------------------- */

export type CanonicalTransactionType =
  | "draft_pick"
  | "waiver_add"
  | "free_agent_add"
  | "drop"
  | "trade"
  | "ir_move"
  | "commissioner"
  | "other";

export interface CanonicalPlayerMove {
  canonical_player_id: string;
  /** Canonical team the player moved to (adds) or from (drops). */
  canonical_team_id: string | null;
}

export interface CanonicalTradeLeg {
  canonical_team_id: string;
  received_player_ids: string[];
  received_pick_labels: string[];
  received_faab: number;
}

export interface CanonicalTransaction {
  canonical_transaction_id: string;
  canonical_league_id: string;
  league_slug: string;
  season: number;
  type: CanonicalTransactionType;
  status: string | null;
  /** ISO timestamp the provider assigned. */
  provider_timestamp: string | null;
  fantasy_week: number | null;
  canonical_team_ids: string[];
  players_added: CanonicalPlayerMove[];
  players_dropped: CanonicalPlayerMove[];
  /** Populated for trades only. */
  trade_legs: CanonicalTradeLeg[];
  faab_spent: number | null;
  provenance: Provenance;
  /** Free-form provider provenance kept for audit/debug. */
  source_metadata: Record<string, unknown>;
}

export interface CanonicalDraftPick {
  canonical_draft_pick_id: string;
  canonical_league_id: string;
  season: number;
  round: number;
  pick_number: number;
  draft_slot: number | null;
  canonical_team_id: string | null;
  canonical_manager_id: string | null;
  canonical_player_id: string | null;
  /** Auction leagues only. */
  auction_amount: number | null;
  is_keeper: boolean;
  provenance: Provenance;
}

/* -------------------------------------------------------------------------- */
/* Waiver / free-agent surface                                                 */
/* -------------------------------------------------------------------------- */

export type OwnershipState = "rostered" | "free_agent" | "waiver" | "locked";

export interface CanonicalWaiverState {
  canonical_league_id: string;
  league_slug: string;
  /** Per-player availability in THIS league only — never reused across leagues. */
  players: CanonicalAvailablePlayer[];
  provenance: Provenance;
}

export interface CanonicalAvailablePlayer {
  canonical_player_id: string;
  ownership: OwnershipState;
  /** Canonical team holding the player, when rostered. */
  canonical_team_id: string | null;
  /** When a waiver claim would clear, if the provider exposes it. */
  waiver_clears_at: string | null;
}

/* -------------------------------------------------------------------------- */
/* Aggregate: a full canonical snapshot of a league at a point in time         */
/* -------------------------------------------------------------------------- */

export interface CanonicalLeagueSnapshot {
  schema_version: typeof CANONICAL_SCHEMA_VERSION;
  captured_at: string;
  /** The provider's own freshness stamp for the underlying data. */
  provider_synced_at: string | null;
  league: CanonicalLeague;
  season: number;
  week: number;
  managers: CanonicalManager[];
  teams: CanonicalFantasyTeam[];
  rosters: CanonicalRoster[];
  standings: CanonicalStanding[];
  matchups: CanonicalMatchup[];
  recent_transactions: CanonicalTransaction[];
  draft_picks: CanonicalDraftPick[];
  waiver_state: CanonicalWaiverState | null;
  /** Player metadata for every canonical_player_id referenced above. */
  players: CanonicalPlayer[];
  /** Identities the crosswalk could not resolve to a stable id. */
  unresolved_players: UnresolvedPlayer[];
  live_provider_status: DegradedStatus;
  history_persistence_status: DegradedStatus;
  warnings: CanonicalWarning[];
}

export interface UnresolvedPlayer {
  provider: ProviderName;
  provider_player_id: string | null;
  observed_name: string | null;
  observed_position: string | null;
  observed_team: string | null;
  reason: string;
}
