#!/usr/bin/env Rscript
# Phase 8 — turn evaluation results into explicit lifecycle states (no state is ever set to PRODUCTION_ACTIVE here).
#   Rscript analysis/football_intel_phase8/finalize.R
# Applies criteria fi-recert-criteria-2026.1 + amendment A1. Context statistics use development seasons (2021-2024) only: the 2025 holdout is not read.
suppressWarnings(suppressMessages({ library(dplyr); library(jsonlite) }))
ROOT <- getwd(); R <- file.path(ROOT, "analysis", "football_intel_phase8", "results")
dev <- fromJSON(file.path(R, "results_dev.json"), simplifyVector = FALSE); ho <- fromJSON(file.path(R, "results_holdout.json"), simplifyVector = FALSE)
MIN_EFFECT <- 0.03
d <- readRDS(file.path(ROOT, "outputs", "startsit-2026", "decision_dataset.rds")) %>% filter(season <= 2024, is.finite(actual), week >= 4, week <= 17)
colsv <- function(f) if (startsWith(f, "off_")) paste0("fi_", f, "_league_percentile") else if (startsWith(f, "def_")) paste0("fidef_", f, "_league_percentile") else paste0("fi_", f, "_modeled")

# baseline integrity: the primary baseline must be far stronger than the naive control (development seasons 2023-2024, rows with both)
bi <- d %>% filter(season %in% 2023:2024, is.finite(baseline_sleeper), is.finite(baseline_trailing)) %>%
  summarise(rows = n(), mae_sleeper = mean(abs(actual - baseline_sleeper)), mae_trailing = mean(abs(actual - baseline_trailing)), rmse_sleeper = sqrt(mean((actual - baseline_sleeper)^2)), rmse_trailing = sqrt(mean((actual - baseline_trailing)^2)))

cands <- list()
for (r in dev$results) {
  pos <- r$position; fam <- r$family; v <- colsv(fam)
  x <- suppressWarnings(as.numeric(d[[v]][d$position == pos & d$season %in% 2023:2024])); dd <- d[d$position == pos & d$season %in% 2023:2024, ]
  ok <- is.finite(x) & is.finite(dd$baseline_sleeper)
  ctx <- list(corr_feature_actual = cor(x[ok], dd$actual[ok]), corr_feature_baseline_sleeper = cor(x[ok], dd$baseline_sleeper[ok]),
              corr_feature_residual = cor(x[ok], (dd$actual - dd$baseline_sleeper)[ok]), n = sum(ok))
  a1 <- r$dev_verdict == "INCONCLUSIVE_SAMPLE" && r$mae$hi < MIN_EFFECT
  final <- if (r$dev_verdict == "PASS_DEV") "PENDING_HOLDOUT" else if (r$dev_verdict == "FAIL_DEV" || a1) "CERTIFICATION_FAILED" else "RESEARCH_ELIGIBLE"
  reason <- if (r$dev_verdict == "FAIL_DEV") "FAILED_DEV_GATES" else if (a1) "EFFECTIVELY_ZERO_OR_HARMFUL (amendment A1)" else if (r$dev_verdict == "INCONCLUSIVE_SAMPLE") "INCONCLUSIVE_SAMPLE" else "PASS_DEV"
  hd <- Filter(function(h) h$position == pos && h$family == fam, ho$results)
  cands[[length(cands) + 1]] <- list(position = pos, family = fam, start_state = "SHADOW_ONLY", evaluable_state = "RESEARCH_ELIGIBLE", evaluated_state = final, verdict_reason = reason,
    dev_original_verdict = r$dev_verdict, failed_gates = r$dev_failed_gates, amendment_a1_applied = a1, tau = r$tau,
    mae_baseline = r$mae_baseline, mae_candidate = r$mae_candidate, mae_improvement = r$mae$delta, mae_improvement_ci90 = c(r$mae$lo, r$mae$hi), bh_q = r$bh_q,
    mae_by_fold = r$mae_by_fold, mae_by_arch = r$mae_by_arch, mae_by_half = r$mae_by_half, mae_by_baseline_tercile = r$mae_by_baseline_tercile,
    decision = r$decision, calibration = r$calibration, redundancy = r$redundancy, context_correlations = ctx,
    adjustment_abs_mean = r$adj_abs_mean, adjustment_abs_p95 = r$adj_abs_p95, adjustment_abs_max = r$adj_abs_max,
    holdout = if (length(hd)) hd[[1]] else list(opened = FALSE, reason = "candidate did not pass development gates; 2025 holdout kept sealed"),
    prospective = list(qualifying_weeks = 0L, live_captured_decisions = 0L, required_weeks = 4L, required_decisions = 150L, met = FALSE),
    highest_state_reachable_from_evidence = if (final == "PENDING_HOLDOUT") "CERTIFICATION_PASSED" else final, production_state = "SHADOW_ONLY")
}
st <- table(vapply(cands, function(c) c$evaluated_state, character(1)))
out <- list(certification_version = "fi-certification-2026.1", criteria_version = "fi-recert-criteria-2026.1+A1", lane = "RECONSTRUCTED_CHRONOLOGY_SAFE", consumer_scope = "START_SIT",
  baseline = list(primary = "baseline_sleeper (RECONSTRUCTED_PRODUCTION_LIKE; production baseline projection is sleeper-weekly-rotowire)", naive_control = "baseline_trailing", integrity = as.list(bi), primary_is_stronger_than_naive = bi$mae_sleeper < bi$mae_trailing),
  holdout_opened = isTRUE(ho$opened), summary = as.list(st), candidates = cands, served_bundles_nongating = dev$served_bundles_nongating,
  not_evaluated = list(
    list(family = "def_pass_epa_allowed", reason = "NOT_PREDICTIVE (Phase 3 routing)", state = "SHADOW_ONLY"), list(family = "def_rush_epa_allowed", reason = "NOT_PREDICTIVE (Phase 3 routing)", state = "SHADOW_ONLY"),
    list(family = "ftn_play_action_rate", reason = "DESCRIPTIVE_ONLY", state = "SHADOW_ONLY"), list(family = "def_man_rate", reason = "DESCRIPTIVE_ONLY", state = "SHADOW_ONLY"),
    list(family = "PFR pressure / pass-rush", reason = "no reconstructable as-of historical series in the decision dataset (NOT_EVALUABLE)", state = "SHADOW_ONLY"),
    list(family = "NGS passing/rushing/receiving", reason = "no reconstructable as-of historical series in the decision dataset (NOT_EVALUABLE)", state = "SHADOW_ONLY"),
    list(family = "coverage-unit profiles", reason = "descriptive; no historical as-of series (NOT_EVALUABLE)", state = "SHADOW_ONLY"),
    list(family = "contextual matchup features / receiver progression", reason = "Phase 5 found 0 predictive-incremental families; Player-Scheme is DESCRIPTIVE; not re-tested through FI (Step 27/28)", state = "SHADOW_ONLY"),
    list(family = "K / D/ST / IDP", reason = "out of scope: Phase 6 provider limitations; unsupported IDP (Step 26)", state = "SHADOW_ONLY")))
write_json(out, file.path(R, "certification_states.json"), auto_unbox = TRUE, digits = 6, pretty = TRUE, na = "null")
cat("states:", paste(names(st), st, collapse = " | "), "\n"); cat(sprintf("baseline integrity: MAE sleeper %.3f vs trailing %.3f on %d rows\n", bi$mae_sleeper, bi$mae_trailing, bi$rows))
