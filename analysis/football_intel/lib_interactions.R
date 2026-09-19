# ===========================================================================
# Football Intelligence — unit coverage-allowed, contextual matchup features
# (spec §15), and FTN descriptive context (spec guardrail 1).
#
# Contextual matchup features are INTERACTION SIGNALS: offense_rating vs
# defense_rating -> interaction_signal + confidence. They are NOT fantasy
# points and carry NO scoring translation (spec §16, §32).
# ===========================================================================

suppressWarnings(suppressMessages({ library(dplyr); library(tidyr) }))

# ------------------------------------------------------------------------
# coverage-allowed: receiving EPA a defense allows to RB / WR / TE targets.
# Opponent-adjusted the same way as team metrics (offense = the receiving
# team's position group; def effect = the defense-allowed rating we want).
# ------------------------------------------------------------------------
build_coverage_allowed_profile <- function(pbp, rosters_weekly, ff_playerids, season, through_week, prior_seasons, FI) {
  pos <- rosters_weekly %>% filter(!is.na(gsis_id), !is.na(position)) %>%
    distinct(season, gsis_id, position)
  targets <- pbp %>%
    filter(season_type == "REG", coalesce(pass, 0) == 1, !is.na(receiver_player_id), !is.na(posteam), !is.na(defteam)) %>%
    transmute(season, week, team = FI$normalize_team(posteam), opponent = FI$normalize_team(defteam),
              gsis_id = receiver_player_id, epa) %>%
    left_join(pos, by = c("season", "gsis_id")) %>%
    mutate(grp = case_when(position %in% c("RB", "FB") ~ "RB",
                           position %in% c("WR") ~ "WR",
                           position %in% c("TE") ~ "TE", TRUE ~ NA_character_)) %>%
    filter(!is.na(grp))

  one <- function(grp, s, tw = NULL, halflife = NULL) {
    d <- targets %>% filter(grp == !!grp, season == s)
    if (!is.null(tw)) d <- d %>% filter(week <= tw)
    if (nrow(d) < 30) return(NULL)
    g <- d %>% group_by(team, opponent, week) %>%
      summarise(y = mean(epa, na.rm = TRUE), n = dplyr::n(), .groups = "drop")
    if (!is.null(halflife)) g <- g %>% mutate(w = n * recency_weight((max(week) - week), halflife))
    else g <- g %>% mutate(w = n)
    fit <- opponent_adjust_metric(g %>% select(team, opponent, y, w),
                                  ridge = FI$OPP_ADJ_RIDGE_LAMBDA, min_w = if (is.null(tw)) FI$OPP_ADJ_MIN_PLAYS_TEAM else 1)
    if (is.null(fit)) return(NULL)
    eff <- g %>% group_by(opponent) %>% summarise(eff_n = sum(w)^2 / sum(w^2), raw = weighted.mean(y, w), .groups = "drop")
    tibble::tibble(team = names(fit$def), grp = grp, def_allowed_dev = as.numeric(fit$def), mu = fit$mu) %>%
      rename(defense_team = team) %>% left_join(rename(eff, defense_team = opponent), by = "defense_team")
  }

  prior_r <- bind_rows(lapply(c("RB", "WR", "TE"), function(gp)
    bind_rows(lapply(prior_seasons, function(s) {
      r <- one(gp, s); if (is.null(r)) NULL else r %>% mutate(season = s)
    }))))
  priors <- prior_r %>%
    mutate(k = season - min(season)) %>%  # placeholder; recompute below
    group_by(defense_team, grp) %>%
    summarise(prior_mean = {
      kk <- max(season) - season + 1
      w <- FI$PRIOR_DECAY_LAMBDA^(kk - 1)
      sum(w * def_allowed_dev) / sum(w)
    }, prior_n = dplyr::n(), .groups = "drop")

  cur <- bind_rows(lapply(c("RB", "WR", "TE"), function(gp) {
    r <- one(gp, season, tw = through_week); if (is.null(r)) NULL else r
  }))
  k <- FI$SHRINK_K$epa_metric
  thr <- FI$CONF_THRESHOLDS$epa_metric

  cur %>%
    left_join(priors, by = c("defense_team", "grp")) %>%
    rowwise() %>%
    mutate(
      .sh = list(shrink_to(def_allowed_dev, eff_n, prior_mean,
                           ifelse(is.finite(prior_n), prior_n * k * 0.4, 0), 0, k)),
      modeled = .sh$estimate,
      confidence = confidence_bucket(coalesce(eff_n, 0), thr)
    ) %>% ungroup() %>%
    mutate(metric = paste0("coverage_allowed_epa_", grp),
           league_percentile = league_percentile(-modeled)) %>%   # lower allowed = better defense
    transmute(season = season, through_week = through_week, team = defense_team, side = "defense",
              metric, output_class = "MODELED",
              raw, modeled, league_percentile, n_obs_effective = eff_n,
              prior_mean, prior_n_seasons = prior_n, confidence)
}

