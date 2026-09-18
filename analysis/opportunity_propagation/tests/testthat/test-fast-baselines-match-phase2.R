# ===========================================================================
# Injury -> Opportunity Propagation Intelligence -- Checkpoint B.
# Cross-check (spec §38): the fast vectorized baseline re-expression in
# lib_fast_baselines.R must produce EXACTLY the same recent/season/
# n_games_season/opportunity_total values Phase 2's own dimension_series()
# produces, both for real participation rows and for real historical
# absence-candidate gap weeks (baseline_asof()). No tolerance beyond
# floating-point epsilon is allowed -- any divergence here means Phase 3 is
# silently re-deriving Phase 2's model instead of reusing it (spec §3),
# which this test exists specifically to catch.
# ===========================================================================
library(testthat)
suppressMessages({ library(dplyr) })

`%||%` <- function(a, b) if (is.null(a) || is.na(a)) b else a

BASE <- file.path(Sys.getenv("FI_ROOT", getwd()), "analysis", "opportunity_propagation")
source(file.path(BASE, "config.R"))
source(file.path(BASE, "lib_absence_detection.R"))
source(file.path(BASE, "lib_fast_baselines.R"))

pgr <- readRDS(file.path(ROLE$CACHE_DIR, "player_game_role.rds"))
rosters <- readRDS(file.path(FI$CACHE_DIR, "rosters_weekly.rds"))
schedules <- readRDS(file.path(FI$CACHE_DIR, "schedules.rds"))

DIMS <- list(
  c("snap_share_derived", "offensive_snaps"),
  c("rush_share", "carries"),
  c("position_group_rush_share", "carries"),
  c("target_share", "targets"),
  c("position_group_target_share", "targets"),
  c("air_yards_share", "targets"),
  c("rz_carry_share", "red_zone_carries"),
  c("rz_target_share", "red_zone_targets"),
  c("kick_return_opportunity_share", "kick_returns"),
  c("punt_return_opportunity_share", "punt_returns")
)

test_that("fast_dimension_series matches dimension_series exactly on real participation rows", {
  set.seed(101)
  sample_ids <- sample(unique(pgr$gsis_id), 120)
  n_checked <- 0
  for (gid in sample_ids) {
    ph <- pgr %>% filter(gsis_id == gid) %>% arrange(season, week)
    if (nrow(ph) < 3) next
    for (dc in DIMS) {
      fs <- fast_dimension_series(ph, dc[1], dc[2])
      idxs <- sample(2:nrow(ph), min(3, nrow(ph) - 1))
      for (i in idxs) {
        real <- dimension_series(ph, dc[1], dc[2], ph$season[i], ph$week[i])
        n_checked <- n_checked + 1
        expect_equal(is.na(real$recent), is.na(fs$recent[i]), label = paste(gid, dc[1], i, "recent-NA"))
        if (!is.na(real$recent)) expect_equal(real$recent, fs$recent[i], tolerance = 1e-9, label = paste(gid, dc[1], i, "recent"))
        expect_equal(is.na(real$season), is.na(fs$season_baseline[i]), label = paste(gid, dc[1], i, "season-NA"))
        if (!is.na(real$season)) expect_equal(real$season, fs$season_baseline[i], tolerance = 1e-9, label = paste(gid, dc[1], i, "season"))
        expect_equal(real$n_games_season, fs$n_games_season[i], label = paste(gid, dc[1], i, "n_games"))
        expect_equal(real$opportunity_total %||% 0, fs$opportunity_total[i], tolerance = 1e-9, label = paste(gid, dc[1], i, "opp_total"))
      }
    }
  }
  expect_gt(n_checked, 500)  # sanity: the sample actually exercised enough real data
})

test_that("baseline_asof matches dimension_series exactly on real historical GAP weeks (absence candidates)", {
  cal <- build_team_game_calendar(schedules)
  roster_lookup <- build_roster_lookup(rosters)
  cand <- detect_candidate_events(pgr, roster_lookup, cal, OPP$ABSENT_PLAYER_POSITIONS)
  cand2 <- attach_last_known_team(cand, pgr)
  qual <- cand2 %>% filter(status %in% OPP$ROSTER_CONFIRMED_NONPARTICIPATION_STATUSES,
                           team == last_known_team, !is.na(last_known_team))
  expect_gt(nrow(qual), 100)  # sanity: real gap-week candidates exist to test against

  set.seed(202)
  sample_events <- qual[sample(nrow(qual), min(150, nrow(qual))), ]
  n_checked <- 0
  for (i in seq_len(nrow(sample_events))) {
    ev <- sample_events[i, ]
    ph <- pgr %>% filter(gsis_id == ev$gsis_id) %>% arrange(season, week)
    if (nrow(ph) == 0) next
    for (dc in DIMS[1:4]) {
      fs <- fast_dimension_series(ph, dc[1], dc[2])
      b <- baseline_asof(fs, ev$season, ev$week)
      real <- dimension_series(ph, dc[1], dc[2], ev$season, ev$week)
      n_checked <- n_checked + 1
      expect_equal(is.na(real$recent), is.na(b$recent), label = paste(ev$gsis_id, dc[1], "recent-NA"))
      if (!is.na(real$recent)) expect_equal(real$recent, b$recent, tolerance = 1e-9, label = paste(ev$gsis_id, dc[1], "recent"))
      expect_equal(real$n_games_season, b$n_games_season, label = paste(ev$gsis_id, dc[1], "n_games"))
    }
  }
  expect_gt(n_checked, 200)
})
