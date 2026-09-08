# ===========================================================================
# Football Intelligence Engine — {targets} pipeline (Phase 3, spec §21).
#
#   Rscript -e 'targets::tar_make()'            # full weekly update
#   Rscript -e 'targets::tar_make(fi_snapshot)' # just re-publish the snapshot
#   Rscript -e 'targets::tar_visnetwork()'      # inspect the graph
#
# Unchanged upstream data does not recompute downstream (spec §21). The raw
# fetch is a manual step (network), invalidated with `--refresh`:
#   Rscript analysis/football_intel/fetch_raw.R --refresh
# then `tar_make()` rebuilds features -> profiles -> snapshot.
#
# This graph deliberately covers ONLY the Football Intelligence engine. The
# TypeScript projection/weekly/trade pipelines are unaffected (spec §32).
# ===========================================================================

library(targets)

tar_option_set(
  packages = c("dplyr", "tidyr", "stringr", "purrr", "jsonlite", "digest", "yaml"),
  format = "rds",
  seed = 20260907L
)

fi_dir <- "analysis/football_intel"
for (f in c("config.R", "lib_features.R", "lib_opponent_adj.R", "lib_priors.R",
            "lib_recency.R", "lib_continuity.R", "lib_profiles.R", "lib_usage.R",
            "lib_interactions.R")) source(file.path(fi_dir, f))

cache <- function(n) readRDS(file.path(FI$CACHE_DIR, paste0(n, ".rds")))

list(
  # ---- raw cache (produced by fetch_raw.R; tracked as file targets) -------
  tar_target(raw_pbp_file,        file.path(FI$CACHE_DIR, "pbp.rds"), format = "file"),
  tar_target(raw_part_file,       file.path(FI$CACHE_DIR, "participation.rds"), format = "file"),
  tar_target(raw_pfr_pass_file,   file.path(FI$CACHE_DIR, "pfr_pass.rds"), format = "file"),
  tar_target(raw_pfr_def_file,    file.path(FI$CACHE_DIR, "pfr_def.rds"), format = "file"),
  tar_target(raw_snap_file,       file.path(FI$CACHE_DIR, "snap_counts.rds"), format = "file"),
  tar_target(raw_sched_file,      file.path(FI$CACHE_DIR, "schedules.rds"), format = "file"),
  tar_target(raw_rosters_file,    file.path(FI$CACHE_DIR, "rosters_weekly.rds"), format = "file"),
  tar_target(raw_ids_file,        file.path(FI$CACHE_DIR, "ff_playerids.rds"), format = "file"),
  tar_target(raw_ftn_file,        file.path(FI$CACHE_DIR, "ftn_charting.rds"), format = "file"),
  tar_target(raw_avail_file,      file.path(FI$CACHE_DIR, "source_availability.rds"), format = "file"),

  tar_target(pbp,           readRDS(raw_pbp_file)),
  tar_target(participation, readRDS(raw_part_file)),
  tar_target(pfr_pass,      readRDS(raw_pfr_pass_file)),
  tar_target(pfr_def,       readRDS(raw_pfr_def_file)),
  tar_target(snap_counts,   readRDS(raw_snap_file)),
  tar_target(schedules,     readRDS(raw_sched_file)),
  tar_target(rosters_weekly,readRDS(raw_rosters_file)),
  tar_target(ff_playerids,  readRDS(raw_ids_file)),
  tar_target(ftn_charting,  readRDS(raw_ftn_file)),
  tar_target(source_availability, readRDS(raw_avail_file)),

  # ---- derived feature tables ------------------------------------------
  tar_target(team_game_features,
             build_team_game_features(pbp, participation, pfr_pass, pfr_def, FI)),
  tar_target(player_game_usage,
             build_player_game_usage(pbp, participation, snap_counts, ff_playerids, FI)),

  # ---- target (season, through_week): latest fully-available week -------
  tar_target(target_week, {
    sw <- pbp %>% dplyr::filter(season_type == "REG") %>%
      dplyr::group_by(season) %>% dplyr::summarise(mw = max(week), .groups = "drop")
    cur <- sw$mw[sw$season == FI$SEASON_CURRENT]
    if (length(cur) && is.finite(cur)) list(season = FI$SEASON_CURRENT, week = cur)
    else list(season = max(sw$season), week = sw$mw[sw$season == max(sw$season)])
  }),

  # ---- per-prior-season opponent-adjusted ratings ----------------------
  tar_target(prior_seasons, {
    s <- (target_week$season - FI$PRIOR_MAX_LOOKBACK):(target_week$season - 1)
    s[s >= min(FI$PBP_SEASONS)]
  }),
  tar_target(prior_ratings,
             dplyr::bind_rows(lapply(METRIC_SPECS, function(sp)
               season_ratings_for_metric(team_game_features, sp, FI, prior_seasons)))),

  # ---- continuity ------------------------------------------------------
  tar_target(discontinuity,
             build_discontinuity_table(target_week$season, schedules, pbp, snap_counts,
                                       rosters_weekly, FI$COORD_YAML, FI)),
  tar_target(prior_discounts, build_prior_discounts(discontinuity, FI)),

  # ---- profiles ------------------------------------------------------
  tar_target(team_profile,
             dplyr::bind_rows(lapply(METRIC_SPECS, function(sp)
               compute_metric_profile(team_game_features, sp, target_week$season, target_week$week,
                                      prior_ratings, prior_discounts, FI)))),
  tar_target(player_usage_profile,
             build_player_usage_profile(player_game_usage, ff_playerids, rosters_weekly,
                                        target_week$season, target_week$week, FI)),
  tar_target(unit_coverage_profile,
             build_coverage_allowed_profile(pbp, rosters_weekly, ff_playerids,
                                            target_week$season, target_week$week, prior_seasons, FI)),
  tar_target(contextual_matchup_feature,
             build_contextual_matchups(team_profile, unit_coverage_profile,
                                       target_week$season, target_week$week, FI)),
  tar_target(ftn_descriptive,
             build_ftn_descriptive(ftn_charting, pbp, target_week$season, target_week$week, FI)),

  # ---- publish (delegates to the script so serve artifacts stay identical) ----
  tar_target(fi_snapshot, {
    system2("Rscript", c("analysis/football_intel/build_snapshot.R",
                         target_week$season, target_week$week))
    readLines(file.path(FI$SERVE_DIR, "football_intelligence_manifest.json"))
  })
)
