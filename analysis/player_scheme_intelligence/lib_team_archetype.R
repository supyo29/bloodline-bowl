# ===========================================================================
# Player x Scheme Intelligence — Tier C: team offense/defense tendency profiles
# + numeric player/defense archetype vectors + scheme-era mechanism
# (spec §16, §17, §20, §21, §22).
#
# Team profiles here are DESCRIPTIVE TENDENCY primitives (formation mix, motion
# rate, PA rate, coverage tendency, box tendency, target-area / target-position
# distribution, rush direction/gap distribution). They deliberately do NOT
# duplicate or rewire the frozen Football Intelligence engine, which owns the
# opponent-adjusted MODELED EPA/PROE/pace/pressure/explosive/RZ ratings.
#
# Numeric archetype VECTORS are primary and always shipped. Archetype LABELS
# are optional and emitted only if a bootstrap stability check clears a bar
# (spec §21, §22) — otherwise the vector ships label-free.
# ===========================================================================

suppressWarnings(suppressMessages({ library(dplyr); library(tidyr) }))

# ---- team offense tendency profile (as-of, chronology-safe) -----------
psi_offense_team_profile <- function(cp, PSI, first_season_charting = 2018L) {
  db  <- psi_charting_dropbacks(cp)
  rush<- psi_charting_rushes(cp)
  pass_att <- cp %>% filter(pass_attempt == 1)

  by_team <- function(df) df %>% group_by(team = posteam)

  # pbp-derived (LIVE_CAPABLE) tendencies
  live <- by_team(cp %>% filter(pass_attempt == 1 | rush_attempt == 1)) %>%
    summarise(
      plays = n(),
      pass_rate = mean(pass_attempt == 1),
      shotgun_rate = mean(shotgun == 1, na.rm = TRUE),
      explosive_pass_rate = mean(pass_attempt == 1 & yards_gained >= 16 & complete == 1, na.rm = TRUE),
      .groups = "drop"
    ) %>% mutate(availability = "LIVE_CAPABLE")

  # target-area distribution (LIVE_CAPABLE, from pass_location/air_yards)
  ta <- pass_att %>% filter(!is.na(field_third), !is.na(depth_bin)) %>%
    by_team(.) %>%
    summarise(
      charted_pass = n(),
      tgt_left = mean(field_third == "LEFT"), tgt_middle = mean(field_third == "MIDDLE"),
      tgt_right = mean(field_third == "RIGHT"),
      tgt_behind_los = mean(depth_bin == "BEHIND_LOS"), tgt_short = mean(depth_bin == "SHORT"),
      tgt_intermediate = mean(depth_bin == "INTERMEDIATE"), tgt_deep = mean(depth_bin == "DEEP"),
      .groups = "drop"
    ) %>% mutate(availability = "LIVE_CAPABLE")

  # rush direction/gap distribution (LIVE_CAPABLE)
  ra <- rush %>% filter(!is.na(field_third)) %>% by_team(.) %>%
    summarise(charted_rush = n(),
              rush_left = mean(field_third == "LEFT"), rush_middle = mean(field_third == "MIDDLE"),
              rush_right = mean(field_third == "RIGHT"), .groups = "drop") %>%
    mutate(availability = "LIVE_CAPABLE")

  # charting-derived (PRIOR_ONLY): formation mix, motion, PA, RPO, screen
  form <- db %>% filter(!is.na(formation)) %>% by_team(.) %>%
    summarise(charted_formation = n(),
              form_shotgun = mean(formation == "SHOTGUN"),
              form_empty = mean(formation == "EMPTY"),
              form_under_center = mean(formation == "UNDER CENTER"),
              form_singleback = mean(formation == "SINGLEBACK"),
              form_i_form = mean(formation == "I_FORM"),
              form_pistol = mean(formation == "PISTOL"),
              .groups = "drop") %>% mutate(availability = "PRIOR_ONLY")

  ftn_t <- db %>% filter(ftn_charted) %>% by_team(.) %>%
    summarise(charted_ftn = n(),
              play_action_rate = mean(is_play_action, na.rm = TRUE),
              motion_rate = mean(is_motion, na.rm = TRUE),
              rpo_rate = mean(is_rpo, na.rm = TRUE),
              screen_rate = mean(is_screen_pass, na.rm = TRUE),
              no_huddle_rate = mean(is_no_huddle, na.rm = TRUE),
              .groups = "drop") %>% mutate(availability = "DESCRIPTIVE_ONLY")

  box_faced <- rush %>% filter(!is.na(defenders_in_box)) %>% by_team(.) %>%
    summarise(mean_box_faced = mean(defenders_in_box),
              light_box_rate = mean(defenders_in_box < 6.5),
              heavy_box_rate = mean(defenders_in_box >= 7.5), .groups = "drop") %>%
    mutate(availability = "PRIOR_ONLY")

  list(live = live, target_area = ta, rush_area = ra, formation = form,
       ftn = ftn_t, box_faced = box_faced)
}

