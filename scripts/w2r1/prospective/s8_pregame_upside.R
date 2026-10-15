# W2.R1 S8: PROSPECTIVE pregame upside-likelihood rows (probability of a top-N positional finish) for an upcoming week from the FROZEN S6 M1b/M0 models (FIT 2022-2024 only; C and chain re-derived from VAL and asserted equal to the frozen s6_val.json).
# TE M1b is preserved for prospective evaluation ONLY (INSUFFICIENT_FINAL_SAMPLE); it is never refit on 2026 weeks 1-5. QB/RB are diagnostic research outputs; WR carries NO_RELIABLE_SIGNAL and no probability.
# Usage: Rscript scripts/w2r1/prospective/s8_pregame_upside.R <week>
args <- commandArgs(TRUE); WK <- as.integer(args[1]); stopifnot(!is.na(WK), WK >= 6)
sub1 <- function(x, a, b) { stopifnot(grepl(a, x, fixed = TRUE)); sub(a, b, x, fixed = TRUE) }
suppressMessages({ library(jsonlite); library(digest) }); sha <- function(p) digest(file = p, algo = "sha256")
b <- paste(readLines("scripts/w2r1/s6_build.R"), collapse = "\n")
b <- sub1(b, "SEASONS <- 2022:2025", "SEASONS <- 2022:2026")
b <- sub1(b, "cand <- cand[week >= 3 & ((season <= 2024 & week <= 18) | (season == 2025 & week <= 17))]", sprintf("cand <- cand[(week >= 3 & ((season <= 2024 & week <= 18) | (season == 2025 & week <= 17))) | (season == 2026 & week == %d)]   # upcoming week rows: outcome columns are never read", WK))
b <- sub1(b, 'T[, split := fifelse(season <= 2024, "FIT", "VAL")]', 'T[, split := fifelse(season <= 2024, "FIT", fifelse(season == 2025, "VAL", "PRE"))]')
b <- sub1(b, 'fwrite(T, "scripts/w2r1/cache/s6_rows.csv")', sprintf('fwrite(T, "scripts/w2r1/cache/s6_rows_pre%02d.csv")', WK))
b <- sub1(b, '"scripts/w2r1/cache/s6_lg_means.csv"', '"scripts/w2r1/cache/s6_lg_means_pre.csv"'); b <- sub1(b, '"scripts/w2r1/cache/s6_lg_player.csv"', '"scripts/w2r1/cache/s6_lg_player_pre.csv"')
b <- sub1(b, '"scripts/w2r1/results/s6_leak.json"', '"scripts/w2r1/final/generated/s6_leak_pre.json"')
dir.create("scripts/w2r1/final/generated", FALSE, TRUE); bf <- sprintf("scripts/w2r1/final/generated/s8_s6_build_pre%02d.R", WK); writeLines(b, bf); stopifnot(system2("Rscript", bf) == 0)
f <- paste(readLines("scripts/w2r1/s6_fit_eval.R"), collapse = "\n")
f <- sub1(f, 'suppressMessages({ library(data.table); library(jsonlite) }); set.seed(20261014)', 'suppressMessages({ library(data.table); library(jsonlite); library(digest) }); sha <- function(p) digest(file = p, algo = "sha256"); set.seed(20261014)')
f <- sub1(f, 'T <- fread("scripts/w2r1/cache/s6_rows.csv"); stopifnot(!any(T$season >= 2026))', sprintf('T <- fread("scripts/w2r1/cache/s6_rows_pre%02d.csv")', WK))
f <- sub1(f, 'prevp <- M0v; prevname <- "M0"; chain <- character(0); ladder <- list()', 'prevp <- M0v; prevname <- "M0"; chain <- character(0); ladder <- list(); selm <- list()')
f <- sub1(f, "res[[nm]] <- list(p = p, known = pr$known)", "res[[nm]] <- list(p = p, known = pr$known); selm[[nm]] <- sel")
blk <- '
  pre <- d[split == "PRE"]; frozen_val <- fromJSON("scripts/w2r1/results/s6_val.json", simplifyVector = FALSE)$positions[[pos]]; stopifnot(identical(frozen_val$last_retained, last), identical(frozen_val$verdict, verdict))
  M0p <- rate_of(pre); pm <- if (last == "M0") list(p = M0p, known = rep(FALSE, nrow(pre))) else predict_m(selm[[last]]$m, pre); m1b <- predict_m(selm[["M1b"]]$m, pre)
  nm_tab <- unique(as.data.table(nflreadr::load_ff_playerids())[!is.na(gsis_id), .(gsis_id, name)], by = "gsis_id"); pre$pname <- nm_tab$name[match(pre$gsis_id, nm_tab$gsis_id)]
  rowsout <- lapply(seq_len(nrow(pre)), function(i) list(name = pre$pname[i], gsis_id = pre$gsis_id[i], team = pre$team[i], opp = pre$opp[i], week = pre$week[i], tier = pre$tier[i], b0 = pre$b0[i], designation = pre$desig[i], tier_base_rate = M0p[i], p_frozen_rung = pm$p[i], p_M1b = m1b$p[i], model_known = isTRUE(pm$known[i]), career_prior = pre$career_prior[i]))
  out$pre[[pos]] <- list(frozen_rung = last, val_verdict = verdict, C = if (last == "M0") NA else selm[[last]]$C, base_rate_fit = base_pos, tier_rates_fit = as.list(setNames(tr_rate$r, tr_rate$tier)), n = nrow(pre), rows = rowsout)
'
f <- sub1(f, '  cat(sprintf("\\n== %s  val n=%d', paste0(blk, '  cat(sprintf("\\n== %s  val n=%d'))
f <- sub1(f, 'out <- list(spec = "w2r1-s6-spec-1", positions = list(),', 'out <- list(pre = list(), spec = "w2r1-s6-spec-1", positions = list(),')
f <- sub1(f, 'write_json(out, "scripts/w2r1/results/s6_val.json", auto_unbox = TRUE, pretty = TRUE, digits = 5)', sprintf('dir.create("lib/w2r1/data/prospective/wk%02d", FALSE, TRUE); write_json(list(meta = list(schema = "w2r1-s8-pregame-upside-1", target_week = %d, season = 2026, generated_at = format(Sys.time(), "%%Y-%%m-%%dT%%H:%%M:%%SZ", tz = "UTC"), label = "Upside likelihood — probability of a top-N positional finish", primary_labels = "QB/RB/WR top-12, TE top-6", frozen_models = list(s6_spec_sha256 = sha("scripts/w2r1/s6_spec.json"), s6_build_sha256 = sha("scripts/w2r1/s6_build.R"), s6_fit_eval_sha256 = sha("scripts/w2r1/s6_fit_eval.R"), frozen_json_sha256 = sha("scripts/w2r1/FROZEN.json")), fit = "FIT 2022-2024 only; never refit on 2026 weeks 1-5", git_head = system("git rev-parse HEAD", intern = TRUE)), positions = out$pre), "lib/w2r1/data/prospective/wk%02d/upside.json", auto_unbox = TRUE, pretty = TRUE, digits = 6, na = "null")', WK, WK, WK))
ff <- sprintf("scripts/w2r1/final/generated/s8_s6_fit_pre%02d.R", WK); writeLines(f, ff); stopifnot(system2("Rscript", ff) == 0)
