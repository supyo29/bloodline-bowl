#!/usr/bin/env Rscript
# ===========================================================================
# Projection Calibration Phase 3 — PRIOR-SEASON calibration inputs (fit data; never the evaluated season).
#
#   Rscript analysis/role_calibration/export_history_stats.R [prior_season]
#
#   historical_player_game_stats_<prior>.csv  actual stat lines per skill player-game (regular season)
#   empirical_pools_<prior>.json              empirical PLAY-OUTCOME pools (rush yards, per-target outcomes, QB dropback outcomes),
#                                             split by position and red zone; fixed-seed sample (no parametric assumption)
# ===========================================================================
suppressWarnings(suppressMessages({ library(dplyr); library(jsonlite); library(nflreadr) }))
FI_ROOT <- getwd(); source(file.path(FI_ROOT, "analysis", "player_role", "config.R"))
args <- commandArgs(TRUE); prior <- if (length(args) >= 1) as.integer(args[1]) else ROLE$SEASON_CURRENT - 1L
OUT <- file.path(getwd(), "lib", "game-distribution", "data"); dir.create(OUT, recursive = TRUE, showWarnings = FALSE)
options(nflreadr.verbose = FALSE, timeout = 900)
ps <- load_player_stats(prior) %>% filter(season_type == "REG", position %in% c("QB", "RB", "WR", "TE"))
keep <- intersect(c("season","week","player_id","player_name","position","team","completions","attempts","passing_yards","passing_tds","passing_interceptions","sacks_suffered","sack_yards_lost","sack_fumbles_lost","passing_2pt_conversions","carries","rushing_yards","rushing_tds","rushing_fumbles_lost","rushing_2pt_conversions","receptions","targets","receiving_yards","receiving_tds","receiving_fumbles_lost","receiving_2pt_conversions"), names(ps))
write.csv(ps[, keep], file.path(OUT, sprintf("historical_player_game_stats_%d.csv", prior)), row.names = FALSE, na = "")
cat(sprintf("historical stats: %d rows\n", nrow(ps)))

set.seed(20260930)
pbp <- readRDS(file.path(FI$CACHE_DIR, "pbp.rds")) %>% filter(season == !!prior, season_type == "REG")
pgr <- readRDS(file.path(ROLE$CACHE_DIR, "player_game_role.rds")) %>% filter(season == !!prior)
posmap <- pgr %>% group_by(gsis_id) %>% summarise(position = names(sort(table(position), decreasing = TRUE))[1], .groups = "drop")
zone <- function(y) ifelse(!is.na(y) & y <= 20, "rz", "nonrz")
samp <- function(df, n = 3000) if (nrow(df) > n) df[sample.int(nrow(df), n), ] else df
pool <- list()
rush <- pbp %>% filter(play_type == "run", !is.na(rusher_player_id), qb_kneel == 0) %>% left_join(posmap, by = c("rusher_player_id" = "gsis_id")) %>% filter(position %in% c("QB", "RB")) %>%
  mutate(zone = zone(yardline_100), kind = ifelse(position == "QB", ifelse(qb_scramble == 1, "scramble", "designed"), "rush"))
for (k in unique(paste(rush$position, rush$kind, rush$zone, sep = "|"))) { p <- strsplit(k, "|", fixed = TRUE)[[1]]
  d <- samp(rush %>% filter(position == p[1], kind == p[2], zone == p[3])); pool[[paste0("rush|", k)]] <- list(n_total = sum(rush$position == p[1] & rush$kind == p[2] & rush$zone == p[3]), yards = d$rushing_yards, td = as.integer(d$rush_touchdown), fum = as.integer(d$fumble_lost)) }
rec <- pbp %>% filter(play_type == "pass", !is.na(receiver_player_id), sack == 0) %>% left_join(posmap, by = c("receiver_player_id" = "gsis_id")) %>% filter(position %in% c("RB", "WR", "TE")) %>% mutate(zone = zone(yardline_100))
for (k in unique(paste(rec$position, rec$zone, sep = "|"))) { p <- strsplit(k, "|", fixed = TRUE)[[1]]
  d <- samp(rec %>% filter(position == p[1], zone == p[2])); pool[[paste0("target|", k)]] <- list(n_total = sum(rec$position == p[1] & rec$zone == p[2]), cmp = as.integer(d$complete_pass), yards = ifelse(d$complete_pass == 1, d$receiving_yards, 0), td = as.integer(d$pass_touchdown), fum = as.integer(d$fumble_lost)) }
db <- pbp %>% filter(qb_dropback == 1) %>% mutate(zone = zone(yardline_100), outcome = ifelse(sack == 1, "sack", ifelse(qb_scramble == 1, "scramble", "pass")))
for (z in c("nonrz", "rz")) { d <- samp(db %>% filter(zone == z), 4000)
  pool[[paste0("dropback|", z)]] <- list(n_total = sum(db$zone == z), outcome = d$outcome, cmp = as.integer(d$complete_pass), yards = ifelse(d$outcome == "pass" & d$complete_pass == 1, d$passing_yards, ifelse(d$outcome == "scramble", d$rushing_yards, ifelse(d$outcome == "sack", d$yards_gained, 0))), td = as.integer(ifelse(d$outcome == "scramble", d$rush_touchdown, d$pass_touchdown)), int = as.integer(d$interception), fum = as.integer(d$fumble_lost)) }
write_json(list(source = sprintf("nflverse pbp %d REG", prior), prior_season = prior, seed = 20260930, pools = pool), file.path(OUT, sprintf("empirical_pools_%d.json", prior)), auto_unbox = TRUE, digits = 4, na = "null")
cat(sprintf("pools: %s\n", paste(names(pool), collapse = ", ")))
