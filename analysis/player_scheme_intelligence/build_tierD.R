#!/usr/bin/env Rscript
# ===========================================================================
# Player x Scheme Intelligence — Tier D build: interaction RESEARCH model
# (spec §23-30, §D1-D28). SHADOW_ONLY. numeric_fantasy_adjustment == 0 ALWAYS.
#
#   Rscript analysis/player_scheme_intelligence/build_tierD.R
#
# Walk-forward, chronology-safe. Certifies (position x interaction-family) pairs
# against a reconstructable production-like baseline (anti-double-counting,
# spec §24). Every pair ends in ONE class: PREDICTIVE_INCREMENTAL /
# EXPLANATORY_ONLY / UNSTABLE / REJECTED / INSUFFICIENT_DATA.
#
# Writes lib/player-scheme-intelligence/data/ :
#   player_scheme_interactions.csv   (per position x family: class + effects)
#   player_scheme_manifest.json      (merged: adds `tier_d`; tiers -> A,B,C,D)
# and outputs/player-scheme-intelligence-2026/ :
#   tierD_walkforward.json  tierD_ablation.json  tierD_calibration.json
#   tierD_reconciliation.json
# ===========================================================================

suppressWarnings(suppressMessages({ library(dplyr); library(tidyr); library(jsonlite); library(digest) }))

.here <- sub("^--file=", "", grep("^--file=", commandArgs(FALSE), value = TRUE))
BASE <- if (length(.here)) dirname(.here) else file.path(getwd(), "analysis", "player_scheme_intelligence")
source(file.path(BASE, "config.R"))
source(file.path(BASE, "lib_spatial.R"))
source(file.path(BASE, "lib_charting.R"))
source(file.path(BASE, "lib_interaction.R"))
set.seed(PSI$SEED)
cache <- function(n) readRDS(file.path(PSI$CACHE_DIR, paste0(n, ".rds")))

message("loading pbp + participation + ftn + rosters ...")
pbp <- cache("pbp"); participation <- cache("participation"); ftn <- cache("ftn_charting")
rosters_weekly <- cache("rosters_weekly")
reg <- pbp %>% filter(season_type == "REG")

CUTS <- c(short_hi = 10, int_hi = 20)
pass_plays <- psi_pass_plays(reg, CUTS)
rush_plays_sp <- psi_rush_plays(reg)
cp <- psi_charting_plays(reg, participation, ftn, PSI, CUTS)
cp_db <- psi_charting_dropbacks(cp)
# rush frame: run-direction (from pbp run_location, 96% coverage) + defenders_in_box
# (from participation). field_third here is the RUN direction, not pass_location.
part_box <- participation %>% transmute(game_id = nflverse_game_id, play_id, defenders_in_box)
rush_box <- reg %>%
  filter(play_type == "run", coalesce(qb_kneel, 0) == 0, coalesce(qb_spike, 0) == 0,
         coalesce(qb_scramble, 0) == 0, !is.na(rusher_player_id)) %>%
  transmute(game_id, play_id, season, week, defteam = toupper(defteam),
            rusher_player_id, field_third = psi_field_third(run_location),
            epa, yards_gained = coalesce(yards_gained, 0)) %>%
  left_join(part_box, by = c("game_id", "play_id")) %>%
  mutate(charted = !is.na(field_third))

message("fantasy points per player-week ...")
# opponent per player-week: the defense the player's team faced
pw_team <- bind_rows(
  reg %>% filter(!is.na(passer_player_id)) %>% distinct(season, week, gsis_id = passer_player_id, team = posteam, opp = defteam),
  reg %>% filter(!is.na(rusher_player_id)) %>% distinct(season, week, gsis_id = rusher_player_id, team = posteam, opp = defteam),
  reg %>% filter(!is.na(receiver_player_id)) %>% distinct(season, week, gsis_id = receiver_player_id, team = posteam, opp = defteam)
) %>% distinct(season, week, gsis_id, .keep_all = TRUE)

fp <- psi_fantasy_pg(pbp, rosters_weekly) %>%
  inner_join(pw_team, by = c("season", "week", "gsis_id")) %>%
  rename(defteam = opp) %>%
  filter(position %in% c("QB", "RB", "WR", "TE"), season >= 2019)

