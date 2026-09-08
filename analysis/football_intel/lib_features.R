# ===========================================================================
# Football Intelligence — feature derivation (spec §3, §5, §21 step 3).
#
# Turns the raw cache into GAME-LEVEL team feature tables. Game level is the
# unit of observation for opponent adjustment (§10) and recency (§9): one row
# per (season, week, team, side).
#
# Output class of every column is declared in feature_catalog() (spec
# guardrail 5): OBSERVED (direct box calc) vs MODELED (assigned later by the
# opponent-adjust / prior / shrink pipeline) vs DESCRIPTIVE_ONLY (FTN, thin
# man/zone). This file only ever produces OBSERVED game-level inputs.
# ===========================================================================

suppressWarnings(suppressMessages({ library(dplyr); library(tidyr); library(stringr) }))

# --------------------------------------------------------------------------
# parse "1 RB, 2 TE, 2 WR" -> personnel bucket (e.g. "12"); NA-safe.
# --------------------------------------------------------------------------
.personnel_bucket <- function(x) {
  rb <- suppressWarnings(as.integer(str_match(x, "(\\d+)\\s*RB")[, 2]))
  te <- suppressWarnings(as.integer(str_match(x, "(\\d+)\\s*TE")[, 2]))
  ifelse(is.na(rb) | is.na(te), NA_character_, paste0(rb, te))
}

# --------------------------------------------------------------------------
# neutral game-script filter (tendency metrics only, spec neutral config)
# --------------------------------------------------------------------------
.neutral <- function(d, FI) {
  wp <- d$wp
  sd <- abs(d$posteam_score - d$defteam_score)
  half_left <- d$half_seconds_remaining
  is.finite(wp) & wp >= FI$NEUTRAL_WP_LO & wp <= FI$NEUTRAL_WP_HI &
    (is.na(sd) | sd <= FI$NEUTRAL_MAX_ABS_SCORE_DIFF) &
    (is.na(half_left) | half_left > 120)
}