# ------------------------------------------------------------------------
# the six approved contextual matchup interaction features (spec §15).
# off_rating and def_rating are MODELED team ratings (deviation scale);
# interaction_signal = off_pct - def_pct  in [-1, 1], POSITIVE = the matchup
# favors the offense on that axis. NO points.
# ------------------------------------------------------------------------
CONTEXTUAL_PAIRS <- tibble::tribble(
  ~feature,                       ~off_metric,                 ~def_metric,
  "pass_epa_vs_pass_defense",     "off_pass_epa",              "def_pass_epa_allowed",
  "rush_epa_vs_rush_defense",     "off_rush_epa",              "def_rush_epa_allowed",
  "pressure_allowed_vs_pressure_generated", "off_pressure_rate_allowed", "def_pressure_rate",
  "explosive_pass_vs_explosive_prevention", "off_explosive_pass_rate",   "def_explosive_pass_rate_allowed",
  "proe_pace_vs_pass_funnel",     "off_proe",                  "def_pass_epa_allowed",
  "rz_offense_vs_rz_defense",     "off_rz_td_rate",            "def_rz_td_rate_allowed"
)

build_contextual_matchups <- function(team_profile, unit_coverage_profile, season, through_week, FI) {
  tp <- team_profile %>% select(team, metric, side, modeled, league_percentile, confidence)
  offs <- tp %>% filter(side == "offense")
  defs <- tp %>% filter(side == "defense")

  base <- bind_rows(lapply(seq_len(nrow(CONTEXTUAL_PAIRS)), function(i) {
    row <- CONTEXTUAL_PAIRS[i, ]
    o <- offs %>% filter(metric == row$off_metric) %>%
      transmute(off_team = team, off_rating = modeled, off_pct = league_percentile, off_conf = confidence)
    d <- defs %>% filter(metric == row$def_metric) %>%
      transmute(def_team = team, def_rating = modeled, def_pct = league_percentile, def_conf = confidence)
    os <- FI$predictive_status(row$off_metric); ds <- FI$predictive_status(row$def_metric)
    cap <- if ("NOT_PREDICTIVE" %in% c(os, ds)) 2L else 4L   # cap at LOW when a side isn't predictive
    tidyr::crossing(o, d) %>%
      filter(off_team != def_team) %>%
      mutate(feature = row$feature,
             predictive_status = paste0("off:", os, "|def:", ds),
             interaction_signal = round(off_pct - (1 - def_pct), 4),
             confidence = pmin(match(off_conf, c("INSUFFICIENT_SAMPLE","LOW","MEDIUM","HIGH")),
                               match(def_conf, c("INSUFFICIENT_SAMPLE","LOW","MEDIUM","HIGH")),
                               cap) )
  }))

  # add the RB/WR/TE coverage interaction (usage axis handled downstream, not here)
  cov <- unit_coverage_profile %>%
    transmute(def_team = team, feature = sub("coverage_allowed_epa_", "receiving_usage_vs_coverage_", metric),
              def_rating = modeled, def_pct = league_percentile, def_conf = confidence)

  bind_rows(
    base %>% transmute(season = season, through_week = through_week, feature,
                       offense_team = off_team, defense_team = def_team,
                       offense_rating = round(off_rating, 4), defense_rating = round(def_rating, 4),
                       offense_percentile = round(off_pct, 4), defense_percentile = round(def_pct, 4),
                       interaction_signal, predictive_status,
                       confidence = c("INSUFFICIENT_SAMPLE","LOW","MEDIUM","HIGH")[pmax(confidence, 1)],
                       output_class = "MODELED"),
    cov %>% transmute(season = season, through_week = through_week, feature,
                      offense_team = NA_character_, defense_team = def_team,
                      offense_rating = NA_real_, defense_rating = round(def_rating, 4),
                      offense_percentile = NA_real_, defense_percentile = round(def_pct, 4),
                      interaction_signal = round(1 - def_pct - 0.5, 4),
                      predictive_status = "off:NA|def:UNVALIDATED",
                      confidence = def_conf, output_class = "MODELED")
  )
}