# ---- team defense tendency / vulnerability profile -------------------
psi_defense_team_profile <- function(cp, PSI, first_season_charting = 2018L) {
  db  <- psi_charting_dropbacks(cp)
  rush<- psi_charting_rushes(cp)
  by_def <- function(df) df %>% group_by(team = defteam)

  live <- by_def(cp %>% filter(pass_attempt == 1 | rush_attempt == 1)) %>%
    summarise(plays_faced = n(),
              epa_per_play_allowed = mean(epa, na.rm = TRUE),
              success_allowed = mean(success, na.rm = TRUE),
              explosive_pass_allowed = mean(pass_attempt == 1 & yards_gained >= 16 & complete == 1, na.rm = TRUE),
              explosive_rush_allowed = mean(rush_attempt == 1 & yards_gained >= 12, na.rm = TRUE),
              .groups = "drop") %>% mutate(availability = "LIVE_CAPABLE")

  # man/zone + coverage-family TENDENCY (PRIOR_ONLY, first season 2018)
  cov <- db %>% filter(!is.na(man_zone)) %>% by_def(.) %>%
    summarise(charted_mz = n(),
              man_rate = mean(man_zone == "MAN"), zone_rate = mean(man_zone == "ZONE"),
              .groups = "drop") %>% mutate(availability = "PRIOR_ONLY")
  covfam <- db %>% filter(!is.na(coverage_family)) %>% by_def(.) %>%
    summarise(charted_cov = n(),
              cover_1 = mean(coverage_family == "COVER_1"),
              cover_2 = mean(coverage_family == "COVER_2"),
              cover_3 = mean(coverage_family == "COVER_3"),
              cover_4 = mean(coverage_family == "COVER_4"),
              cover_6 = mean(coverage_family == "COVER_6"),
              two_man = mean(coverage_family == "2_MAN"),
              cover_0 = mean(coverage_family == "COVER_0"),
              .groups = "drop") %>% mutate(availability = "PRIOR_ONLY")

  # pressure / blitz-proxy GENERATED (PRIOR_ONLY)
  press <- db %>% filter(!is.na(was_pressure)) %>% by_def(.) %>%
    summarise(charted_pressure = n(),
              pressure_rate_generated = mean(was_pressure),
              blitz_proxy_rate = mean(n_pass_rushers >= 5, na.rm = TRUE),
              pressure_without_heavy_blitz_rate = mean(was_pressure & coalesce(n_pass_rushers, 4) <= 4, na.rm = TRUE),
              .groups = "drop") %>% mutate(availability = "PRIOR_ONLY")

  box_gen <- rush %>% filter(!is.na(defenders_in_box)) %>% by_def(.) %>%
    summarise(mean_box_deployed = mean(defenders_in_box),
              heavy_box_rate = mean(defenders_in_box >= 7.5), .groups = "drop") %>%
    mutate(availability = "PRIOR_ONLY")

  list(live = live, man_zone = cov, coverage_family = covfam, pressure = press, box = box_gen)
}

