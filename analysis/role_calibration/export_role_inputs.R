#!/usr/bin/env Rscript
# ===========================================================================
# Projection Calibration Phase 2 — Role & Opportunity calibration inputs.
#
#   Rscript analysis/role_calibration/export_role_inputs.R [season] [target_weeks_csv]
#
# REUSES the canonical Role Intelligence pipeline (analysis/player_role): the player-game substrate
# (player_game_role.rds, built by run_build.R from the FI raw cache) and `build_role_profile()`. Adds NO
# new role definition. Exports additive artifacts under lib/role-calibration/data/:
#
#   observed_role_game.csv   observed (completed-game) role per skill player-game, seasons season-1..season
#   role_profile_asof.csv    PRE-GAME role forecast baseline per (target_week, player): the canonical profile
#                            evaluated at a SYNTHETIC future row for the target week whose metrics are all NA, so
#                            `recent`/`season`/`prior` are computed from history STRICTLY BEFORE the target week and
#                            the target week's own outcome can never enter (structural leakage guard, asserted below)
#   injury_reports.csv       official nflverse team-week injury designations (skill positions)
#   depth_chart_snapshots.csv timestamped (dt) skill-position depth charts
#
# Missing stays NA. Route participation is NA for 2026 (nflverse participation unpublished) and is never filled.
# ===========================================================================
suppressWarnings(suppressMessages({ library(dplyr); library(tidyr); library(jsonlite); library(nflreadr) }))
options(nflreadr.verbose = FALSE, timeout = 900)

BASE <- file.path(getwd(), "analysis", "player_role")
source(file.path(BASE, "config.R"))
source(file.path(BASE, "lib_role_profile.R"))
source(file.path(BASE, "lib_role_domains.R"))

args <- commandArgs(TRUE)
season <- if (length(args) >= 1) as.integer(args[1]) else ROLE$SEASON_CURRENT
target_weeks <- if (length(args) >= 2) as.integer(strsplit(args[2], ",")[[1]]) else 2:4
# Phase 3: optional 3rd arg = output suffix (e.g. "_2025") and 4th arg "profiles_only" => export ONLY the as-of profiles (historical calibration runs)
suffix <- if (length(args) >= 3) args[3] else ""
profiles_only <- length(args) >= 4 && args[4] == "profiles_only"
OUT <- file.path(getwd(), "lib", if (nzchar(suffix)) "game-distribution" else "role-calibration", "data")
dir.create(OUT, recursive = TRUE, showWarnings = FALSE)
SKILL <- c("QB", "RB", "WR", "TE")

pgr <- readRDS(file.path(ROLE$CACHE_DIR, "player_game_role.rds"))
skill <- pgr %>% filter(position %in% SKILL, season >= !!season - 1L, season <= !!season)

# ---- 1. observed role (completed games only) --------------------------------------------------------------------
obs_cols <- c("season", "week", "game_id", "gsis_id", "sleeper_id", "full_name", "position", "team", "opponent",
  "offensive_snaps", "team_offensive_plays", "snap_share_derived", "route_participation", "pass_play_personnel", "targets", "team_pass_att", "target_share",
  "receptions", "air_yards", "team_air_yards", "air_yards_share", "carries", "team_rush_att", "rush_share", "position_group_rush_share", "position_group_target_share",
  "dropbacks", "qb_scrambles", "designed_rushes", "red_zone_targets", "red_zone_carries", "inside_10_targets", "inside_10_carries", "goal_line_carries", "end_zone_targets",
  "team_rz_pass_att", "team_rz_rush_att", "rz_target_share", "rz_carry_share", "third_down_targets", "third_down_carries", "two_minute_targets", "two_minute_carries",
  "team_changed_since_prior_game", "team_offensive_plays_neutral_score_differential")
obs <- skill %>% select(any_of(obs_cols)) %>% arrange(season, week, team, gsis_id)
# team inside-10 / goal-line totals (denominators for inside-10 & goal-line carry share) from ALL players on the team-game
team_tot <- pgr %>% filter(season >= !!season - 1L, season <= !!season) %>% group_by(season, week, team) %>%
  summarise(team_inside_10_carries = sum(inside_10_carries, na.rm = TRUE), team_goal_line_carries = sum(goal_line_carries, na.rm = TRUE),
            team_inside_10_targets = sum(inside_10_targets, na.rm = TRUE), .groups = "drop")
obs <- obs %>% left_join(team_tot, by = c("season", "week", "team")) %>%
  mutate(inside_10_carry_share = ifelse(team_inside_10_carries > 0, inside_10_carries / team_inside_10_carries, NA_real_),
         goal_line_carry_share = ifelse(team_goal_line_carries > 0, goal_line_carries / team_goal_line_carries, NA_real_))
write.csv(obs, file.path(OUT, sprintf("observed_role_game%s.csv", suffix)), row.names = FALSE, na = ""); cat(sprintf("observed_role_game%s.csv: %d rows\n", suffix, nrow(obs)))