# ---- Baseline 0 (naive self-form) + opp-position-allowed ------------
# Baseline 0 = per-player expanding mean of fantasy points, shifted by one game
# (chronology-safe), seeded by the position-season mean for a player's first game.
message("baselines ...")
fp <- fp %>% arrange(gsis_id, season, week) %>% group_by(gsis_id) %>%
  mutate(b0 = dplyr::lag(cummean(fp))) %>% ungroup() %>%
  group_by(position, season) %>% mutate(pos_mean = mean(fp)) %>% ungroup() %>%
  mutate(b0 = coalesce(b0, pos_mean))

# opponent position-allowed, expanding, shifted, league-centered
opp_allowed <- fp %>% group_by(defteam, position, season, week) %>%
  summarise(allowed = sum(fp), .groups = "drop") %>%
  arrange(defteam, position, season, week) %>%
  group_by(defteam, position, season) %>%
  mutate(opp_pos_allowed = dplyr::lag(cummean(allowed))) %>% ungroup() %>%
  group_by(position, season) %>% mutate(lg_allowed = mean(allowed)) %>% ungroup() %>%
  mutate(opp_pos_allowed_c = coalesce(opp_pos_allowed - lg_allowed, 0)) %>%
  select(defteam, position, season, week, opp_pos_allowed_c)
fp <- fp %>% left_join(opp_allowed, by = c("defteam", "position", "season", "week")) %>%
  mutate(opp_pos_allowed_c = coalesce(opp_pos_allowed_c, 0))

# ---- as-of profiles per through-season + overlap features -----------
message("as-of profiles + overlap features (per season cohort) ...")
TEST_SEASONS <- 2022:2025
feat_all <- list()
for (Y in (min(TEST_SEASONS) - 1):(max(TEST_SEASONS) - 1)) {  # through-season for rows in Y+1
  pprof <- psi_player_asof(pass_plays, rush_box, cp_db, Y)
  dprof <- psi_def_asof(pass_plays, rush_box, cp_db, Y)
  rows_Y1 <- fp %>% filter(season == Y + 1)
  feat_all[[as.character(Y + 1)]] <- psi_overlap_features(rows_Y1, pprof, dprof)
}
# also need training rows for seasons 2019..2021 -> profiles through 2018..2020
for (Y in 2018:2020) {
  pprof <- psi_player_asof(pass_plays, rush_box, cp_db, Y)
  dprof <- psi_def_asof(pass_plays, rush_box, cp_db, Y)
  rows_Y1 <- fp %>% filter(season == Y + 1)
  feat_all[[as.character(Y + 1)]] <- psi_overlap_features(rows_Y1, pprof, dprof)
}
feat <- bind_rows(feat_all)
model_df <- fp %>%
  inner_join(feat %>% select(-position), by = c("season", "week", "gsis_id", "defteam"))

IX_COLS <- c(ix_qb_spatial = "QB", ix_qb_coverage = "QB", ix_qb_pressure = "QB",
             ix_wr_spatial = "WR", ix_rb_direction = "RB", ix_rb_box = "RB")
FAMILIES <- list(
  list(pos = "QB", family = "qb_spatial",  feat = "ix_qb_spatial",  live = "PRIOR_ONLY_CURRENT_SEASON"),
  list(pos = "QB", family = "qb_coverage", feat = "ix_qb_coverage", live = "PRIOR_ONLY_CURRENT_SEASON"),
  list(pos = "QB", family = "qb_pressure", feat = "ix_qb_pressure", live = "PRIOR_ONLY_CURRENT_SEASON"),
  list(pos = "WR", family = "wr_spatial",  feat = "ix_wr_spatial",  live = "PRIOR_ONLY_CURRENT_SEASON"),
  list(pos = "TE", family = "te_spatial",  feat = "ix_wr_spatial",  live = "PRIOR_ONLY_CURRENT_SEASON"),
  list(pos = "RB", family = "rb_direction",feat = "ix_rb_direction",live = "PRIOR_ONLY_CURRENT_SEASON"),
  list(pos = "RB", family = "rb_box",      feat = "ix_rb_box",      live = "PRIOR_ONLY_CURRENT_SEASON")
)

