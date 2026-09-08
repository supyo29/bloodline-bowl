# ===========================================================================
# Player x Scheme Intelligence — Tier D: interaction research model
# (spec §23-30, §D1-D28). SHADOW_ONLY. numeric_fantasy_adjustment == 0 ALWAYS.
#
# Central hypothesis: does player x scheme interaction information explain
# incremental OUT-OF-SAMPLE performance BEYOND a production-like pregame
# baseline? (Not: do tendencies overlap — that is Tiers A-C.)
#
# Chronology-safe. Player + defense profiles for season S use ONLY seasons
# <= S-1 (prior-seasons-only, conservative). Baselines are reconstructable
# pregame estimates. Interaction coefficients train on seasons < test season.
#
# Anti-double-counting (spec §24, Phase 4/5 lesson): the candidate must beat
# Baseline 1 (production-like: self-form + opponent-position strength), not
# merely Baseline 0 (naive self-form). A family that beats only Baseline 0 is
# NOT PREDICTIVE_INCREMENTAL.
# ===========================================================================

suppressWarnings(suppressMessages({ library(dplyr); library(tidyr) }))

PPR <- list(pass_yd = 0.04, pass_td = 4, intc = -2, rush_yd = 0.1, rush_td = 6,
            rec = 1, rec_yd = 0.1, rec_td = 6, fum_lost = -2)

# ---- player-week PPR fantasy points from pbp (reconstructable) ---------
psi_fantasy_pg <- function(pbp, rosters_weekly) {
  reg <- pbp %>% filter(season_type == "REG")
  passer <- reg %>% filter(!is.na(passer_player_id)) %>%
    group_by(season, week, gsis_id = passer_player_id) %>%
    summarise(pass_yards = sum(passing_yards, na.rm = TRUE),
              pass_td = sum(pass_touchdown, na.rm = TRUE),
              intc = sum(interception, na.rm = TRUE),
              dropbacks = sum(coalesce(qb_dropback, 0)), .groups = "drop")
  rusher <- reg %>% filter(!is.na(rusher_player_id)) %>%
    group_by(season, week, gsis_id = rusher_player_id) %>%
    summarise(rush_yards = sum(rushing_yards, na.rm = TRUE),
              rush_td = sum(rush_touchdown, na.rm = TRUE),
              carries = sum(coalesce(rush_attempt, 0)),
              fum_lost_rush = sum(coalesce(fumble_lost, 0) * (play_type == "run"), na.rm = TRUE),
              .groups = "drop")
  receiver <- reg %>% filter(!is.na(receiver_player_id)) %>%
    group_by(season, week, gsis_id = receiver_player_id) %>%
    summarise(rec = sum(coalesce(complete_pass, 0)),
              rec_yards = sum(receiving_yards, na.rm = TRUE),
              rec_td = sum(coalesce(pass_touchdown, 0) * coalesce(complete_pass, 0), na.rm = TRUE),
              targets = sum(coalesce(pass_attempt, 0)),
              fum_lost_rec = sum(coalesce(fumble_lost, 0) * (play_type == "pass"), na.rm = TRUE),
              .groups = "drop")
  pos <- rosters_weekly %>%
    filter(!is.na(gsis_id), !is.na(position), position != "") %>%
    distinct(season, gsis_id, position) %>%
    count(season, gsis_id, position) %>%
    group_by(season, gsis_id) %>% slice_max(n, n = 1, with_ties = FALSE) %>%
    ungroup() %>% select(season, gsis_id, position)

  full_join(passer, rusher, by = c("season", "week", "gsis_id")) %>%
    full_join(receiver, by = c("season", "week", "gsis_id")) %>%
    mutate(across(where(is.numeric), ~ coalesce(.x, 0))) %>%
    mutate(
      fp = PPR$pass_yd * pass_yards + PPR$pass_td * pass_td + PPR$intc * intc +
           PPR$rush_yd * rush_yards + PPR$rush_td * rush_td +
           PPR$rec * rec + PPR$rec_yd * rec_yards + PPR$rec_td * rec_td +
           PPR$fum_lost * (fum_lost_rush + fum_lost_rec),
      opportunities = dropbacks + carries + targets
    ) %>%
    left_join(pos, by = c("season", "gsis_id")) %>%
    mutate(position = coalesce(position, dplyr::case_when(
      dropbacks >= carries + targets ~ "QB",
      carries >= targets ~ "RB", TRUE ~ "WR"))) %>%
    filter(opportunities >= 1)
}

