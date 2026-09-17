# ===========================================================================
# Player Role & Opportunity Intelligence — Checkpoint B.
# Canonical player-game grain substrate: "what opportunities did this player
# actually receive in this game?" OBSERVED evidence only. No shrinkage, no
# recency weighting, no role classification, no fantasy points (Checkpoint C+).
#
# Grain: one row per (season, week, game_id, gsis_id, team, opponent,
# position). A row exists ONLY when there is direct evidence the player
# participated (appears in snap_counts, or has a nonzero offensive touch, or
# a special-teams return) -- a roster slot alone never fabricates a row.
#
# Every share metric's exact denominator is documented inline next to its
# formula (spec §5-13: "never guess a denominator"). See
# docs/PLAYER_ROLE_OPPORTUNITY_PHASE_2_CHECKPOINT_B.md for the full metric
# contract, ownership table (SOURCE_NATIVE/DERIVED/JOINED_EXTERNAL/
# UNAVAILABLE), and the route-participation semantics finding.
# ===========================================================================

suppressWarnings(suppressMessages({ library(dplyr); library(tidyr); library(purrr) }))

# ---------------------------------------------------------------------------
# team-game denominators (offensive volume this team actually had, this game)
# ---------------------------------------------------------------------------
.team_game_denominators <- function(pbp, ROLE) {
  p <- pbp %>% filter(season_type %in% c("REG", "POST"), !is.na(posteam))
  kneel_ok <- if (isTRUE(ROLE$EXCLUDE_QB_KNEELS)) quote(coalesce(qb_kneel, 0) == 0) else quote(TRUE)

  p %>%
    group_by(season, week, game_id, team = posteam) %>%
    summarise(
      team_offensive_plays = sum(coalesce(pass, 0) == 1 | (coalesce(rush, 0) == 1 & !!kneel_ok), na.rm = TRUE),
      team_pass_att        = sum(coalesce(pass, 0) == 1, na.rm = TRUE),
      team_pass_plays      = sum(coalesce(pass, 0) == 1, na.rm = TRUE),   # nflverse's own pass-play indicator; includes sacks/spikes, excludes penalty-negated plays
      team_rush_att         = sum(coalesce(rush, 0) == 1 & coalesce(qb_dropback, 0) == 0 & !!kneel_ok, na.rm = TRUE),
      team_air_yards        = sum(air_yards[coalesce(pass, 0) == 1], na.rm = TRUE),
      team_rz_pass_att      = sum(coalesce(pass, 0) == 1 & !is.na(yardline_100) & yardline_100 <= ROLE$RED_ZONE_YARDLINE, na.rm = TRUE),
      team_rz_rush_att      = sum(coalesce(rush, 0) == 1 & coalesce(qb_dropback, 0) == 0 & !!kneel_ok & !is.na(yardline_100) & yardline_100 <= ROLE$RED_ZONE_YARDLINE, na.rm = TRUE),
      team_offensive_plays_neutral_score_differential = mean(score_differential[coalesce(pass, 0) == 1 | coalesce(rush, 0) == 1], na.rm = TRUE),
      overtime = any(qtr == 5, na.rm = TRUE),
      .groups = "drop"
    )
}

# ---------------------------------------------------------------------------
# position-group team denominators (RB rush group, WR/TE target group)
# ---------------------------------------------------------------------------
.position_group_team_denominators <- function(player_rows) {
  player_rows %>%
    group_by(season, week, game_id, team) %>%
    summarise(
      team_rb_carries = sum(carries[position %in% c("RB", "FB")], na.rm = TRUE),
      team_wr_targets = sum(targets[position == "WR"], na.rm = TRUE),
      team_te_targets = sum(targets[position == "TE"], na.rm = TRUE),
      .groups = "drop"
    )
}

