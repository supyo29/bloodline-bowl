#!/usr/bin/env Rscript
# ===========================================================================
# Phase 4 remediation Part C — re-evaluation EVIDENCE GATE.
#
#   Rscript analysis/football_intel_startsit/eligibility.R
#
# Derives lib/weekly/data/start_sit_reevaluation_manifest.json from ACTUAL
# available data. Counts a 2026 NFL week as a genuine current-season FI week
# only when ALL of these hold:
#   1. nflverse pbp has completed REG week W of 2026;
#   2. a Phase 3 FI as-of snapshot can be built through week W-1 for 2026
#      (i.e. Phase 3's own pipeline published for that week);
#   3. current-season FI features (team ratings) exist for week W-1;
#   4. actual weekly fantasy outcomes exist for week W;
#   5. production-baseline projections are available for week W (Sleeper feed).
# The preseason / prior-only snapshot (fi:2025:w18) NEVER counts.
#
# Emits reevaluation_status = NOT_ELIGIBLE until completed_fi_weeks >= minimum.
# NEVER fabricates a future result.
# ===========================================================================

suppressWarnings(suppressMessages({ library(dplyr); library(jsonlite) }))
.here <- sub("^--file=", "", grep("^--file=", commandArgs(FALSE), value = TRUE))
BASE <- if (length(.here)) dirname(.here) else file.path(getwd(), "analysis", "football_intel_startsit")
source(file.path(BASE, "config.R"))

CURRENT_SEASON <- 2026L
MIN_WEEKS <- 4L
PREF_WEEKS <- 6L
PER_WEEK_REQUIREMENTS <- c(
  "pbp_completed_reg_week",
  "phase3_fi_asof_snapshot_buildable",
  "fi_team_ratings_present_through_prior_week",
  "actual_fantasy_outcomes_present",
  "production_baseline_projection_available")

fi_manifest_path <- file.path(SS$ROOT, "lib", "football-intel", "data", "football_intelligence_manifest.json")
fi_manifest <- if (file.exists(fi_manifest_path)) fromJSON(fi_manifest_path) else NULL

# --- how many genuine 2026 FI weeks exist right now? ---------------------
completed <- integer(0)
fi_cache_pbp <- file.path(SS$FI_DIR, "cache", "pbp.rds")
if (file.exists(fi_cache_pbp)) {
  pbp <- readRDS(fi_cache_pbp)
  reg26 <- pbp %>% filter(season == CURRENT_SEASON, season_type == "REG")
  if (nrow(reg26) > 0) {
    # a week counts only if pbp has it AND the FI manifest was published for
    # the current season through at least that week's prior week.
    fi_is_current <- !is.null(fi_manifest) && identical(as.integer(fi_manifest$season), CURRENT_SEASON)
    fi_through <- if (fi_is_current) as.integer(fi_manifest$through_week) else 0L
    weeks_in_pbp <- sort(unique(reg26$week))
    for (w in weeks_in_pbp) {
      ok_pbp <- TRUE
      ok_fi  <- fi_is_current && (fi_through >= (w - 1L)) && ((w - 1L) >= 1L)
      # actuals + baseline: both come from the same Sleeper endpoints the
      # decision-dataset builder uses; check the history cache if present.
      hist_path <- file.path(SS$CACHE_DIR, "sleeper_history.rds")
      ok_act <- ok_base <- FALSE
      if (file.exists(hist_path)) {
        h <- readRDS(hist_path)
        hw <- h %>% filter(season == CURRENT_SEASON, week == w)
        ok_act  <- any(is.finite(hw$act_ppr))
        ok_base <- any(is.finite(hw$proj_ppr))
      }
      if (ok_pbp && isTRUE(ok_fi) && ok_act && ok_base) completed <- c(completed, w)
    }
  }
}
`%||%` <- function(a, b) if (is.null(a) || (length(a) == 1 && is.na(a))) b else a
completed <- sort(unique(completed))
n_completed <- length(completed)

# --- live shadow capture counts (Part C "shadow accumulation") -----------
cap_dir <- file.path(SS$OUT_DIR, "shadow_capture")
live_n <- recon_n <- 0L
if (dir.exists(cap_dir)) {
  files <- list.files(cap_dir, pattern = "\\.jsonl$", full.names = TRUE)
  for (f in files) {
    lines <- tryCatch(readLines(f, warn = FALSE), error = function(e) character(0))
    for (ln in lines) {
      rec <- tryCatch(fromJSON(ln), error = function(e) NULL)
      if (is.null(rec)) next
      if (identical(rec$capture_kind, "LIVE_CAPTURED")) live_n <- live_n + 1L
      else recon_n <- recon_n + 1L
    }
  }
}

eligible <- n_completed >= MIN_WEEKS
status <- if (eligible) "ELIGIBLE" else "NOT_ELIGIBLE"
reason <- if (eligible) NA_character_ else sprintf(
  "insufficient genuine 2026 FI sample: %d completed current-season FI week(s), need >= %d (prior-only snapshot fi:%s does not count)",
  n_completed, MIN_WEEKS, if (is.null(fi_manifest)) "none" else sub("^fi:", "", fi_manifest$football_intelligence_version))

manifest <- list(
  current_model_version = SS$MODEL_VERSION,
  deployment = "SHADOW_ONLY",
  season = CURRENT_SEASON,
  completed_fi_weeks = n_completed,
  completed_fi_week_list = as.list(completed),
  minimum_weeks_required = MIN_WEEKS,
  preferred_weeks = PREF_WEEKS,
  per_week_requirements = PER_WEEK_REQUIREMENTS,
  reevaluation_eligible = eligible,
  reevaluation_status = status,
  not_eligible_reason = reason,
  last_evaluated_through_week = NULL,
  next_candidate_version = sub("(\\d{4})\\.(\\d+)$", paste0("\\1.", as.integer(sub(".*\\.", "", SS$MODEL_VERSION)) + 1L), SS$MODEL_VERSION),
  cadence = list(first_check_week = MIN_WEEKS, second_check_week = PREF_WEEKS, thereafter_every_weeks = 3L),
  live_captured_decisions = live_n,
  historically_reconstructed_decisions = recon_n,
  fi_snapshot_seen = if (is.null(fi_manifest)) NULL else fi_manifest$football_intelligence_version,
  fi_snapshot_is_current_season = !is.null(fi_manifest) && identical(as.integer(fi_manifest$season), CURRENT_SEASON),
  generated_at = format(Sys.time(), "%Y-%m-%dT%H:%M:%S%z"),
  refresh_command = "Rscript analysis/football_intel_startsit/eligibility.R  (then reevaluate.R when ELIGIBLE)")

out <- file.path(SS$SERVE_DIR, "start_sit_reevaluation_manifest.json")
write(toJSON(manifest, auto_unbox = TRUE, pretty = TRUE, null = "null"), out)
cat(sprintf("re-evaluation: %s  (completed_fi_weeks=%d / %d)  -> %s\n",
            status, n_completed, MIN_WEEKS, out))
if (!is.na(reason)) cat("  reason:", reason, "\n")