# --------------------------------------------------------------------------
# team x game OFFENSE + DEFENSE feature rows.
#   pbp          : cached play-by-play (normalized teams)
#   participation: cached participation joined-able by game_id + play_id
#   pfr_pass/def : cached PFR weekly advanced
#   returns a tibble: season, week, season_type, team, opponent, side, home,
#                     <feature columns>, plus n_* sample columns.
# --------------------------------------------------------------------------
build_team_game_features <- function(pbp, participation, pfr_pass, pfr_def, FI) {
  p <- pbp %>%
    filter(!is.na(posteam), !is.na(defteam),
           season_type %in% c("REG", "POST")) %>%
    mutate(
      posteam = FI$normalize_team(posteam),
      defteam = FI$normalize_team(defteam),
      is_dropback = coalesce(qb_dropback, 0) == 1,
      is_rush_att = coalesce(rush, 0) == 1 & coalesce(qb_dropback, 0) == 0,
      is_pass_att = coalesce(pass, 0) == 1,
      early_down  = down %in% c(1, 2),
      rz          = !is.na(yardline_100) & yardline_100 <= 20,
      expl_pass   = coalesce(pass, 0) == 1 & coalesce(yards_gained, 0) >= FI$EXPLOSIVE_PASS_YARDS,
      expl_rush   = coalesce(rush, 0) == 1 & coalesce(qb_dropback, 0) == 0 & coalesce(yards_gained, 0) >= FI$EXPLOSIVE_RUSH_YARDS,
      neutral     = .neutral(., FI)
    )

  scrimmage <- p %>% filter(is_dropback | is_rush_att, coalesce(penalty, 0) == 0 | play_type %in% c("pass", "run"))

  # ---- participation join (scheme; 2016+; charted) ----
  part <- participation %>%
    transmute(game_id = nflverse_game_id, play_id,
              off_formation = offense_formation,
              personnel = .personnel_bucket(offense_personnel),
              box = suppressWarnings(as.numeric(defenders_in_box)),
              pass_rushers = suppressWarnings(as.numeric(number_of_pass_rushers)),
              was_pressure = suppressWarnings(as.numeric(was_pressure)),
              man_zone = defense_man_zone_type)
  sc <- scrimmage %>% left_join(part, by = c("game_id", "play_id"))

  agg_side <- function(df, team_col, opp_col, side_label) {
    tcol <- rlang::sym(team_col); ocol <- rlang::sym(opp_col)
    df %>%
      group_by(season, week, season_type, team = !!tcol, opponent = !!ocol) %>%
      summarise(
        home = as.integer(dplyr::first(home_team) == dplyr::first(!!tcol)),
        plays        = dplyr::n(),
        epa_play     = mean(epa, na.rm = TRUE),
        success_rate = mean(success, na.rm = TRUE),
        pass_epa     = mean(epa[is_pass_att], na.rm = TRUE),
        rush_epa     = mean(epa[is_rush_att], na.rm = TRUE),
        pass_success = mean(success[is_pass_att], na.rm = TRUE),
        rush_success = mean(success[is_rush_att], na.rm = TRUE),
        n_pass       = sum(is_pass_att, na.rm = TRUE),
        n_rush       = sum(is_rush_att, na.rm = TRUE),
        expl_pass_rate = sum(expl_pass, na.rm = TRUE) / pmax(sum(is_pass_att, na.rm = TRUE), 1),
        expl_rush_rate = sum(expl_rush, na.rm = TRUE) / pmax(sum(is_rush_att, na.rm = TRUE), 1),
        # tendencies — neutral script only
        n_neutral    = sum(neutral, na.rm = TRUE),
        pass_rate_neutral = sum(is_dropback & neutral, na.rm = TRUE) / pmax(sum(neutral, na.rm = TRUE), 1),
        proe         = mean(pass_oe[neutral], na.rm = TRUE),
        early_down_pass_rate = sum(is_dropback & early_down & neutral, na.rm = TRUE) /
                               pmax(sum(early_down & neutral, na.rm = TRUE), 1),
        shotgun_rate = mean(shotgun[is_dropback | is_rush_att], na.rm = TRUE),
        no_huddle_rate = mean(no_huddle[is_dropback | is_rush_att], na.rm = TRUE),
        # red zone
        n_rz         = sum(rz, na.rm = TRUE),
        rz_pass_rate = sum(rz & is_dropback, na.rm = TRUE) / pmax(sum(rz, na.rm = TRUE), 1),
        rz_td_rate   = sum(rz & coalesce(touchdown, 0) == 1, na.rm = TRUE) / pmax(sum(rz, na.rm = TRUE), 1),
        # pressure — pbp proxy (sack|qb_hit per dropback), all seasons
        pbp_pressure_rate = sum((coalesce(sack, 0) == 1 | coalesce(qb_hit, 0) == 1) & is_dropback, na.rm = TRUE) /
                            pmax(sum(is_dropback, na.rm = TRUE), 1),
        sack_rate    = sum(coalesce(sack, 0) == 1 & is_dropback, na.rm = TRUE) / pmax(sum(is_dropback, na.rm = TRUE), 1),
        # scheme — participation-charted (2016+); NA before / when unjoined
        n_charted    = sum(!is.na(was_pressure), na.rm = TRUE),
        charted_pressure_rate = mean(was_pressure, na.rm = TRUE),
        box_mean     = mean(box, na.rm = TRUE),
        blitz_rate   = mean(pass_rushers >= 5, na.rm = TRUE),
        n_manzone    = sum(man_zone %in% c("MAN_COVERAGE", "ZONE_COVERAGE"), na.rm = TRUE),
        man_rate     = sum(man_zone == "MAN_COVERAGE", na.rm = TRUE) /
                       pmax(sum(man_zone %in% c("MAN_COVERAGE", "ZONE_COVERAGE"), na.rm = TRUE), 1),
        personnel_11_rate = mean(personnel == "11", na.rm = TRUE),
        personnel_heavy_rate = mean(personnel %in% c("12", "13", "21", "22"), na.rm = TRUE),
        .groups = "drop"
      ) %>%
      mutate(side = side_label)
  }

  na_if_no_sample <- function(df) {
    df %>% mutate(
      charted_pressure_rate = ifelse(n_charted >= 5, charted_pressure_rate, NA_real_),
      box_mean   = ifelse(n_charted >= 5, box_mean, NA_real_),
      blitz_rate = ifelse(n_charted >= 5, blitz_rate, NA_real_),
      man_rate   = ifelse(n_manzone >= FI$CONF_THRESHOLDS$play_rate_metric[["insufficient"]], man_rate, NA_real_),
      personnel_11_rate = ifelse(n_charted >= 5, personnel_11_rate, NA_real_),
      personnel_heavy_rate = ifelse(n_charted >= 5, personnel_heavy_rate, NA_real_),
      proe = ifelse(n_neutral >= 5, proe, NA_real_),
      pass_rate_neutral = ifelse(n_neutral >= 5, pass_rate_neutral, NA_real_),
      early_down_pass_rate = ifelse(n_neutral >= 5, early_down_pass_rate, NA_real_)
    )
  }
  off <- na_if_no_sample(agg_side(sc, "posteam", "defteam", "offense"))
  def <- na_if_no_sample(agg_side(sc, "defteam", "posteam", "defense"))

  # pace: seconds per play, neutral early-down, no-huddle excluded, within drive
  pace <- p %>%
    filter(is_dropback | is_rush_att, coalesce(no_huddle, 0) == 0, early_down, neutral,
           !is.na(fixed_drive), !is.na(game_seconds_remaining)) %>%
    arrange(game_id, fixed_drive, desc(game_seconds_remaining)) %>%
    group_by(game_id, posteam, fixed_drive) %>%
    mutate(sec = dplyr::lag(game_seconds_remaining) - game_seconds_remaining) %>%
    ungroup() %>%
    filter(is.finite(sec), sec >= 8, sec <= 45) %>%
    group_by(season, week, team = posteam) %>%
    summarise(pace_sec_play = mean(sec, na.rm = TRUE), n_pace = dplyr::n(), .groups = "drop")

  off <- off %>% left_join(pace, by = c("season", "week", "team"))

  bind_rows(off, def)
}

