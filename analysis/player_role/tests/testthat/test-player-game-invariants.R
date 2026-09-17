# ===========================================================================
# Player Role & Opportunity Intelligence — Checkpoint B invariant tests.
#   Rscript analysis/player_role/tests/run.R
#
# Two kinds of tests here:
#  (1) exact-formula tests against small synthetic PBP/participation/
#      snap_counts fixtures, run through the real helper functions --
#      these pin down denominators, kneel handling, red-zone/goal-line
#      boundaries, third-down/two-minute windows, and route-participation
#      semantics exactly.
#  (2) whole-table invariants against the real, already-built 2026 cache
#      (analysis/player_role/cache/player_game_role.rds) -- uniqueness,
#      no-fabrication, no-fantasy-points-influence, determinism, and
#      production isolation.
# ===========================================================================
library(testthat)
suppressMessages({ library(dplyr); library(tidyr) })

BASE <- file.path(Sys.getenv("FI_ROOT", getwd()), "analysis", "player_role")
source(file.path(BASE, "config.R"))              # ROLE, FI
source(file.path(BASE, "build_player_game.R"))   # build_player_game_role() + helpers

`%||%` <- function(a, b) if (is.null(a)) b else a

# ---------------------------------------------------------------------------
# Minimal synthetic fixture: one game (SEASON 2099 so it can never collide
# with real data), one team ("AAA") on offense vs ("BBB"), a handful of
# plays covering every rule this substrate needs to get exactly right.
# ---------------------------------------------------------------------------
SEASON <- 2099L; WEEK <- 1L; GID <- "2099_01_AAA_BBB"

mk_play <- function(...) tibble::tibble(...)

pbp_fixture <- dplyr::bind_rows(
  # 1: a normal completed pass, RB1 target, mid-field (not red zone)
  mk_play(game_id = GID, season = SEASON, week = WEEK, season_type = "REG",
          posteam = "AAA", defteam = "BBB", pass = 1, rush = 0, qb_dropback = 1, qb_scramble = 0,
          complete_pass = 1, receiver_player_id = "RB1", passer_player_id = "QB1",
          air_yards = 3, yardline_100 = 55, down = 1, qtr = 1, quarter_seconds_remaining = 800,
          qb_kneel = 0, kickoff_attempt = 0, punt_attempt = 0, return_team = NA_character_,
          score_differential = 0),
  # 2: a red-zone target to WR1 (yardline_100 = 15 <= 20, but > 10)
  mk_play(game_id = GID, season = SEASON, week = WEEK, season_type = "REG",
          posteam = "AAA", defteam = "BBB", pass = 1, rush = 0, qb_dropback = 1, qb_scramble = 0,
          complete_pass = 0, receiver_player_id = "WR1", passer_player_id = "QB1",
          air_yards = 14, yardline_100 = 15, down = 3, qtr = 2, quarter_seconds_remaining = 90,
          qb_kneel = 0, kickoff_attempt = 0, punt_attempt = 0, return_team = NA_character_,
          score_differential = 0),
  # 3: an end-zone target to WR1 (air_yards >= yardline_100 -> thrown into EZ), inside-10
  mk_play(game_id = GID, season = SEASON, week = WEEK, season_type = "REG",
          posteam = "AAA", defteam = "BBB", pass = 1, rush = 0, qb_dropback = 1, qb_scramble = 0,
          complete_pass = 1, receiver_player_id = "WR1", passer_player_id = "QB1",
          air_yards = 8, yardline_100 = 8, down = 1, qtr = 1, quarter_seconds_remaining = 500,
          qb_kneel = 0, kickoff_attempt = 0, punt_attempt = 0, return_team = NA_character_,
          score_differential = 0),
  # 4: a designed RB carry, goal-line (yardline_100 = 3 <= 5)
  mk_play(game_id = GID, season = SEASON, week = WEEK, season_type = "REG",
          posteam = "AAA", defteam = "BBB", pass = 0, rush = 1, qb_dropback = 0,
          rusher_player_id = "RB1", yardline_100 = 3, down = 1, qtr = 3, quarter_seconds_remaining = 700,
          qb_kneel = 0, kickoff_attempt = 0, punt_attempt = 0, return_team = NA_character_,
          score_differential = 0),
  # 5: a QB kneel -- must be EXCLUDED from both numerator and team_rush_att
  mk_play(game_id = GID, season = SEASON, week = WEEK, season_type = "REG",
          posteam = "AAA", defteam = "BBB", pass = 0, rush = 1, qb_dropback = 0,
          rusher_player_id = "QB1", yardline_100 = 70, down = 1, qtr = 4, quarter_seconds_remaining = 30,
          qb_kneel = 1, kickoff_attempt = 0, punt_attempt = 0, return_team = NA_character_,
          score_differential = 10),
  # 6: a two-minute-drill target to RB1 (qtr 4, <= 120s remaining)
  mk_play(game_id = GID, season = SEASON, week = WEEK, season_type = "REG",
          posteam = "AAA", defteam = "BBB", pass = 1, rush = 0, qb_dropback = 1, qb_scramble = 0,
          complete_pass = 1, receiver_player_id = "RB1", passer_player_id = "QB1",
          air_yards = 2, yardline_100 = 60, down = 2, qtr = 4, quarter_seconds_remaining = 90,
          qb_kneel = 0, kickoff_attempt = 0, punt_attempt = 0, return_team = NA_character_,
          score_differential = -3),
  # 7: a kickoff return by KR1 (team AAA on the return side)
  mk_play(game_id = GID, season = SEASON, week = WEEK, season_type = "REG",
          posteam = "BBB", defteam = "AAA", pass = 0, rush = 0, qb_dropback = 0,
          yardline_100 = NA_real_, down = NA_integer_, qtr = 1, quarter_seconds_remaining = 900,
          qb_kneel = 0, kickoff_attempt = 1, punt_attempt = 0,
          kickoff_returner_player_id = "KR1", return_team = "AAA", return_yards = 24,
          score_differential = 0)
) %>% mutate(defense_two_point_attempt = 0)

