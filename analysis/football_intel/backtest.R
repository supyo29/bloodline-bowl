#!/usr/bin/env Rscript
# ===========================================================================
# Football Intelligence — chronology-safe walk-forward backtest
# (spec §17, §18, §19, §20, §31, §36).
#
#   Rscript analysis/football_intel/backtest.R
#
# For each (test_season in FI$BACKTEST_SEASONS, week W in [MIN_WEEK, MAX_WEEK]):
#   * priors are rebuilt from seasons < test_season ONLY
#   * the modeled rating is computed from games with week < W ONLY
#   * predictors are scored against the team's ACTUAL week-W..W+3 outcome
# No future week ever enters a fit. Rolling-origin, not a random split.
#
# Predictors compared (spec §31):
#   B0  league mean                     (0 deviation)
#   B1  season-to-date raw mean         (< W)
#   B2  exponentially-weighted raw mean (< W, recency only)
#   B3  prior-season opponent-adjusted rating only
#   CAND  full modeled (opp-adj + prior + recency + shrink)
#
# Outputs -> outputs/football-intel-2026/ :
#   backtest_baseline_comparison.csv   MAE/RMSE/spearman by predictor x metric
#   backtest_incremental_value.csv     paired bootstrap CAND vs best baseline
#   backtest_reliability_by_week.csv   CAND error by week-of-season
#   backtest_reliability_by_conf.csv   CAND error by confidence bucket
#   backtest_feature_status.csv        KEEP / DESCRIPTIVE / DEFER per feature (spec guardrail 4)
# ===========================================================================

suppressWarnings(suppressMessages({ library(dplyr); library(tidyr) }))
.here <- sub("^--file=", "", grep("^--file=", commandArgs(FALSE), value = TRUE))
BASE <- if (length(.here)) dirname(.here) else file.path(getwd(), "analysis", "football_intel")
source(file.path(BASE, "config.R"))
source(file.path(BASE, "lib_features.R"))
source(file.path(BASE, "lib_opponent_adj.R"))
source(file.path(BASE, "lib_priors.R"))
source(file.path(BASE, "lib_recency.R"))
source(file.path(BASE, "lib_profiles.R"))
source(file.path(FI$ROOT, "analysis", "phase3_lib.R"))  # metric_set, paired_boot

set.seed(FI$SEED)
cache <- function(n) readRDS(file.path(FI$CACHE_DIR, paste0(n, ".rds")))
pbp <- cache("pbp"); participation <- cache("participation")
pfr_pass <- cache("pfr_pass"); pfr_def <- cache("pfr_def")

tgf_path <- file.path(FI$CACHE_DIR, "team_game_features.rds")
tgf <- if (file.exists(tgf_path)) readRDS(tgf_path) else {
  x <- build_team_game_features(pbp, participation, pfr_pass, pfr_def, FI); saveRDS(x, tgf_path); x
}
tgf <- tgf %>% filter(season_type == "REG")

# headline metrics evaluated (a subset with the longest clean history)
BT_METRICS <- Filter(function(s) s$key %in% c(
  "off_pass_epa", "off_rush_epa", "off_success_rate", "off_explosive_pass_rate",
  "def_pass_epa_allowed", "def_rush_epa_allowed", "def_success_allowed",
  "off_proe", "off_pace_sec_play"), METRIC_SPECS)

# per-season opponent-adjusted ratings, all seasons once (for priors + B3)
message("per-season ratings (all) ...")
all_seasons <- sort(unique(tgf$season))
season_ratings <- bind_rows(lapply(BT_METRICS, function(sp)
  season_ratings_for_metric(tgf, sp, FI, all_seasons)))

