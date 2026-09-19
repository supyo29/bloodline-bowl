#!/usr/bin/env Rscript
# Start/Sit evidence-gate R tests (Phase 3.5A).  Rscript analysis/football_intel_startsit/tests/run.R
suppressMessages(library(testthat))
Sys.setenv(FI_ROOT = getwd())
root <- file.path(getwd(), "analysis", "football_intel_startsit", "tests", "testthat")
test_dir(root, reporter = "summary", stop_on_failure = TRUE)
