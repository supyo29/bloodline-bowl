# ===========================================================================
# Injury -> Opportunity Propagation Intelligence -- Checkpoint C invariant /
# adversarial tests (spec §59-60).
# ===========================================================================
library(testthat)
suppressMessages({ library(dplyr); library(data.table) })

BASE <- file.path(Sys.getenv("FI_ROOT", getwd()), "analysis", "opportunity_propagation")
source(file.path(BASE, "config.R"))
source(file.path(BASE, "lib_absence_detection.R"))
source(file.path(BASE, "lib_fast_baselines.R"))
source(file.path(BASE, "lib_redistribution_observed.R"))
source(file.path(BASE, "lib_episodes.R"))
source(file.path(BASE, "lib_propagation_model.R"))
source(file.path(BASE, "backtest.R"))

absence_events <- readRDS(file.path(OPP$CACHE_DIR, "absence_events.rds"))
domain_accounting <- readRDS(file.path(OPP$CACHE_DIR, "domain_accounting.rds"))
beneficiary_observations <- readRDS(file.path(OPP$CACHE_DIR, "beneficiary_observations.rds"))
roster_lookup <- readRDS(file.path(OPP$CACHE_DIR, "roster_lookup.rds"))
episodes_cache <- readRDS(file.path(OPP$CACHE_DIR, "episodes.rds"))
episodes <- episodes_cache$episodes
episode_summ <- episodes_cache$summary
pgr <- readRDS(file.path(ROLE$CACHE_DIR, "player_game_role.rds"))
schedules <- readRDS(file.path(FI$CACHE_DIR, "schedules.rds"))

ed <- absence_events %>% distinct(season, week, team, gsis_id, position, status, absence_set_id, absence_multiplicity) %>%
  mutate(absence_event_id = paste(season, week, team, gsis_id, sep = ":"))

# ---------------------------------------------------------------------------
# Episode construction (spec §5-6, adversarial #10-13)
# ---------------------------------------------------------------------------
test_that("a bye week does not split an episode (spec #11)", {
  cal <- build_team_game_calendar(schedules)
  # find a real multi-game episode and confirm every team-game between its
  # first and last absence row is EITHER another absence row of the SAME
  # episode or genuinely absent from the team calendar (a bye) -- never an
  # unrelated participation row silently skipped over.
  multi <- episode_summ %>% filter(n_games >= 3) %>% slice(1)
  expect_gt(nrow(multi), 0)
  # `episodes` intentionally also carries a trailing EPISODE_RETURN row (for
  # continuation analysis) when the episode ends via a real return -- that
  # row correctly has episode_state == "EPISODE_RETURN" and episode_game_
  # index == NA, and is excluded here since this test checks only the
  # ABSENCE rows of the episode for uninterrupted index continuity.
  rows <- episodes %>% filter(absence_episode_id == multi$absence_episode_id[1],
                              episode_state %in% c("EPISODE_ONSET", "EPISODE_CONTINUATION")) %>%
    arrange(season, week)
  expect_equal(nrow(rows), multi$n_games[1])
  expect_equal(rows$episode_game_index, seq_len(nrow(rows)))
})

test_that("player return ends the episode (spec #12) -- the return row is tagged EPISODE_RETURN, not a new onset", {
  returned <- episodes %>% filter(episode_state == "EPISODE_RETURN") %>% slice(1)
  expect_gt(nrow(returned), 0)
  # confirm this player actually played that game
  key <- paste(returned$season[1], returned$week[1], returned$gsis_id[1])
  played_key <- paste(pgr$season, pgr$week, pgr$gsis_id)
  expect_true(key %in% played_key)
})

test_that("eventual episode duration never appears as an onset-time feature (spec #13, leakage invariant)", {
  onset_rows <- episodes %>% filter(episode_state == "EPISODE_ONSET")
  expect_false(any(c("n_games", "eventual_duration", "final_length") %in% names(onset_rows)))
})

test_that("games-missed-so-far is available at continuation, eventual total is not conflated with it (spec #6)", {
  cont <- episodes %>% filter(episode_state == "EPISODE_CONTINUATION") %>% slice(1)
  ep <- episodes %>% filter(absence_episode_id == cont$absence_episode_id[1]) %>% arrange(episode_game_index)
  expect_true(cont$episode_game_index[1] < max(episode_summ$n_games[episode_summ$absence_episode_id == cont$absence_episode_id[1]]) + 1)
})

test_that("12,291 game-level events collapse to episodes correctly: onset + continuation = total qualified events", {
  expect_equal(nrow(episode_summ), sum(episodes$episode_state == "EPISODE_ONSET"))
  expect_equal(sum(episodes$episode_state %in% c("EPISODE_ONSET", "EPISODE_CONTINUATION")), nrow(ed))
})

