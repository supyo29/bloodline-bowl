#!/usr/bin/env Rscript
# ===========================================================================
# Phase 5 — win-probability CALIBRATION backtest + ablation decomposition
# (spec §10, §12, §27). Chronology-safe; SYNTHETIC-primary with a REAL
# `devoted` cross-check; results ALWAYS reported separately (spec §10, §14).
#
#   Rscript analysis/football_intel_matchup/calibration_backtest.R
#
# Ablation layers (spec §27), each producing a win probability per matchup:
#   L0_score_diff   analytic  Phi(margin_mean / margin_sd_from_weeklyBand)
#   L1_current_mc   independent draws + weeklyBand CV + max(0,Normal)   [CONTROL]
#   L2_calibrated   independent draws + the calibrated marginal model (fit_distributions)
#   L3_twofactor    L2 marginals + the 2-factor dependence (fit_correlations)
#
# A layer must beat the layer below it OUT OF SAMPLE on Brier + log loss to be
# retained (spec §12, §28). The 2-factor model is NOT auto-certified.
#
# Output: outputs/matchup-2026/calibration_backtest.csv + calibration_curve.csv
# ===========================================================================

suppressWarnings(suppressMessages({ library(dplyr); library(tidyr); library(jsonlite) }))
.here <- sub("^--file=", "", grep("^--file=", commandArgs(FALSE), value = TRUE))
BASE <- if (length(.here)) dirname(.here) else file.path(getwd(), "analysis", "football_intel_matchup")
source(file.path(BASE, "config.R"))
set.seed(MI$SEED)

d <- readRDS(file.path(MI$OUT_DIR, "residual_dataset.rds")) %>%
  filter(arch == MI$PRIMARY_ARCHETYPE, is.finite(baseline_sleeper), is.finite(actual),
         position %in% MI$ALL_POS)
dist_m <- fromJSON(file.path(MI$SERVE_DIR, "matchup_distribution_model.json"), simplifyVector = FALSE)
corr_m <- fromJSON(file.path(MI$SERVE_DIR, "matchup_correlation_model.json"), simplifyVector = FALSE)

# standard Bloodline starting lineup
SLOTS <- c("QB","RB","RB","WR","WR","WR","TE","FLEX","K","DEF")
FLEX_ELIG <- c("RB","WR","TE")
SIM_N <- 2000L
MATCHUPS_PER_WEEK <- 240L

# ---- per-position samplers from the served model ----------------------
sd_fn_of <- function(sp) {
  N <- function(x) as.numeric(unlist(x))
  switch(as.character(sp$kind),
    const  = { s <- N(sp$s); function(px) rep(s, length(px)) },
    cv     = { cvv <- N(sp$cv); function(px) pmax(2, abs(px) * cvv) },
    bucket = { br <- N(sp$breaks); sv <- N(sp$sd)
               function(px){ i <- as.integer(cut(px, br)); i[is.na(i)] <- 1L; v <- sv[i]; v[!is.finite(v)] <- median(sv, na.rm=TRUE); as.numeric(v) } },
    linear = { a <- N(sp$a); b <- N(sp$b); function(px) pmax(2, a + b * px) },
    sqrt   = { a <- N(sp$a); b <- N(sp$b); function(px) pmax(2, a + b * sqrt(pmax(px, 0))) })
}
mk_sampler <- function(pm) {
  bias <- as.numeric(pm$mean_bias_correction %||% 0)
  sd_fn <- sd_fn_of(pm$sd_params)
  zg <- if (!is.null(pm$z_grid)) as.numeric(unlist(pm$z_grid)) else NULL
  bw <- as.numeric(pm$bust_weight %||% 0)
  fam <- pm$marginal
  function(proj, n, qd = FALSE) {
    mu <- proj + bias
    s <- sd_fn(mu) * (if (qd) (pm$injury_widen_factor %||% 1) else 1)
    if (fam == "normal_clamp" || is.null(zg)) return(pmax(0, rnorm(n, mu, s)))
    if (fam == "mixture" && bw > 0) {
      bust <- runif(n) < bw
      out <- numeric(n)
      out[bust] <- pmax(0, rnorm(sum(bust), 0.3, 0.4))
      k <- sum(!bust); z <- approx(seq(0,1,length.out=length(zg)), zg, xout=runif(k), rule=2)$y
      out[!bust] <- pmax(0, mu[!bust] + s[!bust] * z); return(out)
    }
    z <- approx(seq(0,1,length.out=length(zg)), zg, xout=runif(n), rule=2)$y
    pmax(0, mu + s * z)
  }
}
`%||%` <- function(a,b) if (is.null(a)) b else a
SAMP <- lapply(dist_m$positions, mk_sampler)

