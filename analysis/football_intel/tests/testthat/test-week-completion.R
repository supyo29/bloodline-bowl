# Football Intelligence — partial-week completion invariants (daily refresh).
# Uses synthetic schedule fixtures (never live current-season data) so this
# is fast, deterministic, and independent of what's actually been played
# when the suite runs.

library(testthat)
if (!exists("FI", inherits = TRUE) || !is.function(FI$compute_week_completion)) {
  source(file.path(Sys.getenv("FI_ROOT", getwd()), "analysis", "football_intel", "config.R"))
}

test_that("a week with every game finished is COMPLETE", {
  sched <- tibble::tibble(
    season = 2024, game_type = "REG", week = 5,
    result = c(3L, -7L, 10L), gameday = c("2024-10-06", "2024-10-06", "2024-10-07")
  )
  wc <- FI$compute_week_completion(sched, 2024, 5)
  expect_equal(wc$week_state, "COMPLETE")
  expect_equal(wc$games_completed_in_latest_week, 3L)
  expect_equal(wc$games_scheduled_in_latest_week, 3L)
  expect_equal(wc$latest_completed_game_date, "2024-10-07")
})

test_that("a week with only some games finished is PARTIAL, never COMPLETE", {
  sched <- tibble::tibble(
    season = 2024, game_type = "REG", week = 5,
    result = c(3L, NA, NA), gameday = c("2024-10-03", "2024-10-06", "2024-10-06")
  )
  wc <- FI$compute_week_completion(sched, 2024, 5)
  expect_equal(wc$week_state, "PARTIAL")
  expect_equal(wc$games_completed_in_latest_week, 1L)
  expect_equal(wc$games_scheduled_in_latest_week, 3L)
  expect_equal(wc$latest_completed_game_date, "2024-10-03")
})

test_that("a week with zero games finished is PARTIAL with a NA completed-game date", {
  sched <- tibble::tibble(season = 2024, game_type = "REG", week = 5,
                          result = c(NA, NA), gameday = c("2024-10-06", "2024-10-06"))
  wc <- FI$compute_week_completion(sched, 2024, 5)
  expect_equal(wc$week_state, "PARTIAL")
  expect_equal(wc$games_completed_in_latest_week, 0L)
  expect_true(is.na(wc$latest_completed_game_date))
})

test_that("completed count can never exceed scheduled count by construction", {
  sched <- tibble::tibble(season = 2024, game_type = "REG", week = 5, result = c(1L, 2L, 3L, 4L),
                          gameday = rep("2024-10-06", 4))
  wc <- FI$compute_week_completion(sched, 2024, 5)
  expect_lte(wc$games_completed_in_latest_week, wc$games_scheduled_in_latest_week)
})

test_that("PARTIAL -> more completions -> COMPLETE is a real transition the function reflects", {
  base_day <- tibble::tibble(season = 2024, game_type = "REG", week = 5,
                             gameday = c("2024-10-06", "2024-10-06", "2024-10-07"))
  partial <- dplyr::bind_cols(base_day, result = c(3L, NA, NA))
  fuller  <- dplyr::bind_cols(base_day, result = c(3L, -7L, NA))
  complete <- dplyr::bind_cols(base_day, result = c(3L, -7L, 10L))
  wc1 <- FI$compute_week_completion(partial, 2024, 5)
  wc2 <- FI$compute_week_completion(fuller, 2024, 5)
  wc3 <- FI$compute_week_completion(complete, 2024, 5)
  expect_equal(c(wc1$week_state, wc2$week_state, wc3$week_state), c("PARTIAL", "PARTIAL", "COMPLETE"))
  expect_equal(c(wc1$games_completed_in_latest_week, wc2$games_completed_in_latest_week,
                 wc3$games_completed_in_latest_week), c(1L, 2L, 3L))
})

test_that("compute_version changes when games_completed_in_latest_week changes, even if the served tables happen to be identical", {
  tp <- tibble::tibble(team = "KC", metric = "off_pass_epa", modeled = 0.1)
  v1 <- FI$compute_version(2024, 5, 1L, tp, tp, tp, tp)
  v2 <- FI$compute_version(2024, 5, 2L, tp, tp, tp, tp)
  expect_false(identical(v1, v2))
  # sanity: identical inputs (including completed count) are deterministic
  v1b <- FI$compute_version(2024, 5, 1L, tp, tp, tp, tp)
  expect_identical(v1, v1b)
})