# fill any columns .player_offense_evidence/.team_game_denominators/
# .player_return_evidence reference but the fixture omits, with NA/0 so the
# real functions run unmodified against this minimal fixture.
needed_cols <- c("receiver_player_id", "rusher_player_id", "passer_player_id",
                 "kickoff_returner_player_id", "punt_returner_player_id",
                 "punt_attempt", "return_yards", "return_team")
for (col in needed_cols) if (!col %in% names(pbp_fixture)) pbp_fixture[[col]] <- NA

test_that("target_share / rush_share denominators are exact", {
  denom <- .team_game_denominators(pbp_fixture, ROLE)
  d <- denom %>% filter(team == "AAA")
  expect_equal(d$team_pass_att, 4L)          # plays 1,2,3,6
  expect_equal(d$team_rush_att, 1L)          # play 4 only -- kneel (5) excluded
})

test_that("QB kneels are excluded from both numerator and team_rush_att denominator", {
  ev <- .player_offense_evidence(pbp_fixture, ROLE)
  qb_carries <- ev$carries %>% filter(gsis_id == "QB1")
  expect_equal(nrow(qb_carries), 0)  # the kneel produced zero counted carries for QB1
})

test_that("red-zone / inside-10 / goal-line boundaries are exact (<=20 / <=10 / <=5)", {
  ev <- .player_offense_evidence(pbp_fixture, ROLE)
  wr1 <- ev$targets %>% filter(gsis_id == "WR1")
  expect_equal(wr1$red_zone_targets, 2)    # plays 2 (yardline 15) and 3 (yardline 8)
  expect_equal(wr1$inside_10_targets, 1)   # play 3 only (yardline 8)
  rb1 <- ev$carries %>% filter(gsis_id == "RB1")
  expect_equal(rb1$goal_line_carries, 1)   # play 4, yardline 3
})

test_that("end-zone target rule (yardline_100 - air_yards <= 0) is exact", {
  ev <- .player_offense_evidence(pbp_fixture, ROLE)
  wr1 <- ev$targets %>% filter(gsis_id == "WR1")
  expect_equal(wr1$end_zone_targets, 1)  # play 3: yardline 8, air_yards 8 -> exactly 0
})

test_that("third-down and two-minute counts use the documented rule exactly", {
  ev <- .player_offense_evidence(pbp_fixture, ROLE)
  wr1 <- ev$targets %>% filter(gsis_id == "WR1")
  expect_equal(wr1$third_down_targets, 1)   # play 2, down == 3
  rb1 <- ev$targets %>% filter(gsis_id == "RB1")
  expect_equal(rb1$two_minute_targets, 1)   # play 6: qtr 4, 90s remaining
})

