#!/usr/bin/env Rscript
# ===========================================================================
# Phase 4 remediation Part C — the DORMANT 2026 re-certification pipeline.
#
#   Rscript analysis/football_intel_startsit/reevaluate.R [--force]
#
# Runs ONLY when the evidence gate (eligibility.R) says ELIGIBLE. Otherwise it
# refreshes the manifest and exits NOT_ELIGIBLE without training anything.
#
# When eligible it performs, chronology-safe, exactly the Phase 4 sequence
# against genuine 2026 current-season data (env-scoped so the frozen 2026.1
# artifact and the 2021-25 training window are never rewritten):
#   1  locate all valid 2026 FI as-of snapshots           (eligibility.R)
#   2  build chronology-safe 2026 Start/Sit decision data  (build_decision_dataset.R, SS_SEASONS_OVERRIDE=2026)
#   3  production baseline: Sleeper weekly; a week whose baseline can't be
#      reconstructed reliably is DEGRADED, never substituted with a weaker one
#   4  train candidate ri-startsit-2026.N (past-only)       (train.R,  SS_MODEL_VERSION_OVERRIDE)
#   5  nested walk-forward hyper-parameter tuning           (train.R)
#   6  evaluate on held-out current-season weeks            (backtest.R)
#   7  feature-family ablation                              (train.R)
#   8  reversal analysis                                    (backtest.R)
#   9  per-position certification                           (finalize_model.R)
#   10 compare against the PRODUCTION baseline (naive controls stay controls)
#   11 emit a per-position deployment verdict
#
# It emits PRODUCTION_ELIGIBLE at most. It NEVER modifies production routing —
# an explicit human deployment step (an activation_log entry in
# start_sit_model.json's deployment_contract) is still required.
#
# ANY failure in the eligible branch -> reevaluation_status = FAILED, manifest
# left consistent, production untouched.
# ===========================================================================

suppressWarnings(suppressMessages({ library(dplyr); library(jsonlite) }))
.here <- sub("^--file=", "", grep("^--file=", commandArgs(FALSE), value = TRUE))
BASE <- if (length(.here)) dirname(.here) else file.path(getwd(), "analysis", "football_intel_startsit")
source(file.path(BASE, "config.R"))
FORCE <- "--force" %in% commandArgs(TRUE)

system2("Rscript", file.path(BASE, "eligibility.R"))
man_path <- file.path(SS$SERVE_DIR, "start_sit_reevaluation_manifest.json")
man <- fromJSON(man_path)
write_man <- function(m) write(toJSON(m, auto_unbox = TRUE, pretty = TRUE, null = "null"), man_path)

if (!isTRUE(man$reevaluation_eligible) && !FORCE) {
  message(sprintf("re-evaluation NOT_ELIGIBLE — %s", man$not_eligible_reason))
  message("pipeline dormant. Re-run after the milestone weeks (", man$cadence$first_check_week,
          ", then ", man$cadence$second_check_week, ", then every ", man$cadence$thereafter_every_weeks, ").")
  quit(status = 0)
}

CANDIDATE <- man$next_candidate_version
message("re-evaluation ", if (FORCE && !isTRUE(man$reevaluation_eligible)) "(FORCED) " else "",
        "running candidate ", CANDIDATE, " ...")
man$reevaluation_status <- "RUNNING"; write_man(man)

fail <- function(reason) {
  man$reevaluation_status <<- "FAILED"
  man$reevaluation_failure_reason <<- reason
  man$candidate_version_evaluated <<- CANDIDATE
  write_man(man)
  message("re-evaluation FAILED — ", reason, "\nproduction routing NOT modified.")
  quit(status = 0)
}

result <- tryCatch({
  # env via Sys.setenv (not system2 `env=`) so a space in the repo path is safe
  Sys.setenv(SS_SEASONS_OVERRIDE = "2026", SS_MODEL_VERSION_OVERRIDE = CANDIDATE, FI_ROOT = SS$ROOT)
  run <- function(script) system2("Rscript", shQuote(file.path(BASE, script)), stdout = "", stderr = "")

  message("  [2] 2026 decision dataset ...")
  rc <- run("build_decision_dataset.R")
  d26 <- file.path(SS$OUT_DIR, "decision_dataset.rds")
  if (rc != 0 || !file.exists(d26)) fail("2026 decision dataset could not be built (degraded window)")
  dd <- readRDS(d26)
  if (nrow(dd) < 500 || dplyr::n_distinct(dd$week) < 3) fail("2026 decision data too thin to evaluate")

  for (script in c("train.R", "backtest.R", "finalize_model.R")) {
    message("  [4-9] ", script, " ...")
    if (run(script) != 0) fail(paste(script, "errored"))
  }

  cand <- fromJSON(file.path(SS$SERVE_DIR, "start_sit_model.json"), simplifyVector = FALSE)
  per_pos <- lapply(names(cand$positions), function(p) {
    ps <- cand$positions[[p]]$production_status
    if (is.null(ps)) ps <- "SHADOW_ONLY_NO_VALUE"
    list(position = p,
         verdict = if (identical(ps, "PRODUCTION_CANDIDATE")) "PRODUCTION_ELIGIBLE"
                   else if (identical(ps, "TIE_BREAK_SHADOW_ONLY")) "SHADOW_ONLY"
                   else "CERTIFICATION_FAILED")
  })
  any_elig <- any(vapply(per_pos, function(x) x$verdict == "PRODUCTION_ELIGIBLE", logical(1)))

  man$reevaluation_status <- if (any_elig) "PASSED" else "FAILED"
  man$last_evaluated_through_week <- suppressWarnings(max(unlist(man$completed_fi_week_list)))
  man$candidate_version_evaluated <- CANDIDATE
  man$per_position_verdict <- per_pos
  man$deployment_note <- paste(
    "Research verdict only. Production routing is UNCHANGED. Activating any position requires an",
    "explicit human deployment step: add an activation_log entry setting that position to",
    "PRODUCTION_ACTIVE in start_sit_model.json's deployment_contract, reviewed and versioned.")
  write_man(man)
  per_pos
}, error = function(e) fail(paste("unexpected:", conditionMessage(e))))

message("\nre-evaluation ", man$reevaluation_status, " — candidate ", CANDIDATE)
for (x in result) message(sprintf("  %-3s -> %s", x$position, x$verdict))
message("\nproduction routing NOT modified. Human deployment step required for any PRODUCTION_ELIGIBLE position.")
