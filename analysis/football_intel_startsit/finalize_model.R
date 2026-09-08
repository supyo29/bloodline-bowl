#!/usr/bin/env Rscript
# Phase 4 — stamp honest per-position + per-family status onto the served model
# from the decision-quality backtest (§15, §37). Run AFTER backtest.R.
#   Rscript analysis/football_intel_startsit/finalize_model.R

suppressWarnings(suppressMessages({ library(dplyr); library(jsonlite) }))
.here <- sub("^--file=", "", grep("^--file=", commandArgs(FALSE), value = TRUE))
BASE <- if (length(.here)) dirname(.here) else file.path(getwd(), "analysis", "football_intel_startsit")
source(file.path(BASE, "config.R"))

model <- fromJSON(file.path(SS$SERVE_DIR, "start_sit_model.json"), simplifyVector = FALSE)
bt <- readRDS(file.path(SS$OUT_DIR, "backtest_full.rds"))
by_pos_tr <- bt$trailing$by_pos
by_pos_sl <- bt$sleeper$by_pos
fs <- read.csv(file.path(SS$SERVE_DIR, "start_sit_feature_status.csv"))

# per-position production status: certify a position for PRODUCTION only if the
# FI reversals beat a coin flip AND net delta is positive against BOTH baselines
# and severe-loss rate is not elevated (§8, §16, §38).
pos_status <- lapply(SS$POSITIONS, function(p) {
  tr <- by_pos_tr[by_pos_tr$position == p, ]
  sl <- by_pos_sl[by_pos_sl$position == p, ]
  rev_win_tr <- tr$rev_win_rate; delta_tr <- tr$mean_delta_points
  rev_win_sl <- if (nrow(sl)) sl$rev_win_rate else NA
  delta_sl <- if (nrow(sl)) sl$mean_delta_points else NA
  # PRODUCTION requires beating BOTH baselines — the naive control AND the
  # RotoWire-backed Sleeper projection production actually uses (§16, §38).
  prod <- if (is.finite(rev_win_tr) && rev_win_tr >= 0.53 && delta_tr > 0 &&
              is.finite(rev_win_sl) && rev_win_sl >= 0.52 && delta_sl > 0 &&
              tr$rev_large_loss_rate <= tr$rev_large_win_rate + 0.02)
            "PRODUCTION_CANDIDATE"
          else if (is.finite(rev_win_tr) && rev_win_tr >= 0.53 && delta_tr > 0)
            "TIE_BREAK_SHADOW_ONLY"   # helps vs naive control, NOT vs production baseline
          else "SHADOW_ONLY_NO_VALUE"
  list(position = p, production_status = prod,
       reversal_win_rate_trailing = round(rev_win_tr, 4),
       mean_delta_points_trailing = round(delta_tr, 4),
       reversal_win_rate_sleeper = round(rev_win_sl, 4),
       mean_delta_points_sleeper = round(delta_sl, 4),
       large_loss_rate = round(tr$rev_large_loss_rate, 4),
       large_win_rate = round(tr$rev_large_win_rate, 4))
})
names(pos_status) <- SS$POSITIONS

for (p in names(model$positions)) {
  model$positions[[p]]$production_status <- pos_status[[p]]$production_status
  model$positions[[p]]$decision_metrics <- pos_status[[p]]
  fam_stat <- fs[fs$position == p, c("family", "status", "incremental_mae_gain")]
  model$positions[[p]]$family_status <- lapply(seq_len(nrow(fam_stat)), function(i)
    as.list(fam_stat[i, ]))
}

model$deployment <- "SHADOW_ONLY"
model$deployment_note <- paste(
  "No position clears the production bar: FI reversals beat a coin flip only for RB",
  "against the naive trailing-PPG control, and that edge does not survive against the",
  "RotoWire-backed Sleeper baseline production actually uses (double-counting, §11).",
  "The shadow comparison path is delivered; production start/sit behavior is unchanged.")

write(toJSON(model, auto_unbox = TRUE, pretty = TRUE, null = "null"),
      file.path(SS$SERVE_DIR, "start_sit_model.json"))

cat("per-position production status:\n")
for (p in SS$POSITIONS) cat(sprintf("  %-3s %-24s  rev_win trailing=%.3f sleeper=%.3f  delta trailing=%+.3f sleeper=%+.3f\n",
  p, pos_status[[p]]$production_status, pos_status[[p]]$reversal_win_rate_trailing,
  pos_status[[p]]$reversal_win_rate_sleeper %||% NA, pos_status[[p]]$mean_delta_points_trailing,
  pos_status[[p]]$mean_delta_points_sleeper %||% NA))
`%||%` <- function(a,b) if (is.null(a) || is.na(a)) b else a