score_rows <- list()
for (sp in BT_METRICS) {
  psd <- pooled_game_sd(tgf, sp)
  k <- FI$SHRINK_K[[sp$family]]
  side_rows <- tgf %>% filter(side == sp$side) %>%
    transmute(season, week, team, opponent, y = .data[[sp$value]], w = .data[[sp$weight]])
  pr_metric <- season_ratings %>% filter(metric == sp$key, side == sp$side)

  for (ts in FI$BACKTEST_SEASONS) {
    priors_ts <- build_season_priors(pr_metric %>% select(season, team, side, metric, rating), ts, FI)
    b3 <- priors_ts %>% transmute(team, b3 = prior_mean)
    sd_ts <- side_rows %>% filter(season == ts)
    if (nrow(sd_ts) < 50) next
    lm_by_wk <- sd_ts %>% arrange(week) %>% mutate(cum = cumsum(y * w)) # placeholder

    for (W in FI$BACKTEST_MIN_WEEK:FI$BACKTEST_MAX_WEEK) {
      hist <- sd_ts %>% filter(week < W)
      fut  <- sd_ts %>% filter(week >= W, week <= W + 3)
      if (nrow(hist) < 20 || nrow(fut) < 10) next
      league_mu_hist <- weighted.mean(hist$y, hist$w, na.rm = TRUE)

      # CAND: opponent-adjust hist, recency weight, shrink to prior->league
      hw <- hist %>% mutate(rw = w * recency_weight(max(week) - week, FI$RECENCY_HALFLIFE_GAMES))
      fit <- opponent_adjust_metric(hw %>% select(team, opponent, y, w = rw),
                                    ridge = FI$OPP_ADJ_RIDGE_LAMBDA, min_w = 1)
      if (is.null(fit)) next
      eff <- hw %>% group_by(team) %>% summarise(eff = sum(rw), .groups = "drop")
      cand <- tibble::tibble(team = names(fit$off), off_dev = as.numeric(fit$off)) %>%
        left_join(eff, by = "team") %>%
        left_join(priors_ts %>% transmute(team, prior_mean, prior_ws = prior_weight_sum), by = "team") %>%
        rowwise() %>%
        mutate(cand_dev = shrink_to(off_dev, eff, prior_mean,
                                    coalesce(prior_ws, 0) * k, 0, k)$estimate) %>%
        ungroup() %>%
        mutate(cand = league_mu_hist + cand_dev,
               # in-season-sample confidence axis (no prior inflation) so the
               # reliability-by-confidence table has a real spread to check.
               conf = confidence_bucket(coalesce(eff, 0), FI$CONF_THRESHOLDS[[sp$family]]),
               weeks_played = W - 1)

      # B1 season-to-date raw, B2 EW raw
      b12 <- hist %>% group_by(team) %>%
        summarise(b1 = weighted.mean(y, w),
                  b2 = weighted.mean(y, w * recency_weight(max(hist$week) - week, FI$RECENCY_HALFLIFE_GAMES)),
                  .groups = "drop")
      # outcome: team's raw mean over W..W+3
      out <- fut %>% group_by(team) %>% summarise(y_future = weighted.mean(y, w), .groups = "drop")

      j <- out %>%
        inner_join(cand %>% select(team, cand, conf, weeks_played), by = "team") %>%
        left_join(b12, by = "team") %>%
        left_join(b3, by = "team") %>%
        mutate(b0 = league_mu_hist,
               b3 = league_mu_hist + coalesce(b3, 0),
               metric = sp$key, season = ts, week = W)
      score_rows[[length(score_rows) + 1]] <- j
    }
  }
  message("  done ", sp$key)
}

S <- bind_rows(score_rows)
saveRDS(S, file.path(FI$OUT_DIR, "backtest_scores.rds"))

# ---- baseline comparison -------------------------------------------------
long <- S %>%
  pivot_longer(c(b0, b1, b2, b3, cand), names_to = "predictor", values_to = "pred") %>%
  filter(is.finite(pred), is.finite(y_future))
bc <- long %>% group_by(metric, predictor) %>%
  summarise(n = dplyr::n(),
            mae = mean(abs(pred - y_future)),
            rmse = sqrt(mean((pred - y_future)^2)),
            spearman = suppressWarnings(cor(pred, y_future, method = "spearman")),
            .groups = "drop") %>%
  arrange(metric, mae)
