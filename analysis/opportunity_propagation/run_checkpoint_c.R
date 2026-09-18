#!/usr/bin/env Rscript
# ===========================================================================
# Injury -> Opportunity Propagation Intelligence -- Checkpoint C driver.
#   Rscript analysis/opportunity_propagation/run_checkpoint_c.R
# Produces every diagnostic cited in docs/INJURY_OPPORTUNITY_PROPAGATION_
# PHASE_3_CHECKPOINT_C.md. Internal artifacts only (spec §62) -- no served
# product, no production import.
# ===========================================================================

suppressWarnings(suppressMessages({ library(dplyr); library(data.table) }))

.here <- sub("^--file=", "", grep("^--file=", commandArgs(FALSE), value = TRUE))
.opp_dir <- if (nzchar(.here)) dirname(.here) else file.path(getwd(), "analysis", "opportunity_propagation")
source(file.path(.opp_dir, "config.R"))
source(file.path(.opp_dir, "lib_absence_detection.R"))
source(file.path(.opp_dir, "lib_fast_baselines.R"))
source(file.path(.opp_dir, "lib_redistribution_observed.R"))
source(file.path(.opp_dir, "lib_episodes.R"))
source(file.path(.opp_dir, "lib_propagation_model.R"))
source(file.path(.opp_dir, "backtest.R"))

t0 <- Sys.time()
absence_events <- readRDS(file.path(OPP$CACHE_DIR, "absence_events.rds"))
domain_accounting <- readRDS(file.path(OPP$CACHE_DIR, "domain_accounting.rds"))
beneficiary_observations <- readRDS(file.path(OPP$CACHE_DIR, "beneficiary_observations.rds"))
roster_lookup <- readRDS(file.path(OPP$CACHE_DIR, "roster_lookup.rds"))
pgr <- readRDS(file.path(ROLE$CACHE_DIR, "player_game_role.rds"))
schedules <- readRDS(file.path(FI$CACHE_DIR, "schedules.rds"))
cal <- build_team_game_calendar(schedules)

ed <- absence_events %>% distinct(season, week, team, gsis_id, position, status, absence_set_id, absence_multiplicity,
                                  meaningful_role_default, meaningful_role_low, meaningful_role_high) %>%
  mutate(absence_event_id = paste(season, week, team, gsis_id, sep = ":"))

cat("Building absence episodes ...\n")
episodes <- build_absence_episodes(ed, roster_lookup, pgr, cal)
summ <- episode_summary(episodes)
saveRDS(list(episodes = episodes, summary = summ), file.path(OPP$CACHE_DIR, "episodes.rds"))

onset_keys <- episodes %>% filter(episode_state == "EPISODE_ONSET") %>% distinct(gsis_id, team, season, week)
onset_events <- ed %>% inner_join(onset_keys, by = c("gsis_id", "team", "season", "week"))

cat(sprintf("Episodes: %d total, %d one-game, %d multi-game\n", nrow(summ), sum(summ$n_games == 1), sum(summ$n_games > 1)))
cat(sprintf("Onset events (== episode count): %d, continuation games: %d\n",
           nrow(onset_events), sum(episodes$episode_state == "EPISODE_CONTINUATION")))

# ---- primary v1 population: DEFAULT-threshold onset events, single-major-absence, 2019-2025 ----
primary_pop <- onset_events %>% filter(meaningful_role_default, season >= 2019, season <= 2025)
primary_single <- primary_pop %>% filter(absence_multiplicity == "single_major_absence")
primary_multi <- primary_pop %>% filter(absence_multiplicity == "multiple_major_absences")
cat(sprintf("\nPrimary window 2019-2025 onset events: %d total (%d single, %d multi)\n",
           nrow(primary_pop), nrow(primary_single), nrow(primary_multi)))

onset_ids_single <- primary_single$absence_event_id
event_season_single <- setNames(primary_single$season, primary_single$absence_event_id)
onset_ids_multi <- primary_multi$absence_event_id
event_season_multi <- setNames(primary_multi$season, primary_multi$absence_event_id)

model_names <- names(OPP$MODEL_REGISTRY)
val_seasons <- 2020:2025

cat("\n=== Walk-forward backtest: PRIMARY (single-major-absence, DEFAULT threshold) ===\n")
t_bt <- Sys.time()
results_single <- walk_forward_backtest(model_names, val_seasons, absence_events, domain_accounting,
                                        beneficiary_observations, onset_ids_single, event_season_single)
cat(sprintf("walk-forward runtime: %.1fs, rows: %d\n", as.numeric(difftime(Sys.time(), t_bt, units = "secs")), nrow(results_single)))
saveRDS(results_single, file.path(OPP$CACHE_DIR, "backtest_primary_single.rds"))

cat("\n=== Walk-forward backtest: MULTI-ABSENCE (same models/priors architecture) ===\n")
results_multi <- walk_forward_backtest(model_names, val_seasons, absence_events, domain_accounting,
                                       beneficiary_observations, onset_ids_multi, event_season_multi)
saveRDS(results_multi, file.path(OPP$CACHE_DIR, "backtest_primary_multi.rds"))

# ---- overall + by-domain summary, primary single-absence ----
overall <- summarize_scores(results_single, c("model"))
by_domain <- summarize_scores(results_single, c("model", "domain"))
by_season <- summarize_scores(results_single, c("model", "val_season"))
cat("\n-- overall (single-absence, primary) --\n"); print(overall)
cat("\n-- by domain --\n"); print(as.data.frame(by_domain))

