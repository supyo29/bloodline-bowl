#!/usr/bin/env Rscript
# ===========================================================================
# Injury -> Opportunity Propagation Intelligence -- Checkpoint D.
# Generates a small, fully deterministic, synthetic fixture exercising:
#   (a) the mandatory NSE regression case (spec §24/§50): two groups
#       (team AAA vs BBB, same dimension/position) with KNOWN, DIFFERENT
#       historical inheritance rates, neither equal to the 0.5 global
#       default, run through the REAL served lookup path
#       (`attach_inheritance_rate`) -- not a grep, not a reimplementation.
#   (b) R/TS numeric parity (spec §40): RB absence, WR absence, TE absence,
#       cross-position receiving, return role, and a sparse-hierarchy
#       fallback case (an unseen team/position falling through to the
#       position or league prior), each run through the REAL
#       allocate_candidate4_hierarchical() R function end-to-end.
#
# Writes analysis/opportunity_propagation/tests/fixtures/
# r_ts_parity_fixture.json, consumed by both
# tests/testthat/test-nse-regression-and-parity.R (re-verifies the SAME
# fixture against the R function) and
# test/opportunity-propagation-r-ts-parity.test.ts (verifies the TS port
# against the identical fixture, spec §40/§51).
# ===========================================================================

suppressWarnings(suppressMessages({ library(dplyr); library(data.table); library(jsonlite) }))

.here <- sub("^--file=", "", grep("^--file=", commandArgs(FALSE), value = TRUE))
.opp_dir <- if (nzchar(.here)) dirname(.here) else file.path(getwd(), "analysis", "opportunity_propagation")
source(file.path(.opp_dir, "config.R"))
source(file.path(.opp_dir, "lib_fast_baselines.R"))
source(file.path(.opp_dir, "lib_redistribution_observed.R"))
source(file.path(.opp_dir, "lib_propagation_model.R"))

# ---- fixture priors: hand-authored, deterministic, KNOWN values --------
priors <- list(
  league = data.table(dimension = c("target_share", "rush_share", "kick_return_role"),
                      league_rate = c(0.90, 0.80, 0.70), n_league = c(50L, 50L, 20L)),
  position = data.table(
    dimension = c("target_share", "target_share", "target_share", "rush_share", "rush_share"),
    position = c("WR", "TE", "RB", "RB", "TE"),
    position_rate_blended = c(0.85, 0.95, 0.75, 0.78, 0.60)
  ),
  team = data.table(
    dimension = c("target_share", "target_share", "rush_share"),
    team = c("AAA", "BBB", "AAA"),
    position = c("WR", "WR", "RB"),
    team_rate_blended = c(1.20, 0.65, 0.95),  # AAA/WR (X=1.20) != BBB/WR (Y=0.65); neither is 0.5
    n_team = c(10L, 10L, 8L)
  )
)
position_weights <- data.table(dimension = c("target_share", "rush_share", "kick_return_role"),
                               same_position_multiplier = c(1.3, 1.5, 1.1))

OPP$MEANINGFUL_ROLE_THRESHOLDS <- OPP$MEANINGFUL_ROLE_THRESHOLDS  # unchanged; fixture does not touch qualification

# ---- NSE regression case: the exact lookup path the live model uses ----
rate_aaa <- inheritance_rate_lookup(priors, "target_share", "AAA", "WR")
rate_bbb <- inheritance_rate_lookup(priors, "target_share", "BBB", "WR")
rate_unseen_team <- inheritance_rate_lookup(priors, "target_share", "ZZZ", "WR")     # -> position prior (0.85)
rate_unseen_position <- inheritance_rate_lookup(priors, "rush_share", "ZZZ", "QB")   # -> league prior (0.80), QB has no position row
rate_unknown_dimension <- inheritance_rate_lookup(priors, "no_such_dimension", "AAA", "WR")  # -> global default 0.5

nse_case <- list(
  rate_team_AAA_WR_target_share = rate_aaa, rate_team_BBB_WR_target_share = rate_bbb,
  rate_unseen_team_falls_to_position_prior = rate_unseen_team,
  rate_unseen_position_falls_to_league_prior = rate_unseen_position,
  rate_unknown_dimension_falls_to_global_default = rate_unknown_dimension
)
stopifnot(rate_aaa != rate_bbb, rate_aaa != 0.5, rate_bbb != 0.5, rate_unknown_dimension == 0.5)
cat("NSE regression case computed:", jsonlite::toJSON(nse_case, auto_unbox = TRUE), "\n")

