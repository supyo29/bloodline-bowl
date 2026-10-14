# W2.R1 S6: K / D-ST SPIKE (weekly top-6) probability models. Reuses the S4 component models (sourced; deterministic), FIT 2022-2024 -> VAL 2025. 2026 never loaded.
# Separate from S4 expected-points qualification (spec): an expected-points model may improve while its spike model fails.
suppressMessages({ library(data.table); library(jsonlite) })
source("scripts/w2r1/s4_fit_eval.R", local = FALSE)
set.seed(20261014); NS <- 4000
simK2 <- function(i, w) { N <- NS; fa <- rpois(N, g$e_fg[i]); rem <- fa; rs <- 1; pts <- numeric(N); sh <- unlist(g[i, paste0("sh_", BL), with = FALSE]); pb <- last_pbin[i, ]
  for (b in 1:6) { pb_i <- if (rs <= 1e-9) 0 else min(1, sh[b] / rs); nb <- rbinom(N, rem, pb_i); rem <- rem - nb; rs <- rs - sh[b]; mk <- rbinom(N, nb, pb[b]); pts <- pts + mk * w$make[b] + (nb - mk) * w$miss[b] }
  xa <- rpois(N, g$e_xp[i]); xm <- rbinom(N, xa, xp_rate); pts + xm * w$xpm + (xa - xm) * w$xpmiss }
cal2 <- function(p, y) { p <- pmin(pmax(p, 1e-4), 1 - 1e-4); br <- mean((p - y)^2); ll <- -mean(y * log(p) + (1 - y) * log(1 - p)); sl <- tryCatch(unname(coef(glm(y ~ qlogis(p), family = binomial))[2]), error = function(e) NA_real_)
  o <- order(p); grp <- cut(seq_along(o), 10, labels = FALSE); bins <- data.table(g = grp, p = p[o], y = y[o])[, .(n = .N, p = mean(p), y = mean(y)), by = g]; while (nrow(bins) > 1 && min(bins$n) < 10) { i <- which.min(bins$n); j <- if (i == nrow(bins)) i - 1 else i + 1; bins[j, `:=`(p = (p * n + bins$p[i] * bins$n[i]) / (n + bins$n[i]), y = (y * n + bins$y[i] * bins$n[i]) / (n + bins$n[i]), n = n + bins$n[i])]; bins <- bins[-i] }
  top <- p >= quantile(p, .9); list(brier = br, logloss = ll, slope = sl, ece = sum(bins$n * abs(bins$p - bins$y)) / sum(bins$n), top_decile_lift = if (mean(y) > 0) mean(y[top]) / mean(y) else NA_real_, top_decile_events = sum(y[top]), reliability = lapply(seq_len(nrow(bins)), function(i) list(n = bins$n[i], p = bins$p[i], observed = bins$y[i]))) }
