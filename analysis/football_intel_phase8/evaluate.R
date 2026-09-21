#!/usr/bin/env Rscript
# ===========================================================================
# Phase 8 — FI feature-family x position certification evaluation.
#
#   Rscript analysis/football_intel_phase8/evaluate.R dev       # stage 1 (2023, 2024 development folds)
#   Rscript analysis/football_intel_phase8/evaluate.R holdout   # stage 2 (2025; ONLY candidates that survived stage 1)
#
# Implements analysis/football_intel_phase8/certification_criteria.json (fi-recert-criteria-2026.1), which was
# committed BEFORE this script was run. READ-ONLY on the served model and on decision_dataset.rds: nothing here
# writes lib/weekly/data or any deployment state. Output is committed evidence under analysis/football_intel_phase8/results/.
#
# Baseline: baseline_sleeper (RECONSTRUCTED_PRODUCTION_LIKE; never called "historical production").
# Lane: RECONSTRUCTED_CHRONOLOGY_SAFE (FI features rebuilt as-of W-1). Training seasons are strictly < the test season.
# Pairs with an exactly tied baseline are excluded (the baseline defines no pick). Rows need finite baseline + actual.
# ===========================================================================
suppressWarnings(suppressMessages({ library(dplyr); library(jsonlite) }))
args  <- commandArgs(trailingOnly = TRUE)
stage <- if (length(args)) args[[1]] else "dev"
stopifnot(stage %in% c("dev", "holdout"))
ROOT <- getwd()
# plumbing only (Phase 8 future-mutation test): P8_DATASET / P8_OUT default to the real dataset and the committed results dir.
OUT <- Sys.getenv("P8_OUT", file.path(ROOT, "analysis", "football_intel_phase8", "results")); dir.create(OUT, showWarnings = FALSE, recursive = TRUE)
DATASET <- Sys.getenv("P8_DATASET", file.path(ROOT, "outputs", "startsit-2026", "decision_dataset.rds"))
crit <- fromJSON(file.path(ROOT, "analysis", "football_intel_phase8", "certification_criteria.json"), simplifyVector = FALSE)

B        <- 2000L
SEED     <- 20260921L
CONF_W   <- c(HIGH = 1, MEDIUM = 0.5, LOW = 0.2, INSUFFICIENT_SAMPLE = 0)
HAIRCUT  <- 0.6
CAP      <- 0.25
LAMBDAS  <- c(0, 100, 1000, 10000)
TAUS     <- c(0.5, 1, 1.5, 2, 3)
MIN_EFFECT <- 0.03            # fantasy points MAE improvement
SEVERE   <- 8                 # fantasy points
POS_FAMILIES <- list(
  QB = c("off_pass_epa","off_success_rate","off_proe","off_pace_sec_play","off_explosive_pass_rate","def_success_allowed","interaction_pass_epa_vs_pass_defense"),
  RB = c("off_rush_epa","off_success_rate","off_pace_sec_play","def_success_allowed","usage_snap_share","usage_rush_share","usage_target_share","interaction_rush_epa_vs_rush_defense"),
  WR = c("off_pass_epa","off_success_rate","off_proe","off_pace_sec_play","off_explosive_pass_rate","def_success_allowed","usage_target_share","usage_route_participation","interaction_pass_epa_vs_pass_defense"),
  TE = c("off_pass_epa","off_success_rate","off_pace_sec_play","def_success_allowed","usage_target_share","usage_route_participation"))
SERVED <- list(QB = c("def_success_allowed","off_explosive_pass_rate"), RB = c("off_pace_sec_play","usage_snap_share"),
  WR = c("def_success_allowed","interaction_pass_epa_vs_pass_defense","off_explosive_pass_rate","off_pass_epa","off_proe"), TE = c("off_pace_sec_play","usage_route_participation","usage_target_share"))
