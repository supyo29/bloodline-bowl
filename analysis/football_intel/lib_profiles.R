# ===========================================================================
# Football Intelligence — profile assembly (spec §7, §10, §12, §26).
#
# compute_metric_profile() runs ONE team metric end-to-end for a target
# (season, through_week):
#   1. per-prior-season opponent-adjusted rating          -> season prior
#   2. discontinuity discount of the prior effective sample
#   3. current-season opponent-adjusted rating (recency weighted, <= through_week)
#   4. shrink current -> prior -> league mean               -> MODELED rating
#   5. trend: short-half-life estimate vs current level
#   6. full explainability decomposition (spec §26)
#
# METRIC_SPECS defines the v1 team-metric set (spec §5, items approved).
# ===========================================================================

suppressWarnings(suppressMessages({ library(dplyr) }))

# each spec: value = game-level column on the team_game_features row for that
# SIDE; weight = play-count column; family = confidence/shrink family;
# higher_is_better = orientation for percentile semantics.
METRIC_SPECS <- list(
  list(key = "off_pass_epa",  side = "offense", value = "pass_epa",  weight = "n_pass",  family = "epa_metric", higher_is_better = TRUE),
  list(key = "off_rush_epa",  side = "offense", value = "rush_epa",  weight = "n_rush",  family = "epa_metric", higher_is_better = TRUE),
  list(key = "off_epa_play",  side = "offense", value = "epa_play",  weight = "plays",   family = "epa_metric", higher_is_better = TRUE),
  list(key = "off_success_rate", side = "offense", value = "success_rate", weight = "plays", family = "epa_metric", higher_is_better = TRUE),
  list(key = "off_proe",      side = "offense", value = "proe",      weight = "n_neutral", family = "play_rate_metric", higher_is_better = NA),
  list(key = "off_pace_sec_play", side = "offense", value = "pace_sec_play", weight = "n_pace", family = "play_rate_metric", higher_is_better = NA),
  list(key = "off_explosive_pass_rate", side = "offense", value = "expl_pass_rate", weight = "n_pass", family = "play_rate_metric", higher_is_better = TRUE),
  list(key = "off_explosive_rush_rate", side = "offense", value = "expl_rush_rate", weight = "n_rush", family = "play_rate_metric", higher_is_better = TRUE),
  list(key = "off_pressure_rate_allowed", side = "offense", value = "pbp_pressure_rate", weight = "n_pass", family = "play_rate_metric", higher_is_better = FALSE),
  list(key = "off_sack_rate_allowed", side = "offense", value = "sack_rate", weight = "n_pass", family = "play_rate_metric", higher_is_better = FALSE),
  list(key = "off_rz_td_rate", side = "offense", value = "rz_td_rate", weight = "n_rz", family = "play_rate_metric", higher_is_better = TRUE),

  list(key = "def_pass_epa_allowed", side = "defense", value = "pass_epa", weight = "n_pass", family = "epa_metric", higher_is_better = FALSE),
  list(key = "def_rush_epa_allowed", side = "defense", value = "rush_epa", weight = "n_rush", family = "epa_metric", higher_is_better = FALSE),
  list(key = "def_epa_play_allowed", side = "defense", value = "epa_play", weight = "plays", family = "epa_metric", higher_is_better = FALSE),
  list(key = "def_success_allowed", side = "defense", value = "success_rate", weight = "plays", family = "epa_metric", higher_is_better = FALSE),
  list(key = "def_explosive_pass_rate_allowed", side = "defense", value = "expl_pass_rate", weight = "n_pass", family = "play_rate_metric", higher_is_better = FALSE),
  list(key = "def_explosive_rush_rate_allowed", side = "defense", value = "expl_rush_rate", weight = "n_rush", family = "play_rate_metric", higher_is_better = FALSE),
  list(key = "def_pressure_rate", side = "defense", value = "pbp_pressure_rate", weight = "n_pass", family = "play_rate_metric", higher_is_better = TRUE),
  list(key = "def_blitz_rate", side = "defense", value = "blitz_rate", weight = "n_charted", family = "play_rate_metric", higher_is_better = NA),
  list(key = "def_rz_td_rate_allowed", side = "defense", value = "rz_td_rate", weight = "n_rz", family = "play_rate_metric", higher_is_better = FALSE)
)