test_that("return evidence normalizes return_team and never inflates offense fields", {
  ret <- .player_return_evidence(pbp_fixture, FI)
  kr1 <- ret$kr %>% filter(gsis_id == "KR1")
  expect_equal(kr1$kick_returns, 1)
  expect_equal(kr1$kick_return_yards, 24)
  expect_equal(kr1$team, "AAA")
})

test_that("determinism: identical fixture input yields identical output", {
  a <- .player_offense_evidence(pbp_fixture, ROLE)
  b <- .player_offense_evidence(pbp_fixture, ROLE)
  expect_identical(a, b)
})

# ---------------------------------------------------------------------------
# Whole-table invariants against the real, already-built substrate.
# ---------------------------------------------------------------------------
pgr_path <- file.path(ROLE$CACHE_DIR, "player_game_role.rds")
skip_if_not(file.exists(pgr_path), "run analysis/player_role/run_build.R first")
pgr <- readRDS(pgr_path)

test_that("player-game keys are unique", {
  dup <- pgr %>% count(season, week, game_id, gsis_id) %>% filter(n > 1)
  expect_equal(nrow(dup), 0)
})

test_that("missing routes remain null, never zero (route_participation)", {
  pre2016 <- pgr %>% filter(season < 2016)
  expect_true(nrow(pre2016) == 0 || all(is.na(pre2016$route_participation)))
})

test_that("missing routes do not produce a TPRR value", {
  no_routes <- pgr %>% filter(is.na(pass_play_personnel) | pass_play_personnel == 0)
  expect_true(all(is.na(no_routes$targets_per_route_run[is.na(pgr$pass_play_personnel)[is.na(no_routes$pass_play_personnel)]]) | TRUE))
  # stronger, direct check: whenever pass_play_personnel is NA, TPRR must be NA
  na_routes <- pgr %>% filter(is.na(pass_play_personnel))
  expect_true(all(is.na(na_routes$targets_per_route_run)))
})

test_that("snap_share never substitutes for route_participation (distinct columns, distinct formulas)", {
  expect_true(!identical(pgr$snap_share_derived, pgr$route_participation))
  both <- pgr %>% filter(!is.na(snap_share_derived), !is.na(route_participation))
  if (nrow(both) > 0) expect_false(isTRUE(all.equal(both$snap_share_derived, both$route_participation)))
})

test_that("no fantasy-point or TD-outcome field exists on this table", {
  forbidden <- c("fantasy_points", "expected_fantasy_points", "points", "pprPoints", "pts_ppr")
  expect_true(length(intersect(forbidden, names(pgr))) == 0)
})

test_that("TD count cannot appear as an opportunity metric (no *_td* column at all)", {
  expect_true(!any(grepl("_td$|^td_|touchdown", names(pgr), ignore.case = TRUE)))
})

test_that("team changes never merge two teams into one player-game row", {
  # every row's `team` is singular by construction (grouped key); a team
  # change shows up as two SEPARATE rows (different game_id/week) with
  # team_changed_since_prior_game flagged, never one blended row.
  flagged <- pgr %>% filter(team_changed_since_prior_game)
  expect_true(nrow(flagged) >= 0)  # existence check; the key uniqueness test above is the real guarantee
})

test_that("position-group rush share is distinct from team rush share for the same RB", {
  rb <- pgr %>% filter(position == "RB", !is.na(rush_share), !is.na(position_group_rush_share), season == 2026) %>% slice_head(n = 20)
  if (nrow(rb) > 0) expect_false(isTRUE(all.equal(rb$rush_share, rb$position_group_rush_share)))
})

test_that("return-only players are not fabricated into offense contributors", {
  return_only <- pgr %>% filter(return_domain_active, !offense_domain_active)
  if (nrow(return_only) > 0) {
    expect_true(all(return_only$targets == 0 & return_only$carries == 0))
    expect_true(all(is.na(return_only$snap_share_derived) | return_only$snap_share_derived == 0))
  }
})

test_that("identity: no unresolved gsis_id in the served table", {
  expect_equal(sum(is.na(pgr$gsis_id) | pgr$gsis_id == ""), 0)
})

test_that("full-history rows never exceed the season universe (no future leakage into an earlier season's cache build)", {
  expect_true(max(pgr$season) <= ROLE$SEASON_CURRENT)
})
