# ===========================================================================
# Injury -> Opportunity Propagation Intelligence -- Checkpoint B performance
# layer.
#
# Phase 3 must consume Phase 2's role formulas, never recreate them (spec
# §3). This file does NOT introduce a new formula: it is a mathematically
# EXACT, vectorized re-expression of Phase 2's own ewma_through() /
# dimension_series() (analysis/player_role/lib_role_profile.R), used only
# because calling those functions once per (event x beneficiary x
# dimension) via repeated dplyr filter/arrange is computationally
# infeasible across the full 2012-2026, ~274k-row history (a naive loop
# measured well over two minutes and climbing for a SINGLE season slice).
#
# Correctness is not assumed -- see
# tests/testthat/test-fast-baselines-match-phase2.R, which cross-checks
# this file's output against Phase 2's real build_dimension_profile() on a
# large random sample of real historical player-weeks (spec §38's explicit
# "cross-check Phase 2" requirement) and requires floating-point-tolerance
# agreement before this file is trusted for the full build.
#
# Derivation (why this is the same formula, not a new one): Phase 2's
# ewma_through(x, h) computes, for n valid points x_1..x_n (chronological),
# weights w_k = 0.5^{(n-k)/h} and returns sum(w_k * x_k) / sum(w_k).
# Substituting alpha = 0.5^{1/h}, w_k = alpha^{n-k} = alpha^n * alpha^{-k}.
# The alpha^n factor cancels between numerator and denominator, leaving
# sum(alpha^{-k} * x_k) / sum(alpha^{-k}) -- a ratio of two CUMULATIVE SUMS,
# computable once per player in O(n) instead of O(n) work PER as-of point.
# ===========================================================================

.opp_ewma_alpha <- function(halflife) 0.5^(1 / halflife)

# ---------------------------------------------------------------------------
# fast_dimension_series(): for ONE player's chronologically-sorted rows and
# ONE (col, opp_col) pair, returns a data.frame with one row per INPUT row,
# carrying BOTH the "before" (strictly excluding that row -- what Phase 2
# calls `recent`/`season` when as_of == that row) and "through" (including
# that row) variants of the EWMA/season-mean baseline. The "through" variant
# is what a GAP week immediately after this row needs as its pre-event
# baseline (see baseline_asof()) -- since nothing changed between this row
# and the gap week, "as of the gap week" == "through this row, inclusive."
# ---------------------------------------------------------------------------
fast_dimension_series <- function(df_sorted, col, opp_col, halflife = ROLE$RECENT_HALFLIFE_GAMES) {
  n <- nrow(df_sorted)
  x <- df_sorted[[col]]
  opp <- if (!is.null(opp_col) && opp_col %in% names(df_sorted)) df_sorted[[opp_col]] else rep(NA_real_, n)
  valid <- !is.na(x)
  alpha <- .opp_ewma_alpha(halflife)

  # Exponent must be indexed by the COUNT OF VALID OBSERVATIONS SO FAR, not
  # the raw row position -- ewma_through() computes k relative to
  # length(x[!is.na(x)]), i.e. NA rows are skipped entirely from the
  # sequence, not merely zero-weighted in place. Using the raw row index
  # here would stretch the effective half-life across any NA gap (the
  # exact bug caught by the cross-check test against real dimension_series()
  # on live data: kick/punt return share, which has frequent bye/no-return
  # NA rows, was the first case to expose it).
  idx_valid <- cumsum(valid)
  inv_pow <- alpha^(-idx_valid)
  x_valid <- ifelse(valid, x, 0)
  cum_num <- cumsum(x_valid * inv_pow * valid)
  cum_den <- cumsum(inv_pow * valid)

  recent_through <- cum_num / cum_den
  recent_through[is.infinite(recent_through) | is.nan(recent_through)] <- NA_real_
  n_valid_through <- cumsum(valid)
  recent_through[n_valid_through == 0] <- NA_real_

  recent_before <- c(NA_real_, recent_through[-n])
  n_valid_before <- c(0L, n_valid_through[-n])
  recent_before[n_valid_before == 0] <- NA_real_
  # a season boundary does NOT reset `recent` (Phase 2's `recent` EWMA is
  # cross-season/career-long by design -- only `season` resets); no
  # additional season-boundary correction needed here.

  season_id <- df_sorted$season
  season_cum_sum <- ave(x_valid * valid, season_id, FUN = cumsum)
  season_cum_n   <- ave(as.numeric(valid), season_id, FUN = cumsum)
  season_through <- ifelse(season_cum_n > 0, season_cum_sum / season_cum_n, NA_real_)

  season_before_sum <- c(NA_real_, season_cum_sum[-n])
  season_before_n   <- c(NA_real_, season_cum_n[-n])
  season_start <- !duplicated(season_id)
  season_before_sum[season_start] <- 0
  season_before_n[season_start] <- 0
  season_before <- ifelse(season_before_n > 0, season_before_sum / season_before_n, NA_real_)

  n_games_season <- as.integer(season_cum_n)  # THROUGH, inclusive -- matches dimension_series()
  opp_valid <- ifelse(is.na(opp), 0, opp) * valid
  opportunity_total <- ave(opp_valid, season_id, FUN = cumsum)  # THROUGH, inclusive

  data.frame(
    season = season_id, week = df_sorted$week,
    recent = recent_before, season_baseline = season_before,
    recent_through = recent_through, season_through = season_through,
    n_games_season = n_games_season, opportunity_total = opportunity_total,
    opportunity_latest = ifelse(valid, opp, NA_real_), latest = ifelse(valid, x, NA_real_)
  )
}

