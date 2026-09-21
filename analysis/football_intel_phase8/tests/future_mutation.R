#!/usr/bin/env Rscript
# Phase 8 Step 8 — future-mutation invariance of the evaluation pipeline.
#   Rscript analysis/football_intel_phase8/tests/future_mutation.R
# (1) Scramble EVERY column of all season-2025 rows (FI features, baselines, actuals): the DEVELOPMENT stage (train<=2023 -> test 2024
#     and train<=2022 -> test 2023) must be byte-identical. (2) Scramble seasons 2024 AND 2025: the 2023 fold of every candidate must be
#     identical (only the 2024 fold may change). Nothing after time T may change what was used/decided at T.
suppressWarnings(suppressMessages(library(jsonlite)))
ROOT <- getwd(); ds <- file.path(ROOT, "outputs", "startsit-2026", "decision_dataset.rds")
d <- readRDS(ds); set.seed(1)
scramble <- function(d, seasons) { i <- which(d$season %in% seasons); for (nm in names(d)) if (!nm %in% c("season", "week", "position", "arch")) d[[nm]][i] <- sample(d[[nm]][i]); d }
run <- function(data, tag) { p <- tempfile(fileext = ".rds"); saveRDS(data, p); out <- file.path(tempdir(), tag); dir.create(out, showWarnings = FALSE)
  st <- system2("Rscript", c("analysis/football_intel_phase8/evaluate.R", "dev"), env = c(paste0("P8_DATASET=", p), paste0("P8_OUT=", out)), stdout = FALSE, stderr = FALSE); stopifnot(st == 0); fromJSON(file.path(out, "results_dev.json"), simplifyVector = FALSE) }
base <- fromJSON(file.path(ROOT, "analysis", "football_intel_phase8", "results", "results_dev.json"), simplifyVector = FALSE)
m25  <- run(scramble(d, 2025), "m25"); m2425 <- run(scramble(d, c(2024, 2025)), "m2425")
same25 <- identical(toJSON(base$results, auto_unbox = TRUE, digits = 8), toJSON(m25$results, auto_unbox = TRUE, digits = 8))
f23 <- function(x) vapply(x$results, function(r) r$mae_by_fold[["2023"]]$delta, numeric(1)); same23 <- isTRUE(all.equal(f23(base), f23(m2425), tolerance = 0))
f24 <- function(x) vapply(x$results, function(r) r$mae_by_fold[["2024"]]$delta, numeric(1)); changed24 <- !isTRUE(all.equal(f24(base), f24(m2425), tolerance = 0))
cat(sprintf("scramble 2025 -> dev results identical: %s\nscramble 2024+2025 -> 2023-fold identical: %s\n(control) scramble 2024+2025 -> 2024-fold DOES change: %s\n", same25, same23, changed24))
stopifnot(same25, same23, changed24); cat("FUTURE-MUTATION INVARIANCE: PASS\n")
