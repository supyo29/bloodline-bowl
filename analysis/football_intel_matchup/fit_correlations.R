#!/usr/bin/env Rscript
# ===========================================================================
# Phase 5 — RESIDUAL dependence model (spec §6, §7). Two-factor latent:
#   z_player = L_teampass * f_teampass(team,game) + L_gamescore * f_gamescore(game) + eps
#
# f_teampass loads the team's QB (+1) and its WR/TE; f_gamescore loads both
# QBs in the game (and weakly the pass-catchers). Loadings estimated from
# STANDARDIZED residual correlations (resid / sd-model), chronology-safe.
#
# Emits the loadings + a per-relationship correlation table AND the "pairwise"
# control (raw block correlation). The 2-factor structure is NOT auto-certified
# — calibration_backtest.R ablates it against independent draws (spec §6, §28).
#
# Output: lib/weekly/data/matchup_correlation_model.json
# ===========================================================================

suppressWarnings(suppressMessages({ library(dplyr); library(tidyr); library(jsonlite) }))
.here <- sub("^--file=", "", grep("^--file=", commandArgs(FALSE), value = TRUE))
BASE <- if (length(.here)) dirname(.here) else file.path(getwd(), "analysis", "football_intel_matchup")
source(file.path(BASE, "config.R"))
set.seed(MI$SEED)

d <- readRDS(file.path(MI$OUT_DIR, "residual_dataset.rds")) %>%
  filter(arch == MI$PRIMARY_ARCHETYPE, is.finite(baseline_sleeper), is.finite(actual),
         position %in% c("QB", "RB", "WR", "TE", "K", "DEF"))

# standardize residuals with a simple per-position heteroscedastic sd (linear in proj)
z_of <- d %>% group_by(position) %>%
  mutate(r = actual - baseline_sleeper,
         .sd = { f <- lm(I(abs(r)*sqrt(pi/2)) ~ baseline_sleeper); pmax(2, predict(f)) },
         z = r / .sd) %>% ungroup() %>%
  filter(is.finite(z)) %>%
  transmute(season, week, team, opponent, position, sleeper_id, z,
            game = paste(season, week, pmin(team, opponent), pmax(team, opponent)))

# QB standardized residual per team-game (the team passing factor proxy)
qb <- z_of %>% filter(position == "QB") %>% group_by(game, team) %>%
  slice_max(abs(z), n = 1, with_ties = FALSE) %>%   # primary QB
  ungroup() %>% transmute(game, team, z_qb = z)

# --- team passing factor loadings: pass-catcher z vs own-QB z --------------
load_teampass <- z_of %>%
  filter(position %in% c("WR", "TE", "RB")) %>%
  inner_join(qb, by = c("game", "team")) %>%
  group_by(position) %>%
  summarise(n = n(),
            loading = cov(z, z_qb, use = "complete") / var(z_qb, na.rm = TRUE),
            corr = cor(z, z_qb, use = "complete"), .groups = "drop")

# --- game scoring factor: opposing-QB residual after removing nothing -----
qb_pairs <- qb %>% inner_join(qb, by = "game", suffix = c("", "_opp")) %>%
  filter(team != team_opp)
game_scoring_corr <- cor(qb_pairs$z_qb, qb_pairs$z_qb_opp, use = "complete")
# a symmetric game factor f_game with each QB loading sqrt(rho) reproduces corr rho
game_qb_loading <- sqrt(max(game_scoring_corr, 0))

# opposing pass-catcher <-> QB (bring-back)
bringback <- z_of %>% filter(position %in% c("WR", "TE")) %>%
  inner_join(qb %>% rename(opp = team, z_oppqb = z_qb), by = c("game")) %>%
  filter(opp == opponent) %>%
  summarise(n = n(), corr = cor(z, z_oppqb, use = "complete"))

# --- DST <-> opposing offense (negative expected) -------------------------
dst <- z_of %>% filter(position == "DEF")
dst_oppqb <- dst %>% inner_join(qb %>% rename(opp = team, z_oppqb = z_qb), by = "game") %>%
  filter(opp == opponent) %>% summarise(n = n(), corr = cor(z, z_oppqb, use = "complete"))

# --- raw pairwise block correlation control -----------------------------
rel <- function(pa, pb, same_team, label) {
  a <- z_of %>% filter(position == pa) %>% select(game, team, opponent, idA = sleeper_id, zA = z)
  b <- z_of %>% filter(position == pb) %>% select(game, team, idB = sleeper_id, zB = z)
  j <- if (same_team) inner_join(a, b, by = c("game", "team"))
       else inner_join(a, b, by = "game") %>% filter(team.x != team.y | is.na(team.y))
  j <- j %>% filter(idA != idB)
  data.frame(relationship = label, n = nrow(j),
             corr = if (nrow(j) > 50) round(cor(j$zA, j$zB, use = "complete"), 4) else NA)
}
pairwise <- bind_rows(
  rel("QB", "WR", TRUE, "QB~WR_same_team"), rel("QB", "TE", TRUE, "QB~TE_same_team"),
  rel("QB", "RB", TRUE, "QB~RB_same_team"), rel("WR", "WR", TRUE, "WR~WR_same_team"),
  rel("RB", "RB", TRUE, "RB~RB_same_team"), rel("QB", "QB", FALSE, "QB~oppQB"),
  rel("QB", "WR", FALSE, "QB~oppWR"), rel("DEF", "QB", FALSE, "DEF~oppQB"))

model <- list(
  correlation_model_version = MI$CORRELATION_MODEL_VERSION,
  matchup_model_version = MI$MATCHUP_MODEL_VERSION,
  generated_at = format(Sys.time(), "%Y-%m-%dT%H:%M:%S%z"),
  archetype = MI$PRIMARY_ARCHETYPE,
  structure = "two_factor (team_passing + game_scoring)",
  min_games_for_full_loading = MI$CORR_MIN_GAMES,
  team_passing_factor = list(
    qb_loading = 1.0,
    catcher_loadings = setNames(as.list(round(load_teampass$loading, 4)), load_teampass$position),
    catcher_corr = setNames(as.list(round(load_teampass$corr, 4)), load_teampass$position),
    n = setNames(as.list(load_teampass$n), load_teampass$position)),
  game_scoring_factor = list(
    qb_qb_residual_corr = round(game_scoring_corr, 4),
    qb_loading = round(game_qb_loading, 4),
    bringback_catcher_oppqb_corr = round(bringback$corr, 4),
    dst_oppqb_corr = round(dst_oppqb$corr, 4)),
  pairwise_control = pairwise,
  deployment = "SHADOW_ONLY",
  note = "Two-factor loadings; NOT auto-certified. calibration_backtest.R ablates independent vs pairwise vs twofactor and retains the factor structure only if it improves OOS matchup calibration (spec §6).")
write(toJSON(model, auto_unbox = TRUE, pretty = TRUE, null = "null"),
      file.path(MI$SERVE_DIR, "matchup_correlation_model.json"))

cat("=== two-factor loadings ===\n")
cat(sprintf("  team_passing: QB=1.0  %s\n", paste(load_teampass$position, round(load_teampass$loading, 3),
      sprintf("(corr %.2f, n=%d)", load_teampass$corr, load_teampass$n), collapse = "  ")))
cat(sprintf("  game_scoring: QB~oppQB corr=%.3f -> per-QB loading=%.3f\n", game_scoring_corr, game_qb_loading))
cat(sprintf("  bring-back catcher~oppQB corr=%.3f   DST~oppQB corr=%.3f\n", bringback$corr, dst_oppqb$corr))
cat("\n=== pairwise control ===\n"); print(pairwise, row.names = FALSE)
