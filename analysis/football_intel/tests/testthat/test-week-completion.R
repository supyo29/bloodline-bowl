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

wc_base <- list(latest_week = 5L, week_state = "PARTIAL", games_completed_in_latest_week = 1L,
                games_scheduled_in_latest_week = 3L, latest_completed_game_date = "2024-10-03")
tp <- tibble::tibble(team = "KC", metric = "off_pass_epa", modeled = 0.1)
ftn <- tibble::tibble(team = "KC", metric = "man_rate", value = 0.4)

test_that("identical snapshot -> identical version", {
  v1 <- FI$compute_version(2024, 5, wc_base, tp, tp, tp, tp, ftn)
  v2 <- FI$compute_version(2024, 5, wc_base, tp, tp, tp, tp, ftn)
  expect_identical(v1, v2)
})

test_that("different completed-game count -> different version, even if every served table is identical", {
  wc2 <- wc_base; wc2$games_completed_in_latest_week <- 2L
  v1 <- FI$compute_version(2024, 5, wc_base, tp, tp, tp, tp, ftn)
  v2 <- FI$compute_version(2024, 5, wc2, tp, tp, tp, tp, ftn)
  expect_false(identical(v1, v2))
})

test_that("different served FTN descriptive content -> different version (the bug this fixes)", {
  ftn2 <- tibble::tibble(team = "KC", metric = "man_rate", value = 0.9)
  v1 <- FI$compute_version(2024, 5, wc_base, tp, tp, tp, tp, ftn)
  v2 <- FI$compute_version(2024, 5, wc_base, tp, tp, tp, tp, ftn2)
  expect_false(identical(v1, v2))
})

test_that("compute_version has no generated_at parameter at all -- a timestamp cannot leak into identity", {
  expect_false("generated_at" %in% names(formals(FI$compute_version)))
})

test_that("every week_completion semantic field is covered by the digest, not just the completed count", {
  replacements <- list(latest_week = 6L, week_state = "COMPLETE",
                       games_scheduled_in_latest_week = 999L, latest_completed_game_date = "2099-01-01")
  v0 <- FI$compute_version(2024, 5, wc_base, tp, tp, tp, tp, ftn)
  for (f in names(replacements)) {
    wc_mod <- wc_base
    wc_mod[[f]] <- replacements[[f]]
    v1 <- FI$compute_version(2024, 5, wc_mod, tp, tp, tp, tp, ftn)
    expect_false(identical(v0, v1), info = sprintf("changing %s did not change the version", f))
  }
})

test_that("generated_at-only difference does not change the version (it is not a digest input)", {
  # simulate two builds that differ only in wall-clock time by constructing
  # the full manifest twice and confirming the version field is identical
  # while generated_at, if present, would differ.
  v1 <- FI$compute_version(2024, 5, wc_base, tp, tp, tp, tp, ftn)
  Sys.sleep(0.01)
  v2 <- FI$compute_version(2024, 5, wc_base, tp, tp, tp, tp, ftn)
  expect_identical(v1, v2)
})