# ---- full-allocator scenarios, run through the REAL R function ---------
make_scenario <- function(name, team, absent_position, dimension, vacated, candidates) {
  events_meta <- data.table(absence_event_id = "fixture_event", team = team, position = absent_position)
  domain_accounting_val <- data.table(absence_event_id = "fixture_event", domain = "FIXTURE", dimension = dimension, vacated_opportunity = vacated)
  beneficiary_val <- rbindlist(lapply(candidates, function(c) {
    data.table(absence_event_id = "fixture_event", domain = "FIXTURE", dimension = dimension,
              beneficiary_gsis_id = c$id, beneficiary_position = c$position,
              pre_event_recent = c$pre_event_recent, pre_event_season = c$pre_event_season)
  }))
  pred <- allocate_candidate4_hierarchical(beneficiary_val, domain_accounting_val, events_meta, priors, position_weights)
  # apply the SAME bounds/renormalization the served backtest applies (clip_predicted_shares logic, reproduced minimally here since this fixture generator doesn't source backtest.R's data.table-scoped helpers)
  bounded <- dimension != "air_yards_share"
  if (bounded) pred[, predicted_role := pmin(pmax(predicted_role, 0), 1)]
  mutually_exhaustive <- c("target_share", "position_group_target_share", "rush_share", "position_group_rush_share",
                          "rz_target_share", "rz_carry_share", "kick_return_role", "punt_return_role")
  if (dimension %in% mutually_exhaustive) {
    group_total <- sum(pmax(pred$predicted_role, 0))
    if (group_total > 1) pred[, predicted_role := predicted_role / group_total]
  }
  pred[, predicted_delta := predicted_role - pre_event_role]
  list(
    name = name, team = team, absent_position = absent_position, dimension = dimension, vacated_opportunity = vacated,
    candidates = candidates,
    expected_predictions = lapply(seq_len(nrow(pred)), function(i) list(
      gsis_id = pred$beneficiary_gsis_id[i], position = pred$beneficiary_position[i],
      pre_event_role = pred$pre_event_role[i], predicted_role = pred$predicted_role[i], predicted_delta = pred$predicted_delta[i]
    ))
  )
}

scenarios <- list(
  make_scenario("RB_absence_rushing", "AAA", "RB", "rush_share", 0.55,
               list(list(id = "RB2", position = "RB", pre_event_recent = 0.20, pre_event_season = 0.15),
                    list(id = "RB3", position = "RB", pre_event_recent = 0.05, pre_event_season = 0.06),
                    list(id = "QB1", position = "QB", pre_event_recent = 0.08, pre_event_season = 0.08))),
  make_scenario("WR_absence_cross_position_receiving", "AAA", "WR", "target_share", 0.30,
               list(list(id = "WR2", position = "WR", pre_event_recent = 0.18, pre_event_season = 0.14),
                    list(id = "TE1", position = "TE", pre_event_recent = 0.10, pre_event_season = 0.09),
                    list(id = "RB1", position = "RB", pre_event_recent = 0.06, pre_event_season = 0.07))),
  make_scenario("TE_absence", "BBB", "TE", "target_share", 0.15,
               list(list(id = "WR3", position = "WR", pre_event_recent = 0.12, pre_event_season = 0.10),
                    list(id = "TE2", position = "TE", pre_event_recent = 0.03, pre_event_season = 0.02))),
  make_scenario("return_role_independent", "AAA", "WR", "kick_return_role", 0.65,
               list(list(id = "WR4", position = "WR", pre_event_recent = 0.02, pre_event_season = 0.01),
                    list(id = "RB4", position = "RB", pre_event_recent = 0.30, pre_event_season = 0.28))),
  make_scenario("sparse_hierarchy_fallback_unseen_team", "ZZZ", "WR", "target_share", 0.25,
               list(list(id = "WR5", position = "WR", pre_event_recent = 0.15, pre_event_season = 0.15),
                    list(id = "TE3", position = "TE", pre_event_recent = 0.05, pre_event_season = 0.05)))
)

fixture <- list(
  priors = list(league = priors$league, position = priors$position, team = priors$team),
  position_weights = position_weights,
  nse_regression_case = nse_case,
  scenarios = scenarios
)

out_dir <- file.path(.opp_dir, "tests", "fixtures")
dir.create(out_dir, showWarnings = FALSE, recursive = TRUE)
out_path <- file.path(out_dir, "r_ts_parity_fixture.json")
write(jsonlite::toJSON(fixture, auto_unbox = TRUE, pretty = TRUE, digits = 15), out_path)
cat("Wrote", out_path, "\n")
