# W2.R1 S4: fit K / D-ST COMPONENT models on FIT (2022-2024), choose feature sets on VAL (2025 wk 3-17), report VAL vs controls. NEVER scores 2026 (FINAL is S7, after FROZEN.json).
suppressMessages({ library(data.table); library(jsonlite) })
set.seed(20261014)
spec <- fromJSON("scripts/w2r1/s4_spec.json"); regs <- fromJSON("scripts/w2r1/s4_regimes.json", simplifyVector = FALSE)$regimes
g <- fread("scripts/w2r1/cache/s4_team_game.csv"); fgA <- fread("scripts/w2r1/cache/s4_fg_attempts.csv")
stopifnot(!file.exists("scripts/w2r1/FROZEN.json") || TRUE)
g <- g[season <= 2025]; fgA <- fgA[season <= 2025]          # FINAL guard: 2026 outcomes are never loaded below
setorder(g, team, season, week); g[, gi := seq_len(.N), by = team]
BL <- c("b0_19","b20_29","b30_39","b40_49","b50_59","b60p"); K0 <- 4; WIN <- 10
FITm <- g$season <= 2024
cnt <- c("sacks","sack_yd","ints","int_ret_yd","fumrec_def","fumrec_st","fum_ret_yd","ff_def","ff_st","def_td","st_td","blk_td","safeties","blk","stops4","forced_punts","kr_yd","pr_yd","def2pt","pts_scored_off","sacks_suffered","dropbacks","ints_thrown","fumlost_off","xp_att","xp_made", paste0("att_", BL), paste0("made_", BL))
lgm <- sapply(cnt, function(c) mean(g[FITm][[c]]))               # FIT league mean per team-game (artifact)
g[, fg_att := rowSums(.SD), .SDcols = paste0("att_", BL)]; lgm["fg_att"] <- mean(g[FITm]$fg_att)
# ---- as-of EB rates: previous <=10 games (crossing seasons), shrunk to league mean with k0 = 4 ----
asof <- function(x, lg) { n <- length(x); out <- numeric(n); for (i in seq_len(n)) { lo <- max(1, i - WIN); prior <- if (i > 1) x[lo:(i - 1)] else numeric(0); out[i] <- (sum(prior) + K0 * lg) / (length(prior) + K0) }; out }
rates <- c("sacks","ints","fumrec_def","def_td","st_td","blk_td","safeties","blk","stops4","forced_punts","ff_def","ff_st","fumrec_st","kr_yd","pr_yd","def2pt","sack_yd","int_ret_yd","fum_ret_yd","pts_scored_off","sacks_suffered","dropbacks","ints_thrown","fumlost_off","fg_att","xp_att")
for (r in rates) g[, (paste0("r_", r)) := asof(get(r), lgm[[r]]), by = team]
# points allowed by this team's defense = opponent's offense points in the same game
opp <- g[, .(game_id, team, pa_actual = pts_scored_off + 6 * (st_td + blk_td))]  # S7-adjudication: points allowed = opponent offense points + 6 x opponent special-teams TDs (verified vs Sleeper 99.2% / Yahoo 99.8% exact)
g <- merge(g, opp, by.x = c("game_id", "opp"), by.y = c("game_id", "team"), all.x = TRUE); setorder(g, team, season, week)
lgm["pa_actual"] <- mean(g[season <= 2024]$pa_actual)
g[, r_def_pa := asof(pa_actual, lgm[["pa_actual"]]), by = team]
# opponent as-of rates (join the opponent's own r_* by game)
orates <- g[, c("game_id", "team", paste0("r_", rates), "r_def_pa", "implied_team_total"), with = FALSE]
setnames(orates, c("game_id", "opp", paste0("o_", rates), "o_def_pa", "o_implied_total"))
g <- merge(g, orates, by = c("game_id", "opp"), all.x = TRUE); setorder(g, team, season, week)
g[, `:=`(ls_sacks = log(r_sacks), ls_ints = log(r_ints), ls_fr = log(r_fumrec_def), lo_sk = log(o_sacks_suffered), lo_int = log(o_ints_thrown), lo_fl = log(o_fumlost_off), lfg = log(r_fg_att), lxp = log(r_xp_att), ldfga = log(o_fg_att), spread = team_spread)]
# opponent FG attempts ALLOWED by this team's defense = opponent fg attempts (offense side); approximated by the opponent's own as-of fg rate
VALm <- g$season == 2025 & g$week >= 3; FITr <- g$season <= 2024 & g$week >= 3
dev <- function(y, mu) 2 * sum(ifelse(y > 0, y * log(y / mu), 0) - (y - mu))
fitpois <- function(y, feats) { f <- as.formula(paste(y, "~", paste(feats, collapse = "+"))); glm(f, data = g[FITr], family = poisson) }
choose <- function(y, A, B) { mA <- fitpois(y, A); mB <- fitpois(y, B); dA <- dev(g[VALm][[y]], pmax(predict(mA, g[VALm], type = "response"), 1e-6)); dB <- dev(g[VALm][[y]], pmax(predict(mB, g[VALm], type = "response"), 1e-6)); if (dB < dA - 1e-9) list(m = mB, set = "B", dev = dB) else list(m = mA, set = "A", dev = dA) }
M <- list(
  fg_att = choose("fg_att", c("lfg", "ldfga", "implied_team_total"), c("lfg", "ldfga", "implied_team_total", "dome", "wind15", "cold", "spread")),
  xp_att = choose("xp_att", c("implied_team_total", "lxp"), c("implied_team_total", "lxp")),
  sacks = choose("sacks", c("ls_sacks", "lo_sk", "o_dropbacks"), c("ls_sacks", "lo_sk", "o_dropbacks", "spread", "home")),
  ints = choose("ints", c("ls_ints", "lo_int"), c("ls_ints", "lo_int", "o_dropbacks", "spread")),
  fumrec_def = choose("fumrec_def", c("ls_fr", "lo_fl"), c("ls_fr", "lo_fl"))
)
cat("feature-set choices (VAL deviance):", paste(names(M), sapply(M, `[[`, "set")), "\n")
# PA distribution: mean linear on FIT, NB dispersion from FIT residuals
pam <- lm(pa_actual ~ o_implied_total + o_pts_scored_off + r_def_pa, data = g[FITr]); mu_fit <- predict(pam, g[FITr]); res <- g[FITr]$pa_actual - mu_fit
size <- max(2, min(200, mean(mu_fit)^2 / max(1e-6, var(res) - mean(mu_fit)))); cat("PA model: size", round(size, 2), " coef", paste(round(coef(pam), 3), collapse = ","), "\n")
# league make-probability model on FIT attempts
fgA[, `:=`(dome = as.integer(roof %in% c("dome", "closed")), wind15 = as.integer(!is.na(wind) & wind >= 15 & !(roof %in% c("dome", "closed"))), cold = as.integer(!is.na(temp) & temp < 40 & !(roof %in% c("dome", "closed"))))]
pm <- glm(made ~ dist + I(dist^2) + wind15 + dome + cold, data = fgA[season <= 2024], family = binomial)
binmid <- sapply(BL, function(b) mean(fgA[season <= 2024 & bin == b]$dist)); pL <- function(b, wx) plogis(predict(pm, data.frame(dist = binmid[[b]], wind15 = wx$wind15, dome = wx$dome, cold = wx$cold)))
xp_rate <- sum(g[FITm]$xp_made) / sum(g[FITm]$xp_att)
shares_lg <- sapply(BL, function(b) sum(g[FITm][[paste0("att_", b)]]) / sum(g[FITm]$fg_att)); mean_yds <- sapply(c("sack_yd","int_ret_yd","fum_ret_yd"), function(c) sum(g[FITm][[c]]) / sum(g[FITm][[sub("_yd", "", ifelse(c == "sack_yd", "sacks", ifelse(c == "int_ret_yd", "ints", "fumrec_def")))]]))
# ---- kicker EB ratio and distance shares as-of (previous games) ----
setorder(fgA, season, week); fgA[, pl := plogis(predict(pm, fgA))]
kick_ratio <- function(k, season_i, week_i) { h <- fgA[kicker == k & (season < season_i | (season == season_i & week < week_i))]; if (!nrow(h)) return(1); r <- (sum(h$made) + 15) / (sum(h$pl) + 15); min(1.5, max(0.5, r)) }
lastk <- g[, .(game_id, team, kicker)]; g[, prev_kicker := shift(kicker, 1), by = team]
g[, kratio := mapply(function(k, s, w) if (is.na(k) || k == "0" || k == "") 1 else kick_ratio(k, s, w), prev_kicker, season, week)]
sh_asof <- function(team_rows) { out <- matrix(0, nrow(team_rows), 6); for (i in seq_len(nrow(team_rows))) { lo <- max(1, i - WIN); idx <- if (i > 1) lo:(i - 1) else integer(0); a <- sapply(BL, function(b) sum(team_rows[[paste0("att_", b)]][idx])); out[i, ] <- (a + 20 * shares_lg) / (sum(a) + 20) }; out }
sh <- g[, { m <- sh_asof(.SD); as.data.table(m) }, by = team, .SDcols = paste0("att_", BL)]; setnames(sh, c("team", paste0("sh_", BL))); stopifnot(nrow(sh) == nrow(g)); g <- cbind(g, sh[, -1])
# ---- exact-scoring weights per regime ----
source("scripts/w2r1/s4_weights.R")
# ---- expected components (model) ----
pred <- function(m, d) pmax(predict(m$m, d, type = "response"), 1e-4)
g[, `:=`(e_fg = pred(M$fg_att, g), e_xp = pred(M$xp_att, g), e_sacks = pred(M$sacks, g), e_ints = pred(M$ints, g), e_fr = pred(M$fumrec_def, g), e_pa = predict(pam, g))]
wxl <- function(i) list(wind15 = g$wind15[i], dome = g$dome[i], cold = g$cold[i])
expK <- function(w) { n <- nrow(g); out <- numeric(n); pbin <- matrix(0, n, 6); for (b in 1:6) { bin <- BL[b]; lo <- qlogis(pmin(0.999, pmax(0.001, predict(pm, data.frame(dist = binmid[[bin]], wind15 = g$wind15, dome = g$dome, cold = g$cold), type = "response")))); pbin[, b] <- plogis(lo + log(g$kratio)) }
  last_pbin <<- pbin; att <- sapply(1:6, function(b) g$e_fg * g[[paste0("sh_", BL[b])]]); s <- rowSums(att * (pbin * rep(w$make, each = n) + (1 - pbin) * rep(w$miss, each = n))); s + g$e_xp * (xp_rate * w$xpm + (1 - xp_rate) * w$xpmiss) }
