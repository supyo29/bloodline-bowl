# W2.R1 S7 FINAL: preregistered T1-T10 style gate evaluation for K / D-ST (team-slot) candidates vs the generic-projection control (prior-4-game mean).
# Written AFTER the freeze and BEFORE any 2026 outcome was scored by it. Mechanical implementation of prereg.json gates_forecast_G2 / k_dst.gates.
suppressMessages(library(data.table))
boot_d <- function(cl, e0, e1, B = 2000) { set.seed(20261014); idx <- split(seq_along(e0), cl); ks <- names(idx); per <- lapply(idx, function(i) c(n = length(i), d = sum(abs(e0[i])) - sum(abs(e1[i]))))
  s <- sapply(seq_len(B), function(b) { p <- per[sample(length(per), length(per), TRUE)]; n <- sum(sapply(p, `[`, 1)); sum(sapply(p, `[`, 2)) / n }); c(lo = unname(quantile(s, .025)), hi = unname(quantile(s, .975))) }
binom_upper <- function(k, n) if (n == 0) 1 else sum(dbinom(k:n, n, 0.5))
# d: data.table(week, season, team, actual, model, control, tier_base) ; model/control are expected points ; higher dMAE = model better
gate_slot <- function(d, val_dMAE, min_n = 150) {
  e1 <- d$actual - d$model; e0 <- d$actual - d$control; n <- nrow(d); cl <- d$game_id   # cluster = game (the two team slots of one game share game script), as in the frozen S4 harness
  dm <- mean(abs(e0)) - mean(abs(e1)); ci <- boot_d(cl, e0, e1)
  by_wk <- d[, .(dMAE = mean(abs(actual - control)) - mean(abs(actual - model)), n = .N), by = week][order(week)]
  # T6: all same-week pairs of team slots (streaming choice among teams); decided = |actual difference| >= 1 point where model and control disagree on the ordering
  dec <- 0; cw <- 0; dis <- 0; amb <- 0
  for (w in unique(d$week)) { x <- d[week == w]; m <- nrow(x); if (m < 2) next; ij <- t(combn(m, 2)); a <- ij[, 1]; b <- ij[, 2]
    ch <- x$control[a] - x$control[b]; cn <- x$model[a] - x$model[b]; dg <- sign(ch) != sign(cn) & ch != 0 & cn != 0; act <- x$actual[a] - x$actual[b]
    dis <- dis + sum(dg); amb <- amb + sum(dg & abs(act) < 1); ok <- dg & abs(act) >= 1; dec <- dec + sum(ok); cw <- cw + sum(ok & sign(act) == sign(cn)) }
  t6p <- binom_upper(cw, dec)
  # T7 tiers by base (control) expectation terciles fixed from FIT is unavailable here -> tiers by the control's own terciles on FINAL rows (reported; N>=100 required for the rule to bind)
  d[, tier := cut(control, quantile(control, c(0, 1/3, 2/3, 1)), include.lowest = TRUE, labels = c("LOW", "MID", "HIGH"))]
  tiers <- d[, .(n = .N, dMAE = mean(abs(actual - control)) - mean(abs(actual - model))), by = tier]
  GT <- list(
    T1 = if (n >= min_n) "PASS" else "INSUFFICIENT_FINAL_SAMPLE",
    T2 = if (dm >= 0.05 && ci["lo"] > 0) "PASS" else "FAIL", T2b = "NOT_APPLICABLE (no Role layer for K/DST)",
    T3 = if (sqrt(mean(e1^2)) <= sqrt(mean(e0^2)) + 0.02) "PASS" else "FAIL",
    T4 = if (abs(mean(e1)) <= 0.5 && abs(mean(e1)) <= abs(mean(e0)) + 0.15) "PASS" else "FAIL",
    T5 = if (sum(by_wk$dMAE > 0) >= 3 && !is.na(val_dMAE) && val_dMAE > 0) "PASS" else "FAIL",
    T6 = if (dec < 100) "INSUFFICIENT" else if (cw >= dec - cw && t6p < 0.10) "PASS" else "FAIL",
    T7 = if (any(tiers$n >= 100 & tiers$dMAE < -0.10)) "FAIL" else "PASS",
    T8 = "NOT_APPLICABLE (no designation / cap for K/DST; OUT contribution n/a)", T9 = "SEE leakage/oracle block", T10 = "NOT_APPLICABLE (scored under each league's exact scoring only; no STD/PPR regimes)")
  list(n = n, MAE_model = mean(abs(e1)), MAE_control = mean(abs(e0)), RMSE_model = sqrt(mean(e1^2)), RMSE_control = sqrt(mean(e0^2)), bias_model = mean(e1), bias_control = mean(e0), dMAE = dm, dMAE_lo95 = unname(ci["lo"]), dMAE_hi95 = unname(ci["hi"]),
    by_week = as.list(setNames(by_wk$dMAE, by_wk$week)), by_week_n = as.list(setNames(by_wk$n, by_wk$week)), weeks_positive = sum(by_wk$dMAE > 0), val_dMAE = val_dMAE,
    decisions = list(disagreements = dis, decided = dec, challenger_wins = cw, control_wins = dec - cw, ambiguous = amb, p_one_sided = t6p), tiers = lapply(split(tiers, tiers$tier), function(z) list(n = z$n, dMAE = z$dMAE)), gates = GT) }
