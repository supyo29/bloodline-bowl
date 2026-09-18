#!/usr/bin/env Rscript
# ===========================================================================
# Injury -> Opportunity Propagation Intelligence -- Checkpoint D served
# artifact build.
#
#   Rscript analysis/opportunity_propagation/serve_opportunity_propagation.R
#
# FREEZES Checkpoint C's selected model (CANDIDATE_4_HIERARCHICAL) exactly
# as validated -- no retuning happens here. Fits the model ONE more time on
# the identical primary calibration population Checkpoint C used (2019-2025
# onset, single_major_absence, DEFAULT threshold) -- this is the SAME fit
# Checkpoint C's own run_checkpoint_c.R performed and cached as
# final_model.rds; this script re-derives it from the same inputs (rather
# than reading that internal cache) so the served artifact's provenance is
# self-contained and reproducible from Checkpoint B's substrate alone.
#
# Writes a small, content-hashed served artifact under
# lib/opportunity-propagation-intelligence/data/ -- NOT the 2.26M-row
# beneficiary_observations table (spec Checkpoint D §37: avoid serving
# millions of Checkpoint B rows). Only the fitted hierarchical priors,
# position-relationship weights, and a manifest are served; live scenario
# evaluation combines these with Phase 2's OWN already-served current role
# snapshot (lib/player-role-intelligence/data/), never a re-fetch of
# historical training rows.
# ===========================================================================

suppressWarnings(suppressMessages({ library(dplyr); library(jsonlite); library(data.table) }))

.here <- sub("^--file=", "", grep("^--file=", commandArgs(FALSE), value = TRUE))
.opp_dir <- if (nzchar(.here)) dirname(.here) else file.path(getwd(), "analysis", "opportunity_propagation")
source(file.path(.opp_dir, "config.R"))
source(file.path(.opp_dir, "lib_absence_detection.R"))
source(file.path(.opp_dir, "lib_fast_baselines.R"))
source(file.path(.opp_dir, "lib_redistribution_observed.R"))
source(file.path(.opp_dir, "lib_episodes.R"))
source(file.path(.opp_dir, "lib_propagation_model.R"))
source(file.path(.opp_dir, "backtest.R"))

SERVE_DIR <- file.path(OPP$ROOT, "lib", "opportunity-propagation-intelligence", "data")
dir.create(SERVE_DIR, showWarnings = FALSE, recursive = TRUE)

MODEL_TAG <- "opportunity-propagation-2026.1"
MODEL_METHOD <- "CANDIDATE_4_HIERARCHICAL"  # frozen selection from Checkpoint C -- do not change without a new certification
SCHEMA_VERSION <- "opportunity-propagation-served:v1"
TRAINING_WINDOW <- list(start_season = 2019L, end_season = 2025L)
ROBUSTNESS_WINDOW <- list(start_season = 2012L, end_season = 2018L)

cat("Loading Checkpoint B substrate + Phase 2 Role Intelligence manifest ...\n")
absence_events <- readRDS(file.path(OPP$CACHE_DIR, "absence_events.rds"))
domain_accounting <- readRDS(file.path(OPP$CACHE_DIR, "domain_accounting.rds"))
beneficiary_observations <- readRDS(file.path(OPP$CACHE_DIR, "beneficiary_observations.rds"))
roster_lookup <- readRDS(file.path(OPP$CACHE_DIR, "roster_lookup.rds"))
pgr <- readRDS(file.path(ROLE$CACHE_DIR, "player_game_role.rds"))
schedules <- readRDS(file.path(FI$CACHE_DIR, "schedules.rds"))
cal <- build_team_game_calendar(schedules)

role_manifest_path <- file.path(ROLE$SERVE_DIR, "role_opportunity_manifest.json")
role_manifest <- jsonlite::fromJSON(role_manifest_path)
role_opportunity_version <- role_manifest$role_opportunity_version
role_season <- role_manifest$season
role_through_week <- role_manifest$through_week
cat(sprintf("Role Intelligence dependency: %s (season=%d, through_week=%d)\n", role_opportunity_version, role_season, role_through_week))

ed <- absence_events %>% distinct(season, week, team, gsis_id, position, status, absence_set_id, absence_multiplicity,
                                  meaningful_role_default) %>%
  mutate(absence_event_id = paste(season, week, team, gsis_id, sep = ":"))
