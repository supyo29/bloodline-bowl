# ===========================================================================
# PHASE 3 — reproducible data fetch + aggregation
#
#   Rscript analysis/phase3_fetch_data.R [--refresh]
#
# Pulls NFL data from the nflverse GitHub releases (via {nflreadr}) and college
# play-by-play-derived player data from the cfbfastR-data GitHub repo, then
# aggregates both to player-season tables cached under analysis/phase3_cache/
# (git-ignored). The modelling harness (phase3_rookie_role_model.R) reads ONLY
# these cached aggregates so a rerun is fast and deterministic.
#
# Every source is a versioned public dataset. No scraping, no API keys.
# ===========================================================================

suppressWarnings(suppressMessages({
  library(nflreadr); library(dplyr); library(tidyr); library(stringr)
}))
options(nflreadr.verbose = FALSE, timeout = 600)

.args   <- commandArgs(TRUE)
REFRESH <- "--refresh" %in% .args
.file   <- sub("^--file=", "", grep("^--file=", commandArgs(FALSE), value = TRUE))
ROOT    <- if (length(.file)) normalizePath(file.path(dirname(.file), "..")) else getwd()
CACHE   <- file.path(ROOT, "analysis", "phase3_cache")
dir.create(CACHE, showWarnings = FALSE, recursive = TRUE)

cache <- function(name, expr) {
  path <- file.path(CACHE, paste0(name, ".rds"))
  if (!REFRESH && file.exists(path)) {
    cat(sprintf("  [cached] %s\n", name)); return(readRDS(path))
  }
  cat(sprintf("  [fetch ] %s ...\n", name))
  val <- force(expr)
  saveRDS(val, path)
  val
}

NFL_SEASONS <- 2012:2025          # rookie year-1 outcomes + prior-year destination context
CFB_SEASONS <- 2011:2024          # final college season for draft classes 2012..2025

cat("PHASE 3 data fetch  (refresh =", REFRESH, ")\n\nNFL (nflverse):\n")

# --- NFL player master, draft, combine, ids ---
players_master <- cache("nfl_players_master", nflreadr::load_players())
draft_picks    <- cache("nfl_draft_picks",    nflreadr::load_draft_picks(seasons = 2000:2025))
combine        <- cache("nfl_combine",         nflreadr::load_combine(seasons = 2000:2025))
ff_ids         <- cache("ff_playerids",        nflreadr::load_ff_playerids())

# --- NFL rosters (years_exp, sleeper_id, depth_chart_position) ---
KEEP_ROSTER <- c("season", "team", "position", "depth_chart_position", "status",
                 "full_name", "birth_date", "gsis_id", "sleeper_id", "pfr_id",
                 "espn_id", "years_exp")
rosters <- cache("nfl_rosters", {
  bind_rows(lapply(NFL_SEASONS, function(s) {
    d <- tryCatch(nflreadr::load_rosters(seasons = s), error = function(e) NULL)
    if (is.null(d)) return(NULL)
    d %>% select(any_of(KEEP_ROSTER)) %>%
      mutate(across(any_of(c("sleeper_id", "espn_id")), as.character))
  }))
})

# --- NFL earliest-available depth chart (closest reproducible entering-season
#     role). nflverse changed the schema for 2025 (snapshot-based, `dt`) vs the
#     older weekly format (`week`, `club_code`, `depth_team`). Normalised to
#     season / team / gsis_id / position / depth_rank. ---
depth_wk1 <- cache("nfl_depth_charts_early", {
  bind_rows(lapply(2015:2025, function(s) {
    d <- tryCatch(nflreadr::load_depth_charts(seasons = s), error = function(e) NULL)
    if (is.null(d)) return(NULL)
    if ("week" %in% names(d)) {
      d %>% filter(week == min(week, na.rm = TRUE)) %>%
        transmute(season, team = club_code, gsis_id,
                  position = depth_position,
                  depth_rank = suppressWarnings(as.integer(depth_team)))
    } else {
      first_dt <- min(d$dt, na.rm = TRUE)
      d %>% filter(dt == first_dt) %>%
        transmute(season = s, team, gsis_id,
                  position = pos_abb,
                  depth_rank = suppressWarnings(as.integer(pos_rank)))
    }
  }))
})

