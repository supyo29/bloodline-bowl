#!/usr/bin/env Rscript
# ===========================================================================
# Matchup Intelligence 2.0 — Phase 5 chronology-safe walk-forward EVALUATION of the interaction families that Phase 9 Tier D did NOT test.
#
#   Rscript analysis/matchup2/evaluate_phase5.R
#
# EVALUATION SUITE — DECLARED BEFORE FITTING:
#   baseline (authoritative for every family here): Tier D "Baseline 1" = player self-form expanding mean (shifted one game) +
#     league-centred opponent-position-allowed. Same baseline, same test seasons, same classifier and FDR control as Tier D, so results are
#     comparable and no family is tuned against one baseline and reported against another.
#   target: fantasy-point residual vs that baseline (PPR points, reconstructable from pbp).
#   chronology: player + defense profiles for season S use ONLY seasons <= S-1; coefficients train on seasons < S; week-S actuals are target only.
#   measures: delta-MAE vs baseline, paired t p-value, BH-FDR across the Phase 5 hypotheses, sign stability across folds, calibration (quintiles),
#     directional win rate, points gained/lost when the interaction moves the prediction materially, large-win/large-loss rate.
#   NEW families (untested in Phase 9): receiver man/zone × defense man rate (WR/TE/RB), receiver explosive-area overlap (WR/TE), RB run-gap overlap.
#
# A null result is a successful research outcome. NOTHING here changes a served projection; output is evidence only (numeric adjustment stays null).
# ===========================================================================
suppressWarnings(suppressMessages({ library(dplyr); library(tidyr); library(jsonlite); library(digest) }))
ROOT <- normalizePath(".")
BASE <- file.path(ROOT, "analysis", "player_scheme_intelligence")
source(file.path(BASE, "config.R")); source(file.path(BASE, "lib_spatial.R")); source(file.path(BASE, "lib_charting.R")); source(file.path(BASE, "lib_interaction.R"))
set.seed(20260921L)
cache <- function(n) readRDS(file.path(PSI$CACHE_DIR, paste0(n, ".rds")))
message("loading caches ...")
pbp <- cache("pbp"); participation <- cache("participation"); ftn <- cache("ftn_charting"); rosters_weekly <- cache("rosters_weekly")
reg <- pbp %>% filter(season_type == "REG")
CUTS <- c(short_hi = 10, int_hi = 20)
pass_plays <- psi_pass_plays(reg, CUTS); rush_sp <- psi_rush_plays(reg)
cp <- psi_charting_plays(reg, participation, ftn, PSI, CUTS); cp_db <- psi_charting_dropbacks(cp)
part_box <- participation %>% transmute(game_id = nflverse_game_id, play_id, defenders_in_box)
rush_box <- reg %>% filter(play_type == "run", coalesce(qb_kneel, 0) == 0, coalesce(qb_spike, 0) == 0, coalesce(qb_scramble, 0) == 0, !is.na(rusher_player_id)) %>%
  transmute(game_id, play_id, season, week, defteam = toupper(defteam), rusher_player_id, field_third = psi_field_third(run_location), epa, yards_gained = coalesce(yards_gained, 0)) %>%
  left_join(part_box, by = c("game_id", "play_id")) %>% mutate(charted = !is.na(field_third))

message("fantasy points + baselines (identical to Tier D) ...")
pw_team <- bind_rows(
  reg %>% filter(!is.na(passer_player_id)) %>% distinct(season, week, gsis_id = passer_player_id, team = posteam, opp = defteam),
  reg %>% filter(!is.na(rusher_player_id)) %>% distinct(season, week, gsis_id = rusher_player_id, team = posteam, opp = defteam),
  reg %>% filter(!is.na(receiver_player_id)) %>% distinct(season, week, gsis_id = receiver_player_id, team = posteam, opp = defteam)) %>% distinct(season, week, gsis_id, .keep_all = TRUE)