# ------------------------------------------------------------------------
# FTN descriptive context — 2022+ only, DESCRIPTIVE_ONLY, explicit bounds.
# Never read by any rating / prior / trend / backtest (spec guardrail 1).
# ------------------------------------------------------------------------
build_ftn_descriptive <- function(ftn, pbp, season, through_week, FI) {
  if (is.null(ftn) || nrow(ftn) == 0 || !season %in% FI$FTN_SEASONS) {
    return(tibble::tibble(season = integer(), through_week = integer(), team = character(),
                          metric = character(), value = double(), n_plays = integer(),
                          availability = character(), output_class = character(),
                          source_coverage = character(), season_bounds = character()))
  }
  gm <- pbp %>% filter(season_type == "REG") %>% distinct(game_id, play_id, posteam)
  d <- ftn %>%
    inner_join(gm, by = c("nflverse_game_id" = "game_id", "nflverse_play_id" = "play_id")) %>%
    filter(season == !!season, week <= !!through_week, !is.na(posteam)) %>%
    mutate(team = FI$normalize_team(posteam))
  if (nrow(d) == 0) return(build_ftn_descriptive(NULL, pbp, season, through_week, FI))
  d %>% group_by(team) %>%
    summarise(
      play_action_rate = mean(is_play_action == 1, na.rm = TRUE),
      screen_rate      = mean(is_screen_pass == 1, na.rm = TRUE),
      rpo_rate         = mean(is_rpo == 1, na.rm = TRUE),
      motion_rate      = mean(is_motion == 1, na.rm = TRUE),
      no_huddle_rate   = mean(is_no_huddle == 1, na.rm = TRUE),
      n_plays = dplyr::n(), .groups = "drop") %>%
    tidyr::pivot_longer(-c(team, n_plays), names_to = "metric", values_to = "value") %>%
    mutate(season = season, through_week = through_week,
           availability = "AVAILABLE", output_class = "DESCRIPTIVE_ONLY",
           source_coverage = "FTN charting (nflreadr::load_ftn_charting)",
           season_bounds = paste0(min(FI$FTN_SEASONS), "-", max(FI$FTN_SEASONS)),
           value = round(value, 4)) %>%
    select(season, through_week, team, metric, value, n_plays, availability, output_class,
           source_coverage, season_bounds)
}


# ------------------------------------------------------------------------
# Receiver target progression — FTN read_thrown, DESCRIPTIVE_ONLY.
#
# FTN semantics (nflreadr data dictionary):
#   0 = first/primary read, 1 = second read, 2 = third read or later,
#   CHK = checkdown, DES = designed read (e.g. screens / many RPO throws),
#   SD = scramble drill.
#
# This labels ONLY the read on which the ball was thrown. It does not infer
# the unthrown progression order for other eligible receivers on that play.
# ------------------------------------------------------------------------
.ftn_read_bucket <- function(x) {
  x <- as.character(x)
  dplyr::case_when(
    x == "0"   ~ "FIRST_READ",
    x == "1"   ~ "SECOND_READ",
    x == "2"   ~ "THIRD_PLUS_READ",
    x == "CHK" ~ "CHECKDOWN",
    x == "DES" ~ "DESIGNED",
    x == "SD"  ~ "SCRAMBLE_DRILL",
    TRUE        ~ "OTHER"
  )
}

