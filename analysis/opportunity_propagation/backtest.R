# ===========================================================================
# Injury -> Opportunity Propagation Intelligence -- Checkpoint C walk-forward
# backtest harness (spec §30-38, §41).
#
# Chronology-safe: for a validation season Y, every prior fitted (priors,
# position weights) uses ONLY onset events with season < Y. Never Y itself,
# never a later season. 2026 and 2012-2018 are evaluated SEPARATELY as
# diagnostics after model selection on the 2019-2025 primary window, never
# used to select or tune anything (spec §9/§32-33).
# ===========================================================================

suppressWarnings(suppressMessages({ library(dplyr); library(data.table) }))

# ---------------------------------------------------------------------------
# build_event_frames(): assembles the three frames every allocator needs,
# restricted to a given set of absence_event_ids (an onset subset, a
# single/multi-absence subset, a season range, etc.) -- pure filtering of
# Checkpoint B's cached substrate, never a recomputation.
# ---------------------------------------------------------------------------
build_event_frames <- function(event_ids, absence_events, domain_accounting, beneficiary_observations) {
  events_meta <- absence_events %>% filter(absence_event_id %in% event_ids) %>%
    distinct(absence_event_id, season, week, team, gsis_id, position, status, absence_set_id, absence_multiplicity)
  da <- domain_accounting %>% filter(absence_event_id %in% event_ids)
  bo <- beneficiary_observations %>% filter(absence_event_id %in% event_ids)
  list(events_meta = events_meta, domain_accounting = da, beneficiary_observations = bo)
}

# ---------------------------------------------------------------------------
# run_allocator(): fits (if the allocator needs fitted priors) on TRAIN
# frames and predicts on VAL frames, for one named model.
# ---------------------------------------------------------------------------
run_allocator <- function(model_name, train_frames, val_frames) {
  fn <- OPP$MODEL_REGISTRY[[model_name]]
  priors <- NULL; position_weights <- NULL
  if (model_name %in% c("BASELINE_3_CONTINGENCY_SHRUNK", "CANDIDATE_4_HIERARCHICAL")) {
    priors <- fit_inheritance_priors(train_frames$domain_accounting, train_frames$events_meta)
  }
  if (model_name == "CANDIDATE_4_HIERARCHICAL") {
    position_weights <- fit_position_relationship_weights(train_frames$beneficiary_observations, train_frames$events_meta)
  }
  pred <- fn(beneficiary_val = val_frames$beneficiary_observations, domain_accounting_val = val_frames$domain_accounting,
            events_meta = val_frames$events_meta, priors = priors, position_weights = position_weights)
  clip_predicted_shares(pred)
}

# ---------------------------------------------------------------------------
# clip_predicted_shares(): spec §18's share-bound requirement, applied
# uniformly to every allocator's output. A model whose inheritance rate can
# exceed 1.0 (Baseline 3 / Candidate 4 deliberately allow this at the
# TEAM/domain level, since Checkpoint B found beneficiaries collectively
# over-absorb the vacated share on average -- a real football-volume
# effect, not an error) can otherwise push an INDIVIDUAL beneficiary's own
# predicted_role above 1 -- a single player's own share must still never
# exceed 1, regardless of what the aggregate rate implies. air_yards_share
# is exempt: it is not bounded in [0,1] by construction (individual plays
# can have negative air yards, so a team's or player's air-yards SHARE can
# legitimately be negative -- see Checkpoint B report's domain-accounting
# note), so clipping it to [0,1] would misrepresent real, valid data.
# ---------------------------------------------------------------------------
clip_predicted_shares <- function(pred) {
  pred <- as.data.table(pred)
  bounded <- pred$dimension != "air_yards_share"
  pred[bounded, predicted_role := pmin(pmax(predicted_role, 0), 1)]

  # spec §18's team-share bound ("sum predicted team shares <= 1 + tolerance")
  # applies only to MUTUALLY EXHAUSTIVE domains -- a genuinely scarce,
  # one-recipient-per-play resource (targets, carries, red-zone touches, a
  # single returner per return). snap_share is explicitly excluded: eleven
  # offensive players share the field on every play, so eleven players'
  # individual shares correctly sum to roughly 11, not <=1 -- that is real
  # football structure, not a defect (see test-checkpoint-c-invariants.R's
  # comment on the same point). Even within a mutually-exhaustive domain,
  # each candidate's OWN pre-event EWMA is computed independently against
  # their OWN history (Phase 2, never renormalized against teammates), so
  # if return/target duty rotated across several players within the recency
  # window, several candidates' pre_event_recent values can each be
  # substantial at once and their naive sum can exceed 1 even before any
  # redistribution. Rather than leave that structurally-possible violation
  # in the output, a final proportional RENORMALIZATION is applied: if a
  # group's predicted_role sum exceeds 1, every row in that group is scaled
  # down by the same factor so the group sums to exactly 1 -- the simplest
  # fix that provably restores the bound without discarding any candidate's
  # relative ranking within the group.
  mutually_exhaustive_dims <- c("target_share", "position_group_target_share", "rush_share",
                                "position_group_rush_share", "rz_target_share", "rz_carry_share",
                                "kick_return_role", "punt_return_role")
  pred[dimension %in% mutually_exhaustive_dims,
      group_total := sum(pmax(predicted_role, 0), na.rm = TRUE), by = .(absence_event_id, domain, dimension)]
  pred[dimension %in% mutually_exhaustive_dims & group_total > 1,
      predicted_role := predicted_role / group_total]
  pred[, group_total := NULL]

  pred[, predicted_delta := predicted_role - pre_event_role]
  pred
}

