# ===========================================================================
# Player Role & Opportunity Intelligence — Checkpoint C domain composition.
#
# Assembles position-specific dimension sets (spec §7) into the full
# PlayerRoleProfile: participation / receiving / rushing / high_value /
# returns, each with corroboration-aware confidence, plus structured change
# events (spec §34) and a descriptive (never fantasy-facing) role-state
# taxonomy (spec §13).
# ===========================================================================

suppressWarnings(suppressMessages({ library(dplyr) }))

.position_dimension_set <- function(position) {
  # which dimensions are MEANINGFUL for this position -- spec §7's explicit
  # instruction not to force one generic usage model onto every position.
  offense_skill <- position %in% c("RB", "FB", "WR", "TE", "QB")
  list(
    participation = offense_skill,
    receiving = position %in% c("RB", "FB", "WR", "TE"),
    receiving_position_group = position %in% c("WR", "TE"),
    rushing = position %in% c("RB", "FB", "QB"),
    rushing_position_group = position %in% c("RB", "FB"),
    high_value = offense_skill,
    returns = TRUE  # any position can be a return contributor; evaluated for everyone, empty if no evidence
  )
}

# ---------------------------------------------------------------------------
# build_role_profile(): the full profile for ONE player as of (season, week).
# `player_history` = that single player's full multi-season row history
# (already subset by caller for performance -- see run_role_profile.R).
# ---------------------------------------------------------------------------
build_role_profile <- function(player_history, as_of_season, as_of_week, ROLE) {
  ph <- player_history %>% arrange(season, week)
  as_of_row <- ph %>% filter(season == as_of_season, week == as_of_week)
  if (nrow(as_of_row) == 0) return(NULL)  # no evidence this player played this game -- no fabricated profile
  current_team <- as_of_row$team[1]
  current_position <- as_of_row$position[1]
  dims <- .position_dimension_set(current_position)

  dim_prof <- function(col, opp_col) build_dimension_profile(ph, col, opp_col, as_of_season, as_of_week, current_team, current_position)

  # ---- pass 1: raw trends (corroboration unknown yet) --------------------
  participation <- if (dims$participation) dim_prof("snap_share_derived", "offensive_snaps") else NULL

  receiving <- if (dims$receiving) list(
    target_share = dim_prof("target_share", "targets"),
    position_group_target_share = if (dims$receiving_position_group) dim_prof("position_group_target_share", "targets") else NULL,
    air_yards_share = dim_prof("air_yards_share", "targets"),
    route_participation = dim_prof("route_participation", "pass_play_personnel")
  ) else NULL

  rushing <- if (dims$rushing) list(
    rush_share = dim_prof("rush_share", "carries"),
    position_group_rush_share = if (dims$rushing_position_group) dim_prof("position_group_rush_share", "carries") else NULL
  ) else NULL

  high_value <- if (dims$high_value) list(
    rz_target_share = if (dims$receiving) dim_prof("rz_target_share", "red_zone_targets") else NULL,
    rz_carry_share = if (dims$rushing) dim_prof("rz_carry_share", "red_zone_carries") else NULL,
    goal_line_carries_latest = tail(ph$goal_line_carries[ph$season < as_of_season | (ph$season == as_of_season & ph$week <= as_of_week)], 1),
    third_down_targets_latest = tail(ph$third_down_targets[ph$season < as_of_season | (ph$season == as_of_season & ph$week <= as_of_week)], 1),
    two_minute_targets_latest = tail(ph$two_minute_targets[ph$season < as_of_season | (ph$season == as_of_season & ph$week <= as_of_week)], 1)
  ) else NULL

  returns <- list(
    kick_return_role = dim_prof("kick_return_opportunity_share", "kick_returns"),
    punt_return_role = dim_prof("punt_return_opportunity_share", "punt_returns")
  )

  # ---- pass 2: corroboration + confidence re-injection --------------------
  # Receiving corroboration: participation + target_share + air_yards_share
  # + rz_target_share moving in the same direction (spec §12's exact example).
  receiving_trends <- list(
    if (!is.null(participation)) participation$trend_latest_vs_recent else NULL,
    if (!is.null(receiving)) receiving$target_share$trend_latest_vs_recent else NULL,
    if (!is.null(receiving)) receiving$air_yards_share$trend_latest_vs_recent else NULL,
    if (!is.null(high_value)) high_value$rz_target_share$trend_latest_vs_recent else NULL
  )
  receiving_corrob <- corroboration_count(receiving_trends)
  if (!is.null(receiving)) {
    receiving$target_share$confidence <- confidence_level(receiving$target_share$n_games_season, receiving$target_share$opportunity_total, receiving_corrob, receiving$target_share$blowout_latest)
    receiving$corroboration_count <- receiving_corrob
    receiving$corroboration_dimensions <- c("participation", "target_share", "air_yards_share", "rz_target_share")
  }

  rushing_trends <- list(
    if (!is.null(participation)) participation$trend_latest_vs_recent else NULL,
    if (!is.null(rushing)) rushing$rush_share$trend_latest_vs_recent else NULL,
    if (!is.null(rushing)) rushing$position_group_rush_share$trend_latest_vs_recent else NULL,
    if (!is.null(high_value)) high_value$rz_carry_share$trend_latest_vs_recent else NULL
  )
  rushing_corrob <- corroboration_count(rushing_trends)
  if (!is.null(rushing)) {
    rushing$rush_share$confidence <- confidence_level(rushing$rush_share$n_games_season, rushing$rush_share$opportunity_total, rushing_corrob, rushing$rush_share$blowout_latest)
    rushing$corroboration_count <- rushing_corrob
    rushing$corroboration_dimensions <- c("participation", "rush_share", "position_group_rush_share", "rz_carry_share")
  }

  # ---- route availability tag (spec §20: confidence/evidence notes it;
  # known targets are never downgraded merely because routes lag) ---------
  route_available <- !is.null(receiving) && !is.na(receiving$route_participation$latest)
  route_note <- if (is.null(receiving)) NA_character_ else if (route_available) "ROUTE_CORROBORATION_AVAILABLE" else "ROUTE_CORROBORATION_UNAVAILABLE"

  # ---- descriptive role-state taxonomy (spec §13) -------------------------
  role_level_tag <- NA_character_
  if (!is.null(receiving) && current_position %in% c("WR", "TE") && !is.na(receiving$target_share$latest)) {
    role_level_tag <- role_level(receiving$target_share$latest, ROLE$LEVEL_THRESHOLDS[[paste0("target_share_", current_position)]])
  } else if (!is.null(rushing) && current_position == "RB" && !is.na(rushing$rush_share$latest)) {
    role_level_tag <- role_level(rushing$rush_share$latest, ROLE$LEVEL_THRESHOLDS$rush_share_RB)
  }

  headline_trend <- if (!is.null(receiving) && current_position %in% c("WR", "TE")) receiving$target_share$trend_latest_vs_recent
    else if (!is.null(rushing) && current_position == "RB") rushing$rush_share$trend_latest_vs_recent
    else if (!is.null(participation)) participation$trend_latest_vs_recent else "UNCERTAIN"

  headline_evidence_state <- if (!is.null(receiving) && current_position %in% c("WR", "TE")) receiving$target_share$evidence_state
    else if (!is.null(rushing) && current_position == "RB") rushing$rush_share$evidence_state else "INSUFFICIENT_SAMPLE"

  list(
    identity = list(gsis_id = as_of_row$gsis_id[1], full_name = as_of_row$full_name[1],
                    position = current_position, team = current_team, opponent = as_of_row$opponent[1]),
    as_of = list(season = as_of_season, week = as_of_week),
    participation = participation,
    receiving = receiving,
    rushing = rushing,
    high_value = high_value,
    returns = returns,
    role_state = list(role_level = role_level_tag, role_trend = headline_trend, evidence_state = headline_evidence_state),
    source_availability = list(route_evidence = route_note),
    schema_version = ROLE$MODEL_SCHEMA_VERSION
  )
}

