/**
 * Canonical Roster Intel projection schema.
 *
 * Three layers, kept strictly separate (see `lib/projections/README` and the
 * repo README "Projection layers" section):
 *
 *   Layer 1 — football projection      (this file's `PlayerProjection`)
 *     scoring-neutral. "What do we expect this NFL player to actually do?"
 *     Identical for every league and every manager.
 *
 *   Layer 2 — league scoring translation  (`LeagueProjection`, lib/projections/league.ts)
 *     keyed by league_id + scoring_hash. Two managers in one league get the
 *     same numbers.
 *
 *   Layer 3 — manager contextual value    (`ManagerProjectionValue`, lib/projections/manager-value.ts)
 *     keyed by league_id + sleeper_user_id + draft state. Does NOT change the
 *     Layer-1 projection.
 *
 * A player's projected receptions do not change because two managers view the
 * same player.
 */

export const PROJECTION_MODEL_VERSION = "ri-structural-2026.3";
export const PROJECTION_SCHEMA_VERSION = "projection.v1";

export type FantasyPosition = "QB" | "RB" | "WR" | "TE" | "K" | "DEF";

export type ProjectionConfidence = "HIGH" | "MEDIUM" | "LOW" | "VERY_LOW";

/** Whether a source fed the model, an ensemble, or is only a benchmark. */
export type SourceRole = "MODEL_INPUT" | "ENSEMBLE_INPUT" | "BENCHMARK_ONLY";

/* -------------------------------------------------------------------------- */
/* Layer 1 — scoring-neutral football projection                               */
/* -------------------------------------------------------------------------- */

export interface ProjectedFootballStats {
  /** Passing */
  pass_att: number | null;
  pass_cmp: number | null;
  cmp_pct: number | null;
  pass_yd: number | null;
  pass_ypa: number | null;
  pass_td: number | null;
  pass_int: number | null;
  pass_2pt: number | null;
  /** Rushing */
  rush_att: number | null;
  rush_yd: number | null;
  rush_ypa: number | null;
  rush_td: number | null;
  rush_2pt: number | null;
  /** Receiving */
  targets: number | null;
  rec: number | null;
  catch_rate: number | null;
  rec_yd: number | null;
  yprr: number | null;
  yptarget: number | null;
  rec_td: number | null;
  rec_2pt: number | null;
  /** Misc */
  fum_lost: number | null;
  /** Kicking */
  fg_att: number | null;
  fg_made: number | null;
  fg_made_0_39: number | null;
  fg_made_40_49: number | null;
  fg_made_50p: number | null;
  fg_miss: number | null;
  xp_made: number | null;
  xp_miss: number | null;
  /** Defense / special teams (season totals) */
  def_sack: number | null;
  def_int: number | null;
  def_fum_rec: number | null;
  def_td: number | null;
  def_safety: number | null;
  def_pts_allowed_per_game: number | null;
}

/** The opportunity / efficiency / TD / availability breakdown behind the number. */
export interface ProjectionComponents {
  /** 0..1 shares within the player's own team, recency-weighted + regressed. */
  snap_share: number | null;
  target_share: number | null;
  carry_share: number | null;
  rz_target_share: number | null;
  goal_line_share: number | null;
  /** Team-level priors this player's volume was allocated from. */
  team_pass_att: number | null;
  team_rush_att: number | null;
  team_plays: number | null;
  team_pass_td: number | null;
  team_rush_td: number | null;
  /** Additive component decomposition of projected points (league-neutral proxy = PPR). */
  volume_component: number | null;
  efficiency_component: number | null;
  td_component: number | null;
  availability_component: number | null;
  rookie_prior_weight: number | null;
  age_multiplier: number | null;
}

export interface AvailabilityProjection {
  games_if_healthy: number;
  expected_games: number;
  availability_probability: number;
  /** Free-text reason when expected_games is materially below games_if_healthy. */
  note: string | null;
}

/** P20 / P50 / P80 fantasy-point outcomes (PPR-neutral for Layer 1). */
export interface OutcomeBand {
  floor: number;
  median: number;
  ceiling: number;
  /** Standard deviation of the season-point distribution. */
  sd: number;
  /** Documented percentiles behind floor/ceiling. */
  percentiles: { floor: number; ceiling: number };
}

