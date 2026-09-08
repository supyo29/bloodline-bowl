# ===========================================================================
# Football Intelligence — statistical invariant tests (spec §30, §35, §36).
#
#   Rscript analysis/football_intel/tests/run.R
#
# These MUST FAIL if the engine violates a documented statistical guarantee.
# They do not read the network — they operate on the local cache + synthetic
# fixtures.
# ===========================================================================

library(testthat)

`%||%` <- function(a, b) if (is.null(a)) b else a
BASE <- file.path(Sys.getenv("FI_ROOT", getwd()), "analysis", "football_intel")
for (f in c("config.R", "lib_features.R", "lib_opponent_adj.R", "lib_priors.R",
            "lib_recency.R", "lib_profiles.R")) source(file.path(BASE, f))

cache <- function(n) readRDS(file.path(FI$CACHE_DIR, paste0(n, ".rds")))
tgf <- readRDS(file.path(FI$CACHE_DIR, "team_game_features.rds")) %>% dplyr::filter(season_type == "REG")
SP <- Filter(function(s) s$key == "off_pass_epa", METRIC_SPECS)[[1]]

# --------------------------------------------------------------------------
test_that("determinism: identical inputs -> byte-identical ratings", {
  a <- season_ratings_for_metric(tgf, SP, FI, 2023)
  b <- season_ratings_for_metric(tgf, SP, FI, 2023)
  expect_identical(a, b)
})

test_that("opponent adjustment is monotone: adding to a team's y raises its off rating", {
  g <- tgf %>% dplyr::filter(side == "offense", season == 2024) %>%
    dplyr::transmute(team, opponent, y = pass_epa, w = n_pass)
  base <- opponent_adjust_metric(g, ridge = FI$OPP_ADJ_RIDGE_LAMBDA, min_w = 1)
  bumped <- g; bumped$y[bumped$team == "KC"] <- bumped$y[bumped$team == "KC"] + 0.3
  fit2 <- opponent_adjust_metric(bumped, ridge = FI$OPP_ADJ_RIDGE_LAMBDA, min_w = 1)
  expect_gt(fit2$off[["KC"]], base$off[["KC"]])
  # other teams barely move
  others <- setdiff(names(base$off), "KC")
  expect_lt(max(abs(fit2$off[others] - base$off[others])), 0.05)
})

test_that("no look-ahead: through-week-W rating ignores weeks > W", {
  full  <- current_rating_for_metric(tgf, SP, 2024, 17, FI)
  early <- current_rating_for_metric(tgf, SP, 2024, 8, FI)
  # recompute "through 8" after DELETING weeks 9..17 from the input entirely
  tgf_trunc <- tgf %>% dplyr::filter(!(season == 2024 & week > 8))
  early2 <- current_rating_for_metric(tgf_trunc, SP, 2024, 8, FI)
  expect_equal(early$current_dev, early2$current_dev, tolerance = 1e-10)
  expect_false(isTRUE(all.equal(early$current_dev, full$current_dev)))
})

test_that("league-average synthetic team shrinks toward 0 (league mean)", {
  sh <- shrink_to(obs = 0.0, eff_n = 300, prior = 0.0, prior_eff = 300, league_mu = 0, k = 200)
  expect_lt(abs(sh$estimate), 1e-9)
})

test_that("zero current-season games -> prior-driven, high shrink-to-league when no prior", {
  none <- shrink_to(obs = NA, eff_n = 0, prior = NA, prior_eff = 0, league_mu = 0, k = 200)
  expect_equal(none$estimate, 0)
  expect_equal(none$recent_weight, 0)
  prior_only <- shrink_to(obs = NA, eff_n = 0, prior = 0.2, prior_eff = 400, league_mu = 0, k = 200)
  expect_gt(prior_only$prior_weight, prior_only$recent_weight)
  expect_gt(prior_only$estimate, 0)         # moves toward the prior
  expect_lt(prior_only$estimate, 0.2)       # but shrunk toward league mean
})