# ---------------------------------------------------------------------------
# baseline_asof(): the pre-event baseline for a GAP week (no row for this
# player at (season, week)) -- the fast_dimension_series() THROUGH-variant
# from the player's most recent game strictly before (season, week). No
# intervening game exists between that row and the gap week by definition
# of "most recent," so THROUGH that row == BEFORE the gap week exactly.
# ---------------------------------------------------------------------------
baseline_asof <- function(fs, season, week) {
  if (is.null(fs) || nrow(fs) == 0) {
    return(list(recent = NA_real_, season_baseline = NA_real_, n_games_season = 0L, opportunity_total = 0))
  }
  key <- season * 100L + week
  fs_key <- fs$season * 100L + fs$week
  idx <- which(fs_key < key)
  if (length(idx) == 0) return(list(recent = NA_real_, season_baseline = NA_real_, n_games_season = 0L, opportunity_total = 0))
  last_idx <- idx[which.max(fs_key[idx])]
  # n_games_season/opportunity_total must reset to the EVENT season, not
  # carry the prior season's THROUGH count, if the gap week is in a season
  # the player has no rows in yet this season (rookie-of-the-event-season
  # edge case, or a player who missed every game of a new season so far).
  same_season <- fs$season[last_idx] == season
  list(
    recent = fs$recent_through[last_idx],
    season_baseline = if (same_season) fs$season_through[last_idx] else NA_real_,
    n_games_season = if (same_season) fs$n_games_season[last_idx] else 0L,
    opportunity_total = if (same_season) fs$opportunity_total[last_idx] else 0
  )
}

# ===========================================================================
# BULK / vectorized versions (spec §35's performance requirement: "Phase 3
# must remain feasible for repeatable backtesting"). A per-row R-level loop
# calling baseline_asof() once per (event x beneficiary x dimension) was
# measured at ~1.7s/event -- infeasible for a full 15-season, thousand-plus-
# event build. These functions compute the IDENTICAL values (same
# fast_dimension_series()/baseline_asof() math, cross-checked in
# test-fast-baselines-match-phase2.R) for an entire batch of lookups in one
# vectorized data.table rolling join, using the same "roll backward to the
# nearest prior key" technique already proven correct in
# lib_absence_detection.R's attach_last_known_team().
# ===========================================================================

# ---------------------------------------------------------------------------
# precompute_all_dimension_series(): ONE dimension, EVERY player in
# `history_by_player`, in one pass. Returns a data.table with one row per
# (gsis_id, season, week) the player actually has a Phase 2 participation
# row for, keyed for the rolling join in bulk_baseline_asof().
# ---------------------------------------------------------------------------
precompute_all_dimension_series <- function(history_by_player, col, opp_col) {
  ids <- names(history_by_player)
  rows <- vector("list", length(ids))
  for (i in seq_along(ids)) {
    ph <- history_by_player[[i]]
    if (is.null(ph) || nrow(ph) == 0) next
    fs <- fast_dimension_series(ph[order(ph$season, ph$week), ], col, opp_col)
    fs$gsis_id <- ids[i]
    rows[[i]] <- fs
  }
  dt <- data.table::rbindlist(rows[!vapply(rows, is.null, logical(1))])
  dt[, event_key := season * 100L + week]
  data.table::setkeyv(dt, c("gsis_id", "event_key"))
  dt
}

# ---------------------------------------------------------------------------
# bulk_baseline_asof(): `lookup` has columns (gsis_id, season, week) -- one
# row per (event, dimension-applicable-player) needing a pre-event baseline.
# Returns `lookup` with recent/season_baseline/n_games_season/
# opportunity_total appended, via a single rolling join (roll = TRUE, "roll
# backward to nearest prior key") -- data.table's native, C-level
# implementation of exactly the per-row baseline_asof() logic above,
# including the same-season reset (done here as a vectorized post-join
# correction, identical semantics).
# ---------------------------------------------------------------------------
bulk_baseline_asof <- function(dim_dt, lookup) {
  lu <- data.table::as.data.table(lookup)
  lu[, event_key := season * 100L + week]
  lu[, lookup_key := event_key - 1L]
  data.table::setkeyv(lu, c("gsis_id", "lookup_key"))

  joined <- dim_dt[lu, on = .(gsis_id, event_key = lookup_key), roll = TRUE,
                   .(gsis_id, season = i.season, week = i.week,
                     matched_season = x.season, recent_through = x.recent_through,
                     season_through = x.season_through, n_games_season = x.n_games_season,
                     opportunity_total = x.opportunity_total)]

  same_season <- !is.na(joined$matched_season) & joined$matched_season == joined$season
  data.table::data.table(
    gsis_id = joined$gsis_id, season = joined$season, week = joined$week,
    recent = joined$recent_through,
    season_baseline = ifelse(same_season, joined$season_through, NA_real_),
    n_games_season = ifelse(same_season, joined$n_games_season, 0L),
    opportunity_total = ifelse(same_season, joined$opportunity_total, 0)
  )
}
