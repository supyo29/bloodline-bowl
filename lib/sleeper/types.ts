/**
 * Type definitions for the Sleeper public read-only API.
 *
 * `Raw*` types mirror what Sleeper actually returns. Sleeper is loose about
 * nullability and occasionally adds fields, so raw types stay permissive and the
 * normalization layer is responsible for tightening things up.
 *
 * Everything else in this file describes the normalized shape served by
 * `GET /api/league`.
 */

/* -------------------------------------------------------------------------- */
/* Raw Sleeper payloads                                                        */
/* -------------------------------------------------------------------------- */

export interface RawNflState {
  week: number;
  leg: number;
  season: string;
  season_type: string;
  league_season: string;
  previous_season: string;
  season_start_date: string;
  display_week: number;
  league_create_season: string;
  season_has_scores: boolean;
}

export interface RawLeague {
  league_id: string;
  name: string;
  status: string;
  season: string;
  season_type: string;
  sport: string;
  total_rosters: number;
  roster_positions: string[];
  scoring_settings: Record<string, number>;
  settings: Record<string, number>;
  metadata: Record<string, string> | null;
  avatar: string | null;
  draft_id: string | null;
  previous_league_id: string | null;
  bracket_id: string | number | null;
  loser_bracket_id: string | number | null;
  company_id: string | null;
}

export interface RawLeagueUser {
  user_id: string;
  display_name: string;
  avatar: string | null;
  is_owner: boolean | null;
  is_bot: boolean | null;
  league_id: string;
  /** `team_name` lives here when a manager has set a custom team name. */
  metadata: Record<string, string | null> | null;
  settings: Record<string, unknown> | null;
}

export interface RawRosterSettings {
  wins?: number;
  losses?: number;
  ties?: number;
  fpts?: number;
  fpts_decimal?: number;
  fpts_against?: number;
  fpts_against_decimal?: number;
  waiver_position?: number;
  waiver_budget_used?: number;
  total_moves?: number;
  division?: number;
  [key: string]: number | undefined;
}

export interface RawRoster {
  roster_id: number;
  league_id: string;
  /** Null for teams nobody has claimed yet. */
  owner_id: string | null;
  co_owners: string[] | null;
  /** Null (not `[]`) on empty rosters. Contains sentinel `"0"` entries in `starters`. */
  players: string[] | null;
  starters: string[] | null;
  reserve: string[] | null;
  taxi: string[] | null;
  keepers: string[] | null;
  settings: RawRosterSettings | null;
  metadata: Record<string, string | null> | null;
}

export interface RawDraft {
  draft_id: string;
  league_id: string;
  season: string;
  season_type: string;
  sport: string;
  status: string;
  type: string;
  start_time: number | null;
  created: number | null;
  last_picked: number | null;
  settings: Record<string, number> | null;
  metadata: Record<string, string> | null;
  /** Maps `user_id` -> draft slot. Null before the order is set. */
  draft_order: Record<string, number> | null;
  /** Maps draft slot -> `roster_id`. Null before the order is set. */
  slot_to_roster_id: Record<string, number> | null;
  creators: string[] | null;
}

export interface RawDraftPick {
  draft_id: string;
  player_id: string | null;
  /** `user_id` of the manager who made the pick. */
  picked_by: string | null;
  /** Sleeper returns this as a string on the picks endpoint. */
  roster_id: string | number | null;
  round: number;
  draft_slot: number;
  pick_no: number;
  is_keeper: boolean | null;
  /** Denormalized player snapshot at pick time; also carries auction `amount`. */
  metadata: Record<string, string> | null;
}

/**
 * A traded pick. Per Sleeper's docs:
 *   - `roster_id`          -> roster_id of the ORIGINAL owner
 *   - `previous_owner_id`  -> roster_id of the previous owner
 *   - `owner_id`           -> roster_id of the CURRENT owner
 */
export interface RawTradedPick {
  season: string;
  round: number;
  roster_id: number;
  previous_owner_id: number | null;
  owner_id: number;
}

/** One entry of the ~12k-player `/players/nfl` dump. */
export interface RawPlayer {
  player_id?: string;
  full_name?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  position?: string | null;
  fantasy_positions?: string[] | null;
  team?: string | null;
  age?: number | null;
  years_exp?: number | null;
  status?: string | null;
  injury_status?: string | null;
  number?: number | null;
  active?: boolean | null;
  depth_chart_order?: number | null;
  search_rank?: number | null;
  [key: string]: unknown;
}

/* -------------------------------------------------------------------------- */
/* Normalized output                                                           */
/* -------------------------------------------------------------------------- */

