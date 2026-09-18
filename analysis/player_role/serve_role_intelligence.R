#!/usr/bin/env Rscript
# ===========================================================================
# Player Role & Opportunity Intelligence — Checkpoint D served artifact build.
#
#   Rscript analysis/player_role/serve_role_intelligence.R [season] [week]
#
# Rebuilds role profiles fresh from Checkpoint B's substrate (never reads a
# stale cached profile object) and serves the durable Checkpoint D artifact
# set:
#   lib/player-role-intelligence/data/role_opportunity_manifest.json
#   lib/player-role-intelligence/data/player_role_profile.csv   (wide, one row/player)
#   lib/player-role-intelligence/data/player_role_change.csv    (one row/event)
#
# Does NOT serve the full multi-season player-game substrate (that stays
# internal per Checkpoint B); does NOT alter the Checkpoint C model.
# ===========================================================================
suppressWarnings(suppressMessages({ library(dplyr); library(tidyr); library(jsonlite); library(digest) }))

BASE <- file.path(getwd(), "analysis", "player_role")
source(file.path(BASE, "config.R"))
source(file.path(BASE, "lib_role_profile.R"))
source(file.path(BASE, "lib_role_domains.R"))

args <- commandArgs(TRUE)
season <- if (length(args) >= 1) as.integer(args[1]) else ROLE$SEASON_CURRENT
week <- if (length(args) >= 2) as.integer(args[2]) else 1L

ROLE_INTELLIGENCE_MODEL_TAG <- "role-opportunity-2026.1"

pgr <- readRDS(file.path(ROLE$CACHE_DIR, "player_game_role.rds"))
active_ids <- pgr %>% filter(season == !!season, week == !!week) %>% pull(gsis_id) %>% unique()
cat(sprintf("Rebuilding role profiles for %d players (season %d, week %d) ...\n", length(active_ids), season, week))

t0 <- Sys.time()
profiles <- vector("list", length(active_ids))
for (i in seq_along(active_ids)) {
  profiles[[i]] <- build_role_profile(pgr %>% filter(gsis_id == active_ids[i]), season, week, ROLE)
}
profiles <- Filter(Negate(is.null), profiles)
events <- purrr::map(profiles, extract_change_events) %>% purrr::flatten()
t1 <- Sys.time()
cat(sprintf("Built %d profiles, %d change events in %.1fs\n", length(profiles), length(events), as.numeric(difftime(t1, t0, units = "secs"))))

# ---------------------------------------------------------------------------
# flatten one DimensionProfile into a named list of columns with a prefix.
# ---------------------------------------------------------------------------
.flatten_dim <- function(dp, prefix) {
  if (is.null(dp)) {
    cols <- c("latest", "recent", "season", "prior", "prior_role_confidence", "discontinuity",
             "n_games_season", "opportunity_total", "delta_latest_vs_recent", "trend_latest_vs_recent",
             "trend_latest_vs_season", "trend_recent_vs_prior", "evidence_state", "confidence")
    out <- setNames(rep(list(NA), length(cols)), paste0(prefix, "_", cols))
    return(out)
  }
  keep <- c("latest", "recent", "season", "prior", "prior_role_confidence", "discontinuity",
           "n_games_season", "opportunity_total", "delta_latest_vs_recent", "trend_latest_vs_recent",
           "trend_latest_vs_season", "trend_recent_vs_prior", "evidence_state", "confidence")
  out <- dp[keep]
  names(out) <- paste0(prefix, "_", names(out))
  out
}

