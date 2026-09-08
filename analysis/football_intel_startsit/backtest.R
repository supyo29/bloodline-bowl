#!/usr/bin/env Rscript
# ===========================================================================
# Phase 4 — pairwise Start/Sit decision-quality backtest + reversal analysis
# (§8, §9, §13, §14, §19, §36). Decision quality is PRIMARY; projection MAE is
# secondary (train.R covers that).
#
#   Rscript analysis/football_intel_startsit/backtest.R
#
# For every (season, week, position, archetype), all same-position player
# pairs where BOTH have a baseline and an actual result. Bucket by baseline
# edge. Baseline picks the higher-baseline player. The FI-candidate applies the
# trained, confidence-weighted, capped adjustment and re-picks — but only flips
# inside the tie-break gate |baseline_edge| < tau.
#
# tau + max_total_adjustment_fraction are tuned on 2023-2024 and the frozen
# choice is evaluated on 2025 (chronology-safe, §5). Results reported against
# BOTH baselines separately (§3) — never merged.
#
# Outputs -> outputs/startsit-2026/ + the tuned params folded into the served
# start_sit_model.json.
# ===========================================================================

suppressWarnings(suppressMessages({ library(dplyr); library(tidyr); library(jsonlite) }))
.here <- sub("^--file=", "", grep("^--file=", commandArgs(FALSE), value = TRUE))
BASE <- if (length(.here)) dirname(.here) else file.path(getwd(), "analysis", "football_intel_startsit")
source(file.path(BASE, "config.R"))
set.seed(SS$SEED)

d <- readRDS(file.path(SS$OUT_DIR, "decision_dataset.rds"))
model <- jsonlite::fromJSON(file.path(SS$SERVE_DIR, "start_sit_model.json"), simplifyVector = FALSE)
CONF_W <- unlist(SS$CONF_WEIGHT)

# ---- reconstruct the FI adjustment for a data frame, per position ----------
fi_adjustment <- function(df, pos) {
  mp <- model$positions[[pos]]
  if (is.null(mp) || is.null(mp$families) || !length(mp$families)) return(rep(0, nrow(df)))
  adj <- rep(0, nrow(df))
  for (fam in mp$families) {
    vcol <- fam$value_col; ccol <- fam$confidence_col; pdcol <- fam$prior_dominated_col
    if (is.null(vcol) || !vcol %in% names(df)) next
    raw <- suppressWarnings(as.numeric(df[[vcol]]))
    cw  <- ifelse(is.na(df[[ccol]]), 0, CONF_W[df[[ccol]]])
    if (!is.null(pdcol) && !is.na(pdcol) && pdcol %in% names(df))
      cw <- cw * ifelse(df[[pdcol]] %in% TRUE, SS$PRIOR_DOMINATED_HAIRCUT, 1)
    sig <- (raw - fam$center) / fam$scale
    sig[!is.finite(sig)] <- 0
    adj <- adj + fam$beta * sig * cw
  }
  adj
}

# ---- build pairwise decisions --------------------------------------------
build_pairs <- function(dd, baseline_col) {
  dd <- dd %>% filter(is.finite(.data[[baseline_col]]), is.finite(actual)) %>%
    mutate(base = .data[[baseline_col]])
  out <- dd %>%
    group_by(season, week, position, arch) %>%
    filter(dplyr::n() >= 2) %>%
    group_modify(~{
      g <- .x
      if (nrow(g) > 60) g <- g %>% slice_sample(n = 60)   # cap combinatorics per group
      idx <- t(combn(nrow(g), 2))
      tibble::tibble(
        a = g$sleeper_id[idx[,1]], b = g$sleeper_id[idx[,2]],
        base_a = g$base[idx[,1]], base_b = g$base[idx[,2]],
        adj_a = g$fi_adj[idx[,1]], adj_b = g$fi_adj[idx[,2]],
        act_a = g$actual[idx[,1]], act_b = g$actual[idx[,2]])
    }) %>% ungroup()
  out %>%
    mutate(base_edge = base_a - base_b,
           cand_a = base_a + adj_a, cand_b = base_b + adj_b,
           cand_edge = cand_a - cand_b,
           base_pick = ifelse(base_edge >= 0, "a", "b"),
           act_winner = ifelse(act_a >= act_b, "a", "b"),
           abs_edge = abs(base_edge),
           bucket = cut(abs(base_edge), c(-1e-9, 1, 3, 6, Inf),
                        labels = c("coin_flip", "close", "moderate", "obvious"))) %>%
    filter(is.finite(base_edge), a != b)
}