/** The trimmed player object embedded in the response. */
export interface NormalizedPlayer {
  player_id: string;
  full_name: string;
  first_name: string | null;
  last_name: string | null;
  position: string | null;
  fantasy_positions: string[];
  team: string | null;
  age: number | null;
  years_exp: number | null;
  status: string | null;
  injury_status: string | null;
  number: number | null;
  /** Whether Sleeper still lists the player as active in the NFL. */
  active: boolean | null;
  /**
   * Sleeper's own relevance ordering (lower is more prominent). Used to rank
   * the available-player pool during a draft rather than inventing rankings.
   */
  search_rank: number | null;
  /** False when the id was not found in Sleeper's player database. */
  resolved: boolean;
}

export interface NormalizedManager {
  user_id: string | null;
  display_name: string | null;
  team_name: string | null;
  avatar: string | null;
  is_owner: boolean;
  is_bot: boolean;
  /** True when no manager has claimed this roster yet. */
  is_vacant: boolean;
  co_owner_user_ids: string[];
}

export interface NormalizedRecord {
  wins: number;
  losses: number;
  ties: number;
  points_for: number;
  points_against: number;
  waiver_position: number | null;
  waiver_budget_used: number | null;
  total_moves: number | null;
  division: number | null;
}

/** A lineup slot, paired with the player currently filling it (if any). */
export interface NormalizedStarterSlot {
  slot: number;
  roster_position: string | null;
  player: NormalizedPlayer | null;
  /** True when the slot is an unfilled `"0"` sentinel from Sleeper. */
  is_empty: boolean;
}

export interface NormalizedDraftPickAsset {
  season: string;
  round: number;
  original_roster_id: number;
  current_owner_roster_id: number;
  previous_owner_roster_id: number | null;
  /** True when this pick has changed hands at least once. */
  is_traded: boolean;
  /** True when the owning roster is not the roster that originally held it. */
  is_acquired: boolean;
  /** Rounds are inferred for seasons with no draft object yet — see `rounds_source`. */
  rounds_source: "draft" | "league_settings" | "traded_picks";
}

export interface NormalizedTeamSummary {
  /** Count of rostered players by primary position, e.g. `{ QB: 3, RB: 5 }`. */
  position_counts: Record<string, number>;
  player_count: number;
  starter_count: number;
  empty_starter_slots: number;
  bench_count: number;
  taxi_count: number;
  reserve_count: number;
  own_picks_held: number;
  picks_acquired: number;
  picks_traded_away: number;
  total_picks_held: number;
}

export interface NormalizedTeam {
  roster_id: number;
  manager: NormalizedManager;
  record: NormalizedRecord;
  players: NormalizedPlayer[];
  starters: NormalizedStarterSlot[];
  bench: NormalizedPlayer[];
  taxi: NormalizedPlayer[];
  reserve: NormalizedPlayer[];
  keepers: NormalizedPlayer[];
  draft_picks: NormalizedDraftPickAsset[];
  summary: NormalizedTeamSummary;
}

export interface NormalizedDraftPick {
  pick_no: number;
  round: number;
  draft_slot: number;
  roster_id: number | null;
  picked_by: {
    user_id: string | null;
    display_name: string | null;
  };
  is_keeper: boolean;
  /** Auction drafts only: winning bid amount. */
  auction_amount: number | null;
  player: NormalizedPlayer | null;
}

export interface NormalizedDraft {
  draft_id: string;
  season: string;
  season_type: string;
  status: string;
  type: string;
  rounds: number;
  start_time: string | null;
  created_at: string | null;
  settings: Record<string, number>;
  metadata: Record<string, string>;
  /** Draft slot -> roster, resolved to manager names where possible. */
  draft_order: Array<{
    draft_slot: number;
    roster_id: number | null;
    user_id: string | null;
    display_name: string | null;
  }>;
  pick_count: number;
  picks: NormalizedDraftPick[];
}

export interface NormalizedTradedPick {
  season: string;
  round: number;
  original_roster_id: number;
  original_owner_display_name: string | null;
  previous_owner_roster_id: number | null;
  previous_owner_display_name: string | null;
  current_owner_roster_id: number;
  current_owner_display_name: string | null;
}

/** Non-fatal problems encountered while assembling the response. */
export interface ResponseWarning {
  code: string;
  message: string;
  resource?: string;
}

