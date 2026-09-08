# ===========================================================================
# Player x Scheme Intelligence — Tier B: charting-dependent profiles
# (spec §6, §7, §8, §9, §10, §12, §13, §14, §15, §16, §31, §36).
#
# Sources: nflverse participation (man/zone, coverage family, targeted route,
# was_pressure, number_of_pass_rushers, time_to_throw, formation, box) and FTN
# charting (play-action, motion, RPO, screen, out-of-pocket, read_thrown).
#
# HARD RULES:
#   * Nothing here is LIVE_CAPABLE for 2026. participation families are
#     PRIOR_ONLY; FTN families are DESCRIPTIVE_ONLY (never a predictive input).
#   * Uncharted plays NEVER become ZONE / MAN / FALSE / a box bucket (spec §5,§23).
#   * Denominators are CHARTED plays, exposed alongside eligible plays and the
#     coverage rate (spec §5). Percentages are never over total plays.
#   * exposure (how often faced) / tendency (what he did) / efficiency (how well)
#     are kept as separate fields (spec §6, §7).
#   * participation `route` is the TARGETED route only — this is a target-only
#     dataset and cannot support routes-run / YPRR (spec §10).
# ===========================================================================

suppressWarnings(suppressMessages({ library(dplyr); library(tidyr); library(stringr) }))

# ---- join charting sources onto the pbp dropback / rush spine ----------
# one row per play; charted-ness flags are explicit per family.
psi_charting_plays <- function(pbp, participation, ftn, PSI, cuts = c(short_hi = 10, int_hi = 20)) {
  spine <- pbp %>%
    filter(season_type == "REG") %>%
    transmute(
      game_id, play_id, season, week,
      posteam = toupper(posteam), defteam = toupper(defteam),
      passer_player_id, receiver_player_id, rusher_player_id,
      qb_dropback = coalesce(qb_dropback, 0),
      pass_attempt = coalesce(pass_attempt, 0),
      rush_attempt = coalesce(rush_attempt, 0),
      sack = coalesce(sack, 0), qb_scramble = coalesce(qb_scramble, 0),
      qb_spike = coalesce(qb_spike, 0), qb_kneel = coalesce(qb_kneel, 0),
      two_point_attempt = coalesce(two_point_attempt, 0),
      complete = coalesce(complete_pass, 0),
      air_yards, yards_gained = coalesce(yards_gained, 0),
      yac = ifelse(complete_pass == 1, yards_after_catch, NA_real_),
      epa, success = coalesce(success, as.integer(epa > 0)),
      pass_td = coalesce(pass_touchdown, 0), rush_td = coalesce(rush_touchdown, 0),
      interception = coalesce(interception, 0), first_down = coalesce(first_down, 0),
      shotgun = coalesce(shotgun, 0),
      field_third = psi_field_third(pass_location),
      depth_bin = psi_depth_bin(air_yards, cuts)
    )

  part <- participation %>%
    transmute(
      game_id = nflverse_game_id, play_id,
      mz_raw = defense_man_zone_type,
      cov_raw = defense_coverage_type,
      route_raw = route,
      was_pressure,
      n_pass_rushers = number_of_pass_rushers,
      time_to_throw,
      offense_formation,
      defenders_in_box
    ) %>%
    mutate(
      man_zone = case_when(mz_raw == "MAN_COVERAGE" ~ "MAN",
                           mz_raw == "ZONE_COVERAGE" ~ "ZONE",
                           TRUE ~ NA_character_),
      coverage_family = case_when(
        is.na(cov_raw) | cov_raw == "" ~ NA_character_,
        cov_raw %in% PSI$COVERAGE_FAMILIES ~ cov_raw,
        cov_raw %in% PSI$COVERAGE_FAMILY_OTHER ~ "OTHER",
        TRUE ~ "OTHER"
      ),
      route = ifelse(is.na(route_raw) | route_raw == "", NA_character_, toupper(route_raw)),
      formation = ifelse(is.na(offense_formation) | offense_formation == "", NA_character_,
                         toupper(offense_formation))
    ) %>%
    select(game_id, play_id, man_zone, coverage_family, route, was_pressure,
           n_pass_rushers, time_to_throw, formation, defenders_in_box)

  f <- if (!is.null(ftn) && nrow(ftn) > 0) {
    ftn %>% transmute(
      game_id = nflverse_game_id, play_id = nflverse_play_id,
      ftn_charted = TRUE,
      is_motion, is_play_action, is_screen_pass, is_rpo, is_qb_out_of_pocket,
      is_no_huddle, is_throw_away, read_thrown,
      n_blitzers, ftn_n_pass_rushers = n_pass_rushers
    )
  } else {
    tibble(game_id = character(), play_id = numeric(), ftn_charted = logical())
  }

  spine %>%
    left_join(part, by = c("game_id", "play_id")) %>%
    left_join(f, by = c("game_id", "play_id")) %>%
    mutate(ftn_charted = coalesce(ftn_charted, FALSE))
}