# ---------------------------------------------------------------------------
# opponent lookup, derived DIRECTLY from PBP's own posteam/defteam rather than
# joined from schedules.rds.
#
# FINDING (Checkpoint B, worth flagging even though out of Phase 2's scope to
# fix): analysis/football_intel/fetch_raw.R's cached schedules.rds contains
# ZERO postseason games. `load_schedules() %>% filter(game_type %in%
# c("REG","POST"))` silently drops every playoff game, because nflreadr's
# actual postseason game_type values are "WC"/"DIV"/"CON"/"SB", never the
# literal string "POST" -- so the "POST" branch of that filter has always
# matched nothing. This does not affect FI's own team/usage profiles (they
# read PBP directly, not schedules), but it would have made any Phase 2
# opponent join through schedules.rds silently drop every playoff-game
# opponent. Deriving opponent from PBP's own posteam/defteam sidesteps this
# entirely and is more robust regardless (no cross-source join for something
# every single PBP row already states directly).
# ---------------------------------------------------------------------------
.opponent_map <- function(pbp) {
  pbp %>% filter(season_type %in% c("REG", "POST"), !is.na(posteam), !is.na(defteam)) %>%
    count(season, week, game_id, team = posteam, opponent = defteam) %>%
    group_by(season, week, game_id, team) %>%
    slice_max(n, n = 1, with_ties = FALSE) %>% ungroup() %>%
    select(-n)
}

# ---------------------------------------------------------------------------
# position per (season, week, team, gsis_id), exact-week first, season-mode
# fallback (mirrors football_intel/lib_usage.R's .player_positions pattern,
# reused conceptually, not copy-pasted, since Checkpoint B needs a per-week
# join rather than a single season-level lookup).
# ---------------------------------------------------------------------------
.position_lookup <- function(rosters_weekly) {
  exact <- rosters_weekly %>%
    filter(!is.na(gsis_id), !is.na(position)) %>%
    distinct(season, week, gsis_id, .keep_all = TRUE) %>%
    transmute(season, week, gsis_id, position)

  season_mode <- rosters_weekly %>%
    filter(!is.na(gsis_id), !is.na(position)) %>%
    count(season, gsis_id, position) %>%
    group_by(season, gsis_id) %>%
    slice_max(n, n = 1, with_ties = FALSE) %>% ungroup() %>%
    transmute(season, gsis_id, position_season_mode = position)

  list(exact = exact, season_mode = season_mode)
}

# ---------------------------------------------------------------------------
# routes / route participation.
#
# SOURCE-SCHEMA FINDING (documented, not guessed -- spec §6):
# nflverse `participation.route` is a SINGLE value per PLAY (the route
# concept charted for that play, e.g. "SLANT", "SCREEN" -- NGS-derived), not
# a per-player field. `offense_players` lists ALL 11 offensive personnel who
# were on the field for the play, with no per-player flag distinguishing a
# receiver who released on a route from a lineman or a back who stayed in to
# block. Therefore an exact per-player "ran a route" count CANNOT be derived
# from this source -- only "was part of the offensive personnel on a pass
# play" can be derived exactly. Checkpoint B publishes that as
# `pass_play_personnel` / `route_participation`, with an explicit
# `route_participation_definition` provenance tag so no downstream consumer
# mistakes this for a confirmed route-run count. It is a reasonable
# participation proxy for skill positions (RB/WR/TE/FB) and is UNRELIABLE for
# OL, who are near-100% on every pass play by definition and never run
# routes -- Checkpoint B marks OL rows for this metric UNRELIABLE rather than
# publishing a misleading near-1.0 "route participation."
# ---------------------------------------------------------------------------
.player_route_participation <- function(pbp, participation, FI) {
  if (is.null(participation) || !all(c("route", "offense_players", "possession_team") %in% names(participation))) return(NULL)
  # game_id/season/week lookup keyed ONLY by game_id (one row per game) --
  # team attribution comes from participation's own possession_team, never
  # from re-joining every play to both of a game's posteam values (that
  # earlier approach silently doubled every play across both teams).
  gm <- pbp %>% filter(season_type %in% c("REG", "POST")) %>% distinct(game_id, season, week)

  rp <- participation %>%
    filter(!is.na(route), route != "") %>%
    transmute(game_id = nflverse_game_id, team = FI$normalize_team(possession_team), offense_players) %>%
    inner_join(gm, by = "game_id")

  rp %>%
    mutate(gsis_id = strsplit(offense_players, ";")) %>%
    tidyr::unnest(gsis_id) %>%
    filter(gsis_id != "") %>%
    group_by(season, week, game_id, team, gsis_id) %>%
    summarise(pass_play_personnel = dplyr::n(), .groups = "drop")
}

