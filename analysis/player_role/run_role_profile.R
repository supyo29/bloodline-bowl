#!/usr/bin/env Rscript
# ===========================================================================
# Player Role & Opportunity Intelligence — Checkpoint C role-profile build.
#
#   Rscript analysis/player_role/run_role_profile.R [season] [week]
#
# Builds a PlayerRoleProfile for every player with a player-game row at
# (season, week), using their full available history (all prior seasons +
# current season through that week) for latest/recent/season/prior. Internal
# diagnostic artifact only -- Checkpoint D owns the served reader.
# ===========================================================================
suppressWarnings(suppressMessages({ library(dplyr); library(jsonlite) }))

BASE <- file.path(getwd(), "analysis", "player_role")
source(file.path(BASE, "config.R"))
source(file.path(BASE, "lib_role_profile.R"))
source(file.path(BASE, "lib_role_domains.R"))

args <- commandArgs(TRUE)
season <- if (length(args) >= 1) as.integer(args[1]) else ROLE$SEASON_CURRENT
week <- if (length(args) >= 2) as.integer(args[2]) else 1L

pgr <- readRDS(file.path(ROLE$CACHE_DIR, "player_game_role.rds"))
active_ids <- pgr %>% filter(season == !!season, week == !!week) %>% pull(gsis_id) %>% unique()
cat(sprintf("Building role profiles for %d players active in season %d week %d ...\n", length(active_ids), season, week))

t0 <- Sys.time()
profiles <- vector("list", length(active_ids))
for (i in seq_along(active_ids)) {
  ph <- pgr %>% filter(gsis_id == active_ids[i])
  profiles[[i]] <- build_role_profile(ph, season, week, ROLE)
}
profiles <- Filter(Negate(is.null), profiles)
t1 <- Sys.time()
cat(sprintf("Built %d profiles in %.1fs\n", length(profiles), as.numeric(difftime(t1, t0, units = "secs"))))

events <- purrr::map(profiles, extract_change_events) %>% purrr::flatten()
cat(sprintf("Extracted %d structured change events (non-STABLE/UNCERTAIN)\n", length(events)))

out_path <- file.path(ROLE$CACHE_DIR, sprintf("role_profiles_%d_w%02d.rds", season, week))
saveRDS(list(profiles = profiles, events = events), out_path)
cat(sprintf("Saved: %s\n", out_path))
