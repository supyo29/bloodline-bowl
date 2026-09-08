# ===========================================================================
# Phase 4 Start/Sit — configuration (single source of truth).
# Reuses the frozen Phase 3 engine (analysis/football_intel/*) as a read-only
# upstream. Nothing here re-derives a Phase 3 statistic.
# ===========================================================================

SS <- new.env()

# ri-startsit-2026.1 is IMMUTABLE. A re-evaluation run overrides the version
# and the training seasons via env vars so the frozen 2026.1 artifact and the
# frozen 2021-25 training window are never rewritten.
SS$MODEL_VERSION <- local({
  ov <- Sys.getenv("SS_MODEL_VERSION_OVERRIDE", ""); if (nzchar(ov)) ov else "ri-startsit-2026.1"
})
SS$SEED                <- 20260908L

# scoring archetypes (Sleeper precomputed points columns)
SS$ARCHETYPES <- c(std = "pts_std", half = "pts_half_ppr", ppr = "pts_ppr")

# decision dataset grid — matches the Phase 3 walk-forward window + the
# "need in-season sample before a current-season signal exists" floor.
SS$SEASONS <- local({
  ov <- Sys.getenv("SS_SEASONS_OVERRIDE", "")
  if (nzchar(ov)) as.integer(strsplit(ov, ",")[[1]]) else 2021:2025
})
SS$MIN_WEEK     <- 4L      # decisions from week 4 (>=3 played weeks of trailing form + FI)
SS$MAX_WEEK     <- 17L     # regular season; week 18 rest-heavy, excluded from training
SS$POSITIONS    <- c("QB", "RB", "WR", "TE")

# trailing-PPG clean control baseline: exponentially-weighted mean of the
# player's PRIOR completed weeks this season, half-life in games.
SS$TRAILING_HALFLIFE <- 4
SS$TRAILING_MIN_GAMES <- 2L

# nested walk-forward: for test season s, the inner tuning loop trains on
# seasons < s and validates on the LATEST inner season < s. Outer eval never
# informs tuning.
SS$INNER_VAL_SEASONS <- 1L

# candidate hyper-parameter grids (selected in the inner loop, never on the
# outer held-out weeks).
SS$RIDGE_LAMBDA_GRID   <- c(0.5, 1, 2, 5, 10, 25)
SS$TAU_GRID            <- c(0.5, 1.0, 1.5, 2.0, 3.0)     # baseline-edge (pts) tie-break gate
SS$MAX_ADJ_FRAC_GRID   <- c(0.08, 0.12, 0.18, 0.25)      # cap on |total FI adj| as fraction of baseline
SS$CONF_MIN_GATE       <- "LOW"                          # below this Phase-3 confidence -> 0 contribution

# Phase-3 confidence -> influence weight (monotone; invariant-tested downstream)
SS$CONF_WEIGHT <- c(HIGH = 1.0, MEDIUM = 0.5, LOW = 0.2, INSUFFICIENT_SAMPLE = 0.0)
# prior-dominated (early-season / low obs) extra haircut
SS$PRIOR_DOMINATED_HAIRCUT <- 0.6

# FI feature families offered to the model, with their Phase-3 predictive_status
# routing class. The trainer may only assign a nonzero coefficient to
# PREDICTIVE (freely) and WEAKLY_PREDICTIVE (capped). Everything else -> 0.
SS$FI_FAMILIES <- tibble::tribble(
  ~family,                 ~kind,               ~routing,
  "off_pass_epa",          "team_off",          "PREDICTIVE",
  "off_rush_epa",          "team_off",          "PREDICTIVE",
  "off_success_rate",      "team_off",          "PREDICTIVE",
  "off_proe",              "team_off",          "PREDICTIVE",
  "off_pace_sec_play",     "team_off",          "PREDICTIVE",
  "off_explosive_pass_rate","team_off",         "PREDICTIVE",
  "def_success_allowed",   "opp_def",           "PREDICTIVE",
  "def_pass_epa_allowed",  "opp_def",           "NOT_PREDICTIVE",
  "def_rush_epa_allowed",  "opp_def",           "NOT_PREDICTIVE",
  "usage_snap_share",      "player_usage",      "PREDICTIVE",
  "usage_target_share",    "player_usage",      "PREDICTIVE",
  "usage_rush_share",      "player_usage",      "PREDICTIVE",
  "usage_route_participation","player_usage",   "PREDICTIVE",
  "interaction_pass_epa_vs_pass_defense", "interaction", "WEAKLY_PREDICTIVE",
  "interaction_rush_epa_vs_rush_defense", "interaction", "WEAKLY_PREDICTIVE",
  "ftn_play_action_rate",  "descriptive",       "DESCRIPTIVE_ONLY",
  "def_man_rate",          "descriptive",       "DESCRIPTIVE_ONLY"
)

# per-position which team_off / usage families are even plausibly relevant
# (still must pass incremental validation to be KEPT).
SS$POSITION_FAMILIES <- list(
  QB = c("off_pass_epa","off_success_rate","off_proe","off_pace_sec_play","off_explosive_pass_rate",
         "def_success_allowed","interaction_pass_epa_vs_pass_defense"),
  RB = c("off_rush_epa","off_success_rate","off_pace_sec_play","def_success_allowed",
         "usage_snap_share","usage_rush_share","usage_target_share",
         "interaction_rush_epa_vs_rush_defense"),
  WR = c("off_pass_epa","off_success_rate","off_proe","off_pace_sec_play","off_explosive_pass_rate",
         "def_success_allowed","usage_target_share","usage_route_participation",
         "interaction_pass_epa_vs_pass_defense"),
  TE = c("off_pass_epa","off_success_rate","off_pace_sec_play","def_success_allowed",
         "usage_target_share","usage_route_participation")
)

SS$ROOT <- local({
  ev <- Sys.getenv("FI_ROOT", "")
  if (nzchar(ev) && dir.exists(file.path(ev, "analysis"))) return(ev)
  if (dir.exists(file.path(getwd(), "analysis", "football_intel_startsit"))) return(getwd())
  getwd()
})
SS$FI_DIR    <- file.path(SS$ROOT, "analysis", "football_intel")
SS$CACHE_DIR <- file.path(SS$ROOT, "analysis", "football_intel_startsit", "cache")
SS$OUT_DIR   <- file.path(SS$ROOT, "outputs", "startsit-2026")
SS$SERVE_DIR <- file.path(SS$ROOT, "lib", "weekly", "data")
for (d in c(SS$CACHE_DIR, SS$OUT_DIR, SS$SERVE_DIR)) dir.create(d, showWarnings = FALSE, recursive = TRUE)

invisible(SS)