# team-passing / game-scoring loadings
tp_load <- corr_m$team_passing_factor$catcher_loadings
gs_qb <- as.numeric(corr_m$game_scoring_factor$qb_loading %||% 0)
dst_oppqb <- as.numeric(corr_m$game_scoring_factor$dst_oppqb_corr %||% 0)
catch_l <- function(pos) { v <- tp_load[[pos]]; if (is.null(v)) 0 else as.numeric(v) }

# ---- build a legal random lineup from a week's player pool ------------
rand_lineup <- function(pool) {
  pick <- function(pos, k) { cand <- pool %>% filter(position == pos); if (nrow(cand) < k) return(NULL); cand %>% slice_sample(n = k) }
  qb <- pick("QB",1); k <- pick("K",1); de <- pick("DEF",1); te <- pick("TE",1)
  rb <- pick("RB",2); wr <- pick("WR",3)
  if (any(sapply(list(qb,k,de,te,rb,wr), is.null))) return(NULL)
  used <- c(qb$sleeper_id, k$sleeper_id, de$sleeper_id, te$sleeper_id, rb$sleeper_id, wr$sleeper_id)
  flexcand <- pool %>% filter(position %in% FLEX_ELIG, !sleeper_id %in% used)
  if (nrow(flexcand) == 0) return(NULL)
  fl <- flexcand %>% slice_sample(n = 1)
  bind_rows(qb,rb,wr,te,fl,k,de) %>%
    mutate(slot = c("QB","RB","RB","WR","WR","WR","TE","FLEX","K","DEF"))
}

wp_layers <- function(A, B) {
  # A, B: lineup tibbles with position, baseline_sleeper, qd, actual, team, opponent, is_qb_of_game
  proj_sum <- function(L) sum(L$baseline_sleeper)
  # L0 analytic: margin mean/sd from weeklyBand CV
  wb_sd <- function(L) sqrt(sum((pmax(2, abs(L$baseline_sleeper) * MI$WEEKLYBAND_CV[L$position]))^2))
  mA <- proj_sum(A); mB <- proj_sum(B)
  L0 <- pnorm((mA - mB) / sqrt(wb_sd(A)^2 + wb_sd(B)^2))

  draw_team <- function(L, layer, qb_factor = NULL, game_factor = NULL) {
    tot <- numeric(SIM_N)
    # team passing factor for THIS lineup's QB
    f_tp <- rnorm(SIM_N)
    for (i in seq_len(nrow(L))) {
      pos <- L$position[i]; pj <- L$baseline_sleeper[i]
      if (layer == "L1") { s <- pmax(2, abs(pj) * MI$WEEKLYBAND_CV[pos]); x <- pmax(0, rnorm(SIM_N, pj, s)) }
      else {
        base <- SAMP[[pos]](rep(pj, SIM_N), SIM_N, qd = isTRUE(L$qd[i]))
        if (layer == "L3") {
          # inject dependence via a standardized shared shock added to the z-part.
          # approx: convert to z, add loadings*factors, convert back with position sd.
          pm <- dist_m$positions[[pos]]; bias <- as.numeric(pm$mean_bias_correction %||% 0)
          mu <- pj + bias
          sd_here <- sd_fn_of(pm$sd_params)(rep(mu, SIM_N))
          L_tp <- if (pos == "QB") 1 else if (pos %in% c("WR","TE","RB")) catch_l(pos) else 0
          L_gs <- if (pos == "QB") gs_qb else if (pos == "DEF") 0 else 0
          shared <- L_tp * f_tp + L_gs * (game_factor %||% rnorm(SIM_N))
          if (pos == "DEF") shared <- dst_oppqb * (qb_factor %||% rnorm(SIM_N))  # DST loads OPP passing
          idio_sd <- sqrt(max(1e-6, 1 - L_tp^2 - L_gs^2))
          base <- pmax(0, mu + sd_here * (shared + idio_sd * rnorm(SIM_N)))
        }
        x <- base
      }
      tot <- tot + x
    }
    list(tot = tot, f_tp = f_tp)
  }
  # L1
  a1 <- draw_team(A, "L1"); b1 <- draw_team(B, "L1"); L1 <- mean(a1$tot > b1$tot) + 0.5*mean(a1$tot == b1$tot)
  # L2
  a2 <- draw_team(A, "L2"); b2 <- draw_team(B, "L2"); L2 <- mean(a2$tot > b2$tot) + 0.5*mean(a2$tot == b2$tot)
  # L3 (shared game factor across both lineups)
  fg <- rnorm(SIM_N)
  a3 <- draw_team(A, "L3", game_factor = fg); b3 <- draw_team(B, "L3", game_factor = fg, qb_factor = a3$f_tp)
  # DST bring-back: A's DST vs B's QB factor
  L3 <- mean(a3$tot > b3$tot) + 0.5*mean(a3$tot == b3$tot)
  c(L0_score_diff = L0, L1_current_mc = L1, L2_calibrated = L2, L3_twofactor = L3)
}

