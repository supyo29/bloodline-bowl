#!/usr/bin/env Rscript
# ===========================================================================
# Checkpoint E — confidence calibration + subgroup diagnostics.
#
#   Rscript analysis/player_role/confidence_calibration.R
#
# Reuses the FROZEN Checkpoint C functions (ewma_through, confidence_level,
# change_detection) directly -- never a reimplementation. Chronology-safe:
# at decision row i, `recent`/n_games_season/opportunity_total use ONLY
# rows < i (baseline) or <= i (evidence-volume, matching Checkpoint C's own
# "before" vs "through" split); the evaluation target is the next SAME-
# SEASON row's actual value (cross-season transitions excluded, same
# convention as backtest.R).
#
# Approximation, stated explicitly: corroboration here is computed from the
# 3 headline dimensions only (snap_share_derived, target_share, rush_share)
# joined on (gsis_id, season, week) -- a tractable proxy for the live
# model's fuller per-domain corroboration set (which also includes
# air_yards_share and red-zone shares). This is a simplification of the
# INPUT to the frozen confidence_level() function, not a change to the
# function itself.
# ===========================================================================
suppressWarnings(suppressMessages({ library(dplyr); library(tidyr); library(purrr) }))
BASE <- file.path(getwd(), "analysis", "player_role")
source(file.path(BASE, "config.R"))
source(file.path(BASE, "lib_role_profile.R"))  # ewma_through, confidence_level, change_detection (FROZEN)

pgr <- readRDS(file.path(ROLE$CACHE_DIR, "player_game_role.rds")) %>% filter(season < ROLE$SEASON_CURRENT)

# One pre-existing, inconsequential edge case (found during Checkpoint E
# certification): 3 rows (one player, Jalen Davis, position=DB -- never
# relevant to any Role Intelligence dimension) share a (gsis_id, season,
# week) key across two different game_ids in the same nominal week --
# Checkpoint B's own uniqueness invariant is scoped to (season, week,
# game_id, gsis_id), which these DO satisfy; (gsis_id, season, week) alone
# is not guaranteed unique in the rare case of a mid-week team churn. This
# script needs (gsis_id, season, week) as its join key, so it deterministically
# keeps one row per such collision. Documented, not silently worked around.
pgr <- pgr %>% distinct(gsis_id, season, week, .keep_all = TRUE)

# ---------------------------------------------------------------------------
# per-metric per-player-week table: latest / recent(before) / n_games/opp
# (through) / delta / trend, using the frozen ewma_through + change_detection.
# ---------------------------------------------------------------------------
build_metric_table <- function(pgr, metric_col, opp_col) {
  ordered <- pgr %>% filter(!is.na(.data[[metric_col]])) %>% arrange(gsis_id, season, week)
  by_player <- split(ordered, ordered$gsis_id)
  rows <- vector("list", length(by_player))
  for (idx in seq_along(by_player)) {
    df <- by_player[[idx]]
    x <- df[[metric_col]]; opp <- df[[opp_col]]
    n <- length(x)
    if (n < 2) next
    out <- vector("list", n - 1)
    for (i in seq_len(n - 1)) {
      if (df$season[i + 1] != df$season[i]) next  # cross-season transition excluded
      before <- x[1:(i - 1)]; before <- before[!is.na(before)]
      recent <- if (i >= 2 && length(before) > 0) ewma_through(before, ROLE$RECENT_HALFLIFE_GAMES) else NA_real_
      season_rows_through <- df$season[1:i] == df$season[i]
      n_games_season <- sum(season_rows_through)
      opportunity_total <- sum(opp[1:i][season_rows_through], na.rm = TRUE)
      cd <- change_detection(x[i], recent, opp[i])
      out[[i]] <- list(gsis_id = df$gsis_id[i], position = df$position[i], season = df$season[i], week = df$week[i],
                       latest = x[i], recent = recent, delta = cd$delta, trend = cd$trend,
                       n_games_season = n_games_season, opportunity_total = opportunity_total,
                       actual_next = x[i + 1],
                       is_rookie_like = (min(df$season) == df$season[i]),  # first season this player appears in the panel
                       team_changed = df$team[i] != df$team[max(1, i - 1)] && i > 1)
    }
    rows[[idx]] <- bind_rows(out)
  }
  bind_rows(rows)
}

cat("Building per-metric tables (snap/target/rush) ...\n")
t0 <- Sys.time()
snap_tbl   <- build_metric_table(pgr, "snap_share_derived", "offensive_snaps") %>% rename_with(~ paste0("snap_", .x), -c(gsis_id, season, week, position))
target_tbl <- build_metric_table(pgr, "target_share", "targets") %>% rename_with(~ paste0("target_", .x), -c(gsis_id, season, week, position))
rush_tbl   <- build_metric_table(pgr, "rush_share", "carries") %>% rename_with(~ paste0("rush_", .x), -c(gsis_id, season, week, position))
cat(sprintf("done in %.1fs\n", as.numeric(difftime(Sys.time(), t0, units = "secs"))))

