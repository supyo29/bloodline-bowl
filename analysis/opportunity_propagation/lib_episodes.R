# ===========================================================================
# Injury -> Opportunity Propagation Intelligence -- Checkpoint C episode
# hardening (spec §4-8).
#
# Checkpoint B's 12,291 qualified game-level events are NOT independent
# causal shocks -- a player out for 4 straight team-games is one absence
# episode, not 4. This file derives a deterministic episode layer over
# Checkpoint B's substrate WITHOUT touching absence detection itself (spec
# §3: bug fixes allowed, parallel reimplementation is not).
#
# Clock used for continuity: the TEAM'S OWN completed-game sequence (from
# lib_absence_detection.R's build_team_game_calendar()), not raw calendar
# week number -- a bye week simply has no calendar row, so consecutive
# calendar rows already bridge a bye automatically (spec §5). Team changes
# are a hard episode boundary (never carry an absence episode across a
# team change, spec §23/#17 in the adversarial list).
#
# Episode continuation rule (deterministic, conservative): an episode
# continues across consecutive team-games that are ALSO qualified
# nonparticipation events for that player. It ends the moment the player
# either (a) has a real Phase 2 participation row (RETURN), or (b) has a
# team-game with neither a participation row nor a qualified-absence row
# (e.g. roster status was ACT/DEV that week with no participation --
# CENSORED_UNKNOWN; we do not assume continuity through an unconfirmed
# week), or (c) the team changes. This is a deliberately conservative
# choice, documented rather than hidden -- see Checkpoint C report
# §"episode construction rule."
# ===========================================================================

suppressWarnings(suppressMessages({ library(dplyr); library(data.table) }))