# dropback universe for charting splits (documented denominator, spec §6):
#   qb_dropback==1 & qb_spike==0 & qb_kneel==0 & two_point_attempt==0 & !is.na(passer)
psi_charting_dropbacks <- function(cp) {
  cp %>% filter(qb_dropback == 1, qb_spike == 0, qb_kneel == 0,
                two_point_attempt == 0, !is.na(passer_player_id))
}
psi_charting_rushes <- function(cp) {
  cp %>% filter(rush_attempt == 1, qb_kneel == 0, qb_spike == 0,
                qb_scramble == 0, !is.na(rusher_player_id))
}

# ---- Tier B evidence class: sample AND coverage rate AND opp diversity ----
psi_tierb_evidence <- function(charted_n, coverage_rate, n_opp, thr, PSI) {
  base <- dplyr::case_when(
    is.na(charted_n) | charted_n < thr["insufficient"] ~ "INSUFFICIENT",
    charted_n < thr["weak"]                            ~ "WEAK",
    charted_n < thr["moderate"]                        ~ "MODERATE",
    TRUE                                               ~ "STRONG"
  )
  cap_cov <- !is.na(coverage_rate) & coverage_rate < PSI$TIERB_MIN_COVERAGE_RATE
  cap_opp <- !is.na(n_opp) & n_opp < PSI$TIERB_MIN_OPP_DIVERSITY
  out <- base
  out[cap_cov & out %in% c("STRONG", "MODERATE")] <- "WEAK"
  out[cap_opp] <- pmin_chr(out[cap_opp], "WEAK")
  out
}
pmin_chr <- function(x, cap) {
  ord <- c(INSUFFICIENT = 0, WEAK = 1, MODERATE = 2, STRONG = 3)
  ifelse(ord[x] > ord[cap], cap, x)
}

# efficiency block shared by the split builders
psi_eff_block <- function(df) {
  df %>% summarise(
    plays = n(),
    completion_pct = mean(complete[pass_attempt == 1], na.rm = TRUE),
    epa_per_play = mean(epa, na.rm = TRUE),
    success_rate = mean(success, na.rm = TRUE),
    air_yards = mean(air_yards, na.rm = TRUE),
    yac = mean(yac, na.rm = TRUE),
    explosive_rate = mean(yards_gained >= PSI_EXPL_PASS & complete == 1, na.rm = TRUE),
    sack_rate = mean(sack, na.rm = TRUE),
    scramble_rate = mean(qb_scramble, na.rm = TRUE),
    turnover_rate = mean(interception, na.rm = TRUE),
    td_rate = mean(pass_td, na.rm = TRUE),
    time_to_throw = mean(time_to_throw, na.rm = TRUE),
    n_opp = n_distinct(defteam),
    .groups = "drop"
  )
}
PSI_EXPL_PASS <- 16

