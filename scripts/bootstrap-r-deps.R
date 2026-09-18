#!/usr/bin/env Rscript
# ===========================================================================
# Bloodline Bowl — Phase 10 evidence loop: R dependency bootstrap.
#
#   Rscript scripts/bootstrap-r-deps.R
#
# Installs exactly the CRAN packages the Football Intelligence + Player x Scheme
# pipelines import (derived from the source, not guessed). Idempotent: an
# already-installed package of a sufficient version is skipped. This is a plain
# installer, not a lockfile framework (renv is deliberately not used — the repo
# has no other R dependency-management layer).
#
# Base / "recommended" packages that ship with R (stats, utils, methods, MASS)
# are asserted, not installed.
# ===========================================================================

options(warn = 1L)
repos <- getOption("repos")
if (is.null(repos[["CRAN"]]) || repos[["CRAN"]] %in% c("", "@CRAN@")) {
  repos <- c(CRAN = "https://cloud.r-project.org")
}

# --- packages imported directly by the pipeline (grep of library()/pkg::) ---
required <- c(
  targets   = "1.5.0",   # {targets} graph runner  (_targets.R)
  nflreadr  = "1.4.0",   # nflverse loaders        (fetch_raw.R, source_audit.R)
  dplyr     = "1.1.0",
  tidyr     = "1.3.0",
  stringr   = "1.5.0",
  purrr     = "1.0.0",
  tibble    = "3.2.0",
  rlang     = "1.1.0",
  jsonlite  = "1.8.0",
  digest    = "0.6.30",
  yaml      = "2.3.0",    # _targets.R tar_option_set(packages=...), coordinators.yaml
  testthat  = "3.2.0"     # analysis/*/tests/*
)

# --- ships with R; must be present but is never installed here ---
base_recommended <- c("stats", "utils", "methods", "MASS")

missing_base <- base_recommended[!vapply(base_recommended, requireNamespace, logical(1), quietly = TRUE)]
if (length(missing_base)) {
  stop("Base/recommended package(s) unexpectedly absent from this R: ",
       paste(missing_base, collapse = ", "),
       ". Install a complete R (with recommended packages).")
}

need <- character(0)
for (pkg in names(required)) {
  min_ver <- required[[pkg]]
  have <- tryCatch(as.character(utils::packageVersion(pkg)), error = function(e) NA_character_)
  if (is.na(have)) {
    need <- c(need, pkg)
  } else if (utils::compareVersion(have, min_ver) < 0) {
    message(sprintf("  %-10s %s installed, need >= %s -> will upgrade", pkg, have, min_ver))
    need <- c(need, pkg)
  } else {
    message(sprintf("  %-10s %s (ok)", pkg, have))
  }
}

if (length(need)) {
  message("\nInstalling: ", paste(need, collapse = ", "))
  install.packages(need, repos = repos, dependencies = c("Depends", "Imports", "LinkingTo"))
} else {
  message("\nAll evidence-loop R dependencies satisfied.")
}

# --- verify everything loads (catches a broken transitive install) ---
failed <- character(0)
for (pkg in names(required)) {
  ok <- tryCatch({ suppressWarnings(suppressMessages(requireNamespace(pkg, quietly = TRUE))) },
                 error = function(e) FALSE)
  if (!ok) failed <- c(failed, pkg)
}
if (length(failed)) {
  stop("These packages still do not load after install: ", paste(failed, collapse = ", "))
}

cat("\nR:", R.version.string, "\n")
for (pkg in names(required)) cat(sprintf("  %-10s %s\n", pkg, as.character(utils::packageVersion(pkg))))
cat("bootstrap-r-deps: OK\n")