# ---------------------------------------------------------------------------
# build_absence_episodes(): the single entry point.
#   absence_events_distinct: one row per qualified game-level event
#     (season, week, team, gsis_id, position, status, absence_set_id, ...)
#   roster_lookup: Checkpoint B's resolved (season, week, gsis_id) -> team/status
#   player_game_role: Phase 2's real participation rows
#   team_game_calendar: build_team_game_calendar(schedules) -- valid completed games
#
# Returns a data.table, one row per (gsis_id, team, season, week) that is
# EITHER a qualified absence game OR the immediately-following return game
# (kept so continuation analysis (spec §39-40) can see the episode's true
# end), with columns:
#   absence_episode_id, episode_game_index (1-based within the episode,
#   NA for the trailing return row), episode_state (EPISODE_ONSET /
#   EPISODE_CONTINUATION / EPISODE_RETURN), episode_end_reason
#   (RETURN / CENSORED_UNKNOWN / TEAM_CHANGE / SEASON_END -- for the LAST
#   absence row of the episode only).
# ---------------------------------------------------------------------------
build_absence_episodes <- function(absence_events_distinct, roster_lookup, player_game_role, team_game_calendar) {
  qualified_ids <- unique(absence_events_distinct$gsis_id)

  qual_keys <- absence_events_distinct %>%
    mutate(event_key = season * 100L + week) %>%
    select(gsis_id, season, week, team, event_key) %>%
    distinct()

  played_keys <- player_game_role %>%
    filter(gsis_id %in% qualified_ids) %>%
    mutate(event_key = season * 100L + week) %>%
    select(gsis_id, season, week, team, event_key) %>%
    distinct()

  roster_timeline <- roster_lookup %>%
    filter(gsis_id %in% qualified_ids, !is.na(team)) %>%
    mutate(event_key = season * 100L + week) %>%
    inner_join(team_game_calendar %>% mutate(event_key = season * 100L + week) %>% select(season, week, team, event_key),
               by = c("season", "week", "team", "event_key")) %>%
    select(gsis_id, season, week, team, event_key) %>%
    distinct() %>%
    arrange(gsis_id, event_key)

  qual_set <- qual_keys %>% mutate(is_qualified_absence = TRUE) %>% select(gsis_id, event_key, team, is_qualified_absence)
  played_set <- played_keys %>% mutate(is_participation = TRUE) %>% select(gsis_id, event_key, team, is_participation)

  timeline <- roster_timeline %>%
    left_join(qual_set, by = c("gsis_id", "event_key", "team")) %>%
    left_join(played_set, by = c("gsis_id", "event_key", "team")) %>%
    mutate(
      is_qualified_absence = coalesce(is_qualified_absence, FALSE),
      is_participation = coalesce(is_participation, FALSE)
    ) %>%
    arrange(gsis_id, event_key)

  players <- split(timeline, timeline$gsis_id)
  episode_rows <- vector("list", length(players))

  for (i in seq_along(players)) {
    tl <- players[[i]]
    gid <- names(players)[i]
    n <- nrow(tl)
    episode_id <- NA_character_
    episode_idx <- 0L
    out_rows <- vector("list", n)
    k <- 0L

    for (r in seq_len(n)) {
      team_changed <- r > 1 && tl$team[r] != tl$team[r - 1]
      if (team_changed && !is.na(episode_id)) {
        # close the prior episode (no trailing return row available across
        # a team change -- the episode simply ends there, tagged so it is
        # never mistaken for a real return)
        if (k >= 1 && out_rows[[k]]$absence_episode_id == episode_id) {
          out_rows[[k]]$episode_end_reason <- "TEAM_CHANGE"
        }
        episode_id <- NA_character_
        episode_idx <- 0L
      }

      if (tl$is_qualified_absence[r]) {
        if (is.na(episode_id)) {
          episode_id <- paste(gid, tl$team[r], tl$season[r], tl$week[r], sep = ":")
          episode_idx <- 1L
          state <- "EPISODE_ONSET"
        } else {
          episode_idx <- episode_idx + 1L
          state <- "EPISODE_CONTINUATION"
        }
        k <- k + 1L
        out_rows[[k]] <- data.table(
          gsis_id = gid, team = tl$team[r], season = tl$season[r], week = tl$week[r],
          absence_episode_id = episode_id, episode_game_index = episode_idx, episode_state = state,
          episode_end_reason = NA_character_
        )
      } else if (tl$is_participation[r]) {
        if (!is.na(episode_id)) {
          k <- k + 1L
          out_rows[[k]] <- data.table(
            gsis_id = gid, team = tl$team[r], season = tl$season[r], week = tl$week[r],
            absence_episode_id = episode_id, episode_game_index = NA_integer_, episode_state = "EPISODE_RETURN",
            episode_end_reason = "RETURN"
          )
          # mark the reason on the LAST absence row of that episode too
          if (k >= 2 && out_rows[[k - 1]]$absence_episode_id == episode_id) {
            out_rows[[k - 1]]$episode_end_reason <- "RETURN"
          }
        }
        episode_id <- NA_character_
        episode_idx <- 0L
      } else {
        # neither participation nor qualified absence this week -- close any
        # open episode as CENSORED_UNKNOWN (conservative; see file header)
        if (!is.na(episode_id) && k >= 1 && out_rows[[k]]$absence_episode_id == episode_id) {
          out_rows[[k]]$episode_end_reason <- "CENSORED_UNKNOWN"
        }
        episode_id <- NA_character_
        episode_idx <- 0L
      }
    }
    # if the timeline ends while an episode is still open, mark SEASON_END
    if (!is.na(episode_id) && k >= 1 && out_rows[[k]]$absence_episode_id == episode_id && is.na(out_rows[[k]]$episode_end_reason)) {
      out_rows[[k]]$episode_end_reason <- "SEASON_END"
    }
    episode_rows[[i]] <- rbindlist(out_rows[seq_len(k)])
  }
  rbindlist(episode_rows)
}

# ---------------------------------------------------------------------------
# episode_summary(): one row per absence_episode_id -- length, onset
# (season,week,team,gsis_id), end reason. Used for reporting (spec §66)
# and for the onset-vs-continuation split (spec §7).
# ---------------------------------------------------------------------------
episode_summary <- function(episodes) {
  absence_rows <- episodes[episode_state %in% c("EPISODE_ONSET", "EPISODE_CONTINUATION")]
  absence_rows[, .(
    gsis_id = gsis_id[1], team = team[1],
    onset_season = season[which(episode_state == "EPISODE_ONSET")][1],
    onset_week = week[which(episode_state == "EPISODE_ONSET")][1],
    n_games = .N,
    end_reason = episode_end_reason[which(!is.na(episode_end_reason))][1]
  ), by = absence_episode_id]
}