# =========================================================================
# QB COVERAGE PROFILE (man/zone primary + families) — spec §7, §9
# exposure = man/zone dropbacks; tendency = depth/direction dist; efficiency = EPA etc.
# =========================================================================
psi_qb_coverage_profile <- function(db, PSI, first_season = 2018L) {
  db <- db %>% filter(season >= first_season)
  tot <- db %>% group_by(gsis_id = passer_player_id) %>%
    summarise(dropbacks_eligible = n(),
              dropbacks_charted_mz = sum(!is.na(man_zone)),
              coverage_rate_mz = mean(!is.na(man_zone)),
              man_dropbacks = sum(man_zone == "MAN", na.rm = TRUE),
              zone_dropbacks = sum(man_zone == "ZONE", na.rm = TRUE),
              .groups = "drop") %>%
    mutate(man_share_charted = man_dropbacks / pmax(dropbacks_charted_mz, 1),
           zone_share_charted = zone_dropbacks / pmax(dropbacks_charted_mz, 1))
  mz <- db %>% filter(!is.na(man_zone)) %>%
    group_by(gsis_id = passer_player_id, bucket = man_zone) %>%
    group_modify(~ {
      e <- psi_eff_block(.x)
      dep <- .x %>% filter(!is.na(depth_bin))
      e$deep_share <- mean(dep$depth_bin == "DEEP")
      e$intermediate_share <- mean(dep$depth_bin == "INTERMEDIATE")
      e$short_share <- mean(dep$depth_bin == "SHORT")
      e$behind_los_share <- mean(dep$depth_bin == "BEHIND_LOS")
      dd <- .x %>% filter(!is.na(field_third))
      e$middle_share <- mean(dd$field_third == "MIDDLE")
      e
    }) %>% ungroup() %>%
    left_join(tot %>% select(gsis_id, coverage_rate_mz), by = "gsis_id") %>%
    mutate(evidence_class = psi_tierb_evidence(plays, coverage_rate_mz, n_opp,
                                               PSI$TIERB_EVIDENCE$coverage_split, PSI),
           availability = "PRIOR_ONLY", source = "participation", family = "qb_coverage")
  fam <- db %>% filter(!is.na(coverage_family)) %>%
    group_by(gsis_id = passer_player_id, bucket = coverage_family) %>%
    group_modify(~ psi_eff_block(.x)) %>% ungroup() %>%
    left_join(tot %>% select(gsis_id, coverage_rate_mz), by = "gsis_id") %>%
    mutate(evidence_class = psi_tierb_evidence(plays, coverage_rate_mz, n_opp,
                                               PSI$TIERB_EVIDENCE$coverage_split, PSI),
           availability = "PRIOR_ONLY", source = "participation", family = "qb_coverage_family")
  list(totals = tot, man_zone = mz, family = fam)
}

# =========================================================================
# QB PRESSURE PROFILE — spec §7, §8. pressure != blitz.
# =========================================================================
psi_qb_pressure_profile <- function(db, PSI, first_season = 2016L) {
  db <- db %>% filter(season >= first_season)
  tot <- db %>% group_by(gsis_id = passer_player_id) %>%
    summarise(dropbacks_eligible = n(),
              dropbacks_charted_pressure = sum(!is.na(was_pressure)),
              pressure_rate_faced = mean(was_pressure, na.rm = TRUE),
              coverage_rate_pressure = mean(!is.na(was_pressure)),
              dropbacks_charted_rushers = sum(!is.na(n_pass_rushers)),
              .groups = "drop")
  st <- db %>% filter(!is.na(was_pressure)) %>%
    mutate(state = ifelse(was_pressure, "PRESSURED", "CLEAN")) %>%
    group_by(gsis_id = passer_player_id, bucket = state) %>%
    group_modify(~ psi_eff_block(.x)) %>% ungroup() %>%
    left_join(tot %>% select(gsis_id, coverage_rate_pressure), by = "gsis_id") %>%
    mutate(evidence_class = psi_tierb_evidence(plays, coverage_rate_pressure, n_opp,
                                               PSI$TIERB_EVIDENCE$pressure_split, PSI),
           availability = "PRIOR_ONLY", source = "participation", family = "qb_pressure")
  list(totals = tot, states = st)
}

# =========================================================================
# QB PASS-RUSHER-COUNT PROFILE — spec §8. participation number_of_pass_rushers.
# "blitz (5+)" is a PROXY, labelled as such; FTN n_blitzers kept separate.
# =========================================================================
psi_qb_rusher_count_profile <- function(db, PSI, first_season = 2016L) {
  db <- db %>% filter(season >= first_season, !is.na(n_pass_rushers))
  bucketize <- function(n) dplyr::case_when(
    n < 4 ~ "LT4", n == 4 ~ "FOUR", n == 5 ~ "FIVE", n >= 6 ~ "SIXPLUS", TRUE ~ NA_character_)
  cov <- db %>% group_by(gsis_id = passer_player_id) %>%
    summarise(coverage_rate_rushers = n() / n(), .groups = "drop") %>% mutate(coverage_rate_rushers = 1)
  out <- db %>% mutate(bucket = bucketize(n_pass_rushers)) %>% filter(!is.na(bucket)) %>%
    group_by(gsis_id = passer_player_id, bucket) %>%
    group_modify(~ psi_eff_block(.x)) %>% ungroup() %>%
    group_by(gsis_id) %>% mutate(rusher_share = plays / sum(plays)) %>% ungroup() %>%
    mutate(evidence_class = psi_tierb_evidence(plays, 1, n_opp,
                                               PSI$TIERB_EVIDENCE$pressure_split, PSI),
           availability = "PRIOR_ONLY", source = "participation",
           family = "qb_rusher_count",
           note = "5+ = blitz PROXY (rusher count, not charted blitzer identity)")
  out
}

