# ===========================================================================
# Injury -> Opportunity Propagation Intelligence -- Checkpoint B observed
# redistribution.
#
# NO PREDICTION HERE (spec §39). Every value this file produces is either:
#   (a) a chronology-safe PRE-EVENT role snapshot, computed from Phase 2's
#       own EWMA/season-mean formula (via the exact, cross-checked
#       vectorized re-expression in lib_fast_baselines.R -- see that file's
#       header and tests/testthat/test-fast-baselines-match-phase2.R for
#       the correctness proof; never a new formula); or
#   (b) an EVENT-GAME OBSERVED value, read directly off Phase 2's
#       player_game_role row for that player/week -- a retrospective fact,
#       not a model output.
#
# Domain/dimension pairs mirror Phase 2's own RoleDomain decomposition
# (participation / receiving / rushing / high_value / returns) exactly --
# see lib/player-role-intelligence/schema.ts.
# ===========================================================================

suppressWarnings(suppressMessages({ library(dplyr) }))

OPP$DIMENSIONS <- tibble::tribble(
  ~domain,        ~dimension,                     ~col,                          ~opp_col,             ~positions,
  "PARTICIPATION","snap_share",                   "snap_share_derived",          "offensive_snaps",    c("RB","WR","TE","QB"),
  "RUSHING",      "rush_share",                   "rush_share",                  "carries",            c("RB","QB"),
  "RUSHING",      "position_group_rush_share",     "position_group_rush_share",   "carries",            c("RB"),
  "RECEIVING",    "target_share",                  "target_share",               "targets",            c("RB","WR","TE"),
  "RECEIVING",    "position_group_target_share",   "position_group_target_share","targets",            c("WR","TE"),
  "RECEIVING",    "air_yards_share",               "air_yards_share",            "targets",            c("RB","WR","TE"),
  "HIGH_VALUE",   "rz_carry_share",                "rz_carry_share",              "red_zone_carries",   c("RB","QB"),
  "HIGH_VALUE",   "rz_target_share",                "rz_target_share",            "red_zone_targets",   c("RB","WR","TE"),
  "RETURNS",      "kick_return_role",              "kick_return_opportunity_share","kick_returns",      c("RB","WR","TE","QB"),
  "RETURNS",      "punt_return_role",               "punt_return_opportunity_share","punt_returns",     c("RB","WR","TE","QB")
)
OPP$EVENT_GAME_COLUMN <- setNames(OPP$DIMENSIONS$col, OPP$DIMENSIONS$dimension)

.dimension_applies <- function(dim_row, position) position %in% dim_row$positions[[1]]

# ---------------------------------------------------------------------------
# fast-series cache: fast_dimension_series() is O(career length) per
# (player, dimension) -- computed once, reused across every event/
# beneficiary lookup that touches that player. Environment-based memoization
# (not a data.frame join) because the access pattern is "random single-
# player lookups scattered across a loop," not a batch join.
# ---------------------------------------------------------------------------
.opp_fast_cache <- new.env()

get_fast_series <- function(gsis_id, dimension, history_by_player) {
  key <- paste(gsis_id, dimension, sep = "::")
  cached <- .opp_fast_cache[[key]]
  if (!is.null(cached)) return(cached)
  ph <- history_by_player[[gsis_id]]
  if (is.null(ph)) { .opp_fast_cache[[key]] <- NA; return(NA) }
  d <- OPP$DIMENSIONS[OPP$DIMENSIONS$dimension == dimension, ]
  fs <- fast_dimension_series(ph %>% arrange(season, week), d$col[1], d$opp_col[1])
  .opp_fast_cache[[key]] <- fs
  fs
}

reset_fast_cache <- function() { rm(list = ls(.opp_fast_cache), envir = .opp_fast_cache) }

