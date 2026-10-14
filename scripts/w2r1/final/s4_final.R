# W2.R1 S7 FINAL (S4 K / D-ST). Derives the FINAL scorers from the FROZEN S4 scripts by MECHANICAL, asserted text substitutions (no frozen file is edited) and runs them.
# The models are fit on FIT (2022-2024) exactly as frozen; the VAL feature-set choices are re-derived from the same VAL data and asserted equal to the frozen choices; only the SCORED rows change (2026 wk 1-5).
suppressMessages({ library(jsonlite) })
sub1 <- function(x, a, b) { stopifnot(grepl(a, x, fixed = TRUE)); sub(a, b, x, fixed = TRUE) }
dir.create("scripts/w2r1/final/generated", FALSE, TRUE); dir.create("scripts/w2r1/results/final", FALSE, TRUE)
b <- paste(readLines("scripts/w2r1/s4_build.R"), collapse = "\n")
b <- sub1(b, "seasons <- 2022:2025", "seasons <- 2022:2026")
b <- sub1(b, "g <- g[played == TRUE]", "g <- g[played == TRUE]; g <- g[season < 2026 | week <= 5]   # FINAL set = 2026 weeks 1-5 completed games")
b <- sub1(b, 'fwrite(g, "scripts/w2r1/cache/s4_team_game.csv")', 'fwrite(g, "scripts/w2r1/cache/s4_team_game_final.csv")')
b <- sub1(b, 'fwrite(fg[!is.na(bin), .(game_id', 'fg <- fg[game_id %in% g$game_id]; fwrite(fg[!is.na(bin), .(game_id')
b <- sub1(b, '"scripts/w2r1/cache/s4_fg_attempts.csv"', '"scripts/w2r1/cache/s4_fg_attempts_final.csv"')
writeLines(b, "scripts/w2r1/final/generated/s4_build_final.R")
f <- paste(readLines("scripts/w2r1/s4_fit_eval.R"), collapse = "\n")
f <- sub1(f, 'fread("scripts/w2r1/cache/s4_team_game.csv")', 'fread("scripts/w2r1/cache/s4_team_game_final.csv")')
f <- sub1(f, 'fread("scripts/w2r1/cache/s4_fg_attempts.csv")', 'fread("scripts/w2r1/cache/s4_fg_attempts_final.csv")')
f <- sub1(f, "g <- g[season <= 2025]; fgA <- fgA[season <= 2025]", "g <- g[season <= 2025 | (season == 2026 & week <= 5)]; fgA <- fgA[season <= 2025 | (season == 2026 & week <= 5)]")
f <- sub1(f, "VALrow <- g$season == 2025 & g$week >= 3", "VALrow <- g$season == 2026 & g$week <= 5   # FINAL rows (the VALm used by choose() above is UNCHANGED: 2025 wk>=3)")
# capture per-slot FINAL rows for the preregistered gates
f <- sub1(f, 'd <- g[pop]; out$results[[paste0(rn, "|K")]] <- metrics(d$a_k, d$e_k, d$c_k, d$game_id)',
  'd <- g[pop]; out$results[[paste0(rn, "|K")]] <- metrics(d$a_k, d$e_k, d$c_k, d$game_id); FIN[[paste0(rn, "|K")]] <- data.table(game_id = d$game_id, week = d$week, season = d$season, team = d$team, actual = d$a_k, model = d$e_k, control = d$c_k)')
f <- sub1(f, 'd <- g[VALrow]; out$results[[paste0(rn, "|DST")]] <- metrics(d$a_d, d$e_d, d$c_d, d$game_id)',
  'd <- g[VALrow]; out$results[[paste0(rn, "|DST")]] <- metrics(d$a_d, d$e_d, d$c_d, d$game_id); FIN[[paste0(rn, "|DST")]] <- data.table(game_id = d$game_id, week = d$week, season = d$season, team = d$team, actual = d$a_d, model = d$e_d, control = d$c_d)')
f <- sub1(f, 'VALrow <- g$season == 2026', 'FIN <- list(); VALrow <- g$season == 2026')
f <- sub1(f, 'write_json(out[setdiff(names(out), "golden")], "scripts/w2r1/results/s4_val.json", auto_unbox = TRUE, pretty = TRUE, digits = 5)\n# ---- LEAKAGE', 'write_json(out[setdiff(names(out), "golden")], "scripts/w2r1/results/final/s4_final_raw.json", auto_unbox = TRUE, pretty = TRUE, digits = 5)\n# ---- LEAKAGE')
# remove the trailing writes of golden / val artifacts (must NOT overwrite frozen artifacts)
f <- sub1(f, 'write_json(out$golden, "scripts/w2r1/results/s4_golden.json", auto_unbox = TRUE, pretty = TRUE, digits = 10)', "")
f <- sub1(f, 'write_json(out[setdiff(names(out), "golden")], "scripts/w2r1/results/s4_val.json", auto_unbox = TRUE, pretty = TRUE, digits = 5)', 'saveRDS(FIN, "scripts/w2r1/cache/s4_final_rows.rds"); write_json(out[setdiff(names(out), "golden")], "scripts/w2r1/results/final/s4_final_raw.json", auto_unbox = TRUE, pretty = TRUE, digits = 5)')

# T9 oracle control for EVERY regime (frozen harness ran it for 3 slots only; the control is a harness-sensitivity check, not a candidate change)
f <- sub1(f, 'for (rn in c("maclin-on-chicks-xvi", "rogers-park")) { rg <- regs[[rn]]; w <- wD(rg)', 'for (rn in names(regs)) { rg <- regs[[rn]]; w <- wD(rg)')
f <- sub1(f, 'rg <- regs[["maclin-on-chicks-xvi"]]; w <- wK(rg); gd <- copy(g);', 'for (rn in Filter(function(z) isTRUE(regs[[z]]$has_K), names(regs))) { rg <- regs[[rn]]; w <- wK(rg); gd <- copy(g);')
f <- sub1(f, 'out$oracle[["maclin-on-chicks-xvi|K"]] <- list(MAE_oracle_counts = mean(abs(a[m] - eo[m])), MAE_model = out$results[["maclin-on-chicks-xvi|K"]]$MAE_model)', 'out$oracle[[paste0(rn, "|K")]] <- list(MAE_oracle_counts = mean(abs(a[m] - eo[m])), MAE_model = out$results[[paste0(rn, "|K")]]$MAE_model) }')
writeLines(f, "scripts/w2r1/final/generated/s4_fit_eval_final.R")
stopifnot(!grepl("results/s4_val.json|results/s4_golden.json", f))
cat("generated\n")