# --- NFL weekly player stats -> REGULAR-SEASON player-season aggregate ---
nfl_player_season <- cache("nfl_player_season", {
  bind_rows(lapply(NFL_SEASONS, function(s) {
    ps <- tryCatch(nflreadr::load_player_stats(seasons = s), error = function(e) NULL)
    if (is.null(ps)) return(NULL)
    ps %>%
      filter(season_type == "REG", position %in% c("QB", "RB", "WR", "TE")) %>%
      group_by(gsis_id = player_id, player = player_display_name, position, season) %>%
      summarise(
        games          = dplyr::n_distinct(week),
        pass_att       = sum(attempts, na.rm = TRUE),
        pass_cmp       = sum(completions, na.rm = TRUE),
        pass_yd        = sum(passing_yards, na.rm = TRUE),
        pass_td        = sum(passing_tds, na.rm = TRUE),
        pass_int       = sum(passing_interceptions, na.rm = TRUE),
        carries        = sum(carries, na.rm = TRUE),
        rush_yd        = sum(rushing_yards, na.rm = TRUE),
        rush_td        = sum(rushing_tds, na.rm = TRUE),
        targets        = sum(targets, na.rm = TRUE),
        rec            = sum(receptions, na.rm = TRUE),
        rec_yd         = sum(receiving_yards, na.rm = TRUE),
        rec_td         = sum(receiving_tds, na.rm = TRUE),
        fantasy_points_ppr = sum(fantasy_points_ppr, na.rm = TRUE),
        .groups = "drop"
      )
  }))
})

# --- NFL team-season passing/rushing volume (destination context denominators) ---
nfl_team_season <- cache("nfl_team_season", {
  nfl_player_season %>%
    group_by(team_season = season) %>%   # placeholder; recompute below with team
    ungroup()
})
# team requires the team column from weekly stats: recompute directly
nfl_team_season <- cache("nfl_team_season_v2", {
  bind_rows(lapply(NFL_SEASONS, function(s) {
    ps <- tryCatch(nflreadr::load_player_stats(seasons = s), error = function(e) NULL)
    if (is.null(ps)) return(NULL)
    ps %>%
      filter(season_type == "REG", position %in% c("QB", "RB", "WR", "TE")) %>%
      group_by(team, season) %>%
      summarise(team_pass_att = sum(attempts, na.rm = TRUE),
                team_targets  = sum(targets, na.rm = TRUE),
                team_rush_att = sum(carries, na.rm = TRUE),
                team_pass_td  = sum(passing_tds, na.rm = TRUE),
                team_rush_td  = sum(rushing_tds, na.rm = TRUE),
                .groups = "drop")
  }))
})

# player-season with team (for destination incumbent / vacated calc)
nfl_player_team_season <- cache("nfl_player_team_season", {
  bind_rows(lapply(NFL_SEASONS, function(s) {
    ps <- tryCatch(nflreadr::load_player_stats(seasons = s), error = function(e) NULL)
    if (is.null(ps)) return(NULL)
    ps %>%
      filter(season_type == "REG", position %in% c("QB", "RB", "WR", "TE")) %>%
      group_by(gsis_id = player_id, player = player_display_name, position, team, season) %>%
      summarise(games = dplyr::n_distinct(week),
                targets = sum(targets, na.rm = TRUE),
                carries = sum(carries, na.rm = TRUE),
                rec = sum(receptions, na.rm = TRUE),
                rush_yd = sum(rushing_yards, na.rm = TRUE),
                rec_yd = sum(receiving_yards, na.rm = TRUE),
                fantasy_points_ppr = sum(fantasy_points_ppr, na.rm = TRUE),
                .groups = "drop")
  }))
})