cols_for <- function(f) {
  if (startsWith(f, "off_"))         list(v = paste0("fi_", f, "_league_percentile"), c = paste0("fi_", f, "_confidence"), pd = paste0("fi_", f, "_prior_dominated"))
  else if (startsWith(f, "def_"))    list(v = paste0("fidef_", f, "_league_percentile"), c = paste0("fidef_", f, "_confidence"), pd = NA_character_)
  else if (startsWith(f, "usage_"))  list(v = paste0("fi_", f, "_modeled"), c = paste0("fi_", f, "_confidence"), pd = NA_character_)
  else                               list(v = paste0("fi_", f, "_modeled"), c = paste0("fi_", f, "_confidence"), pd = NA_character_)
}

d <- readRDS(DATASET) %>%
  filter(position %in% names(POS_FAMILIES), is.finite(baseline_sleeper), is.finite(actual), week >= 4, week <= 17) %>%
  mutate(resid = actual - baseline_sleeper, half = ifelse(week <= 9, "wk4-9", "wk10-17"))
cat(sprintf("dataset rows %d | seasons %s\n", nrow(d), paste(sort(unique(d$season)), collapse = ",")))

# ---- feature -> u = z * cw (train-only standardisation) ----------------------
make_u <- function(df, fam, mu, sdv) {
  cc <- cols_for(fam); if (!cc$v %in% names(df)) return(rep(0, nrow(df)))
  x  <- suppressWarnings(as.numeric(df[[cc$v]])); z <- (x - mu) / sdv; z[!is.finite(z)] <- 0
  cf <- as.character(df[[cc$c]]); cw <- ifelse(is.na(cf), 0, CONF_W[cf]); cw[is.na(cw)] <- 0
  if (!is.na(cc$pd) && cc$pd %in% names(df)) cw <- cw * ifelse(df[[cc$pd]] %in% TRUE, HAIRCUT, 1)
  z * cw
}
train_stats <- function(tr, fam) { cc <- cols_for(fam); x <- suppressWarnings(as.numeric(tr[[cc$v]])); x <- x[is.finite(x)]; list(mu = mean(x), sd = max(sd(x), 1e-9)) }
ridge1 <- function(u, r, lam) sum(u * r) / (sum(u^2) + lam)
apply_cap <- function(adj, base) { cap <- CAP * abs(base); pmax(-cap, pmin(cap, adj)) }

# fit one family for one arch: lambda by inner validation on the latest prior season, beta on all train
fit_family <- function(tr, fam) {
  st <- train_stats(tr, fam); seasons <- sort(unique(tr$season)); val_s <- max(seasons)
  itr <- tr[tr$season < val_s, ]; iva <- tr[tr$season == val_s, ]
  best <- list(lam = LAMBDAS[1], mae = Inf)
  if (nrow(itr) > 200 && nrow(iva) > 50) for (lam in LAMBDAS) {
    sti <- train_stats(itr, fam); b <- ridge1(make_u(itr, fam, sti$mu, sti$sd), itr$resid, lam)
    a <- apply_cap(b * make_u(iva, fam, sti$mu, sti$sd), iva$baseline_sleeper); m <- mean(abs(iva$resid - a))
    if (m < best$mae) best <- list(lam = lam, mae = m)
  }
  u <- make_u(tr, fam, st$mu, st$sd)
  list(fam = fam, mu = st$mu, sd = st$sd, lam = best$lam, beta = ridge1(u, tr$resid, best$lam))
}
predict_family <- function(fit, te) apply_cap(fit$beta * make_u(te, fit$fam, fit$mu, fit$sd), te$baseline_sleeper)

