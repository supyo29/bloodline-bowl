#!/usr/bin/env Rscript
# ===========================================================================
# Phase 4 — fetch Sleeper historical weekly PROJECTIONS + ACTUAL stats for the
# decision-dataset grid. Cached to analysis/football_intel_startsit/cache/.
#
#   Rscript analysis/football_intel_startsit/fetch_sleeper_history.R [--refresh]
#
# Sleeper's precomputed pts_std / pts_half_ppr / pts_ppr are used directly as
# the three scoring ARCHETYPES (0 / 0.5 / 1 PPR) — for standard archetypes
# those ARE the archetype score; custom-bonus leagues are out of scope (§26).
#
# CAVEAT (recorded, surfaced in the report): projection rows carry
# `last_modified`; Sleeper may revise a week's projection THROUGH that week, so
# the projection baseline is "potentially revised" and is NEVER the sole
# certification baseline — the clean trailing-PPG control is (§3).
# ===========================================================================

suppressWarnings(suppressMessages({ library(jsonlite); library(dplyr); library(tidyr) }))
.here <- sub("^--file=", "", grep("^--file=", commandArgs(FALSE), value = TRUE))
source(file.path(dirname(.here), "config.R"))
REFRESH <- "--refresh" %in% commandArgs(TRUE)

pull <- function(kind, season, week) {
  # kind: "projections" or "stats"
  u <- sprintf("https://api.sleeper.app/%s/nfl/%d/%d?season_type=regular", kind, season, week)
  d <- tryCatch(jsonlite::fromJSON(u, flatten = TRUE), error = function(e) NULL)
  if (is.null(d) || !is.data.frame(d) || nrow(d) == 0) return(NULL)
  keep <- intersect(c("player_id", "team", "opponent", "week", "season", "last_modified",
                      "player.position", "player.injury_status",
                      "stats.pts_std", "stats.pts_half_ppr", "stats.pts_ppr", "stats.gp"), names(d))
  d %>% select(all_of(keep)) %>%
    mutate(season = as.integer(season), week = as.integer(week), kind = kind)
}

rename_std <- function(df, suffix) {
  df %>% transmute(
    season, week, sleeper_id = player_id,
    team = toupper(team), opponent = toupper(coalesce(opponent, NA_character_)),
    position = .data[["player.position"]],
    injury_status = if ("player.injury_status" %in% names(df)) .data[["player.injury_status"]] else NA_character_,
    last_modified = if ("last_modified" %in% names(df)) last_modified else NA_real_,
    "{suffix}_std" := .data[["stats.pts_std"]],
    "{suffix}_half" := .data[["stats.pts_half_ppr"]],
    "{suffix}_ppr" := .data[["stats.pts_ppr"]],
    "{suffix}_gp" := if ("stats.gp" %in% names(df)) .data[["stats.gp"]] else NA_real_
  )
}

cache_path <- file.path(SS$CACHE_DIR, "sleeper_history.rds")
if (!REFRESH && file.exists(cache_path)) { message("[cached] sleeper_history.rds"); quit(status = 0) }

grid <- expand.grid(season = SS$SEASONS, week = SS$MIN_WEEK:(SS$MAX_WEEK + 1L))
proj_rows <- list(); stat_rows <- list()
for (i in seq_len(nrow(grid))) {
  s <- grid$season[i]; w <- grid$week[i]
  p <- pull("projections", s, w); a <- pull("stats", s, w)
  if (!is.null(p)) proj_rows[[length(proj_rows) + 1]] <- rename_std(p, "proj")
  if (!is.null(a)) stat_rows[[length(stat_rows) + 1]] <- rename_std(a, "act")
  message(sprintf("  %d wk%02d  proj=%s act=%s", s, w,
                  if (is.null(p)) "-" else nrow(p), if (is.null(a)) "-" else nrow(a)))
  Sys.sleep(0.15)
}
proj <- bind_rows(proj_rows) %>% filter(position %in% SS$POSITIONS)
act  <- bind_rows(stat_rows) %>% filter(position %in% SS$POSITIONS) %>%
  select(season, week, sleeper_id, starts_with("act_"))

hist <- proj %>%
  left_join(act, by = c("season", "week", "sleeper_id")) %>%
  distinct(season, week, sleeper_id, .keep_all = TRUE)

saveRDS(hist, cache_path)
message(sprintf("\nwrote %d player-week rows (%d-%d) -> %s",
                nrow(hist), min(hist$season), max(hist$season), cache_path))
message(sprintf("  projection last_modified range: %s .. %s",
                as.character(as.POSIXct(min(hist$last_modified, na.rm = TRUE) / 1000, origin = "1970-01-01")),
                as.character(as.POSIXct(max(hist$last_modified, na.rm = TRUE) / 1000, origin = "1970-01-01"))))
