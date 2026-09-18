#!/usr/bin/env Rscript
# ===========================================================================
# Injury -> Opportunity Propagation Intelligence -- Checkpoint B build entry
# point.
#
#   Rscript analysis/opportunity_propagation/run_build.R
#
# Reads ONLY existing caches (Phase 1's analysis/football_intel/cache/*.rds,
# Phase 2's analysis/player_role/cache/player_game_role.rds) -- fetches
# nothing new. Writes the internal (git-ignored) event substrate to
# analysis/opportunity_propagation/cache/. No lib/<...>/data serve
# directory yet -- Checkpoint B is internal-only (spec §34).
# ===========================================================================

suppressWarnings(suppressMessages({ library(dplyr) }))

.here <- sub("^--file=", "", grep("^--file=", commandArgs(FALSE), value = TRUE))
.opp_dir <- if (nzchar(.here)) dirname(.here) else file.path(getwd(), "analysis", "opportunity_propagation")
source(file.path(.opp_dir, "config.R"))                        # defines OPP, ROLE, FI
source(file.path(.opp_dir, "lib_absence_detection.R"))
source(file.path(.opp_dir, "lib_fast_baselines.R"))
source(file.path(.opp_dir, "lib_redistribution_observed.R"))
source(file.path(.opp_dir, "build_absence_events.R"))

t0 <- Sys.time()
cat("Loading caches ...\n")
player_game_role <- readRDS(file.path(ROLE$CACHE_DIR, "player_game_role.rds"))
rosters_weekly   <- readRDS(file.path(FI$CACHE_DIR, "rosters_weekly.rds"))
schedules        <- readRDS(file.path(FI$CACHE_DIR, "schedules.rds"))
t_load <- Sys.time()

cat("Building absence-event substrate (full history) ...\n")
res <- build_absence_events(player_game_role, rosters_weekly, schedules, OPP, ROLE, FI)
t_build <- Sys.time()

season_min <- min(res$absence_events$season)
season_max <- max(res$absence_events$season)
version_id <- OPP$compute_version(season_min, season_max, res$absence_events)

saveRDS(res$absence_events, file.path(OPP$CACHE_DIR, "absence_events.rds"))
saveRDS(res$beneficiary_observations, file.path(OPP$CACHE_DIR, "beneficiary_observations.rds"))
saveRDS(res$domain_accounting, file.path(OPP$CACHE_DIR, "domain_accounting.rds"))
saveRDS(res$excluded, file.path(OPP$CACHE_DIR, "excluded_candidates.rds"))
saveRDS(res$no_meaningful_role, file.path(OPP$CACHE_DIR, "no_meaningful_role_candidates.rds"))
saveRDS(res$roster_lookup, file.path(OPP$CACHE_DIR, "roster_lookup.rds"))
t_save <- Sys.time()

n_events <- length(unique(res$absence_events$absence_event_id))
cat("\n--- Checkpoint B build report ---\n")
cat(sprintf("season universe        : %d-%d\n", season_min, season_max))
cat(sprintf("candidates_total       : %d\n", res$candidates_total))
cat(sprintf("qualified events       : %d\n", n_events))
cat(sprintf("no_meaningful_role     : %d\n", nrow(res$no_meaningful_role)))
cat(sprintf("excluded               : %d\n", nrow(res$excluded)))
cat("\nexclusion reasons:\n")
print(table(res$excluded$reason))
cat(sprintf("\nbeneficiary_observations rows: %d\n", nrow(res$beneficiary_observations)))
cat(sprintf("domain_accounting rows       : %d\n", nrow(res$domain_accounting)))
cat(sprintf("\nload time  : %.1fs\n", as.numeric(difftime(t_load, t0, units = "secs"))))
cat(sprintf("build time : %.1fs\n", as.numeric(difftime(t_build, t_load, units = "secs"))))
cat(sprintf("save time  : %.1fs\n", as.numeric(difftime(t_save, t_build, units = "secs"))))
cat(sprintf("opportunity_propagation_version: %s\n", version_id))
cat("\nCheckpoint B build complete.\n")