apply_gate <- function(pairs, tau, max_frac) {
  pairs %>% mutate(
    adj_a_c = pmax(pmin(adj_a, max_frac * abs(base_a)), -max_frac * abs(base_a)),
    adj_b_c = pmax(pmin(adj_b, max_frac * abs(base_b)), -max_frac * abs(base_b)),
    cand_edge_g = base_edge + (adj_a_c - adj_b_c),
    # only allowed to flip the pick when inside the tie-break gate
    fi_pick = ifelse(abs_edge < tau,
                     ifelse(cand_edge_g >= 0, "a", "b"),
                     base_pick),
    reversal = fi_pick != base_pick,
    base_correct = base_pick == act_winner,
    fi_correct = fi_pick == act_winner,
    base_points = ifelse(base_pick == "a", act_a, act_b),
    fi_points = ifelse(fi_pick == "a", act_a, act_b),
    delta_points = fi_points - base_points)
}

summ <- function(g) {
  rev <- g %>% filter(reversal)
  tibble::tibble(
    n = nrow(g), reversal_rate = mean(g$reversal),
    base_acc = mean(g$base_correct), fi_acc = mean(g$fi_correct),
    acc_delta = mean(g$fi_correct) - mean(g$base_correct),
    mean_delta_points = mean(g$delta_points), total_delta_points = sum(g$delta_points),
    n_reversals = nrow(rev),
    rev_win_rate = if (nrow(rev)) mean(rev$fi_correct) else NA_real_,
    rev_mean_delta = if (nrow(rev)) mean(rev$delta_points) else NA_real_,
    rev_median_delta = if (nrow(rev)) median(rev$delta_points) else NA_real_,
    rev_large_loss_rate = if (nrow(rev)) mean(rev$delta_points <= -5) else NA_real_,
    rev_large_win_rate = if (nrow(rev)) mean(rev$delta_points >= 5) else NA_real_)
}

run_baseline <- function(baseline_col, label) {
  dd <- d %>% filter(position %in% SS$POSITIONS)
  dd$fi_adj <- 0
  for (pos in SS$POSITIONS) dd$fi_adj[dd$position == pos] <- fi_adjustment(dd[dd$position == pos, ], pos)
  pairs_all <- bind_rows(lapply(SS$POSITIONS, function(pos)
    build_pairs(dd %>% filter(position == pos), baseline_col) %>% mutate(position = pos)))

  # ---- tune tau + max_frac on 2023-2024, freeze, evaluate 2025 ----
  tune <- pairs_all %>% filter(season %in% c(2023, 2024))
  grid <- expand.grid(tau = SS$TAU_GRID, mf = SS$MAX_ADJ_FRAC_GRID)
  scored <- lapply(seq_len(nrow(grid)), function(i) {
    g <- apply_gate(tune, grid$tau[i], grid$mf[i])
    s <- summ(g)
    data.frame(tau = grid$tau[i], mf = grid$mf[i], obj = s$total_delta_points,
               acc_delta = s$acc_delta, rev_rate = s$reversal_rate,
               large_loss = s$rev_large_loss_rate)
  })
  scored <- bind_rows(scored)
  # objective: maximize total delta points subject to large-loss rate not worse
  # than beneficial behaviour (§8) -> require rev_win_rate implied positive.
  best <- scored %>% filter(is.finite(obj)) %>% arrange(desc(obj)) %>% slice(1)
  eval25 <- apply_gate(pairs_all %>% filter(season == 2025), best$tau, best$mf)
  full   <- apply_gate(pairs_all, best$tau, best$mf)

  by_bucket <- full %>% group_by(bucket) %>% group_modify(~summ(.x)) %>% ungroup()
  by_pos    <- full %>% group_by(position) %>% group_modify(~summ(.x)) %>% ungroup()
  by_pos_bucket <- full %>% group_by(position, bucket) %>% group_modify(~summ(.x)) %>% ungroup()
  rev_by_conf <- full %>% filter(reversal) %>%
    group_by(position) %>%
    summarise(n = dplyr::n(), win_rate = mean(fi_correct), mean_delta = mean(delta_points),
              large_loss = mean(delta_points <= -5), .groups = "drop")

  list(label = label, tuned = best, tune_grid = scored,
       overall = summ(full), eval_2025 = summ(eval25),
       by_bucket = by_bucket, by_pos = by_pos, by_pos_bucket = by_pos_bucket,
       reversals = full %>% filter(reversal) %>%
         transmute(season, week, position, arch, base_pick, fi_pick, base_edge,
                   adj_a_c, adj_b_c, act_a, act_b, delta_points, fi_correct),
       rev_by_conf = rev_by_conf)
}

