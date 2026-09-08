# ===========================================================================
# Player x Scheme Intelligence — Tier A: PBP-only spatial profiles (spec §4,5,
# §10, §13, §17, §18). LIVE_CAPABLE. No charting dependency.
#
# Pure, deterministic, chronology-safe functions. Every denominator is
# documented inline (spec §41). Missing location NEVER becomes MIDDLE; missing
# air_yards NEVER becomes SHORT (spec §41, §43 case 28-29). Sacks / spikes /
# kneels / scrambles / 2-pt are handled per the documented universe below.
# ===========================================================================

suppressWarnings(suppressMessages({ library(dplyr); library(tidyr); library(stringr) }))

# ---- depth bin from air_yards (spec §4 candidate cut points) -------------
psi_depth_bin <- function(air_yards, cuts = c(short_hi = 10, int_hi = 20)) {
  out <- rep(NA_character_, length(air_yards))
  ok <- !is.na(air_yards)
  out[ok & air_yards < 0]                                   <- "BEHIND_LOS"
  out[ok & air_yards >= 0 & air_yards < cuts["short_hi"]]   <- "SHORT"
  out[ok & air_yards >= cuts["short_hi"] & air_yards < cuts["int_hi"]] <- "INTERMEDIATE"
  out[ok & air_yards >= cuts["int_hi"]]                     <- "DEEP"
  factor(out, levels = c("BEHIND_LOS", "SHORT", "INTERMEDIATE", "DEEP"))
}

psi_field_third <- function(loc) {
  x <- toupper(as.character(loc))
  x[!x %in% c("LEFT", "MIDDLE", "RIGHT")] <- NA_character_
  factor(x, levels = c("LEFT", "MIDDLE", "RIGHT"))
}

# =========================================================================
# 1. Play-level normalized pass dataset (spec §39 "play-level normalized").
#
# PASS-ATTEMPT UNIVERSE (documented denominator, spec §41):
#   play_type == "pass"           -- a real pass was attempted
#   AND sack == 0                 -- sacks are NOT attempts; kept separately
#   AND qb_spike == 0             -- spikes excluded entirely (spec §41)
#   AND two_point_attempt == 0    -- 2-pt conversions excluded (different value model)
#   AND season_type == "REG"      -- regular season only for tendency stability
#   AND !is.na(passer_player_id)
# A "throwaway"/batted ball with no location IS a pass attempt: it stays in the
# attempt denominator but, having pass_location / air_yards == NA, it lands in
# NO matrix cell (attempts_uncharted) -- it is never reassigned (spec §41).
# =========================================================================
psi_pass_plays <- function(pbp, cuts = c(short_hi = 10, int_hi = 20)) {
  pbp %>%
    filter(season_type == "REG", play_type == "pass",
           sack == 0, qb_spike == 0, coalesce(two_point_attempt, 0) == 0,
           !is.na(passer_player_id)) %>%
    transmute(
      game_id, season, week,
      posteam = toupper(posteam), defteam = toupper(defteam),
      passer_player_id, receiver_player_id,
      air_yards,
      field_third = psi_field_third(pass_location),
      depth_bin   = psi_depth_bin(air_yards, cuts),
      charted     = !is.na(field_third) & !is.na(depth_bin),
      complete    = coalesce(complete_pass, 0),
      yards_gained = coalesce(yards_gained, 0),
      yac         = ifelse(complete_pass == 1, yards_after_catch, NA_real_),
      epa,
      success     = coalesce(success, as.integer(epa > 0)),
      pass_td     = coalesce(pass_touchdown, 0),
      interception = coalesce(interception, 0),
      first_down  = coalesce(first_down, 0),
      explosive   = as.integer(complete_pass == 1 & yards_gained >= 16)
    )
}