# ---- decision pairs (close-call region, baseline defines the pick) -----------
build_pairs <- function(te) {
  te$rid <- seq_len(nrow(te)); out <- list(); k <- 0L
  for (g in split(te, list(te$season, te$week, te$arch), drop = TRUE)) {
    n <- nrow(g); if (n < 2) next
    ij <- which(upper.tri(matrix(0, n, n)), arr.ind = TRUE)
    e <- g$baseline_sleeper[ij[, 1]] - g$baseline_sleeper[ij[, 2]]
    keep <- abs(e) < max(TAUS) & e != 0; if (!any(keep)) next
    k <- k + 1L; out[[k]] <- data.frame(i = g$rid[ij[keep, 1]], j = g$rid[ij[keep, 2]], edge = e[keep], cl = paste(g$season[1], g$week[1]))
  }
  bind_rows(out)
}
decision_stats <- function(te, pairs, adj, tau) {
  p <- pairs[abs(pairs$edge) < tau, ]; if (!nrow(p)) return(NULL)
  ai <- te$baseline_sleeper[p$i] + adj[p$i]; aj <- te$baseline_sleeper[p$j] + adj[p$j]
  base_pick_i <- p$edge > 0; cand_tie <- ai == aj; cand_pick_i <- ai > aj
  flip <- !cand_tie & (cand_pick_i != base_pick_i)
  act_i <- te$actual[p$i]; act_j <- te$actual[p$j]
  d_act <- ifelse(base_pick_i, act_j - act_i, act_i - act_j)   # actual(cand pick) - actual(base pick), only meaningful when flip
  delta <- ifelse(flip, d_act, 0)
  data.frame(cl = p$cl, delta = delta, flip = flip, win = flip & delta > 0, loss = flip & delta < 0, severe = flip & delta <= -SEVERE, large_win = flip & delta >= SEVERE)
}
agg_pairs <- function(ds) ds %>% group_by(cl) %>% summarise(sd = sum(delta), n = n(), rev = sum(flip), win = sum(win), loss = sum(loss), sev = sum(severe), lw = sum(large_win), .groups = "drop")

# ---- cluster bootstrap over (season, week) ------------------------------------
boot_ratio <- function(num, den, seed) {
  set.seed(seed); K <- length(num); W <- t(rmultinom(B, K, rep(1 / K, K)))
  as.numeric((W %*% num) / pmax(as.numeric(W %*% den), 1e-9))
}
ci90 <- function(x) as.numeric(quantile(x, c(0.05, 0.95), na.rm = TRUE))
mae_stats <- function(rows, seed) {   # rows: cl, dAE (baseline AE - candidate AE)
  a <- rows %>% group_by(cl) %>% summarise(s = sum(dAE), n = n(), .groups = "drop")
  bt <- boot_ratio(a$s, a$n, seed); ci <- ci90(bt)
  list(delta = sum(a$s) / sum(a$n), lo = ci[1], hi = ci[2], p_le0 = (sum(bt <= 0) + 1) / (B + 1), n = sum(a$n), clusters = nrow(a))
}
calib <- function(adj, resid, cl, seed) {
  ok <- is.finite(adj) & is.finite(resid); adj <- adj[ok]; resid <- resid[ok]; cl <- cl[ok]
  if (sd(adj) < 1e-9) return(list(slope = NA_real_, lo = NA_real_, hi = NA_real_, spearman = NA_real_, buckets = NULL))
  slope <- sum(adj * resid) / sum(adj^2)
  a <- data.frame(cl = cl, sxy = adj * resid, sxx = adj^2) %>% group_by(cl) %>% summarise(sxy = sum(sxy), sxx = sum(sxx), .groups = "drop")
  ci <- ci90(boot_ratio(a$sxy, a$sxx, seed))
  br <- cut(adj, quantile(adj, 0:5 / 5, na.rm = TRUE), include.lowest = TRUE, labels = FALSE)
  bm <- tapply(resid, br, mean); sp <- if (length(bm) >= 3 && length(unique(round(bm, 8))) > 1) suppressWarnings(cor(seq_along(bm), as.numeric(bm), method = "spearman")) else NA_real_
  list(slope = slope, lo = ci[1], hi = ci[2], spearman = sp, buckets = round(as.numeric(bm), 4))
}