# ---------------------------------------------------------------------------
# pre_event_snapshot(): chronology-safe pre-event role for ONE player, ONE
# (season, week) event, across every dimension applicable to that player's
# position. `latest` is intentionally NOT populated here for the ABSENT
# player call site (there is no row -- that is the nonparticipation signal
# itself); for a BENEFICIARY call site the caller separately reads the
# actual event-game row directly (see compute_beneficiaries_and_accounting_
# bulk() below) rather than relying on this function's `latest`.
# ---------------------------------------------------------------------------
pre_event_snapshot <- function(gsis_id, season, week, position, history_by_player) {
  rows <- list()
  for (i in seq_len(nrow(OPP$DIMENSIONS))) {
    d <- OPP$DIMENSIONS[i, ]
    if (!.dimension_applies(d, position)) next
    fs <- get_fast_series(gsis_id, d$dimension, history_by_player)
    if (length(fs) == 1 && is.na(fs)) next
    b <- baseline_asof(fs, season, week)
    conf <- confidence_level(b$n_games_season, b$opportunity_total, corroboration_count = 0, blowout_latest = FALSE)
    evidence_state <- if (b$n_games_season == 0) "INSUFFICIENT_SAMPLE" else if (b$n_games_season < 2) "TENTATIVE" else "OBSERVED"
    rows[[length(rows) + 1]] <- tibble::tibble(
      domain = d$domain, dimension = d$dimension,
      pre_event_recent = b$recent, pre_event_season = b$season_baseline,
      pre_event_n_games_season = b$n_games_season, pre_event_opportunity_total = b$opportunity_total,
      pre_event_confidence = conf, pre_event_evidence_state = evidence_state
    )
  }
  dplyr::bind_rows(rows)
}

# ---------------------------------------------------------------------------
# meaningful_role_flags(): does this pre-event snapshot clear ANY published
# threshold candidate (spec §10/§26) on its `recent` EWMA value? A
# dimension not covered by a threshold key (air_yards_share, rz_*) never
# gates qualification on its own.
# ---------------------------------------------------------------------------
.threshold_key_for_dimension <- function(dimension) {
  switch(dimension,
    snap_share = "snap_share",
    rush_share = "rush_share", position_group_rush_share = "rush_share",
    target_share = "target_share", position_group_target_share = "target_share",
    kick_return_role = "return_share", punt_return_role = "return_share",
    NA_character_
  )
}

meaningful_role_flags <- function(snapshot) {
  out <- list()
  for (variant in names(OPP$MEANINGFUL_ROLE_THRESHOLDS)) {
    th <- OPP$MEANINGFUL_ROLE_THRESHOLDS[[variant]]
    hit <- FALSE
    for (i in seq_len(nrow(snapshot))) {
      key <- .threshold_key_for_dimension(snapshot$dimension[i])
      if (is.na(key)) next
      v <- snapshot$pre_event_recent[i]
      if (!is.na(v) && v >= th[[key]]) hit <- TRUE
    }
    out[[variant]] <- hit
  }
  out
}