episodes <- build_absence_episodes(ed, roster_lookup, pgr, cal)
onset_keys <- episodes %>% filter(episode_state == "EPISODE_ONSET") %>% distinct(gsis_id, team, season, week)
onset_events <- ed %>% inner_join(onset_keys, by = c("gsis_id", "team", "season", "week"))

train_ids <- onset_events %>%
  filter(meaningful_role_default, season >= TRAINING_WINDOW$start_season, season <= TRAINING_WINDOW$end_season,
         absence_multiplicity == "single_major_absence") %>%
  pull(absence_event_id)
cat(sprintf("Fitting frozen model on %d onset single-absence events (%d-%d) ...\n",
           length(train_ids), TRAINING_WINDOW$start_season, TRAINING_WINDOW$end_season))

train_frames <- build_event_frames(train_ids, absence_events, domain_accounting, beneficiary_observations)
priors <- fit_inheritance_priors(train_frames$domain_accounting, train_frames$events_meta)
position_weights <- fit_position_relationship_weights(train_frames$beneficiary_observations, train_frames$events_meta)

# ---- write served parameter tables (small, deterministic, row-order
# canonicalized so identical content always serializes identically) -----
league_out <- as.data.frame(priors$league[order(dimension)])
position_out <- as.data.frame(priors$position[order(dimension, position)])
team_out <- as.data.frame(priors$team[order(dimension, team, position)])
weights_out <- as.data.frame(position_weights[order(dimension)])

write.csv(league_out, file.path(SERVE_DIR, "inheritance_priors_league.csv"), row.names = FALSE)
write.csv(position_out, file.path(SERVE_DIR, "inheritance_priors_position.csv"), row.names = FALSE)
write.csv(team_out, file.path(SERVE_DIR, "inheritance_priors_team.csv"), row.names = FALSE)
write.csv(weights_out, file.path(SERVE_DIR, "position_relationship_weights.csv"), row.names = FALSE)

# ---- dimension/domain table (which of Phase 2's own RoleDomain
# dimensions this model supports, and which positions each applies to) --
dims_out <- OPP$DIMENSIONS %>% mutate(positions = sapply(positions, paste, collapse = "|")) %>%
  select(domain, dimension, positions)
write.csv(dims_out, file.path(SERVE_DIR, "supported_dimensions.csv"), row.names = FALSE)

# ---- content-deterministic version: hash EVERY served table's content,
# NEVER generated_at -- identical analytical content always yields the
# identical id (mirrors FI$compute_version / ROLE$compute_version exactly).
# Delegated to OPP$compute_opi_version() (config.R) so this exact rule is
# independently unit-tested (test-opi-version-determinism.R, spec §6/§48).
opi_season <- role_season
opi_through_week <- role_through_week
opi_version <- OPP$compute_opi_version(opi_season, opi_through_week, MODEL_TAG, MODEL_METHOD, SCHEMA_VERSION,
                                       TRAINING_WINDOW, role_opportunity_version,
                                       league_out, position_out, team_out, weights_out, dims_out)

