# W2.R1 S6: empirical breakout / upside study (QB RB WR TE). FIT 2022-2024 -> VAL 2025 wk 3-17. 2026 never loaded. Spec: scripts/w2r1/s6_spec.json (frozen before this script ran).
suppressMessages({ library(data.table); library(jsonlite) }); set.seed(20261014)
T <- fread("scripts/w2r1/cache/s6_rows.csv"); stopifnot(!any(T$season >= 2026))
fit_max <- T[split == "FIT", max(season * 100 + week)]; val_min <- T[split == "VAL", min(season * 100 + week)]; stopifnot(fit_max < val_min)   # time split only
TR <- c("snap_trend", "target_trend", "carry_trend", "rz_trend")
LV <- list(QB = c("rl_dropbacks", "rl_designed", "rl_scrambles", "rl_snap", "b0"), RB = c("rl_carries", "rl_targets", "rl_rz_carries", "rl_rz_targets", "rl_snap", "b0"), WR = c("rl_targets", "rl_rz_targets", "rl_snap", "rl_air_share", "b0"), TE = c("rl_targets", "rl_rz_targets", "rl_snap", "rl_air_share", "b0"))
CX <- c("implied_team_total", "team_spread", "opp_implied_total", "team_pace_asof", "dome"); SH <- c("so_missing_target_share", "so_missing_rush_share", "so_ol_out", "so_front_out"); EX <- c("years_exp", "career_prior", "team_changed_recent", "weeks_since_out")
OFFM <- c("t_neutral_pass_rate", "t_early_down_pass_rate", "t_play_action_rate", "t_screen_rate", "t_deep_attempt_rate", "t_rb_target_share", "t_rz_pass_rate", "t_goal_line_run_rate", "t_sack_rate_suffered"); DEFM <- c("d_sack_rate", "d_blitz_rate", "d_pass_epa_allowed", "d_rush_epa_allowed", "d_explosive_pass_allowed", "d_deep_target_concession", "d_rb_target_share_allowed", "d_rz_td_rate_allowed", "d_ppg_allowed")
DG <- c(paste0(OFFM, "_MULTI"), paste0(DEFM, "_MULTI"))
T[, `:=`(tier_starter = as.integer(tier == "STARTER"), tier_flex = as.integer(tier == "FLEX"))]
fams <- function(pos) { a <- c("tier_starter", "tier_flex", TR); b <- c(a, LV[[pos]], CX); c <- c(b, SH, EX); d <- c(c, DG); list(M1a = a, M1b = b, M1c = c, M1d = d) }
bad <- grep("^(lab_|o_|actual|played|c6$|c12$|sd_res)", unlist(fams("QB")), value = TRUE); stopifnot(length(bad) == 0)     # column audit: no outcome column is a feature
logit <- function(p) log(p / (1 - p))
fit_logit <- function(X, y, lam) { p <- ncol(X); beta <- rep(0, p); a0 <- qlogis(min(max(mean(y), 1e-3), 1 - 1e-3)); for (it in 1:60) { eta <- as.vector(a0 + X %*% beta); mu <- plogis(eta); W <- pmax(mu * (1 - mu), 1e-9); z <- eta + (y - mu) / W
    A <- rbind(c(sum(W), colSums(W * X)), cbind(colSums(W * X), crossprod(X, W * X) + diag(lam, p))); rhs <- c(sum(W * z), crossprod(X, W * z)); sol <- tryCatch(solve(A, rhs), error = function(e) NULL); if (is.null(sol)) break; nb <- sol[-1]; na <- sol[1]; if (max(abs(nb - beta), abs(na - a0)) < 1e-7) { beta <- nb; a0 <- na; break }; beta <- nb; a0 <- na }
  list(a0 = a0, beta = beta) }
