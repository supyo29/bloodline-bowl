# ===========================================================================
# Injury -> Opportunity Propagation Intelligence -- Checkpoint B build.
#
# build_absence_events(): the single orchestration entry point. Produces:
#   - absence_events           (team-game absence event grain, spec §33)
#   - beneficiary_observations (beneficiary grain, spec §33)
#   - domain_accounting        (team/domain accounting grain, spec §33)
#   - excluded                 (every rejected candidate + deterministic reason)
#   - no_meaningful_role       (candidates that passed every gate except role magnitude)
#
# DESCRIPTIVE ONLY (spec §39/§40): no prediction, no fantasy points, no
# outcome-chasing. Every value is either a chronology-safe Phase 2 pre-event
# snapshot (via lib_fast_baselines.R's cross-checked vectorized formula) or
# a directly-observed event-game fact.
# ===========================================================================

suppressWarnings(suppressMessages({ library(dplyr) }))

# ---------------------------------------------------------------------------
# classify_candidates(): assigns exactly one deterministic reason (spec
# §30's vocabulary) per candidate, or "QUALIFIED_PENDING_ROLE_CHECK" for
# candidates that still need the (expensive) role-magnitude check. Fixed,
# documented precedence -- never silent.
# ---------------------------------------------------------------------------
classify_candidates <- function(cand2, ROSTER_CONFIRMED, ROSTER_DEPARTURE, absent_positions) {
  cand2 %>% mutate(
    reason = case_when(
      unresolved                                              ~ "MULTIPLE_TEAM_ASSIGNMENTS",
      !position %in% absent_positions                          ~ "UNSUPPORTED_POSITION",
      is.na(last_known_team)                                    ~ "INSUFFICIENT_PRE_EVENT_HISTORY",
      team != last_known_team                                   ~ "TEAM_CHANGE",
      status %in% ROSTER_DEPARTURE                              ~ "TEAM_CHANGE",
      is.na(status)                                             ~ "SOURCE_GAP",
      !status %in% ROSTER_CONFIRMED                             ~ "ROSTER_ASSOCIATION_AMBIGUOUS",
      TRUE                                                       ~ "QUALIFIED_PENDING_ROLE_CHECK"
    )
  )
}