# =========================================================================
# 2. Play-level normalized rush dataset.
#
# DESIGNED-RUSH UNIVERSE (documented denominator):
#   play_type == "run" AND qb_kneel == 0 AND qb_spike == 0
#   AND coalesce(qb_scramble,0) == 0   -- scrambles are QB dropback plays, not
#                                          designed runs; excluded from RB + team
#                                          rush spatial (spec §13)
#   AND season_type == "REG" AND !is.na(rusher_player_id)
# run_location / run_gap are ALREADY from the offense's perspective in nflverse
# (left = offense's left hand). No mirroring is applied (spec §42).
# Missing run_location -> NO cell (never MIDDLE).
# =========================================================================
psi_rush_plays <- function(pbp) {
  pbp %>%
    filter(season_type == "REG", play_type == "run",
           coalesce(qb_kneel, 0) == 0, coalesce(qb_spike, 0) == 0,
           coalesce(qb_scramble, 0) == 0, !is.na(rusher_player_id)) %>%
    transmute(
      game_id, season, week,
      posteam = toupper(posteam), defteam = toupper(defteam),
      rusher_player_id,
      field_third = psi_field_third(run_location),
      run_gap = { g <- toupper(as.character(run_gap)); g[!g %in% c("END","TACKLE","GUARD")] <- NA; g },
      charted = !is.na(psi_field_third(run_location)),
      yards_gained = coalesce(yards_gained, 0),
      epa,
      success = coalesce(success, as.integer(epa > 0)),
      rush_td = coalesce(rush_touchdown, 0),
      first_down = coalesce(first_down, 0),
      explosive = as.integer(yards_gained >= 12),
      stuffed = as.integer(yards_gained <= 0)
    )
}

# ---- as-of filter (chronology-safe, spec §30, §41) --------------------
psi_asof <- function(df, season, week) {
  df %>% filter(season < !!season | (season == !!season & week <= !!week))
}

# ---- evidence class from a sample count + threshold vector ------------
psi_evidence <- function(n, thr) {
  dplyr::case_when(
    is.na(n) | n < thr["insufficient"] ~ "INSUFFICIENT",
    n < thr["weak"]                    ~ "WEAK",
    n < thr["moderate"]                ~ "MODERATE",
    TRUE                               ~ "STRONG"
  )
}

# ---- shrink a cell mean toward a fallback mean (spec §25) -------------
psi_shrink <- function(cell_mean, cell_n, fallback_mean, k) {
  w <- cell_n / (cell_n + k)
  ifelse(is.na(cell_mean), fallback_mean, w * cell_mean + (1 - w) * fallback_mean)
}

# =========================================================================
# 3. QB spatial matrix + directional/depth marginals (spec §4, §5)
#    entity = passer_player_id. One block per (player, window).
# =========================================================================
psi_qb_matrix <- function(pass, PSI, thr_name = "qb_cell_attempts", k_name = "qb_cell") {
  thr <- PSI$EVIDENCE_THRESHOLDS[[thr_name]]; k <- PSI$SHRINK_K[[k_name]]
  charted <- pass %>% filter(charted)
  tot <- pass %>% group_by(gsis_id = passer_player_id) %>%
    summarise(attempts_total = n(),
              attempts_charted = sum(charted),
              attempts_uncharted = sum(!charted),
              epa_overall = mean(epa, na.rm = TRUE),
              .groups = "drop")
  cells <- charted %>%
    group_by(gsis_id = passer_player_id, depth_bin, field_third, .drop = FALSE) %>%
    summarise(
      attempts = n(),
      completions = sum(complete),
      completion_pct = ifelse(n() > 0, mean(complete), NA_real_),
      air_yards = mean(air_yards, na.rm = TRUE),
      yards_per_attempt = mean(yards_gained),
      epa_per_attempt_raw = mean(epa, na.rm = TRUE),
      success_rate = mean(success),
      td_rate = mean(pass_td),
      int_rate = mean(interception),
      explosive_rate = mean(explosive),
      first_down_rate = mean(first_down),
      yac = mean(yac, na.rm = TRUE),
      .groups = "drop"
    ) %>%
    left_join(tot, by = "gsis_id") %>%
    mutate(
      attempt_share = ifelse(attempts_charted > 0, attempts / attempts_charted, NA_real_),
      epa_per_attempt = psi_shrink(epa_per_attempt_raw, attempts, epa_overall, k),
      evidence_class = psi_evidence(attempts, thr),
      output_class = "OBSERVED"
    )
  list(totals = tot, cells = cells)
}

