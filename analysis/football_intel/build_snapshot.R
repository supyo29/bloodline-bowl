#!/usr/bin/env Rscript
# ===========================================================================
# Football Intelligence — build one versioned FootballIntelligenceSnapshot
# (spec §3, §7, §11, §15, §21, §23, §25, §26).
#
#   Rscript analysis/football_intel/build_snapshot.R [season] [through_week]
#
# Defaults: the latest fully-available NFL week for FI$SEASON_CURRENT; if that
# season has zero games, the most recent COMPLETE season.
#
# Writes (spec §23 — RDS internally, CSV/JSON for the served contract):
#   lib/football-intel/data/football_intelligence_manifest.json   (served)
#   lib/football-intel/data/team_profile.csv                      (served)
#   lib/football-intel/data/player_usage_profile.csv              (served)
#   lib/football-intel/data/unit_coverage_profile.csv             (served)
#   lib/football-intel/data/contextual_matchup_feature.csv        (served)
#   lib/football-intel/data/ftn_descriptive.csv                   (served, DESCRIPTIVE_ONLY)
#   outputs/football-intel-2026/snapshot_<version>.rds            (internal)
# ===========================================================================

suppressWarnings(suppressMessages({ library(dplyr); library(tidyr); library(jsonlite); library(digest) }))

.here <- sub("^--file=", "", grep("^--file=", commandArgs(FALSE), value = TRUE))
BASE <- if (length(.here)) dirname(.here) else file.path(getwd(), "analysis", "football_intel")
source(file.path(BASE, "config.R"))
source(file.path(BASE, "lib_features.R"))
source(file.path(BASE, "lib_opponent_adj.R"))
source(file.path(BASE, "lib_priors.R"))
source(file.path(BASE, "lib_recency.R"))
source(file.path(BASE, "lib_continuity.R"))
source(file.path(BASE, "lib_profiles.R"))
source(file.path(BASE, "lib_usage.R"))
source(file.path(BASE, "lib_interactions.R"))

args <- commandArgs(TRUE); args <- args[!grepl("^--", args)]
cache <- function(n) readRDS(file.path(FI$CACHE_DIR, paste0(n, ".rds")))

message("loading cache ...")
pbp <- cache("pbp"); schedules <- cache("schedules"); participation <- cache("participation")
pfr_pass <- cache("pfr_pass"); pfr_def <- cache("pfr_def"); pfr_rec <- cache("pfr_rec")
snap_counts <- cache("snap_counts"); rosters_weekly <- cache("rosters_weekly")
ff_playerids <- cache("ff_playerids"); ftn <- cache("ftn_charting")
avail <- readRDS(file.path(FI$CACHE_DIR, "source_availability.rds"))

# ---- resolve target (season, through_week) with real availability -------
reg <- pbp %>% filter(season_type == "REG")
season_weeks <- reg %>% group_by(season) %>% summarise(mw = max(week), .groups = "drop")
if (length(args) >= 1) {
  season <- as.integer(args[1])
  through_week <- if (length(args) >= 2) as.integer(args[2]) else season_weeks$mw[season_weeks$season == season]
} else {
  cur <- season_weeks$mw[season_weeks$season == FI$SEASON_CURRENT]
  if (length(cur) && is.finite(cur)) { season <- FI$SEASON_CURRENT; through_week <- cur }
  else { season <- max(season_weeks$season); through_week <- season_weeks$mw[season_weeks$season == season] }
}
message(sprintf("target: season %d, through week %d", season, through_week))

# per-source data cutoff (spec §3, guardrail 2): the max week each source has
# for `season` that is <= through_week.
src_cut <- avail %>% filter(season == !!season, week <= !!through_week) %>%
  group_by(source) %>% summarise(through = max(week), .groups = "drop")
data_cutoff <- setNames(as.list(src_cut$through), src_cut$source)

# ---- features (all history; cached) ------------------------------------
tgf_path <- file.path(FI$CACHE_DIR, "team_game_features.rds")
if (file.exists(tgf_path) && file.mtime(tgf_path) > file.mtime(file.path(FI$CACHE_DIR, "pbp.rds"))) {
  tgf <- readRDS(tgf_path)
} else {
  message("building team-game features ...")
  tgf <- build_team_game_features(pbp, participation, pfr_pass, pfr_def, FI)
  saveRDS(tgf, tgf_path)
}

# ---- per-prior-season opponent-adjusted ratings (for priors) ----------
message("per-season opponent-adjusted ratings ...")
prior_seasons <- (season - FI$PRIOR_MAX_LOOKBACK):(season - 1)
prior_seasons <- prior_seasons[prior_seasons >= min(FI$PBP_SEASONS)]
prior_ratings <- bind_rows(lapply(METRIC_SPECS, function(sp)
  season_ratings_for_metric(tgf, sp, FI, prior_seasons)))

# ---- continuity / discontinuity discounts ----------------------------
message("continuity ...")
discontinuity <- build_discontinuity_table(season, schedules, pbp, snap_counts, rosters_weekly, FI$COORD_YAML, FI)
discounts <- build_prior_discounts(discontinuity, FI)

# ---- team metric profiles -------------------------------------------
message("team metric profiles ...")
team_profile <- bind_rows(lapply(METRIC_SPECS, function(sp)
  compute_metric_profile(tgf, sp, season, through_week, prior_ratings, discounts, FI)))