export interface ProjectionConfidenceDetail {
  bucket: ProjectionConfidence;
  score: number; // 0..1
  reasons: string[];
  sample_seasons: number;
  is_rookie: boolean;
  team_changed: boolean;
  injury_flagged: boolean;
}

export interface PlayerProjection {
  schema_version: string;
  model_version: string;
  season: number;
  generated_at: string;
  data_as_of: string;

  /* identity */
  player_id: string; // canonical = Sleeper player_id
  sleeper_player_id: string;
  full_name: string;
  position: FantasyPosition;
  team: string | null;
  age: number | null;
  years_exp: number | null;

  /* Layer 1 */
  stats: ProjectedFootballStats;
  components: ProjectionComponents;
  availability: AvailabilityProjection;

  /** PPR-neutral season points and per-game (a league-agnostic reference only). */
  neutral_points: number;
  neutral_ppg: number;
  outcome: OutcomeBand;

  confidence: ProjectionConfidenceDetail;

  /* provenance */
  sources: Record<string, { role: SourceRole; used: boolean }>;
  warnings: string[];
}

/* -------------------------------------------------------------------------- */
/* Layer 2 — league scoring translation                                        */
/* -------------------------------------------------------------------------- */

export interface LeagueProjection {
  player_id: string;
  full_name: string;
  position: FantasyPosition;
  team: string | null;

  league_slug: string;
  league_id: string;
  scoring_hash: string;

  /** Roster Intel football stats -> this league's scoring. */
  league_points: number;
  league_ppg: number;
  league_outcome: OutcomeBand;

  /** Sleeper's projected football stats -> this league's scoring (apples-to-apples). */
  sleeper_league_points: number | null;

  /** Roster Intel vs Sleeper under THIS league's scoring. */
  vs_sleeper: {
    delta_points: number | null;
    delta_pct: number | null;
    ri_rank: number | null;
    sleeper_rank: number | null;
    rank_delta: number | null;
    primary_driver: string | null;
  };

  /** Value over replacement, derived from this league's lineup configuration. */
  replacement_points: number | null;
  value_over_replacement: number | null;
  vor_rank: number | null;
  position_rank: number | null;
  overall_rank: number | null;
  tier: number | null;

  confidence: ProjectionConfidence;
}

/* -------------------------------------------------------------------------- */
/* Layer 3 — manager contextual value                                          */
/* -------------------------------------------------------------------------- */

export interface ManagerProjectionValue {
  player_id: string;
  full_name: string;
  position: FantasyPosition;

  /** Echo of the resolved manager identity (never affects Layer 1/2). */
  used_roster_id: number;
  used_sleeper_user_id: string;

  /** Need-weighted value for THIS manager's current roster. */
  roster_fit: string;
  fills_open_starter: boolean;
  need_multiplier: number;
  contextual_value: number;

  /** Projection-edge signal, surfaced to the draft engine (informational). */
  projection_edge: {
    ri_vs_sleeper_pct: number | null;
    direction: "RI_ABOVE" | "RI_BELOW" | "AGREES" | "NO_BENCHMARK";
    primary_driver: string | null;
    confidence: ProjectionConfidence;
  };
}

/* -------------------------------------------------------------------------- */

export const EMPTY_STATS: ProjectedFootballStats = {
  pass_att: null, pass_cmp: null, cmp_pct: null, pass_yd: null, pass_ypa: null,
  pass_td: null, pass_int: null, pass_2pt: null,
  rush_att: null, rush_yd: null, rush_ypa: null, rush_td: null, rush_2pt: null,
  targets: null, rec: null, catch_rate: null, rec_yd: null, yprr: null,
  yptarget: null, rec_td: null, rec_2pt: null,
  fum_lost: null,
  fg_att: null, fg_made: null, fg_made_0_39: null, fg_made_40_49: null,
  fg_made_50p: null, fg_miss: null, xp_made: null, xp_miss: null,
  def_sack: null, def_int: null, def_fum_rec: null, def_td: null,
  def_safety: null, def_pts_allowed_per_game: null,
};