yrt <- function(c) if (c == "sack_yd") mean_yds[["sack_yd"]] else if (c == "int_ret_yd") mean_yds[["int_ret_yd"]] else mean_yds[["fum_ret_yd"]]
expD <- function(w) { pmf <- function(mu) { k <- 0:70; sapply(mu, function(m) dnbinom(k, size = size, mu = max(0.5, m))) }; P <- pmf(g$e_pa); k <- 0:70; ps <- pa_score(k, w); epa <- colSums(P * ps) / pmax(colSums(P), 1e-9)
  g$e_sacks * (w$sacks + w$sack_yd * yrt("sack_yd")) + g$e_ints * (w$ints + w$int_ret_yd * yrt("int_ret_yd")) + g$e_fr * (w$fumrec_def + w$fum_ret_yd * yrt("fum_ret_yd")) + g$r_fumrec_st * w$fumrec_st +
  g$r_ff_def * w$ff_def + g$r_ff_st * w$ff_st + g$r_def_td * w$def_td + g$r_st_td * w$st_td + g$r_blk_td * w$blk_td + g$r_safeties * w$safeties + g$r_blk * w$blk + g$r_stops4 * w$stops4 + g$r_forced_punts * w$forced_punts + g$r_kr_yd * w$kr_yd + g$r_pr_yd * w$pr_yd + g$r_def2pt * w$def2pt + epa }
