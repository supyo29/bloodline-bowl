# ===========================================================================
# Player x Scheme Interaction Intelligence — configuration (single source of truth)
#
# Phase 9 of the Bloodline Bowl Team Management architecture.
# See docs/TEAM_MANAGEMENT_PHASE_9_PLAYER_SCHEME_INTELLIGENCE.md.
#
# ADDITIVE ONLY. Phase 9 does NOT modify the frozen semantics of Canonical
# League State, Team-State, Football Intelligence, Start/Sit, Matchup
# Intelligence, Roster Health, Schedule Planning, Orchestrator, production
# lineup / waivers / trades / trade depth / trade ROS (spec §1, §44).
#
# Two deployment lanes (spec intro, §35, §36):
#   SHARED_DESCRIPTIVE  — validated observable tendency/profile calculations,
#                         served + consumable as football context.
#   SHADOW_PREDICTIVE   — any player x scheme matchup EFFECT on fantasy value
#                         stays SHADOW_ONLY until incremental OOS value beyond
#                         the production baseline is demonstrated (§24, §35).
# No Phase 9 result may change production projection / lineup / start-sit /
# waiver / trade / matchup / Orchestrator ACTION behavior during this phase.
# ===========================================================================

PSI <- new.env()

# ---- versioning ---------------------------------------------------------
PSI$MODEL_TAG              <- "player-scheme-intelligence-2026.1"
PSI$FEATURE_SCHEMA_VERSION <- 1L
PSI$SPATIAL_VERSION        <- "qb-spatial-2026.1"
PSI$TENDENCY_VERSION       <- "player-tendency-2026.1"
PSI$DEFENSE_VERSION        <- "defense-scheme-2026.1"
PSI$INTERACTION_VERSION    <- "player-scheme-interaction-2026.1"

# ---- determinism ------------------------------------------------------
PSI$SEED <- 20260908L

# ---- seasons --------------------------------------------------------------
PSI$SEASON_CURRENT <- 2026L

# pbp is the spatial backbone: cheap, long history, LIVE_CAPABLE in-season.
PSI$PBP_SEASONS <- 2012:2025

# participation: formation / personnel / box / route / man-zone / coverage /
# time-to-throw / pressure. Historically LAGS heavily and 2026 in-season
# availability is NOT guaranteed (spec §2 IMPORTANT, guardrail 2/31).
PSI$PARTICIPATION_SEASONS <- 2016:2025

# FTN charting: play-action / motion / RPO / screen / OOP / blitzers /
# read-thrown / throwaway / int-worthy. In-season cadence is lagged/uncertain.
PSI$FTN_SEASONS <- 2022:2025

# NGS weekly (player-week aggregates only — NEVER treated as play-level).
PSI$NGS_SEASONS <- 2016:2025

# PFR advanced weekly (pressure / blitz / YBC-YAC / coverage-allowed).
PSI$PFR_SEASONS <- 2018:2025

# ---- availability states (spec §3) -----------------------------------
# Every feature declares exactly one, as-of the decision week.
#   LIVE_CURRENT                    current-season data exists and updates
#   HISTORICAL_CURRENT_THROUGH_2025 complete through 2025; live-capable when
#                                   current-season games have been played
#   PRIOR_ONLY                      newest available is a prior season; no
#                                   current-season update exists yet
#   POSTSEASON_ONLY                 only published after the season ends
#   UNAVAILABLE                     not present in any ingested source
PSI$AVAILABILITY_STATES <- c(
  "LIVE_CURRENT", "HISTORICAL_CURRENT_THROUGH_2025",
  "PRIOR_ONLY", "POSTSEASON_ONLY", "UNAVAILABLE"
)

# ---- live-capability classes (spec §31) ----------------------------
#   LIVE_CAPABLE               could genuinely have been known before the game
#   RETROSPECTIVE_ONLY         useful for research, not available live then
#   PRIOR_ONLY_CURRENT_SEASON  historical profile usable today, no current update
PSI$LIVE_CLASSES <- c("LIVE_CAPABLE", "RETROSPECTIVE_ONLY", "PRIOR_ONLY_CURRENT_SEASON")

# ---- QB depth bins (spec §4) — TRANSPARENT CANDIDATE DEFINITION -------
# Frozen only after cut-point sensitivity audit (spec §4). air_yards based.
PSI$DEPTH_BINS <- list(
  BEHIND_LOS   = c(-Inf, 0),
  SHORT        = c(0, 10),
  INTERMEDIATE = c(10, 20),
  DEEP         = c(20, Inf)
)
PSI$DEPTH_BIN_GRID <- list(
  # alternative cut points tested in the sensitivity audit
  a = list(SHORT_HI = 10, INT_HI = 20),
  b = list(SHORT_HI = 8,  INT_HI = 16),
  c = list(SHORT_HI = 12, INT_HI = 22)
)
PSI$FIELD_THIRDS <- c("LEFT", "MIDDLE", "RIGHT")   # from pbp pass_location / run_location