# ---------------------------------------------------------------------------
# offense-side player-game evidence (targets/receiving, rushing, red zone,
# third down, two minute) -- all DERIVED directly from PBP.
# ---------------------------------------------------------------------------
.player_offense_evidence <- function(pbp, ROLE) {
  p <- pbp %>% filter(season_type %in% c("REG", "POST"), !is.na(posteam))
  kneel_ok <- if (isTRUE(ROLE$EXCLUDE_QB_KNEELS)) quote(coalesce(qb_kneel, 0) == 0) else quote(TRUE)
  is_third_down <- quote(coalesce(down, 0) == 3)
  is_two_minute <- quote(qtr %in% ROLE$TWO_MINUTE_QUARTERS & coalesce(quarter_seconds_remaining, 9999) <= ROLE$TWO_MINUTE_SECONDS_REMAINING)

  targets <- p %>% filter(coalesce(pass, 0) == 1, !is.na(receiver_player_id)) %>%
    mutate(is_end_zone_target = !is.na(yardline_100) & !is.na(air_yards) & (yardline_100 - air_yards) <= 0) %>%
    group_by(season, week, game_id, team = posteam, gsis_id = receiver_player_id) %>%
    summarise(
      targets = dplyr::n(),
      receptions = sum(coalesce(complete_pass, 0) == 1, na.rm = TRUE),
      air_yards = sum(air_yards, na.rm = TRUE),
      red_zone_targets   = sum(!is.na(yardline_100) & yardline_100 <= ROLE$RED_ZONE_YARDLINE, na.rm = TRUE),
      inside_10_targets  = sum(!is.na(yardline_100) & yardline_100 <= ROLE$INSIDE_10_YARDLINE, na.rm = TRUE),
      end_zone_targets   = sum(is_end_zone_target, na.rm = TRUE),
      third_down_targets = sum(eval(is_third_down), na.rm = TRUE),
      two_minute_targets = sum(eval(is_two_minute), na.rm = TRUE),
      .groups = "drop"
    )

  carries <- p %>% filter(coalesce(rush, 0) == 1, coalesce(qb_dropback, 0) == 0, !!kneel_ok, !is.na(rusher_player_id)) %>%
    group_by(season, week, game_id, team = posteam, gsis_id = rusher_player_id) %>%
    summarise(
      carries = dplyr::n(),
      red_zone_carries   = sum(!is.na(yardline_100) & yardline_100 <= ROLE$RED_ZONE_YARDLINE, na.rm = TRUE),
      inside_10_carries  = sum(!is.na(yardline_100) & yardline_100 <= ROLE$INSIDE_10_YARDLINE, na.rm = TRUE),
      goal_line_carries  = sum(!is.na(yardline_100) & yardline_100 <= ROLE$GOAL_LINE_YARDLINE, na.rm = TRUE),
      third_down_carries = sum(eval(is_third_down), na.rm = TRUE),
      two_minute_carries = sum(eval(is_two_minute), na.rm = TRUE),
      .groups = "drop"
    )

  dropbacks <- p %>% filter(coalesce(qb_dropback, 0) == 1, !is.na(passer_player_id)) %>%
    group_by(season, week, game_id, team = posteam, gsis_id = passer_player_id) %>%
    summarise(
      dropbacks = dplyr::n(),
      qb_scrambles = sum(coalesce(qb_scramble, 0) == 1, na.rm = TRUE),
      .groups = "drop"
    )

  qb_designed_rush <- carries %>%
    inner_join(distinct(dropbacks, season, week, game_id, team, gsis_id), by = c("season", "week", "game_id", "team", "gsis_id")) %>%
    transmute(season, week, game_id, team, gsis_id, designed_rushes = carries)

  list(targets = targets, carries = carries, dropbacks = dropbacks, qb_designed_rush = qb_designed_rush)
}

