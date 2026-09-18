#!/usr/bin/env Rscript
# Injury -> Opportunity Propagation Intelligence -- Checkpoint B tests.
#   Rscript analysis/opportunity_propagation/tests/run.R
# Requires: analysis/opportunity_propagation/run_build.R has been run at
# least once (the invariant tests read its real cached output).
suppressMessages(library(testthat))
Sys.setenv(FI_ROOT = getwd())
root <- file.path(getwd(), "analysis", "opportunity_propagation")
if (!dir.exists(file.path(root, "..", "football_intel", "cache"))) stop("run from repo root; cache missing (fetch_raw.R first)")
if (!file.exists(file.path(root, "cache", "absence_events.rds"))) stop("run analysis/opportunity_propagation/run_build.R first")
res <- test_dir(file.path(root, "tests", "testthat"), reporter = "summary", stop_on_failure = TRUE)