# --- NFL snap counts -> player-season offensive snap share (year-1 usage target) ---
nfl_snap_season <- cache("nfl_snap_season", {
  bind_rows(lapply(2012:2025, function(s) {
    sc <- tryCatch(nflreadr::load_snap_counts(seasons = s), error = function(e) NULL)
    if (is.null(sc)) return(NULL)
    sc %>% filter(game_type == "REG") %>%
      group_by(pfr_player_id, season) %>%
      summarise(off_snaps = sum(offense_snaps, na.rm = TRUE),
                off_pct_mean = mean(offense_pct, na.rm = TRUE),
                snap_games = dplyr::n(), .groups = "drop")
  }))
})

cat("\nCollege (cfbfastR-data play-by-play -> player-season):\n")

cfb_player_season <- cache("cfb_player_season", {
  agg_one <- function(yr) {
    u <- sprintf("https://github.com/sportsdataverse/cfbfastR-data/raw/main/player_stats/rds/player_stats_%d.rds", yr)
    tmp <- tempfile()
    ok <- tryCatch({ download.file(u, tmp, quiet = TRUE, mode = "wb"); TRUE }, error = function(e) FALSE)
    if (!ok) { cat("    cfb", yr, "FAIL\n"); return(NULL) }
    d <- tryCatch(readRDS(tmp), error = function(e) NULL)
    if (is.null(d)) return(NULL)
    d$rz <- !is.na(d$yards_to_goal) & d$yards_to_goal <= 20

    # cfbfastR schema (verified):
    #   completion/incompletion_player_id = the QB;  reception_player_id = the catcher
    #   target_player_id = intended catcher on an INCOMPLETE pass (populated on
    #     only ~40% of incompletions -> college "targets" are low quality; use
    #     receptions + receiving yards as the reliable receiving signal)
    #   touchdown_player_id = scorer; classify by which same-row role it matches
    mk <- function(id_col, ...) {
      d %>% filter(!is.na(.data[[id_col]])) %>%
        group_by(pid = as.character(.data[[id_col]])) %>%
        summarise(..., .groups = "drop")
    }
    # On a TD play cfbfastR credits `touchdown_player_id` to the QB for a
    # passing TD (verified); the catcher is in `reception_player_id`, the ball
    # carrier in `rush_player_id`. So:
    tdp <- d %>% filter(!is.na(touchdown_player_id))
    rec_td  <- tdp %>% filter(!is.na(reception_player_id)) %>% count(pid = as.character(reception_player_id), name = "rec_td")
    rush_td <- tdp %>% filter(!is.na(rush_player_id))      %>% count(pid = as.character(rush_player_id),      name = "rush_td")
    pass_td <- tdp %>% filter(!is.na(completion_player_id)) %>% count(pid = as.character(completion_player_id), name = "pass_td")

    # games: distinct game_id in which the athlete appears in ANY skill role
    long_ids <- bind_rows(
      d %>% transmute(game_id, pid = as.character(reception_player_id)),
      d %>% transmute(game_id, pid = as.character(rush_player_id)),
      d %>% transmute(game_id, pid = as.character(completion_player_id)),
      d %>% transmute(game_id, pid = as.character(incompletion_player_id)),
      d %>% transmute(game_id, pid = as.character(target_player_id))
    ) %>% filter(!is.na(pid))
    games_tbl <- long_ids %>% group_by(pid) %>% summarise(c_games = dplyr::n_distinct(game_id), .groups = "drop")

    recv <- mk("reception_player_id", rec = dplyr::n(), rec_yd = sum(reception_yds, na.rm = TRUE),
               rz_rec = sum(rz), team = dplyr::first(team), conference = dplyr::first(conference))
    tgt_partial <- mk("target_player_id", targets_partial = dplyr::n())
    rush <- mk("rush_player_id", carries = dplyr::n(), rush_yd = sum(rush_yds, na.rm = TRUE),
               rz_carries = sum(rz))
    cmp  <- mk("completion_player_id", pass_cmp = dplyr::n(), pass_yd = sum(completion_yds, na.rm = TRUE),
               team_qb = dplyr::first(team))
    inc  <- mk("incompletion_player_id", pass_inc = dplyr::n())
    ints <- mk("interception_thrown_player_id", pass_int = dplyr::n())

    out <- Reduce(function(a, b) full_join(a, b, by = "pid"),
                  list(recv, tgt_partial, rush, rec_td, rush_td, pass_td, cmp, inc, ints, games_tbl)) %>%
      mutate(season = yr) %>%
      mutate(across(c(rec, rec_yd, rz_rec, targets_partial, carries, rush_yd, rz_carries, c_games,
                      rec_td, rush_td, pass_td, pass_cmp, pass_yd, pass_inc, pass_int),
                    ~ tidyr::replace_na(., 0))) %>%
      mutate(team = dplyr::coalesce(team, team_qb),
             pass_att = pass_cmp + pass_inc,
             targets_lb = rec + targets_partial) %>%   # lower bound on targets
      select(-team_qb)
    cat(sprintf("    cfb %d: %d player-seasons\n", yr, nrow(out)))
    out
  }
  bind_rows(lapply(CFB_SEASONS, agg_one))
})

