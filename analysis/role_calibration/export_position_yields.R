#!/usr/bin/env Rscript
# ===========================================================================
# Projection Calibration Phase 2 — league-wide PRIOR-SEASON yield-per-opportunity table (football level, scoring neutral).
#
#   Rscript analysis/role_calibration/export_position_yields.R [prior_season]
#
# Converts OPPORTUNITY (carries / targets / dropbacks, split red-zone vs not) into expected football STAT LINES.
# Fantasy scoring is applied LATER, per league scoring fingerprint, by the repo's single scoring engine — so one football
# forecast translates differently per league. Fitted ONLY on `prior_season` (never the season being evaluated): the
# parameters are out-of-sample for every 2026 game by construction.
# ===========================================================================
suppressWarnings(suppressMessages({ library(dplyr); library(jsonlite) }))
FI_ROOT <- getwd(); source(file.path(FI_ROOT, "analysis", "player_role", "config.R"))
args <- commandArgs(TRUE); prior <- if (length(args) >= 1) as.integer(args[1]) else ROLE$SEASON_CURRENT - 1L
pbp <- readRDS(file.path(FI$CACHE_DIR, "pbp.rds")) %>% filter(season == !!prior, season_type == "REG")
pgr <- readRDS(file.path(ROLE$CACHE_DIR, "player_game_role.rds")) %>% filter(season == !!prior)
posmap <- pgr %>% group_by(gsis_id) %>% summarise(position = names(sort(table(position), decreasing = TRUE))[1], .groups = "drop")
rz <- function(y) ifelse(!is.na(y) & y <= 20, "rz", "nonrz")
r5 <- function(x) round(x, 5)

rush <- pbp %>% filter(play_type == "run", !is.na(rusher_player_id), qb_kneel == 0) %>%
  left_join(posmap, by = c("rusher_player_id" = "gsis_id")) %>% filter(position %in% c("QB", "RB", "WR", "TE")) %>%
  mutate(zone = rz(yardline_100), kind = ifelse(position == "QB", ifelse(qb_scramble == 1, "scramble", "designed"), "rush"))
rush_y <- rush %>% group_by(position, kind, zone) %>%
  summarise(n = n(), ypc = r5(mean(rushing_yards, na.rm = TRUE)), td = r5(mean(rush_touchdown, na.rm = TRUE)), fum_lost = r5(mean(fumble_lost, na.rm = TRUE)), .groups = "drop")

rec <- pbp %>% filter(play_type == "pass", !is.na(receiver_player_id), sack == 0) %>%
  left_join(posmap, by = c("receiver_player_id" = "gsis_id")) %>% filter(position %in% c("RB", "WR", "TE")) %>% mutate(zone = rz(yardline_100))
rec_y <- rec %>% group_by(position, zone) %>%
  summarise(n = n(), catch_rate = r5(mean(complete_pass, na.rm = TRUE)), yards_per_target = r5(mean(ifelse(complete_pass == 1, receiving_yards, 0), na.rm = TRUE)),
            td_per_target = r5(mean(pass_touchdown, na.rm = TRUE)), fum_lost = r5(mean(fumble_lost, na.rm = TRUE)), .groups = "drop")

db <- pbp %>% filter(qb_dropback == 1, !is.na(passer_player_id) | !is.na(rusher_player_id)) %>% mutate(zone = rz(yardline_100))
# per dropback outcome: pass attempt (incl. INT), sack, or scramble (scramble yards/TD are priced through the QB `scramble` rush yield)
qb_y <- db %>% group_by(zone) %>% summarise(n = n(), pass_att_rate = r5(mean(pass_attempt == 1 & sack == 0 & qb_scramble == 0, na.rm = TRUE)),
  sack_rate = r5(mean(sack == 1, na.rm = TRUE)), scramble_rate = r5(mean(qb_scramble == 1, na.rm = TRUE)), .groups = "drop")
pa <- pbp %>% filter(play_type == "pass", pass_attempt == 1, sack == 0, qb_scramble == 0) %>% mutate(zone = rz(yardline_100))
pa_y <- pa %>% group_by(zone) %>% summarise(n = n(), cmp_rate = r5(mean(complete_pass, na.rm = TRUE)), yards_per_att = r5(mean(ifelse(complete_pass == 1, passing_yards, 0), na.rm = TRUE)),
  td_per_att = r5(mean(pass_touchdown, na.rm = TRUE)), int_per_att = r5(mean(interception, na.rm = TRUE)), .groups = "drop")

out <- list(source = sprintf("nflverse pbp %d REG season (prior-season yields; out-of-sample for %d)", prior, prior + 1L), prior_season = prior,
            zone_definition = "rz = yardline_100 <= 20", rush = rush_y, receiving = rec_y, qb_dropback = qb_y, qb_pass_attempt = pa_y)
write_json(out, file.path(getwd(), "lib", "role-calibration", "data", sprintf("position_yields_%d.json", prior)), auto_unbox = TRUE, pretty = TRUE, digits = NA)
print(rush_y); print(rec_y); print(qb_y); print(pa_y)
