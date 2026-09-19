# ===========================================================================
# Football Intelligence Engine — configuration (single source of truth)
#
# Phase 3 of the Bloodline Bowl Team Management architecture.
# See docs/TEAM_MANAGEMENT_PHASE_3.md.
#
# NOTHING in this engine is random without a seed set here. NOTHING reads a
# season / decay / threshold that is not defined here.
# ===========================================================================

FI <- new.env()

# ---- versioning -----------------------------------------------------------
FI$MODEL_TAG              <- "ri-football-intel-2026.1"
FI$FEATURE_SCHEMA_VERSION <- 1L
FI$OPP_ADJ_VERSION        <- "opp-adj-ridge-2026.1"
FI$PRIOR_VERSION          <- "prior-decay-2026.1"
FI$RECENCY_VERSION        <- "recency-ew-2026.1"
FI$TREND_VERSION          <- "trend-statediff-2026.1"
FI$USAGE_VERSION          <- "usage-2026.1"

# ---- determinism --------------------------------------------------------
FI$SEED <- 20260907L

# ---- seasons ----------------------------------------------------------------
# Historical bootstrap (spec §22): how far back is *useful*. Older seasons
# decay heavily (see PRIOR_DECAY_LAMBDA) so there is little value beyond ~4
# prior seasons; we ingest a wider window only so the walk-forward backtest
# can reconstruct priors as they would have existed in earlier test seasons.
FI$SEASON_CURRENT   <- 2026L
# Upper bound of every ingest window is FI$SEASON_CURRENT, not a literal year,
# so the in-season automated refresh actually requests the current season's
# data instead of silently stopping at whatever year this file was last
# edited in.
FI$PBP_SEASONS      <- 2012:FI$SEASON_CURRENT   # team/pace/EPA/explosive/RZ — cheap, long history
FI$PARTICIPATION_SEASONS <- 2016:FI$SEASON_CURRENT   # formation / personnel / man-zone / routes
FI$PFR_SEASONS      <- 2018:FI$SEASON_CURRENT   # pressure / blitz / YBC / coverage-allowed
FI$NGS_SEASONS      <- 2016:FI$SEASON_CURRENT
FI$FTN_SEASONS      <- 2022:FI$SEASON_CURRENT   # DESCRIPTIVE_ONLY — never a model input (spec guardrail 1)

# Walk-forward backtest window (spec §17). Test seasons whose priors can be
# built from >= 3 prior seasons of every required source.
FI$BACKTEST_SEASONS <- 2021:2025
FI$BACKTEST_MIN_WEEK <- 4L         # need a few in-season games before a current-season signal exists
FI$BACKTEST_MAX_WEEK <- 18L

# ---- historical priors (spec §8) -----------------------------------------
# w_s proportional to lambda ^ (target_season - s), truncated at 4 prior seasons.
# Grid searched in backtest.R; the frozen value is chosen by out-of-sample MAE.
FI$PRIOR_DECAY_LAMBDA      <- 0.5
FI$PRIOR_DECAY_LAMBDA_GRID <- c(0.35, 0.5, 0.65)
FI$PRIOR_MAX_LOOKBACK      <- 4L

# Discontinuity down-weighting: each active discontinuity multiplies the
# prior's effective sample by the corresponding factor (< 1). Not additive.
# Values are grid-searched; these are the frozen defaults.
FI$DISCONTINUITY_FACTOR <- list(
  head_coach_change        = 0.55,
  offensive_coord_change   = 0.65,
  defensive_coord_change   = 0.65,
  starting_qb_change       = 0.60,   # offense only
  ol_continuity_low        = 0.80,   # offense only; < OL_CONTINUITY_LOW_THRESHOLD
  front_turnover_high      = 0.80,   # defense only
  secondary_turnover_high  = 0.80    # defense only
)
FI$OL_CONTINUITY_LOW_THRESHOLD  <- 0.55   # snap-weighted returning share
FI$UNIT_TURNOVER_HIGH_THRESHOLD <- 0.45   # snap-weighted departed share

# ---- recency weighting within season (spec §9) --------------------------
# Exponentially-weighted over game-level unit metrics. Half-life in games.
FI$RECENCY_HALFLIFE_GAMES      <- 5
FI$RECENCY_HALFLIFE_GRID       <- c(3, 4, 5, 7)
# The prior is worth this many shrink-constants of pseudo-observations at full
# strength (discount 1.0). Deliberately <= 1 so a full current season dominates
# a multi-season prior (spec §29: current info eventually dominates stale priors).
FI$PRIOR_STRENGTH             <- 0.6
# Partial-pool guard: a single game cannot move a unit rating by more than
# this many pooled standard deviations.
FI$RECENCY_SINGLE_GAME_CAP_SD  <- 1.25

# ---- opponent adjustment (spec §10) ------------------------------------
FI$OPP_ADJ_RIDGE_LAMBDA   <- 1.0     # ridge penalty on team effects
FI$OPP_ADJ_MAX_ITER       <- 50
FI$OPP_ADJ_TOL            <- 1e-6
FI$OPP_ADJ_MIN_PLAYS_TEAM <- 50      # below this a team effect stays shrunk to 0 (league mean)