flatten_profile <- function(p) {
  row <- c(
    list(gsis_id = p$identity$gsis_id, sleeper_id = NA_character_, full_name = p$identity$full_name,
        position = p$identity$position, team = p$identity$team, opponent = p$identity$opponent,
        season = p$as_of$season, through_week = p$as_of$week),
    .flatten_dim(p$participation, "participation_snap_share"),
    .flatten_dim(if (!is.null(p$receiving)) p$receiving$target_share else NULL, "receiving_target_share"),
    .flatten_dim(if (!is.null(p$receiving)) p$receiving$position_group_target_share else NULL, "receiving_position_group_target_share"),
    .flatten_dim(if (!is.null(p$receiving)) p$receiving$air_yards_share else NULL, "receiving_air_yards_share"),
    .flatten_dim(if (!is.null(p$receiving)) p$receiving$route_participation else NULL, "receiving_route_participation"),
    .flatten_dim(if (!is.null(p$rushing)) p$rushing$rush_share else NULL, "rushing_rush_share"),
    .flatten_dim(if (!is.null(p$rushing)) p$rushing$position_group_rush_share else NULL, "rushing_position_group_rush_share"),
    .flatten_dim(if (!is.null(p$high_value)) p$high_value$rz_target_share else NULL, "high_value_rz_target_share"),
    .flatten_dim(if (!is.null(p$high_value)) p$high_value$rz_carry_share else NULL, "high_value_rz_carry_share"),
    .flatten_dim(p$returns$kick_return_role, "returns_kick_return_role"),
    .flatten_dim(p$returns$punt_return_role, "returns_punt_return_role"),
    list(
      high_value_goal_line_carries_latest = if (!is.null(p$high_value)) p$high_value$goal_line_carries_latest else NA,
      high_value_third_down_targets_latest = if (!is.null(p$high_value)) p$high_value$third_down_targets_latest else NA,
      high_value_two_minute_targets_latest = if (!is.null(p$high_value)) p$high_value$two_minute_targets_latest else NA,
      receiving_corroboration_count = if (!is.null(p$receiving)) p$receiving$corroboration_count else NA,
      rushing_corroboration_count = if (!is.null(p$rushing)) p$rushing$corroboration_count else NA,
      role_level = p$role_state$role_level, role_trend = p$role_state$role_trend, role_evidence_state = p$role_state$evidence_state,
      route_evidence = p$source_availability$route_evidence,
      schema_version = p$schema_version
    )
  )
  tibble::as_tibble(row)
}

profile_df <- bind_rows(lapply(profiles, flatten_profile)) %>%
  left_join(pgr %>% filter(season == !!season, week == !!week) %>% distinct(gsis_id, sleeper_id), by = "gsis_id") %>%
  mutate(sleeper_id = coalesce(sleeper_id.y, sleeper_id.x)) %>% select(-sleeper_id.x, -sleeper_id.y) %>%
  arrange(gsis_id)  # canonical deterministic ordering for stable content identity

flatten_event <- function(e) {
  tibble::tibble(
    gsis_id = e$gsis_id, full_name = e$full_name, season = e$season, through_week = e$week,
    domain = e$domain, dimension = e$dimension, trend = e$trend, evidence_state = e$evidence_state, confidence = e$confidence,
    latest = e$evidence$latest, baseline_recent = e$evidence$recent, baseline_season = e$evidence$season, baseline_prior = e$evidence$prior,
    delta = e$evidence$delta_latest_vs_recent, n_games_season = e$evidence$n_games_season, opportunity_total = e$evidence$opportunity_total
  )
}
event_df <- if (length(events) > 0) bind_rows(lapply(events, flatten_event)) %>% arrange(gsis_id, domain, dimension) else tibble::tibble()

# ---------------------------------------------------------------------------
# null-value validation (spec §11): a feature family claiming current
# availability must show real, non-null population -- catches exactly the
# Checkpoint A/B "OBSERVED metadata + null values" failure mode.
# ---------------------------------------------------------------------------
validate_family_population <- function(col, family_name, expect_population) {
  n <- length(col)
  n_non_na <- sum(!is.na(col))
  pct <- if (n > 0) 100 * n_non_na / n else 0
  if (expect_population && n_non_na == 0 && n > 0) {
    stop(sprintf("VALIDATION FAILURE: %s claims current availability but is 100%% null across %d rows", family_name, n))
  }
  list(family = family_name, n_rows = n, n_non_na = n_non_na, pct_populated = round(pct, 1))
}