# per-season opponent-adjusted ratings for one metric (all completed seasons).
# returns tibble(season, team, side_role, rating, n_eff_plays)
season_ratings_for_metric <- function(tgf, spec, FI, seasons) {
  side_rows <- tgf %>% filter(side == spec$side, season_type == "REG")
  out <- lapply(seasons, function(s) {
    g <- side_rows %>% filter(season == s) %>%
      transmute(team, opponent, y = .data[[spec$value]], w = .data[[spec$weight]])
    fit <- opponent_adjust_metric(g, ridge = FI$OPP_ADJ_RIDGE_LAMBDA, min_w = FI$OPP_ADJ_MIN_PLAYS_TEAM)
    if (is.null(fit)) return(NULL)
    eff <- g %>% group_by(team) %>% summarise(n = sum(w, na.rm = TRUE), .groups = "drop")
    tibble::tibble(season = s, team = names(fit$off), side = spec$side,
                   metric = spec$key, rating = as.numeric(fit$off),
                   mu = fit$mu) %>%
      left_join(eff, by = "team") %>% rename(n_eff_plays = n)
  })
  bind_rows(out)
}

# current-season opponent-adjusted rating through `through_week`, recency-weighted.
current_rating_for_metric <- function(tgf, spec, season, through_week, FI, halflife = NULL) {
  hl <- halflife %||% FI$RECENCY_HALFLIFE_GAMES
  g <- tgf %>%
    filter(side == spec$side, season == !!season, week <= !!through_week, season_type == "REG") %>%
    transmute(team, opponent, y = .data[[spec$value]], w0 = .data[[spec$weight]],
              weeks_ago = through_week - week)
  if (nrow(g) < 10) return(NULL)
  g <- g %>% mutate(w = w0 * recency_weight(weeks_ago, hl)) %>% filter(is.finite(y), w > 0)
  fit <- opponent_adjust_metric(g %>% select(team, opponent, y, w),
                                ridge = FI$OPP_ADJ_RIDGE_LAMBDA, min_w = 1)
  if (is.null(fit)) return(NULL)
  eff <- g %>% group_by(team) %>%
    summarise(eff_n = sum(w),                          # recency-weighted plays behind the estimate
              kish = sum(w)^2 / sum(w^2),              # effective # of games (for trend SE)
              raw = weighted.mean(y, w), .groups = "drop")
  tibble::tibble(team = names(fit$off), current_dev = as.numeric(fit$off), mu = fit$mu) %>%
    left_join(eff, by = "team")
}

`%||%` <- function(a, b) if (is.null(a) || length(a) == 0) b else a

# pooled league game-to-game SD of a metric (for the recency cap + trend se).
pooled_game_sd <- function(tgf, spec) {
  v <- tgf %>% filter(side == spec$side, season_type == "REG") %>% pull(.data[[spec$value]])
  stats::sd(v, na.rm = TRUE)
}