# ---- uncertainty / shrinkage (spec §11) -------------------------------
# Publication thresholds on EFFECTIVE sample. Below INSUFFICIENT -> value is
# emitted but flagged, never suppressed, never fabricated to league mean.
FI$CONF_THRESHOLDS <- list(
  play_rate_metric = c(insufficient = 30,  low = 80,  medium = 200),  # e.g. man/zone split, personnel
  epa_metric       = c(insufficient = 60,  low = 150, medium = 350),  # per-play EPA-family
  player_usage     = c(insufficient = 2,   low = 4,   medium = 8)     # games
)
FI$SHRINK_K <- list(
  epa_metric       = 200,   # plays; toward team prior then league mean
  play_rate_metric = 120,
  player_usage     = 4      # games
)

# ---- trend (spec §12) --------------------------------------------------
FI$TREND_RECENT_HALFLIFE_GAMES <- 2
FI$TREND_DEADBAND_SD           <- 0.5   # |z| below -> "stable"
FI$TREND_UNCERTAIN_SE_RATIO    <- 1.0   # se >= magnitude -> "uncertain"

# ---- explosive-play thresholds (spec §5) ------------------------------
FI$EXPLOSIVE_PASS_YARDS <- 16
FI$EXPLOSIVE_RUSH_YARDS <- 12

# ---- neutral game script (for tendency metrics) ----------------------
# win prob band + exclude last 2 min of each half + exclude garbage time.
FI$NEUTRAL_WP_LO <- 0.20
FI$NEUTRAL_WP_HI <- 0.80
FI$NEUTRAL_MAX_ABS_SCORE_DIFF <- 16

# ---- predictive status (spec §19, §31, guardrail 4) -----------------
# Populated from analysis/football_intel/backtest.R walk-forward results.
# PREDICTIVE      : CAND beats the best simple baseline out-of-sample (P >= 0.90)
# WEAKLY_PREDICTIVE: 0.60 <= P < 0.90
# NOT_PREDICTIVE  : CAND does not beat the league-mean / rolling baseline
#                   -> still published (it is an honest OBSERVED-adjusted summary
#                      of what happened) but NEVER presented as a forecast, and
#                      any contextual feature that uses it is confidence-capped.
# Metrics not backtested individually inherit the family verdict, or
# UNVALIDATED if the family was not tested.
FI$PREDICTIVE_STATUS <- list(
  off_pass_epa = "PREDICTIVE", off_rush_epa = "PREDICTIVE", off_epa_play = "PREDICTIVE",
  off_success_rate = "PREDICTIVE", off_proe = "PREDICTIVE", off_pace_sec_play = "PREDICTIVE",
  off_explosive_pass_rate = "PREDICTIVE", off_explosive_rush_rate = "WEAKLY_PREDICTIVE",
  off_pressure_rate_allowed = "WEAKLY_PREDICTIVE", off_sack_rate_allowed = "WEAKLY_PREDICTIVE",
  off_rz_td_rate = "UNVALIDATED",
  def_pass_epa_allowed = "NOT_PREDICTIVE", def_rush_epa_allowed = "NOT_PREDICTIVE",
  def_epa_play_allowed = "NOT_PREDICTIVE", def_success_allowed = "PREDICTIVE",
  def_explosive_pass_rate_allowed = "WEAKLY_PREDICTIVE", def_explosive_rush_rate_allowed = "WEAKLY_PREDICTIVE",
  def_pressure_rate = "WEAKLY_PREDICTIVE", def_blitz_rate = "DESCRIPTIVE_TENDENCY",
  def_rz_td_rate_allowed = "UNVALIDATED"
)
FI$predictive_status <- function(metric) {
  v <- FI$PREDICTIVE_STATUS[[metric]]
  if (is.null(v)) "UNVALIDATED" else v
}

# ---- output classes (spec guardrail 5) ------------------------------
# Every published numeric field is tagged exactly one of these.
FI$OUTPUT_CLASS <- c("OBSERVED", "MODELED", "DESCRIPTIVE_ONLY")

# ---- paths --------------------------------------------------------------
FI$ROOT <- local({
  ev <- Sys.getenv("FI_ROOT", "")
  if (nzchar(ev) && dir.exists(file.path(ev, "analysis", "football_intel"))) return(ev)
  if (dir.exists(file.path(getwd(), "analysis", "football_intel"))) return(getwd())
  f <- sub("^--file=", "", grep("^--file=", commandArgs(FALSE), value = TRUE))
  if (length(f)) {
    cand <- normalizePath(file.path(dirname(f), "..", ".."), mustWork = FALSE)
    if (dir.exists(file.path(cand, "analysis", "football_intel"))) return(cand)
  }
  getwd()
})
FI$CACHE_DIR   <- file.path(FI$ROOT, "analysis", "football_intel", "cache")
FI$OUT_DIR     <- file.path(FI$ROOT, "outputs", "football-intel-2026")
FI$SERVE_DIR   <- file.path(FI$ROOT, "lib", "football-intel", "data")
FI$COORD_YAML  <- file.path(FI$ROOT, "analysis", "football_intel", "coordinators.yaml")
for (d in c(FI$CACHE_DIR, FI$OUT_DIR, FI$SERVE_DIR)) dir.create(d, showWarnings = FALSE, recursive = TRUE)

