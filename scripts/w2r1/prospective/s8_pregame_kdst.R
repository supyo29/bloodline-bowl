# W2.R1 S8: PROSPECTIVE pregame K / D-ST component forecasts for an upcoming week, from the FROZEN S4 models (fit on FIT 2022-2024 only; feature sets, PA dispersion unchanged).
# Derived from scripts/w2r1/s4_build.R and s4_fit_eval.R by asserted substitutions (frozen files untouched). Never refits on 2026 weeks 1-5; as-of features may use completed games (strictly earlier than the target week).
# Usage: Rscript scripts/w2r1/prospective/s8_pregame_kdst.R <week>
args <- commandArgs(TRUE); WK <- as.integer(args[1]); stopifnot(!is.na(WK), WK >= 6)
sub1 <- function(x, a, b) { stopifnot(grepl(a, x, fixed = TRUE)); sub(a, b, x, fixed = TRUE) }
suppressMessages({ library(jsonlite); library(digest) })
sha <- function(p) digest(file = p, algo = "sha256")
b <- paste(readLines("scripts/w2r1/s4_build.R"), collapse = "\n")
b <- sub1(b, "seasons <- 2022:2025", "seasons <- 2022:2026")
b <- sub1(b, "g <- g[played == TRUE]", sprintf("g <- g[played == TRUE | (season == 2026 & week == %d)]; g <- g[season < 2026 | week <= %d]   # upcoming week rows carry schedule/lines only; outcome columns are 0 and are NEVER read as-of", WK, WK))
b <- sub1(b, 'fwrite(g, "scripts/w2r1/cache/s4_team_game.csv")', sprintf('fwrite(g, "scripts/w2r1/cache/s4_team_game_pre%02d.csv")', WK))
b <- sub1(b, 'fwrite(fg[!is.na(bin), .(game_id', 'fg <- fg[game_id %in% g$game_id]; fwrite(fg[!is.na(bin), .(game_id')
b <- sub1(b, '"scripts/w2r1/cache/s4_fg_attempts.csv"', sprintf('"scripts/w2r1/cache/s4_fg_attempts_pre%02d.csv"', WK))
dir.create("scripts/w2r1/final/generated", FALSE, TRUE); bf <- sprintf("scripts/w2r1/final/generated/s8_build_pre%02d.R", WK); writeLines(b, bf)
stopifnot(system2("Rscript", bf) == 0)
f <- paste(readLines("scripts/w2r1/s4_fit_eval.R"), collapse = "\n")
f <- sub1(f, 'fread("scripts/w2r1/cache/s4_team_game.csv")', sprintf('fread("scripts/w2r1/cache/s4_team_game_pre%02d.csv")', WK))
f <- sub1(f, 'fread("scripts/w2r1/cache/s4_fg_attempts.csv")', sprintf('fread("scripts/w2r1/cache/s4_fg_attempts_pre%02d.csv")', WK))
f <- sub1(f, "g <- g[season <= 2025]; fgA <- fgA[season <= 2025]", sprintf("g <- g[season <= 2025 | (season == 2026 & week <= %d)]; fgA <- fgA[season <= 2025 | (season == 2026 & week <= 5)]", WK))
cut <- regexpr("ctl <- function(x)", f, fixed = TRUE); stopifnot(cut > 0); f <- substr(f, 1, cut - 1)
exp_block <- sprintf('
suppressMessages(library(digest)); sha <- function(p) digest(file = p, algo = "sha256")
TGT <- which(g$season == 2026 & g$week == %d)
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
latest <- max(g[season == 2026 & week < %d & game_id %%in%% g$game_id]$week)
meta <- list(schema = "w2r1-s8-pregame-kdst-1", target_week = %d, season = 2026, generated_at = format(Sys.time(), "%%Y-%%m-%%dT%%H:%%M:%%SZ", tz = "UTC"), data_through_week = latest,
  frozen_models = list(s4_spec_sha256 = sha("scripts/w2r1/s4_spec.json"), s4_build_sha256 = sha("scripts/w2r1/s4_build.R"), s4_fit_eval_sha256 = sha("scripts/w2r1/s4_fit_eval.R"), s4_weights_sha256 = sha("scripts/w2r1/s4_weights.R"), s4_regimes_sha256 = sha("scripts/w2r1/s4_regimes.json"), frozen_json_sha256 = sha("scripts/w2r1/FROZEN.json"), feature_sets = lapply(M, `[[`, "set"), pa_size = size, fit = "FIT 2022-2024 only; never refit on 2026 weeks 1-5"),
  weather_note = "wind/temperature are unknown before kickoff: treated as not-windy / not-cold (roof from the schedule); no outcome data enters any row",
  git_head = system("git rev-parse HEAD", intern = TRUE))
dir.create(sprintf("lib/w2r1/data/prospective/wk%%02d", %d), FALSE, TRUE)
write_json(list(meta = meta, teams = teams), sprintf("lib/w2r1/data/prospective/wk%%02d/kdst_components.json", %d), auto_unbox = TRUE, pretty = TRUE, digits = 8, na = "null")
cat("teams", length(teams), "available", sum(sapply(teams, function(t) isTRUE(t$available))), "data_through_week", latest, "\n")
', WK, WK, WK, WK, WK)
f <- paste0(f, exp_block)
ff <- sprintf("scripts/w2r1/final/generated/s8_fit_pre%02d.R", WK); writeLines(f, ff); stopifnot(system2("Rscript", ff) == 0)
