# ===========================================================================
# Injury -> Opportunity Propagation Intelligence -- Checkpoint B absence
# detection.
#
# Builds CANDIDATE_FULL_GAME_NONPARTICIPATION events and resolves the
# roster/team/identity dimension needed to classify each one into
# QUALIFIED_FULL_GAME_NONPARTICIPATION, AMBIGUOUS_NONPARTICIPATION, or a
# deterministic exclusion reason (spec §6-11, §21, §30). Role-magnitude
# gating (meaningful pre-event role) happens in build_absence_events.R,
# after lib_redistribution_observed.R computes the chronology-safe pre-event
# Phase 2 role snapshot.
#
# Hard rule (spec §7): a missing Phase 2 player_game_role row is NEVER by
# itself treated as a confirmed absence. Every event here requires an
# independent roster/schedule join before it becomes even a candidate.
# ===========================================================================

suppressWarnings(suppressMessages({ library(dplyr); library(data.table) }))

# ---------------------------------------------------------------------------
# build_team_game_calendar(): every (season, week, team) with a VALID,
# COMPLETED NFL game -- spec §8. A completed game is one with both scores
# present, matching the same completeness semantics the NFL Reality Frontier
# (Phase 1) uses (an exact "finished" signal, never inferred from calendar
# date). Bye weeks are automatically absent from this calendar (a team with
# no scheduled/completed game that week simply has no row) -- test #1.
# ---------------------------------------------------------------------------
build_team_game_calendar <- function(schedules) {
  completed <- schedules %>% filter(!is.na(home_score), !is.na(away_score))
  home <- completed %>% transmute(season, week, team = home_team, opponent = away_team, game_id)
  away <- completed %>% transmute(season, week, team = away_team, opponent = home_team, game_id)
  bind_rows(home, away) %>% distinct()
}

# ---------------------------------------------------------------------------
# build_roster_lookup(): one resolved row per (season, week, gsis_id).
# Ambiguity handling (spec §9, §32): if rosters_weekly carries more than one
# DISTINCT team (or, given one team, more than one distinct status) for the
# same (season, week, gsis_id) key, the row is marked `unresolved = TRUE`
# rather than arbitrarily picking one -- never silently disambiguated by
# row order. Measured duplicate rate is reported in the Checkpoint B report.
# ---------------------------------------------------------------------------
build_roster_lookup <- function(rosters_weekly) {
  rosters_weekly %>%
    filter(!is.na(gsis_id), gsis_id != "") %>%
    group_by(season, week, gsis_id) %>%
    summarise(
      n_rows = dplyr::n(),
      n_distinct_teams = n_distinct(team),
      team = if (n_distinct(team) == 1) dplyr::first(team) else NA_character_,
      status = if (n_distinct(team) == 1 && n_distinct(status) == 1) dplyr::first(status) else NA_character_,
      position = if (n_distinct(position) == 1) dplyr::first(position) else NA_character_,
      unresolved = n_distinct(team) > 1,
      .groups = "drop"
    )
}

# ---------------------------------------------------------------------------
# detect_candidate_events(): for the absent-player-eligible position
# universe, join team-game calendar x roster lookup x Phase 2 participation
# to produce one row per (season, week, gsis_id) where:
#   - the player's roster team played a valid completed game that week
#     (spec §8)
#   - the player has NO Phase 2 participation row for that (season, week,
#     gsis_id) at that team (spec §7's required independent check)
# This is CANDIDATE-level only -- no role-magnitude or roster-status
# filtering yet.
# ---------------------------------------------------------------------------
detect_candidate_events <- function(player_game_role, roster_lookup, team_game_calendar, positions) {
  eligible_ids <- player_game_role %>%
    filter(position %in% positions) %>%
    distinct(gsis_id) %>%
    pull(gsis_id)

  roster_elig <- roster_lookup %>% filter(gsis_id %in% eligible_ids, !is.na(team))

  joined <- roster_elig %>%
    inner_join(team_game_calendar, by = c("season", "week", "team"))

  played_keys <- player_game_role %>% distinct(season, week, gsis_id, team) %>%
    mutate(played = TRUE)

  joined %>%
    left_join(played_keys, by = c("season", "week", "gsis_id", "team")) %>%
    filter(is.na(played)) %>%
    select(-played)
}

# ---------------------------------------------------------------------------
# attach_last_known_team(): for each candidate (season, week, gsis_id), the
# player's own most recent TEAM from Phase 2 participation history STRICTLY
# BEFORE the event week (never the event week itself, never a later week --
# spec §9/§11/§23's chronology-safety requirement). Implemented as a
# data.table rolling ("as of") join for O(n log n) performance instead of a
# per-row filter() (which would be O(candidates x full history)).
#
# `event_key` = season*100 + week is monotonic within the 1-18-week regular
# season used throughout this repo (FI$PBP_SEASONS is regular-season-only,
# verified in Checkpoint B report), so ordering by event_key exactly matches
# chronological ordering.
# ---------------------------------------------------------------------------
attach_last_known_team <- function(candidates, player_game_role) {
  hist_dt <- as.data.table(player_game_role %>% distinct(gsis_id, season, week, team))
  hist_dt[, event_key := season * 100L + week]
  setkey(hist_dt, gsis_id, event_key)

  cand_dt <- as.data.table(candidates)
  cand_dt[, event_key := season * 100L + week]
  # roll = -Inf (data.table convention: roll backward, i.e. take the
  # nearest PRIOR key) with a strict "before" requirement enforced by
  # subtracting 1 from the join key so the event week's own key never
  # matches its own history row (there is none anyway -- candidates are,
  # by construction, weeks with no participation row -- but this keeps the
  # join semantics explicit and future-proof).
  cand_dt[, lookup_key := event_key - 1L]
  setkey(cand_dt, gsis_id, lookup_key)

  out <- hist_dt[cand_dt, on = .(gsis_id, event_key = lookup_key), roll = TRUE,
                 .(gsis_id, season = i.season, week = i.week, event_key = i.event_key,
                   last_known_team = x.team)]
  as_tibble(out) %>% distinct(gsis_id, season, week, last_known_team) %>%
    right_join(candidates, by = c("gsis_id", "season", "week"))
}