prep <- function(d, cols, ref) { X <- as.matrix(d[, ..cols]); ok <- complete.cases(X); Z <- sweep(sweep(X, 2, ref$mean), 2, ref$sd, "/"); list(Z = Z, ok = ok) }
cal <- function(p, y) { p <- pmin(pmax(p, 1e-4), 1 - 1e-4); br <- mean((p - y)^2); ll <- -mean(y * log(p) + (1 - y) * log(1 - p)); slope <- tryCatch(unname(coef(glm(y ~ logit(p), family = binomial))[2]), error = function(e) NA_real_)
  o <- order(p); nb <- 10; grp <- cut(seq_along(o), breaks = nb, labels = FALSE); bins <- data.table(g = grp, p = p[o], y = y[o])[, .(n = .N, p = mean(p), y = mean(y)), by = g]
  while (nrow(bins) > 1 && min(bins$n) < 10) { i <- which.min(bins$n); j <- if (i == nrow(bins)) i - 1 else i + 1; bins[j, `:=`(p = (p * n + bins$p[i] * bins$n[i]) / (n + bins$n[i]), y = (y * n + bins$y[i] * bins$n[i]) / (n + bins$n[i]), n = n + bins$n[i])]; bins <- bins[-i] }
  ece <- sum(bins$n * abs(bins$p - bins$y)) / sum(bins$n); thr <- quantile(p, .9); top <- p >= thr; list(brier = br, logloss = ll, slope = slope, ece = ece, top_decile_lift = if (mean(y) > 0) mean(y[top]) / mean(y) else NA_real_, top_decile_events = sum(y[top]), top_decile_n = sum(top), reliability = lapply(seq_len(nrow(bins)), function(i) list(n = bins$n[i], p = bins$p[i], observed = bins$y[i]))) }
boot_brier <- function(cl, e0, e1, B = 2000) { u <- unique(cl); idx <- match(cl, u); s0 <- as.vector(rowsum(e0, idx)); s1 <- as.vector(rowsum(e1, idx)); nn <- as.vector(rowsum(rep(1, length(e0)), idx)); set.seed(20261014)
  d <- replicate(B, { k <- sample.int(length(u), length(u), TRUE); (sum(s0[k]) - sum(s1[k])) / sum(nn[k]) }); list(dBrier = (sum(e0) - sum(e1)) / length(e0), lo95 = unname(quantile(d, .025)), hi95 = unname(quantile(d, .975)), p = mean(d <= 0)) }