joined <- snap_tbl %>%
  full_join(target_tbl, by = c("gsis_id", "season", "week", "position")) %>%
  full_join(rush_tbl, by = c("gsis_id", "season", "week", "position"))

corrob_count <- function(t1, t2) {
  ifelse(is.na(t1) | is.na(t2), 0,
        ifelse(t1 == "EXPANDING" & t2 == "EXPANDING", 1,
              ifelse(t1 == "CONTRACTING" & t2 == "CONTRACTING", 1, 0)))
}

score_metric <- function(joined, prefix, other1, other2) {
  d <- joined %>% filter(!is.na(.data[[paste0(prefix, "_latest")]]))
  trend_self <- d[[paste0(prefix, "_trend")]]
  corrob <- corrob_count(trend_self, d[[paste0(other1, "_trend")]]) + corrob_count(trend_self, d[[paste0(other2, "_trend")]])
  n_games <- d[[paste0(prefix, "_n_games_season")]]
  opp <- d[[paste0(prefix, "_opportunity_total")]]
  conf <- purrr::pmap_chr(list(n_games, opp, corrob), function(n, o, c) confidence_level(n, o, c))
  d %>% mutate(
    confidence = conf,
    abs_err = abs(.data[[paste0(prefix, "_actual_next")]] - .data[[paste0(prefix, "_latest")]]),
    persisted = .data[[paste0(prefix, "_actual_next")]] >= (.data[[paste0(prefix, "_recent")]] + 0.5 * .data[[paste0(prefix, "_delta")]]),
    trend = trend_self,
    n_games_season = n_games,
    opportunity_total = opp,
    volume_tier = ifelse(opp >= median(opp, na.rm = TRUE), "HIGH_VOLUME", "LOW_VOLUME"),
    cohort = ifelse(.data[[paste0(prefix, "_is_rookie_like")]], "ROOKIE_LIKE",
                    ifelse(.data[[paste0(prefix, "_team_changed")]], "TEAM_CHANGER", "SAME_TEAM_VETERAN")),
    metric = prefix
  ) %>% select(gsis_id, season, week, position, metric, confidence, trend, abs_err, persisted, volume_tier, cohort, n_games_season, opportunity_total)
}

scored <- bind_rows(
  score_metric(joined, "snap", "target", "rush"),
  score_metric(joined, "target", "snap", "rush"),
  score_metric(joined, "rush", "snap", "target")
) %>% filter(!is.na(abs_err))

cat(sprintf("\nTotal scored player-game-metric observations: %d\n", nrow(scored)))

cat("\n=== Confidence calibration (all metrics combined) ===\n")
calib <- scored %>% group_by(confidence) %>%
  summarise(n = dplyr::n(), mae = mean(abs_err), pct_persisted_when_trending = mean(persisted[trend != "STABLE" & trend != "UNCERTAIN"], na.rm = TRUE),
           n_trending = sum(trend %in% c("EXPANDING", "CONTRACTING")), .groups = "drop") %>%
  mutate(confidence = factor(confidence, levels = c("INSUFFICIENT_SAMPLE", "LOW", "MEDIUM", "HIGH"))) %>% arrange(confidence)
print(calib)

cat("\n=== By metric x confidence ===\n")
print(scored %>% group_by(metric, confidence) %>% summarise(n = dplyr::n(), mae = mean(abs_err), .groups = "drop") %>%
       mutate(confidence = factor(confidence, levels = c("INSUFFICIENT_SAMPLE", "LOW", "MEDIUM", "HIGH"))) %>% arrange(metric, confidence))

cat("\n=== Directional persistence for EXPANDING/CONTRACTING events, by domain ===\n")
print(scored %>% filter(trend %in% c("EXPANDING", "CONTRACTING")) %>% group_by(metric, trend) %>%
       summarise(n = dplyr::n(), pct_persisted = round(100 * mean(persisted), 1), .groups = "drop"))

cat("\n=== Subgroup diagnostics: cohort (rookie-like / same-team veteran / team-changer) ===\n")
print(scored %>% group_by(cohort) %>% summarise(n = dplyr::n(), mae = mean(abs_err), pct_high_conf = round(100 * mean(confidence == "HIGH"), 2), .groups = "drop"))

cat("\n=== Subgroup diagnostics: volume tier ===\n")
print(scored %>% group_by(volume_tier) %>% summarise(n = dplyr::n(), mae = mean(abs_err), .groups = "drop"))

cat("\n=== Subgroup diagnostics: position (RB/WR/TE only, target/rush metrics) ===\n")
print(scored %>% filter(position %in% c("RB", "WR", "TE"), metric %in% c("target", "rush")) %>%
       group_by(position, metric) %>% summarise(n = dplyr::n(), mae = mean(abs_err), .groups = "drop"))

saveRDS(scored, file.path(ROLE$CACHE_DIR, "confidence_calibration_scored.rds"))
cat("\nSaved: analysis/player_role/cache/confidence_calibration_scored.rds\n")