# ---- explosive-play thresholds (align with FI, spec §5) --------------
PSI$EXPLOSIVE_PASS_YARDS <- 16
PSI$EXPLOSIVE_RUSH_YARDS <- 12

# ---- neutral game script (tendency metrics; align with FI) ----------
PSI$NEUTRAL_WP_LO <- 0.20
PSI$NEUTRAL_WP_HI <- 0.80
PSI$NEUTRAL_MAX_ABS_SCORE_DIFF <- 16

# ---- shrinkage / evidence classes (spec §25, §26) -----------------
# Publication thresholds on EFFECTIVE sample per grain. Below INSUFFICIENT a
# cell is emitted but flagged, NEVER suppressed, NEVER fabricated to a mean.
PSI$EVIDENCE_THRESHOLDS <- list(
  qb_cell_attempts   = c(insufficient = 15,  weak = 40,  moderate = 100),
  player_route       = c(insufficient = 10,  weak = 25,  moderate = 60),
  rb_direction_rush  = c(insufficient = 15,  weak = 40,  moderate = 100),
  coverage_split     = c(insufficient = 25,  weak = 60,  moderate = 150),
  interaction_games  = c(insufficient = 4,   weak = 8,   moderate = 16)
)
PSI$SHRINK_K <- list(
  qb_cell   = 60,    # attempts; toward QB marginal then position marginal
  route     = 30,
  rush_dir  = 60,
  coverage  = 80,
  interact  = 8      # opponent-games; toward zero effect
)

# ---- recency / role-change (spec §9, §27) -------------------------
PSI$RECENCY_HALFLIFE_GAMES <- 10
PSI$RECENCY_HALFLIFE_GRID  <- c(6, 8, 10, 14)
PSI$PROFILE_WINDOWS <- c("career", "recent", "current_team")   # spec §9

# ---- interaction model (spec §23, §25, §28) --------------------
# Target is a RESIDUAL vs a trustworthy pregame baseline, never raw fantasy
# splits (spec §23). numeric_fantasy_adjustment defaults to 0 (spec §24, §35).
PSI$INTERACTION_TARGETS <- c(
  "epa_per_opportunity_residual",
  "success_residual",
  "target_share_residual",
  "yards_per_route_residual",
  "fantasy_points_residual"      # only vs clean pregame baseline windows
)
PSI$INTERACTION_METHOD_GRID <- c("ridge_interaction", "empirical_bayes", "mixed_effects")
PSI$FDR_ALPHA <- 0.10             # false-discovery control (spec §29)

# ---- walk-forward validation (spec §30) --------------------------
PSI$WF_SEASONS   <- 2021:2025
PSI$WF_MIN_WEEK  <- 4L
PSI$WF_MAX_WEEK  <- 18L

# ---- deployment lane (spec §35, §36) — HARD DEFAULT --------------
PSI$FANTASY_ADJUSTMENT_ENABLED <- FALSE   # NEVER TRUE in 2026.1
PSI$DEPLOYMENT <- "SHARED_DESCRIPTIVE + SHADOW_PREDICTIVE"

# ---- paths ------------------------------------------------------------
PSI$ROOT <- local({
  ev <- Sys.getenv("PSI_ROOT", "")
  if (nzchar(ev) && dir.exists(file.path(ev, "analysis", "player_scheme_intelligence"))) return(ev)
  if (dir.exists(file.path(getwd(), "analysis", "player_scheme_intelligence"))) return(getwd())
  f <- sub("^--file=", "", grep("^--file=", commandArgs(FALSE), value = TRUE))
  if (length(f)) {
    cand <- normalizePath(file.path(dirname(f), "..", ".."), mustWork = FALSE)
    if (dir.exists(file.path(cand, "analysis", "player_scheme_intelligence"))) return(cand)
  }
  getwd()
})
# Phase 9 reuses the Phase 3 raw cache (identical nflverse sources, one fetch).
PSI$CACHE_DIR <- file.path(PSI$ROOT, "analysis", "football_intel", "cache")
PSI$PSI_CACHE <- file.path(PSI$ROOT, "analysis", "player_scheme_intelligence", "cache")
PSI$OUT_DIR   <- file.path(PSI$ROOT, "outputs", "player-scheme-intelligence-2026")
PSI$SERVE_DIR <- file.path(PSI$ROOT, "lib", "player-scheme-intelligence", "data")
for (d in c(PSI$PSI_CACHE, PSI$OUT_DIR, PSI$SERVE_DIR))
  dir.create(d, showWarnings = FALSE, recursive = TRUE)

# ---- team alias normalization (reuse FI's one team universe) --------
PSI$normalize_team <- function(x) {
  x <- toupper(trimws(as.character(x)))
  dplyr::recode(x,
    "OAK" = "LV", "SD" = "LAC", "STL" = "LAR", "LA" = "LAR",
    "WSH" = "WAS", "ARZ" = "ARI", "BLT" = "BAL", "CLV" = "CLE", "HST" = "HOU",
    "SL" = "LAR", "JAC" = "JAX", .default = x)
}

invisible(PSI)