# ---- 2. pre-game role profiles (synthetic NA target-week row) ------------------------------------------------------
rw <- readRDS(file.path(FI$CACHE_DIR, "rosters_weekly.rds"))
dims <- list(
  snap_share = function(p) p$participation,
  target_share = function(p) p$receiving$target_share, air_yards_share = function(p) p$receiving$air_yards_share,
  route_participation = function(p) p$receiving$route_participation, position_group_target_share = function(p) p$receiving$position_group_target_share,
  rush_share = function(p) p$rushing$rush_share, position_group_rush_share = function(p) p$rushing$position_group_rush_share,
  rz_target_share = function(p) p$high_value$rz_target_share, rz_carry_share = function(p) p$high_value$rz_carry_share)
metric_row <- function(nm, d) {
  g <- function(f) { v <- if (is.null(d)) NA else d[[f]]; if (is.null(v) || length(v) == 0) NA else v }
  tibble::tibble(!!paste0(nm, "_recent") := as.numeric(g("recent")), !!paste0(nm, "_season") := as.numeric(g("season")),
    !!paste0(nm, "_prior") := as.numeric(g("prior")), !!paste0(nm, "_prior_conf") := as.character(g("prior_role_confidence")),
    !!paste0(nm, "_discontinuity") := as.character(g("discontinuity")), !!paste0(nm, "_n_games") := as.integer(g("n_games_season")),
    !!paste0(nm, "_opp_total") := as.numeric(g("opportunity_total")), !!paste0(nm, "_conf") := as.character(g("confidence")))
}
metric_cols <- setdiff(names(pgr), c("season", "week", "game_id", "gsis_id", "sleeper_id", "pfr_id", "full_name", "position", "team", "opponent", "prior_game_team", "team_changed_since_prior_game", "overtime", "offense_domain_active", "return_domain_active", "snap_share_source", "route_participation_definition", "route_participation_reliability"))
profiles <- list()
for (N in target_weeks) {
  hist <- pgr %>% filter(position %in% SKILL, season < !!season | (season == !!season & week < N))
  rosters_N <- rw %>% filter(season == !!season, week == N, position %in% SKILL) %>% distinct(gsis_id, team, position)
  last <- hist %>% arrange(season, week) %>% group_by(gsis_id) %>% slice_tail(n = 1) %>% ungroup()
  # candidates: on the target-week roster, or already has a game this season (anyone else cannot be a target-week skill player)
  ids <- intersect(unique(hist$gsis_id), union(rosters_N$gsis_id, hist$gsis_id[hist$season == season]))
  cat(sprintf("target week %d: %d candidate players with prior history\n", N, length(ids))); flush.console()
  for (id in ids) {
    ph <- hist %>% filter(gsis_id == id) %>% arrange(season, week)
    l <- last %>% filter(gsis_id == id)
    r <- rosters_N %>% filter(gsis_id == id)
    team_N <- if (nrow(r) == 1) r$team else l$team
    pos_N <- if (nrow(r) == 1) r$position else l$position
    syn <- l[1, ]
    for (cc in metric_cols) syn[[cc]] <- NA
    syn$season <- season; syn$week <- N; syn$team <- team_N; syn$position <- pos_N; syn$game_id <- NA_character_; syn$opponent <- NA_character_
    ph_plus <- bind_rows(ph, syn)
    stopifnot(max(ph$season * 100 + ph$week) < season * 100 + N)   # LEAKAGE GUARD: every history row is strictly before the target week
    p <- tryCatch(build_role_profile(ph_plus, season, N, ROLE), error = function(e) NULL)
    if (is.null(p)) next
    row <- tibble::tibble(target_week = N, gsis_id = id, sleeper_id = l$sleeper_id[1], full_name = l$full_name[1], position = pos_N, team = team_N,
      last_game_season = l$season[1], last_game_week = l$week[1], last_game_team = l$team[1],
      games_before_target_season = sum(ph$season == season), roster_team_source = if (nrow(r) == 1) "rosters_weekly" else "last_game_row")
    for (nm in names(dims)) row <- bind_cols(row, metric_row(nm, dims[[nm]](p)))
    profiles[[length(profiles) + 1]] <- row
  }
}
prof <- bind_rows(profiles)
write.csv(prof, file.path(OUT, sprintf("role_profile_asof%s.csv", suffix)), row.names = FALSE, na = "")
cat(sprintf("role_profile_asof%s.csv: %d rows\n", suffix, nrow(prof)))
if (profiles_only) quit(save = "no", status = 0)

# ---- 3. official injury designations (team-week) ---------------------------------------------------------------------
inj <- load_injuries(seasons = c(season - 1L, season)) %>% filter(position %in% SKILL) %>%
  transmute(season, week, gsis_id, team, position, report_status, practice_status, report_primary_injury, practice_primary_injury)
write.csv(inj, file.path(OUT, "injury_reports.csv"), row.names = FALSE, na = "")
cat(sprintf("injury_reports.csv: %d rows (weeks %s)\n", nrow(inj), paste(range(inj$week[inj$season == season]), collapse = "-")))

# ---- 4. timestamped depth charts (starter/backup state) --------------------------------------------------------------
dc <- load_depth_charts(season) %>% filter(pos_abb %in% SKILL, as.Date(dt) >= as.Date(sprintf("%d-08-25", season))) %>%
  transmute(dt, team, gsis_id, pos_abb, pos_slot, pos_rank)
write.csv(dc, file.path(OUT, "depth_chart_snapshots.csv"), row.names = FALSE, na = "")
cat(sprintf("depth_chart_snapshots.csv: %d rows\n", nrow(dc)))