# ---- known feature/scenario support metadata (spec Checkpoint D §7,
# §9, §19-20, §28, §30) -- machine-readable, not just prose. -------------
manifest <- list(
  model_tag = MODEL_TAG,
  opportunity_propagation_version = opi_version,
  schema_version = SCHEMA_VERSION,
  season = opi_season,
  through_week = opi_through_week,
  generated_at = format(Sys.time(), "%Y-%m-%dT%H:%M:%S%z", tz = "UTC"),

  role_opportunity_dependency = list(
    role_opportunity_version = role_opportunity_version,
    role_opportunity_model_tag = role_manifest$role_opportunity_model_tag,
    season = role_season, through_week = role_through_week
  ),
  football_intelligence_dependency = NULL,  # spec §5: no real FI analytical input exists in this model -- do not claim a dependency that isn't real

  training_window = list(start_season = TRAINING_WINDOW$start_season, end_season = TRAINING_WINDOW$end_season,
                        onset_single_absence_events = length(train_ids)),
  robustness_window = list(start_season = ROBUSTNESS_WINDOW$start_season, end_season = ROBUSTNESS_WINDOW$end_season,
                           note = "frozen-model diagnostic only; never used to tune"),
  forward_diagnostic_window = list(season = 2026L, note = "frozen-model diagnostic only; never used to tune"),

  model_method = MODEL_METHOD,
  model_description = "Hierarchical role-vector allocator: pre-event Phase 2 role share, weighted by the candidate's own recent-vs-season trend and a trained same-position affinity multiplier, scaled by a team->position->league shrunk empirical inheritance rate.",

  historical_training_semantics = list(
    event_definition = "QUALIFIED_FULL_GAME_NONPARTICIPATION",
    cause = "UNKNOWN",
    cause_note = "No source in this repository distinguishes injury from any other cause of nonparticipation. Historical training events are all-cause. A live scenario may be INSTANTIATED by a real injury, but the model itself is not injury-specific and never estimates medical probability or severity."
  ),

  supported_scenario_type = "FULL_GAME_NONPARTICIPATION",
  scenario_semantics = "CONDITIONAL (IF player X is unavailable for the full game) -- not probabilistic. Phase 3 does not estimate P(player X misses the game).",
  episode_semantics = "Calibrated against EPISODE_ONSET events only (a player's first qualified nonparticipation game after observed participation). No calibrated continuation-adjustment model exists; a supplied scenario is always evaluated as if onset.",

  supported_absent_positions = c("RB", "WR", "TE"),
  unsupported_absent_positions = list(QB = "UNSUPPORTED_SCENARIO -- QB nonparticipation changes offensive structure globally rather than merely redistributing role; never routed through this model"),

  single_absence_support = "CALIBRATED",
  multi_absence_support = "EXPERIMENTAL_MULTI_ABSENCE",
  multi_absence_support_note = "Checkpoint C found multi-absence performance materially weaker than single-absence on every metric, and a simple next-man-up baseline beat this model specifically on multi-absence top-beneficiary accuracy. Multi-absence scenarios are evaluated (never silently reduced to independent single-player summation) but must be treated as degraded/experimental, never calibrated.",

  confidence_semantics = list(
    tiers_supported = c("LOW", "INSUFFICIENT_EVIDENCE"),
    tiers_not_supported = c("MEDIUM", "HIGH"),
    note = "Checkpoint C's primary calibration sample (252 onset single-absence episodes) never reached the MEDIUM threshold (>=500 training events) in any walk-forward fold. No HIGH tier was ever validated. Serving MEDIUM/HIGH here would be decorative, not calibrated -- Phase 2's own precedent (HIGH retired) is followed."
  ),
  uncertainty_ranges_supported = FALSE,
  uncertainty_note = "No empirically calibrated interval was established in Checkpoint C at this sample size; only evidence_count (training sample size) and historical_error (backtest MAE) are served -- never a probability-like interval.",

  red_zone_support = "INSUFFICIENT_EVIDENCE_POSSIBLE",
  red_zone_note = "HIGH_VALUE domain (rz_carry_share/rz_target_share) is sparse; the manifest's dimension table marks it, and evidence_count/historical_error must be inspected per prediction rather than assuming confident goal-line redistribution.",

  routes = list(
    historical_feature_capability = "UNRELIABLE_NON_ELIGIBLE_POSITION / source-lagged (Checkpoint B/C finding)",
    current_route_availability = "NOT REQUIRED",
    model_requires_routes = FALSE
  ),

  returns_kept_separate = TRUE,

  deployment_state = "SHADOW_ONLY",
  eligible_to_influence_production = FALSE,
  production_numeric_influence = "PROHIBITED",

  known_limitations = c(
    "historical training cause is UNKNOWN for 100% of events (no injury-specific source exists)",
    "v1 supports FULL_GAME_NONPARTICIPATION only, not LIMITED/QUESTIONABLE scenarios",
    "supported absent-player positions are RB/WR/TE only; QB returns an explicit UNSUPPORTED_SCENARIO result",
    "multi-absence scenarios are EXPERIMENTAL_MULTI_ABSENCE, not calibrated",
    "coaching continuity (OC/DC) is unavailable and not used; only season/team/player-team-change discontinuities are modeled",
    "route participation is not used and not required",
    "no player-availability probability is modeled or estimated anywhere in this product",
    "no fantasy-points, PPR, or scoring translation exists anywhere in this product"
  )
)

manifest_path <- file.path(SERVE_DIR, "opportunity_propagation_manifest.json")
write(jsonlite::toJSON(manifest, auto_unbox = TRUE, pretty = TRUE, na = "null", null = "null"), manifest_path)

cat(sprintf("\nServed artifact: %s\n", SERVE_DIR))
for (f in list.files(SERVE_DIR)) cat(sprintf("  %s (%.1f KB)\n", f, file.size(file.path(SERVE_DIR, f)) / 1024))
cat(sprintf("\nopportunity_propagation_version: %s\n", opi_version))
cat("Checkpoint D served-artifact build complete.\n")
