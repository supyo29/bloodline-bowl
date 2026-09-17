#!/usr/bin/env Rscript
# ===========================================================================
# Player Role & Opportunity Intelligence — Checkpoint C recency backtest.
#
#   Rscript analysis/player_role/backtest.R
#
# Walk-forward comparison (chronology-safe, see lib_recency_backtest.R's
# header) of candidate recency estimators against next-same-season-game
# actual, across every season in Checkpoint B's substrate EXCEPT the current
# season (2026 is held out entirely -- it has only 1 week and cannot support
# a next-game evaluation yet; it is reserved for the live diagnostic).
# ===========================================================================
suppressWarnings(suppressMessages({ library(dplyr); library(jsonlite) }))

BASE <- file.path(getwd(), "analysis", "player_role")
source(file.path(BASE, "config.R"))
source(file.path(BASE, "lib_recency_backtest.R"))

pgr_full <- readRDS(file.path(ROLE$CACHE_DIR, "player_game_role.rds"))
pgr <- pgr_full %>% filter(season < ROLE$SEASON_CURRENT)  # 2026 held out -- see header
cat(sprintf("Backtest universe: seasons %d-%d, %d rows, %d players\n",
           min(pgr$season), max(pgr$season) , nrow(pgr), n_distinct(pgr$gsis_id)))

ESTIMATORS <- c("latest_game", "ma2", "ma3", "ewma_hl1", "ewma_hl2", "ewma_hl3", "season_avg")

METRICS <- c(
  snap_share_derived           = "PARTICIPATION",
  target_share                 = "RECEIVING",
  position_group_target_share  = "RECEIVING (position-group)",
  rush_share                   = "RUSHING",
  position_group_rush_share    = "RUSHING (position-group)",
  rz_target_share              = "HIGH_VALUE receiving",
  rz_carry_share                = "HIGH_VALUE rushing"
)

all_results <- list()
t0 <- Sys.time()
for (metric in names(METRICS)) {
  cat(sprintf("\n--- %s (%s) ---\n", metric, METRICS[[metric]]))
  bt <- run_recency_backtest(pgr, metric, min_games = 2)
  if (nrow(bt) == 0) { cat("  (no eligible rows)\n"); next }
  summ <- summarize_backtest(bt, ESTIMATORS)
  print(summ$overall)
  all_results[[metric]] <- summ
}
cat(sprintf("\nTotal backtest runtime: %.1fs\n", as.numeric(difftime(Sys.time(), t0, units = "secs"))))

# ---- winner selection: lowest overall MAE per metric ----------------------
winners <- purrr::imap_dfr(all_results, function(summ, metric) {
  best <- summ$overall %>% slice_min(mae, n = 1, with_ties = FALSE)
  tibble::tibble(metric = metric, winner = best$estimator, mae = best$mae, n = best$n)
})
cat("\n=== Winning estimator per metric (by MAE) ===\n")
print(winners)

# ---- position-level breakdown for the winning estimator per metric --------
cat("\n=== By-position MAE for each metric's overall winner ===\n")
for (i in seq_len(nrow(winners))) {
  m <- winners$metric[i]; w <- winners$winner[i]
  cat(sprintf("\n%s (winner: %s)\n", m, w))
  print(all_results[[m]]$by_position %>% filter(estimator == w) %>% arrange(desc(n)))
}

# ---- early-season vs midseason breakdown for the winner --------------------
cat("\n=== Early-season (wk<=3) vs midseason MAE for each metric's overall winner ===\n")
for (i in seq_len(nrow(winners))) {
  m <- winners$metric[i]; w <- winners$winner[i]
  cat(sprintf("\n%s (winner: %s)\n", m, w))
  print(all_results[[m]]$by_phase %>% filter(estimator == w))
}

dir.create(ROLE$CACHE_DIR, showWarnings = FALSE, recursive = TRUE)
saveRDS(all_results, file.path(ROLE$CACHE_DIR, "recency_backtest_results.rds"))
write.csv(winners, file.path(ROLE$CACHE_DIR, "recency_backtest_winners.csv"), row.names = FALSE)
cat("\nSaved: analysis/player_role/cache/recency_backtest_results.rds, recency_backtest_winners.csv\n")