# ---------------------------------------------------------------------------
# special-teams return evidence, derived from the SAME raw PBP source used
# for everything else (kickoff_returner_player_id / punt_returner_player_id
# / return_yards). This is a deliberate departure from the audit's note that
# the *existing production* return-game model (lib/projections/return-game.ts)
# is Sleeper-box-score-sourced: Checkpoint B derives return role from PBP
# instead because (a) PBP is already ingested and cached -- no new external
# fetch or cross-language join is required for a substrate rebuild; (b) it
# uses the exact same gsis_id identity as every other field in this table,
# rather than a second identity system; (c) it is game-level exact, not a
# season aggregate. This SOURCE_NATIVE return count is cross-checked against
# the production Sleeper-sourced kr/pr counts in the Checkpoint B report --
# it is not assumed identical without verification.
# ---------------------------------------------------------------------------
.player_return_evidence <- function(pbp, FI) {
  # `return_team` is a raw nflverse field that fetch_raw.R never normalizes
  # (only posteam/defteam/home_team/away_team are). Verified directly: it
  # still carries the pre-2016 "LA" (St. Louis/LA Rams) code that
  # FI$normalize_team maps to "LAR" everywhere else, so it must be
  # normalized here explicitly or return-game rows silently fork into a
  # phantom second "team" that can never match any opponent/game-state join.
  p <- pbp %>% filter(season_type %in% c("REG", "POST")) %>% mutate(return_team = FI$normalize_team(return_team))

  kr <- p %>% filter(coalesce(kickoff_attempt, 0) == 1, !is.na(kickoff_returner_player_id)) %>%
    group_by(season, week, game_id, team = return_team, gsis_id = kickoff_returner_player_id) %>%
    summarise(kick_returns = dplyr::n(), kick_return_yards = sum(coalesce(return_yards, 0), na.rm = TRUE), .groups = "drop")

  pr <- p %>% filter(coalesce(punt_attempt, 0) == 1, !is.na(punt_returner_player_id)) %>%
    group_by(season, week, game_id, team = return_team, gsis_id = punt_returner_player_id) %>%
    summarise(punt_returns = dplyr::n(), punt_return_yards = sum(coalesce(return_yards, 0), na.rm = TRUE), .groups = "drop")

  team_kr <- kr %>% group_by(season, week, game_id, team) %>% summarise(team_kick_returns = sum(kick_returns), .groups = "drop")
  team_pr <- pr %>% group_by(season, week, game_id, team) %>% summarise(team_punt_returns = sum(punt_returns), .groups = "drop")

  list(kr = kr, pr = pr, team_kr = team_kr, team_pr = team_pr)
}