# directional + depth marginals with vs-baseline deltas (spec §5)
psi_qb_directional <- function(pass, baseline_dir = NULL) {
  charted <- pass %>% filter(charted)
  by_player <- function(df, grp) df %>% group_by(gsis_id = passer_player_id) %>%
    summarise(n = sum(charted), .groups = "drop")
  d <- charted %>% group_by(gsis_id = passer_player_id) %>%
    summarise(
      n = n(),
      left_pct = mean(field_third == "LEFT"),
      middle_pct = mean(field_third == "MIDDLE"),
      right_pct = mean(field_third == "RIGHT"),
      behind_los_pct = mean(depth_bin == "BEHIND_LOS"),
      short_pct = mean(depth_bin == "SHORT"),
      intermediate_pct = mean(depth_bin == "INTERMEDIATE"),
      deep_pct = mean(depth_bin == "DEEP"),
      deep_left_pct = mean(depth_bin == "DEEP" & field_third == "LEFT"),
      deep_middle_pct = mean(depth_bin == "DEEP" & field_third == "MIDDLE"),
      deep_right_pct = mean(depth_bin == "DEEP" & field_third == "RIGHT"),
      intermediate_middle_pct = mean(depth_bin == "INTERMEDIATE" & field_third == "MIDDLE"),
      short_middle_pct = mean(depth_bin == "SHORT" & field_third == "MIDDLE"),
      .groups = "drop"
    )
  if (!is.null(baseline_dir)) {
    bcols <- setdiff(names(baseline_dir), c("gsis_id", "n"))
    for (c in bcols) d[[paste0(c, "_vs_league")]] <- d[[c]] - baseline_dir[[c]][1]
  }
  d
}

# =========================================================================
# 4. Receiver spatial profile (spec §10). entity = receiver_player_id.
#    Cells are the THROW's location/depth (where he is targeted), NOT alignment.
# =========================================================================
psi_receiver_matrix <- function(pass, PSI) {
  thr <- PSI$EVIDENCE_THRESHOLDS[["qb_cell_attempts"]]; k <- PSI$SHRINK_K[["qb_cell"]]
  tgt <- pass %>% filter(!is.na(receiver_player_id))
  charted <- tgt %>% filter(charted)
  tot <- tgt %>% group_by(gsis_id = receiver_player_id) %>%
    summarise(targets_total = n(), targets_charted = sum(charted),
              targets_uncharted = sum(!charted), epa_overall = mean(epa, na.rm = TRUE),
              .groups = "drop")
  cells <- charted %>%
    group_by(gsis_id = receiver_player_id, depth_bin, field_third, .drop = FALSE) %>%
    summarise(
      targets = n(), receptions = sum(complete),
      catch_rate = ifelse(n() > 0, mean(complete), NA_real_),
      air_yards = mean(air_yards, na.rm = TRUE),
      yards_per_target = mean(yards_gained),
      epa_per_target_raw = mean(epa, na.rm = TRUE),
      success_rate = mean(success), td_rate = mean(pass_td),
      explosive_rate = mean(explosive), first_down_rate = mean(first_down),
      yac = mean(yac, na.rm = TRUE), .groups = "drop"
    ) %>%
    left_join(tot, by = "gsis_id") %>%
    mutate(target_share_of_self = ifelse(targets_charted > 0, targets / targets_charted, NA_real_),
           epa_per_target = psi_shrink(epa_per_target_raw, targets, epa_overall, k),
           evidence_class = psi_evidence(targets, thr), output_class = "OBSERVED")
  list(totals = tot, cells = cells)
}