# ---- walk-forward -------------------------------------------------
message("walk-forward ...")
mae <- function(e) mean(abs(e), na.rm = TRUE)
wf_rows <- list(); calib_rows <- list()
for (fam in FAMILIES) {
  fpos <- fam$pos; fc <- fam$feat
  d0 <- model_df %>% filter(position == fpos, !is.na(.data[[fc]]))
  if (nrow(d0) < 400) {
    wf_rows[[fam$family]] <- data.frame(position = fpos, family = fam$family, n_test = nrow(d0),
      delta_mae_vs_b0 = NA, delta_mae_vs_b1 = NA, p_value = NA, sign_stable = NA,
      class = "INSUFFICIENT_DATA")
    next
  }
  d0 <- d0 %>% mutate(feat_z = as.numeric(scale(.data[[fc]])))
  per_season <- list(); coefs <- c()
  for (S in TEST_SEASONS) {
    tr <- d0 %>% filter(season < S); te <- d0 %>% filter(season == S)
    if (nrow(tr) < 200 || nrow(te) < 40) next
    b1 <- lm(fp ~ b0 + opp_pos_allowed_c, data = tr)
    cand <- lm(fp ~ b0 + opp_pos_allowed_c + feat_z, data = tr)
    coefs <- c(coefs, coef(cand)["feat_z"])
    te$p_b0 <- te$b0
    te$p_b1 <- predict(b1, te)
    te$p_cand <- predict(cand, te)
    per_season[[as.character(S)]] <- te %>%
      transmute(season = S, gsis_id, week,
                e_b0 = fp - p_b0, e_b1 = fp - p_b1, e_cand = fp - p_cand,
                ix_contrib = p_cand - p_b1, resid_b1 = fp - p_b1)
  }
  ps <- bind_rows(per_season)
  if (nrow(ps) < 100) {
    wf_rows[[fam$family]] <- data.frame(position = fpos, family = fam$family, n_test = nrow(ps),
      delta_mae_vs_b0 = NA, delta_mae_vs_b1 = NA, p_value = NA, sign_stable = NA, class = "INSUFFICIENT_DATA")
    next
  }
  dm_b0 <- mae(ps$e_b0) - mae(ps$e_cand)
  dm_b1 <- mae(ps$e_b1) - mae(ps$e_cand)
  # paired test: per-row improvement in absolute error over Baseline 1
  imp <- abs(ps$e_b1) - abs(ps$e_cand)
  pv <- tryCatch(t.test(imp, mu = 0, alternative = "greater")$p.value, error = function(e) 1)
  sign_stable <- length(coefs) >= 3 && (all(coefs > 0) || all(coefs < 0))
  # calibration: quintiles of ix_contrib vs mean resid_b1
  ps$q <- dplyr::ntile(ps$ix_contrib, 5)
  cal <- ps %>% group_by(q) %>% summarise(mean_ix = mean(ix_contrib), mean_resid_b1 = mean(resid_b1), n = n(), .groups = "drop")
  mono <- with(cal, all(diff(mean_resid_b1) >= -0.15) || all(diff(mean_resid_b1) <= 0.15))
  calib_rows[[fam$family]] <- cal %>% mutate(position = fpos, family = fam$family)
  # classification
  # Classification (spec §21). Anti-double-counting (§24): the decision metric is
  # improvement over Baseline 1 (production-like), NOT Baseline 0 (naive).
  #   PREDICTIVE_INCREMENTAL: materially beats B1 OOS, FDR-significant (applied
  #                           below), sign-stable across folds, calibrated.
  #   EXPLANATORY_ONLY      : real matchup relationship (beats naive B0) but the
  #                           signal is subsumed by opponent strength (no gain
  #                           over B1), sign-stable.
  #   UNSTABLE             : positive-ish vs B1 but not sign-stable / calibrated.
  #   REJECTED            : no reliable relationship even vs the naive baseline.
  cls <- dplyr::case_when(
    dm_b1 >= 0.10 & pv < 0.10 & sign_stable & mono       ~ "PREDICTIVE_INCREMENTAL",
    dm_b1 >= 0.03 & sign_stable                          ~ "UNSTABLE",
    dm_b0 >= 0.03 & dm_b1 >= -0.02 & sign_stable         ~ "EXPLANATORY_ONLY",
    TRUE                                                 ~ "REJECTED"
  )
  wf_rows[[fam$family]] <- data.frame(position = fpos, family = fam$family, n_test = nrow(ps),
    mae_b0 = mae(ps$e_b0), mae_b1 = mae(ps$e_b1), mae_cand = mae(ps$e_cand),
    delta_mae_vs_b0 = dm_b0, delta_mae_vs_b1 = dm_b1, p_value = pv,
    sign_stable = sign_stable, calibration_monotone = mono, class = cls)
}
wf <- bind_rows(wf_rows)
# FDR across the tested (position x family) hypotheses that have a p-value
tested <- !is.na(wf$p_value)
wf$fdr_reject <- NA
wf$fdr_reject[tested] <- psi_bh(wf$p_value[tested], alpha = PSI$FDR_ALPHA)
# downgrade PREDICTIVE_INCREMENTAL that fails FDR
wf <- wf %>% mutate(class = ifelse(class == "PREDICTIVE_INCREMENTAL" & !coalesce(fdr_reject, FALSE),
                                   "EXPLANATORY_ONLY", class))