wsmall <- function(n) ifelse(n >= 4, 1, ifelse(n >= 2, 0.6, 0))
out <- list(spec = "w2r1-s6-spec-1", positions = list(), base_rates = list(), negative_examples = list(), subgroups = list(), oracle = list())
LAM <- c(100, 10, 1, 0.1); names(LAM) <- c("0.01", "0.1", "1", "10")
for (pos in c("QB", "RB", "WR", "TE")) {
  d <- T[position == pos]; fit <- d[split == "FIT"]; val <- d[split == "VAL"]; vA <- val[week <= 9]; vB <- val[week >= 10]; y <- "lab_primary"
  tr_rate <- fit[, .(r = (sum(get(y)) + 1) / (.N + 2)), by = tier]; rate_of <- function(dd) tr_rate$r[match(dd$tier, tr_rate$tier)]
  base_pos <- mean(fit[[y]]); out$base_rates[[pos]] <- list(FIT = list(n = nrow(fit), primary = base_pos, top6 = mean(fit$lab_top6), top12 = mean(fit$lab_top12), residual = mean(fit$lab_resid), relative = mean(fit$lab_rel)), VAL = list(n = nrow(val), primary = mean(val[[y]]), top6 = mean(val$lab_top6), top12 = mean(val$lab_top12), residual = mean(val$lab_resid), relative = mean(val$lab_rel)), tier_rates_FIT = as.list(setNames(tr_rate$r, tr_rate$tier)), events = list(FIT = sum(fit[[y]]), VAL = sum(val[[y]])))
  M0v <- rate_of(val); yv <- val[[y]]; cl <- paste(val$team, val$week); e0 <- (M0v - yv)^2
  res <- list(M0 = list(cal = cal(M0v, yv)))
  fF <- fams(pos); fitm <- function(nm, C, train) { cols <- fF[[nm]]; Xtr <- as.matrix(train[, ..cols]); ok <- complete.cases(Xtr); ref <- list(mean = colMeans(Xtr[ok, , drop = FALSE]), sd = pmax(apply(Xtr[ok, , drop = FALSE], 2, sd), 1e-9)); Z <- sweep(sweep(Xtr[ok, , drop = FALSE], 2, ref$mean), 2, ref$sd, "/"); m <- fit_logit(Z, train[[y]][ok], LAM[[as.character(C)]]); c(m, list(ref = ref, cols = cols)) }
  predict_m <- function(m, dd) { mc <- m$cols; Xd <- as.matrix(dd[, ..mc]); ok <- complete.cases(Xd); pm <- rep(NA_real_, nrow(dd)); if (any(ok)) { Z <- sweep(sweep(Xd[ok, , drop = FALSE], 2, m$ref$mean), 2, m$ref$sd, "/"); pm[ok] <- plogis(m$a0 + as.vector(Z %*% m$beta)) }; base <- rate_of(dd); w <- wsmall(dd$career_prior); p <- ifelse(is.na(pm), base, w * pm + (1 - w) * base); list(p = pmin(pmax(p, 1e-3), 1 - 1e-3), known = !is.na(pm)) }
  ll_of <- function(p, yy) -mean(yy * log(p) + (1 - yy) * log(1 - p))
  chooseC <- function(nm, valsel) { best <- NULL; for (C in c("0.01", "0.1", "1", "10")) { m <- fitm(nm, C, fit); p <- predict_m(m, valsel)$p; l <- ll_of(p, valsel[[y]]); if (is.null(best) || l < best$l - 1e-12) best <- list(C = C, l = l, m = m) }; best }
  prevp <- M0v; prevname <- "M0"; chain <- character(0); ladder <- list()
  for (nm in c("M1a", "M1b", "M1c", "M1d")) {
    sel <- chooseC(nm, val); pr <- predict_m(sel$m, val); p <- pr$p; e1 <- (p - yv)^2; ll1 <- ll_of(p, yv); llp <- ll_of(prevp, yv); b <- boot_brier(cl, (prevp - yv)^2, e1)
    keep <- (llp - ll1) >= 0.002 && b$lo95 > 0
    selA <- chooseC(nm, vA); pB <- predict_m(selA$m, vB)$p; lateM0 <- rate_of(vB); late <- list(C = selA$C, brier_skill_vs_M0 = 1 - mean((pB - vB[[y]])^2) / mean((lateM0 - vB[[y]])^2), logloss_gain_vs_M0 = ll_of(lateM0, vB[[y]]) - ll_of(pB, vB[[y]]))
    vsM0 <- boot_brier(cl, e0, e1); cc <- cal(p, yv)
    ladder[[nm]] <- list(C = sel$C, coverage_known = mean(pr$known), vs_previous_retained = prevname, dLogLoss = llp - ll1, boot_vs_previous = b, retained = keep, brier = cc$brier, brier_skill_vs_M0 = 1 - cc$brier / res$M0$cal$brier, boot_vs_M0 = vsM0, logloss = cc$logloss, dLogLoss_vs_M0 = res$M0$cal$logloss - cc$logloss, calibration = cc, val_late = late)
    res[[nm]] <- list(p = p, known = pr$known)
    if (keep) { chain <- c(chain, nm); prevp <- p; prevname <- nm }
  }
  last <- if (length(chain)) tail(chain, 1) else "M0"; L <- if (last == "M0") NULL else ladder[[last]]
  pfin <- if (last == "M0") M0v else res[[last]]$p
  alerts <- lapply(c(ELEVATED = 1.5, HIGH = 2.0), function(mult) { a <- pfin >= mult * base_pos; list(threshold = mult * base_pos, alerted = sum(a), precision = if (sum(a)) mean(yv[a]) else NA_real_, recall = if (sum(yv)) sum(yv[a]) / sum(yv) else NA_real_, lift = if (sum(a)) mean(yv[a]) / mean(yv) else NA_real_) })
  # gates (spec B1-B5) on the last retained candidate vs M0
  verdict <- if (sum(yv) < 40) "INSUFFICIENT SAMPLE" else if (is.null(L)) "NO RELIABLE BREAKOUT SIGNAL" else {
    b2 <- L$brier_skill_vs_M0 >= 0.02 && L$boot_vs_M0$lo95 > 0; b3 <- L$dLogLoss_vs_M0 > 0; b4 <- !is.na(L$calibration$slope) && L$calibration$slope >= 0.8 && L$calibration$slope <= 1.2 && L$calibration$ece <= 0.03; b5 <- !is.na(L$calibration$top_decile_lift) && L$calibration$top_decile_lift >= 1.3 && L$calibration$top_decile_events >= 10
    late_ok <- L$val_late$brier_skill_vs_M0 >= 0.02 && L$val_late$logloss_gain_vs_M0 > 0
    gates <- list(B1 = TRUE, B2 = b2, B3 = b3, B4 = b4, B5 = b5, VAL_LATE = late_ok); attr_g <- gates
    if (!b2 || !b3) "NO RELIABLE BREAKOUT SIGNAL" else if (b4 && b5 && late_ok) "VALIDATION CANDIDATE" else "DIAGNOSTIC ONLY" }
  # ORACLE control: target-game actual usage + tier
  oc <- c("tier_starter", "tier_flex", "o_targets", "o_carries", "o_dropbacks"); Xo <- as.matrix(fit[, ..oc]); ro <- list(mean = colMeans(Xo), sd = pmax(apply(Xo, 2, sd), 1e-9)); mo <- fit_logit(sweep(sweep(Xo, 2, ro$mean), 2, ro$sd, "/"), fit[[y]], 1); po <- plogis(mo$a0 + as.vector(sweep(sweep(as.matrix(val[, ..oc]), 2, ro$mean), 2, ro$sd, "/") %*% mo$beta)); bo <- mean((po - yv)^2)
  oc2 <- c("tier_starter", "tier_flex", "actual"); Xo2 <- as.matrix(fit[, ..oc2]); r2 <- list(mean = colMeans(Xo2), sd = pmax(apply(Xo2, 2, sd), 1e-9)); m2o <- fit_logit(sweep(sweep(Xo2, 2, r2$mean), 2, r2$sd, "/"), fit[[y]], 1); po2 <- plogis(m2o$a0 + as.vector(sweep(sweep(as.matrix(val[, ..oc2]), 2, r2$mean), 2, r2$sd, "/") %*% m2o$beta)); bo2 <- mean((po2 - yv)^2)
  out$oracle[[pos]] <- list(brier_oracle_usage = bo, brier_M0 = res$M0$cal$brier, relative_improvement = 1 - bo / res$M0$cal$brier, criterion_25pct_met = (1 - bo / res$M0$cal$brier) >= 0.25, brier_oracle_target_outcome = bo2, relative_improvement_target_outcome = 1 - bo2 / res$M0$cal$brier)
  # negative examples: descriptive cohort = top quintile of a SIGNED composite per family (signs fixed in the code before results)
  fcomp <- list(TREND = list(TR, 1), LEVEL = list(setdiff(LV[[pos]], "b0"), 1), CONTEXT = list(c("implied_team_total", "team_pace_asof"), 1), SHIFT = list(c("so_missing_target_share", "so_missing_rush_share"), 1), S5_DIAG = list(c("d_pass_epa_allowed_MULTI", "d_rush_epa_allowed_MULTI", "d_explosive_pass_allowed_MULTI"), 1))
  ne <- list(); for (fn in names(fcomp)) { cols <- fcomp[[fn]][[1]]; cols <- cols[cols %in% names(d)]; zs <- sapply(cols, function(c) (val[[c]] - mean(fit[[c]], na.rm = TRUE)) / max(sd(fit[[c]], na.rm = TRUE), 1e-9)); comp <- rowMeans(as.matrix(zs), na.rm = FALSE); zf <- sapply(cols, function(c) (fit[[c]] - mean(fit[[c]], na.rm = TRUE)) / max(sd(fit[[c]], na.rm = TRUE), 1e-9)); cf <- rowMeans(as.matrix(zf)); q <- quantile(cf, .8, na.rm = TRUE); sel <- !is.na(comp) & comp >= q
    ne[[fn]] <- list(n_cohort = sum(sel), n_positive = sum(yv[sel]), n_negative = sum(sel) - sum(yv[sel]), empirical_rate = mean(yv[sel]), position_base_rate = mean(yv), lift_vs_position_base = mean(yv[sel]) / mean(yv), tier_expected_rate = mean(M0v[sel]), lift_vs_tier_expected = mean(yv[sel]) / mean(M0v[sel])) }
  out$negative_examples[[pos]] <- ne
  # rookie / small-sample subgroups (VAL; final display probability)
  sg <- list(rookie = val$years_exp == 0, low_history_lt4 = val$career_prior < 4, recent_team_change = val$team_changed_recent == 1, injury_return_weeks_since_out_le3 = val$weeks_since_out <= 3, large_snap_trend_shift = abs(val$snap_trend) >= quantile(abs(fit$snap_trend), .9, na.rm = TRUE)); sgo <- list()
  for (k in names(sg)) { s <- sg[[k]]; s[is.na(s)] <- FALSE; sgo[[k]] <- list(n = sum(s), events = sum(yv[s]), observed_rate = if (sum(s)) mean(yv[s]) else NA, mean_p_shown = if (sum(s)) mean(pfin[s]) else NA, tier_expected = if (sum(s)) mean(M0v[s]) else NA, observed_over_tier_expected = if (sum(s)) mean(yv[s]) / mean(M0v[s]) else NA, min_p = if (sum(s)) min(pfin[s]) else NA) }
  out$subgroups[[pos]] <- sgo
  # M2: not fitted unless the gate is met (only rpart exists in this environment; no boosted-tree package)
  m2 <- list(fitted = FALSE, reason = if (is.null(L)) "M1 did not beat M0 on VAL (gate for M2 not met)" else if (sum(fit[[y]]) + sum(yv) < 300) "fewer than 300 positive events" else "gate met but no boosted-tree package is installed (gbm/xgboost/ranger absent); a single rpart tree is not a calibrated candidate")
  out$positions[[pos]] <- list(n_val = nrow(val), events_val = sum(yv), base_rate_val = mean(yv), M0 = res$M0$cal, ladder = ladder, retained_chain = chain, last_retained = last, alerts = alerts, verdict = verdict, M2 = m2, p_distribution = list(min = min(pfin), q10 = quantile(pfin, .1), median = median(pfin), q90 = quantile(pfin, .9), max = max(pfin)))
  cat(sprintf("\n== %s  val n=%d events=%d base=%.3f | M0 brier %.4f ll %.4f | retained %s | VERDICT %s\n", pos, nrow(val), sum(yv), mean(yv), res$M0$cal$brier, res$M0$cal$logloss, paste(chain, collapse = ">"), verdict))
  for (nm in names(ladder)) { l <- ladder[[nm]]; cat(sprintf("  %s C=%-4s cov %.2f | brier skill vs M0 %+.3f [dBrier lo95 %+.4f] | dLL vs M0 %+.4f | slope %.2f ece %.3f lift %.2f(ev %d) | late skill %+.3f | %s\n", nm, l$C, l$coverage_known, l$brier_skill_vs_M0, l$boot_vs_M0$lo95, l$dLogLoss_vs_M0, l$calibration$slope, l$calibration$ece, l$calibration$top_decile_lift, l$calibration$top_decile_events, l$val_late$brier_skill_vs_M0, if (l$retained) "RETAINED" else "-")) }
  cat(sprintf("  oracle brier improvement vs M0: %.0f%%\n", 100 * out$oracle[[pos]]$relative_improvement))
}
write_json(out, "scripts/w2r1/results/s6_val.json", auto_unbox = TRUE, pretty = TRUE, digits = 5)
