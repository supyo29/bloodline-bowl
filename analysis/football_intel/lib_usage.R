# ===========================================================================
# Football Intelligence — player usage profiles (spec §6).
#
# OBSERVED opportunity only. Recency-weighted through `through_week`, shrunk
# toward the player's own prior-season usage then the position mean by games.
# NEVER points, NEVER talent (spec §6, §16, §32).
# ===========================================================================

suppressWarnings(suppressMessages({ library(dplyr); library(tidyr) }))

USAGE_METRICS <- c("snap_share", "route_participation", "target_share", "air_yards_share",
                   "rush_share", "rz_target_share", "rz_carry_share",
                   "deep_att_rate", "designed_rush_rate")

# position lookup (gsis) from weekly rosters, most-frequent in the season.
.player_positions <- function(rosters_weekly, season) {
  rosters_weekly %>% filter(season == !!season, !is.na(gsis_id), !is.na(position)) %>%
    count(gsis_id, position) %>% group_by(gsis_id) %>%
    slice_max(n, n = 1, with_ties = FALSE) %>% ungroup() %>%
    transmute(gsis_id, position)
}

build_player_usage_profile <- function(pgu, ff_playerids, rosters_weekly, season, through_week, FI) {
  pos <- .player_positions(rosters_weekly, season)
  hl <- FI$RECENCY_HALFLIFE_GAMES
  k  <- FI$SHRINK_K$player_usage
  thr <- FI$CONF_THRESHOLDS$player_usage

  cur <- pgu %>% filter(season == !!season, week <= !!through_week) %>%
    mutate(weeks_ago = through_week - week, w = recency_weight(weeks_ago, hl))

  prior <- pgu %>% filter(season == !!season - 1) %>%
    group_by(gsis_id) %>%
    summarise(across(all_of(USAGE_METRICS), ~ mean(.x, na.rm = TRUE), .names = "prior_{.col}"),
              prior_games = dplyr::n(), .groups = "drop")

  pos_mean <- cur %>% left_join(pos, by = "gsis_id") %>% filter(!is.na(position)) %>%
    group_by(position) %>%
    summarise(across(all_of(USAGE_METRICS), ~ mean(.x, na.rm = TRUE), .names = "posmean_{.col}"), .groups = "drop")

  agg <- cur %>%
    group_by(gsis_id, team) %>%
    summarise(across(all_of(USAGE_METRICS),
                     ~ { ok <- is.finite(.x) & is.finite(w); if (!any(ok)) NA_real_ else sum(w[ok] * .x[ok]) / sum(w[ok]) }),
              games = dplyr::n_distinct(week),
              eff_games = sum(w)^2 / sum(w^2),
              last_week = max(week),
              .groups = "drop") %>%
    group_by(gsis_id) %>% slice_max(games, n = 1, with_ties = FALSE) %>% ungroup() %>%
    left_join(pos, by = "gsis_id") %>%
    left_join(prior, by = "gsis_id") %>%
    left_join(pos_mean, by = "position") %>%
    left_join(select(ff_playerids, gsis_id, sleeper_id, pfr_id, full_name = name), by = "gsis_id")

  long <- agg %>%
    tidyr::pivot_longer(all_of(USAGE_METRICS), names_to = "metric", values_to = "obs") %>%
    rowwise() %>%
    mutate(
      prior_val = get0(paste0("prior_", metric), ifnotfound = NA_real_),
      pos_val   = get0(paste0("posmean_", metric), ifnotfound = NA_real_),
      .sh = list(shrink_to(obs, eff_games, prior_val,
                           ifelse(is.finite(prior_games), pmin(prior_games, 17), 0) / 17 * k,
                           ifelse(is.finite(pos_val), pos_val, 0), k)),
      modeled = .sh$estimate,
      prior_weight = .sh$prior_weight,
      recent_weight = .sh$recent_weight,
      confidence = confidence_bucket(coalesce(eff_games, 0), thr)
    ) %>% ungroup()

  long %>% transmute(
    season = season, through_week = through_week,
    gsis_id, sleeper_id, pfr_id, full_name, position, team,
    metric, output_class = "OBSERVED",
    observed = obs, modeled, position_mean = pos_val, prior_season = prior_val,
    games, eff_games, prior_weight, recent_weight, confidence, last_week
  )
}
