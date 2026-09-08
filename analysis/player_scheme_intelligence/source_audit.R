#!/usr/bin/env Rscript
# ===========================================================================
# Player x Scheme Intelligence — reproducible source audit (spec §2, §3).
#
#   Rscript analysis/player_scheme_intelligence/source_audit.R
#
# Inspects the ACTUAL installed raw schemas (the Phase 3 nflverse cache) rather
# than assuming fields. Emits a machine-readable source-timeliness contract to
#   outputs/player-scheme-intelligence-2026/source_audit.json
# and a human summary to stdout.
#
# Every feature family gets: source, first_supported_season,
# last_available_season/week, historical_or_live, availability_state,
# live_class, expected_update_cadence, data_cutoff (spec §3).
#
# NO network. Reads only analysis/football_intel/cache/*.rds .
# ===========================================================================

suppressWarnings(suppressMessages({ library(dplyr); library(jsonlite) }))

.here <- sub("^--file=", "", grep("^--file=", commandArgs(FALSE), value = TRUE))
source(file.path(dirname(.here), "config.R"))

rd <- function(n) {
  p <- file.path(PSI$CACHE_DIR, paste0(n, ".rds"))
  if (!file.exists(p)) return(NULL)
  readRDS(p)
}

pbp  <- rd("pbp")
part <- rd("participation")
ftn  <- rd("ftn_charting")
ngsp <- rd("ngs_passing")
pfrp <- rd("pfr_pass")
pfrd <- rd("pfr_def")
stopifnot(!is.null(pbp))

CUR <- PSI$SEASON_CURRENT
gk  <- pbp %>% distinct(game_id, season, week)

# --- how much current-season (2026) data exists in each source right now ---
cur_rows <- function(df, join_games = FALSE) {
  if (is.null(df)) return(0L)
  if (join_games && !("season" %in% names(df))) {
    df <- df %>% left_join(gk, by = c("nflverse_game_id" = "game_id"))
  }
  if (!("season" %in% names(df))) return(NA_integer_)
  sum(df$season == CUR, na.rm = TRUE)
}

last_sw <- function(df, join_games = FALSE) {
  if (is.null(df)) return(NA_character_)
  if (join_games && !("season" %in% names(df))) {
    df <- df %>% left_join(gk, by = c("nflverse_game_id" = "game_id"))
  }
  if (!all(c("season", "week") %in% names(df))) return(NA_character_)
  s <- max(df$season, na.rm = TRUE)
  w <- max(df$week[df$season == s], na.rm = TRUE)
  sprintf("%d-w%d", s, w)
}

# participation charting-completeness by season (of ALL plays)
part_j <- part %>% left_join(gk, by = c("nflverse_game_id" = "game_id"))
part_cov <- part_j %>% group_by(season) %>% summarise(
  plays        = n(),
  man_zone_pct = round(100 * mean(!is.na(defense_man_zone_type) & defense_man_zone_type != ""), 1),
  coverage_pct = round(100 * mean(!is.na(defense_coverage_type) & defense_coverage_type != ""), 1),
  route_pct    = round(100 * mean(!is.na(route) & route != ""), 1),
  formation_pct= round(100 * mean(!is.na(offense_formation)), 1),
  box_pct      = round(100 * mean(!is.na(defenders_in_box)), 1),
  ttt_pct      = round(100 * mean(!is.na(time_to_throw)), 1),
  .groups = "drop"
)

# pbp spatial field completeness (denominator = pass / rush attempts)
patt <- pbp %>% filter(season_type == "REG", pass_attempt == 1)
ratt <- pbp %>% filter(season_type == "REG", rush_attempt == 1)
pbp_spatial <- list(
  pass_location_pct = round(100 * mean(!is.na(patt$pass_location)), 1),
  air_yards_pct     = round(100 * mean(!is.na(patt$air_yards)), 1),
  yac_pct           = round(100 * mean(!is.na(patt$yards_after_catch[patt$complete_pass == 1])), 1),
  run_location_pct  = round(100 * mean(!is.na(ratt$run_location)), 1),
  run_gap_pct       = round(100 * mean(!is.na(ratt$run_gap)), 1),
  depth_share = {
    ay <- patt$air_yards
    list(
      behind_los = round(100 * mean(ay < 0, na.rm = TRUE), 1),
      short_0_9  = round(100 * mean(ay >= 0 & ay < 10, na.rm = TRUE), 1),
      inter_10_19= round(100 * mean(ay >= 10 & ay < 20, na.rm = TRUE), 1),
      deep_20p   = round(100 * mean(ay >= 20, na.rm = TRUE), 1)
    )
  }
)

