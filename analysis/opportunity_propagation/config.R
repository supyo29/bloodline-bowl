# ===========================================================================
# Injury -> Opportunity Propagation Intelligence -- Phase 3, Checkpoint B
# configuration.
#
# See docs/INJURY_OPPORTUNITY_PROPAGATION_PHASE_3_AUDIT.md (Checkpoint A) and
# docs/INJURY_OPPORTUNITY_PROPAGATION_PHASE_3_CHECKPOINT_B.md (this
# checkpoint).
#
# Checkpoint A's semantic correction (binding for all of Phase 3): this repo
# has NO historical source that reliably distinguishes injury from any other
# cause of nonparticipation. Every event built here is a FACTUAL
# nonparticipation observation, never an injury inference. The word "injury"
# does not appear in any type, column, or status value produced by this
# module except inside the module's own name (a legacy label from the
# instructions, not a semantic claim) and the `cause` field's controlled
# vocabulary, which defaults to UNKNOWN and requires real source evidence
# to be anything else.
#
# This module reuses Phase 1's raw ingestion (analysis/football_intel/
# cache/*.rds) and Phase 2's player-game role substrate (analysis/
# player_role/cache/player_game_role.rds, and the Checkpoint C role-profile
# functions in analysis/player_role/lib_role_profile.R) rather than
# recreating any share/EWMA/confidence formula. See lib_redistribution_
# observed.R for the exact reuse points.
# ===========================================================================

.opp_dir <- local({
  root_candidates <- c(Sys.getenv("FI_ROOT", ""), getwd())
  for (r in root_candidates) {
    if (nzchar(r) && dir.exists(file.path(r, "analysis", "opportunity_propagation"))) return(file.path(r, "analysis", "opportunity_propagation"))
  }
  .here <- sub("^--file=", "", grep("^--file=", commandArgs(FALSE), value = TRUE))
  if (length(.here) && nzchar(.here[1])) return(dirname(.here[1]))
  file.path(getwd(), "analysis", "opportunity_propagation")
})
# ROLE (Phase 2) sources FI (Phase 1) itself -- one source() call gets both envs.
source(file.path(.opp_dir, "..", "player_role", "config.R"))          # defines ROLE, FI
source(file.path(.opp_dir, "..", "player_role", "lib_role_profile.R")) # defines dimension_series/build_dimension_profile/etc (ROLE-scoped constants)

OPP <- new.env()

# ---- versioning -------------------------------------------------------------
OPP$SCHEMA_VERSION <- "opportunity-propagation-substrate:v1"  # Checkpoint B data/grain contract
OPP$SEED           <- FI$SEED

# ---- v1 scope (spec Checkpoint B §5, §7, §25, §26) --------------------------
# QB excluded from the absent-player universe entirely -- QB nonparticipation
# changes the offensive environment/play-calling globally rather than merely
# redistributing a role among teammates, and needs a separate model (spec
# §5, §30/§53 of the Phase 3 instructions, reaffirmed explicitly in
# Checkpoint B's instructions).
OPP$ABSENT_PLAYER_POSITIONS <- c("RB", "WR", "TE")
# Beneficiary candidate pool: same-team skill positions plus QB (QB's own
# rushing changes are recorded as a named residual component, never folded
# into an RB/WR/TE beneficiary row -- see lib_redistribution_observed.R).
OPP$BENEFICIARY_POSITIONS <- c("RB", "WR", "TE", "QB")

# ---- roster-status vocabulary (measured empirically against
# analysis/football_intel/cache/rosters_weekly.rds -- see Checkpoint B
# report §"roster status reliability audit"; do not edit without re-running
# that audit) ------------------------------------------------------------
# Statuses that confirm the player remained associated with the team for
# that week AND did not play -- i.e. a genuine, source-backed
# nonparticipation-while-rostered signal. Empirically verified: zero of
# these rows ever coincide with a Phase 2 participation row for the same
# (season, week, gsis_id) -- see Checkpoint B report.
OPP$ROSTER_CONFIRMED_NONPARTICIPATION_STATUSES <- c("INA", "RES", "PUP", "SUS")
# Statuses that mean the player left the team's roster (trade, release,
# retirement, free agency, exemption) -- these are TEAM_CHANGE-shaped
# discontinuities, never modeled as "vacated opportunity due to absence."
OPP$ROSTER_DEPARTURE_STATUSES <- c("CUT", "TRD", "TRC", "TRT", "RET", "UFA", "RFA", "NWT", "EXE", "E01", "E14")
# ACT/DEV (and any other status) with no participation row is NOT treated
# as roster-confirmed nonparticipation -- it is ambiguous (roster says
# active, or practice-squad, but there is no positive confirmation the
# absence was a game-day inactive/reserve decision). See Checkpoint B
# report for the measured contradiction rate.

# ---- meaningful pre-event role thresholds (spec §10/§26: publish multiple
# candidates, do not lock prematurely; DEFAULT is v1's working threshold,
# used for the qualified-event flag; LOW/HIGH are sensitivity variants
# reported alongside it, never silently substituted). All thresholds are
# applied to the Phase 2 pre-event `recent` EWMA value (see
# lib_redistribution_observed.R), never to `latest` (which is undefined for
# an absent player at the event week) and never to a raw single-game value.
OPP$MEANINGFUL_ROLE_THRESHOLDS <- list(
  DEFAULT = list(snap_share = 0.15, rush_share = 0.10, target_share = 0.08, return_share = 0.30),
  LOW     = list(snap_share = 0.10, rush_share = 0.06, target_share = 0.05, return_share = 0.20),
  HIGH    = list(snap_share = 0.20, rush_share = 0.15, target_share = 0.12, return_share = 0.40)
)

# ---- paths -------------------------------------------------------------------
OPP$ROOT      <- FI$ROOT
OPP$CACHE_DIR <- file.path(OPP$ROOT, "analysis", "opportunity_propagation", "cache")
dir.create(OPP$CACHE_DIR, showWarnings = FALSE, recursive = TRUE)
# No lib/<...>/data serve directory yet -- Checkpoint B is internal-only
# (spec §34: "Do not serve a public TypeScript product yet").

# ---- content-hash version id (same determinism rules as FI/ROLE: wall-clock
# generated_at excluded from the digest). ------------------------------------
OPP$compute_version <- function(season_min, season_max, absence_events) {
  content <- digest::digest(list(
    OPP$SCHEMA_VERSION, season_min, season_max, absence_events
  ), algo = "sha256")
  sprintf("opp:%d-%d:%s", season_min, season_max, substr(content, 1, 12))
}

# ---- Checkpoint D: served OPI ("opi:<season>:w<week>:<12hex>") version --
# identical rule (generated_at excluded from the digest) as OPP$compute_
# version/ROLE$compute_version/FI$compute_version -- extracted as its own
# function specifically so it is independently unit-testable (spec §6/§48).
OPP$compute_opi_version <- function(season, through_week, model_tag, model_method, schema_version,
                                    training_window, role_opportunity_version,
                                    league_table, position_table, team_table, weights_table, dims_table) {
  content <- digest::digest(list(
    model_tag, model_method, schema_version, training_window, role_opportunity_version,
    league_table, position_table, team_table, weights_table, dims_table
  ), algo = "sha256")
  sprintf("opi:%d:w%02d:%s", season, through_week, substr(content, 1, 12))
}

invisible(OPP)