# ===========================================================================
# compute_beneficiaries_and_accounting_bulk(): the vectorized replacement
# for a per-event R loop calling beneficiary_candidates()/event_game_
# observed()/pre_event_snapshot() one absence event at a time. A per-event
# loop was measured at ~1.7s/event (data.table's per-call join-plan
# overhead, paid thousands of times) -- infeasible across a full-history
# build. This function performs the SAME joins and the SAME
# fast_dimension_series()/baseline_asof() math (spec §3: no new formula),
# just batched: one data.table merge for candidate identification, one
# merge for event-game observed values, and ONE bulk rolling join PER
# DIMENSION (9 total, not 9-per-event) for pre-event baselines.
# ===========================================================================
compute_beneficiaries_and_accounting_bulk <- function(absence_events, roster_lookup, player_game_role, history_by_player, OPP) {
  ae_dt <- data.table::as.data.table(
    absence_events[, c("absence_event_id", "season", "week", "team", "gsis_id")]
  )
  data.table::setnames(ae_dt, "gsis_id", "absent_gsis_id")

  roster_dt <- data.table::as.data.table(
    roster_lookup[!is.na(roster_lookup$team) & !is.na(roster_lookup$gsis_id),
                  c("season", "week", "team", "gsis_id", "position")]
  )
  data.table::setnames(roster_dt, c("gsis_id", "position"), c("beneficiary_gsis_id", "beneficiary_position"))

  played_pos <- unique(data.table::as.data.table(
    player_game_role[!is.na(player_game_role$gsis_id), c("season", "week", "team", "gsis_id", "position")]
  ))
  data.table::setnames(played_pos, c("gsis_id", "position"), c("beneficiary_gsis_id", "beneficiary_position"))

  cand_a <- merge(ae_dt, roster_dt, by = c("season", "week", "team"), allow.cartesian = TRUE)
  cand_b <- merge(ae_dt, played_pos, by = c("season", "week", "team"), allow.cartesian = TRUE)
  cand <- unique(rbind(cand_a, cand_b), by = c("absence_event_id", "beneficiary_gsis_id"))
  cand <- cand[beneficiary_gsis_id != absent_gsis_id & beneficiary_position %in% OPP$BENEFICIARY_POSITIONS]

  cols_needed <- unique(OPP$DIMENSIONS$col)
  pgr_slim <- unique(data.table::as.data.table(player_game_role)[, c("season", "week", "gsis_id", cols_needed), with = FALSE], by = c("season", "week", "gsis_id"))
  data.table::setnames(pgr_slim, "gsis_id", "beneficiary_gsis_id")
  cand <- merge(cand, pgr_slim, by = c("season", "week", "beneficiary_gsis_id"), all.x = TRUE)
  # a beneficiary with NO event-game row (rostered but truly zero-touch) or
  # an NA on an individual metric is recorded as a genuine 0 -- spec §26's
  # "a real 0, not missing"; this is never used to FABRICATE a Phase 2 row,
  # only to score an already-identified real teammate's actual output.
  for (cl in cols_needed) cand[[cl]][is.na(cand[[cl]])] <- 0

  lookup <- unique(cand[, .(gsis_id = beneficiary_gsis_id, season, week)])

  ben_dim_rows <- vector("list", nrow(OPP$DIMENSIONS))
  for (i in seq_len(nrow(OPP$DIMENSIONS))) {
    d <- OPP$DIMENSIONS[i, ]
    dim_dt <- precompute_all_dimension_series(history_by_player, d$col[1], d$opp_col[1])
    baselines <- bulk_baseline_asof(dim_dt, lookup)
    baselines_by_key <- baselines[cand[, .(gsis_id = beneficiary_gsis_id, season, week)],
                                  on = c("gsis_id", "season", "week")]
    applies <- cand$beneficiary_position %in% d$positions[[1]]
    conf <- mapply(function(n, o) confidence_level(n, o, 0, FALSE),
                   baselines_by_key$n_games_season[applies], baselines_by_key$opportunity_total[applies])
    ben_dim_rows[[i]] <- data.table::data.table(
      absence_event_id = cand$absence_event_id[applies],
      beneficiary_gsis_id = cand$beneficiary_gsis_id[applies],
      beneficiary_position = cand$beneficiary_position[applies],
      domain = d$domain, dimension = d$dimension,
      pre_event_recent = baselines_by_key$recent[applies], pre_event_season = baselines_by_key$season_baseline[applies],
      pre_event_n_games_season = baselines_by_key$n_games_season[applies],
      pre_event_opportunity_total = baselines_by_key$opportunity_total[applies],
      pre_event_confidence = conf,
      event_game_value = cand[[d$col[1]]][applies]
    )
  }
  beneficiary_observations <- data.table::rbindlist(ben_dim_rows)
  beneficiary_observations[, delta := event_game_value - pre_event_recent]
  as_tibble(beneficiary_observations)
}
