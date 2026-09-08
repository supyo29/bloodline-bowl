#!/usr/bin/env Rscript
# ===========================================================================
# Phase 5 — chronology-safe projection RESIDUAL dataset (spec §5, §11).
#
#   Rscript analysis/football_intel_matchup/build_residual_dataset.R [--refresh]
#
# = the Phase 4 decision dataset (QB/RB/WR/TE, 3 archetypes, pregame Sleeper
#   projection + actual + injury + game) EXTENDED with:
#     * K + DST rows (Sleeper projections/stats, scored per archetype)
#     * projection_provenance label: HISTORICALLY_RECONSTRUCTED (+ sub-label:
#       2021 no-timestamp / 2022 bulk-backfill / 2023-25 in-season) vs
#       LIVE_CAPTURED (from the Phase 4 capture.ts store, none yet)
#     * game context from nflverse schedules: spread, game_total,
#       implied_team_total, roof/is_indoor, wind
#     * FI as-of team ratings (from the Phase 4 fi_asof cache) for the
#       variance/dependence FI ablation (§9)
#
# Output: outputs/matchup-2026/residual_dataset.rds
# ===========================================================================

suppressWarnings(suppressMessages({ library(dplyr); library(tidyr); library(jsonlite) }))
.here <- sub("^--file=", "", grep("^--file=", commandArgs(FALSE), value = TRUE))
BASE <- if (length(.here)) dirname(.here) else file.path(getwd(), "analysis", "football_intel_matchup")
source(file.path(BASE, "config.R"))
REFRESH <- "--refresh" %in% commandArgs(TRUE)

ficache <- function(n) readRDS(file.path(MI$FI_DIR, "cache", paste0(n, ".rds")))
p4 <- readRDS(file.path(MI$OUT_DIR, "..", "startsit-2026", "decision_dataset.rds"))
schedules <- ficache("schedules")

# ---- K + DST from Sleeper (cached) -------------------------------------
kd_path <- file.path(MI$CACHE_DIR, "sleeper_kdst_history.rds")
if (REFRESH || !file.exists(kd_path)) {
  message("fetching Sleeper K + DST history ...")
  pull <- function(kind, s, w, pos) {
    u <- sprintf("https://api.sleeper.app/%s/nfl/%d/%d?season_type=regular&position[]=%s", kind, s, w, pos)
    d <- tryCatch(jsonlite::fromJSON(u, flatten = TRUE), error = function(e) NULL)
    if (is.null(d) || !is.data.frame(d) || nrow(d) == 0) return(NULL)
    keep <- intersect(c("player_id","team","opponent","week","season","last_modified",
                        "player.position","player.injury_status","stats.pts_std","stats.pts_half_ppr","stats.pts_ppr"), names(d))
    d %>% select(all_of(keep)) %>% mutate(season = as.integer(season), week = as.integer(week), kind = kind)
  }
  grid <- expand.grid(season = MI$SEASONS, week = MI$MIN_WEEK:(MI$MAX_WEEK + 1L))
  rows <- list()
  for (i in seq_len(nrow(grid))) for (pos in c("K", "DEF")) for (kind in c("projections", "stats")) {
    d <- pull(kind, grid$season[i], grid$week[i], pos); if (!is.null(d)) rows[[length(rows)+1]] <- d
    Sys.sleep(0.08)
  }
  kd <- bind_rows(rows)
  saveRDS(kd, kd_path)
} else kd <- readRDS(kd_path)

norm_kd <- function(kd) {
  proj <- kd %>% filter(kind == "projections") %>%
    transmute(season, week, sleeper_id = player_id, position = .data[["player.position"]],
              team = toupper(team), opponent = toupper(coalesce(opponent, NA_character_)),
              injury_status = if ("player.injury_status" %in% names(kd)) .data[["player.injury_status"]] else NA_character_,
              last_modified = if ("last_modified" %in% names(kd)) last_modified else NA_real_,
              proj_std = .data[["stats.pts_std"]], proj_half = .data[["stats.pts_half_ppr"]], proj_ppr = .data[["stats.pts_ppr"]])
  act <- kd %>% filter(kind == "stats") %>%
    transmute(season, week, sleeper_id = player_id,
              act_std = .data[["stats.pts_std"]], act_half = .data[["stats.pts_half_ppr"]], act_ppr = .data[["stats.pts_ppr"]])
  proj %>% left_join(act, by = c("season", "week", "sleeper_id")) %>%
    distinct(season, week, sleeper_id, .keep_all = TRUE) %>%
    pivot_longer(c(act_std, act_half, act_ppr), names_to = "arch", values_to = "actual", names_prefix = "act_") %>%
    left_join(
      proj %>% pivot_longer(c(proj_std, proj_half, proj_ppr), names_to = "arch", values_to = "baseline_sleeper", names_prefix = "proj_") %>%
        select(season, week, sleeper_id, arch, baseline_sleeper),
      by = c("season", "week", "sleeper_id", "arch")) %>%
    filter(week >= MI$MIN_WEEK, week <= MI$MAX_WEEK, is.finite(actual)) %>%
    mutate(baseline_trailing = NA_real_, gsis_id = NA_character_,
           position = ifelse(position == "DEF", "DEF", position))
}
kd_long <- norm_kd(kd)