# =========================================================================
# 5. RB rushing spatial profile (spec §13). Direction + gap ONLY. Never
#    relabeled zone/gap/power/counter (spec §13).
# =========================================================================
psi_rb_rush_matrix <- function(rush, PSI) {
  thr <- PSI$EVIDENCE_THRESHOLDS[["rb_direction_rush"]]; k <- PSI$SHRINK_K[["rush_dir"]]
  charted <- rush %>% filter(charted)
  tot <- rush %>% group_by(gsis_id = rusher_player_id) %>%
    summarise(carries_total = n(), carries_charted = sum(charted),
              carries_uncharted = sum(!charted), epa_overall = mean(epa, na.rm = TRUE),
              .groups = "drop")
  dir_cells <- charted %>%
    group_by(gsis_id = rusher_player_id, field_third, .drop = FALSE) %>%
    summarise(carries = n(), yards_per_carry = mean(yards_gained),
              epa_per_rush_raw = mean(epa, na.rm = TRUE), success_rate = mean(success),
              explosive_rate = mean(explosive), stuff_rate = mean(stuffed),
              td_rate = mean(rush_td), first_down_rate = mean(first_down), .groups = "drop") %>%
    left_join(tot, by = "gsis_id") %>%
    mutate(carry_share = ifelse(carries_charted > 0, carries / carries_charted, NA_real_),
           epa_per_rush = psi_shrink(epa_per_rush_raw, carries, epa_overall, k),
           evidence_class = psi_evidence(carries, thr), output_class = "OBSERVED")
  gap_cells <- charted %>% filter(!is.na(run_gap)) %>%
    group_by(gsis_id = rusher_player_id, run_gap) %>%
    summarise(carries = n(), yards_per_carry = mean(yards_gained),
              epa_per_rush_raw = mean(epa, na.rm = TRUE), success_rate = mean(success),
              explosive_rate = mean(explosive), stuff_rate = mean(stuffed), .groups = "drop") %>%
    left_join(tot %>% select(gsis_id, epa_overall), by = "gsis_id") %>%
    mutate(epa_per_rush = psi_shrink(epa_per_rush_raw, carries, epa_overall, PSI$SHRINK_K[["rush_dir"]]),
           evidence_class = psi_evidence(carries, PSI$EVIDENCE_THRESHOLDS[["rb_direction_rush"]]),
           output_class = "OBSERVED")
  list(totals = tot, direction = dir_cells, gap = gap_cells)
}

# =========================================================================
# 6. Defense PASS vulnerability matrix (spec §18). group = defteam.
#    Same depth x third grid so QB/receiver profiles can be matched directly.
# =========================================================================
psi_def_pass_matrix <- function(pass, PSI) {
  thr <- PSI$EVIDENCE_THRESHOLDS[["coverage_split"]]
  charted <- pass %>% filter(charted)
  tot <- pass %>% group_by(team = defteam) %>%
    summarise(targets_faced = n(), targets_charted = sum(charted), .groups = "drop")
  cells <- charted %>%
    group_by(team = defteam, depth_bin, field_third, .drop = FALSE) %>%
    summarise(
      targets_allowed = n(),
      target_share_allowed = NA_real_,  # filled below
      completion_pct_allowed = mean(complete),
      epa_per_target_allowed = mean(epa, na.rm = TRUE),
      success_rate_allowed = mean(success),
      yards_per_target_allowed = mean(yards_gained),
      explosive_rate_allowed = mean(explosive),
      td_rate_allowed = mean(pass_td),
      int_rate_generated = mean(interception),
      .groups = "drop"
    ) %>%
    left_join(tot, by = "team") %>%
    mutate(target_share_allowed = ifelse(targets_charted > 0, targets_allowed / targets_charted, NA_real_),
           evidence_class = psi_evidence(targets_allowed, thr), output_class = "OBSERVED")
  list(totals = tot, cells = cells)
}