run_synth <- function(dd, label) {
  rows <- list()
  for (s in MI$OUTER_TEST_SEASONS) for (w in MI$MIN_WEEK:MI$MAX_WEEK) {
    pool <- dd %>% filter(season == s, week == w, is.finite(baseline_sleeper), is.finite(actual)) %>%
      mutate(qd = injury_status %in% MI$INJURY_WIDEN_STATES)
    if (nrow(pool) < 40) next
    for (mnum in seq_len(MATCHUPS_PER_WEEK)) {
      A <- rand_lineup(pool); B <- rand_lineup(pool)
      if (is.null(A) || is.null(B)) next
      if (length(intersect(A$sleeper_id, B$sleeper_id)) > 0) next
      wp <- wp_layers(A, B)
      rows[[length(rows)+1]] <- data.frame(season = s, week = w,
        actual_win = as.integer(sum(A$actual) > sum(B$actual)),
        t(wp))
    }
  }
  R <- bind_rows(rows)
  metrics <- lapply(c("L0_score_diff","L1_current_mc","L2_calibrated","L3_twofactor"), function(col) {
    p <- pmin(pmax(R[[col]], 1e-4), 1 - 1e-4); y <- R$actual_win
    data.frame(source = label, layer = col, n = nrow(R),
               brier = mean((p - y)^2), logloss = -mean(y*log(p) + (1-y)*log(1-p)),
               auc = { o <- order(p); r <- rank(p); (sum(r[y==1]) - sum(y)*(sum(y)+1)/2) / (sum(y)*sum(y==0)) },
               cal_slope = tryCatch(coef(glm(y ~ qlogis(p), family=binomial))[2], error=function(e) NA))
  })
  list(rows = R, metrics = bind_rows(metrics))
}

message("SYNTHETIC backtest ...")
synth <- run_synth(d, "SYNTHETIC_MATCHUPS")
write.csv(synth$metrics, file.path(MI$OUT_DIR, "calibration_backtest_synthetic.csv"), row.names = FALSE)

# calibration curve (deciles) for each layer, synthetic
cc <- bind_rows(lapply(c("L1_current_mc","L2_calibrated","L3_twofactor"), function(col) {
  synth$rows %>% mutate(bucket = cut(.data[[col]], seq(0,1,0.1), include.lowest = TRUE)) %>%
    group_by(bucket) %>% summarise(layer = col, n = n(), mean_pred = mean(.data[[col]]),
                                   emp_win = mean(actual_win), .groups = "drop")
}))
write.csv(cc, file.path(MI$OUT_DIR, "calibration_curve.csv"), row.names = FALSE)

cat("\n=== SYNTHETIC calibration (walk-forward 2023-2025) ===\n")
print(as.data.frame(synth$metrics), row.names = FALSE, digits = 4)
cat("\n=== calibration curve (L2 calibrated) ===\n")
print(as.data.frame(cc %>% filter(layer == "L2_calibrated") %>% select(bucket, n, mean_pred, emp_win)), row.names = FALSE, digits = 3)
cat("\n=== ablation verdict ===\n")
m <- synth$metrics
d_L1L2 <- m$brier[m$layer=="L1_current_mc"] - m$brier[m$layer=="L2_calibrated"]
d_L2L3 <- m$brier[m$layer=="L2_calibrated"] - m$brier[m$layer=="L3_twofactor"]
cat(sprintf("  L1->L2 (calibrated marginals):  Brier %+.5f  logloss %+.5f  %s\n",
    d_L1L2, m$logloss[m$layer=="L1_current_mc"]-m$logloss[m$layer=="L2_calibrated"],
    if (d_L1L2 > 0.0005) "IMPROVES" else "no material gain"))
cat(sprintf("  L2->L3 (2-factor dependence):   Brier %+.5f  logloss %+.5f  %s\n",
    d_L2L3, m$logloss[m$layer=="L2_calibrated"]-m$logloss[m$layer=="L3_twofactor"],
    if (d_L2L3 > 0.0005) "KEEP twofactor" else "REJECT twofactor — no incremental calibration value (use independent + calibrated marginals)"))