write.csv(bc, file.path(FI$OUT_DIR, "backtest_baseline_comparison.csv"), row.names = FALSE)

# ---- incremental value: CAND vs best baseline (paired bootstrap) --------
iv <- bind_rows(lapply(unique(S$metric), function(m) {
  d <- S %>% filter(metric == m, is.finite(cand), is.finite(y_future))
  base_maes <- c(b0 = mean(abs(d$b0 - d$y_future), na.rm = TRUE),
                 b1 = mean(abs(d$b1 - d$y_future), na.rm = TRUE),
                 b2 = mean(abs(d$b2 - d$y_future), na.rm = TRUE),
                 b3 = mean(abs(d$b3 - d$y_future), na.rm = TRUE))
  best <- names(which.min(base_maes))
  pb <- paired_boot(d$cand, d[[best]], d$y_future, R = 2000, seed = FI$SEED)
  tibble::tibble(metric = m, n = pb["n"], best_baseline = best,
                 best_baseline_mae = min(base_maes),
                 cand_mae = mean(abs(d$cand - d$y_future), na.rm = TRUE),
                 mean_delta = pb["mean_d"], ci_lo = pb["lo"], ci_hi = pb["hi"],
                 p_cand_better = pb["p_improve"])
}))
write.csv(iv, file.path(FI$OUT_DIR, "backtest_incremental_value.csv"), row.names = FALSE)

# ---- reliability by week-of-season + by confidence --------------------
rbw <- S %>% filter(is.finite(cand), is.finite(y_future)) %>%
  mutate(week_bucket = cut(weeks_played, c(0, 4, 8, 12, 30), labels = c("1-4", "5-8", "9-12", "13+"))) %>%
  group_by(metric, week_bucket) %>%
  summarise(n = dplyr::n(), cand_mae = mean(abs(cand - y_future)),
            b1_mae = mean(abs(b1 - y_future), na.rm = TRUE),
            cand_beats_b1 = mean(abs(cand - y_future) < abs(b1 - y_future)), .groups = "drop")
write.csv(rbw, file.path(FI$OUT_DIR, "backtest_reliability_by_week.csv"), row.names = FALSE)

rbc <- S %>% filter(is.finite(cand), is.finite(y_future)) %>%
  group_by(metric, conf) %>%
  summarise(n = dplyr::n(), cand_mae = mean(abs(cand - y_future)),
            cand_rmse = sqrt(mean((cand - y_future)^2)), .groups = "drop")
write.csv(rbc, file.path(FI$OUT_DIR, "backtest_reliability_by_conf.csv"), row.names = FALSE)

# ---- feature status (spec guardrail 4) --------------------------------
status <- iv %>%
  mutate(final_status = case_when(
    p_cand_better >= 0.90 & cand_mae < best_baseline_mae ~ "KEEP",
    p_cand_better >= 0.60                                ~ "KEEP_WEAK",
    TRUE                                                 ~ "DEFER_OR_DESCRIPTIVE"),
    backtest_result = sprintf("cand MAE %.4f vs best baseline (%s) %.4f", cand_mae, best_baseline, best_baseline_mae),
    incremental_signal = sprintf("P(cand better)=%.2f, delta=%.4f [%.4f, %.4f]", p_cand_better, mean_delta, ci_lo, ci_hi)) %>%
  transmute(feature = metric, candidate = "IN", backtest_result, incremental_signal, final_status)
write.csv(status, file.path(FI$OUT_DIR, "backtest_feature_status.csv"), row.names = FALSE)

cat("\n=== baseline comparison (MAE) ===\n")
print(bc %>% select(metric, predictor, n, mae, spearman) %>% as.data.frame(), row.names = FALSE)
cat("\n=== incremental value (CAND vs best baseline) ===\n")
print(iv %>% as.data.frame(), row.names = FALSE)
cat("\n=== feature status ===\n")
print(status %>% select(feature, final_status) %>% as.data.frame(), row.names = FALSE)