# ---- evaluate one (position, family) over a set of folds ---------------------
eval_candidate <- function(pos, fam, folds, seed_base) {
  per_fold <- list(); all_rows <- list(); all_pairs <- list(); all_adj <- list(); te_all <- list(); fits <- list(); off <- 0L
  for (fd in folds) {
    for (ar in c("std", "half", "ppr")) {
      tr <- d[d$position == pos & d$arch == ar & d$season %in% fd$train, ]; te <- d[d$position == pos & d$arch == ar & d$season == fd$test, ]
      if (nrow(tr) < 500 || nrow(te) < 200) next
      ft <- fit_family(tr, fam); adj <- predict_family(ft, te); fits[[paste(fd$test, ar)]] <- ft[c("beta", "lam")]
      te$cl <- paste(te$season, te$week); te$dAE <- abs(te$resid) - abs(te$resid - adj); te$adj <- adj
      pr <- build_pairs(te); pr$cl <- pr$cl
      te_all[[length(te_all) + 1]] <- te; all_pairs[[length(all_pairs) + 1]] <- list(te = te, pairs = pr, adj = adj)
    }
  }
  if (!length(te_all)) return(NULL)
  te <- bind_rows(te_all)
  list(te = te, pp = all_pairs, fits = fits)
}
tau_select <- function(pp) {   # pooled development mean close-call regret improvement, >=100 reversals, then frozen
  best <- list(tau = NA_real_, m = -Inf)
  for (tau in TAUS) {
    ds <- bind_rows(lapply(pp, function(x) decision_stats(x$te, x$pairs, x$adj, tau))); if (is.null(ds) || !nrow(ds)) next
    if (sum(ds$flip) < 100) next; m <- sum(ds$delta) / nrow(ds); if (m > best$m) best <- list(tau = tau, m = m)
  }
  best
}
summarise_candidate <- function(pos, fam, ev, tau, seed, per_fold_seasons) {
  te <- ev$te; res <- list(position = pos, family = fam, tau = tau, n_rows = nrow(te))
  m <- mae_stats(te %>% transmute(cl, dAE), seed + 1); res$mae <- m
  res$mae_by_fold <- lapply(split(te, te$season), function(x) { mm <- mae_stats(x %>% transmute(cl, dAE), seed + 2); list(delta = mm$delta, weeks = mm$clusters) })
  res$mae_by_arch <- lapply(split(te, te$arch), function(x) { mm <- mae_stats(x %>% transmute(cl, dAE), seed + 3); list(delta = mm$delta, lo = mm$lo, hi = mm$hi) })
  res$mae_by_half <- lapply(split(te, te$half), function(x) { mm <- mae_stats(x %>% transmute(cl, dAE), seed + 4); list(delta = mm$delta, lo = mm$lo, hi = mm$hi) })
  te$terc <- ave(te$baseline_sleeper, te$season, te$arch, FUN = function(v) as.integer(cut(v, quantile(v, 0:3 / 3), include.lowest = TRUE, labels = 1:3)))
  res$mae_by_baseline_tercile <- lapply(split(te, te$terc), function(x) { mm <- mae_stats(x %>% transmute(cl, dAE), seed + 5); list(delta = mm$delta, lo = mm$lo, hi = mm$hi) })
  res$mae_baseline <- mean(abs(te$resid)); res$mae_candidate <- mean(abs(te$resid - te$adj)); res$rmse_baseline <- sqrt(mean(te$resid^2)); res$rmse_candidate <- sqrt(mean((te$resid - te$adj)^2))
  ds <- if (is.finite(tau)) bind_rows(lapply(ev$pp, function(x) decision_stats(x$te, x$pairs, x$adj, tau))) else NULL
  if (!is.null(ds) && nrow(ds)) {
    a <- agg_pairs(ds); bt <- boot_ratio(a$sd, a$n, seed + 6); ci <- ci90(bt)
    rv <- ds[ds$flip, ]
    res$decision <- list(pairs_in_region = nrow(ds), reversals = sum(ds$flip), mean_regret_improvement_per_pair = sum(ds$delta) / nrow(ds), lo = ci[1], hi = ci[2], p_le0 = (sum(bt <= 0) + 1) / (B + 1),
      reversal_win_rate = if (sum(ds$win) + sum(ds$loss) > 0) sum(ds$win) / (sum(ds$win) + sum(ds$loss)) else NA_real_,
      mean_delta_per_reversal = if (nrow(rv)) mean(rv$delta) else NA_real_, median_delta_per_reversal = if (nrow(rv)) median(rv$delta) else NA_real_,
      pct_reversals_improved = if (nrow(rv)) mean(rv$delta > 0) else NA_real_, pct_reversals_worsened = if (nrow(rv)) mean(rv$delta < 0) else NA_real_,
      severe_miss_rate = if (nrow(rv)) mean(rv$severe) else NA_real_, large_win_rate = if (nrow(rv)) mean(rv$large_win) else NA_real_,
      mean_regret_baseline_per_pair = NA_real_, total_regret_points_improved = sum(ds$delta))
  } else res$decision <- NULL
  cl <- calib(te$adj, te$resid, te$cl, seed + 7); res$calibration <- cl
  res$redundancy <- list(corr_with_baseline = suppressWarnings(cor(te$adj, te$baseline_sleeper, use = "complete.obs")),
    corr_with_trailing = suppressWarnings(cor(te$adj, te$baseline_trailing, use = "complete.obs")))
  res$adj_abs_mean <- mean(abs(te$adj)); res$adj_abs_p95 <- as.numeric(quantile(abs(te$adj), 0.95)); res$adj_abs_max <- max(abs(te$adj))
  res
}
finite_or <- function(x, y = FALSE) if (is.null(x) || length(x) == 0 || is.na(x)) y else x

