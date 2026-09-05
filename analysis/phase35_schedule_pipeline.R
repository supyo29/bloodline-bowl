#!/usr/bin/env Rscript
# PHASE 3.5 COMPLETION — Part C: real schedule-strength pipeline.
#
#   Rscript analysis/phase35_schedule_pipeline.R
#
# Produces LEAGUE-AGNOSTIC raw matchup-strength features
# (team x opponent x position x week) — per §24 of the completion spec, this
# script does NOT know about Bloodline Bowl's playoff window, bye weeks, or
# season length; the bridge (TypeScript) combines these raw rows with
# league-specific settings later.
#
# METHODOLOGY (documented, not a black box): points-allowed-by-position,
# normalized to a 0..1 percentile across all 32 teams for that week — i.e.
# "how generous was this defense to this position, relative to the rest of
# the league, that week." This is the SIMPLER proxy §21 explicitly permits
# when a stronger source isn't available — no adjusted-EPA-allowed or
# DVOA-equivalent metric is computed here; that would need a heavier
# possession-level model than this pass builds. Documented as a real
# limitation, not hidden.
#
# Orientation (fixed, documented): matchup_score in [-1, +1], POSITIVE =
# EASIER / more favorable for the offensive player's position that week
# (the defense allowed more fantasy production to that position than
# average), NEGATIVE = HARDER.
#
# SEASON CHOICE: same as the usage pipeline — 2025 is the most recent
# COMPLETE season; 2026 has zero played games as of this run.

suppressMessages({
  library(nflreadr)
  library(dplyr)
  library(tidyr)
  library(jsonlite)
})
options(nflreadr.verbose = FALSE, timeout = 300)

season_arg <- 2025L
data_version <- "ri-schedule-weekly-2026.1"
out_dir <- file.path("lib", "trades", "data")
dir.create(out_dir, recursive = TRUE, showWarnings = FALSE)
out_csv <- file.path(out_dir, "player_schedule_strength_weekly.csv")
out_meta <- file.path(out_dir, "player_schedule_strength_weekly.meta.json")

message("Loading real nflverse data for season ", season_arg, "...")
stats <- nflreadr::load_player_stats(seasons = season_arg, summary_level = "week") |>
  filter(season_type == "REG", position %in% c("QB", "RB", "WR", "TE"))

sched <- nflreadr::load_schedules(seasons = season_arg) |>
  filter(game_type == "REG") |>
  select(week, home_team, away_team)

# points allowed BY the defense TO each position, per week (real, from source — no fabricated adjustment)
pts_allowed <- stats |>
  group_by(season, week, position, opponent_team) |>
  summarise(points_allowed = sum(fantasy_points_ppr, na.rm = TRUE), .groups = "drop") |>
  rename(defense_team = opponent_team)

# percentile across the 32 teams for that week+position -> [-1, +1], positive = easier matchup
pts_allowed <- pts_allowed |>
  group_by(season, week, position) |>
  mutate(
    matchup_percentile = percent_rank(points_allowed),
    matchup_score = round(2 * matchup_percentile - 1, 4) # rescale 0..1 -> -1..+1
  ) |>
  ungroup()

# expand to team x opponent x position x week rows using the real schedule (both home and away sides)
home_side <- sched |> transmute(week, team = home_team, opponent = away_team)
away_side <- sched |> transmute(week, team = away_team, opponent = home_team)
matchups <- bind_rows(home_side, away_side)

joined <- matchups |>
  crossing(position = c("QB", "RB", "WR", "TE")) |>
  left_join(pts_allowed, by = c("opponent" = "defense_team", "week" = "week", "position" = "position")) |>
  mutate(
    season = season_arg,
    source = "nflverse (nflreadr::load_player_stats fantasy_points_ppr allowed-by-position, percentile-normalized) + nflreadr::load_schedules",
    source_updated_at = as.character(Sys.time()),
    data_version = data_version,
    freshness = if_else(!is.na(matchup_score), "CURRENT", "UNAVAILABLE")
  ) |>
  select(season, week, team, opponent, position, matchup_score, matchup_percentile, source, source_updated_at, data_version, freshness) |>
  arrange(season, week, team, position)

write.csv(joined, out_csv, row.names = FALSE, na = "")

meta <- list(
  data_version = data_version,
  generated_at = as.character(Sys.time()),
  season = season_arg,
  weeks_present = sort(unique(joined$week)),
  rows = nrow(joined),
  rows_resolved = sum(!is.na(joined$matchup_score)),
  methodology = "points-allowed-by-position, percentile-normalized across the week's 32 teams, rescaled to [-1, +1]",
  orientation = "positive = easier/favorable matchup for the offensive position, negative = harder",
  limitations = c(
    "raw points-allowed proxy, not an EPA-adjusted or DVOA-equivalent defensive metric",
    "K/DST not modeled — QB/RB/WR/TE only",
    "does not account for injuries to the opposing defense"
  ),
  league_agnostic = TRUE,
  note = "TypeScript combines these raw team+opponent+position+week rows with league-specific playoff windows, bye weeks, and season length — this table intentionally has no league settings baked in (Phase 3.5 completion spec §24).",
  source = "nflverse via nflreadr",
  refresh_command = "Rscript analysis/phase35_schedule_pipeline.R"
)
write(jsonlite::toJSON(meta, auto_unbox = TRUE, pretty = TRUE), out_meta)

message("Wrote ", nrow(joined), " real schedule-strength rows to ", out_csv)
message("Resolved matchup_score: ", sum(!is.na(joined$matchup_score)), " / ", nrow(joined))