# ---- as-of player profile (seasons <= through_season) -----------------
psi_player_asof <- function(pass_plays, rush_plays, cp_dropbacks, through_season, min_att = 40, min_carry = 40) {
  pp <- pass_plays %>% filter(season <= through_season, charted)
  # QB 12-cell attempt share + epa
  qb_cells <- pp %>% group_by(gsis_id = passer_player_id, depth_bin, field_third) %>%
    summarise(att = n(), epa = mean(epa, na.rm = TRUE), .groups = "drop") %>%
    group_by(gsis_id) %>% mutate(att_share = att / sum(att), tot = sum(att)) %>% ungroup() %>%
    filter(tot >= min_att)
  # QB man/zone epa split + pressure epa delta (from charting dropbacks)
  db <- cp_dropbacks %>% filter(season <= through_season)
  qb_mz <- db %>% filter(!is.na(man_zone)) %>% group_by(gsis_id = passer_player_id, man_zone) %>%
    summarise(epa = mean(epa, na.rm = TRUE), n = n(), .groups = "drop") %>%
    pivot_wider(names_from = man_zone, values_from = c(epa, n)) %>%
    transmute(gsis_id, man_zone_epa_delta = epa_MAN - epa_ZONE,
              mz_n = coalesce(n_MAN, 0) + coalesce(n_ZONE, 0))
  qb_press <- db %>% filter(!is.na(was_pressure)) %>%
    mutate(st = ifelse(was_pressure, "P", "C")) %>%
    group_by(gsis_id = passer_player_id, st) %>%
    summarise(epa = mean(epa, na.rm = TRUE), n = n(), .groups = "drop") %>%
    pivot_wider(names_from = st, values_from = c(epa, n)) %>%
    transmute(gsis_id, pressure_epa_delta = epa_P - epa_C,
              press_n = coalesce(n_P, 0) + coalesce(n_C, 0))
  # WR 12-cell target share + epa
  wr_cells <- pass_plays %>% filter(season <= through_season, charted, !is.na(receiver_player_id)) %>%
    group_by(gsis_id = receiver_player_id, depth_bin, field_third) %>%
    summarise(tgt = n(), epa = mean(epa, na.rm = TRUE), .groups = "drop") %>%
    group_by(gsis_id) %>% mutate(tgt_share = tgt / sum(tgt), tot = sum(tgt)) %>% ungroup() %>%
    filter(tot >= min_att)
  # RB rush direction share + epa; box epa split
  rb_dir <- rush_plays %>% filter(season <= through_season, charted) %>%
    group_by(gsis_id = rusher_player_id, field_third) %>%
    summarise(car = n(), epa = mean(epa, na.rm = TRUE), .groups = "drop") %>%
    group_by(gsis_id) %>% mutate(dir_share = car / sum(car), tot = sum(car)) %>% ungroup() %>%
    filter(tot >= min_carry)
  rb_box <- rush_plays %>% filter(season <= through_season, !is.na(defenders_in_box)) %>%
    mutate(bx = ifelse(defenders_in_box >= 7.5, "H", ifelse(defenders_in_box < 6.5, "L", "N"))) %>%
    group_by(gsis_id = rusher_player_id, bx) %>%
    summarise(epa = mean(epa, na.rm = TRUE), n = n(), .groups = "drop") %>%
    pivot_wider(names_from = bx, values_from = c(epa, n)) %>%
    transmute(gsis_id, box_epa_delta = coalesce(epa_H, 0) - coalesce(epa_L, 0),
              box_n = coalesce(n_H, 0) + coalesce(n_L, 0) + coalesce(n_N, 0))
  list(qb_cells = qb_cells, qb_mz = qb_mz, qb_press = qb_press,
       wr_cells = wr_cells, rb_dir = rb_dir, rb_box = rb_box)
}

