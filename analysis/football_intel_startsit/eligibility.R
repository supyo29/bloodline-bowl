#!/usr/bin/env Rscript
# ===========================================================================
# Re-evaluation EVIDENCE GATE  (Phase 4 remediation Part C; rebuilt in Phase 3.5A).
#
#   Rscript analysis/football_intel_startsit/eligibility.R
#
# Derives lib/weekly/data/start_sit_reevaluation_manifest.json from ACTUAL
# evidence. A 2026 week counts as a genuine current-season FI evidence week only
# when ALL FIVE predicates hold (evidence_gate.R, auditable per week):
#   NFL_WEEK_COMPLETE              every scheduled game "complete" per the frozen
#                                  Phase 1 predicate (scripts/nfl-week-completion.ts),
#                                  cross-checked against nflverse schedule + PBP
#   FI_ASOF_AVAILABLE              an as-of snapshot through W-1 is buildable
#   CURRENT_SEASON_FI_AVAILABLE    FI is a 2026 publication and W-1 (and all earlier
#                                  weeks) are complete; a prior-only snapshot never counts
#   ACTUALS_AVAILABLE              final actuals for every team that played
#   PRODUCTION_BASELINE_AVAILABLE  a LIVE_CAPTURED pre-kickoff production baseline exists
# Missing input => fail closed with a reason code. Nothing is inferred or substituted.
# NEVER fabricates a result; NEVER promotes anything.
# ===========================================================================

suppressWarnings(suppressMessages({ library(dplyr); library(jsonlite) }))
.here <- sub("^--file=", "", grep("^--file=", commandArgs(FALSE), value = TRUE))
BASE <- if (length(.here)) dirname(.here) else file.path(getwd(), "analysis", "football_intel_startsit")
source(file.path(BASE, "config.R"))
source(file.path(BASE, "evidence_gate.R"))

CURRENT_SEASON <- 2026L
MIN_WEEKS <- 4L
PREF_WEEKS <- 6L
GATE_VERSION <- "evidence-gate-2026.2"
PER_WEEK_REQUIREMENTS <- PREDICATES
SKIP_NETWORK <- nzchar(Sys.getenv("SS_ELIGIBILITY_OFFLINE", ""))

fi_manifest_path <- file.path(SS$ROOT, "lib", "football-intel", "data", "football_intelligence_manifest.json")
fi_manifest <- if (file.exists(fi_manifest_path)) fromJSON(fi_manifest_path, simplifyVector = FALSE) else NULL

# --- 1. NFL reality (frozen Phase 1 predicate, emitted by the TS script) -----
reality_path <- file.path(SS$OUT_DIR, "nfl_week_completion.json")
if (!SKIP_NETWORK) {
  unlink(reality_path)  # never trust a stale artifact
  system2("npx", c("tsx", shQuote(file.path(SS$ROOT, "scripts", "nfl-week-completion.ts")), CURRENT_SEASON, shQuote(reality_path)),
          stdout = FALSE, stderr = FALSE)
}
reality <- if (file.exists(reality_path)) fromJSON(reality_path, simplifyVector = FALSE) else list(available = FALSE, weeks = list())
reality$available <- isTRUE(reality$available)

# --- 2. nflverse cross-check (second, independent source) ---------------------
sched_games <- pbp_games <- integer(0)
sched_path <- file.path(SS$FI_DIR, "cache", "schedules.rds")
if (file.exists(sched_path)) {
  sc <- readRDS(sched_path) %>% filter(season == CURRENT_SEASON, game_type == "REG")
  sched_games <- table(sc$week); sched_games <- setNames(as.integer(sched_games), names(sched_games))
}
pbp_path <- file.path(SS$FI_DIR, "cache", "pbp.rds")
if (file.exists(pbp_path)) {
  pb <- readRDS(pbp_path) %>% filter(season == CURRENT_SEASON, season_type == "REG") %>% distinct(week, game_id)
  pbp_games <- table(pb$week); pbp_games <- setNames(as.integer(pbp_games), names(pbp_games))
}
nflverse <- list(sched_games = as.list(sched_games), pbp_games = as.list(pbp_games))

# --- 3. actuals (separate 2026 cache; frozen 2021-25 cache is never touched) --
actuals <- NULL
hist26 <- file.path(SS$CACHE_DIR, sprintf("sleeper_history_%d.rds", CURRENT_SEASON))
if (reality$available && !SKIP_NETWORK && any(vapply(reality$weeks, function(w) w$completed > 0, TRUE))) {
  system2("Rscript", c(shQuote(file.path(BASE, "fetch_sleeper_history.R")), sprintf("--season=%d", CURRENT_SEASON)),
          stdout = FALSE, stderr = FALSE)
}
if (file.exists(hist26)) {
  h <- readRDS(hist26)
  actuals <- h %>% filter(season == CURRENT_SEASON) %>% transmute(week, team, act_ppr)
}