build_receiver_progression <- function(ftn, pbp, ff_playerids, season, through_week, FI) {
  empty <- function() tibble::tibble(
    season = integer(), week = integer(), team = character(), opponent = character(),
    gsis_id = character(), sleeper_id = character(), full_name = character(),
    passer_gsis_id = character(), bucket = character(), targets = integer(),
    target_read_share = double(), receptions = integer(), receiving_yards = double(),
    yards_per_target = double(), air_yards = double(), adot = double(), yac = double(),
    epa_per_target = double(), success_rate = double(), first_down_rate = double(),
    explosive_rate = double(), receiving_tds = integer(), td_rate = double(),
    targets_eligible = integer(), targets_charted_read = integer(),
    read_coverage_rate = double(), output_class = character(), source = character(),
    read_semantics = character()
  )
  if (is.null(ftn) || nrow(ftn) == 0 || !season %in% FI$FTN_SEASONS) return(empty())

  plays <- pbp %>%
    filter(season_type == "REG", season == !!season, week <= !!through_week,
           coalesce(pass, 0) == 1, !is.na(receiver_player_id)) %>%
    transmute(
      game_id, play_id, season, week,
      team = FI$normalize_team(posteam), opponent = FI$normalize_team(defteam),
      gsis_id = receiver_player_id, passer_gsis_id = passer_player_id,
      complete = coalesce(complete_pass, 0),
      yards_gained = coalesce(yards_gained, 0),
      target_air_yards = air_yards,
      target_yac = ifelse(complete_pass == 1, yards_after_catch, NA_real_),
      epa, success = coalesce(success, as.integer(epa > 0)),
      first_down = coalesce(first_down, 0),
      receiving_td = coalesce(pass_touchdown, 0)
    )

  if (nrow(plays) == 0) return(empty())

  chart <- ftn %>%
    transmute(
      game_id = nflverse_game_id, play_id = nflverse_play_id,
      read_thrown = as.character(read_thrown)
    )

  joined <- plays %>% left_join(chart, by = c("game_id", "play_id"))
  totals <- joined %>%
    group_by(season, week, team, opponent, gsis_id) %>%
    summarise(
      targets_eligible = dplyr::n(),
      targets_charted_read = sum(!is.na(read_thrown) & read_thrown != ""),
      read_coverage_rate = targets_charted_read / targets_eligible,
      .groups = "drop"
    )

  out <- joined %>%
    filter(!is.na(read_thrown), read_thrown != "") %>%
    mutate(bucket = .ftn_read_bucket(read_thrown)) %>%
    group_by(season, week, team, opponent, gsis_id, passer_gsis_id, bucket) %>%
    summarise(
      targets = dplyr::n(),
      receptions = sum(complete, na.rm = TRUE),
      receiving_yards = sum(yards_gained, na.rm = TRUE),
      yards_per_target = mean(yards_gained, na.rm = TRUE),
      air_yards = sum(target_air_yards, na.rm = TRUE),
      adot = mean(target_air_yards, na.rm = TRUE),
      yac = sum(target_yac, na.rm = TRUE),
      epa_per_target = mean(epa, na.rm = TRUE),
      success_rate = mean(success, na.rm = TRUE),
      first_down_rate = mean(first_down, na.rm = TRUE),
      explosive_rate = mean(complete == 1 & yards_gained >= FI$EXPLOSIVE_PASS_YARDS, na.rm = TRUE),
      receiving_tds = sum(receiving_td, na.rm = TRUE),
      td_rate = mean(receiving_td, na.rm = TRUE),
      .groups = "drop"
    ) %>%
    left_join(totals, by = c("season", "week", "team", "opponent", "gsis_id")) %>%
    group_by(season, week, team, opponent, gsis_id) %>%
    mutate(target_read_share = targets / sum(targets)) %>%
    ungroup()

  idmap <- ff_playerids %>%
    transmute(
      gsis_id = as.character(gsis_id),
      sleeper_id = dplyr::coalesce(as.character(sleeper_id), NA_character_),
      full_name = dplyr::coalesce(as.character(name), NA_character_)
    ) %>%
    filter(!is.na(gsis_id), gsis_id != "") %>%
    distinct(gsis_id, .keep_all = TRUE)

  out %>%
    left_join(idmap, by = "gsis_id") %>%
    mutate(
      output_class = "DESCRIPTIVE_ONLY",
      source = "nflverse_ftn",
      read_semantics = "0=FIRST_READ|1=SECOND_READ|2=THIRD_PLUS_READ|CHK=CHECKDOWN|DES=DESIGNED|SD=SCRAMBLE_DRILL"
    ) %>%
    select(
      season, week, team, opponent, gsis_id, sleeper_id, full_name, passer_gsis_id,
      bucket, targets, target_read_share, receptions, receiving_yards, yards_per_target,
      air_yards, adot, yac, epa_per_target, success_rate, first_down_rate,
      explosive_rate, receiving_tds, td_rate, targets_eligible, targets_charted_read,
      read_coverage_rate, output_class, source, read_semantics
    ) %>%
    arrange(season, week, team, gsis_id, bucket)
}