test_that("large current sample -> prior contribution diminishes", {
  small <- shrink_to(0.3, eff_n = 40,   prior = 0.0, prior_eff = 400, league_mu = 0, k = 200)
  large <- shrink_to(0.3, eff_n = 4000, prior = 0.0, prior_eff = 400, league_mu = 0, k = 200)
  expect_gt(large$recent_weight, small$recent_weight)
  expect_lt(large$prior_weight, small$prior_weight)
  expect_gt(large$estimate, small$estimate)   # less pulled to the 0 prior
})

test_that("one extreme game cannot move the recency estimate by more than the cap", {
  vals <- c(0.1, 0.05, 0.12, 0.08, 0.09)
  wa <- 4:0
  psd <- 0.15
  base <- recency_estimate(vals, wa, FI$RECENCY_HALFLIFE_GAMES, psd, FI$RECENCY_SINGLE_GAME_CAP_SD)
  spike <- recency_estimate(c(vals[1:4], 3.0), wa, FI$RECENCY_HALFLIFE_GAMES, psd, FI$RECENCY_SINGLE_GAME_CAP_SD)
  expect_lt(abs(spike$estimate - base$estimate), FI$RECENCY_SINGLE_GAME_CAP_SD * psd + 1e-9)
})

test_that("more effective sample never lowers the confidence bucket (all else equal)", {
  thr <- FI$CONF_THRESHOLDS$epa_metric
  lo  <- confidence_bucket(80,  thr, se = 0.01, discrim = 0.05)
  hi  <- confidence_bucket(800, thr, se = 0.01, discrim = 0.05)
  rank <- c(INSUFFICIENT_SAMPLE = 0, LOW = 1, MEDIUM = 2, HIGH = 3)
  expect_gte(rank[[hi]], rank[[lo]])
})

test_that("confidence: a genuinely league-average team with a tight SE stays confident", {
  thr <- FI$CONF_THRESHOLDS$epa_metric
  expect_equal(confidence_bucket(600, thr, se = 0.01, discrim = 0.06), "HIGH")
})

test_that("trend deadband: recent == current -> stable/uncertain, never a direction", {
  tr <- trend_signal(0.1, 0.1, recent_eff_n = 5, pooled_sd = 0.15, FI)
  expect_true(tr$direction %in% c("stable", "uncertain"))
})

test_that("discontinuity discounts are multiplicative and bounded (0,1]", {
  dt <- tibble::tibble(team = "X", side = "offense", head_coach_change = TRUE,
                       starting_qb_change = TRUE, offensive_coord_change = TRUE,
                       defensive_coord_change = NA, ol_continuity = 0.4,
                       front_turnover = NA_real_, secondary_turnover = NA_real_)
  d <- build_prior_discounts(dt, FI)
  expect_lte(d$prior_discount, 1)
  expect_gt(d$prior_discount, 0)
  # exactly the product of the active factors
  f <- FI$DISCONTINUITY_FACTOR
  expect_equal(d$prior_discount,
               f$head_coach_change * f$offensive_coord_change * f$starting_qb_change * f$ol_continuity_low,
               tolerance = 1e-9)
})

test_that("unknown continuity applies NO discount", {
  dt <- tibble::tibble(team = "X", side = "defense", head_coach_change = NA,
                       starting_qb_change = NA, offensive_coord_change = NA,
                       defensive_coord_change = NA, ol_continuity = NA_real_,
                       front_turnover = NA_real_, secondary_turnover = NA_real_)
  expect_equal(build_prior_discounts(dt, FI)$prior_discount, 1)
})

test_that("FTN / man-zone are never tagged as model inputs", {
  # config guardrail: FTN metrics not present in METRIC_SPECS (the model input set)
  keys <- vapply(METRIC_SPECS, function(s) s$key, character(1))
  expect_false(any(grepl("ftn|play_action|screen|rpo|motion", keys)))
  expect_true(FI$predictive_status("def_blitz_rate") %in% c("DESCRIPTIVE_TENDENCY", "UNVALIDATED"))
})