if (stage == "dev") {
  folds <- list(list(train = c(2021, 2022), test = 2023), list(train = c(2021, 2022, 2023), test = 2024))
  results <- list(); idx <- 0L
  for (pos in names(POS_FAMILIES)) for (fam in POS_FAMILIES[[pos]]) {
    idx <- idx + 1L; ev <- eval_candidate(pos, fam, folds, SEED + idx); if (is.null(ev)) next
    ts <- tau_select(ev$pp); results[[idx]] <- summarise_candidate(pos, fam, ev, ts$tau, SEED + 100L * idx, NULL)
    results[[idx]]$tau_selection_mean_improvement <- ts$m
    cat(sprintf("%-3s %-38s MAE d=%+.4f [%+.4f,%+.4f] tau=%s rev=%s\n", pos, fam, results[[idx]]$mae$delta, results[[idx]]$mae$lo, results[[idx]]$mae$hi, ts$tau, finite_or(results[[idx]]$decision$reversals, NA)))
  }
  # ---- served-structure bundles: NON-GATING comparator (dev folds only; the holdout is never opened for bundles) ----
  bundles <- list()
  for (pos in names(SERVED)) {
    rows <- list()
    for (fd in folds) for (ar in c("std", "half", "ppr")) {
      tr <- d[d$position == pos & d$arch == ar & d$season %in% fd$train, ]; te <- d[d$position == pos & d$arch == ar & d$season == fd$test, ]
      U <- function(df, tr0) sapply(SERVED[[pos]], function(f) { s <- train_stats(tr0, f); make_u(df, f, s$mu, s$sd) })
      Ut <- U(tr, tr); Ue <- U(te, tr); lam <- 1000; b <- solve(t(Ut) %*% Ut + lam * diag(ncol(Ut)), t(Ut) %*% tr$resid)
      adj <- apply_cap(as.numeric(Ue %*% b), te$baseline_sleeper); rows[[length(rows) + 1]] <- data.frame(cl = paste(te$season, te$week), dAE = abs(te$resid) - abs(te$resid - adj))
    }
    m <- mae_stats(bind_rows(rows), SEED + 9000L); bundles[[pos]] <- list(families = SERVED[[pos]], mae_delta = m$delta, lo = m$lo, hi = m$hi, gating = FALSE)
  }
  # ---- gates + multiple testing --------------------------------------------------
  results <- Filter(Negate(is.null), results)
  p <- vapply(results, function(r) r$mae$p_le0, numeric(1)); q <- p.adjust(p, "BH")
  for (i in seq_along(results)) {
    r <- results[[i]]; r$bh_q <- q[i]; g <- list()
    fold_ok <- all(vapply(r$mae_by_fold, function(x) x$delta > 0, logical(1))) && length(r$mae_by_fold) == 2
    g$G2_sample <- length(r$mae_by_fold) == 2 && all(vapply(r$mae_by_fold, function(x) x$weeks >= 12, logical(1))) && r$n_rows >= 2000 && finite_or(r$decision$reversals, 0) >= 300
    g$G3_incremental <- r$mae$delta >= MIN_EFFECT && r$mae$lo > 0 && r$bh_q <= 0.10
    g$G4_stability <- fold_ok && all(vapply(r$mae_by_arch, function(x) x$delta > 0, logical(1)))
    dd <- r$decision
    g$G5_decision <- !is.null(dd) && dd$lo > 0 && finite_or(dd$reversal_win_rate, 0) >= 0.52 && finite_or(dd$severe_miss_rate, 1) <= finite_or(dd$large_win_rate, 0)
    cb <- r$calibration
    g$G7_calibration <- !is.na(cb$slope) && cb$slope >= 0.5 && cb$slope <= 1.5 && cb$lo > 0 && finite_or(cb$spearman, 0) >= 0.6
    cells <- c(r$mae_by_arch, r$mae_by_half, r$mae_by_baseline_tercile)
    g$G8_subgroup <- !any(vapply(cells, function(x) x$hi < -MIN_EFFECT, logical(1)))
    g$G9_redundancy_ok <- abs(finite_or(r$redundancy$corr_with_baseline, 0)) < 0.9
    r$gates_dev <- g
    fails <- names(g)[!unlist(g)]
    r$dev_verdict <- if (!g$G2_sample) "INCONCLUSIVE_SAMPLE" else if (length(fails) == 0) "PASS_DEV" else "FAIL_DEV"
    r$dev_failed_gates <- fails
    results[[i]] <- r
  }
  write_json(list(criteria_version = crit$criteria_version, stage = "dev", lane = "RECONSTRUCTED_CHRONOLOGY_SAFE", baseline = "baseline_sleeper (RECONSTRUCTED_PRODUCTION_LIKE)",
                  folds = folds, n_tests = length(results), bootstrap = list(B = B, seed = SEED, cluster = "season-week", interval = 0.90), results = results, served_bundles_nongating = bundles),
             file.path(OUT, "results_dev.json"), auto_unbox = TRUE, digits = 6, pretty = TRUE, na = "null")
  surv <- Filter(function(r) r$dev_verdict == "PASS_DEV", results)
  write_json(list(criteria_version = crit$criteria_version, frozen = lapply(surv, function(r) list(position = r$position, family = r$family, tau = r$tau))), file.path(OUT, "frozen_candidates.json"), auto_unbox = TRUE, pretty = TRUE)
  cat(sprintf("\nDEV: %d tests | PASS_DEV %d | FAIL_DEV %d | INCONCLUSIVE %d\n", length(results), length(surv), sum(vapply(results, function(r) r$dev_verdict == "FAIL_DEV", logical(1))), sum(vapply(results, function(r) r$dev_verdict == "INCONCLUSIVE_SAMPLE", logical(1)))))
} else {
  fz <- fromJSON(file.path(OUT, "frozen_candidates.json"), simplifyVector = FALSE)$frozen
  if (!length(fz)) { cat("HOLDOUT NOT OPENED: no candidate survived the development gates.\n"); write_json(list(criteria_version = crit$criteria_version, stage = "holdout", opened = FALSE, reason = "no candidate passed all development gates", results = list()), file.path(OUT, "results_holdout.json"), auto_unbox = TRUE, pretty = TRUE); quit(save = "no") }
  folds <- list(list(train = 2021:2024, test = 2025)); results <- list(); m <- length(fz)
  for (i in seq_along(fz)) { f <- fz[[i]]; ev <- eval_candidate(f$position, f$family, folds, SEED + 5000L + i); r <- summarise_candidate(f$position, f$family, ev, f$tau, SEED + 7000L * i, NULL)
    r$bonferroni_alpha <- 0.05 / m; r$G6_holdout <- r$mae$delta >= MIN_EFFECT && r$mae$lo > 0 && !is.null(r$decision) && r$decision$lo > 0; results[[i]] <- r }
  write_json(list(criteria_version = crit$criteria_version, stage = "holdout", opened = TRUE, results = results), file.path(OUT, "results_holdout.json"), auto_unbox = TRUE, digits = 6, pretty = TRUE, na = "null")
  cat("HOLDOUT evaluated for", m, "frozen candidate(s)\n")
}