overall_multi <- summarize_scores(results_multi, c("model"))
cat("\n-- overall (multi-absence) --\n"); print(overall_multi)

# ---- threshold sensitivity: rerun primary walk-forward under LOW/HIGH thresholds ----
cat("\n=== Threshold sensitivity ===\n")
threshold_results <- list(DEFAULT = results_single)
for (variant in c("low", "high")) {
  col <- paste0("meaningful_role_", variant)
  pop <- onset_events %>% filter(.data[[col]], season >= 2019, season <= 2025, absence_multiplicity == "single_major_absence")
  ids <- pop$absence_event_id
  seas <- setNames(pop$season, pop$absence_event_id)
  res <- walk_forward_backtest(model_names, val_seasons, absence_events, domain_accounting, beneficiary_observations, ids, seas)
  threshold_results[[toupper(variant)]] <- res
  cat(sprintf("variant=%s n_events=%d\n", toupper(variant), length(unique(ids))))
}
saveRDS(threshold_results, file.path(OPP$CACHE_DIR, "backtest_threshold_sensitivity.rds"))
threshold_summary <- bind_rows(lapply(names(threshold_results), function(v) {
  summarize_scores(threshold_results[[v]], c("model")) %>% mutate(threshold_variant = v)
}))
cat("\n-- threshold sensitivity summary --\n"); print(as.data.frame(threshold_summary))

# ---- select final model: lowest mean L1 distribution error among calibrated candidates, primary single-absence, DEFAULT threshold ----
selected_model <- overall %>% filter(model != "BASELINE_0_NO_PROPAGATION") %>% arrange(mean_l1_distribution_error) %>% slice(1) %>% pull(model)
cat(sprintf("\nSelected model (lowest mean L1, primary single-absence, DEFAULT threshold): %s\n", selected_model))

# ---- final fit on ALL 2019-2025 primary single-absence onset events ----
final_train_frames <- build_event_frames(onset_ids_single, absence_events, domain_accounting, beneficiary_observations)
final_priors <- if (selected_model %in% c("BASELINE_3_CONTINGENCY_SHRUNK", "CANDIDATE_4_HIERARCHICAL")) fit_inheritance_priors(final_train_frames$domain_accounting, final_train_frames$events_meta) else NULL
final_position_weights <- if (selected_model == "CANDIDATE_4_HIERARCHICAL") fit_position_relationship_weights(final_train_frames$beneficiary_observations, final_train_frames$events_meta) else NULL
saveRDS(list(model = selected_model, priors = final_priors, position_weights = final_position_weights, train_ids = onset_ids_single),
       file.path(OPP$CACHE_DIR, "final_model.rds"))

# ---- 2012-2018 robustness diagnostic (apply frozen final model, never retrain) ----
cat("\n=== 2012-2018 robustness diagnostic (frozen primary model, not retrained) ===\n")
old_era_ids <- onset_events %>% filter(meaningful_role_default, season <= 2018, absence_multiplicity == "single_major_absence") %>% pull(absence_event_id)
cat(sprintf("2012-2018 onset single-absence events: %d\n", length(old_era_ids)))
if (length(old_era_ids) > 0) {
  old_val_frames <- build_event_frames(old_era_ids, absence_events, domain_accounting, beneficiary_observations)
  old_pred <- OPP$MODEL_REGISTRY[[selected_model]](beneficiary_val = old_val_frames$beneficiary_observations,
    domain_accounting_val = old_val_frames$domain_accounting, events_meta = old_val_frames$events_meta,
    priors = final_priors, position_weights = final_position_weights)
  old_scored <- score_predictions(old_pred, old_val_frames)
  old_summary <- summarize_scores(old_scored$event_level, character(0))
  cat("-- 2012-2018 result --\n"); print(as.data.frame(old_summary))
  saveRDS(old_scored, file.path(OPP$CACHE_DIR, "diagnostic_2012_2018.rds"))
}

# ---- 2026 forward diagnostic (frozen model, not retuned) ----
cat("\n=== 2026 forward diagnostic (frozen primary model, not retuned) ===\n")
fwd_ids <- onset_events %>% filter(meaningful_role_default, season == 2026, absence_multiplicity == "single_major_absence") %>% pull(absence_event_id)
cat(sprintf("2026 onset single-absence events: %d\n", length(fwd_ids)))
if (length(fwd_ids) > 0) {
  fwd_val_frames <- build_event_frames(fwd_ids, absence_events, domain_accounting, beneficiary_observations)
  fwd_pred <- OPP$MODEL_REGISTRY[[selected_model]](beneficiary_val = fwd_val_frames$beneficiary_observations,
    domain_accounting_val = fwd_val_frames$domain_accounting, events_meta = fwd_val_frames$events_meta,
    priors = final_priors, position_weights = final_position_weights)
  fwd_scored <- score_predictions(fwd_pred, fwd_val_frames)
  print(as.data.frame(summarize_scores(fwd_scored$event_level, character(0))))
  saveRDS(fwd_scored, file.path(OPP$CACHE_DIR, "diagnostic_2026_forward.rds"))
} else {
  cat("Insufficient 2026 qualified onset single-absence events for a forward diagnostic -- stated plainly, not fabricated.\n")
}

cat(sprintf("\nTotal Checkpoint C modeling runtime: %.1fs\n", as.numeric(difftime(Sys.time(), t0, units = "secs"))))
cat("Checkpoint C build complete.\n")