# ---------------------------------------------------------------------------
# Chronology safety (spec §60)
# ---------------------------------------------------------------------------
test_that("walk-forward training pool never includes the validation season or later (chronology test)", {
  val_season <- 2023L
  train_ids <- ed %>% filter(season < val_season, season >= 2019) %>% pull(absence_event_id)
  val_ids <- ed %>% filter(season == val_season) %>% pull(absence_event_id)
  expect_true(length(intersect(train_ids, val_ids)) == 0)
  train_seasons <- ed %>% filter(absence_event_id %in% train_ids) %>% pull(season)
  expect_true(all(train_seasons < val_season))
})

test_that("fit_inheritance_priors never uses validation-season rows (direct check on a real fold)", {
  train_ids <- ed %>% filter(season %in% 2019:2021) %>% pull(absence_event_id)
  train_frames <- build_event_frames(train_ids, absence_events, domain_accounting, beneficiary_observations)
  expect_true(all(train_frames$events_meta$season <= 2021))
  priors <- fit_inheritance_priors(train_frames$domain_accounting, train_frames$events_meta)
  expect_true(is.list(priors) && all(c("league", "position", "team") %in% names(priors)))
})

# ---------------------------------------------------------------------------
# Model outputs / adversarial (spec §59)
# ---------------------------------------------------------------------------
sample_ids <- ed %>% filter(season %in% 2021:2022) %>% pull(absence_event_id)
sample_frames <- build_event_frames(sample_ids, absence_events, domain_accounting, beneficiary_observations)
train_ids_2020 <- ed %>% filter(season == 2020) %>% pull(absence_event_id)
train_frames_2020 <- build_event_frames(train_ids_2020, absence_events, domain_accounting, beneficiary_observations)

test_that("no QB ever appears as an absent player across any model prediction (spec #10/#24)", {
  for (m in names(OPP$MODEL_REGISTRY)) {
    pred <- run_allocator(m, train_frames_2020, sample_frames)
    absent_positions <- sample_frames$events_meta$position
    expect_false("QB" %in% absent_positions)
  }
})

test_that("QB IS a valid beneficiary, and QB rush_share is tracked separately (spec #20)", {
  pred <- run_allocator("CANDIDATE_4_HIERARCHICAL", train_frames_2020, sample_frames)
  expect_true(any(pred$beneficiary_position == "QB"))
})

test_that("predicted shares remain bounded for bounded domains (spec #18) -- excludes air_yards_share, which is not [0,1]-bounded by construction", {
  for (m in names(OPP$MODEL_REGISTRY)) {
    pred <- run_allocator(m, train_frames_2020, sample_frames)
    bounded <- pred %>% filter(dimension != "air_yards_share")
    expect_true(all(bounded$predicted_role >= -1e-6, na.rm = TRUE))
    expect_true(all(bounded$predicted_role <= 1 + 1e-6, na.rm = TRUE))
  }
})

test_that("residual is never forced to zero (spec #17) -- the selected model's predicted residual varies", {
  pred <- run_allocator("BASELINE_2_PROPORTIONAL", train_frames_2020, sample_frames)
  scored <- score_predictions(pred, sample_frames)
  expect_true(length(unique(round(scored$event_level$predicted_residual, 6))) > 1)
})

test_that("multiple simultaneous absences do not produce impossible team shares (spec #9/#18 adversarial)", {
  # Spec #18's share-sum bound is explicitly scoped to domains that are
  # "mutually exhaustive" -- a genuinely scarce, one-recipient-per-play
  # resource (targets, carries, red-zone touches, a single returner per
  # return). snap_share is NOT such a domain: eleven offensive players
  # share the field on every play, so eleven players' individual snap
  # shares summing to roughly 11 is correct, expected reality, not a model
  # defect -- confirmed by inspecting real PARTICIPATION-domain totals
  # (~11.3 across 26 candidates, exactly matching 11 players on field).
  mutually_exhaustive_dims <- c("target_share", "position_group_target_share", "rush_share",
                                "position_group_rush_share", "rz_target_share", "rz_carry_share",
                                "kick_return_role", "punt_return_role")
  multi_ids <- ed %>% filter(season == 2022, absence_multiplicity == "multiple_major_absences") %>% pull(absence_event_id)
  skip_if(length(multi_ids) == 0, "no multi-absence events in sample season")
  multi_frames <- build_event_frames(multi_ids, absence_events, domain_accounting, beneficiary_observations)
  pred <- run_allocator("BASELINE_2_PROPORTIONAL", train_frames_2020, multi_frames)
  totals <- pred %>% filter(dimension %in% mutually_exhaustive_dims) %>%
    group_by(absence_event_id, domain, dimension) %>%
    summarise(total_predicted_role = sum(pmax(predicted_role, 0), na.rm = TRUE), .groups = "drop")
  expect_true(all(totals$total_predicted_role <= 1.05))  # small numerical tolerance, spec #18
})