# =========================================================================
# QB FORMATION PROFILE — spec §12. participation offense_formation.
# (shotgun rate is also natively in pbp = LIVE_CAPABLE; noted in manifest.)
# =========================================================================
psi_qb_formation_profile <- function(db, PSI, first_season = 2016L) {
  db <- db %>% filter(season >= first_season, !is.na(formation))
  db %>% group_by(gsis_id = passer_player_id, bucket = formation) %>%
    group_modify(~ psi_eff_block(.x)) %>% ungroup() %>%
    group_by(gsis_id) %>% mutate(formation_share = plays / sum(plays)) %>% ungroup() %>%
    mutate(evidence_class = psi_tierb_evidence(plays, 1, n_opp,
                                               PSI$TIERB_EVIDENCE$concept, PSI),
           availability = "PRIOR_ONLY", source = "participation", family = "qb_formation")
}

# =========================================================================
# QB CONCEPT PROFILE (FTN) — spec §12. DESCRIPTIVE_ONLY. frequency + efficiency.
# =========================================================================
psi_qb_concept_profile <- function(db, PSI, first_season = 2022L) {
  db <- db %>% filter(season >= first_season, ftn_charted)
  concepts <- list(
    play_action = "is_play_action", motion = "is_motion", no_huddle = "is_no_huddle",
    rpo = "is_rpo", screen = "is_screen_pass", out_of_pocket = "is_qb_out_of_pocket",
    throwaway = "is_throw_away"
  )
  bind_rows(lapply(names(concepts), function(cn) {
    col <- concepts[[cn]]
    db %>% filter(!is.na(.data[[col]])) %>%
      group_by(gsis_id = passer_player_id) %>%
      group_modify(~ {
        on <- .x %>% filter(.data[[col]])
        e <- psi_eff_block(on)
        e$concept <- cn
        e$frequency <- mean(.x[[col]])
        e$plays_with_concept <- nrow(on)
        e$charted_plays <- nrow(.x)
        e
      }) %>% ungroup()
  })) %>%
    mutate(evidence_class = psi_tierb_evidence(plays_with_concept, 1, n_opp,
                                               PSI$TIERB_EVIDENCE$concept, PSI),
           availability = "DESCRIPTIVE_ONLY", source = "ftn", family = "qb_concepts")
}

# =========================================================================
# QB PROGRESSION PROFILE (FTN read_thrown) — spec §13. DESCRIPTIVE_ONLY.
# =========================================================================
psi_qb_progression_profile <- function(db, PSI, first_season = 2022L) {
  db <- db %>% filter(season >= first_season, ftn_charted, !is.na(read_thrown), read_thrown != "")
  relabel <- c("0" = "PRE_SNAP_OR_ZERO", "1" = "FIRST_READ", "2" = "SECOND_READ",
               "CHK" = "CHECKDOWN", "DES" = "DESIGNED", "SD" = "SCRAMBLE_DRILL")
  db %>% mutate(bucket = ifelse(read_thrown %in% names(relabel), relabel[read_thrown], "OTHER")) %>%
    group_by(gsis_id = passer_player_id, bucket) %>%
    group_modify(~ {
      e <- psi_eff_block(.x)
      dep <- .x %>% filter(!is.na(depth_bin))
      e$deep_share <- mean(dep$depth_bin == "DEEP")
      e$behind_los_share <- mean(dep$depth_bin == "BEHIND_LOS")
      e
    }) %>% ungroup() %>%
    group_by(gsis_id) %>% mutate(read_share = plays / sum(plays)) %>% ungroup() %>%
    mutate(evidence_class = psi_tierb_evidence(plays, 1, n_opp,
                                               PSI$TIERB_EVIDENCE$concept, PSI),
           availability = "DESCRIPTIVE_ONLY", source = "ftn", family = "qb_progression")
}