# ---- numeric archetype vector assembly (spec §21) -------------------
# Interpretable features only, drawn from Tier A + Tier B served outputs.
psi_qb_archetype_vector <- function(qb_dir, qb_matrix, qb_press, qb_concept) {
  base <- qb_dir %>% filter(window == "career") %>%
    transmute(gsis_id, deep_rate = deep_pct, behind_los_rate = behind_los_pct,
              middle_rate = middle_pct, intermediate_middle_rate = intermediate_middle_pct)
  eff <- qb_matrix %>% filter(window == "career") %>%
    group_by(gsis_id) %>%
    summarise(deep_epa = mean(epa_per_attempt[depth_bin == "DEEP"], na.rm = TRUE),
              short_epa = mean(epa_per_attempt[depth_bin == "SHORT"], na.rm = TRUE),
              aDOT = weighted.mean(air_yards, attempts, na.rm = TRUE), .groups = "drop")
  press <- qb_press %>% filter(window == "career") %>%
    group_by(gsis_id) %>%
    summarise(pressure_epa_delta = epa_per_play[bucket == "PRESSURED"][1] - epa_per_play[bucket == "CLEAN"][1],
              pressure_scramble_rate = scramble_rate[bucket == "PRESSURED"][1], .groups = "drop")
  con <- qb_concept %>% filter(window == "career", concept == "play_action") %>%
    transmute(gsis_id, play_action_rate = frequency)
  base %>% left_join(eff, by = "gsis_id") %>% left_join(press, by = "gsis_id") %>%
    left_join(con, by = "gsis_id")
}

# bootstrap cluster stability (Adjusted Rand Index across resamples).
# Returns a label column ONLY when mean ARI >= threshold (spec §22).
psi_cluster_with_stability <- function(vec_df, k = 4, n_boot = 25, ari_min = 0.55, seed = 20260908L) {
  set.seed(seed)
  m <- vec_df %>% select(where(is.numeric)) %>% as.matrix()
  ok <- rowSums(!is.finite(m)) == 0
  m <- m[ok, , drop = FALSE]
  ids <- vec_df$gsis_id[ok]
  if (nrow(m) < k * 5) return(list(labels = NULL, mean_ari = NA_real_, note = "too few complete rows to cluster"))
  ms <- scale(m)
  base_km <- kmeans(ms, centers = k, nstart = 10, iter.max = 50)
  ari <- function(a, b) {
    tab <- table(a, b); n <- sum(tab)
    si <- sum(choose(tab, 2))
    a_i <- sum(choose(rowSums(tab), 2)); b_j <- sum(choose(colSums(tab), 2))
    exp <- a_i * b_j / choose(n, 2); mx <- (a_i + b_j) / 2
    if (mx - exp == 0) return(1)
    (si - exp) / (mx - exp)
  }
  aris <- replicate(n_boot, {
    idx <- sample(nrow(ms), replace = TRUE)
    km <- kmeans(ms[idx, , drop = FALSE], centers = k, nstart = 5, iter.max = 50)
    # map back: predict base cluster for the resampled rows via nearest base centroid
    d <- as.matrix(dist(rbind(km$centers, base_km$centers)))
    ari(km$cluster, base_km$cluster[idx])
  })
  mean_ari <- mean(aris, na.rm = TRUE)
  list(
    labels = if (isTRUE(mean_ari >= ari_min)) data.frame(gsis_id = ids, archetype_cluster = base_km$cluster) else NULL,
    mean_ari = mean_ari,
    centers = base_km$centers,
    note = if (isTRUE(mean_ari >= ari_min)) "stable — labels emitted" else "UNSTABLE — labels withheld, numeric vector only (spec §22)"
  )
}
