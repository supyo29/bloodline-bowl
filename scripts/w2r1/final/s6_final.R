# W2.R1 S7 FINAL scorer for S6 (upside likelihood), derived from the FROZEN scripts/w2r1/s6_fit_eval.R by asserted substitutions. Models are fit on FIT only (as frozen);
# the VAL ladder / C selection is re-derived and asserted equal to the frozen s6_val.json; FINAL rows are then scored with the frozen last-retained rung (and every rung, for reporting).
sub1 <- function(x, a, b) { stopifnot(grepl(a, x, fixed = TRUE)); sub(a, b, x, fixed = TRUE) }
f <- paste(readLines("scripts/w2r1/s6_fit_eval.R"), collapse = "\n")
f <- sub1(f, 'T <- fread("scripts/w2r1/cache/s6_rows.csv"); stopifnot(!any(T$season >= 2026))', 'T <- fread("scripts/w2r1/cache/s6_rows_final.csv")')
f <- sub1(f, 'prevp <- M0v; prevname <- "M0"; chain <- character(0); ladder <- list()', 'prevp <- M0v; prevname <- "M0"; chain <- character(0); ladder <- list(); selm <- list()')
f <- sub1(f, "res[[nm]] <- list(p = p, known = pr$known)", "res[[nm]] <- list(p = p, known = pr$known); selm[[nm]] <- sel")
blk <- '
  # ================= FINAL (2026 wk 1-5): frozen rung scored once =================
  fin <- d[split == "FINAL"]; yf <- fin[[y]]; M0f <- rate_of(fin); clf <- paste(fin$team, fin$week)
  rung <- function(nm) if (nm == "M0") M0f else predict_m(selm[[nm]]$m, fin)$p
  rep1 <- function(nm, p) { cc <- cal(p, yf); b0 <- mean((M0f - yf)^2); bb <- boot_brier(clf, (M0f - yf)^2, (p - yf)^2); al <- lapply(c(ELEVATED = 1.5, HIGH = 2.0), function(mult) { a <- p >= mult * base_pos; list(threshold = mult * base_pos, alerted = sum(a), precision = if (sum(a)) mean(yf[a]) else NA_real_, recall = if (sum(yf)) sum(yf[a]) / sum(yf) else NA_real_, lift = if (sum(a)) mean(yf[a]) / mean(yf) else NA_real_) })
    list(model = nm, C = if (nm == "M0") NA else selm[[nm]]$C, n = length(yf), events = sum(yf), base_rate_final = mean(yf), base_rate_fit = base_pos, brier = cc$brier, brier_M0 = b0, brier_skill_vs_M0 = 1 - cc$brier / b0, boot_vs_M0 = bb, logloss = cc$logloss, logloss_M0 = ll_of(M0f, yf), dLogLoss_vs_M0 = ll_of(M0f, yf) - cc$logloss, slope = cc$slope, ece = cc$ece, top_decile_lift = cc$top_decile_lift, top_decile_events = cc$top_decile_events, top_decile_n = cc$top_decile_n, alerts = al, reliability = cc$reliability) }
  rungs <- lapply(c("M0", "M1a", "M1b", "M1c", "M1d"), function(nm) rep1(nm, rung(nm))); names(rungs) <- c("M0", "M1a", "M1b", "M1c", "M1d")
  cand <- rungs[[last]]; Lval <- if (last == "M0") NULL else ladder[[last]]; late_ok_val <- !is.null(Lval) && Lval$val_late$brier_skill_vs_M0 >= 0.02 && Lval$val_late$logloss_gain_vs_M0 > 0
  g <- list(B1 = cand$events >= 40, B2 = !is.na(cand$boot_vs_M0$lo95) && cand$brier_skill_vs_M0 >= 0.02 && cand$boot_vs_M0$lo95 > 0, B3 = cand$dLogLoss_vs_M0 > 0, B4 = !is.na(cand$slope) && cand$slope >= 0.8 && cand$slope <= 1.2 && cand$ece <= 0.03, B5 = !is.na(cand$top_decile_lift) && cand$top_decile_lift >= 1.3 && cand$top_decile_events >= 10, VAL_LATE = late_ok_val)
  fstat <- if (!g$B1) "INSUFFICIENT_FINAL_SAMPLE" else if (last == "M0") "NO_RELIABLE_SIGNAL" else if (all(unlist(g))) "SHADOW_QUALIFIED" else "NO_RELIABLE_SIGNAL"
  byw <- lapply(split(seq_len(nrow(fin)), fin$week >= 3), function(ix) list(n = length(ix), events = sum(yf[ix]), brier = mean((rung(last)[ix] - yf[ix])^2), brier_M0 = mean((M0f[ix] - yf[ix])^2)))
  names(byw) <- ifelse(names(byw) == "TRUE", "weeks_3_5", "weeks_1_2")
  out$final[[pos]] <- list(frozen_last_retained_on_VAL = last, val_verdict = verdict, candidate = cand, gates = g, final_status = fstat, all_rungs = rungs, by_week_block = byw)
  cat(sprintf("FINAL %s: n=%d events=%d | %s Brier skill vs M0 %+.3f [lo95 %+.4f] dLL %+.4f slope %.2f ece %.3f lift %.2f (ev %d) | gates %s | %s\n", pos, nrow(fin), sum(yf), last, cand$brier_skill_vs_M0, cand$boot_vs_M0$lo95, cand$dLogLoss_vs_M0, cand$slope, cand$ece, cand$top_decile_lift, cand$top_decile_events, paste(names(g), unlist(g), collapse = " "), fstat))
'
f <- sub1(f, '  cat(sprintf("\\n== %s  val n=%d', paste0(blk, '  cat(sprintf("\\n== %s  val n=%d'))
f <- sub1(f, 'out <- list(spec = "w2r1-s6-spec-1", positions = list(),', 'out <- list(final = list(), spec = "w2r1-s6-spec-1", positions = list(),')
f <- sub1(f, 'write_json(out, "scripts/w2r1/results/s6_val.json", auto_unbox = TRUE, pretty = TRUE, digits = 5)', 'dir.create("scripts/w2r1/results/final", FALSE, TRUE); write_json(out, "scripts/w2r1/results/final/s6_final_raw.json", auto_unbox = TRUE, pretty = TRUE, digits = 5)')
stopifnot(!grepl("results/s6_val.json", f))
writeLines(f, "scripts/w2r1/final/generated/s6_fit_eval_final.R"); cat("generated s6 final scorer\n")