# ---- player usage profiles -----------------------------------------
message("player usage profiles ...")
pgu_path <- file.path(FI$CACHE_DIR, "player_game_usage.rds")
if (file.exists(pgu_path) && file.mtime(pgu_path) > file.mtime(file.path(FI$CACHE_DIR, "pbp.rds"))) {
  pgu <- readRDS(pgu_path)
} else {
  pgu <- build_player_game_usage(pbp, participation, snap_counts, ff_playerids, FI)
  saveRDS(pgu, pgu_path)
}
player_usage_profile <- build_player_usage_profile(pgu, ff_playerids, rosters_weekly, season, through_week, FI)

# ---- unit coverage-allowed (RB/WR/TE receiving EPA allowed) --------
message("unit coverage-allowed ...")
unit_coverage_profile <- build_coverage_allowed_profile(pbp, rosters_weekly, ff_playerids, season, through_week,
                                                        prior_seasons, FI)

# ---- contextual matchup interaction features ----------------------
message("contextual matchup features ...")
contextual_matchup_feature <- build_contextual_matchups(team_profile, unit_coverage_profile, season, through_week, FI)

# ---- FTN descriptive (DESCRIPTIVE_ONLY; never a model input) -------
ftn_descriptive <- build_ftn_descriptive(ftn, pbp, season, through_week, FI)

# ---- version id (content hash of the served tables, spec §3, §27) --
content <- digest::digest(list(
  FI$MODEL_TAG, FI$FEATURE_SCHEMA_VERSION, season, through_week,
  team_profile, player_usage_profile, unit_coverage_profile, contextual_matchup_feature
), algo = "sha256")
version <- sprintf("fi:%d:w%02d:%s", season, through_week, substr(content, 1, 12))

manifest <- list(
  football_intelligence_version = version,
  model_tag = FI$MODEL_TAG,
  feature_schema_version = FI$FEATURE_SCHEMA_VERSION,
  generated_at = format(Sys.time(), "%Y-%m-%dT%H:%M:%S%z"),
  season = season,
  through_week = through_week,
  data_cutoff = data_cutoff,
  seasons_used = list(prior = prior_seasons, current = season),
  model_versions = list(
    opponent_adjustment = FI$OPP_ADJ_VERSION, prior = FI$PRIOR_VERSION,
    recency = FI$RECENCY_VERSION, trend = FI$TREND_VERSION, usage = FI$USAGE_VERSION),
  source_versions = list(nflreadr = as.character(utils::packageVersion("nflreadr"))),
  config = list(
    prior_decay_lambda = FI$PRIOR_DECAY_LAMBDA, prior_max_lookback = FI$PRIOR_MAX_LOOKBACK,
    recency_halflife_games = FI$RECENCY_HALFLIFE_GAMES,
    opp_adj_ridge_lambda = FI$OPP_ADJ_RIDGE_LAMBDA, seed = FI$SEED),
  files = c("team_profile.csv", "player_usage_profile.csv", "unit_coverage_profile.csv",
            "contextual_matchup_feature.csv", "ftn_descriptive.csv"),
  output_classes = FI$OUTPUT_CLASS,
  determinism = "seeded + closed-form ridge; identical cache -> identical version",
  notes = c(
    "FTN (ftn_descriptive.csv) is DESCRIPTIVE_ONLY and never feeds any rating/prior/trend/backtest.",
    "man/zone (def_man_rate) is DESCRIPTIVE_ONLY, min-play gated.",
    "Ratings are deviations from the season league mean on the metric's native scale."
  )
)

w_csv <- function(df, name) write.csv(df, file.path(FI$SERVE_DIR, name), row.names = FALSE, na = "")
w_csv(team_profile, "team_profile.csv")
w_csv(player_usage_profile, "player_usage_profile.csv")
w_csv(unit_coverage_profile, "unit_coverage_profile.csv")
w_csv(contextual_matchup_feature, "contextual_matchup_feature.csv")
w_csv(ftn_descriptive, "ftn_descriptive.csv")
write(jsonlite::toJSON(manifest, auto_unbox = TRUE, pretty = TRUE, null = "null"),
      file.path(FI$SERVE_DIR, "football_intelligence_manifest.json"))
saveRDS(list(manifest = manifest, team_profile = team_profile, player_usage_profile = player_usage_profile,
             unit_coverage_profile = unit_coverage_profile, contextual_matchup_feature = contextual_matchup_feature,
             discontinuity = discontinuity),
        file.path(FI$OUT_DIR, sprintf("snapshot_%s.rds", gsub("[:]", "_", version))))

message("\nsnapshot ", version)
message(sprintf("  team_profile             %d rows (%d metrics x %d teams)", nrow(team_profile),
                dplyr::n_distinct(team_profile$metric), dplyr::n_distinct(team_profile$team)))
message(sprintf("  player_usage_profile     %d rows", nrow(player_usage_profile)))
message(sprintf("  unit_coverage_profile    %d rows", nrow(unit_coverage_profile)))
message(sprintf("  contextual_matchup       %d rows", nrow(contextual_matchup_feature)))
message(sprintf("  ftn_descriptive          %d rows (DESCRIPTIVE_ONLY)", nrow(ftn_descriptive)))
message(sprintf("  confidence mix: %s", paste(names(table(team_profile$confidence)),
                table(team_profile$confidence), sep = "=", collapse = " ")))