# --------------------------------------------------------------------------
# player x game USAGE (spec §6). OBSERVED opportunity only — never points,
# never talent. QB/RB/WR/TE. Built from pbp + participation routes + snaps.
# --------------------------------------------------------------------------
build_player_game_usage <- function(pbp, participation, snap_counts, ff_playerids, FI) {
  p <- pbp %>% filter(season_type %in% c("REG", "POST"), !is.na(posteam))

  # team-week denominators
  team_wk <- p %>%
    group_by(season, week, team = posteam) %>%
    summarise(team_pass_att = sum(coalesce(pass, 0), na.rm = TRUE),
              team_rush_att = sum(coalesce(rush, 0) == 1 & coalesce(qb_dropback, 0) == 0, na.rm = TRUE),
              team_air_yards = sum(air_yards[coalesce(pass, 0) == 1], na.rm = TRUE),
              team_rz_pass = sum(coalesce(pass, 0) == 1 & !is.na(yardline_100) & yardline_100 <= 20, na.rm = TRUE),
              team_rz_rush = sum(coalesce(rush, 0) == 1 & coalesce(qb_dropback, 0) == 0 & !is.na(yardline_100) & yardline_100 <= 20, na.rm = TRUE),
              .groups = "drop")

  targets <- p %>% filter(coalesce(pass, 0) == 1, !is.na(receiver_player_id)) %>%
    group_by(season, week, team = posteam, gsis_id = receiver_player_id) %>%
    summarise(targets = dplyr::n(),
              air_yards = sum(air_yards, na.rm = TRUE),
              adot = mean(air_yards, na.rm = TRUE),
              rz_targets = sum(!is.na(yardline_100) & yardline_100 <= 20, na.rm = TRUE),
              .groups = "drop")

  carries <- p %>% filter(coalesce(rush, 0) == 1, coalesce(qb_dropback, 0) == 0, !is.na(rusher_player_id)) %>%
    group_by(season, week, team = posteam, gsis_id = rusher_player_id) %>%
    summarise(carries = dplyr::n(),
              rz_carries = sum(!is.na(yardline_100) & yardline_100 <= 20, na.rm = TRUE),
              gl_carries = sum(!is.na(yardline_100) & yardline_100 <= 5, na.rm = TRUE),
              .groups = "drop")

  dropbacks <- p %>% filter(coalesce(qb_dropback, 0) == 1, !is.na(passer_player_id)) %>%
    group_by(season, week, team = posteam, gsis_id = passer_player_id) %>%
    summarise(dropbacks = dplyr::n(),
              deep_att = sum(air_yards >= 20, na.rm = TRUE),
              qb_scrambles = sum(coalesce(qb_scramble, 0) == 1, na.rm = TRUE),
              .groups = "drop")
  qb_designed_rush <- p %>% filter(coalesce(rush, 0) == 1, coalesce(qb_dropback, 0) == 0, !is.na(rusher_player_id)) %>%
    inner_join(distinct(dropbacks, season, week, team, gsis_id), by = c("season", "week", "posteam" = "team", "rusher_player_id" = "gsis_id")) %>%
    group_by(season, week, team = posteam, gsis_id = rusher_player_id) %>%
    summarise(designed_rush = dplyr::n(), .groups = "drop")

  # routes from participation (2016+): count pass plays where player is on field + a route recorded
  routes <- NULL
  if (!is.null(participation) && "route" %in% names(participation) && "offense_players" %in% names(participation)) {
    gm <- distinct(p, game_id, season, week, posteam)
    rp <- participation %>%
      filter(!is.na(route), route != "") %>%
      transmute(game_id = nflverse_game_id, play_id, offense_players) %>%
      inner_join(gm, by = "game_id")
    routes <- rp %>%
      mutate(pid = strsplit(offense_players, ";")) %>%
      tidyr::unnest(pid) %>%
      filter(pid != "") %>%
      group_by(season, week, team = posteam, gsis_id = pid) %>%
      summarise(routes = dplyr::n(), .groups = "drop")
  }

  # team pass plays for route participation denominator
  team_pass_plays <- p %>% filter(coalesce(pass, 0) == 1) %>%
    count(season, week, team = posteam, name = "team_pass_plays")

  snaps <- snap_counts %>%
    left_join(select(ff_playerids, gsis_id, pfr_id), by = c("pfr_player_id" = "pfr_id")) %>%
    filter(!is.na(gsis_id)) %>%
    group_by(season, week, team, gsis_id) %>%
    summarise(off_snaps = sum(offense_snaps, na.rm = TRUE),
              snap_share = mean(offense_pct, na.rm = TRUE), .groups = "drop")

  usage <- purrr::reduce(
    list(targets, carries, dropbacks, qb_designed_rush, routes, snaps),
    ~ full_join(.x, .y, by = c("season", "week", "team", "gsis_id")),
    .init = distinct(bind_rows(
      select(targets, season, week, team, gsis_id),
      select(carries, season, week, team, gsis_id),
      select(dropbacks, season, week, team, gsis_id)
    ))
  ) %>%
    left_join(team_wk, by = c("season", "week", "team")) %>%
    left_join(team_pass_plays, by = c("season", "week", "team")) %>%
    mutate(
      targets = coalesce(targets, 0), carries = coalesce(carries, 0),
      dropbacks = coalesce(dropbacks, 0), designed_rush = coalesce(designed_rush, 0),
      target_share = ifelse(team_pass_att > 0, targets / team_pass_att, NA_real_),
      rush_share   = ifelse(team_rush_att > 0, carries / team_rush_att, NA_real_),
      air_yards_share = ifelse(team_air_yards > 0, air_yards / team_air_yards, NA_real_),
      rz_target_share = ifelse(team_rz_pass > 0, rz_targets / team_rz_pass, NA_real_),
      rz_carry_share  = ifelse(team_rz_rush > 0, rz_carries / team_rz_rush, NA_real_),
      route_participation = ifelse(!is.na(routes) & team_pass_plays > 0, routes / team_pass_plays, NA_real_),
      deep_att_rate = ifelse(dropbacks > 0, deep_att / dropbacks, NA_real_),
      designed_rush_rate = ifelse(dropbacks > 0, designed_rush / (dropbacks + designed_rush), NA_real_)
    )
  usage
}

