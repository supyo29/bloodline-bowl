#!/usr/bin/env Rscript
# ===========================================================================
# Football Intelligence — reproducible raw data fetch (spec §21 step 1, §22).
#
#   Rscript analysis/football_intel/fetch_raw.R [--refresh]
#
# Pulls every raw source from the nflverse (via {nflreadr}) and caches to
# analysis/football_intel/cache/*.rds (git-ignored). Downstream targets read
# ONLY the cache. Records, per source, the (season, week) rows actually
# present so build_features.R can honor real historical availability
# (spec guardrail 2 — participation/FTN lag).
#
# No API keys. No scraping. Every source is a versioned public dataset.
# ===========================================================================

suppressWarnings(suppressMessages({
  library(nflreadr); library(dplyr); library(tidyr)
}))
options(nflreadr.verbose = FALSE, timeout = 900)

.here <- sub("^--file=", "", grep("^--file=", commandArgs(FALSE), value = TRUE))
source(file.path(dirname(.here), "config.R"))

REFRESH <- "--refresh" %in% commandArgs(TRUE)

cache <- function(name, expr) {
  path <- file.path(FI$CACHE_DIR, paste0(name, ".rds"))
  if (!REFRESH && file.exists(path)) { cat(sprintf("  [cached] %-28s\n", name)); return(readRDS(path)) }
  cat(sprintf("  [fetch ] %-28s ...\n", name)); flush.console()
  val <- force(expr)
  saveRDS(val, path)
  val
}

availability <- function(df, label) {
  if (is.null(df) || !all(c("season", "week") %in% names(df))) return(NULL)
  df %>% distinct(season, week) %>% mutate(source = label)
}

cat("Football Intelligence raw fetch  (refresh =", REFRESH, ")\n\n")

# --- schedules / games (context: spread, total, roof, coaches, rest) -------
schedules <- cache("schedules", {
  nflreadr::load_schedules(seasons = min(FI$PBP_SEASONS):FI$SEASON_CURRENT) %>%
    filter(game_type %in% c("REG", "POST")) %>%
    mutate(home_team = FI$normalize_team(home_team),
           away_team = FI$normalize_team(away_team))
})

# --- play-by-play (the backbone) -----------------------------------------
pbp <- cache("pbp", {
  d <- nflreadr::load_pbp(seasons = FI$PBP_SEASONS)
  d %>% mutate(posteam = FI$normalize_team(posteam),
              defteam = FI$normalize_team(defteam),
              home_team = FI$normalize_team(home_team),
              away_team = FI$normalize_team(away_team))
})

# --- participation (formation / personnel / box / route / man-zone / pressure)
participation <- cache("participation", {
  bind_rows(lapply(FI$PARTICIPATION_SEASONS, function(s) {
    d <- tryCatch(nflreadr::load_participation(seasons = s), error = function(e) NULL)
    if (is.null(d)) { cat("    participation", s, "UNAVAILABLE\n"); return(NULL) }
    d
  }))
})

# --- Next Gen Stats (weekly, player) -------------------------------------
ngs_passing <- cache("ngs_passing", nflreadr::load_nextgen_stats(seasons = FI$NGS_SEASONS, stat_type = "passing"))
ngs_rushing <- cache("ngs_rushing", nflreadr::load_nextgen_stats(seasons = FI$NGS_SEASONS, stat_type = "rushing"))
ngs_receiving <- cache("ngs_receiving", nflreadr::load_nextgen_stats(seasons = FI$NGS_SEASONS, stat_type = "receiving"))

# --- PFR advanced (weekly): pressure, YBC/YAC, coverage-allowed ----------
pfr_pass <- cache("pfr_pass", nflreadr::load_pfr_advstats(seasons = FI$PFR_SEASONS, stat_type = "pass", summary_level = "week"))
pfr_rush <- cache("pfr_rush", nflreadr::load_pfr_advstats(seasons = FI$PFR_SEASONS, stat_type = "rush", summary_level = "week"))
pfr_rec  <- cache("pfr_rec",  nflreadr::load_pfr_advstats(seasons = FI$PFR_SEASONS, stat_type = "rec",  summary_level = "week"))
pfr_def  <- cache("pfr_def",  nflreadr::load_pfr_advstats(seasons = FI$PFR_SEASONS, stat_type = "def",  summary_level = "week"))

