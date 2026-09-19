# ===========================================================================
# Phase 3.5A — pure, side-effect-free evidence-gate predicates.
#
# `evaluate_week_evidence()` decides, for ONE current-season week, which of the
# required predicates hold and WHY the rest do not. eligibility.R gathers the
# inputs (I/O) and calls this; tests call it directly with synthetic inputs.
#
# Principles
#   * "Week complete" is NEVER inferred from PBP rows or from a provider's week
#     counter. It comes from `reality` (the frozen Phase 1 completion predicate,
#     emitted by scripts/nfl-week-completion.ts): every scheduled game complete.
#   * Missing input => FAIL CLOSED (predicate FALSE + a reason code). Nothing is
#     inferred, nothing is substituted with a weaker input.
#   * The production baseline must be a record of what production actually
#     showed BEFORE kickoff (a LIVE_CAPTURED shadow record). A post-hoc Sleeper
#     history projection is NOT the production baseline and never satisfies it.
# ===========================================================================

# The as-of FI builder (fi_asof_features.R) skips thr = W-1 < 2, so a week
# W < 3 can never have a buildable as-of snapshot.
FI_ASOF_MIN_THROUGH <- 2L

PREDICATES <- c("NFL_WEEK_COMPLETE", "FI_ASOF_AVAILABLE", "CURRENT_SEASON_FI_AVAILABLE",
                "ACTUALS_AVAILABLE", "PRODUCTION_BASELINE_AVAILABLE")

`%||%` <- function(a, b) if (is.null(a) || length(a) == 0 || (length(a) == 1 && is.na(a))) b else a

