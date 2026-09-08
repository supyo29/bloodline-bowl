#!/usr/bin/env Rscript
# Football Intelligence — R invariant test runner (spec §35).
#   Rscript analysis/football_intel/tests/run.R
suppressMessages(library(testthat))
Sys.setenv(FI_ROOT = getwd())
root <- file.path(getwd(), "analysis", "football_intel")
if (!dir.exists(file.path(root, "cache"))) stop("run from repo root; cache missing (fetch_raw.R first)")
res <- test_dir(file.path(root, "tests", "testthat"), reporter = "summary", stop_on_failure = TRUE)