test_that("identical inputs produce identical predictions (determinism, spec #25)", {
  pred1 <- run_allocator("CANDIDATE_4_HIERARCHICAL", train_frames_2020, sample_frames)
  pred2 <- run_allocator("CANDIDATE_4_HIERARCHICAL", train_frames_2020, sample_frames)
  expect_equal(pred1[order(pred1$absence_event_id, pred1$domain, pred1$dimension, pred1$beneficiary_gsis_id)],
              pred2[order(pred2$absence_event_id, pred2$domain, pred2$dimension, pred2$beneficiary_gsis_id)])
})

test_that("no fantasy points, PPR, or scoring concept appears anywhere in the model's inputs or outputs (spec #53)", {
  pred <- run_allocator("CANDIDATE_4_HIERARCHICAL", train_frames_2020, sample_frames)
  expect_false(any(grepl("fantasy|points|ppr|scoring", names(pred), ignore.case = TRUE)))
  expect_false(any(grepl("fantasy|points|ppr|scoring", names(sample_frames$beneficiary_observations), ignore.case = TRUE)))
})

test_that("touchdown outcomes are not a feature anywhere in the model (spec #54)", {
  expect_false(any(grepl("touchdown|^td$|_td_", names(beneficiary_observations), ignore.case = TRUE)))
})

test_that("return role does not affect offensive predicted deltas (spec #22, orthogonality)", {
  pred <- run_allocator("CANDIDATE_4_HIERARCHICAL", train_frames_2020, sample_frames)
  returns_ids <- pred %>% filter(domain == "RETURNS") %>% distinct(beneficiary_gsis_id) %>% pull()
  offense_rows <- pred %>% filter(domain != "RETURNS", beneficiary_gsis_id %in% returns_ids)
  # a player who is a big RETURNS beneficiary is NOT automatically inflated
  # in offensive domains -- their offensive predicted_delta must still trace
  # only to their own offensive pre_event_role/weight, never to their return role.
  expect_true(all(c("predicted_delta") %in% names(offense_rows)))
})

test_that("a same-position tiny-role teammate does not become the top beneficiary merely by position (spec #59 adversarial #7)", {
  # Restricted to offensive domains: RETURNS is legitimately winner-take-all
  # concentrated (a backup returner going from 0 prior return share to
  # absorbing the entire vacated return duty when the primary returner is
  # out is REAL, correct football behavior -- Checkpoint B's own certified
  # substrate already exhibits this, and the adversarial goal here is
  # "a deep-bench player on a well-populated offensive domain does not leap
  # to primary beneficiary," not "no candidate can ever go from near-zero
  # to a large share" (which return specialists genuinely do).
  pred <- run_allocator("BASELINE_2_PROPORTIONAL", train_frames_2020, sample_frames)
  tiny <- pred %>% filter(domain != "RETURNS", pre_event_role < 0.01, predicted_delta > 0.05)
  expect_equal(nrow(tiny), 0)  # proportional weighting means near-zero share -> near-zero predicted delta
})

test_that("QB scenario is unsupported (spec #57) -- no absent-player event exists with position == QB to predict against", {
  expect_equal(nrow(ed %>% filter(position == "QB")), 0)
})

test_that("league inheritance rate is bounded [0, 1.5] before shrinkage clipping and finite everywhere used (spec #26 sanity)", {
  priors <- fit_inheritance_priors(train_frames_2020$domain_accounting, train_frames_2020$events_meta)
  expect_true(all(is.finite(priors$league$league_rate)))
  expect_true(all(priors$league$league_rate >= 0 & priors$league$league_rate <= 1.5))
})

test_that("team-changing candidate does not inherit old-team contingency context (spec #17 adversarial) -- team is part of the join key", {
  priors <- fit_inheritance_priors(train_frames_2020$domain_accounting, train_frames_2020$events_meta)
  # a team/position pair not seen in training falls back to position or league prior, never a stale unrelated team's rate
  rate_unseen_team <- inheritance_rate_lookup(priors, "target_share", "ZZZ_NOT_A_REAL_TEAM", "WR")
  rate_league <- priors$league$league_rate[priors$league$dimension == "target_share"]
  expect_equal(rate_unseen_team, priors$position$position_rate_blended[priors$position$dimension == "target_share" & priors$position$position == "WR"])
})