fp <- psi_fantasy_pg(pbp, rosters_weekly) %>% inner_join(pw_team, by = c("season", "week", "gsis_id")) %>% rename(defteam = opp) %>% filter(position %in% c("QB", "RB", "WR", "TE"), season >= 2019)
fp <- fp %>% arrange(gsis_id, season, week) %>% group_by(gsis_id) %>% mutate(b0 = dplyr::lag(cummean(fp))) %>% ungroup() %>% group_by(position, season) %>% mutate(pos_mean = mean(fp)) %>% ungroup() %>% mutate(b0 = coalesce(b0, pos_mean))
opp_allowed <- fp %>% group_by(defteam, position, season, week) %>% summarise(allowed = sum(fp), .groups = "drop") %>% arrange(defteam, position, season, week) %>% group_by(defteam, position, season) %>% mutate(opp_pos_allowed = dplyr::lag(cummean(allowed))) %>% ungroup() %>% group_by(position, season) %>% mutate(lg_allowed = mean(allowed)) %>% ungroup() %>% mutate(opp_pos_allowed_c = coalesce(opp_pos_allowed - lg_allowed, 0)) %>% select(defteam, position, season, week, opp_pos_allowed_c)
fp <- fp %>% left_join(opp_allowed, by = c("defteam", "position", "season", "week")) %>% mutate(opp_pos_allowed_c = coalesce(opp_pos_allowed_c, 0))

# ---- NEW as-of features (profiles through season Y only) ------------------------------------------------------------------------------
MIN_MZ <- 30L
phase5_features <- function(rows, Y, pass_plays, rush_sp, cp, cp_db) {
  # receiver man/zone edge: EPA/target vs MAN minus vs ZONE
  rc <- cp %>% filter(season <= Y, pass_attempt == 1, !is.na(receiver_player_id), !is.na(man_zone), qb_spike == 0) %>% group_by(gsis_id = receiver_player_id, man_zone) %>% summarise(epa = mean(epa, na.rm = TRUE), n = n(), .groups = "drop") %>% pivot_wider(names_from = man_zone, values_from = c(epa, n)) %>%
    transmute(gsis_id, rcv_mz_edge = epa_MAN - epa_ZONE, rcv_mz_n = pmin(coalesce(n_MAN, 0L), coalesce(n_ZONE, 0L))) %>% filter(rcv_mz_n >= MIN_MZ)
  db <- cp_db %>% filter(season <= Y); lg_man <- mean(db$man_zone[!is.na(db$man_zone)] == "MAN")
  def_man <- db %>% group_by(defteam) %>% summarise(man_rate = mean(man_zone == "MAN", na.rm = TRUE), .groups = "drop") %>% mutate(man_rate_c = man_rate - lg_man)
  # receiver explosive-area overlap
  pp <- pass_plays %>% filter(season <= Y, charted); lg_ex <- pp %>% group_by(depth_bin, field_third) %>% summarise(lg_expl = mean(explosive), .groups = "drop")
  def_ex <- pp %>% group_by(defteam, depth_bin, field_third) %>% summarise(def_expl = mean(explosive), n = n(), .groups = "drop") %>% left_join(lg_ex, by = c("depth_bin", "field_third")) %>% mutate(expl_vuln = def_expl - lg_expl)
  rcells <- pp %>% filter(!is.na(receiver_player_id)) %>% group_by(gsis_id = receiver_player_id, depth_bin, field_third) %>% summarise(tgt = n(), .groups = "drop") %>% group_by(gsis_id) %>% mutate(tgt_share = tgt / sum(tgt), tot = sum(tgt)) %>% ungroup() %>% filter(tot >= 40)
  rx <- rcells %>% inner_join(def_ex, by = c("depth_bin", "field_third"), relationship = "many-to-many") %>% group_by(gsis_id, defteam) %>% summarise(ix_rcv_explosive = sum(tgt_share * expl_vuln, na.rm = TRUE), .groups = "drop")
  # RB gap overlap
  rp <- rush_sp %>% filter(season <= Y, !is.na(run_gap)); lg_gap <- rp %>% group_by(run_gap) %>% summarise(lg_epa = mean(epa, na.rm = TRUE), .groups = "drop")
  def_gap <- rp %>% group_by(defteam, run_gap) %>% summarise(d_epa = mean(epa, na.rm = TRUE), .groups = "drop") %>% left_join(lg_gap, by = "run_gap") %>% mutate(gap_vuln = d_epa - lg_epa)
  rgap <- rp %>% group_by(gsis_id = rusher_player_id, run_gap) %>% summarise(car = n(), .groups = "drop") %>% group_by(gsis_id) %>% mutate(gap_share = car / sum(car), tot = sum(car)) %>% ungroup() %>% filter(tot >= 40)
  rg <- rgap %>% inner_join(def_gap, by = "run_gap", relationship = "many-to-many") %>% group_by(gsis_id, defteam) %>% summarise(ix_rb_gap = sum(gap_share * gap_vuln, na.rm = TRUE), .groups = "drop")
  rows %>% select(season, week, gsis_id, defteam, position) %>% left_join(rc, by = "gsis_id") %>% left_join(def_man %>% select(defteam, man_rate_c), by = "defteam") %>% mutate(ix_rcv_coverage = rcv_mz_edge * man_rate_c) %>% left_join(rx, by = c("gsis_id", "defteam")) %>% left_join(rg, by = c("gsis_id", "defteam"))
}
if (!"run_gap" %in% names(rush_sp)) stop("psi_rush_plays no longer exposes run_gap")
rush_sp <- rush_sp %>% mutate(gsis_id = NULL); rush_sp$rusher_player_id <- rush_sp$rusher_player_id