export interface LeagueResponse {
  generated_at: string;
  source: "Sleeper";
  league_id: string;
  nfl_state: RawNflState | null;
  league: {
    league_id: string;
    name: string;
    season: string;
    season_type: string;
    sport: string;
    status: string;
    /** Plain-English gloss on `status`, since Sleeper's values are terse. */
    status_description: string;
    total_rosters: number;
    avatar_url: string | null;
    previous_league_id: string | null;
    roster_positions: string[];
    starting_lineup: {
      slots: string[];
      total_starters: number;
      bench_slots: number;
      taxi_slots: number;
      reserve_slots: number;
      position_requirements: Record<string, number>;
    };
    scoring_settings: Record<string, number>;
    settings: Record<string, number>;
    /** Human-readable gloss of the settings that matter most for analysis. */
    key_settings: Record<string, string | number | boolean>;
  };
  teams: NormalizedTeam[];
  drafts: NormalizedDraft[];
  traded_picks: NormalizedTradedPick[];
  league_state: {
    is_pre_draft: boolean;
    rosters_filled: boolean;
    claimed_teams: number;
    vacant_teams: number;
    total_rostered_players: number;
    total_draft_picks_made: number;
    notes: string[];
  };
  metadata: {
    player_count: number;
    team_count: number;
    draft_count: number;
    traded_pick_count: number;
    unresolved_player_ids: string[];
    player_database_size: number;
    warnings: ResponseWarning[];
    /** Milliseconds spent assembling this response. */
    build_ms: number;
  };
}

/* -------------------------------------------------------------------------- */
/* Live draft endpoint (`GET /api/draft`)                                      */
/* -------------------------------------------------------------------------- */

/** A completed acquisition, trimmed for repeated polling during a draft. */
export interface DraftAcquisition {
  pick_no: number;
  round: number;
  draft_slot: number;
  roster_id: number | null;
  manager: {
    user_id: string | null;
    display_name: string | null;
  };
  player: NormalizedPlayer | null;
  /** Winning auction bid, or null when Sleeper did not expose one. */
  price: number | null;
  is_keeper: boolean;
}

export interface DraftBudgetInfo {
  /** True only for auction drafts that expose a per-team budget. */
  supported: boolean;
  /** Where prices come from, or null when unsupported. */
  source: "sleeper_pick_metadata" | null;
  /** Present only when `supported` is false. */
  reason?: string;
  starting_budget_per_team: number | null;
  minimum_bid: number;
  /** Sleeper exposes no minimum-bid setting, so this is normally assumed. */
  minimum_bid_source: "draft_settings" | "assumed_default";
  /**
   * Whether completed picks actually carried prices. Null before any pick is
   * made, since there is nothing to judge yet.
   */
  prices_available: boolean | null;
  /** Completed picks with no price attached. */
  picks_missing_price: number;
}

export interface DraftTeam {
  roster_id: number;
  draft_slot: number | null;
  manager: {
    user_id: string | null;
    display_name: string | null;
    team_name: string | null;
    is_vacant: boolean;
  };
  players_acquired: Array<{
    player_id: string;
    full_name: string;
    position: string | null;
    team: string | null;
    price: number | null;
    pick_no: number;
  }>;
  roster: {
    players_acquired: number;
    slots_required: number;
    slots_remaining: number;
  };
  /** Null for non-auction drafts. */
  budget: {
    starting: number;
    spent: number;
    remaining: number;
    minimum_required_for_remaining_slots: number;
    maximum_single_bid: number;
    can_bid: boolean;
  } | null;
  positions: Record<string, number>;
  needs: {
    required: Array<{ position: string; minimum_needed: number }>;
    flexible_slots_remaining: number;
    bench_slots_remaining: number;
    starters_filled: number;
    starters_required: number;
  };
}

export interface DraftResponse {
  generated_at: string;
  source: "Sleeper";
  league_id: string;
  draft: {
    draft_id: string;
    season: string;
    status: string;
    /** Plain-English gloss, since Sleeper's status values are terse. */
    status_description: string;
    type: string;
    rounds: number;
    total_picks: number;
    completed_picks: number;
    remaining_picks: number;
    /** Sleeper's last-pick timestamp, when present. */
    last_picked_at: string | null;
    nomination_timer_seconds: number | null;
    pick_timer_seconds: number | null;
  } | null;
  budget: DraftBudgetInfo;
  last_pick: DraftAcquisition | null;
  teams: DraftTeam[];
  picks: DraftAcquisition[];
  available_players: NormalizedPlayer[];
  market: {
    /** Null for non-auction drafts. */
    highest_remaining_budget: number | null;
    lowest_remaining_budget: number | null;
    largest_max_bid: number | null;
    /** Roster ids that can still outbid everyone else, most capable first. */
    top_bidders: Array<{
      roster_id: number;
      display_name: string | null;
      maximum_single_bid: number;
      remaining: number;
      slots_remaining: number;
    }>;
  };
  metadata: {
    polling_safe: boolean;
    cache_seconds: number;
    team_count: number;
    available_players: {
      returned: number;
      total_matching: number;
      limit: number;
      position_filter: string | null;
      /** How the pool was ordered and what coverage is guaranteed. */
      ordering: string;
    };
    player_database_size: number;
    warnings: ResponseWarning[];
    build_ms: number;
  };
}
