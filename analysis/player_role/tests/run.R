#!/usr/bin/env Rscript
# Player Role & Opportunity Intelligence — Checkpoint B invariant tests.
#   Rscript analysis/player_role/tests/run.R
suppressMessages(library(testthat))
Sys.setenv(FI_ROOT = getwd())
root <- file.path(getwd(), "analysis", "player_role")
if (!dir.exists(file.path(root, "..", "football_intel", "cache"))) stop("run from repo root; cache missing (fetch_raw.R first)")
res <- test_dir(file.path(root, "tests", "testthat"), reporter = "summary", stop_on_failure = TRUE)