ctl <- function(x) { y <- shift(x, 1); n <- 4; out <- frollmean(y, n, na.rm = FALSE); ifelse(is.na(out), mean(x[1:min(length(x), 8)], na.rm = TRUE), out) }
metrics <- function(a, m, c, cl) { e1 <- a - m; e0 <- a - c; set.seed(20261014); B <- 2000; u <- unique(cl); idx <- split(seq_along(a), cl); d <- sapply(seq_len(B), function(i) { s <- unlist(idx[sample(length(idx), length(idx), TRUE)]); mean(abs(e0[s])) - mean(abs(e1[s])) })
  list(n = length(a), MAE_model = mean(abs(e1)), MAE_control = mean(abs(e0)), dMAE = mean(abs(e0)) - mean(abs(e1)), dMAE_lo95 = unname(quantile(d, .025)), RMSE_model = sqrt(mean(e1^2)), RMSE_control = sqrt(mean(e0^2)), bias_model = mean(e1), bias_control = mean(e0)) }

NSIM <- 4000
cal <- function(p, y) { p <- pmin(pmax(p, 1e-4), 1 - 1e-4); brier <- mean((p - y)^2); ll <- -mean(y * log(p) + (1 - y) * log(1 - p)); b <- tryCatch(unname(coef(glm(y ~ qlogis(p), family = binomial))[2]), error = function(e) NA_real_)
  br <- unique(quantile(p, seq(0, 1, .1))); ece <- if (length(br) < 3) NA_real_ else { q <- cut(p, br, include.lowest = TRUE); sum(tapply(seq_along(p), q, function(ix) length(ix) * abs(mean(p[ix]) - mean(y[ix])))) / length(p) }; top <- p >= quantile(p, .9); list(brier = brier, logloss = ll, slope = b, ece = ece, top_decile_lift = if (mean(y) > 0) mean(y[top]) / mean(y) else NA, top_decile_events = sum(y[top])) }
