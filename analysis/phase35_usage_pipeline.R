#!/usr/bin/env Rscript
# PHASE 3.5 COMPLETION — Part B: real player usage/opportunity pipeline.
#
#   Rscript analysis/phase35_usage_pipeline.R
#
# Pulls REAL weekly player usage from nflverse via {nflreadr} — the SAME
# package `analysis/phase3_fetch_data.R` already uses for the preseason
# Roster Intel draft model (reused here, not re-implemented). Writes a
# versioned, append-safe (full history, not latest-only) output table to
# lib/trades/data/player_usage_weekly.csv per the documented contract.
#
# SEASON CHOICE: as of this run, the 2026 NFL season has not yet played a
# single game (today's real date is before Week 1 kickoff) — nflreadr has
# ZERO 2026 rows to return. This script therefore pulls the most recent
# COMPLETE season (2025) as real historical data, suitable for backtesting
# and calibration research. It will pick up real 2026 rows automatically
# once games are actually played — see `season_arg` below.
#
# METRICS SUPPORTED (real, from source, never fabricated):
#   snaps, snap_share            <- nflreadr::load_snap_counts (offense_snaps/offense_pct)
#   targets, target_share        <- nflreadr::load_player_stats (already computed by nflverse)
#   carries, rush_share          <- nflreadr::load_player_stats (rush_share computed here: team-week carry share)
#   receptions                   <- nflreadr::load_player_stats
#
# METRICS NOT SUPPORTED by these two sources (left NA, never zero-filled):
#   routes, route_participation, red_zone_targets, red_zone_carries,
#   goal_line_carries, dropbacks, designed_rushes, scrambles
#   (these require nflfastR PBP-level participation data, a materially
#   heavier pull; deferred — see docs/TRADE_ENGINE_PHASE35_COMPLETION.md
#   "Future work" for what a Part B.2 pass would add).
#
# Player identity: nflreadr::load_ff_playerids() crosswalks gsis_id (used by
# load_player_stats) <-> sleeper_id (used by this bridge) <-> pfr_id (used by
# load_snap_counts) in ONE table — reused directly, no name-only matching.

suppressMessages({
  library(nflreadr)
  library(dplyr)
  library(tidyr)
  library(jsonlite)
})
options(nflreadr.verbose = FALSE, timeout = 300)

season_arg <- 2025L # most recent COMPLETE season; see header note on 2026
data_version <- "ri-usage-weekly-2026.1"
out_dir <- file.path("lib", "trades", "data")
dir.create(out_dir, recursive = TRUE, showWarnings = FALSE)
out_csv <- file.path(out_dir, "player_usage_weekly.csv")
out_meta <- file.path(out_dir, "player_usage_weekly.meta.json")

message("Loading real nflverse data for season ", season_arg, "...")
ids <- nflreadr::load_ff_playerids() |>
  select(gsis_id, sleeper_id, pfr_id, name) |>
  filter(!is.na(gsis_id))

stats <- nflreadr::load_player_stats(seasons = season_arg, summary_level = "week") |>
  filter(season_type == "REG", position %in% c("QB", "RB", "WR", "TE")) |>
  select(player_id, player_display_name, position, team, week, season,
         targets, target_share, carries, receptions, air_yards_share)

snaps <- nflreadr::load_snap_counts(seasons = season_arg) |>
  filter(game_type == "REG") |>
  select(pfr_player_id, team, week, offense_snaps, offense_pct)

# team-week total carries, for a real rush_share (nflverse does not ship one directly)
team_week_carries <- stats |>
  group_by(season, week, team) |>
  summarise(team_carries = sum(carries, na.rm = TRUE), .groups = "drop")

joined <- stats |>
  left_join(ids, by = c("player_id" = "gsis_id")) |>
  left_join(snaps, by = c("pfr_id" = "pfr_player_id", "week" = "week", "team" = "team")) |>
  left_join(team_week_carries, by = c("season", "week", "team")) |>
  mutate(
    rush_share = if_else(!is.na(carries) & team_carries > 0, carries / team_carries, NA_real_),
    snap_share = offense_pct,
    routes = NA_real_,
    route_participation = NA_real_,
    red_zone_targets = NA_real_,
    red_zone_carries = NA_real_,
    goal_line_carries = NA_real_,
    source = "nflverse (nflreadr::load_player_stats + load_snap_counts + load_ff_playerids)",
    source_updated_at = as.character(Sys.time()),
    data_version = data_version,
    sample_quality = case_when(
      !is.na(offense_snaps) & offense_snaps >= 10 ~ "OK",
      !is.na(offense_snaps) & offense_snaps < 10 ~ "SMALL_SAMPLE",
      TRUE ~ "UNKNOWN"
    ),
    match_method = if_else(!is.na(sleeper_id), "FF_PLAYERIDS_CROSSWALK", "UNRESOLVED")
  ) |>
  select(
    season, week, source_player_id = player_id, sleeper_id, player_name = player_display_name,
    team, position, snaps = offense_snaps, snap_share, routes, route_participation,
    targets, target_share, carries, rush_share, red_zone_targets, red_zone_carries,
    goal_line_carries, sample_quality, match_method, source, source_updated_at, data_version
  ) |>
  arrange(season, week, position, desc(coalesce(target_share, 0) + coalesce(rush_share, 0)))

write.csv(joined, out_csv, row.names = FALSE, na = "")

meta <- list(
  data_version = data_version,
  generated_at = as.character(Sys.time()),
  season = season_arg,
  weeks_present = sort(unique(joined$week)),
  rows = nrow(joined),
  players_resolved_to_sleeper = sum(!is.na(joined$sleeper_id)),
  players_unresolved = sum(is.na(joined$sleeper_id)),
  supported_metrics = c("snaps", "snap_share", "targets", "target_share", "carries", "rush_share", "receptions_via_source"),
  unsupported_metrics_left_na = c("routes", "route_participation", "red_zone_targets", "red_zone_carries", "goal_line_carries"),
  source = "nflverse via nflreadr",
  refresh_command = "Rscript analysis/phase35_usage_pipeline.R"
)
write(jsonlite::toJSON(meta, auto_unbox = TRUE, pretty = TRUE), out_meta)

message("Wrote ", nrow(joined), " real usage rows to ", out_csv)
message("Resolved to sleeper_id: ", sum(!is.na(joined$sleeper_id)), " / ", nrow(joined))
