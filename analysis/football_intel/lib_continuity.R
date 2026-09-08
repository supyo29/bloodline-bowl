# ===========================================================================
# Football Intelligence — personnel & coaching continuity (spec §13, §14).
#
# Continuity signals DOWN-WEIGHT the historical prior (lib_priors), they are
# NOT additive bonuses. Where a signal cannot be established reliably it is
# `UNKNOWN` and applies NO discount (spec guardrail: never assume).
#
#   head coach        <- schedules (nflverse ships HC only)
#   starting QB        <- pbp primary passer by team-season
#   OL continuity      <- snap-weighted returning share of O-line snaps
#   front / secondary  <- snap-weighted returning share of DL+LB / DB snaps
#   OC / DC            <- analysis/football_intel/coordinators.yaml (hand-sourced,
#                         each row carries a source_url); absent -> UNKNOWN
# ===========================================================================

suppressWarnings(suppressMessages({ library(dplyr); library(tidyr) }))

# head coach by team-season from schedules
hc_by_team_season <- function(schedules) {
  bind_rows(
    schedules %>% transmute(season, team = home_team, coach = home_coach),
    schedules %>% transmute(season, team = away_team, coach = away_coach)
  ) %>%
    filter(!is.na(coach), coach != "") %>%
    count(season, team, coach, name = "g") %>%
    group_by(season, team) %>% slice_max(g, n = 1, with_ties = FALSE) %>% ungroup() %>%
    select(season, team, head_coach = coach)
}

# primary starting QB by team-season (most dropbacks)
qb_by_team_season <- function(pbp) {
  pbp %>%
    filter(coalesce(qb_dropback, 0) == 1, !is.na(passer_player_id), !is.na(posteam)) %>%
    count(season, team = posteam, passer_player_id, name = "db") %>%
    group_by(season, team) %>% slice_max(db, n = 1, with_ties = FALSE) %>% ungroup() %>%
    select(season, team, starting_qb = passer_player_id)
}

# snap-weighted returning share for a position group, team-season vs prior season
returning_share <- function(snap_counts, rosters_weekly, positions, out_col) {
  # position from rosters_weekly (snap_counts `position` is coarse); join on gsis via pfr
  sc <- snap_counts %>%
    filter(!is.na(position)) %>%
    group_by(season, team, player = coalesce(pfr_player_id, player), pos = position) %>%
    summarise(snaps = sum(coalesce(offense_snaps, 0) + coalesce(defense_snaps, 0), na.rm = TRUE), .groups = "drop") %>%
    filter(pos %in% positions, snaps > 0)
  sc <- sc %>% group_by(season, team, player) %>%
    summarise(snaps = sum(snaps), .groups = "drop")
  prev <- sc %>% mutate(season = season + 1L) %>% select(season, team, player, prev_snaps = snaps)
  sc %>%
    left_join(prev, by = c("season", "team", "player")) %>%
    group_by(season, team) %>%
    summarise(!!out_col := sum(snaps[!is.na(prev_snaps)], na.rm = TRUE) / pmax(sum(snaps, na.rm = TRUE), 1),
              .groups = "drop")
}

# coordinators.yaml -> tibble(season, team, offensive_coordinator, defensive_coordinator)
load_coordinators <- function(path) {
  if (!file.exists(path)) return(tibble::tibble(season = integer(), team = character(),
                                                offensive_coordinator = character(),
                                                defensive_coordinator = character()))
  y <- yaml::read_yaml(path)
  rows <- lapply(y$entries %||% list(), function(e) tibble::tibble(
    season = as.integer(e$season), team = toupper(e$team),
    offensive_coordinator = e$oc %||% NA_character_,
    defensive_coordinator = e$dc %||% NA_character_))
  if (!length(rows)) return(tibble::tibble(season = integer(), team = character(),
                                           offensive_coordinator = character(), defensive_coordinator = character()))
  bind_rows(rows)
}
`%||%` <- function(a, b) if (is.null(a) || length(a) == 0) b else a

# assemble the discontinuity table for target_season (booleans + [0,1] shares).
build_discontinuity_table <- function(target_season, schedules, pbp, snap_counts, rosters_weekly, coord_path, FI) {
  hc <- hc_by_team_season(schedules)
  qb <- qb_by_team_season(pbp)
  ol <- returning_share(snap_counts, rosters_weekly, c("T", "G", "C", "OL", "OT", "OG"), "ol_continuity")
  fr <- returning_share(snap_counts, rosters_weekly, c("DE", "DT", "NT", "DL", "EDGE", "LB", "ILB", "OLB", "MLB"), "front_returning")
  sec <- returning_share(snap_counts, rosters_weekly, c("CB", "S", "FS", "SS", "DB"), "secondary_returning")
  co <- load_coordinators(coord_path)

  cur <- tibble::tibble(team = sort(unique(c(schedules$home_team, schedules$away_team)))) %>%
    filter(!is.na(team), team != "")
  j <- function(df, s) df %>% filter(season == s) %>% select(-season)

  base <- cur %>%
    left_join(j(hc, target_season) %>% rename(hc_now = head_coach), by = "team") %>%
    left_join(j(hc, target_season - 1) %>% rename(hc_prev = head_coach), by = "team") %>%
    left_join(j(qb, target_season) %>% rename(qb_now = starting_qb), by = "team") %>%
    left_join(j(qb, target_season - 1) %>% rename(qb_prev = starting_qb), by = "team") %>%
    left_join(j(ol, target_season), by = "team") %>%
    left_join(j(fr, target_season), by = "team") %>%
    left_join(j(sec, target_season), by = "team") %>%
    left_join(j(co, target_season) %>% rename(oc_now = offensive_coordinator, dc_now = defensive_coordinator), by = "team") %>%
    left_join(j(co, target_season - 1) %>% rename(oc_prev = offensive_coordinator, dc_prev = defensive_coordinator), by = "team") %>%
    mutate(
      head_coach_change      = ifelse(!is.na(hc_now) & !is.na(hc_prev), hc_now != hc_prev, NA),
      starting_qb_change     = ifelse(!is.na(qb_now) & !is.na(qb_prev), qb_now != qb_prev, NA),
      offensive_coord_change = ifelse(!is.na(oc_now) & !is.na(oc_prev), oc_now != oc_prev, NA),
      defensive_coord_change = ifelse(!is.na(dc_now) & !is.na(dc_prev), dc_now != dc_prev, NA),
      front_turnover         = ifelse(is.finite(front_returning), 1 - front_returning, NA_real_),
      secondary_turnover     = ifelse(is.finite(secondary_returning), 1 - secondary_returning, NA_real_)
    )

  bind_rows(
    base %>% transmute(team, side = "offense", head_coach_change, starting_qb_change,
                       offensive_coord_change, defensive_coord_change = NA,
                       ol_continuity, front_turnover = NA_real_, secondary_turnover = NA_real_),
    base %>% transmute(team, side = "defense", head_coach_change, starting_qb_change = NA,
                       offensive_coord_change = NA, defensive_coord_change,
                       ol_continuity = NA_real_, front_turnover, secondary_turnover)
  )
}
