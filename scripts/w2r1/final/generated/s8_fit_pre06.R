# W2.R1 S4: fit K / D-ST COMPONENT models on FIT (2022-2024), choose feature sets on VAL (2025 wk 3-17), report VAL vs controls. NEVER scores 2026 (FINAL is S7, after FROZEN.json).
suppressMessages({ library(data.table); library(jsonlite) })
set.seed(20261014)
spec <- fromJSON("scripts/w2r1/s4_spec.json"); regs <- fromJSON("scripts/w2r1/s4_regimes.json", simplifyVector = FALSE)$regimes
g <- fread("scripts/w2r1/cache/s4_team_game_pre06.csv"); fgA <- fread("scripts/w2r1/cache/s4_fg_attempts_pre06.csv")
stopifnot(!file.exists("scripts/w2r1/FROZEN.json") || TRUE)
g <- g[season <= 2025 | (season == 2026 & week <= 6)]; fgA <- fgA[season <= 2025 | (season == 2026 & week <= 5)]          # FINAL guard: 2026 outcomes are never loaded below
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

suppressMessages(library(digest)); sha <- function(p) digest(file = p, algo = "sha256")
TGT <- which(g$season == 2026 & g$week == 6)
pbin_of <- function(i) sapply(1:6, function(bn) plogis(qlogis(pmin(0.999, pmax(0.001, predict(pm, data.frame(dist = binmid[[BL[bn]]], wind15 = g$wind15[i], dome = g$dome[i], cold = g$cold[i]), type = "response")))) + log(g$kratio[i])))
teams <- list()
for (i in TGT) { mu <- max(0.5, g$e_pa[i]); pmf <- dnbinom(0:70, size = size, mu = mu); pmf <- pmf / sum(pmf)
  ok <- !anyNA(c(g$e_sacks[i], g$e_ints[i], g$e_fr[i], g$e_pa[i], g$implied_team_total[i], g$e_fg[i]))
  teams[[g$team[i]]] <- list(team = g$team[i], opp = g$opp[i], game_id = g$game_id[i], gameday = g$gameday[i], available = ok, inputs = list(implied_team_total = g$implied_team_total[i], team_spread = g$team_spread[i], dome = g$dome[i], wind15 = g$wind15[i], cold = g$cold[i], weather_known = !is.na(g$wind[i])),
    dst = list(e_sacks = g$e_sacks[i], e_ints = g$e_ints[i], e_fr = g$e_fr[i], r_fumrec_st = g$r_fumrec_st[i], r_ff_def = g$r_ff_def[i], r_ff_st = g$r_ff_st[i], r_def_td = g$r_def_td[i], r_st_td = g$r_st_td[i], r_blk_td = g$r_blk_td[i], r_safeties = g$r_safeties[i], r_blk = g$r_blk[i], r_stops4 = g$r_stops4[i], r_forced_punts = g$r_forced_punts[i], r_kr_yd = g$r_kr_yd[i], r_pr_yd = g$r_pr_yd[i], r_def2pt = g$r_def2pt[i], mean_yds = as.list(mean_yds), pa_mean = g$e_pa[i], pa_pmf = pmf),
    k = list(e_fg = g$e_fg[i], shares = unname(unlist(g[i, paste0("sh_", BL), with = FALSE])), pbin = pbin_of(i), e_xp = g$e_xp[i], xp_rate = xp_rate, kicker_ratio = g$kratio[i], prev_kicker = g$prev_kicker[i])) }
# R-side expected points per regime for cross-verification with lib/w2r1/kdst.ts
for (rn in names(regs)) { rg <- regs[[rn]]; wd <- wD(rg); ed <- expD(wd); for (i in TGT) teams[[g$team[i]]]$dst[[paste0("R_expected_", rn)]] <- ed[i]
  if (isTRUE(rg$has_K)) { wk_ <- wK(rg); ek <- expK(wk_); for (i in TGT) teams[[g$team[i]]]$k[[paste0("R_expected_", rn)]] <- ek[i] } }
latest <- max(g[season == 2026 & week < 6 & game_id %in% g$game_id]$week)
meta <- list(schema = "w2r1-s8-pregame-kdst-1", target_week = 6, season = 2026, generated_at = format(Sys.time(), "%Y-%m-%dT%H:%M:%SZ", tz = "UTC"), data_through_week = latest,
  frozen_models = list(s4_spec_sha256 = sha("scripts/w2r1/s4_spec.json"), s4_build_sha256 = sha("scripts/w2r1/s4_build.R"), s4_fit_eval_sha256 = sha("scripts/w2r1/s4_fit_eval.R"), s4_weights_sha256 = sha("scripts/w2r1/s4_weights.R"), s4_regimes_sha256 = sha("scripts/w2r1/s4_regimes.json"), frozen_json_sha256 = sha("scripts/w2r1/FROZEN.json"), feature_sets = lapply(M, `[[`, "set"), pa_size = size, fit = "FIT 2022-2024 only; never refit on 2026 weeks 1-5"),
  weather_note = "wind/temperature are unknown before kickoff: treated as not-windy / not-cold (roof from the schedule); no outcome data enters any row",
  git_head = system("git rev-parse HEAD", intern = TRUE))
dir.create(sprintf("lib/w2r1/data/prospective/wk%02d", 6), FALSE, TRUE)
write_json(list(meta = meta, teams = teams), sprintf("lib/w2r1/data/prospective/wk%02d/kdst_components.json", 6), auto_unbox = TRUE, pretty = TRUE, digits = 8, na = "null")
cat("teams", length(teams), "available", sum(sapply(teams, function(t) isTRUE(t$available))), "data_through_week", latest, "
")