# --- snap counts (player-game) ------------------------------------------
snap_counts <- cache("snap_counts", {
  bind_rows(lapply(FI$PBP_SEASONS, function(s) {
    d <- tryCatch(nflreadr::load_snap_counts(seasons = s), error = function(e) NULL)
    if (is.null(d)) return(NULL)
    d %>% mutate(team = FI$normalize_team(team), opponent = FI$normalize_team(opponent))
  }))
})

# --- weekly rosters (personnel continuity) ------------------------------
rosters_weekly <- cache("rosters_weekly", {
  bind_rows(lapply(FI$PBP_SEASONS, function(s) {
    d <- tryCatch(nflreadr::load_rosters_weekly(seasons = s), error = function(e) NULL)
    if (is.null(d)) return(NULL)
    keep <- intersect(c("season","week","team","position","depth_chart_position","status",
                        "full_name","gsis_id","sleeper_id","pfr_id","espn_id","years_exp"), names(d))
    d %>% select(all_of(keep)) %>% mutate(team = FI$normalize_team(team))
  }))
})

# --- player identity crosswalk ----------------------------------------
ff_playerids <- cache("ff_playerids", {
  nflreadr::load_ff_playerids() %>%
    select(any_of(c("gsis_id","sleeper_id","pfr_id","espn_id","yahoo_id","name","position","team")))
})

# --- FTN charting — DESCRIPTIVE_ONLY (never a model input) --------------
ftn_charting <- cache("ftn_charting", {
  bind_rows(lapply(FI$FTN_SEASONS, function(s) {
    d <- tryCatch(nflreadr::load_ftn_charting(seasons = s), error = function(e) NULL)
    if (is.null(d)) return(NULL)
    d
  }))
})

# --- record actual (season, week) availability per source -------------
avail <- bind_rows(
  availability(mutate(pbp, season = season, week = week), "pbp"),
  availability(participation %>% left_join(distinct(pbp, nflverse_game_id = game_id, season, week), by = "nflverse_game_id"), "participation"),
  availability(ngs_passing, "ngs_passing"),
  availability(ngs_rushing, "ngs_rushing"),
  availability(ngs_receiving, "ngs_receiving"),
  availability(pfr_pass, "pfr_pass"),
  availability(pfr_def, "pfr_def"),
  availability(snap_counts, "snap_counts"),
  availability(ftn_charting, "ftn_charting")
) %>% filter(!is.na(week))
saveRDS(avail, file.path(FI$CACHE_DIR, "source_availability.rds"))

cat("\nSummary:\n")
cat(sprintf("  pbp                %d plays  seasons %d-%d\n", nrow(pbp), min(pbp$season), max(pbp$season)))
cat(sprintf("  participation      %d plays\n", nrow(participation)))
cat(sprintf("  ngs (p/r/rec)      %d / %d / %d\n", nrow(ngs_passing), nrow(ngs_rushing), nrow(ngs_receiving)))
cat(sprintf("  pfr (p/r/rec/def)  %d / %d / %d / %d\n", nrow(pfr_pass), nrow(pfr_rush), nrow(pfr_rec), nrow(pfr_def)))
cat(sprintf("  snap_counts        %d\n", nrow(snap_counts)))
cat(sprintf("  rosters_weekly     %d\n", nrow(rosters_weekly)))
cat(sprintf("  ftn_charting       %d  (DESCRIPTIVE_ONLY)\n", nrow(ftn_charting)))
cat(sprintf("  ff_playerids       %d\n", nrow(ff_playerids)))
cat(sprintf("  source_availability %d (season,week,source) rows\n", nrow(avail)))
cat("\nRaw fetch complete -> analysis/football_intel/cache/\n")