# ---------------------------------------------------------------------------
# build_absence_events(): main orchestration.
# ---------------------------------------------------------------------------
build_absence_events <- function(player_game_role, rosters_weekly, schedules, OPP, ROLE, FI) {
  reset_fast_cache()
  cal <- build_team_game_calendar(schedules)
  roster_lookup <- build_roster_lookup(rosters_weekly)

  cand <- detect_candidate_events(player_game_role, roster_lookup, cal, OPP$ABSENT_PLAYER_POSITIONS)
  cand2 <- attach_last_known_team(cand, player_game_role)
  classified <- classify_candidates(cand2, OPP$ROSTER_CONFIRMED_NONPARTICIPATION_STATUSES,
                                     OPP$ROSTER_DEPARTURE_STATUSES, OPP$ABSENT_PLAYER_POSITIONS)

  pending <- classified %>% filter(reason == "QUALIFIED_PENDING_ROLE_CHECK")
  resolved_excluded <- classified %>% filter(reason != "QUALIFIED_PENDING_ROLE_CHECK")

  history_by_player <- split(player_game_role, player_game_role$gsis_id)

  role_check_rows <- vector("list", nrow(pending))
  for (i in seq_len(nrow(pending))) {
    r <- pending[i, ]
    snap <- pre_event_snapshot(r$gsis_id, r$season, r$week, r$position, history_by_player)
    flags <- meaningful_role_flags(snap)
    role_check_rows[[i]] <- tibble::tibble(
      gsis_id = r$gsis_id, season = r$season, week = r$week,
      meaningful_role_default = flags$DEFAULT, meaningful_role_low = flags$LOW, meaningful_role_high = flags$HIGH,
      pre_event_snapshot = list(snap)
    )
  }
  role_check <- dplyr::bind_rows(role_check_rows)

  pending2 <- pending %>% left_join(role_check, by = c("gsis_id", "season", "week")) %>%
    mutate(reason = if_else(meaningful_role_default, "QUALIFIED_FULL_GAME_NONPARTICIPATION", "NO_MEANINGFUL_PRE_EVENT_ROLE"))

  qualified <- pending2 %>% filter(reason == "QUALIFIED_FULL_GAME_NONPARTICIPATION")
  no_meaningful_role <- pending2 %>% filter(reason == "NO_MEANINGFUL_PRE_EVENT_ROLE") %>% select(-pre_event_snapshot)

  qualified <- qualified %>% mutate(absence_set_id = paste(season, week, team, sep = ":"))
  set_sizes <- qualified %>% count(absence_set_id, name = "n_absent_in_set")
  qualified <- qualified %>% left_join(set_sizes, by = "absence_set_id") %>%
    mutate(absence_multiplicity = if_else(n_absent_in_set > 1, "multiple_major_absences", "single_major_absence"))

  absence_events <- qualified %>%
    mutate(
      absence_event_id = paste(season, week, team, gsis_id, sep = ":"),
      event_type = "QUALIFIED_FULL_GAME_NONPARTICIPATION",
      cause = "UNKNOWN"   # spec §1/§27: NEVER inferred; no source in this repo supports anything else
    ) %>%
    select(absence_event_id, season, week, game_id, team, opponent, absence_set_id, absence_multiplicity,
           gsis_id, position, status, event_type, cause,
           meaningful_role_default, meaningful_role_low, meaningful_role_high, pre_event_snapshot)

  # ---- beneficiary observations + domain accounting (spec §13-18) --------
  # Bulk/vectorized (see lib_redistribution_observed.R's
  # compute_beneficiaries_and_accounting_bulk() header) -- a per-event R
  # loop calling the same joins one absence event at a time was measured at
  # ~1.7s/event, infeasible across a full-history build.
  beneficiary_observations <- compute_beneficiaries_and_accounting_bulk(
    absence_events %>% select(-pre_event_snapshot), roster_lookup, player_game_role, history_by_player, OPP
  )

  absent_snapshots_long <- absence_events %>% select(absence_event_id, pre_event_snapshot) %>%
    tidyr::unnest(pre_event_snapshot) %>%
    select(absence_event_id, domain, dimension, vacated_opportunity = pre_event_recent)

  qb_rush_by_event <- beneficiary_observations %>%
    filter(beneficiary_position == "QB", dimension == "rush_share") %>%
    group_by(absence_event_id) %>% summarise(qb_rush_share_delta = sum(delta, na.rm = TRUE), .groups = "drop")

  # QB is excluded from "identified beneficiary gain" ONLY for rush_share
  # (spec §16: QB rushing is tracked as a separate named residual component,
  # qb_rush_share_delta, never folded into an RB/WR/TE beneficiary row). QB
  # is NOT excluded from any other domain -- QB values there are near-
  # universally 0 (a QB essentially never absorbs WR/RB targets or return
  # duties), so including them changes nothing in practice, but excluding
  # QB from every domain (not just rushing) would be a broader carve-out
  # than the spec asked for.
  domain_accounting <- beneficiary_observations %>%
    filter(!(beneficiary_position == "QB" & dimension == "rush_share")) %>%
    group_by(absence_event_id, domain, dimension) %>%
    summarise(identified_beneficiary_gain = sum(pmax(delta, 0, na.rm = TRUE), na.rm = TRUE),
              n_beneficiaries_observed = dplyr::n(), .groups = "drop") %>%
    inner_join(absent_snapshots_long, by = c("absence_event_id", "domain", "dimension")) %>%
    left_join(qb_rush_by_event, by = "absence_event_id") %>%
    mutate(
      qb_rush_share_delta = if_else(dimension == "rush_share", qb_rush_share_delta, NA_real_),
      residual_structural_change = vacated_opportunity - identified_beneficiary_gain - coalesce(qb_rush_share_delta, 0)
    )

  absence_events_flat <- absence_events %>%
    left_join(absence_events %>% select(absence_event_id, pre_event_snapshot) %>% tidyr::unnest(pre_event_snapshot),
              by = "absence_event_id") %>%
    select(-pre_event_snapshot)

  list(
    absence_events = absence_events_flat,
    beneficiary_observations = beneficiary_observations,
    domain_accounting = domain_accounting,
    no_meaningful_role = no_meaningful_role,
    excluded = resolved_excluded,
    roster_lookup = roster_lookup,
    candidates_total = nrow(classified)
  )
}