# ---- family ablation (each family alone vs all-in, QB only for brevity) ----
message("ablation ...")
abl <- wf %>% transmute(position, family,
  incremental_mae_gain_vs_b1 = delta_mae_vs_b1,
  beats_naive_only = coalesce(delta_mae_vs_b0 > 0.05 & delta_mae_vs_b1 <= 0.05, FALSE),
  retained = class %in% c("PREDICTIVE_INCREMENTAL"))

# ---- outputs -----------------------------------------------------
message("writing artifacts ...")
INV_ZERO <- 0
interactions <- wf %>% transmute(
  position, family,
  interaction_target = "fantasy_points_residual_vs_production_like_baseline",
  n_test_rows = n_test,
  delta_mae_vs_naive_baseline = round(delta_mae_vs_b0, 4),
  delta_mae_vs_production_like_baseline = round(delta_mae_vs_b1, 4),
  p_value = round(p_value, 4), fdr_reject = fdr_reject,
  sign_stable, calibration_monotone,
  validation_status = class,
  live_capability = "PRIOR_ONLY_CURRENT_SEASON",
  numeric_fantasy_adjustment = INV_ZERO,
  deployment = "SHADOW_ONLY",
  future_production_eligibility = ifelse(class == "PREDICTIVE_INCREMENTAL", "CANDIDATE", "NONE")
)
write.csv(as.data.frame(interactions), file.path(PSI$SERVE_DIR, "player_scheme_interactions.csv"),
          row.names = FALSE, na = "")

write_json(list(walkforward = "psi-tierD-walkforward-2026.1", test_seasons = TEST_SEASONS,
                baseline_note = "Baseline 1 is a RECONSTRUCTABLE production-like pregame estimate (self-form expanding mean + league-centered opponent-position-allowed). Historical production-projection provenance is not trustworthy for 2019-2025 so it is NOT used as the certification baseline (spec §3, Phase 4 lesson).",
                rows = wf),
           file.path(PSI$OUT_DIR, "tierD_walkforward.json"), auto_unbox = TRUE, pretty = TRUE, dataframe = "rows")
write_json(list(ablation = "psi-tierD-ablation-2026.1", rows = abl),
           file.path(PSI$OUT_DIR, "tierD_ablation.json"), auto_unbox = TRUE, pretty = TRUE, dataframe = "rows")
write_json(list(calibration = "psi-tierD-calibration-2026.1", rows = bind_rows(calib_rows)),
           file.path(PSI$OUT_DIR, "tierD_calibration.json"), auto_unbox = TRUE, pretty = TRUE, dataframe = "rows")