boot2 <- function(cl, e0, e1, B = 2000) { u <- unique(cl); idx <- match(cl, u); s0 <- as.vector(rowsum(e0, idx)); s1 <- as.vector(rowsum(e1, idx)); nn <- as.vector(rowsum(rep(1, length(e0)), idx)); set.seed(20261014); d <- replicate(B, { k <- sample.int(length(u), length(u), TRUE); (sum(s0[k]) - sum(s1[k])) / sum(nn[k]) }); list(dBrier = (sum(e0) - sum(e1)) / length(e0), lo95 = unname(quantile(d, .025))) }
fitlog <- function(x, y, lam) { Xs <- scale(x); mu <- attr(Xs, "scaled:center"); sdv <- attr(Xs, "scaled:scale"); beta <- rep(0, ncol(Xs)); a0 <- qlogis(mean(y)); for (it in 1:50) { eta <- as.vector(a0 + Xs %*% beta); m <- plogis(eta); W <- pmax(m * (1 - m), 1e-9); z <- eta + (y - m) / W; A <- rbind(c(sum(W), colSums(W * Xs)), cbind(colSums(W * Xs), crossprod(Xs, W * Xs) + diag(lam, ncol(Xs)))); sol <- solve(A, c(sum(W * z), crossprod(Xs, W * z))); beta <- sol[-1]; a0 <- sol[1] }; list(a0 = a0, beta = beta, mu = mu, sd = sdv) }
predlog <- function(m, x) plogis(m$a0 + as.vector(sweep(sweep(x, 2, m$mu), 2, m$sd, "/") %*% m$beta))
spk <- list()
for (rn in names(regs)) { rg <- regs[[rn]]
  for (pos in c(if (isTRUE(rg$has_K)) "K", "DST")) {
    if (pos == "K") { w <- wK(rg); g[, `:=`(a_s = actualK(g, w), e_s = expK(w))]; pf <- frollsum(shift(g$fg_att, 1), 3); popm <- !is.na(pf) & pf >= 1; g[, pf_ := pf] } else { w <- wD(rg); g[, `:=`(a_s = actualD(g, w), e_s = expD(w))]; popm <- rep(TRUE, nrow(g)) }
    g[, c_s := ctl(a_s), by = team]; g[, lab := as.integer(a_s >= sort(a_s, decreasing = TRUE)[6]), by = .(season, week)]
    cutv <- median(g[season <= 2024 & week >= 3, .(c6 = sort(a_s, decreasing = TRUE)[6]), by = .(season, week)]$c6)
    rows_fit <- which(g$season <= 2024 & g$week >= 3 & popm); rows_val <- which(g$season == 2025 & g$week >= 3 & popm)
    sim_one <- function(i) { x <- if (pos == "K") simK2(i, w) else simD(i, w); c(mean(x >= cutv), sd(x)) }
    SF <- t(sapply(rows_fit, sim_one)); SV <- t(sapply(rows_val, sim_one))
    ytr <- g$lab[rows_fit]; yv <- g$lab[rows_val]; cl <- paste(g$game_id[rows_val])
    tc <- quantile(g$c_s[rows_fit], c(1/3, 2/3)); ter <- function(v) 1 + (v > tc[1]) + (v > tc[2]); r0 <- tapply(ytr, ter(g$c_s[rows_fit]), mean); p0 <- as.numeric(r0[ter(g$c_s[rows_val])])
    psim <- pmin(pmax(SV[, 1], 1e-3), 1 - 1e-3); Xf <- cbind(e = g$e_s[rows_fit], sd = SF[, 2]); Xv <- cbind(e = g$e_s[rows_val], sd = SV[, 2])
    wk <- g$week[rows_val]; late <- wk >= 10; best <- NULL
    for (C in c(0.01, 0.1, 1, 10)) { m <- fitlog(Xf, ytr, 1 / C); p <- pmin(pmax(predlog(m, Xv), 1e-3), 1 - 1e-3); l <- -mean(yv * log(p) + (1 - yv) * log(1 - p)); if (is.null(best) || l < best$l - 1e-12) best <- list(C = C, l = l, m = m, p = p) }
    # VAL-LATE: C chosen on weeks 3-9 only
    bl <- NULL; for (C in c(0.01, 0.1, 1, 10)) { m <- fitlog(Xf, ytr, 1 / C); p <- pmin(pmax(predlog(m, Xv[!late, , drop = FALSE]), 1e-3), 1 - 1e-3); l <- -mean(yv[!late] * log(p) + (1 - yv[!late]) * log(1 - p)); if (is.null(bl) || l < bl$l - 1e-12) bl <- list(C = C, l = l, m = m) }
    pl <- pmin(pmax(predlog(bl$m, Xv[late, , drop = FALSE]), 1e-3), 1 - 1e-3); late_skill <- 1 - mean((pl - yv[late])^2) / mean((p0[late] - yv[late])^2)
    base <- mean(ytr); res <- list()
    for (nm in c("M0", "M_sim", "M1")) { p <- switch(nm, M0 = p0, M_sim = psim, M1 = best$p); cc <- cal2(p, yv); b <- boot2(cl, (p0 - yv)^2, (p - yv)^2); al <- lapply(c(ELEVATED = 1.5, HIGH = 2.0), function(mu) { a <- p >= mu * base; list(alerted = sum(a), precision = if (sum(a)) mean(yv[a]) else NA_real_, recall = if (sum(yv)) sum(yv[a]) / sum(yv) else NA_real_) }); res[[nm]] <- c(cc, list(skill_vs_M0 = 1 - cc$brier / mean((p0 - yv)^2), boot_vs_M0 = b, alerts = al)) }
    pick <- if (res$M1$brier < res$M_sim$brier) "M1" else "M_sim"; L <- res[[pick]]
    b2 <- L$skill_vs_M0 >= 0.02 && L$boot_vs_M0$lo95 > 0; b3 <- L$logloss < res$M0$logloss; b4 <- !is.na(L$slope) && L$slope >= .8 && L$slope <= 1.2 && L$ece <= .03; b5 <- !is.na(L$top_decile_lift) && L$top_decile_lift >= 1.3 && L$top_decile_events >= 10
    verdict <- if (sum(yv) < 40) "INSUFFICIENT SAMPLE" else if (!b2 || !b3) "NO RELIABLE BREAKOUT SIGNAL" else if (b4 && b5 && late_skill >= 0.02) "VALIDATION CANDIDATE" else "DIAGNOSTIC ONLY"
    spk[[paste0(rn, "|", pos)]] <- list(n_val = length(yv), events_val = sum(yv), base_rate_fit = base, cut = cutv, models = res, chosen = pick, M1_C = best$C, val_late_skill_M1 = late_skill, gates = list(B2 = b2, B3 = b3, B4 = b4, B5 = b5), verdict = verdict)
    cat(sprintf("%-30s n=%d ev=%d | M0 %.4f M_sim %.4f (skill %+.3f) M1 %.4f (skill %+.3f lo %+.4f slope %.2f ece %.3f lift %.2f ev %d late %+.3f) -> %s [%s]\n", paste0(rn, "|", pos), length(yv), sum(yv), res$M0$brier, res$M_sim$brier, res$M_sim$skill_vs_M0, res$M1$brier, res$M1$skill_vs_M0, res$M1$boot_vs_M0$lo95, res$M1$slope, res$M1$ece, res$M1$top_decile_lift, res$M1$top_decile_events, late_skill, verdict, pick)) } }
write_json(spk, "scripts/w2r1/results/s6_kdst_spike.json", auto_unbox = TRUE, pretty = TRUE, digits = 5)
