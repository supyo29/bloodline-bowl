#!/usr/bin/env Rscript
# ===========================================================================
# Phase 4 — chronology-safe Start/Sit decision dataset (§C, §4, §41.2).
#
#   Rscript analysis/football_intel_startsit/build_decision_dataset.R
#
# One row per (season, week, player, scoring archetype). Every predictor is
# information available BEFORE the Week-W games:
#   baseline_sleeper : Sleeper historical weekly projection (POTENTIALLY REVISED
#                      through-week — never the sole certification baseline)
#   baseline_trailing: EW mean of the player's PRIOR completed weeks this season
#                      (fully chronology-clean control)
#   fi_*             : Phase 3 modeled ratings AS OF week W-1 (participation-lagged)
# Target (never a predictor): actual Week-W fantasy points in that archetype.
#
# Output: outputs/startsit-2026/decision_dataset.rds + .csv sample
# ===========================================================================

suppressWarnings(suppressMessages({ library(dplyr); library(tidyr) }))
.here <- sub("^--file=", "", grep("^--file=", commandArgs(FALSE), value = TRUE))
BASE <- if (length(.here)) dirname(.here) else file.path(getwd(), "analysis", "football_intel_startsit")
source(file.path(BASE, "config.R"))

# Phase 3 engine (read-only upstream) --------------------------------------
FI_BASE <- SS$FI_DIR
for (f in c("config.R", "lib_features.R", "lib_opponent_adj.R", "lib_priors.R",
            "lib_recency.R", "lib_continuity.R", "lib_profiles.R")) source(file.path(FI_BASE, f))
source(file.path(BASE, "fi_asof_features.R"))
set.seed(SS$SEED)

ficache <- function(n) readRDS(file.path(FI$CACHE_DIR, paste0(n, ".rds")))
hist <- readRDS(file.path(SS$CACHE_DIR, "sleeper_history.rds"))
ff <- ficache("ff_playerids") %>% select(gsis_id, sleeper_id) %>% filter(!is.na(gsis_id), !is.na(sleeper_id))
tgf <- readRDS(file.path(FI$CACHE_DIR, "team_game_features.rds")) %>% filter(season_type == "REG")
pgu <- readRDS(file.path(FI$CACHE_DIR, "player_game_usage.rds"))
pbp <- ficache("pbp"); schedules <- ficache("schedules"); snap_counts <- ficache("snap_counts")
rosters_weekly <- ficache("rosters_weekly")

# --- priors + discontinuity per test season (from PRIOR seasons only) ------
message("per-season priors + discontinuity ...")
prior_ratings_by_season <- list(); discounts_by_season <- list()
for (S in SS$SEASONS) {
  ps <- (S - FI$PRIOR_MAX_LOOKBACK):(S - 1); ps <- ps[ps >= min(FI$PBP_SEASONS)]
  prior_ratings_by_season[[as.character(S)]] <-
    bind_rows(lapply(METRIC_SPECS, function(sp) season_ratings_for_metric(tgf, sp, FI, ps)))
  disc <- build_discontinuity_table(S, schedules, pbp, snap_counts, rosters_weekly, FI$COORD_YAML, FI)
  discounts_by_season[[as.character(S)]] <- build_prior_discounts(disc, FI)
}

# --- FI as-of features ----------------------------------------------------
message("FI as-of features for the grid ...")
fi <- fi_asof_bundle(FI, SS, tgf, pgu, prior_ratings_by_season, discounts_by_season)
saveRDS(fi, file.path(SS$CACHE_DIR, "fi_asof.rds"))

# --- trailing-PPG clean control ------------------------------------------
message("trailing-PPG control baseline ...")
long_act <- hist %>%
  filter(week <= SS$MAX_WEEK + 1L) %>%
  select(season, week, sleeper_id, position, team, opponent, injury_status,
         act_std, act_half, act_ppr, proj_std, proj_half, proj_ppr, last_modified) %>%
  pivot_longer(c(act_std, act_half, act_ppr), names_to = "arch", values_to = "actual",
               names_prefix = "act_") %>%
  left_join(hist %>% select(season, week, sleeper_id) %>% distinct(), by = c("season","week","sleeper_id"))

proj_long <- hist %>%
  pivot_longer(c(proj_std, proj_half, proj_ppr), names_to = "arch", values_to = "baseline_sleeper",
               names_prefix = "proj_") %>%
  select(season, week, sleeper_id, arch, baseline_sleeper)