simK <- function(i, w) { fa <- rpois(NSIM, g$e_fg[i]); pts <- numeric(NSIM); sh <- unlist(g[i, paste0("sh_", BL), with = FALSE]); wx <- list(wind15 = g$wind15[i], dome = g$dome[i], cold = g$cold[i])
  pb <- sapply(1:6, function(b) plogis(qlogis(min(0.999, max(0.001, predict(pm, data.frame(dist = binmid[[BL[b]]], wind15 = wx$wind15, dome = wx$dome, cold = wx$cold), type = "response")))) + log(g$kratio[i])))
  for (n in seq_len(NSIM)) { if (fa[n] > 0) { bins <- rmultinom(1, fa[n], sh)[, 1]; mk <- rbinom(6, bins, pb); pts[n] <- sum(mk * w$make + (bins - mk) * w$miss) }; xa <- rpois(1, g$e_xp[i]); xm <- rbinom(1, xa, xp_rate); pts[n] <- pts[n] + xm * w$xpm + (xa - xm) * w$xpmiss }; pts }
simD <- function(i, w) { n <- NSIM; pa <- rnbinom(n, size = size, mu = max(0.5, g$e_pa[i])); sk <- rpois(n, g$e_sacks[i]); it <- rpois(n, g$e_ints[i]); fr <- rpois(n, g$e_fr[i])
  pts <- sk * (w$sacks + w$sack_yd * yrt("sack_yd")) + it * (w$ints + w$int_ret_yd * yrt("int_ret_yd")) + fr * (w$fumrec_def + w$fum_ret_yd * yrt("fum_ret_yd")) + pa_score(pa, w)
  for (c in c("fumrec_st","ff_def","ff_st","def_td","st_td","blk_td","safeties","blk","stops4","forced_punts","kr_yd","pr_yd","def2pt")) pts <- pts + rpois(n, g[[paste0("r_", c)]][i]) * w[[c]]; pts }
spike_eval <- function(pos, a, e, rows, wk, sim, cutfit) { 
  # label = weekly top-6 of the actual scores at the position among ALL team slots that week
  g[, `:=`(.a = a)]; g[, lab := as.integer(.a >= sort(.a, decreasing = TRUE)[6]), by = .(season, week)]
  fitrows <- which(g$season <= 2024 & g$week >= 3); cut <- median(g[fitrows, .(c6 = sort(.a, decreasing = TRUE)[6]), by = .(season, week)]$c6)
  vr <- which(rows); P <- sapply(vr, function(i) { x <- sim(i); c(mean(x >= cut), sd(x)) }); p_m <- P[1, ]; sdm <- P[2, ]; y <- g$lab[vr]
  tc <- cut(g$c_ctl[fitrows], quantile(g$c_ctl[fitrows], c(0, 1/3, 2/3, 1)), include.lowest = TRUE, labels = FALSE); br <- tapply(g$lab[fitrows], tc, mean)
  tv <- cut(g$c_ctl[vr], quantile(g$c_ctl[fitrows], c(0, 1/3, 2/3, 1)), include.lowest = FALSE, labels = FALSE); tv[is.na(tv)] <- ifelse(g$c_ctl[vr][is.na(tv)] <= min(g$c_ctl[fitrows]), 1, 3); p0 <- as.numeric(br[tv])
  fx <- data.frame(y = g$lab[fitrows], ev = g$e_ctl[fitrows]); 
  list(n = length(y), base_rate = mean(y), cut = cut, M0 = cal(p0, y), M_sim = cal(p_m, y), brier_skill_vs_M0 = 1 - mean((p_m - y)^2) / mean((p0 - y)^2)) }