# ---- as-of defense profile (league-centered) -------------------------
psi_def_asof <- function(pass_plays, rush_plays, cp_dropbacks, through_season, min_n = 100) {
  pp <- pass_plays %>% filter(season <= through_season, charted)
  lg_cell <- pp %>% group_by(depth_bin, field_third) %>% summarise(lg_epa = mean(epa, na.rm = TRUE), .groups = "drop")
  def_cell <- pp %>% group_by(defteam, depth_bin, field_third) %>%
    summarise(epa_allowed = mean(epa, na.rm = TRUE), n = n(), .groups = "drop") %>%
    left_join(lg_cell, by = c("depth_bin", "field_third")) %>%
    mutate(cell_vuln = epa_allowed - lg_epa)
  db <- cp_dropbacks %>% filter(season <= through_season)
  lg_man <- mean(db$man_zone[!is.na(db$man_zone)] == "MAN")
  lg_press <- mean(db$was_pressure, na.rm = TRUE)
  def_scheme <- db %>% group_by(defteam) %>%
    summarise(man_rate = mean(man_zone == "MAN", na.rm = TRUE),
              pressure_rate = mean(was_pressure, na.rm = TRUE), n = n(), .groups = "drop") %>%
    mutate(man_rate_c = man_rate - lg_man, pressure_rate_c = pressure_rate - lg_press)
  lg_dir <- rush_plays %>% filter(season <= through_season, charted) %>%
    group_by(field_third) %>% summarise(lg_epa = mean(epa, na.rm = TRUE), .groups = "drop")
  def_dir <- rush_plays %>% filter(season <= through_season, charted) %>%
    group_by(defteam, field_third) %>%
    summarise(epa_allowed = mean(epa, na.rm = TRUE), n = n(), .groups = "drop") %>%
    left_join(lg_dir, by = "field_third") %>% mutate(dir_vuln = epa_allowed - lg_epa)
  lg_box <- rush_plays %>% filter(season <= through_season, !is.na(defenders_in_box))
  def_box <- lg_box %>% group_by(defteam) %>%
    summarise(heavy_box_rate = mean(defenders_in_box >= 7.5), .groups = "drop") %>%
    mutate(heavy_box_rate_c = heavy_box_rate - mean(lg_box$defenders_in_box >= 7.5))
  list(def_cell = def_cell, def_scheme = def_scheme, def_dir = def_dir, def_box = def_box)
}

# ---- interaction overlap features per player-week (spec §7, §5) ------
psi_overlap_features <- function(fp_rows, pprof, dprof) {
  # QB spatial overlap: sum_c player_att_share * defense_cell_vuln
  qb_sp <- pprof$qb_cells %>% inner_join(dprof$def_cell, by = c("depth_bin", "field_third"),
                                        relationship = "many-to-many") %>%
    group_by(gsis_id, defteam) %>%
    summarise(ix_qb_spatial = sum(att_share * cell_vuln, na.rm = TRUE),
              ix_qb_spatial_support = first(tot), .groups = "drop")
  wr_sp <- pprof$wr_cells %>% inner_join(dprof$def_cell, by = c("depth_bin", "field_third"),
                                        relationship = "many-to-many") %>%
    group_by(gsis_id, defteam) %>%
    summarise(ix_wr_spatial = sum(tgt_share * cell_vuln, na.rm = TRUE),
              ix_wr_spatial_support = first(tot), .groups = "drop")
  rb_sp <- pprof$rb_dir %>% inner_join(dprof$def_dir, by = "field_third",
                                      relationship = "many-to-many") %>%
    group_by(gsis_id, defteam) %>%
    summarise(ix_rb_direction = sum(dir_share * dir_vuln, na.rm = TRUE),
              ix_rb_direction_support = first(tot), .groups = "drop")
  # scalar overlaps
  base <- fp_rows %>% select(season, week, gsis_id, defteam, position)
  base %>%
    left_join(qb_sp, by = c("gsis_id", "defteam")) %>%
    left_join(wr_sp, by = c("gsis_id", "defteam")) %>%
    left_join(rb_sp, by = c("gsis_id", "defteam")) %>%
    left_join(pprof$qb_mz, by = "gsis_id") %>%
    left_join(pprof$qb_press, by = "gsis_id") %>%
    left_join(pprof$rb_box, by = "gsis_id") %>%
    left_join(dprof$def_scheme %>% select(defteam, man_rate_c, pressure_rate_c), by = "defteam") %>%
    left_join(dprof$def_box %>% select(defteam, heavy_box_rate_c), by = "defteam") %>%
    mutate(
      ix_qb_coverage = man_zone_epa_delta * man_rate_c,
      ix_qb_pressure = pressure_epa_delta * pressure_rate_c,
      ix_rb_box      = box_epa_delta * heavy_box_rate_c
    )
}

# ---- BH false-discovery control -------------------------------------
psi_bh <- function(pvals, alpha = 0.10) {
  o <- order(pvals); n <- length(pvals)
  crit <- (seq_len(n) / n) * alpha
  pass <- pvals[o] <= crit
  keep <- if (any(pass)) max(which(pass)) else 0
  reject <- rep(FALSE, n); if (keep > 0) reject[o[seq_len(keep)]] <- TRUE
  reject
}