d <- long_act %>%
  select(season, week, sleeper_id, position, team, opponent, injury_status, arch, actual, last_modified) %>%
  left_join(proj_long, by = c("season","week","sleeper_id","arch"))

# EW trailing mean of PRIOR completed weeks, per (player, arch)
d <- d %>% arrange(season, sleeper_id, arch, week) %>%
  group_by(season, sleeper_id, arch) %>%
  mutate(baseline_trailing = {
    n <- dplyr::n(); v <- rep(NA_real_, n)
    for (j in seq_len(n)) {
      idx <- which(seq_len(n) < j & is.finite(actual))
      if (length(idx) >= SS$TRAILING_MIN_GAMES) {
        wts <- 0.5^((week[j] - week[idx]) / SS$TRAILING_HALFLIFE)
        v[j] <- sum(wts * actual[idx]) / sum(wts)
      }
    }
    v
  }) %>% ungroup()

# --- join gsis + FI features -------------------------------------------
d <- d %>%
  filter(week >= SS$MIN_WEEK, week <= SS$MAX_WEEK, position %in% SS$POSITIONS,
         is.finite(actual)) %>%
  left_join(ff, by = "sleeper_id")

teamw <- fi$team_asof %>%
  select(season, week, team, side, family, modeled, league_percentile, confidence, predictive_status, prior_dominated)
off_w <- teamw %>% filter(side == "offense") %>%
  select(season, week, team, family, modeled, league_percentile, confidence, prior_dominated) %>%
  pivot_wider(names_from = family, values_from = c(modeled, league_percentile, confidence, prior_dominated),
              names_glue = "fi_{family}_{.value}")
def_w <- teamw %>% filter(side == "defense") %>%
  select(season, week, team, family, modeled, league_percentile, confidence) %>%
  pivot_wider(names_from = family, values_from = c(modeled, league_percentile, confidence),
              names_glue = "fidef_{family}_{.value}")

d <- d %>%
  left_join(off_w, by = c("season", "week", "team")) %>%
  left_join(def_w, by = c("season", "week", "opponent" = "team")) %>%
  left_join(fi$usage_asof %>%
              pivot_wider(names_from = family, values_from = c(modeled, confidence), names_glue = "fi_{family}_{.value}"),
            by = c("season", "week", "gsis_id")) %>%
  left_join(fi$interact_asof %>% filter(family == "interaction_pass_epa_vs_pass_defense") %>%
              transmute(season, week, team = off_team, opponent = def_team,
                        fi_interaction_pass_epa_vs_pass_defense_modeled = interaction_signal,
                        fi_interaction_pass_epa_vs_pass_defense_confidence = confidence),
            by = c("season", "week", "team", "opponent")) %>%
  left_join(fi$interact_asof %>% filter(family == "interaction_rush_epa_vs_rush_defense") %>%
              transmute(season, week, team = off_team, opponent = def_team,
                        fi_interaction_rush_epa_vs_rush_defense_modeled = interaction_signal,
                        fi_interaction_rush_epa_vs_rush_defense_confidence = confidence),
            by = c("season", "week", "team", "opponent"))

d <- d %>% mutate(
  fi_available = !is.na(fi_off_pass_epa_modeled) | !is.na(fi_off_rush_epa_modeled),
  gsis_resolved = !is.na(gsis_id),
  baseline_sleeper_last_modified_utc = as.POSIXct(last_modified / 1000, origin = "1970-01-01", tz = "UTC")
)

saveRDS(d, file.path(SS$OUT_DIR, "decision_dataset.rds"))
write.csv(head(d, 500), file.path(SS$OUT_DIR, "decision_dataset_sample.csv"), row.names = FALSE)

message(sprintf("\ndecision_dataset: %d rows  (%d-%d, wk %d-%d)  positions %s  archetypes %s",
                nrow(d), min(d$season), max(d$season), min(d$week), max(d$week),
                paste(sort(unique(d$position)), collapse = "/"), paste(unique(d$arch), collapse = "/")))
message(sprintf("  gsis resolved: %.1f%%   FI available: %.1f%%   trailing baseline present: %.1f%%   sleeper baseline present: %.1f%%",
                100 * mean(d$gsis_resolved), 100 * mean(d$fi_available),
                100 * mean(is.finite(d$baseline_trailing)), 100 * mean(is.finite(d$baseline_sleeper))))
message(sprintf("  projection last_modified: %s .. %s (revision-risk caveat, §3)",
                min(d$baseline_sleeper_last_modified_utc, na.rm = TRUE),
                max(d$baseline_sleeper_last_modified_utc, na.rm = TRUE)))