# ---------------------------------------------------------------------------
# score_predictions(): joins a model's predictions against the OBSERVED
# beneficiary deltas and domain residual, then computes every metric in
# spec §34-36 at the (absence_event_id, domain, dimension) grain, plus a
# predicted residual (vacated - sum of predicted positive deltas) compared
# against the OBSERVED residual_structural_change.
# ---------------------------------------------------------------------------
score_predictions <- function(predicted, val_frames) {
  pred <- as.data.table(predicted)
  actual <- as.data.table(val_frames$beneficiary_observations)[, .(absence_event_id, domain, dimension, beneficiary_gsis_id, actual_delta = delta)]
  joined <- merge(pred, actual, by = c("absence_event_id", "domain", "dimension", "beneficiary_gsis_id"), all = TRUE)
  joined[is.na(predicted_delta), predicted_delta := 0]
  joined[is.na(actual_delta), actual_delta := 0]
  joined[, abs_err := abs(predicted_delta - actual_delta)]

  vac <- as.data.table(val_frames$domain_accounting)[, .(absence_event_id, domain, dimension, vacated_opportunity, residual_structural_change)]
  event_level <- joined[, .(sum_predicted_positive = sum(pmax(predicted_delta, 0), na.rm = TRUE),
                            l1_beneficiary = sum(abs_err, na.rm = TRUE),
                            n_beneficiaries = .N,
                            top_pred_id = beneficiary_gsis_id[which.max(predicted_delta)],
                            top_actual_id = beneficiary_gsis_id[which.max(actual_delta)],
                            top2_pred = list(beneficiary_gsis_id[order(-predicted_delta)][1:min(2, .N)]),
                            top2_actual = list(beneficiary_gsis_id[order(-actual_delta)][1:min(2, .N)])),
                        by = .(absence_event_id, domain, dimension)]
  event_level <- merge(event_level, vac, by = c("absence_event_id", "domain", "dimension"), all.x = TRUE)
  event_level[, predicted_residual := vacated_opportunity - sum_predicted_positive]
  event_level[, residual_abs_err := abs(predicted_residual - residual_structural_change)]
  event_level[, l1_distribution_error := l1_beneficiary + residual_abs_err]
  event_level[, top_beneficiary_correct := !is.na(top_pred_id) & !is.na(top_actual_id) & top_pred_id == top_actual_id]
  event_level[, top2_recall := mapply(function(p, a) length(intersect(p, a)) / max(1, min(2, length(a))), top2_pred, top2_actual)]

  list(event_level = event_level, beneficiary_level = joined)
}

# ---------------------------------------------------------------------------
# summarize_scores(): aggregate metrics by an arbitrary grouping (domain,
# season, single/multi, confidence bucket, ...) -- spec §35's "do not
# collapse all domains into one headline score."
# ---------------------------------------------------------------------------
summarize_scores <- function(event_level, group_cols) {
  event_level %>% group_by(across(all_of(group_cols))) %>%
    summarise(
      n_events = n(),
      mean_l1_distribution_error = mean(l1_distribution_error, na.rm = TRUE),
      median_l1_distribution_error = median(l1_distribution_error, na.rm = TRUE),
      mean_beneficiary_mae = mean(l1_beneficiary / pmax(n_beneficiaries, 1), na.rm = TRUE),
      top_beneficiary_accuracy = mean(top_beneficiary_correct, na.rm = TRUE),
      top2_recall = mean(top2_recall, na.rm = TRUE),
      mean_residual_abs_err = mean(residual_abs_err, na.rm = TRUE),
      .groups = "drop"
    )
}

# ---------------------------------------------------------------------------
# walk_forward_backtest(): the primary chronology-safe walk-forward driver.
# `onset_ids_by_season` = named list/vector mapping absence_event_id -> season
# (ONSET events only, spec §7/§31). Trains on all seasons < val_season within
# `train_seasons_pool` (e.g. 2019:(val_season-1)), predicts on val_season.
# ---------------------------------------------------------------------------
walk_forward_backtest <- function(model_names, val_seasons, absence_events, domain_accounting, beneficiary_observations,
                                  onset_event_ids, event_season) {
  results <- vector("list", length(model_names) * length(val_seasons))
  idx <- 0L
  for (val_season in val_seasons) {
    train_ids <- onset_event_ids[event_season < val_season & event_season >= 2019]
    val_ids <- onset_event_ids[event_season == val_season]
    if (length(train_ids) == 0 || length(val_ids) == 0) next
    train_frames <- build_event_frames(train_ids, absence_events, domain_accounting, beneficiary_observations)
    val_frames <- build_event_frames(val_ids, absence_events, domain_accounting, beneficiary_observations)
    for (model_name in model_names) {
      idx <- idx + 1L
      pred <- run_allocator(model_name, train_frames, val_frames)
      scored <- score_predictions(pred, val_frames)
      el <- scored$event_level %>% mutate(model = model_name, val_season = val_season, n_train_events = length(train_ids))
      results[[idx]] <- el
    }
  }
  dplyr::bind_rows(results[seq_len(idx)])
}