TEST_SEASONS <- 2022:2025
feat_all <- list()
for (Y in 2018:(max(TEST_SEASONS) - 1)) { rows_Y1 <- fp %>% filter(season == Y + 1); feat_all[[as.character(Y + 1)]] <- phase5_features(rows_Y1, Y, pass_plays, rush_sp, cp, cp_db) }
feat <- bind_rows(feat_all); model_df <- fp %>% inner_join(feat %>% select(-position), by = c("season", "week", "gsis_id", "defteam"))

# ---- chronology adversarial: mutate ALL data of the test season and later; features for that season must be byte-identical --------------
message("chronology adversarial (future mutation) ...")
chk_season <- 2024L; mutate_future <- function(d) { d$epa[d$season >= chk_season] <- rev(d$epa[d$season >= chk_season]); if ("explosive" %in% names(d)) d$explosive[d$season >= chk_season] <- 1L - d$explosive[d$season >= chk_season]; d }
rowsC <- fp %>% filter(season == chk_season)
f_real <- phase5_features(rowsC, chk_season - 1, pass_plays, rush_sp, cp, cp_db)
f_mut <- phase5_features(rowsC, chk_season - 1, mutate_future(pass_plays), mutate_future(rush_sp), mutate_future(cp), mutate_future(cp_db))
chronology_ok <- isTRUE(all.equal(f_real %>% select(ix_rcv_coverage, ix_rcv_explosive, ix_rb_gap), f_mut %>% select(ix_rcv_coverage, ix_rcv_explosive, ix_rb_gap)))
message("  future-mutation invariance: ", chronology_ok)

FAMILIES <- list(list(pos = "WR", family = "wr_man_zone", feat = "ix_rcv_coverage"), list(pos = "TE", family = "te_man_zone", feat = "ix_rcv_coverage"), list(pos = "RB", family = "rb_man_zone_receiving", feat = "ix_rcv_coverage"),
                 list(pos = "WR", family = "wr_explosive_area", feat = "ix_rcv_explosive"), list(pos = "TE", family = "te_explosive_area", feat = "ix_rcv_explosive"), list(pos = "RB", family = "rb_run_gap", feat = "ix_rb_gap"))