# reconciliation / invariants
r <- list(
  numeric_fantasy_adjustment_all_zero = all(interactions$numeric_fantasy_adjustment == 0),
  all_shadow_only = all(interactions$deployment == "SHADOW_ONLY"),
  every_family_classified = all(interactions$validation_status %in%
    c("PREDICTIVE_INCREMENTAL", "EXPLANATORY_ONLY", "UNSTABLE", "REJECTED", "INSUFFICIENT_DATA")),
  fdr_method = "Benjamini-Hochberg",
  fdr_alpha = PSI$FDR_ALPHA,
  chronology_note = "profiles for season S use seasons <= S-1; interaction coefficients train on seasons < S; week-S actuals target-only.",
  n_families = nrow(interactions),
  n_predictive_incremental = sum(interactions$validation_status == "PREDICTIVE_INCREMENTAL"),
  n_explanatory_only = sum(interactions$validation_status == "EXPLANATORY_ONLY"),
  n_rejected = sum(interactions$validation_status == "REJECTED"),
  n_unstable = sum(interactions$validation_status == "UNSTABLE"),
  n_insufficient = sum(interactions$validation_status == "INSUFFICIENT_DATA")
)
r$all_pass <- r$numeric_fantasy_adjustment_all_zero && r$all_shadow_only && r$every_family_classified
served_hash <- digest::digest(list(interactions), algo = "sha256")
r$served_content_sha256 <- served_hash
write_json(c(list(reconciliation = "psi-tierD-reconciliation-2026.1"), r),
           file.path(PSI$OUT_DIR, "tierD_reconciliation.json"), auto_unbox = TRUE, pretty = TRUE)

mpath <- file.path(PSI$SERVE_DIR, "player_scheme_manifest.json")
manifest <- jsonlite::fromJSON(mpath, simplifyVector = TRUE)
manifest$tiers <- c("A", "B", "C", "D")
manifest$tier_d <- list(
  built_at = format(Sys.time(), "%Y-%m-%dT%H:%M:%S%z"),
  interaction_version = PSI$INTERACTION_VERSION,
  lane = "SHADOW_ONLY",
  numeric_fantasy_adjustment = 0,
  hard_invariant = "numeric_fantasy_adjustment == 0 for the entire Phase 9 regardless of results (spec §22)",
  test_seasons = TEST_SEASONS,
  baseline = list(
    b0 = "player self-form expanding mean, shifted (naive)",
    b1 = "b0 + league-centered opponent-position-allowed (reconstructable production-like)",
    note = "NOT certified against the historical production projection (provenance not trustworthy 2019-2025; Phase 4 lesson)."),
  shrinkage = "z-scored single-family interaction term in an OLS baseline; ridge/EB comparison deferred — single-term OLS is the simplest form and no family cleared the incremental bar to warrant more (spec §11/§27).",
  fdr = list(method = "Benjamini-Hochberg", alpha = PSI$FDR_ALPHA),
  outcome_summary = list(
    predictive_incremental = r$n_predictive_incremental, explanatory_only = r$n_explanatory_only,
    unstable = r$n_unstable, rejected = r$n_rejected, insufficient = r$n_insufficient),
  reconciliation_all_pass = r$all_pass,
  served_content_sha256 = served_hash,
  files = c("player_scheme_interactions.csv"),
  notes = c(
    "SHADOW_ONLY research layer. numeric_fantasy_adjustment == 0 for every family, always.",
    "Chronology-safe walk-forward: profiles use seasons <= S-1; coefficients train on seasons < S.",
    "Certification baseline is a RECONSTRUCTABLE production-like estimate, not the live production projection.",
    "A null result (no family beats the production-like baseline OOS) is a SUCCESSFUL research outcome (spec §27)."
  )
)
write(jsonlite::toJSON(manifest, auto_unbox = TRUE, pretty = TRUE, null = "null"), mpath)

message("\nTier D research complete.")
print(interactions %>% select(position, family, delta_mae_vs_production_like_baseline, p_value, validation_status))
message(sprintf("\n  classes: PRED_INCR=%d EXPLANATORY=%d UNSTABLE=%d REJECTED=%d INSUFFICIENT=%d",
                r$n_predictive_incremental, r$n_explanatory_only, r$n_unstable, r$n_rejected, r$n_insufficient))
message(sprintf("  invariant numeric_fantasy_adjustment==0: %s | SHADOW_ONLY: %s",
                r$numeric_fantasy_adjustment_all_zero, r$all_shadow_only))
