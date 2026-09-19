#!/usr/bin/env Rscript
# ===========================================================================
# Phase 4 remediation Part C — the DORMANT 2026 re-certification pipeline.
#
#   Rscript analysis/football_intel_startsit/reevaluate.R [--force]
#
# Runs ONLY when the evidence gate (eligibility.R) says ELIGIBLE (and --force cannot change that).
# Phase 3.5A Checkpoint F: it evaluates the shadow gate against the PRODUCTION baseline on genuine captured
# pre-kickoff evidence with ONE unambiguous gate identity (tuned-on baseline, tuned tau/cap, evaluated tau/cap)
# and fails closed on chronology-leaking features, post-hoc baselines, mismatched gates, incomplete NFL weeks
# or insufficient evidence. It fits nothing, writes no model artifact and never promotes.
# ===========================================================================

suppressWarnings(suppressMessages({ library(dplyr); library(jsonlite) }))
.here <- sub("^--file=", "", grep("^--file=", commandArgs(FALSE), value = TRUE))
BASE <- if (length(.here)) dirname(.here) else file.path(getwd(), "analysis", "football_intel_startsit")
source(file.path(BASE, "config.R"))
source(file.path(BASE, "candidate_gate.R"))
source(file.path(BASE, "candidate_frame.R"))
FORCE <- "--force" %in% commandArgs(TRUE)

# Sandbox-only test hook: keep a synthetic manifest as-is. NEVER honoured in a real repo (a .git dir at ROOT).
if (!(nzchar(Sys.getenv("SS_TEST_MANIFEST_AS_IS")) && !dir.exists(file.path(SS$ROOT, ".git"))))
  system2("Rscript", file.path(BASE, "eligibility.R"))
man_path <- file.path(SS$SERVE_DIR, "start_sit_reevaluation_manifest.json")
man <- fromJSON(man_path, simplifyVector = FALSE)
write_man <- function(m) write(toJSON(m, auto_unbox = TRUE, pretty = TRUE, null = "null"), man_path)

# Phase 3.5A: `--force` can NO LONGER bypass the evidence gate. Fitting a candidate on an ineligible
# sample is exactly what this gate exists to prevent; the flag is retained only so old invocations
# do not error, and it is ignored.
if (FORCE) message("NOTE: --force is ignored; the evidence gate is not bypassable.")
if (!isTRUE(man$reevaluation_eligible)) {
  message(sprintf("re-evaluation NOT_ELIGIBLE — %s", man$not_eligible_reason))
  message("pipeline dormant. Re-run after the milestone weeks (", man$cadence$first_check_week,
          ", then ", man$cadence$second_check_week, ", then every ", man$cadence$thereafter_every_weeks, ").")
  quit(status = 0)
}

CANDIDATE <- man$next_candidate_version
message("re-evaluation running candidate ", CANDIDATE, " ...")
man$reevaluation_status <- "RUNNING"; write_man(man)

fail <- function(reason) {
  man$reevaluation_status <<- "FAILED"
  man$reevaluation_failure_reason <<- reason
  man$candidate_version_evaluated <<- CANDIDATE
  write_man(man)
  message("re-evaluation FAILED — ", reason, "\nproduction routing NOT modified.")
  quit(status = 0)
}

# ---------------------------------------------------------------------------------------------------
# Phase 3.5A Checkpoint F — the candidate path NEVER touches Sleeper-history baselines, the trailing
# control as a selector, or whole-season discontinuity features. Evidence = captured pre-kickoff
# production baselines + later outcome enrichment (same scoring fingerprint), chronology-safe (AS_OF)
# features. Every assertion fails closed. This script evaluates gate value against the PRODUCTION baseline;
# it does not fit or serve a new model (a v2 fit is a separate, reviewed step) and never promotes.
# ---------------------------------------------------------------------------------------------------
result <- tryCatch({
  rec_path <- file.path(SS$OUT_DIR, "captured_records.json")
  out_path <- file.path(SS$OUT_DIR, "captured_outcomes.json")
  if (!file.exists(rec_path) || !file.exists(out_path))
    fail("captured evidence export missing (run scripts/startsit-export-captured-evidence.ts against the durable store)")
  records  <- fromJSON(rec_path, simplifyVector = FALSE)
  outcomes <- fromJSON(out_path, simplifyVector = FALSE)

  built <- build_candidate_frame(records, outcomes)
  reality_path <- file.path(SS$OUT_DIR, "nfl_week_completion.json")
  reality <- if (file.exists(reality_path)) fromJSON(reality_path, simplifyVector = FALSE) else NULL
  assert_candidate_admissible(built$provenance, man,
    registry_path = file.path(BASE, "candidate_v2_feature_registry.json"),
    design_families = character(0), reality_weeks = if (!is.null(reality) && isTRUE(reality$available)) reality$weeks else NULL)

  weeks <- built$provenance$weeks
  sp <- split_weeks(weeks)
  pairs <- gate_pairs(built$frame)
  if (is.null(pairs)) fail("no comparable pairs in the captured evidence")
  # trailing control (research only): built from the same frame's players is NOT possible without history;
  # it is reported only if a control frame has been exported. It never selects the gate.
  ctl_path <- file.path(SS$OUT_DIR, "captured_control_frame.json")
  ctl_pairs <- NULL
  if (file.exists(ctl_path)) {
    cf <- as.data.frame(do.call(rbind, lapply(fromJSON(ctl_path, simplifyVector = FALSE), as.data.frame)))
    ctl_pairs <- gate_pairs(cf)
  }
  report <- candidate_gate_report(pairs, ctl_pairs, sp$tune, sp$eval, SS$TAU_GRID, c(SS$MAX_ADJ_FRAC_GRID, 0.25))
  report$provenance <- built$provenance
  write(toJSON(report, auto_unbox = TRUE, pretty = TRUE, null = "null", na = "null"),
        file.path(SS$OUT_DIR, "candidate_gate_report.json"))
  report
}, error = function(e) fail(paste("unexpected:", conditionMessage(e))))

man$reevaluation_status <- "ELIGIBLE"        # research evaluation only: never PASSED, never a verdict
man$last_evaluated_through_week <- suppressWarnings(max(unlist(man$completed_fi_week_list)))
man$candidate_version_evaluated <- NULL
man$candidate_fit <- "NOT_PERFORMED (separate reviewed step; no artifact generated)"
man$gate_identity <- result$gate_identity
man$deployment_note <- paste("Research evaluation only. No candidate was fit, no artifact written, production routing UNCHANGED.",
                             "Activation requires an explicit human step in the deployment contract.")
write_man(man)
message("gate evaluated against the PRODUCTION baseline: tau=", result$gate_identity$evaluated_tau,
        " cap=", result$gate_identity$evaluated_cap, "; production routing NOT modified.")
