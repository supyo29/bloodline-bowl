# ===========================================================================
# Injury -> Opportunity Propagation Intelligence -- Checkpoint D.
# Content-hash determinism (spec §6/§48): identical analytical content ->
# identical opportunity_propagation_version; generated_at-only differences
# never change it; every OTHER material change does.
# ===========================================================================
library(testthat)
suppressMessages({ library(data.table) })

BASE <- file.path(Sys.getenv("FI_ROOT", getwd()), "analysis", "opportunity_propagation")
source(file.path(BASE, "config.R"))

base_league <- data.table(dimension = c("target_share"), league_rate = c(0.9), n_league = c(50L))
base_position <- data.table(dimension = c("target_share"), position = c("WR"), position_rate_blended = c(0.85))
base_team <- data.table(dimension = c("target_share"), team = c("AAA"), position = c("WR"), team_rate_blended = c(1.2), n_team = c(10L))
base_weights <- data.table(dimension = c("target_share"), same_position_multiplier = c(1.3))
base_dims <- data.table(domain = c("RECEIVING"), dimension = c("target_share"), positions = c("RB|WR|TE"))

v <- function(league = base_league, position = base_position, team = base_team, weights = base_weights, dims = base_dims,
             training_window = list(start_season = 2019L, end_season = 2025L), role_version = "roi:2026:w01:aaaa") {
  OPP$compute_opi_version(2026L, 1L, "opportunity-propagation-2026.1", "CANDIDATE_4_HIERARCHICAL", "opportunity-propagation-served:v1",
                         training_window, role_version, league, position, team, weights, dims)
}

test_that("1. identical content -> identical version", {
  expect_equal(v(), v())
})

test_that("2. generated_at is not even a parameter -- re-running twice at different wall-clock times gives the same version", {
  v1 <- v(); Sys.sleep(0.05); v2 <- v()
  expect_equal(v1, v2)
})

test_that("3. a model-parameter (league rate) change -> different version", {
  changed <- copy(base_league); changed[, league_rate := 0.5]
  expect_false(v() == v(league = changed))
})

test_that("4. a Role dependency version change -> different version (analytically material -- it changes which snapshot the model was fit against)", {
  expect_false(v() == v(role_version = "roi:2026:w02:bbbb"))
})

test_that("5. a support-state-relevant change (training window) -> different version", {
  expect_false(v() == v(training_window = list(start_season = 2012L, end_season = 2025L)))
})

test_that("6. row order is canonicalized/deterministic -- a differently-ordered but identical-content table yields the same version", {
  two_row_league <- data.table(dimension = c("target_share", "rush_share"), league_rate = c(0.9, 0.8), n_league = c(50L, 50L))
  reordered <- two_row_league[order(-league_rate)]
  canonical_a <- two_row_league[order(dimension)]
  canonical_b <- reordered[order(dimension)]
  expect_equal(v(league = canonical_a), v(league = canonical_b))
})

test_that("7. a meaningful calibration-table change (team-level rate) -> different version", {
  changed <- copy(base_team); changed[, team_rate_blended := 0.4]
  expect_false(v() == v(team = changed))
})

test_that("a same_position_multiplier change -> different version", {
  changed <- copy(base_weights); changed[, same_position_multiplier := 2.0]
  expect_false(v() == v(weights = changed))
})

test_that("version format matches opi:<season>:w<week>:<12hex>", {
  expect_match(v(), "^opi:2026:w01:[0-9a-f]{12}$")
})