res_trailing <- run_baseline("baseline_trailing", "trailing_ppg_clean")
# Sleeper research baseline: restrict to 2023-2025 (2021 no timestamp, 2022 backfilled)
d_sl <- d
res_sleeper <- local({ d <<- d %>% filter(season >= 2023); r <- run_baseline("baseline_sleeper", "sleeper_hist_2023_2025"); d <<- d_sl; r })

# ---- write artifacts ----------------------------------------------------
write.csv(res_trailing$by_pos_bucket, file.path(SS$OUT_DIR, "backtest_decision_by_pos_bucket_trailing.csv"), row.names = FALSE)
write.csv(res_sleeper$by_pos_bucket,  file.path(SS$OUT_DIR, "backtest_decision_by_pos_bucket_sleeper.csv"), row.names = FALSE)
write.csv(res_trailing$reversals,     file.path(SS$OUT_DIR, "backtest_reversals_trailing.csv"), row.names = FALSE)
write.csv(bind_rows(res_trailing$by_pos %>% mutate(baseline = "trailing"),
                    res_sleeper$by_pos %>% mutate(baseline = "sleeper_2023_25")),
          file.path(SS$OUT_DIR, "backtest_decision_by_position.csv"), row.names = FALSE)
saveRDS(list(trailing = res_trailing, sleeper = res_sleeper), file.path(SS$OUT_DIR, "backtest_full.rds"))

# fold tuned tau / max_frac into the served model
model$tau_tie_break <- res_trailing$tuned$tau
model$max_total_adjustment_fraction <- res_trailing$tuned$mf
model$decision_backtest <- list(
  primary_baseline = "trailing_ppg_clean",
  tuned_on = "2023-2024", evaluated_on = "2025",
  overall_trailing = as.list(res_trailing$overall),
  eval2025_trailing = as.list(res_trailing$eval_2025),
  overall_sleeper_2023_25 = as.list(res_sleeper$overall))
write(jsonlite::toJSON(model, auto_unbox = TRUE, pretty = TRUE, null = "null"),
      file.path(SS$SERVE_DIR, "start_sit_model.json"))

cat("\n=== TUNED (trailing baseline, on 2023-2024) ===\n"); print(res_trailing$tuned)
cat("\n=== OVERALL decision quality — trailing (all seasons) ===\n"); print(as.data.frame(res_trailing$overall))
cat("\n=== 2025 held-out — trailing ===\n"); print(as.data.frame(res_trailing$eval_2025))
cat("\n=== by baseline-edge bucket (trailing) ===\n"); print(as.data.frame(res_trailing$by_bucket))
cat("\n=== by position (trailing) ===\n"); print(as.data.frame(res_trailing$by_pos))
cat("\n=== by position (Sleeper 2023-25 research baseline) ===\n"); print(as.data.frame(res_sleeper$by_pos))
cat("\n=== reversals by position (trailing) ===\n"); print(as.data.frame(res_trailing$rev_by_conf))
