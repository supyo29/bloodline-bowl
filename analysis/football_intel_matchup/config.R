# ===========================================================================
# Phase 5 Matchup Intelligence — configuration (single source of truth).
# Reuses the frozen Phase 3 FI engine + the Phase 4 decision dataset as
# read-only upstreams. Nothing here re-derives a Phase 3/4 statistic.
# ===========================================================================

MI <- new.env()

MI$MATCHUP_MODEL_VERSION       <- "ri-matchup-2026.1"
MI$DISTRIBUTION_MODEL_VERSION  <- "ri-matchup-dist-2026.1"
MI$CORRELATION_MODEL_VERSION   <- "ri-matchup-corr-2026.1"
MI$SEED                        <- 20260908L

# scoring archetypes (Sleeper precomputed points) — same as Phase 4
MI$ARCHETYPES <- c(std = "pts_std", half = "pts_half_ppr", ppr = "pts_ppr")
MI$PRIMARY_ARCHETYPE <- "ppr"

MI$SEASONS   <- 2021:2025
MI$MIN_WEEK  <- 4L
MI$MAX_WEEK  <- 17L
MI$SKILL_POS <- c("QB", "RB", "WR", "TE")
MI$ALL_POS   <- c("QB", "RB", "WR", "TE", "K", "DEF")

# chronology-safe walk-forward: train dist/corr params on seasons < s, evaluate on s
MI$OUTER_TEST_SEASONS <- 2023:2025

# heteroscedastic residual model candidates (compared by OOS calibration, §3)
#   const   : sd = c_pos
#   cv      : sd = |proj| * CV_pos            (the current weeklyBand heuristic)
#   bucket  : sd = empirical sd within a projection bucket
#   linear  : sd = a_pos + b_pos * proj       (continuous heteroscedastic)
#   sqrt    : sd = a_pos + b_pos * sqrt(max(proj,0))
MI$DIST_CANDIDATES <- c("const", "cv", "bucket", "linear", "sqrt")
MI$PROJ_BUCKETS <- c(-1, 4, 8, 12, 16, 22, 60)

# current weeklyBand CV (lib/weekly/uncertainty.ts) — the control
MI$WEEKLYBAND_CV <- c(QB = 0.33, RB = 0.44, WR = 0.48, TE = 0.52, K = 0.42, DEF = 0.58)

# marginal distribution family candidates (§4)
#   normal_clamp : max(0, Normal(mu, sd))            (current)
#   skewnormal   : skew-normal fit per position
#   empirical    : resample standardized residuals per position (captures skew+tails)
#   mixture      : bust-inflated: w * point-mass-near-0 + (1-w) * heteroscedastic body
MI$MARGINAL_CANDIDATES <- c("normal_clamp", "empirical", "mixture")

# 2-factor dependence (§6). loadings estimated from residual regression:
#   z_player = L_team * f_team_passing + L_game * f_game_scoring + eps
# f_team_passing loads QB (+1) and its WR/TE; f_game_scoring loads both QBs (+ weak WR/TE)
MI$CORR_CANDIDATES <- c("independent", "pairwise", "twofactor")
MI$CORR_MIN_GAMES  <- 40L        # a team/game with fewer historical games -> loading shrunk to 0

# injury variance widening (§24) — validated, not assumed
MI$INJURY_WIDEN_STATES <- c("Questionable", "Doubtful")

# game context fields to test for INCREMENTAL value on variance / loading / tails (§8)
MI$GAME_CONTEXT_FIELDS <- c("implied_team_total", "game_total", "spread", "is_indoor", "wind")

# simulation (§15) — audited empirically in convergence.R
MI$SIM_N_GRID <- c(1000L, 5000L, 10000L, 20000L, 50000L)
MI$SIM_N      <- 10000L           # frozen after convergence audit

# whole-percent WP precision (§13)
MI$WP_DISPLAY_DECIMALS <- 0L

MI$ROOT <- local({
  ev <- Sys.getenv("FI_ROOT", "")
  if (nzchar(ev) && dir.exists(file.path(ev, "analysis"))) return(ev)
  if (dir.exists(file.path(getwd(), "analysis", "football_intel_matchup"))) return(getwd())
  getwd()
})
MI$FI_DIR    <- file.path(MI$ROOT, "analysis", "football_intel")
MI$SS_DIR    <- file.path(MI$ROOT, "analysis", "football_intel_startsit")
MI$CACHE_DIR <- file.path(MI$ROOT, "analysis", "football_intel_matchup", "cache")
MI$OUT_DIR   <- file.path(MI$ROOT, "outputs", "matchup-2026")
MI$SERVE_DIR <- file.path(MI$ROOT, "lib", "weekly", "data")
for (d in c(MI$CACHE_DIR, MI$OUT_DIR, MI$SERVE_DIR)) dir.create(d, showWarnings = FALSE, recursive = TRUE)

invisible(MI)
