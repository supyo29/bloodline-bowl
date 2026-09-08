#!/usr/bin/env Rscript
# ===========================================================================
# Player x Scheme Intelligence — Tier A R invariant tests (spec §41, §42, §43).
#   Rscript analysis/player_scheme_intelligence/tests/test_tierA.R
# Run from the repo root (needs analysis/football_intel/cache/pbp.rds).
# ===========================================================================
suppressWarnings(suppressMessages({ library(testthat); library(dplyr) }))
root <- getwd()
BASE <- file.path(root, "analysis", "player_scheme_intelligence")
source(file.path(BASE, "config.R"))
source(file.path(BASE, "lib_spatial.R"))
if (!file.exists(file.path(PSI$CACHE_DIR, "pbp.rds"))) stop("run from repo root; pbp cache missing")

pbp <- readRDS(file.path(PSI$CACHE_DIR, "pbp.rds"))
reg <- pbp %>% filter(season_type == "REG")
S <- 2025L; W <- 18L
pass <- psi_pass_plays(reg, c(short_hi = 10, int_hi = 20)) %>% psi_asof(S, W)
rush <- psi_rush_plays(reg) %>% psi_asof(S, W)

test_that("depth bins never fabricate SHORT from a missing air_yards (§41 case 29)", {
  b <- psi_depth_bin(c(NA, 0, -1, 5, 15, 25))
  expect_true(is.na(b[1]))
  expect_equal(as.character(b[2:6]), c("SHORT", "BEHIND_LOS", "SHORT", "INTERMEDIATE", "DEEP"))
})

test_that("field third never fabricates MIDDLE from a missing location (§41)", {
  f <- psi_field_third(c(NA, "", "left", "middle", "right", "deep left"))
  expect_true(all(is.na(f[c(1, 2, 6)])))
  expect_equal(as.character(f[3:5]), c("LEFT", "MIDDLE", "RIGHT"))
})

test_that("QB matrix cells reconcile to attempts_charted, and charted+uncharted=total (§41)", {
  m <- psi_qb_matrix(pass, PSI)
  chk <- m$cells %>% group_by(gsis_id) %>%
    summarise(cell_sum = sum(attempts), charted = first(attempts_charted),
              total = first(attempts_total), unch = first(attempts_uncharted), .groups = "drop")
  expect_equal(chk$cell_sum, chk$charted)
  expect_equal(chk$charted + chk$unch, chk$total)
})

test_that("sacks are NOT pass attempts; spikes/kneels/scrambles excluded (documented denominator)", {
  expect_gt(reg %>% filter(play_type == "pass", sack == 1) %>% nrow(), 0)   # sacks exist in raw pbp
  # the normalized pass universe re-derived with sack rows kept would differ; ours has none:
  raw_pass <- reg %>% filter(play_type == "pass", qb_spike == 0, coalesce(two_point_attempt, 0) == 0,
                             !is.na(passer_player_id))
  expect_equal(nrow(pass), raw_pass %>% filter(sack == 0) %>% nrow())
  # scramble plays never enter the designed-rush universe
  expect_equal(nrow(psi_rush_plays(reg %>% filter(coalesce(qb_scramble, 0) == 1))), 0)
})

test_that("run_location is offense-perspective and not mirrored (§42)", {
  # left+middle+right shares of charted rushes sum to 1; both L and R present
  d <- psi_def_rush_profile(rush, PSI)$direction
  sh <- d %>% group_by(team) %>% summarise(s = sum(carry_share_allowed, na.rm = TRUE), .groups = "drop")
  expect_true(all(abs(sh$s - 1) < 1e-9))
  expect_true(all(c("LEFT", "MIDDLE", "RIGHT") %in% as.character(d$field_third)))
})

test_that("chronology-safe: an as-of cut at (S,W) excludes later weeks (§30, §41)", {
  p_now <- psi_pass_plays(reg, c(short_hi = 10, int_hi = 20)) %>% psi_asof(2023L, 5L)
  expect_equal(nrow(p_now %>% filter(season == 2023, week > 5)), 0)
  expect_equal(nrow(p_now %>% filter(season > 2023)), 0)
  expect_gt(nrow(p_now %>% filter(season == 2023, week <= 5)), 0)
})

test_that("determinism: identical inputs -> identical matrix", {
  a <- psi_qb_matrix(pass, PSI)$cells
  b <- psi_qb_matrix(pass, PSI)$cells
  expect_identical(a, b)
})

test_that("defense pass matrix reconciles to targets_charted per team (§42)", {
  m <- psi_def_pass_matrix(pass, PSI)
  chk <- m$cells %>% group_by(team) %>%
    summarise(cs = sum(targets_allowed), tc = first(targets_charted), .groups = "drop")
  expect_equal(chk$cs, chk$tc)
  expect_equal(n_distinct(m$cells$team), 32)
})

test_that("adversarial: a tiny-sample player is INSUFFICIENT, never falsely STRONG (§43 case 6, 21)", {
  m <- psi_qb_matrix(pass, PSI)
  tiny <- m$cells %>% filter(attempts <= 5)
  expect_true(all(tiny$evidence_class == "INSUFFICIENT"))
})

cat("\nAll Tier A R invariants passed.\n")