# --- 4. live shadow-capture summary (durable store, emitted by the TS report) -
cap_path <- file.path(SS$OUT_DIR, "shadow_capture_summary.json")
cap <- if (file.exists(cap_path)) fromJSON(cap_path, simplifyVector = FALSE) else NULL
live_by_week <- if (!is.null(cap$live_captured_by_week)) cap$live_captured_by_week else list()
baseline <- list(live_captured_by_week = live_by_week)

# --- 5. per-week predicates ---------------------------------------------------
frontier_week <- if (reality$available) {
  done <- Filter(function(w) w$completed > 0, reality$weeks)
  if (length(done)) max(vapply(done, function(w) as.integer(w$week), 1L)) else 0L
} else 0L
pbp_max <- if (length(pbp_games)) max(as.integer(names(pbp_games))) else 0L
candidate_weeks <- seq_len(max(frontier_week, pbp_max, if (!is.null(fi_manifest)) as.integer(fi_manifest$through_week) else 0L))

gate <- evaluate_evidence_gate(candidate_weeks, CURRENT_SEASON, reality, nflverse, fi_manifest, actuals, baseline,
                               MIN_WEEKS, PREF_WEEKS)
completed <- gate$completed_weeks
n_completed <- length(completed)
eligible <- gate$eligible
status <- if (eligible) "ELIGIBLE" else "NOT_ELIGIBLE"

rejected <- Filter(function(e) !isTRUE(e$counts), gate$week_evidence)
rej_summary <- lapply(rejected, function(e) list(week = e$week, reasons = as.list(e$reasons)))
reason <- if (eligible) NA_character_ else sprintf(
  "insufficient genuine %d evidence: %d qualifying week(s), need >= %d (candidate weeks %s; NFL frontier: week %d has %s completed)%s",
  CURRENT_SEASON, n_completed, MIN_WEEKS,
  if (length(candidate_weeks)) paste0(min(candidate_weeks), "-", max(candidate_weeks)) else "none", frontier_week,
  if (reality$available && frontier_week > 0) {
    fw <- Filter(function(w) as.integer(w$week) == frontier_week, reality$weeks)[[1]]
    sprintf("%d/%d games", fw$completed, fw$scheduled) } else "n/a",
  if (!reality$available) "; NFL reality UNAVAILABLE (fail closed)" else "")

live_n <- as.integer(cap$live_captured_total %||% 0L)
manifest <- list(
  evidence_gate_version = GATE_VERSION,
  current_model_version = SS$MODEL_VERSION,
  deployment = "SHADOW_ONLY",
  season = CURRENT_SEASON,
  completed_fi_weeks = n_completed,
  completed_fi_week_list = as.list(completed),
  minimum_weeks_required = MIN_WEEKS,
  preferred_weeks = PREF_WEEKS,
  per_week_requirements = as.list(PER_WEEK_REQUIREMENTS),
  candidate_weeks = as.list(candidate_weeks),
  week_evidence = gate$week_evidence,
  rejected_weeks = rej_summary,
  nfl_reality = list(available = reality$available, as_of = reality$as_of %||% NULL,
                     source = reality$source %||% NULL, latest_week_with_any_completed_game = frontier_week,
                     weeks = lapply(Filter(function(w) w$completed > 0 || w$week <= frontier_week + 1L, reality$weeks),
                                    function(w) w[c("week", "scheduled", "completed", "state")])),
  reevaluation_eligible = eligible,
  reevaluation_status = status,
  not_eligible_reason = reason,
  last_evaluated_through_week = NULL,
  next_candidate_version = sub("(\\d{4})\\.(\\d+)$", paste0("\\1.", as.integer(sub(".*\\.", "", SS$MODEL_VERSION)) + 1L), SS$MODEL_VERSION),
  cadence = list(first_check_week = MIN_WEEKS, second_check_week = PREF_WEEKS, thereafter_every_weeks = 3L),
  live_captured_decisions = live_n,
  historically_reconstructed_decisions = as.integer(cap$reconstructed_total %||% 0L),
  post_lock_observations = as.integer(cap$post_lock_total %||% 0L),
  capture_summary_available = !is.null(cap),
  fi_snapshot_seen = if (is.null(fi_manifest)) NULL else fi_manifest$football_intelligence_version,
  fi_snapshot_is_current_season = !is.null(fi_manifest) && identical(as.integer(fi_manifest$season), CURRENT_SEASON),
  generated_at = format(Sys.time(), "%Y-%m-%dT%H:%M:%S%z"),
  refresh_command = "Rscript analysis/football_intel_startsit/eligibility.R  (then reevaluate.R when ELIGIBLE)")

out <- file.path(SS$SERVE_DIR, "start_sit_reevaluation_manifest.json")
write(toJSON(manifest, auto_unbox = TRUE, pretty = TRUE, null = "null", na = "null"), out)
cat(sprintf("re-evaluation: %s  (qualifying weeks=%d / %d)  -> %s\n", status, n_completed, MIN_WEEKS, out))
for (e in gate$week_evidence)
  cat(sprintf("  wk%02d %s  %s\n", e$week, if (e$counts) "COUNTS  " else "rejected",
              if (e$counts) "" else paste(e$reasons, collapse = ", ")))
if (!is.na(reason)) cat("  reason:", reason, "\n")