# ---- unify with the Phase 4 skill-position dataset --------------------
common <- c("season", "week", "sleeper_id", "gsis_id", "position", "team", "opponent",
            "injury_status", "arch", "actual", "baseline_sleeper", "baseline_trailing", "last_modified")
skill <- p4 %>% mutate(last_modified = last_modified) %>% select(any_of(common))
for (c0 in setdiff(common, names(skill))) skill[[c0]] <- NA
d <- bind_rows(skill %>% select(all_of(common)), kd_long %>% select(all_of(common)))

# ---- provenance label (§5) ------------------------------------------
d <- d %>% mutate(
  projection_provenance = "HISTORICALLY_RECONSTRUCTED",
  provenance_sublabel = case_when(
    season == 2021 ~ "sleeper_no_timestamp",
    season == 2022 ~ "sleeper_bulk_backfill",
    TRUE ~ "sleeper_in_season_possibly_revised"),
  resid_sleeper = actual - baseline_sleeper,
  resid_trailing = actual - baseline_trailing)

# ---- game context from schedules (§8) ------------------------------
sc <- schedules %>%
  transmute(season, week,
            home_team = toupper(home_team), away_team = toupper(away_team),
            spread_line, total_line, roof, wind)
home <- sc %>% transmute(season, week, team = home_team, opponent = away_team,
                         game_total = total_line, spread = -spread_line,  # home spread: negative = favored
                         roof, wind)
away <- sc %>% transmute(season, week, team = away_team, opponent = home_team,
                         game_total = total_line, spread = spread_line, roof, wind)
gc <- bind_rows(home, away) %>%
  mutate(implied_team_total = ifelse(is.finite(game_total) & is.finite(spread), game_total/2 - spread/2, NA_real_),
         is_indoor = as.integer(roof %in% c("dome", "closed")))
d <- d %>% left_join(gc, by = c("season", "week", "team", "opponent"))

# ---- FI as-of team ratings for the variance/dependence ablation (§9) --
fi_path <- file.path(MI$SS_DIR, "cache", "fi_asof.rds")
if (file.exists(fi_path)) {
  fi <- readRDS(fi_path)$team_asof %>%
    filter(family %in% c("off_pace_sec_play", "off_proe", "off_explosive_pass_rate", "def_success_allowed")) %>%
    select(season, week, team, side, family, league_percentile, predictive_status)
  off_fi <- fi %>% filter(side == "offense") %>%
    pivot_wider(names_from = family, values_from = league_percentile, names_glue = "fi_{family}", id_cols = c(season, week, team))
  def_fi <- fi %>% filter(side == "defense", family == "def_success_allowed") %>%
    transmute(season, week, opponent = team, fi_def_success_allowed = league_percentile)
  d <- d %>% left_join(off_fi, by = c("season", "week", "team")) %>%
             left_join(def_fi, by = c("season", "week", "opponent"))
}

d <- d %>% filter(position %in% MI$ALL_POS, is.finite(actual))
saveRDS(d, file.path(MI$OUT_DIR, "residual_dataset.rds"))

message(sprintf("\nresidual_dataset: %d rows  positions %s  archetypes %s  (%d-%d)",
                nrow(d), paste(sort(unique(d$position)), collapse = "/"),
                paste(unique(d$arch), collapse = "/"), min(d$season), max(d$season)))
message(sprintf("  by position: %s", paste(names(table(d$position[d$arch == "ppr"])),
                table(d$position[d$arch == "ppr"]), sep = "=", collapse = " ")))
message(sprintf("  game context present: implied_total %.0f%%  spread %.0f%%  indoor flag %.0f%%",
                100*mean(is.finite(d$implied_team_total)), 100*mean(is.finite(d$spread)), 100*mean(is.finite(d$is_indoor))))
message(sprintf("  provenance: %s", paste(names(table(d$provenance_sublabel)), table(d$provenance_sublabel), sep="=", collapse=" ")))
