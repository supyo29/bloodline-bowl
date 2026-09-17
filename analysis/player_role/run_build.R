#!/usr/bin/env Rscript
# ===========================================================================
# Player Role & Opportunity Intelligence -- Checkpoint B build entry point.
#
#   Rscript analysis/player_role/run_build.R [season] [through_week]
#
# Reads ONLY the existing Football Intelligence raw cache (analysis/
# football_intel/cache/*.rds) -- does not re-fetch nflverse data. Builds the
# full-history internal player-game substrate, writes it to
# analysis/player_role/cache/player_game_role.rds (git-ignored, internal),
# and serves a small current/recent-week CSV + manifest under
# lib/player-role-intelligence/data/ for TS/analysis consumption.
# ===========================================================================

suppressWarnings(suppressMessages({ library(dplyr); library(jsonlite) }))

.here <- sub("^--file=", "", grep("^--file=", commandArgs(FALSE), value = TRUE))
.role_dir <- if (nzchar(.here)) dirname(.here) else file.path(getwd(), "analysis", "player_role")
source(file.path(.role_dir, "config.R"))              # defines ROLE, FI
source(file.path(.role_dir, "build_player_game.R"))    # defines build_player_game_role()

args <- commandArgs(TRUE)
season <- if (length(args) >= 1) as.integer(args[1]) else ROLE$SEASON_CURRENT
through_week <- if (length(args) >= 2) as.integer(args[2]) else NA_integer_

t0 <- Sys.time()
cat("Loading raw caches ...\n")
pbp            <- readRDS(file.path(FI$CACHE_DIR, "pbp.rds"))
participation  <- readRDS(file.path(FI$CACHE_DIR, "participation.rds"))
snap_counts    <- readRDS(file.path(FI$CACHE_DIR, "snap_counts.rds"))
ff_playerids   <- readRDS(file.path(FI$CACHE_DIR, "ff_playerids.rds"))
rosters_weekly <- readRDS(file.path(FI$CACHE_DIR, "rosters_weekly.rds"))
schedules      <- readRDS(file.path(FI$CACHE_DIR, "schedules.rds"))
t_load <- Sys.time()

cat("Building player-game role substrate (full history, all cached seasons) ...\n")
player_game_role <- build_player_game_role(pbp, participation, snap_counts, ff_playerids,
                                           rosters_weekly, schedules, ROLE, FI)
conflicting_team_rows <- attr(player_game_role, "conflicting_team_rows")
t_build <- Sys.time()

internal_path <- file.path(ROLE$CACHE_DIR, "player_game_role.rds")
saveRDS(player_game_role, internal_path)
write.csv(conflicting_team_rows, file.path(ROLE$CACHE_DIR, "conflicting_team_rows_audit.csv"), row.names = FALSE)
t_save <- Sys.time()

# ---- data-quality diagnostics (reported at Checkpoint B, not asserted blind)
n_rows <- nrow(player_game_role)
dup_keys <- player_game_role %>% count(season, week, game_id, gsis_id) %>% filter(n > 1)
unresolved_ids <- player_game_role %>% filter(is.na(gsis_id) | gsis_id == "")
missing_position <- player_game_role %>% filter(is.na(position))
missing_opponent <- player_game_role %>% filter(is.na(opponent))

missingness <- tibble::tibble(
  feature_family = c("SNAPS", "ROUTES", "TARGETS", "AIR_YARDS", "RUSHING", "RED_ZONE",
                     "THIRD_DOWN", "TWO_MINUTE", "RETURNS", "POSITION", "OPPONENT"),
  n_missing = c(
    sum(is.na(player_game_role$offensive_snaps)),
    sum(is.na(player_game_role$route_participation)),
    0L,  # targets zero-filled by construction where a row exists
    sum(is.na(player_game_role$air_yards_share)),
    0L,
    sum(is.na(player_game_role$rz_target_share) & is.na(player_game_role$rz_carry_share)),
    0L,
    0L,
    0L,
    nrow(missing_position),
    nrow(missing_opponent)
  ),
  pct_missing = round(100 * n_missing / n_rows, 2)
)

cat("\n--- Checkpoint B build report ---\n")
cat(sprintf("season universe   : %d-%d\n", min(player_game_role$season), max(player_game_role$season)))
cat(sprintf("player-game rows  : %d\n", n_rows))
cat(sprintf("duplicate keys    : %d (post-resolution; must be 0)\n", nrow(dup_keys)))
cat(sprintf("resolved team-conflicts (evidence-based, reported not hidden): %d rows across %d player-games\n",
           nrow(conflicting_team_rows), length(unique(paste(conflicting_team_rows$season, conflicting_team_rows$week, conflicting_team_rows$game_id, conflicting_team_rows$gsis_id)))))
cat(sprintf("unresolved gsis_id: %d\n", nrow(unresolved_ids)))
cat(sprintf("missing position  : %d (%.2f%%)\n", nrow(missing_position), 100 * nrow(missing_position) / n_rows))
cat(sprintf("missing opponent  : %d (%.2f%%)\n", nrow(missing_opponent), 100 * nrow(missing_opponent) / n_rows))
cat("\nmissingness by feature family:\n")
print(missingness)

cat(sprintf("\nload time  : %.1fs\n", as.numeric(difftime(t_load, t0, units = "secs"))))
cat(sprintf("build time : %.1fs\n", as.numeric(difftime(t_build, t_load, units = "secs"))))
cat(sprintf("save time  : %.1fs\n", as.numeric(difftime(t_save, t_build, units = "secs"))))
cat(sprintf("internal artifact: %s (%.1f MB)\n", internal_path, file.size(internal_path) / 1e6))

