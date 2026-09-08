#!/usr/bin/env Rscript
# Player x Scheme Intelligence — R test runner (Phase 9).
#   Rscript analysis/player_scheme_intelligence/tests/run.R
# Run from the repo root (needs analysis/football_intel/cache/pbp.rds).
root <- getwd()
if (!file.exists(file.path(root, "analysis", "player_scheme_intelligence", "config.R")))
  stop("run from the repo root")
for (f in c("test_tierA.R", "test_tierD_synthetic.R")) {
  cat("\n==== ", f, " ====\n")
  system2("Rscript", shQuote(file.path(root, "analysis", "player_scheme_intelligence", "tests", f)))
}
