# ===========================================================================
# Player Role & Opportunity Intelligence — Phase 2, Checkpoint B configuration.
#
# See docs/PLAYER_ROLE_OPPORTUNITY_PHASE_2_AUDIT.md (Checkpoint A) and
# docs/PLAYER_ROLE_OPPORTUNITY_PHASE_2_CHECKPOINT_B.md (this checkpoint).
#
# This module reuses Football Intelligence's raw ingestion (analysis/
# football_intel/cache/*.rds, populated by analysis/football_intel/fetch_raw.R)
# and its FI env (team normalization, paths, seasons) rather than duplicating
# a second raw download. It does NOT reuse FI's shrunk player_usage_profile —
# Checkpoint A's audit and Checkpoint B's instructions both require Phase 2 to
# build its own player-game-grain substrate from the same raw sources.
#
# Checkpoint B publishes DATA SCHEMA version only (ROLE$SCHEMA_VERSION). No
# role-classification MODEL version exists yet -- that is Checkpoint C.
# ===========================================================================

.role_dir <- local({
  root_candidates <- c(Sys.getenv("FI_ROOT", ""), getwd())
  for (r in root_candidates) {
    if (nzchar(r) && dir.exists(file.path(r, "analysis", "player_role"))) return(file.path(r, "analysis", "player_role"))
  }
  .here <- sub("^--file=", "", grep("^--file=", commandArgs(FALSE), value = TRUE))
  if (length(.here) && nzchar(.here[1])) return(dirname(.here[1]))
  file.path(getwd(), "analysis", "player_role")
})
source(file.path(.role_dir, "..", "football_intel", "config.R"))  # defines FI

ROLE <- new.env()

# ---- versioning -----------------------------------------------------------
ROLE$SCHEMA_VERSION   <- "role-opportunity-schema:v1"   # data/grain contract version (Checkpoint B)
ROLE$MODEL_SCHEMA_VERSION <- "role-profile-model:v1"    # role-profile/change-detection contract (Checkpoint C)
ROLE$FEATURE_SCHEMA_VERSION <- 1L
ROLE$SEED             <- FI$SEED

# ---- grain window -----------------------------------------------------------
# Same season/current-week universe as FI, so this substrate can always be
# cross-checked against the same-week FI snapshot.
ROLE$SEASON_CURRENT <- FI$SEASON_CURRENT

# ---- rule definitions (spec §6-13; document every boundary explicitly) ----
# Red zone / high-value opportunity yard-line boundaries (opponent yard line,
# i.e. pbp's `yardline_100`, the standard NFL/nflverse convention: distance in
# yards from the opponent's end zone; 100 = own goal line, 0 = opponent goal
# line). These match the common NFL red-zone convention (<=20) and the
# tighter goal-line bands nflverse/analysts commonly use for "inside-10" and
# "goal-line" designations.
ROLE$RED_ZONE_YARDLINE   <- 20   # yardline_100 <= 20
ROLE$INSIDE_10_YARDLINE  <- 10   # yardline_100 <= 10
ROLE$GOAL_LINE_YARDLINE  <- 5    # yardline_100 <= 5  ("goal-line carries")

# Two-minute window: final 2:00 of the 2nd and 4th quarters only (the two
# clock-managed, offense-tempo-relevant windows in a normal 60-minute game).
# Overtime (qtr == 5) is explicitly EXCLUDED -- NFL OT (2026 rules: one
# possession minimum, sudden-death afterward) does not have the same
# clock-management incentive structure as a two-minute-drill situation, and a
# comingled OT count would silently change the meaning of "two-minute usage"
# without a documented rule. If OT two-minute usage is wanted later, it must
# be a separate, explicitly-named field.
ROLE$TWO_MINUTE_QUARTERS        <- c(2L, 4L)
ROLE$TWO_MINUTE_SECONDS_REMAINING <- 120

# QB kneels: excluded from BOTH the numerator (a player's own carries) and the
# denominator (team_rush_attempts) for every rushing-share metric. A kneel is
# clock management, not a rushing opportunity -- including it in the team
# denominator would understate every real rusher's share in a game with
# several end-of-half/end-of-game kneels (spec §8 explicit requirement).
ROLE$EXCLUDE_QB_KNEELS <- TRUE

# ---- paths ------------------------------------------------------------------
ROLE$ROOT       <- FI$ROOT
ROLE$CACHE_DIR  <- file.path(ROLE$ROOT, "analysis", "player_role", "cache")
ROLE$SERVE_DIR  <- file.path(ROLE$ROOT, "lib", "player-role-intelligence", "data")
dir.create(ROLE$CACHE_DIR, showWarnings = FALSE, recursive = TRUE)
dir.create(ROLE$SERVE_DIR, showWarnings = FALSE, recursive = TRUE)

# ---- content-hash version id (mirrors FI$compute_version's determinism rules:
# wall-clock (generated_at) is excluded from the digest; identical analytical
# content always produces identical identity). ------------------------------
ROLE$compute_version <- function(season, through_week, player_game_role) {
  content <- digest::digest(list(
    ROLE$SCHEMA_VERSION, ROLE$FEATURE_SCHEMA_VERSION, season, through_week, player_game_role
  ), algo = "sha256")
  sprintf("roi:%d:w%02d:%s", season, through_week, substr(content, 1, 12))
}

invisible(ROLE)