route_avail_current <- any(!is.na(profile_df$receiving_route_participation_latest))
validation_report <- list(
  validate_family_population(profile_df$participation_snap_share_latest, "ROLE_SNAPS", TRUE),
  validate_family_population(profile_df$receiving_target_share_latest, "ROLE_TARGETS", TRUE),
  validate_family_population(profile_df$rushing_rush_share_latest, "ROLE_RUSHING", TRUE),
  # ROLE_ROUTES: population is EXPECTED to be all-null this week (participation
  # source lag) -- expect_population=FALSE here means "do not fail if empty",
  # which is the correct behavior for a genuinely-unavailable family. This is
  # the specific guard against a FALSE ALARM as well as a false positive: the
  # manifest's own availability tag (below) must say AVAILABLE_WITH_LAG, not
  # AVAILABLE_CURRENT, whenever this comes back with n_non_na == 0.
  validate_family_population(profile_df$receiving_route_participation_latest, "ROLE_ROUTES", FALSE)
)
cat("\nNull-value validation (feature-family population):\n")
for (v in validation_report) cat(sprintf("  %-14s %d/%d rows populated (%.1f%%)\n", v$family, v$n_non_na, v$n_rows, v$pct_populated))

# route availability false-positive guard: the manifest must never claim
# AVAILABLE_CURRENT for routes when the served data is entirely null.
route_family_status <- if (route_avail_current) "AVAILABLE_CURRENT" else "AVAILABLE_WITH_LAG"
if (route_family_status == "AVAILABLE_CURRENT" && all(is.na(profile_df$receiving_route_participation_latest))) {
  stop("VALIDATION FAILURE: route family marked AVAILABLE_CURRENT but all values are null")
}

# ---------------------------------------------------------------------------
# manifest + content-hash version (generated_at excluded from the digest --
# same determinism rule as FI$compute_version / Checkpoint B's ROLE$compute_version)
# ---------------------------------------------------------------------------
source_availability_raw <- readRDS(file.path(FI$CACHE_DIR, "source_availability.rds"))
family_avail <- function(family, source_name, expect_current) {
  rows <- source_availability_raw %>% filter(source == source_name, season == !!season)
  if (nrow(rows) == 0) {
    status <- if (source_name %in% FI$EXPECTED_SOURCES) "AVAILABLE_WITH_LAG" else "UNAVAILABLE"
    return(list(family = family, source = source_name, status = status, through_week = NA_integer_))
  }
  list(family = family, source = source_name, status = "AVAILABLE_CURRENT", through_week = max(rows$week))
}

source_availability <- list(
  family_avail("ROLE_SNAPS", "snap_counts", TRUE),
  family_avail("ROLE_TARGETS", "pbp", TRUE),
  family_avail("ROLE_RUSHING", "pbp", TRUE),
  family_avail("ROLE_RED_ZONE", "pbp", TRUE),
  family_avail("ROLE_ROUTES", "participation", FALSE),
  list(family = "ROLE_RETURNS", source = "pbp", status = "AVAILABLE_CURRENT", through_week = week)
)

week_completion <- FI$compute_week_completion(readRDS(file.path(FI$CACHE_DIR, "schedules.rds")), season, week)
data_cutoff <- source_availability_raw %>% filter(season == !!season, source %in% c("pbp", "participation", "snap_counts")) %>%
  group_by(source) %>% summarise(through_week = max(week), .groups = "drop") %>% tibble::deframe() %>% as.list()

content_digest <- digest::digest(list(
  ROLE_INTELLIGENCE_MODEL_TAG, ROLE$MODEL_SCHEMA_VERSION, season, week,
  profile_df, event_df,
  # source-availability SEMANTICS (not raw cutoffs) participate in identity:
  # a change from AVAILABLE_WITH_LAG to AVAILABLE_CURRENT is a material
  # change in what consumers can know, even if it happened to not change any
  # profile value yet.
  lapply(source_availability, function(x) list(x$family, x$status))
), algo = "sha256")
role_opportunity_version <- sprintf("roi:%d:w%02d:%s", season, week, substr(content_digest, 1, 12))