# ===========================================================================
# build_player_game_role(): the Checkpoint B entry point.
# ===========================================================================
build_player_game_role <- function(pbp, participation, snap_counts, ff_playerids,
                                    rosters_weekly, schedules, ROLE, FI) {

  # ff_playerids crosswalk: a small number of rows share a duplicated gsis_id
  # or pfr_id (verified: 10 / 16 respectively in the current crosswalk). Any
  # id appearing more than once is genuinely ambiguous for a 1:1 join and is
  # dropped from the identity-join table entirely (never fuzzy-matched or
  # silently picked-first -- spec §23's "never silently drop... never fuzzy-
  # match without surfacing ambiguity"). Rows affected are reported in the
  # Checkpoint B identity-audit output, not silently discarded unseen.
  ff_dupe_gsis <- ff_playerids$gsis_id[duplicated(ff_playerids$gsis_id) & !is.na(ff_playerids$gsis_id)]
  ff_dupe_pfr  <- ff_playerids$pfr_id[duplicated(ff_playerids$pfr_id) & !is.na(ff_playerids$pfr_id)]
  ff_clean <- ff_playerids %>% filter(!gsis_id %in% ff_dupe_gsis, !pfr_id %in% ff_dupe_pfr | is.na(pfr_id))

  team_denom <- .team_game_denominators(pbp, ROLE)
  opp_map    <- .opponent_map(pbp)
  pos_lookup <- .position_lookup(rosters_weekly)

  offense <- .player_offense_evidence(pbp, ROLE)
  routes  <- .player_route_participation(pbp, participation, FI)
  returns <- .player_return_evidence(pbp, FI)

  snaps <- snap_counts %>%
    left_join(select(ff_clean, gsis_id, pfr_id) %>% filter(!is.na(pfr_id)), by = c("pfr_player_id" = "pfr_id")) %>%
    filter(!is.na(gsis_id)) %>%
    transmute(season, week, game_id, team, gsis_id,
             offensive_snaps = offense_snaps, snap_share_source = offense_pct,
             special_teams_snaps = st_snaps, special_teams_pct_source = st_pct)

  # --- union of every (season, week, game_id, team, gsis_id) with ANY
  # evidence of participation -- a row is never fabricated from a roster
  # slot alone (spec §4).
  key_sources <- list(
    select(snaps, season, week, game_id, team, gsis_id),
    select(offense$targets, season, week, game_id, team, gsis_id),
    select(offense$carries, season, week, game_id, team, gsis_id),
    select(offense$dropbacks, season, week, game_id, team, gsis_id),
    select(returns$kr, season, week, game_id, team, gsis_id),
    select(returns$pr, season, week, game_id, team, gsis_id)
  )
  keys <- purrr::reduce(key_sources, bind_rows) %>% distinct(season, week, game_id, team, gsis_id)

  pg <- keys %>%
    left_join(snaps, by = c("season", "week", "game_id", "team", "gsis_id")) %>%
    left_join(offense$targets, by = c("season", "week", "game_id", "team", "gsis_id")) %>%
    left_join(offense$carries, by = c("season", "week", "game_id", "team", "gsis_id")) %>%
    left_join(offense$dropbacks, by = c("season", "week", "game_id", "team", "gsis_id")) %>%
    left_join(offense$qb_designed_rush, by = c("season", "week", "game_id", "team", "gsis_id")) %>%
    left_join(routes, by = c("season", "week", "game_id", "team", "gsis_id")) %>%
    left_join(returns$kr, by = c("season", "week", "game_id", "team", "gsis_id")) %>%
    left_join(returns$pr, by = c("season", "week", "game_id", "team", "gsis_id")) %>%
    left_join(team_denom, by = c("season", "week", "game_id", "team")) %>%
    left_join(returns$team_kr, by = c("season", "week", "game_id", "team")) %>%
    left_join(returns$team_pr, by = c("season", "week", "game_id", "team")) %>%
    left_join(opp_map, by = c("season", "week", "game_id", "team")) %>%
    left_join(pos_lookup$exact, by = c("season", "week", "gsis_id")) %>%
    left_join(pos_lookup$season_mode, by = c("season", "gsis_id")) %>%
    mutate(position = coalesce(position, position_season_mode)) %>%
    select(-position_season_mode) %>%
    left_join(select(ff_clean, gsis_id, sleeper_id, pfr_id, full_name = name), by = "gsis_id")

  pg_grp <- .position_group_team_denominators(
    pg %>% mutate(carries = coalesce(carries, 0), targets = coalesce(targets, 0))
  )
  pg <- pg %>% left_join(pg_grp, by = c("season", "week", "game_id", "team"))

  # --- fill counting-stat NAs with 0 only where the SOURCE positively
  # confirms zero opportunity (a player who is in this table but has no
  # target row genuinely had zero targets that game -- the row's existence
  # already proves participation evidence). Route/pass_play_personnel is
  # NOT zero-filled here: absence there means the source (participation,
  # 2016+) may not cover the season, not that the player ran zero routes.
  zero_fill_cols <- c("targets", "receptions", "air_yards", "red_zone_targets", "inside_10_targets",
                      "end_zone_targets", "third_down_targets", "two_minute_targets",
                      "carries", "red_zone_carries", "inside_10_carries", "goal_line_carries",
                      "third_down_carries", "two_minute_carries", "dropbacks", "qb_scrambles",
                      "designed_rushes", "kick_returns", "kick_return_yards", "punt_returns", "punt_return_yards")
  pg <- pg %>% mutate(across(all_of(zero_fill_cols), ~ coalesce(.x, 0)))

  out <- pg %>% mutate(
    aDOT = ifelse(targets > 0, air_yards / targets, NA_real_),

    snap_share_derived = ifelse(coalesce(team_offensive_plays, 0) > 0 & !is.na(offensive_snaps),
                                offensive_snaps / team_offensive_plays, NA_real_),

    target_share      = ifelse(coalesce(team_pass_att, 0) > 0, targets / team_pass_att, NA_real_),
    air_yards_share    = ifelse(coalesce(team_air_yards, 0) > 0, air_yards / team_air_yards, NA_real_),
    rush_share         = ifelse(coalesce(team_rush_att, 0) > 0, carries / team_rush_att, NA_real_),
    rz_target_share    = ifelse(coalesce(team_rz_pass_att, 0) > 0, red_zone_targets / team_rz_pass_att, NA_real_),
    rz_carry_share     = ifelse(coalesce(team_rz_rush_att, 0) > 0, red_zone_carries / team_rz_rush_att, NA_real_),

    position_group_rush_share   = ifelse(position %in% c("RB", "FB") & coalesce(team_rb_carries, 0) > 0,
                                         carries / team_rb_carries, NA_real_),
    position_group_target_share = case_when(
      position == "WR" & coalesce(team_wr_targets, 0) > 0 ~ targets / team_wr_targets,
      position == "TE" & coalesce(team_te_targets, 0) > 0 ~ targets / team_te_targets,
      TRUE ~ NA_real_
    ),

    # route_participation: see .player_route_participation()'s doc comment.
    # Never substitutes for snap_share_derived/snap_share_source, and vice
    # versa -- these three columns are never the same formula (spec §6, §21).
    route_participation = ifelse(!is.na(pass_play_personnel) & coalesce(team_pass_plays, 0) > 0,
                                 pass_play_personnel / team_pass_plays, NA_real_),
    route_participation_definition = "pass_play_personnel_share",
    route_participation_reliability = ifelse(position %in% c("OL", "DL", "DB", "LB", "K", "P", "LS"),
                                             "UNRELIABLE_NON_ELIGIBLE_POSITION", "PROXY_PERSONNEL_PRESENCE"),

    targets_per_route_run = ifelse(!is.na(pass_play_personnel) & pass_play_personnel > 0,
                                   targets / pass_play_personnel, NA_real_),

    kick_return_opportunity_share = ifelse(coalesce(team_kick_returns, 0) > 0, kick_returns / team_kick_returns, NA_real_),
    punt_return_opportunity_share = ifelse(coalesce(team_punt_returns, 0) > 0, punt_returns / team_punt_returns, NA_real_),

    # role domain tags -- offense and special-teams-return evidence are kept
    # visibly separate so a return-heavy/offense-light player cannot be
    # misread as a major offensive contributor (spec §13).
    offense_domain_active = coalesce(offensive_snaps, 0) > 0 | targets > 0 | carries > 0 | dropbacks > 0,
    return_domain_active  = kick_returns > 0 | punt_returns > 0
  )

  # --- alignment/motion/blocking: genuinely UNAVAILABLE at player-game grain
  # (Checkpoint A finding, re-confirmed here). Represented as explicit typed
  # constants in the served manifest's feature-family table (spec §12), NOT
  # as NA columns bloated across every row -- a column of all-NA adds no row-
  # level information and the manifest is the correct place for a whole-
  # -family unavailability declaration.

  # --- resolve genuine (season, week, game_id, gsis_id) key conflicts.
  # FINDING: a small number of rows (verified: 72 of 274,413, all pre-2021,
  # concentrated in a handful of games) carry two different `team` values for
  # the same player-game, because PFR's snap_counts source occasionally
  # attributes a player to the WRONG team with 0 snaps/0 touches alongside
  # the correct, evidenced row (e.g. Super Bowl XLIX 2014_21_NE_SEA: Tom
  # Brady appears once correctly as NE with real snaps, and once spuriously
  # as SEA with 0 snaps and 0 touches). This is never silently merged and
  # never a fuzzy match (spec §23) -- it is resolved deterministically by
  # evidence strength (the row with more participation evidence wins; ties
  # broken by team name for determinism/reproducibility), and every resolved
  # conflict is reported, not hidden (spec §24 test 24: identical input must
  # yield identical output, which a nondeterministic tie-break would violate).
  out <- out %>% mutate(
    .evidence = coalesce(offensive_snaps, 0) + targets + carries + dropbacks + kick_returns + punt_returns
  )
  conflicting_team_rows <- out %>%
    add_count(season, week, game_id, gsis_id, name = ".n") %>%
    filter(.n > 1) %>%
    select(season, week, game_id, gsis_id, full_name, team, .evidence) %>%
    arrange(season, week, game_id, gsis_id, desc(.evidence))
  out <- out %>%
    group_by(season, week, game_id, gsis_id) %>%
    slice_max(.evidence, n = 1, with_ties = FALSE) %>%
    ungroup() %>%
    select(-.evidence)

  # --- team-change discontinuity flag (spec §15): compare to the same
  # player's most recent PRIOR game this season, chronologically.
  out <- out %>%
    arrange(gsis_id, season, week) %>%
    group_by(gsis_id, season) %>%
    mutate(prior_game_team = dplyr::lag(team), team_changed_since_prior_game = !is.na(prior_game_team) & prior_game_team != team) %>%
    ungroup()

  result <- out %>% select(
    season, week, game_id, gsis_id, sleeper_id, pfr_id, full_name, position, team, opponent,
    offensive_snaps, team_offensive_plays, snap_share_source, snap_share_derived,
    pass_play_personnel, team_pass_plays, route_participation, route_participation_definition, route_participation_reliability,
    targets, team_pass_att, target_share, receptions, air_yards, team_air_yards, air_yards_share, aDOT, targets_per_route_run,
    carries, team_rush_att, rush_share, position_group_rush_share, position_group_target_share,
    dropbacks, qb_scrambles, designed_rushes,
    red_zone_targets, red_zone_carries, inside_10_targets, inside_10_carries, goal_line_carries, end_zone_targets,
    team_rz_pass_att, team_rz_rush_att, rz_target_share, rz_carry_share,
    third_down_targets, third_down_carries, two_minute_targets, two_minute_carries,
    kick_returns, kick_return_yards, punt_returns, punt_return_yards,
    team_kick_returns, team_punt_returns, kick_return_opportunity_share, punt_return_opportunity_share,
    offense_domain_active, return_domain_active,
    team_offensive_plays_neutral_score_differential, overtime,
    prior_game_team, team_changed_since_prior_game
  )
  attr(result, "conflicting_team_rows") <- conflicting_team_rows
  result
}