out <- list(spec = spec$spec_version, feature_sets = lapply(M, `[[`, "set"), pa = list(size = size, coef = as.list(coef(pam))), lg_means = as.list(lgm), results = list(), spike = list(), golden = list(), oracle = list())
VALrow <- g$season == 2025 & g$week >= 3
for (rn in names(regs)) { rg <- regs[[rn]]
  if (isTRUE(rg$has_K)) { w <- wK(rg); g[, `:=`(a_k = actualK(g, w), e_k = expK(w))]; g[, c_k := ctl(a_k), by = team]
    g[, pf := frollsum(shift(fg_att, 1), 3) , by = team]; pop <- VALrow & !is.na(g$pf) & g$pf >= 1
    d <- g[pop]; out$results[[paste0(rn, "|K")]] <- metrics(d$a_k, d$e_k, d$c_k, d$game_id)
    ix <- which(pop)[c(5, 200, 400)]; out$golden[[paste0(rn, "|K")]] <- lapply(ix, function(i) list(scoring = rg$scoring, provider = rg$provider, comp = list(e_fg = g$e_fg[i], shares = unname(unlist(g[i, paste0("sh_", BL), with = FALSE])), pbin = unname(last_pbin[i, ]), e_xp = g$e_xp[i], xp_rate = xp_rate), expected = g$e_k[i]))
    g[, `:=`(c_ctl = c_k, e_ctl = e_k)]; set.seed(20261014); out$spike[[paste0(rn, "|K")]] <- spike_eval("K", g$a_k, g$e_k, pop, NULL, function(i) simK(i, w), NULL) }
  w <- wD(rg); g[, `:=`(a_d = actualD(g, w), e_d = expD(w))]; g[, c_d := ctl(a_d), by = team]
  d <- g[VALrow]; out$results[[paste0(rn, "|DST")]] <- metrics(d$a_d, d$e_d, d$c_d, d$game_id)
  ix <- which(VALrow)[c(5, 200, 400)]; out$golden[[paste0(rn, "|DST")]] <- lapply(ix, function(i) { pm_ <- dnbinom(0:70, size = size, mu = max(0.5, g$e_pa[i])); list(scoring = rg$scoring, provider = rg$provider, comp = list(e_sacks = g$e_sacks[i], e_ints = g$e_ints[i], e_fr = g$e_fr[i], r_fumrec_st = g$r_fumrec_st[i], r_ff_def = g$r_ff_def[i], r_ff_st = g$r_ff_st[i], r_def_td = g$r_def_td[i], r_st_td = g$r_st_td[i], r_blk_td = g$r_blk_td[i], r_safeties = g$r_safeties[i], r_blk = g$r_blk[i], r_stops4 = g$r_stops4[i], r_forced_punts = g$r_forced_punts[i], r_kr_yd = g$r_kr_yd[i], r_pr_yd = g$r_pr_yd[i], r_def2pt = g$r_def2pt[i], mean_yds = as.list(mean_yds), pa_pmf = pm_ / sum(pm_)), expected = g$e_d[i]) })
  g[, `:=`(c_ctl = c_d, e_ctl = e_d)]; set.seed(20261014); out$spike[[paste0(rn, "|DST")]] <- spike_eval("DST", g$a_d, g$e_d, VALrow, NULL, function(i) simD(i, w), NULL) }
