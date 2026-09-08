#!/usr/bin/env Rscript
# Phase 5 — game-context + FI-for-variance incremental ablation (spec §8, §9, §27).
# Question: does spread/total/indoor or a Phase-3 FI percentile add incremental
# information about the RESIDUAL VARIANCE (|z|) beyond the projection level?
# (Not the mean — that is Phase 4's frozen domain.)
#   Rscript analysis/football_intel_matchup/context_fi_ablation.R

suppressWarnings(suppressMessages({ library(dplyr) }))
.here <- sub("^--file=", "", grep("^--file=", commandArgs(FALSE), value = TRUE))
BASE <- if (length(.here)) dirname(.here) else file.path(getwd(), "analysis", "football_intel_matchup")
source(file.path(BASE, "config.R"))
set.seed(MI$SEED)

d <- readRDS(file.path(MI$OUT_DIR, "residual_dataset.rds")) %>%
  filter(arch == MI$PRIMARY_ARCHETYPE, is.finite(baseline_sleeper), is.finite(actual),
         position %in% c("QB","RB","WR","TE")) %>%
  group_by(position) %>%
  mutate(r = actual - baseline_sleeper,
         sd0 = { f <- lm(I(abs(r)*sqrt(pi/2)) ~ baseline_sleeper); pmax(2, predict(f)) },
         absz = pmax(1e-3, abs(r / sd0))) %>% ungroup()

# gamma GLM of |standardized residual| on projection + candidate context, walk-forward
ablate <- function(extra) {
  rows <- list()
  for (s in MI$OUTER_TEST_SEASONS) for (pos in c("QB","RB","WR","TE")) {
    tr <- d %>% filter(season < s, position == pos)
    te <- d %>% filter(season == s, position == pos)
    f_base <- "absz ~ baseline_sleeper"
    f_full <- paste0(f_base, if (nchar(extra)) paste0(" + ", extra) else "")
    ok_cols <- all(sapply(strsplit(gsub(" ", "", extra), "\\+")[[1]], function(v) v == "" || (v %in% names(tr) && mean(is.finite(tr[[v]])) > 0.8)))
    if (!ok_cols || nrow(tr) < 200) next
    m0 <- glm(as.formula(f_base), Gamma(link="log"), tr)
    m1 <- glm(as.formula(f_full), Gamma(link="log"), tr, na.action = na.exclude)
    p0 <- predict(m0, te, type="response"); p1 <- predict(m1, te, type="response")
    ok <- is.finite(p0) & is.finite(p1) & is.finite(te$absz)
    rows[[length(rows)+1]] <- data.frame(position = pos, test_season = s,
      mae_base = mean(abs(p0[ok] - te$absz[ok])), mae_full = mean(abs(p1[ok] - te$absz[ok])))
  }
  bind_rows(rows) %>% group_by(position) %>%
    summarise(mae_base = mean(mae_base), mae_full = mean(mae_full),
              incremental = mean(mae_base) - mean(mae_full), .groups = "drop")
}

cat("=== game-context -> residual-variance incremental value ===\n")
for (ctx in c("game_total", "implied_team_total", "spread", "is_indoor")) {
  a <- ablate(ctx)
  cat(sprintf("  %-20s  %s\n", ctx, paste(sprintf("%s:%+.4f", a$position, a$incremental), collapse = "  ")))
}
cat("\n=== FI percentile -> residual-variance incremental value (spec §9) ===\n")
for (ctx in c("fi_off_pace_sec_play", "fi_off_proe", "fi_off_explosive_pass_rate", "fi_def_success_allowed")) {
  if (!ctx %in% names(d)) { cat(sprintf("  %-28s  (not in dataset)\n", ctx)); next }
  a <- ablate(ctx)
  cat(sprintf("  %-28s  %s\n", ctx, paste(sprintf("%s:%+.4f", a$position, a$incremental), collapse = "  ")))
}
cat("\n(positive = the candidate improves out-of-sample |standardized residual| prediction;\n",
    " values < ~0.005 are noise-level and the feature is EXCLUDED per spec §8/§9.)\n")
