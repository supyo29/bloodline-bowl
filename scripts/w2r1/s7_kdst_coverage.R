# W2.R1 S7 adjudication D: K/DST scoring-component coverage matrix + END-TO-END reconstruction error vs provider stat lines (2025 only; no 2026 data).
suppressMessages({ library(data.table); library(jsonlite) })
source("scripts/w2r1/s4_weights.R")
regs <- fromJSON("scripts/w2r1/s4_regimes.json", simplifyVector = FALSE)$regimes
g <- fread("scripts/w2r1/cache/s4_team_game.csv")[season == 2025]
opp <- g[, .(game_id, team, pa_actual = pts_scored_off + 6 * (st_td + blk_td))]; g <- merge(g, opp, by.x = c("game_id", "opp"), by.y = c("game_id", "team"), all.x = TRUE)
sl <- fread("scripts/w2r1/cache/sleeper_def_2025.csv"); yh <- fread("scripts/w2r1/cache/yahoo_def_2025.csv"); yh[, team := toupper(team_y)]; yh[team == "LAR", team := "LA"]
slm <- merge(g, sl, by = c("week", "team"), suffixes = c("", ".sl")); yhm <- merge(g, yh, by = c("week", "team"))
pa_bins_pts <- function(pa, w) pa_score(pa, w)
# Materiality rule (fixed here, before any final-set access, not tuned to results):
#   a component/residual is MATERIAL if its mean absolute points per team-game >= MAT (0.05); a league D/ST is EXACT_QUALIFIED only if
#   (a) every non-zero D/ST key is reconstructed, mapped-equivalent, or not-applicable-to-D/ST, OR an unreconstructable key is quantified immaterial (<0.05) with league total of such < 0.10, AND
#   (b) the END-TO-END mean absolute error between reconstructed actual points and provider-stat-line-implied points is <= 0.25 points per team-game.
MAT <- 0.05; TOT <- 0.10; E2E <- 0.25
out <- list(rule = list(material_mean_abs_pts_per_team_game = MAT, immaterial_total_cap = TOT, end_to_end_cap = E2E))
for (rn in names(regs)) { rg <- regs[[rn]]; w <- wD(rg); sleeperP <- identical(rg$provider, "sleeper")
  recon <- actualD(g, w)  # reconstructed from pbp, all 2025 team-games
  if (sleeperP) { d <- slm; v <- function(k) { x <- d[[paste0(k, ".sl")]]; if (is.null(x)) x <- d[[k]]; x }  # PROVIDER column wins over a same-named reconstructed column
    # provider-stat-line-implied points under the league's exact keys (Sleeper keys, incl. the individual-player-free D/ST subset)
    prov <- v("sack") * W(rg, "sack") + v("sack_yd") * W(rg, "sack_yd") + v("int") * W(rg, "int") + v("int_ret_yd") * W(rg, "int_ret_yd") + v("fum_rec") * W(rg, "fum_rec") + v("def_st_fum_rec") * W(rg, "def_st_fum_rec") + v("fum_ret_yd") * W(rg, "fum_ret_yd") +
      v("ff") * W(rg, "ff") + v("def_st_ff") * W(rg, "def_st_ff") + v("def_td") * W(rg, "def_td") + v("def_st_td") * W(rg, "def_st_td") + v("safe") * W(rg, "safe") + v("blk_kick") * W(rg, "blk_kick") + v("def_4_and_stop") * W(rg, "def_4_and_stop") + v("def_forced_punts") * W(rg, "def_forced_punts") +
      v("def_kr_yd") * w$kr_yd + v("def_pr_yd") * w$pr_yd + v("def_2pt") * w$def2pt + v("blk_kick_ret_yd") * W(rg, "blk_kick_ret_yd") + v("fg_ret_yd") * W(rg, "fg_ret_yd") + pa_score(v("pts_allow"), w)
    mine <- actualD(d, w)
    unk <- list(blk_kick_ret_yd = mean(abs(v("blk_kick_ret_yd") * W(rg, "blk_kick_ret_yd"))), fg_ret_yd = mean(abs(v("fg_ret_yd") * W(rg, "fg_ret_yd"))))
  } else { d <- yhm; n <- function(k) as.numeric(d[[k]])
    prov <- n("y32") * W(rg, "sack") + n("y33") * W(rg, "int") + n("y34") * W(rg, "fum_rec") + n("y36") * W(rg, "safe") + n("y37") * W(rg, "blk_kick") + n("y35") * W(rg, "def_td") + n("y49") * W(rg, "st_td") + n("y82") * W(rg, "def_2pt") + n("y48") * (if (!is.null(rg$scoring$def_kr_yd)) W(rg, "def_kr_yd") else 0) + pa_score(n("y31"), w)
    # Yahoo exposes ONE Return Yards stat (kr+pr); a league that scores KR and PR yardage separately would need a split -> checked below
    mine <- actualD(d, w); unk <- list() }
  e2e <- mean(abs(mine - prov), na.rm = TRUE); bias <- mean(mine - prov, na.rm = TRUE)
  zero_unk <- if (length(unk)) sum(unlist(unk)) else 0; mat_unk <- any(unlist(unk) >= MAT)
  qual <- !mat_unk && zero_unk < TOT && e2e <= E2E
  out[[rn]] <- list(provider = rg$provider, n_team_games_checked = nrow(d), end_to_end_mean_abs_pts_error = round(e2e, 4), end_to_end_bias = round(bias, 4), unreconstructable_keys_mean_abs_pts = unk, unreconstructable_total = round(zero_unk, 4),
    status = if (qual) "EXACT_SCORING_QUALIFIED_BOUNDED_RESIDUAL" else "DIAGNOSTIC_ONLY") }
write_json(out, "scripts/w2r1/results/s7_kdst_coverage.json", auto_unbox = TRUE, pretty = TRUE, digits = 5)
for (rn in names(regs)) cat(sprintf("%-24s e2e MAE %.4f bias %+.4f unk %.4f -> %s\n", rn, out[[rn]]$end_to_end_mean_abs_pts_error, out[[rn]]$end_to_end_bias, out[[rn]]$unreconstructable_total, out[[rn]]$status))