# ---- served artifact: current season only, all weeks built so far (small
# enough to commit; the full multi-season history stays internal per spec
# §21's "internal vs served" guidance). ------------------------------------
served <- player_game_role %>% filter(season == !!season)
if (!is.na(through_week)) served <- served %>% filter(week <= through_week)
served_through_week <- max(served$week, na.rm = TRUE)

served_csv_path <- file.path(ROLE$SERVE_DIR, "player_game_role.csv")
write.csv(served, served_csv_path, row.names = FALSE, na = "")

source_availability <- readRDS(file.path(FI$CACHE_DIR, "source_availability.rds"))
week_completion <- FI$compute_week_completion(schedules, season, served_through_week)

# Status vocabulary matches Phase 1's own EXPECTED_SOURCE_LAG /
# BROKEN_OR_MISSING_DATA classification (analysis/football_intel/
# validate_snapshot.R) -- Checkpoint B deliberately does not invent a
# parallel freshness vocabulary (spec §14, §20's "integrate into Phase 1's
# existing freshness/availability terminology").
feature_family_availability <- function(family, source_name) {
  rows <- source_availability %>% filter(source == source_name, season == !!season)
  if (nrow(rows) == 0) {
    status <- if (source_name %in% FI$EXPECTED_SOURCES) "AVAILABLE_WITH_LAG" else "UNAVAILABLE"
    return(list(family = family, source = source_name, status = status, through_week = NA_integer_))
  }
  list(family = family, source = source_name, status = "AVAILABLE_CURRENT", through_week = max(rows$week))
}

manifest <- list(
  role_opportunity_schema_version = ROLE$SCHEMA_VERSION,
  season = season,
  through_week = served_through_week,
  generated_at = format(Sys.time(), "%Y-%m-%dT%H:%M:%S%z", tz = "UTC"),
  week_completion = week_completion,
  feature_family_availability = list(
    feature_family_availability("SNAPS", "snap_counts"),
    feature_family_availability("ROUTES", "participation"),
    feature_family_availability("TARGETS", "pbp"),
    feature_family_availability("AIR_YARDS", "pbp"),
    feature_family_availability("RUSHING", "pbp"),
    feature_family_availability("RED_ZONE", "pbp"),
    feature_family_availability("THIRD_DOWN", "pbp"),
    feature_family_availability("TWO_MINUTE", "pbp"),
    list(family = "RETURNS", source = "pbp", status = "AVAILABLE_CURRENT", through_week = served_through_week),
    list(family = "ALIGNMENT", source = NA, status = "UNAVAILABLE", through_week = NA),
    list(family = "MOTION_PLAYER_LEVEL", source = NA, status = "UNAVAILABLE", through_week = NA),
    list(family = "PASS_BLOCKING", source = NA, status = "UNAVAILABLE", through_week = NA),
    list(family = "RUN_BLOCKING", source = NA, status = "UNAVAILABLE", through_week = NA)
  ),
  field_ownership = list(
    offensive_snaps = "SOURCE_NATIVE", snap_share_source = "SOURCE_NATIVE", snap_share_derived = "DERIVED",
    targets = "DERIVED", target_share = "DERIVED", receptions = "DERIVED",
    air_yards = "DERIVED", air_yards_share = "DERIVED", aDOT = "DERIVED",
    carries = "DERIVED", rush_share = "DERIVED",
    position_group_rush_share = "DERIVED", position_group_target_share = "DERIVED",
    pass_play_personnel = "DERIVED", route_participation = "DERIVED",
    red_zone_targets = "DERIVED", red_zone_carries = "DERIVED", inside_10_targets = "DERIVED",
    inside_10_carries = "DERIVED", goal_line_carries = "DERIVED", end_zone_targets = "DERIVED",
    third_down_targets = "DERIVED", third_down_carries = "DERIVED",
    two_minute_targets = "DERIVED", two_minute_carries = "DERIVED",
    kick_returns = "SOURCE_NATIVE", kick_return_yards = "SOURCE_NATIVE",
    punt_returns = "SOURCE_NATIVE", punt_return_yards = "SOURCE_NATIVE",
    kick_return_opportunity_share = "DERIVED", punt_return_opportunity_share = "DERIVED",
    slot_alignment = "UNAVAILABLE", wide_alignment = "UNAVAILABLE", backfield_alignment = "UNAVAILABLE",
    motion = "UNAVAILABLE", pass_blocking = "UNAVAILABLE", run_blocking = "UNAVAILABLE"
  ),
  data_quality = list(
    player_game_rows_full_history = n_rows,
    served_rows = nrow(served),
    duplicate_keys = nrow(dup_keys),
    unresolved_gsis_id = nrow(unresolved_ids)
  ),
  internal_artifact = "analysis/player_role/cache/player_game_role.rds (git-ignored; full multi-season history)",
  served_artifact = "lib/player-role-intelligence/data/player_game_role.csv (current season only)",
  production_numeric_influence = "PROHIBITED",
  notes = "Checkpoint B substrate. No role classification, no shrinkage/recency model, no fantasy points. Evidence only."
)
manifest$role_opportunity_version <- ROLE$compute_version(season, served_through_week, served)

manifest_path <- file.path(ROLE$SERVE_DIR, "role_opportunity_manifest.json")
write(jsonlite::toJSON(manifest, auto_unbox = TRUE, pretty = TRUE, na = "null"), manifest_path)

cat(sprintf("\nserved artifact: %s (%d rows, %.2f MB)\n", served_csv_path, nrow(served), file.size(served_csv_path) / 1e6))
cat(sprintf("manifest: %s\n", manifest_path))
cat(sprintf("role_opportunity_version: %s\n", manifest$role_opportunity_version))
cat("\nCheckpoint B build complete.\n")
