# ===========================================================================
# Phase 3.5A Checkpoint F (D9) — chronology-safe (as-of) discontinuity / prior-discount table.
#
# ROOT CAUSE (D9). `build_discontinuity_table(target_season, ...)` (frozen Phase 3 library) derives
# head-coach / starting-QB / OL / front / secondary continuity from the WHOLE target season
# (coach with most games, QB with most dropbacks, total snaps). build_decision_dataset.R called it ONCE
# per season and applied that single table to every decision week, so a Week-4 decision inherited
# facts only knowable at season's end (e.g. a QB who took over in Week 9).
#
# REPAIR. For a Week-W decision, hand the frozen library ONLY data that existed before Week W:
#   * every season < S in full (past, complete)
#   * season S rows with week < W
#   * nothing from season > S, nothing from week >= W of season S
# The frozen library is not modified; the truncation happens before the call, so leakage is impossible by
# construction (and proven by tests that mutate W..end-of-season data).
#
# Features that cannot be reconstructed as-of are EXCLUDED, not approximated:
#   offensive_coord_change / defensive_coord_change  -> UNSAFE_FOR_BACKTEST. coordinators.yaml is
#     season-keyed with no effective dates, so a mid-season change is indistinguishable from a
#     preseason one. Forced NA (= UNKNOWN => no discount, the library's documented guardrail).
# ===========================================================================

suppressWarnings(suppressMessages({ library(dplyr) }))

DISCONTINUITY_UNSAFE_FEATURES <- c("offensive_coord_change", "defensive_coord_change")

# rows visible at the decision point: season < S (all) or season == S & week < W
asof_visible <- function(df, target_season, decision_week) {
  if (is.null(df) || !nrow(df)) return(df)
  df[df$season < target_season | (df$season == target_season & df$week < decision_week), , drop = FALSE]
}

build_discontinuity_table_asof <- function(target_season, decision_week, schedules, pbp, snap_counts,
                                           rosters_weekly, FI) {
  stopifnot(length(target_season) == 1, length(decision_week) == 1, decision_week >= 1)
  tab <- build_discontinuity_table(
    target_season,
    asof_visible(schedules, target_season, decision_week),
    asof_visible(pbp, target_season, decision_week),
    asof_visible(snap_counts, target_season, decision_week),
    asof_visible(rosters_weekly, target_season, decision_week),
    coord_path = tempfile(fileext = ".yaml"),      # nonexistent -> OC/DC UNKNOWN (UNSAFE_FOR_BACKTEST)
    FI)
  for (col in DISCONTINUITY_UNSAFE_FEATURES) if (col %in% names(tab)) tab[[col]] <- NA
  tab
}

# per-(season, week) prior-discount tables keyed "S|W", consumed by fi_asof_bundle(discounts_asof=)
build_discounts_asof <- function(seasons, weeks, schedules, pbp, snap_counts, rosters_weekly, FI) {
  out <- list()
  for (S in seasons) for (W in weeks) {
    disc <- build_discontinuity_table_asof(S, W, schedules, pbp, snap_counts, rosters_weekly, FI)
    out[[paste0(S, "|", W)]] <- build_prior_discounts(disc, FI)
  }
  out
}