# =========================================================================
# RECEIVER ROUTE PROFILE — spec §10. TARGETED route only (target-only source).
# =========================================================================
psi_receiver_route_profile <- function(cp, PSI, first_season = 2018L) {
  tgt <- cp %>% filter(pass_attempt == 1, !is.na(receiver_player_id), season >= first_season)
  tot <- tgt %>% group_by(gsis_id = receiver_player_id) %>%
    summarise(targets_eligible = n(),
              targets_charted_route = sum(!is.na(route)),
              route_coverage_rate = mean(!is.na(route)), .groups = "drop")
  by_route <- tgt %>% filter(!is.na(route)) %>%
    group_by(gsis_id = receiver_player_id, bucket = route) %>%
    summarise(targets = n(), receptions = sum(complete),
              catch_rate = mean(complete), yards_per_target = mean(yards_gained),
              air_yards = mean(air_yards, na.rm = TRUE), yac = mean(yac, na.rm = TRUE),
              epa_per_target = mean(epa, na.rm = TRUE), success_rate = mean(success),
              explosive_rate = mean(yards_gained >= PSI_EXPL_PASS & complete == 1),
              n_opp = n_distinct(defteam), .groups = "drop") %>%
    left_join(tot, by = "gsis_id") %>%
    group_by(gsis_id) %>%
    mutate(targeted_route_share = targets / sum(targets)) %>% ungroup() %>%
    mutate(evidence_class = psi_tierb_evidence(targets, route_coverage_rate, n_opp,
                                               PSI$TIERB_EVIDENCE$route_family, PSI),
           availability = "PRIOR_ONLY", source = "participation", family = "receiver_route",
           metric_note = "TARGETED route only. targeted_route_share is a share of TARGETS, not routes run. YPRR NOT computable from this source (spec §10).")
  list(totals = tot, routes = by_route)
}

# =========================================================================
# RECEIVER COVERAGE PROFILE — spec §12. vs man / zone.
# =========================================================================
psi_receiver_coverage_profile <- function(cp, PSI, first_season = 2018L) {
  tgt <- cp %>% filter(pass_attempt == 1, !is.na(receiver_player_id), season >= first_season)
  tot <- tgt %>% group_by(gsis_id = receiver_player_id) %>%
    summarise(targets_eligible = n(), targets_charted_mz = sum(!is.na(man_zone)),
              mz_coverage_rate = mean(!is.na(man_zone)), .groups = "drop")
  by_mz <- tgt %>% filter(!is.na(man_zone)) %>%
    group_by(gsis_id = receiver_player_id, bucket = man_zone) %>%
    summarise(targets = n(), catch_rate = mean(complete),
              yards_per_target = mean(yards_gained), air_yards = mean(air_yards, na.rm = TRUE),
              yac = mean(yac, na.rm = TRUE), epa_per_target = mean(epa, na.rm = TRUE),
              success_rate = mean(success),
              explosive_rate = mean(yards_gained >= PSI_EXPL_PASS & complete == 1),
              n_opp = n_distinct(defteam), .groups = "drop") %>%
    left_join(tot, by = "gsis_id") %>%
    group_by(gsis_id) %>% mutate(target_share_vs_bucket = targets / sum(targets)) %>% ungroup() %>%
    mutate(evidence_class = psi_tierb_evidence(targets, mz_coverage_rate, n_opp,
                                               PSI$TIERB_EVIDENCE$coverage_split, PSI),
           availability = "PRIOR_ONLY", source = "participation", family = "receiver_coverage")
  list(totals = tot, man_zone = by_mz)
}

# =========================================================================
# RB BOX PROFILE — spec §14. defenders_in_box buckets. Box != front scheme.
# =========================================================================
psi_rb_box_profile <- function(rush, PSI, cutdef = PSI$BOX_BUCKETS, first_season = 2016L) {
  rush <- rush %>% filter(season >= first_season, !is.na(defenders_in_box))
  light_hi <- cutdef$LIGHT[2]; heavy_lo <- cutdef$HEAVY[1]
  buck <- function(b) dplyr::case_when(b < light_hi ~ "LIGHT", b >= heavy_lo ~ "HEAVY", TRUE ~ "NEUTRAL")
  tot <- rush %>% group_by(gsis_id = rusher_player_id) %>%
    summarise(carries_eligible = n(), box_coverage_rate = 1,
              mean_box_faced = mean(defenders_in_box), .groups = "drop")
  by_box <- rush %>% mutate(bucket = buck(defenders_in_box)) %>%
    group_by(gsis_id = rusher_player_id, bucket) %>%
    summarise(carries = n(), yards_per_carry = mean(yards_gained),
              epa_per_rush = mean(epa, na.rm = TRUE), success_rate = mean(success),
              explosive_rate = mean(yards_gained >= 12), stuff_rate = mean(yards_gained <= 0),
              td_rate = mean(rush_td), n_opp = n_distinct(defteam), .groups = "drop") %>%
    left_join(tot, by = "gsis_id") %>%
    group_by(gsis_id) %>% mutate(box_share = carries / sum(carries)) %>% ungroup() %>%
    mutate(evidence_class = psi_tierb_evidence(carries, 1, n_opp,
                                               PSI$TIERB_EVIDENCE$box_bucket, PSI),
           availability = "PRIOR_ONLY", source = "participation", family = "rb_box")
  list(totals = tot, boxes = by_box)
}
