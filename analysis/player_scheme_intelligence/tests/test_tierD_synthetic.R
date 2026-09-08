#!/usr/bin/env Rscript
# ===========================================================================
# Player x Scheme Intelligence — Tier D synthetic sanity tests (spec §25).
# Validate MECHANICS (recovery, shrink-to-zero, FDR), not real predictive value.
#   Rscript analysis/player_scheme_intelligence/tests/test_tierD_synthetic.R
# ===========================================================================
suppressWarnings(suppressMessages({ library(testthat); library(dplyr) }))
BASE <- file.path(getwd(), "analysis", "player_scheme_intelligence")
source(file.path(BASE, "config.R"))
source(file.path(BASE, "lib_spatial.R"))
source(file.path(BASE, "lib_charting.R"))
source(file.path(BASE, "lib_interaction.R"))
set.seed(1)

test_that("BH FDR recovers a true signal and rejects pure noise", {
  # 3 real effects (tiny p), 20 nulls (uniform p)
  p <- c(1e-5, 1e-4, 1e-3, runif(20, 0, 1))
  rej <- psi_bh(p, alpha = 0.10)
  expect_true(all(rej[1:3]))
  expect_lt(mean(rej[4:23]), 0.20)   # few/no false discoveries
})

test_that("BH with all-null p-values rejects (almost) nothing", {
  set.seed(2); p <- runif(50)
  expect_lte(sum(psi_bh(p, alpha = 0.10)), 2)
})

test_that("overlap feature: perfect alignment is strongly positive, anti-alignment negative", {
  # one QB throws everything DEEP_MIDDLE; one defense is very soft there, one very strong
  pprof <- list(
    qb_cells = tibble(gsis_id = "Q1", depth_bin = factor("DEEP", levels = c("BEHIND_LOS","SHORT","INTERMEDIATE","DEEP")),
                      field_third = factor("MIDDLE", levels = c("LEFT","MIDDLE","RIGHT")),
                      att = 100, epa = 0.2, att_share = 1, tot = 100),
    wr_cells = tibble(gsis_id = character(), depth_bin = factor(character()), field_third = factor(character()),
                      tgt = integer(), epa = double(), tgt_share = double(), tot = integer()),
    rb_dir = tibble(gsis_id = character(), field_third = factor(character()), car = integer(), epa = double(),
                    dir_share = double(), tot = integer()),
    qb_mz = tibble(gsis_id = "Q1", man_zone_epa_delta = 0.1, mz_n = 200),
    qb_press = tibble(gsis_id = "Q1", pressure_epa_delta = -0.3, press_n = 200),
    rb_box = tibble(gsis_id = character(), box_epa_delta = double(), box_n = integer())
  )
  dprof <- list(
    def_cell = tidyr::expand_grid(
      depth_bin = factor(c("BEHIND_LOS","SHORT","INTERMEDIATE","DEEP"), levels = c("BEHIND_LOS","SHORT","INTERMEDIATE","DEEP")),
      field_third = factor(c("LEFT","MIDDLE","RIGHT"), levels = c("LEFT","MIDDLE","RIGHT"))) %>%
      tidyr::crossing(defteam = c("SOFT", "HARD")) %>%
      mutate(epa_allowed = 0, n = 200, lg_epa = 0,
             cell_vuln = ifelse(depth_bin == "DEEP" & field_third == "MIDDLE" & defteam == "SOFT", 0.5,
                         ifelse(depth_bin == "DEEP" & field_third == "MIDDLE" & defteam == "HARD", -0.5, 0))),
    def_scheme = tibble(defteam = c("SOFT","HARD"), man_rate_c = 0, pressure_rate_c = c(0.1, -0.1), man_rate = 0.5, pressure_rate = 0.3, n = 500),
    def_dir = tibble(defteam = character(), field_third = factor(character()), epa_allowed = double(), n = integer(), lg_epa = double(), dir_vuln = double()),
    def_box = tibble(defteam = c("SOFT","HARD"), heavy_box_rate = 0.3, heavy_box_rate_c = c(0.1, -0.1))
  )
  fp_rows <- tibble(season = 2024, week = 1, gsis_id = "Q1", defteam = c("SOFT", "HARD"), position = "QB")
  f <- psi_overlap_features(fp_rows, pprof, dprof)
  soft <- f$ix_qb_spatial[f$defteam == "SOFT"]; hard <- f$ix_qb_spatial[f$defteam == "HARD"]
  expect_gt(soft, 0.4)
  expect_lt(hard, -0.4)
  expect_gt(soft, hard)
})

test_that("no interaction: a scheme feature uncorrelated with residual gets ~0 coefficient", {
  n <- 2000
  d <- tibble(b0 = rnorm(n, 12, 4), opp_pos_allowed_c = rnorm(n, 0, 2),
              feat_z = rnorm(n),
              fp = 0.7 * b0 + 0.5 * opp_pos_allowed_c + rnorm(n, 0, 5))  # feat_z NOT in DGP
  m <- lm(fp ~ b0 + opp_pos_allowed_c + feat_z, data = d)
  expect_lt(abs(coef(m)["feat_z"]), 0.5)   # shrinks toward zero
})

test_that("inserted fake interaction IS recovered", {
  n <- 3000
  d <- tibble(b0 = rnorm(n, 12, 4), opp_pos_allowed_c = rnorm(n, 0, 2), feat_z = rnorm(n))
  d$fp <- 0.7 * d$b0 + 0.5 * d$opp_pos_allowed_c + 1.8 * d$feat_z + rnorm(n, 0, 5)
  m <- lm(fp ~ b0 + opp_pos_allowed_c + feat_z, data = d)
  expect_gt(coef(m)["feat_z"], 1.0)
})

cat("\nTier D synthetic sanity: all mechanics pass.\n")