mae <- function(e) mean(abs(e), na.rm = TRUE)
wf_rows <- list(); dec_rows <- list()
for (fam in FAMILIES) {
  d0 <- model_df %>% filter(position == fam$pos, !is.na(.data[[fam$feat]]))
  if (nrow(d0) < 400) { wf_rows[[fam$family]] <- data.frame(position = fam$pos, family = fam$family, n_test = nrow(d0), class = "INSUFFICIENT_DATA"); next }
  d0 <- d0 %>% mutate(feat_z = as.numeric(scale(.data[[fam$feat]]))); per <- list(); coefs <- c()
  for (S in TEST_SEASONS) { tr <- d0 %>% filter(season < S); te <- d0 %>% filter(season == S); if (nrow(tr) < 200 || nrow(te) < 40) next
    b1 <- lm(fp ~ b0 + opp_pos_allowed_c, data = tr); cand <- lm(fp ~ b0 + opp_pos_allowed_c + feat_z, data = tr); coefs <- c(coefs, coef(cand)["feat_z"]); te$p_b1 <- predict(b1, te); te$p_cand <- predict(cand, te); te$p_b0 <- te$b0
    per[[as.character(S)]] <- te %>% transmute(season = S, gsis_id, week, fp, e_b0 = fp - p_b0, e_b1 = fp - p_b1, e_cand = fp - p_cand, shift = p_cand - p_b1) }
  ps <- bind_rows(per); if (nrow(ps) < 100) { wf_rows[[fam$family]] <- data.frame(position = fam$pos, family = fam$family, n_test = nrow(ps), class = "INSUFFICIENT_DATA"); next }
  dm0 <- mae(ps$e_b0) - mae(ps$e_cand); dm1 <- mae(ps$e_b1) - mae(ps$e_cand); imp <- abs(ps$e_b1) - abs(ps$e_cand); pv <- tryCatch(t.test(imp, mu = 0, alternative = "greater")$p.value, error = function(e) 1)
  sign_stable <- length(coefs) >= 3 && (all(coefs > 0) || all(coefs < 0)); ps$q <- dplyr::ntile(ps$shift, 5); cal <- ps %>% group_by(q) %>% summarise(mean_shift = mean(shift), mean_resid_b1 = mean(e_b1), n = n(), .groups = "drop"); mono <- all(diff(cal$mean_resid_b1) >= -0.15)
  # decision-style measures: rows where the interaction moves the prediction materially (top/bottom decile of |shift|)
  thr <- quantile(abs(ps$shift), 0.9); big <- ps %>% filter(abs(shift) >= thr); dir_win <- mean(sign(big$shift) == sign(big$e_b1) & big$shift != 0); gain <- mean(abs(big$e_b1) - abs(big$e_cand)); lw <- mean((abs(big$e_b1) - abs(big$e_cand)) >= 5); ll <- mean((abs(big$e_b1) - abs(big$e_cand)) <= -5)
  cls <- dplyr::case_when(dm1 >= 0.10 & pv < 0.10 & sign_stable & mono ~ "PREDICTIVE_INCREMENTAL", dm1 >= 0.03 & sign_stable ~ "UNSTABLE", dm0 >= 0.03 & dm1 >= -0.02 & sign_stable ~ "EXPLANATORY_ONLY", TRUE ~ "REJECTED")
  wf_rows[[fam$family]] <- data.frame(position = fam$pos, family = fam$family, n_test = nrow(ps), mae_b0 = mae(ps$e_b0), mae_b1 = mae(ps$e_b1), mae_cand = mae(ps$e_cand), delta_mae_vs_b0 = dm0, delta_mae_vs_b1 = dm1, p_value = pv, sign_stable = sign_stable, calibration_monotone = mono,
    material_shift_rows = nrow(big), directional_win_rate = dir_win, mean_points_gained_on_material = gain, large_win_rate = lw, large_loss_rate = ll, class = cls)
}
wf <- bind_rows(wf_rows); tested <- !is.na(wf$p_value); wf$fdr_reject <- NA; wf$fdr_reject[tested] <- psi_bh(wf$p_value[tested], alpha = PSI$FDR_ALPHA)
wf <- wf %>% mutate(class = ifelse(class == "PREDICTIVE_INCREMENTAL" & !coalesce(fdr_reject, FALSE), "EXPLANATORY_ONLY", class))
dir.create(file.path(ROOT, "lib", "matchup2", "data"), showWarnings = FALSE, recursive = TRUE)
res <- list(evaluation_version = "matchup2-walkforward-2026.1", generated_by = "analysis/matchup2/evaluate_phase5.R", test_seasons = TEST_SEASONS,
  baseline = "Tier D Baseline 1: player self-form expanding mean (shifted) + league-centred opponent-position-allowed (reconstructable production-like; NOT the historical production projection, whose provenance is untrustworthy 2019-2025)",
  target = "fantasy-point residual vs baseline (PPR, reconstructed from pbp)", fdr = list(method = "Benjamini-Hochberg", alpha = PSI$FDR_ALPHA, scope = "the 6 Phase 5 hypotheses"),
  chronology = list(profiles_for_season_S_use = "seasons <= S-1 only", coefficients_train_on = "seasons < S", future_mutation_invariance = chronology_ok, mutation_tested = paste0("all epa/explosive of season >= ", chk_season, " reversed/flipped; season-", chk_season, " features unchanged")),
  new_families_tested = nrow(wf), n_predictive_incremental = sum(wf$class == "PREDICTIVE_INCREMENTAL"), rows = wf)
res$content_sha256 <- digest::digest(wf, algo = "sha256")
write_json(res, file.path(ROOT, "lib", "matchup2", "data", "walkforward_results.json"), auto_unbox = TRUE, pretty = TRUE, dataframe = "rows", na = "null")
print(wf %>% select(position, family, n_test, delta_mae_vs_b0, delta_mae_vs_b1, p_value, sign_stable, calibration_monotone, class))
message("chronology invariance: ", chronology_ok, " | PREDICTIVE_INCREMENTAL: ", sum(wf$class == "PREDICTIVE_INCREMENTAL"))