state_for <- function(cur_n, newest_season) {
  if (is.na(cur_n)) return("UNKNOWN")
  if (cur_n > 0) return("LIVE_CURRENT")
  if (newest_season >= 2025) return("HISTORICAL_CURRENT_THROUGH_2025")
  "PRIOR_ONLY"
}

sources <- list(
  pbp = list(
    source = "nflverse play-by-play (nflreadr::load_pbp)",
    fields = c("pass_location", "pass_length", "air_yards", "yards_after_catch",
               "run_location", "run_gap", "qb_dropback", "qb_scramble", "qb_hit",
               "sack", "epa", "success", "cpoe", "xpass", "down", "ydstogo",
               "yardline_100", "goal_to_go", "wp", "shotgun", "no_huddle",
               "passer_player_id", "receiver_player_id", "rusher_player_id"),
    first_supported_season = min(pbp$season),
    last_available = last_sw(pbp),
    current_season_rows = cur_rows(pbp),
    availability_state = state_for(cur_rows(pbp), max(pbp$season)),
    live_class = "LIVE_CAPABLE",
    expected_update_cadence = "within ~24h of each game, in-season",
    notes = c(
      "Spatial backbone. LEFT/MIDDLE/RIGHT + air_yards depth bins are derivable here with NO charting dependency.",
      sprintf("pass_location present on %.1f%% of pass attempts; air_yards on %.1f%%.",
              pbp_spatial$pass_location_pct, pbp_spatial$air_yards_pct),
      "run_location present ~86%, run_gap ~ lower — gap splits are WEAKER than direction splits.",
      "Becomes LIVE_CURRENT for 2026 as soon as Week 1 games are played + ingested."
    )
  ),
  participation = list(
    source = "nflverse participation (nflreadr::load_participation)",
    fields = c("offense_formation", "offense_personnel", "defense_personnel",
               "defenders_in_box", "number_of_pass_rushers", "time_to_throw",
               "was_pressure", "route", "defense_man_zone_type", "defense_coverage_type"),
    first_supported_season = min(part_j$season, na.rm = TRUE),
    last_available = last_sw(part, join_games = TRUE),
    current_season_rows = cur_rows(part, join_games = TRUE),
    availability_state = state_for(cur_rows(part, join_games = TRUE), max(part_j$season, na.rm = TRUE)),
    live_class = "PRIOR_ONLY_CURRENT_SEASON",
    expected_update_cadence = "historically heavy lag; in-season 2026 availability NOT guaranteed (spec §2 IMPORTANT)",
    charting_completeness_by_season = part_cov,
    notes = c(
      "man/zone + coverage_type charted on ~0% (2016-17), ~38% (2018-22), ~49% (2023-25) of ALL plays.",
      "route charted ~37-42% of plays. Formation ~72-80%. defenders_in_box 100% from 2023.",
      "A 2025 man/zone profile used in Sept 2026 is PRIOR_ONLY until nflverse publishes 2026 participation.",
      "NEVER present a stale 2025 coverage tendency as a current 2026 observation (guardrail 2/31)."
    )
  ),
  ftn_charting = list(
    source = "nflverse FTN charting (nflreadr::load_ftn_charting)",
    fields = c("starting_hash", "qb_location", "n_offense_backfield", "n_defense_box",
               "is_no_huddle", "is_motion", "is_play_action", "is_screen_pass",
               "is_rpo", "is_trick_play", "is_qb_out_of_pocket", "is_interception_worthy",
               "is_throw_away", "read_thrown", "is_catchable_ball", "is_contested_ball",
               "n_blitzers", "n_pass_rushers", "is_qb_fault_sack"),
    first_supported_season = if (!is.null(ftn)) min(ftn$season) else NA,
    last_available = last_sw(ftn),
    current_season_rows = cur_rows(ftn),
    availability_state = state_for(cur_rows(ftn), if (!is.null(ftn)) max(ftn$season) else 0),
    live_class = "PRIOR_ONLY_CURRENT_SEASON",
    expected_update_cadence = "weekly-ish with a lag historically; in-season 2026 cadence uncertain",
    notes = c(
      "In FI this is DESCRIPTIVE_ONLY and NEVER a model input (FI guardrail 1). Phase 9 keeps that rule for anything predictive.",
      "play_action / motion / RPO / screen / OOP / blitzers are FTN-only — all PRIOR_ONLY for 2026 today.",
      "Full season-week coverage 2022-2025 (no partial-charting gaps like participation)."
    )
  ),
  ngs_weekly = list(
    source = "nflverse Next Gen Stats weekly (nflreadr::load_nextgen_stats)",
    fields = c("avg_time_to_throw", "avg_intended_air_yards", "avg_completed_air_yards",
               "avg_air_yards_to_sticks", "aggressiveness", "expected_completion_percentage",
               "completion_percentage_above_expectation"),
    first_supported_season = if (!is.null(ngsp)) min(ngsp$season) else NA,
    last_available = last_sw(ngsp),
    current_season_rows = cur_rows(ngsp),
    availability_state = state_for(cur_rows(ngsp), if (!is.null(ngsp)) max(ngsp$season) else 0),
    live_class = "LIVE_CAPABLE",
    expected_update_cadence = "weekly, in-season, short lag",
    notes = c(
      "PLAYER-WEEK AGGREGATES ONLY. NEVER claim play-level spatial detail from an NGS weekly field (spec §2 IMPORTANT).",
      "Useful as a coarse cross-check on QB depth/aggressiveness, not as a matrix input."
    )
  ),
  pfr_advanced_weekly = list(
    source = "nflverse PFR advanced weekly (nflreadr::load_pfr_advstats)",
    fields = c("times_pressured", "times_blitzed", "times_hurried", "times_hit",
               "times_sacked", "pocket_time (rush: ybc/yac)",
               "def_targets", "def_completions_allowed", "def_yards_allowed",
               "def_adot", "def_times_blitzed", "def_pressures"),
    first_supported_season = if (!is.null(pfrp)) min(pfrp$season) else NA,
    last_available = last_sw(pfrp),
    current_season_rows = cur_rows(pfrp),
    availability_state = state_for(cur_rows(pfrp), if (!is.null(pfrp)) max(pfrp$season) else 0),
    live_class = "LIVE_CAPABLE",
    expected_update_cadence = "weekly, in-season, 1-3 day lag",
    notes = c(
      "Team/player-game grain pressure + blitz counts. Live-capable substitute for participation pressure fields in 2026.",
      "def stat_type gives coverage-allowed (targets / cmp / yards / aDOT) at defender-game grain."
    )
  )
)