# --------------------------------------------------------------------------
# feature catalog — the spec-mandated output-class + availability declaration.
# --------------------------------------------------------------------------
feature_catalog <- function() {
  tibble::tribble(
    ~feature,                 ~grain,   ~class,             ~since_season, ~notes,
    "off_pass_epa",           "team",   "MODELED",          2012, "opponent-adjusted pbp pass EPA/play",
    "off_rush_epa",           "team",   "MODELED",          2012, "opponent-adjusted pbp rush EPA/play",
    "off_success_rate",       "team",   "MODELED",          2012, "opponent-adjusted",
    "off_proe",               "team",   "MODELED",          2012, "pass rate over expected, neutral",
    "off_pass_rate_neutral",  "team",   "MODELED",          2012, "neutral early/all down pass rate",
    "off_early_down_pass_rate","team",  "MODELED",          2012, "neutral",
    "off_pace_sec_play",      "team",   "MODELED",          2012, "neutral early-down no-huddle-excluded",
    "off_explosive_pass_rate","team",   "MODELED",          2012, ">=16 air+yac",
    "off_explosive_rush_rate","team",   "MODELED",          2012, ">=12",
    "off_pressure_rate_allowed","team", "MODELED",          2012, "pbp proxy all yrs; charted 2016+",
    "off_sack_rate_allowed",  "team",   "MODELED",          2012, "",
    "off_rz_pass_rate",       "team",   "MODELED",          2012, "",
    "off_rz_td_rate",         "team",   "MODELED",          2012, "",
    "def_pass_epa_allowed",   "team",   "MODELED",          2012, "opponent-adjusted",
    "def_rush_epa_allowed",   "team",   "MODELED",          2012, "opponent-adjusted",
    "def_success_allowed",    "team",   "MODELED",          2012, "",
    "def_explosive_pass_rate_allowed","team","MODELED",     2012, "",
    "def_explosive_rush_rate_allowed","team","MODELED",     2012, "",
    "def_pressure_rate",      "team",   "MODELED",          2012, "pbp proxy; charted 2016+; PFR 2018+",
    "def_blitz_rate",         "team",   "MODELED",          2016, "participation 5+ pass rushers",
    "def_pressure_without_blitz_rate","team","MODELED",     2016, "participation",
    "def_box_mean",           "team",   "MODELED",          2016, "participation defenders in box",
    "def_rz_td_rate_allowed", "team",   "MODELED",          2012, "",
    "def_man_rate",           "team",   "DESCRIPTIVE_ONLY", 2016, "charting-confidence varies; min-play gated",
    "coverage_allowed_epa_RB","unit",   "MODELED",          2012, "pbp target EPA to RB alignment",
    "coverage_allowed_epa_WR","unit",   "MODELED",          2012, "",
    "coverage_allowed_epa_TE","unit",   "MODELED",          2012, "",
    "usage_*",                "player", "OBSERVED",         2012, "share/participation; routes 2016+",
    "ftn_*",                  "team",   "DESCRIPTIVE_ONLY", 2022, "play-action/screen/RPO/motion — NEVER a model input"
  )
}