# --------------------------------------------------------------------------
# compute_metric_profile(): the full pipeline for one metric + target.
# returns tibble with one row per team.
# --------------------------------------------------------------------------
compute_metric_profile <- function(tgf, spec, season, through_week, prior_ratings, discounts, FI) {
  thr <- FI$CONF_THRESHOLDS[[spec$family]]
  k   <- FI$SHRINK_K[[spec$family]]
  psd <- pooled_game_sd(tgf, spec)

  priors <- build_season_priors(
    prior_ratings %>% filter(metric == spec$key, side == spec$side), season, FI) %>%
    select(team, prior_mean, prior_n_seasons, prior_weight_sum)

  disc <- discounts %>% filter(side == spec$side) %>% select(team, prior_discount)

  cur <- current_rating_for_metric(tgf, spec, season, through_week, FI)
  recent <- current_rating_for_metric(tgf, spec, season, through_week, FI,
                                      halflife = FI$TREND_RECENT_HALFLIFE_GAMES)

  teams <- sort(unique(c(priors$team, cur$team, disc$team)))
  base <- tibble::tibble(team = teams, metric = spec$key, side = spec$side,
                         season = season, through_week = through_week) %>%
    left_join(priors, by = c("team")) %>%
    left_join(disc, by = "team") %>%
    left_join(cur %>% select(team, current_dev, obs_eff_n = eff_n, obs_kish = kish, raw = raw, league_mu = mu), by = "team") %>%
    left_join(recent %>% select(team, recent_dev = current_dev, recent_kish = kish), by = "team") %>%
    mutate(
      prior_discount = coalesce(prior_discount, 1),
      # discounted effective prior sample (play-equivalent). Bounded so a full
      # current season outweighs the prior (spec §29).
      prior_eff = ifelse(is.finite(prior_mean),
                         k * FI$PRIOR_STRENGTH * prior_discount *
                           pmin(coalesce(prior_n_seasons, 0) / FI$PRIOR_MAX_LOOKBACK, 1),
                         0),
      league_mu = coalesce(league_mu, 0)
    )

  # discriminability = cross-team spread of the modeled ratings this metric
  disc0 <- base %>% rowwise() %>%
    mutate(md = shrink_to(current_dev, obs_eff_n, prior_mean, prior_eff, 0, k)$estimate) %>%
    ungroup() %>% pull(md)
  rating_sd <- stats::sd(disc0, na.rm = TRUE)

  res <- base %>% rowwise() %>% mutate(
    .sh = list(shrink_to(current_dev, obs_eff_n, prior_mean, prior_eff, 0, k)),
    modeled_dev = .sh$estimate,
    prior_weight = .sh$prior_weight,
    recent_weight = .sh$recent_weight,
    shrunk_to_league = .sh$shrunk_to_league,
    # posterior SE of the shrunk estimate: var = rw^2 * var_obs + pw^2 * var_prior
    #   var_obs   = psd^2 / effective in-season games
    #   var_prior = psd^2 / (prior seasons * ~10 games), i.e. a multi-season mean
    .var_obs   = ifelse(is.finite(obs_kish) & obs_kish > 0, psd^2 / obs_kish, psd^2),
    .var_prior = ifelse(is.finite(prior_n_seasons) & prior_n_seasons > 0,
                        psd^2 / (prior_n_seasons * 10), psd^2),
    std_error = sqrt(pmax(coalesce(recent_weight, 0)^2 * .var_obs +
                          coalesce(prior_weight, 0)^2 * .var_prior, 0)),
    confidence = confidence_bucket(coalesce(obs_eff_n, 0) + coalesce(prior_eff, 0), thr,
                                   se = std_error, discrim = rating_sd,
                                   obs_only = coalesce(obs_eff_n, 0)),
    .tr = list(trend_signal(modeled_dev,
                            ifelse(is.finite(recent_dev), recent_dev, modeled_dev),
                            coalesce(recent_kish, 0), psd, FI)),
    trend_direction = .tr$direction,
    trend_magnitude = .tr$magnitude,
    trend_confidence = .tr$confidence
  ) %>% ungroup() %>% select(-.sh, -.tr)

  # league percentile on the MODELED rating, oriented so higher pct = better
  # for the unit when higher_is_better; NA orientation -> raw percentile.
  hib <- spec$higher_is_better
  pv <- res$modeled_dev
  if (isFALSE(hib)) pv <- -pv
  res$league_percentile <- league_percentile(pv)

  res %>% transmute(
    season, through_week, team, side, metric,
    output_class = "MODELED",
    predictive_status = FI$predictive_status(spec$key),
    raw, modeled = modeled_dev, league_mean = league_mu,
    league_percentile,
    n_obs_effective = obs_eff_n,
    prior_mean, prior_n_seasons, prior_discount,
    prior_weight, recent_weight, shrunk_to_league,
    std_error, confidence,
    trend_current_level = modeled_dev, trend_recent_level = recent_dev,
    trend_direction, trend_magnitude, trend_confidence
  )
}