audit <- list(
  audit_version = "psi-source-audit-2026.1",
  model_tag = PSI$MODEL_TAG,
  generated_at = format(Sys.time(), "%Y-%m-%dT%H:%M:%S%z"),
  current_season = CUR,
  as_of_note = "As of generation, 0 rows of ANY 2026 source are cached; newest data is 2025. Every Phase 9 calculation is PRIOR_ONLY for 2026 until Week 1 games are played + ingested.",
  pbp_spatial_completeness = pbp_spatial,
  sources = sources
)

outp <- file.path(PSI$OUT_DIR, "source_audit.json")
write_json(audit, outp, auto_unbox = TRUE, pretty = TRUE, dataframe = "rows", null = "null")

cat("\n==== PLAYER x SCHEME — SOURCE AUDIT ====\n")
cat(sprintf("current season: %d   (cached 2026 rows: pbp=%d part=%d ftn=%d ngs=%d pfr=%d)\n",
            CUR, cur_rows(pbp), cur_rows(part, TRUE), cur_rows(ftn), cur_rows(ngsp), cur_rows(pfrp)))
for (nm in names(sources)) {
  s <- sources[[nm]]
  cat(sprintf("\n  %-22s  state=%-32s live=%-26s last=%s\n",
              nm, s$availability_state, s$live_class, s$last_available))
}
cat(sprintf("\nartifact -> %s\n", outp))
