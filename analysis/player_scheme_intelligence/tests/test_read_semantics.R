#!/usr/bin/env Rscript
# Numeric FTN read_thrown codes must stay neutral (UNVERIFIED_SOURCE_CONFLICT).
suppressWarnings(suppressMessages({ library(testthat); library(dplyr) }))
BASE <- file.path(getwd(), "analysis", "player_scheme_intelligence")
source(file.path(BASE, "config.R"))
source(file.path(BASE, "lib_spatial.R"))
source(file.path(BASE, "lib_charting.R"))

test_that("psi_read_bucket never produces ordinal read labels", {
  out <- psi_read_bucket(c("0", "1", "2", "CHK", "DES", "SD", " CHK", "3", NA))
  expect_equal(out, c("RAW_0", "RAW_1", "RAW_2", "CHECKDOWN", "DESIGNED",
                      "SCRAMBLE_DRILL", "OTHER", "OTHER", "OTHER"))
  expect_false(any(grepl("FIRST|SECOND|THIRD|PRE_SNAP", out)))
})