# =========================================================================
# 7. Defense RUSH spatial profile (spec §17). group = defteam, all designed runs.
# =========================================================================
psi_def_rush_profile <- function(rush, PSI) {
  thr <- PSI$EVIDENCE_THRESHOLDS[["rb_direction_rush"]]
  charted <- rush %>% filter(charted)
  tot <- rush %>% group_by(team = defteam) %>%
    summarise(carries_faced = n(), carries_charted = sum(charted), .groups = "drop")
  dir <- charted %>% group_by(team = defteam, field_third, .drop = FALSE) %>%
    summarise(carries_allowed = n(), yards_per_carry_allowed = mean(yards_gained),
              epa_per_rush_allowed = mean(epa, na.rm = TRUE), success_rate_allowed = mean(success),
              explosive_rate_allowed = mean(explosive), stuff_rate_generated = mean(stuffed),
              .groups = "drop") %>%
    left_join(tot, by = "team") %>%
    mutate(carry_share_allowed = ifelse(carries_charted > 0, carries_allowed / carries_charted, NA_real_),
           evidence_class = psi_evidence(carries_allowed, thr), output_class = "OBSERVED")
  gap <- charted %>% filter(!is.na(run_gap)) %>%
    group_by(team = defteam, run_gap) %>%
    summarise(carries_allowed = n(), yards_per_carry_allowed = mean(yards_gained),
              epa_per_rush_allowed = mean(epa, na.rm = TRUE), success_rate_allowed = mean(success),
              explosive_rate_allowed = mean(explosive), .groups = "drop") %>%
    mutate(evidence_class = psi_evidence(carries_allowed, thr), output_class = "OBSERVED")
  list(totals = tot, direction = dir, gap = gap)
}

# ---- league/position baseline matrix (spec §5) -----------------------
# pooled over ALL QBs / receivers / RBs as-of; per-cell mean of the same stats.
psi_pooled_pass_matrix <- function(pass) {
  pass %>% filter(charted) %>%
    group_by(depth_bin, field_third, .drop = FALSE) %>%
    summarise(attempt_share = n() / nrow(filter(pass, charted)),
              completion_pct = mean(complete), air_yards = mean(air_yards, na.rm = TRUE),
              yards_per_attempt = mean(yards_gained), epa_per_attempt = mean(epa, na.rm = TRUE),
              success_rate = mean(success), td_rate = mean(pass_td), int_rate = mean(interception),
              explosive_rate = mean(explosive), first_down_rate = mean(first_down),
              yac = mean(yac, na.rm = TRUE), .groups = "drop")
}
psi_pooled_directional <- function(pass) {
  c <- pass %>% filter(charted)
  tibble(
    gsis_id = "__LEAGUE_QB__", n = nrow(c),
    left_pct = mean(c$field_third == "LEFT"), middle_pct = mean(c$field_third == "MIDDLE"),
    right_pct = mean(c$field_third == "RIGHT"),
    behind_los_pct = mean(c$depth_bin == "BEHIND_LOS"), short_pct = mean(c$depth_bin == "SHORT"),
    intermediate_pct = mean(c$depth_bin == "INTERMEDIATE"), deep_pct = mean(c$depth_bin == "DEEP"),
    deep_left_pct = mean(c$depth_bin == "DEEP" & c$field_third == "LEFT"),
    deep_middle_pct = mean(c$depth_bin == "DEEP" & c$field_third == "MIDDLE"),
    deep_right_pct = mean(c$depth_bin == "DEEP" & c$field_third == "RIGHT"),
    intermediate_middle_pct = mean(c$depth_bin == "INTERMEDIATE" & c$field_third == "MIDDLE"),
    short_middle_pct = mean(c$depth_bin == "SHORT" & c$field_third == "MIDDLE")
  )
}