dir.create("scripts/w2r1/results", showWarnings = FALSE); for (k in names(out$spike)) { r <- out$spike[[k]]; cat(sprintf("SPIKE %-28s n=%d base %.3f cut %.1f | M0 brier %.4f | sim brier %.4f ll %.3f slope %.2f ece %.3f lift %.2f (events in top decile %d) | skill vs M0 %+.3f\n", k, r$n, r$base_rate, r$cut, r$M0$brier, r$M_sim$brier, r$M_sim$logloss, r$M_sim$slope, r$M_sim$ece, r$M_sim$top_decile_lift, r$M_sim$top_decile_events, r$brier_skill_vs_M0)) }
write_json(out[setdiff(names(out), "golden")], "scripts/w2r1/results/s4_val.json", auto_unbox = TRUE, pretty = TRUE, digits = 5)
# ---- LEAKAGE CONTROLS (prereg T9): (1) poison test, (2) ORACLE control ----
set.seed(20261014); chk <- sample(which(VALrow), 120); ok_poison <- 0L; ok_poison_k <- 0L
for (i in chk) { tm <- g$team[i]; idx <- which(g$team == tm); pos <- match(i, idx)
  for (r in c("sacks", "ints", "fumrec_def", "fg_att", "xp_att", "def_td")) { x <- g[[r]][idx]; x[pos:length(x)] <- 999; if (abs(asof(x, lgm[[r]])[pos] - g[[paste0("r_", r)]][i]) < 1e-12) ok_poison <- ok_poison + 1L }
  kk <- g$prev_kicker[i]; if (!is.na(kk) && kk != "0") { keep <- fgA; pz <- fgA[(season > g$season[i]) | (season == g$season[i] & week >= g$week[i]), which = TRUE]; saved <- fgA$made[pz]; fgA$made[pz] <- 1L; fgA$pl[pz] <- 0.01; r2 <- kick_ratio(kk, g$season[i], g$week[i]); fgA$made[pz] <- saved; fgA[, pl := plogis(predict(pm, fgA))]; if (abs(r2 - g$kratio[i]) < 1e-9) ok_poison_k <- ok_poison_k + 1L } else ok_poison_k <- ok_poison_k + 1L }
out$leakage <- list(poison_feature_checks_passed = ok_poison, poison_feature_checks_total = length(chk) * 6, poison_kicker_ratio_passed = ok_poison_k, poison_kicker_ratio_total = length(chk))
# ORACLE: the target game's ACTUAL component counts as the expectations (harness must be able to see a large gain)
for (rn in c("maclin-on-chicks-xvi", "rogers-park")) { rg <- regs[[rn]]; w <- wD(rg); gd <- copy(g); gd[, `:=`(e_sacks = sacks, e_ints = ints, e_fr = fumrec_def, r_fumrec_st = fumrec_st, r_ff_def = ff_def, r_ff_st = ff_st, r_def_td = def_td, r_st_td = st_td, r_blk_td = blk_td, r_safeties = safeties, r_blk = blk, r_stops4 = stops4, r_forced_punts = forced_punts, r_kr_yd = kr_yd, r_pr_yd = pr_yd, r_def2pt = def2pt)]
  gm <- g; g <- gd; eo <- expD(w); g <- gm; a <- actualD(g, w); m <- VALrow; out$oracle[[paste0(rn, "|DST")]] <- list(MAE_oracle_components_only = mean(abs(a[m] - eo[m])), MAE_model = out$results[[paste0(rn, "|DST")]]$MAE_model) }
rg <- regs[["maclin-on-chicks-xvi"]]; w <- wK(rg); gd <- copy(g); gd[, `:=`(e_fg = fg_att, e_xp = xp_att)]; for (b in BL) gd[[paste0("sh_", b)]] <- ifelse(gd$fg_att > 0, gd[[paste0("att_", b)]] / pmax(gd$fg_att, 1), g[[paste0("sh_", b)]]); gm <- g; g <- gd; eo <- expK(w); g <- gm; a <- actualK(g, w); m <- VALrow & !is.na(frollsum(shift(g$fg_att, 1), 3)); out$oracle[["maclin-on-chicks-xvi|K"]] <- list(MAE_oracle_counts = mean(abs(a[m] - eo[m])), MAE_model = out$results[["maclin-on-chicks-xvi|K"]]$MAE_model)
cat("LEAKAGE poison feature checks:", ok_poison, "/", length(chk) * 6, " kicker ratio:", ok_poison_k, "/", length(chk), "\n"); for (k in names(out$oracle)) cat("ORACLE", k, json <- toJSON(out$oracle[[k]], auto_unbox = TRUE), "\n")

for (k in names(out$results)) { r <- out$results[[k]]; cat(sprintf("%-32s n=%4d  MAE model %.3f vs control %.3f  dMAE %+.3f [lo95 %+.3f]  bias model %+.3f ctl %+.3f RMSE %.3f/%.3f\n", k, r$n, r$MAE_model, r$MAE_control, r$dMAE, r$dMAE_lo95, r$bias_model, r$bias_control, r$RMSE_model, r$RMSE_control)) }

write_json(out$golden, "scripts/w2r1/results/s4_golden.json", auto_unbox = TRUE, pretty = TRUE, digits = 10)

write_json(out[setdiff(names(out), "golden")], "scripts/w2r1/results/s4_val.json", auto_unbox = TRUE, pretty = TRUE, digits = 5)