#' @param week integer week
#' @param season integer
#' @param reality list(available, weeks = list of list(week, scheduled, completed, state, teams))
#' @param nflverse list(sched_games = named int (by week), pbp_games = named int (by week))
#' @param fi FI manifest (list) or NULL
#' @param actuals data.frame(week, team, act_ppr) for the season (may be empty/NULL)
#' @param baseline list(live_captured_by_week = named int)   # LIVE_CAPTURED records per week
evaluate_week_evidence <- function(week, season, reality, nflverse, fi, actuals, baseline) {
  reasons <- character(0)
  fail <- function(code) reasons <<- c(reasons, code)
  wk <- function(x) x[[as.character(week)]] %||% 0L

  rw <- NULL
  if (isTRUE(reality$available)) {
    for (r in reality$weeks) if (identical(as.integer(r$week), as.integer(week))) rw <- r
  }

  # ---- 1. NFL_WEEK_COMPLETE ------------------------------------------------
  nfl_complete <- FALSE
  if (!isTRUE(reality$available)) {
    fail("REALITY_UNAVAILABLE")
  } else if (is.null(rw)) {
    fail("WEEK_NOT_IN_SCHEDULE")
  } else if (!identical(rw$state, "COMPLETE") || rw$scheduled < 1 || rw$completed != rw$scheduled) {
    fail(sprintf("WEEK_%s_%d_OF_%d_GAMES", rw$state, as.integer(rw$completed), as.integer(rw$scheduled)))
  } else {
    sched_n <- wk(nflverse$sched_games); pbp_n <- wk(nflverse$pbp_games)
    if (sched_n != rw$scheduled) {
      fail(sprintf("SCHEDULE_SOURCE_DISAGREEMENT_%d_VS_%d", as.integer(sched_n), as.integer(rw$scheduled)))
    } else if (pbp_n != rw$scheduled) {
      fail(sprintf("PBP_INCOMPLETE_%d_OF_%d", as.integer(pbp_n), as.integer(rw$scheduled)))
    } else nfl_complete <- TRUE
  }

  # ---- FI is-ahead-of-reality (global; fail closed for FI predicates) ------
  fi_ahead <- FALSE
  fi_current <- !is.null(fi) && identical(as.integer(fi$season), as.integer(season)) &&
    identical(as.integer(fi$seasons_used$current %||% NA), as.integer(season))
  if (fi_current && isTRUE(reality$available)) {
    done <- Filter(function(r) r$completed > 0, reality$weeks)
    frontier <- if (length(done)) max(vapply(done, function(r) as.integer(r$week), 1L)) else 0L
    fi_through <- as.integer(fi$through_week)
    if (fi_through > frontier) fi_ahead <- TRUE
    if (fi_through == frontier && length(done)) {
      rl <- Filter(function(r) as.integer(r$week) == frontier, done)[[1]]
      if (as.integer(fi$week_completion$games_completed_in_latest_week %||% 0L) > as.integer(rl$completed)) fi_ahead <- TRUE
    }
  }

  # ---- prior period fully complete? (W-1 and every earlier week) ----------
  prior_complete <- FALSE
  if (week >= 2L && isTRUE(reality$available)) {
    prior <- Filter(function(r) as.integer(r$week) < week, reality$weeks)
    prior_complete <- length(prior) == (week - 1L) && all(vapply(prior, function(r) identical(r$state, "COMPLETE"), TRUE))
  }

  # ---- 3. CURRENT_SEASON_FI_AVAILABLE -------------------------------------
  cur_fi <- FALSE
  if (is.null(fi)) fail("FI_MANIFEST_MISSING")
  else if (!fi_current) fail("FI_PRIOR_SEASON_ONLY")
  else if (fi_ahead) fail("FI_AHEAD_OF_REALITY")
  else if (week < 2L) fail("NO_PRIOR_CURRENT_SEASON_WEEK")
  else if (!prior_complete) fail("PRIOR_WEEK_NOT_COMPLETE")
  else cur_fi <- TRUE

  # ---- 2. FI_ASOF_AVAILABLE ------------------------------------------------
  fi_asof <- FALSE
  if (is.null(fi) || !fi_current || fi_ahead) {
    # reason already recorded by predicate 3
  } else if ((week - 1L) < FI_ASOF_MIN_THROUGH) {
    fail(sprintf("FI_ASOF_UNBUILDABLE_BEFORE_WEEK_%d", FI_ASOF_MIN_THROUGH + 1L))
  } else if (as.integer(fi$through_week) < (week - 1L)) {
    fail(sprintf("FI_THROUGH_%d_BEHIND_REQUIRED_%d", as.integer(fi$through_week), as.integer(week - 1L)))
  } else fi_asof <- TRUE

  # ---- 4. ACTUALS_AVAILABLE ------------------------------------------------
  actuals_ok <- FALSE
  if (!nfl_complete) {
    fail("ACTUALS_NOT_FINAL_WEEK_INCOMPLETE")
  } else {
    a <- if (is.null(actuals)) NULL else actuals[actuals$week == week & is.finite(actuals$act_ppr), , drop = FALSE]
    if (is.null(a) || nrow(a) == 0) {
      fail("ACTUALS_MISSING")
    } else {
      missing_teams <- setdiff(rw$teams, unique(a$team))
      if (length(missing_teams)) fail(sprintf("ACTUALS_TEAM_COVERAGE_MISSING_%d_TEAMS", length(missing_teams)))
      else actuals_ok <- TRUE
    }
  }

  # ---- 5. PRODUCTION_BASELINE_AVAILABLE -----------------------------------
  n_live <- as.integer(wk(baseline$live_captured_by_week))
  base_ok <- n_live >= 1L
  if (!base_ok) fail("NO_PRE_KICKOFF_PRODUCTION_BASELINE_CAPTURE")

  preds <- c(NFL_WEEK_COMPLETE = nfl_complete, FI_ASOF_AVAILABLE = fi_asof,
             CURRENT_SEASON_FI_AVAILABLE = cur_fi, ACTUALS_AVAILABLE = actuals_ok,
             PRODUCTION_BASELINE_AVAILABLE = base_ok)
  list(week = as.integer(week), predicates = as.list(preds), counts = all(preds),
       reasons = unique(reasons),
       detail = list(games_scheduled = rw$scheduled %||% NA, games_completed = rw$completed %||% NA,
                     live_captured_records = n_live))
}

#' Evaluate every candidate week and derive the gate summary.
evaluate_evidence_gate <- function(weeks, season, reality, nflverse, fi, actuals, baseline,
                                   min_weeks = 4L, pref_weeks = 6L) {
  ev <- lapply(weeks, evaluate_week_evidence, season = season, reality = reality,
               nflverse = nflverse, fi = fi, actuals = actuals, baseline = baseline)
  counted <- vapply(ev, function(e) isTRUE(e$counts), TRUE)
  list(week_evidence = ev,
       completed_weeks = sort(vapply(ev[counted], function(e) e$week, 1L)),
       min_weeks = min_weeks, pref_weeks = pref_weeks,
       eligible = sum(counted) >= min_weeks)
}