# college rosters: athlete_id (the id used in the play data) -> name / school /
# position / year. The bridge from nflverse draft picks (name + college) to the
# cfbfastR play-level ids.
cfb_rosters <- cache("cfb_rosters", {
  one <- function(yr) {
    u <- sprintf("https://github.com/sportsdataverse/cfbfastR-data/raw/main/rosters/rds/cfb_rosters_%d.rds", yr)
    tmp <- tempfile()
    ok <- tryCatch({ download.file(u, tmp, quiet = TRUE, mode = "wb"); TRUE }, error = function(e) FALSE)
    if (!ok) return(NULL)
    d <- tryCatch(readRDS(tmp), error = function(e) NULL)
    if (is.null(d)) return(NULL)
    d %>% transmute(athlete_id = as.character(athlete_id),
                    first_name, last_name, team, position,
                    height = suppressWarnings(as.numeric(height)),
                    weight = suppressWarnings(as.numeric(weight)),
                    class_year = year, season = yr)
  }
  bind_rows(lapply(2013:2024, one))
})

# college team-season totals for share features
cfb_team_season <- cache("cfb_team_season", {
  cfb_player_season %>%
    group_by(team, season) %>%
    summarise(team_rec       = sum(rec, na.rm = TRUE),
              team_rec_yd    = sum(rec_yd, na.rm = TRUE),
              team_rec_td    = sum(rec_td, na.rm = TRUE),
              team_carries   = sum(carries, na.rm = TRUE),
              team_rush_yd   = sum(rush_yd, na.rm = TRUE),
              team_rush_td   = sum(rush_td, na.rm = TRUE),
              team_rz_rec    = sum(rz_rec, na.rm = TRUE),
              team_rz_carries = sum(rz_carries, na.rm = TRUE),
              team_pass_att  = sum(pass_att, na.rm = TRUE),
              .groups = "drop")
})

cat("\nSummary:\n")
cat(sprintf("  nfl_player_season      %d rows (%d-%d)\n", nrow(nfl_player_season), min(nfl_player_season$season), max(nfl_player_season$season)))
cat(sprintf("  nfl_player_team_season %d rows\n", nrow(nfl_player_team_season)))
cat(sprintf("  nfl_snap_season        %d rows\n", nrow(nfl_snap_season)))
cat(sprintf("  draft_picks            %d rows; cfb_player_id non-NA %d\n", nrow(draft_picks), sum(!is.na(draft_picks$cfb_player_id))))
cat(sprintf("  combine                %d rows\n", nrow(combine)))
cat(sprintf("  rosters                %d rows\n", nrow(rosters)))
cat(sprintf("  depth_wk1              %d rows\n", nrow(depth_wk1)))
cat(sprintf("  cfb_player_season      %d rows (%d-%d)\n", nrow(cfb_player_season), min(cfb_player_season$season), max(cfb_player_season$season)))
cat("\nPHASE 3 data fetch complete -> analysis/phase3_cache/\n")