# ---- team alias normalization (one team universe, spec §4) -----------
FI$normalize_team <- function(x) {
  x <- toupper(trimws(as.character(x)))
  dplyr::recode(x,
    "OAK" = "LV", "SD" = "LAC", "STL" = "LAR", "LA" = "LAR",
    "WSH" = "WAS", "ARZ" = "ARI", "BLT" = "BAL", "CLV" = "CLE", "HST" = "HOU",
    "SL" = "LAR", "JAC" = "JAX", .default = x)
}

# ---- sources whose per-(season,week) availability fetch_raw.R tracks -----
# Single source of truth for both fetch_raw.R's source_availability.rds and
# validate_snapshot.R's EXPECTED_SOURCE_LAG / BROKEN_OR_MISSING_DATA
# classification -- a source entirely absent from data_cutoff is only ever
# "expected lag" if it's on this list; anything else appearing would be
# unexpected and worth a human look.
FI$EXPECTED_SOURCES <- c("pbp", "participation", "ngs_passing", "ngs_rushing", "ngs_receiving",
                         "pfr_pass", "pfr_def", "snap_counts", "ftn_charting")

# ---- partial-week completion (daily refresh support) --------------------
# Derives week completeness from the authoritative schedule/result data
# already fetched (schedules.rds), never from calendar date. A week is
# COMPLETE only when every scheduled REG game for it has a final result;
# any other state (including zero completed games) is PARTIAL. This is
# reporting metadata only -- it does not change how current_rating_for_metric
# selects rows (week <= through_week already includes whatever games have
# actually been played, complete or not).
FI$compute_week_completion <- function(schedules, season, week) {
  wk <- schedules[schedules$season == season & schedules$game_type == "REG" & schedules$week == week, , drop = FALSE]
  n_scheduled <- nrow(wk)
  done <- wk[!is.na(wk$result), , drop = FALSE]
  n_completed <- nrow(done)
  list(
    latest_week = as.integer(week),
    week_state = if (n_scheduled > 0 && n_completed == n_scheduled) "COMPLETE" else "PARTIAL",
    games_completed_in_latest_week = as.integer(n_completed),
    games_scheduled_in_latest_week = as.integer(n_scheduled),
    latest_completed_game_date = if (n_completed > 0) as.character(max(done$gameday, na.rm = TRUE)) else NA_character_
  )
}

# ---- content-hash version id (spec §3, §27) ------------------------------
# The version identity covers every served *analytical/descriptive* table --
# team_profile, player_usage_profile, unit_coverage_profile,
# contextual_matchup_feature, AND ftn_descriptive (previously omitted: a
# daily refresh that only changed FTN charting would have kept the same
# version and never published it). It also covers week_completion's five
# semantic fields explicitly (latest_week, week_state,
# games_completed_in_latest_week, games_scheduled_in_latest_week,
# latest_completed_game_date) rather than only the completed-game count, so
# any change to how complete the week is -- not just the raw count --
# changes identity too.
#
# Two things are deliberately EXCLUDED from the digest:
#   - generated_at: a wall-clock timestamp must never by itself create a new
#     version, or every run would be "UPDATED" regardless of content.
#   - data_cutoff: a source reporting a newer cutoff is provenance/freshness
#     metadata, not served analytical content. Any cutoff change that
#     actually adds information will, by construction, show up in one of the
#     hashed tables above (a new play changes tgf -> team_profile/usage/etc.;
#     new FTN rows change ftn_descriptive); a cutoff bump that changes none
#     of them is, by definition, a no-op for anything a consumer reads, and
#     the correct outcome for that is NO_CHANGE, not a forced republish of
#     otherwise-identical served data.
FI$compute_version <- function(season, through_week, week_completion,
                               team_profile, player_usage_profile, unit_coverage_profile,
                               contextual_matchup_feature, ftn_descriptive,
                               receiver_progression = NULL) {
  wc_identity <- week_completion[c("latest_week", "week_state", "games_completed_in_latest_week",
                                   "games_scheduled_in_latest_week", "latest_completed_game_date")]
  content <- digest::digest(list(
    FI$MODEL_TAG, FI$FEATURE_SCHEMA_VERSION, season, through_week, wc_identity,
    team_profile, player_usage_profile, unit_coverage_profile, contextual_matchup_feature,
    ftn_descriptive, receiver_progression
  ), algo = "sha256")
  sprintf("fi:%d:w%02d:%s", season, through_week, substr(content, 1, 12))
}

invisible(FI)
