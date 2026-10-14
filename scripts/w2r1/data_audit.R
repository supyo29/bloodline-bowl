# W2.R1 historical data audit: which nflverse sources exist per season, with row counts and the key fields the tactical layers need.
# Read-only (network GETs of public nflverse releases). Output: JSON on stdout. Exploratory/audit only: no modelling, no thresholds.
suppressMessages({ library(nflreadr); library(jsonlite) })
seasons <- 2020:2026
probe <- function(name, f, ...) {
  out <- list()
  for (s in seasons) {
    r <- tryCatch({ d <- suppressWarnings(suppressMessages(f(s, ...))); list(rows = nrow(d), cols = ncol(d), max_week = if ("week" %in% names(d)) suppressWarnings(max(d$week, na.rm = TRUE)) else NA) }, error = function(e) list(rows = 0L, error = substr(conditionMessage(e), 1, 80)))
    out[[as.character(s)]] <- r
  }
  out
}
res <- list(
  player_stats = probe("player_stats", function(s) load_player_stats(s, summary_level = "week")),
  schedules    = probe("schedules", function(s) load_schedules(s)),
  injuries     = probe("injuries", function(s) load_injuries(s)),
  depth_charts = probe("depth_charts", function(s) load_depth_charts(s)),
  snap_counts  = probe("snap_counts", function(s) load_snap_counts(s)),
  participation= probe("participation", function(s) load_participation(s)),
  ftn_charting = probe("ftn_charting", function(s) load_ftn_charting(s)),
  nextgen_pass = probe("nextgen_pass", function(s) load_nextgen_stats(s, "passing")),
  team_stats   = probe("team_stats", function(s) load_team_stats(s, summary_level = "week")),
  pbp          = probe("pbp", function(s) { d <- load_pbp(s); d })
)
# which tactical fields exist in the most recent complete pbp season
p <- tryCatch(load_pbp(2025), error = function(e) NULL)
if (!is.null(p)) {
  want <- c("offense_formation","offense_personnel","defenders_in_box","defense_personnel","number_of_pass_rushers","was_pressure","pass_location","air_yards","play_action","qb_scramble","run_gap","run_location","wp","vegas_wp","spread_line","total_line","roof","surface","temp","wind","field_goal_result","kick_distance","fumble_forced","sack","interception","safety","penalty","drive","xpass","pass_oe","cp","epa","route","defense_man_zone_type","defense_coverage_type","time_to_throw","n_offense_backfield","ngs_air_yards","was_no_huddle","shotgun")
  res$pbp_fields_2025 <- list(present = intersect(want, names(p)), absent = setdiff(want, names(p)), rows = nrow(p))
}
cat(toJSON(res, auto_unbox = TRUE, na = "null", pretty = TRUE))