manifest <- list(
  role_opportunity_model_tag = ROLE_INTELLIGENCE_MODEL_TAG,
  role_opportunity_version = role_opportunity_version,
  feature_schema_version = ROLE$MODEL_SCHEMA_VERSION,
  substrate_schema_version = ROLE$SCHEMA_VERSION,
  season = season, through_week = week,
  generated_at = format(Sys.time(), "%Y-%m-%dT%H:%M:%S%z", tz = "UTC"),
  week_completion = week_completion,
  source_cutoffs = data_cutoff,
  source_availability = source_availability,
  model_configuration = list(
    recency_method = "EWMA",
    recency_halflife_games = ROLE$RECENT_HALFLIFE_GAMES,
    prior_methodology = "player's own prior-season EWMA (same half-life), discontinuity-discounted for team/position change",
    confidence_methodology_version = "role-confidence:v2",
    confidence_methodology_note = "v2 (Checkpoint E): HIGH tier retired -- a chronology-safe historical backtest found HIGH-confidence trending events persisted less reliably (43.8%) than MEDIUM (49.1%), n=856; confidence_level() now caps at MEDIUM pending further calibration. See PLAYER_ROLE_OPPORTUNITY_PHASE_2_CERTIFICATION.md.",
    min_share_delta = ROLE$MIN_SHARE_DELTA,
    min_opportunity_for_trend = ROLE$MIN_OPPORTUNITY_FOR_TREND,
    role_level_calibration_basis = list(
      WR = "empirical quantiles, 2012-2025 substrate",
      RB = "empirical quantiles, 2012-2025 substrate",
      TE = "empirical TE-specific quantiles, 2012-2025 substrate (n=14,855; verified era-stable, 2012-2018 vs 2019-2025 nearly identical) -- CORRECTED in Checkpoint E: earlier checkpoints' 'TE uses WR fallback' caveat was overstated. The dimension that actually drives TE role_level (target_share) has always used real TE-specific thresholds; only an unused position-group-share config entry (never read by role_level()) reuses a WR approximation."
    ),
    confidence_calibration_scope = "global + positional dimension sets only, as actually backtested -- NOT separately calibrated for rookies, team-changers, or volume tiers (Checkpoint C known limitation)"
  ),
  deployment_state = "SHARED_CONTEXT",
  eligible_to_influence_production = FALSE,
  known_unavailable_feature_families = c("ALIGNMENT", "MOTION_PLAYER_LEVEL", "PASS_BLOCKING", "RUN_BLOCKING"),
  row_counts = list(profiles = nrow(profile_df), change_events = nrow(event_df)),
  dependencies = list(substrate = "player_game_role.csv (Checkpoint B)", substrate_schema_version = ROLE$SCHEMA_VERSION)
)

dir.create(ROLE$SERVE_DIR, showWarnings = FALSE, recursive = TRUE)
write.csv(profile_df, file.path(ROLE$SERVE_DIR, "player_role_profile.csv"), row.names = FALSE, na = "")
write.csv(event_df, file.path(ROLE$SERVE_DIR, "player_role_change.csv"), row.names = FALSE, na = "")
write(jsonlite::toJSON(manifest, auto_unbox = TRUE, pretty = TRUE, na = "null"), file.path(ROLE$SERVE_DIR, "role_opportunity_manifest.json"))

cat(sprintf("\nServed: %s (%d rows)\n", file.path(ROLE$SERVE_DIR, "player_role_profile.csv"), nrow(profile_df)))
cat(sprintf("Served: %s (%d rows)\n", file.path(ROLE$SERVE_DIR, "player_role_change.csv"), nrow(event_df)))
cat(sprintf("Manifest: %s\n", file.path(ROLE$SERVE_DIR, "role_opportunity_manifest.json")))
cat(sprintf("role_opportunity_version: %s\n", role_opportunity_version))
cat(sprintf("route family status: %s\n", route_family_status))
