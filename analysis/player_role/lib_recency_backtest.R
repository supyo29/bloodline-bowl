# ===========================================================================
# Player Role & Opportunity Intelligence — Checkpoint C recency backtest.
#
# Walk-forward comparison of candidate recency/prior estimators against
# next-game share, per spec §15/§28/§29/§30. Operates ONLY on Checkpoint B's
# already-built, already-tested player_game_role substrate -- no new raw
# ingestion, no re-audit of the substrate itself.
#
# Chronology safety: for player-game row i (ordered season, week within
# player), every candidate estimator uses ONLY rows <= i. The evaluation
# target is the value at the very next SAME-SEASON row (i+1) -- cross-season
# transitions (offseason team/role change) are excluded from this
# persistence backtest, since that is a materially different, harder
# question (spec §16's discontinuity handling) than in-season week-to-week
# persistence.
# ===========================================================================

suppressWarnings(suppressMessages({ library(dplyr); library(tidyr); library(purrr) }))

# Explicit-weight EWMA (not a recursive filter): weight of the k-th-most-
# recent observation is 0.5^(k/halflife). Defined for any length >= 1,
# handles irregular/short sequences without an init-value hack, and is used
# both by this backtest and by the actual role-profile model, so it is
# verified once here and reused unchanged everywhere (no drift between what
# was backtested and what runs live).
ewma_through <- function(x, halflife) {
  n <- length(x)
  if (n == 0) return(NA_real_)
  # weight of the k-th-most-recent observation (k=0 is the latest)
  k <- (n - 1):0
  w <- 0.5^(k / halflife)
  sum(w * x) / sum(w)
}

# ---------------------------------------------------------------------------
# candidate_estimates(): for ONE player's chronologically-ordered metric
# series, compute every candidate estimator's value AT each row using only
# data through that row (inclusive), plus the same-season next-game actual.
# ---------------------------------------------------------------------------
candidate_estimates_for_player <- function(df, metric_col, halflifes = c(1, 2, 3)) {
  x <- df[[metric_col]]
  n <- length(x)
  if (n < 2) return(NULL)

  out <- vector("list", n - 1)
  for (i in seq_len(n - 1)) {
    hist <- x[1:i]
    hist_valid <- hist[!is.na(hist)]
    if (length(hist_valid) == 0) next
    actual_next <- x[i + 1]
    if (is.na(actual_next)) next
    if (df$season[i + 1] != df$season[i]) next  # cross-season transition excluded (see header)

    row <- list(
      gsis_id = df$gsis_id[i], season = df$season[i], week = df$week[i],
      position = df$position[i], n_games_seen = length(hist_valid),
      actual_next = actual_next,
      latest_game = tail(hist_valid, 1),
      ma2 = if (length(hist_valid) >= 2) mean(tail(hist_valid, 2)) else NA_real_,
      ma3 = if (length(hist_valid) >= 3) mean(tail(hist_valid, 3)) else NA_real_,
      season_avg = mean(hist[df$season[1:i] == df$season[i]], na.rm = TRUE)
    )
    for (hl in halflifes) row[[paste0("ewma_hl", hl)]] <- ewma_through(hist_valid, hl)
    out[[i]] <- row
  }
  bind_rows(out)
}

# ---------------------------------------------------------------------------
# run_recency_backtest(): the full walk-forward comparison for one metric,
# across every player with >=2 games in the substrate.
# ---------------------------------------------------------------------------
run_recency_backtest <- function(pgr, metric_col, min_games = 2, halflifes = c(1, 2, 3)) {
  ordered <- pgr %>% filter(!is.na(.data[[metric_col]])) %>%
    arrange(gsis_id, season, week) %>%
    group_by(gsis_id) %>% filter(dplyr::n() >= min_games) %>%
    group_split()

  results <- purrr::map(ordered, ~ candidate_estimates_for_player(.x, metric_col, halflifes))
  bind_rows(results)
}

# ---------------------------------------------------------------------------
# summarize_backtest(): MAE per estimator, overall and by position/season-phase.
# ---------------------------------------------------------------------------
summarize_backtest <- function(bt, estimators) {
  bt_long <- bt %>%
    tidyr::pivot_longer(all_of(estimators), names_to = "estimator", values_to = "estimate") %>%
    filter(!is.na(estimate)) %>%
    mutate(abs_err = abs(estimate - actual_next), sq_err = (estimate - actual_next)^2)

  overall <- bt_long %>% group_by(estimator) %>%
    summarise(n = dplyr::n(), mae = mean(abs_err), rmse = sqrt(mean(sq_err)), .groups = "drop") %>%
    arrange(mae)

  by_position <- bt_long %>% group_by(estimator, position) %>%
    summarise(n = dplyr::n(), mae = mean(abs_err), .groups = "drop")

  by_phase <- bt_long %>% mutate(phase = ifelse(week <= 3, "early_season", "midseason")) %>%
    group_by(estimator, phase) %>%
    summarise(n = dplyr::n(), mae = mean(abs_err), .groups = "drop")

  list(overall = overall, by_position = by_position, by_phase = by_phase)
}