# ---------------------------------------------------------------------------
# extract_change_events(): flattens a profile's non-STABLE/non-UNCERTAIN
# dimension trends into structured events (spec §34).
# ---------------------------------------------------------------------------
extract_change_events <- function(profile) {
  events <- list()
  add_event <- function(domain, dim_name, dp) {
    if (is.null(dp) || is.null(dp$trend_latest_vs_recent) || dp$trend_latest_vs_recent %in% c("STABLE", "UNCERTAIN")) return(NULL)
    list(
      gsis_id = profile$identity$gsis_id, full_name = profile$identity$full_name,
      season = profile$as_of$season, week = profile$as_of$week,
      domain = domain, dimension = dim_name,
      trend = dp$trend_latest_vs_recent, evidence_state = dp$evidence_state, confidence = dp$confidence,
      evidence = list(latest = dp$latest, recent = dp$recent, season = dp$season, prior = dp$prior,
                      delta_latest_vs_recent = dp$delta_latest_vs_recent,
                      n_games_season = dp$n_games_season, opportunity_total = dp$opportunity_total)
    )
  }
  events <- c(events, list(add_event("PARTICIPATION", "snap_share_derived", profile$participation)))
  if (!is.null(profile$receiving)) {
    events <- c(events,
      list(add_event("RECEIVING", "target_share", profile$receiving$target_share)),
      list(add_event("RECEIVING", "position_group_target_share", profile$receiving$position_group_target_share)),
      list(add_event("RECEIVING", "air_yards_share", profile$receiving$air_yards_share)))
  }
  if (!is.null(profile$rushing)) {
    events <- c(events,
      list(add_event("RUSHING", "rush_share", profile$rushing$rush_share)),
      list(add_event("RUSHING", "position_group_rush_share", profile$rushing$position_group_rush_share)))
  }
  if (!is.null(profile$high_value)) {
    events <- c(events,
      list(add_event("HIGH_VALUE", "rz_target_share", profile$high_value$rz_target_share)),
      list(add_event("HIGH_VALUE", "rz_carry_share", profile$high_value$rz_carry_share)))
  }
  events <- c(events,
    list(add_event("RETURNS", "kick_return_opportunity_share", profile$returns$kick_return_role)),
    list(add_event("RETURNS", "punt_return_opportunity_share", profile$returns$punt_return_role)))
  Filter(Negate(is.null), events)
}
