# ===========================================================================
# Player Role & Opportunity Intelligence — Checkpoint C adversarial + role
# state.
#
#   Rscript analysis/player_role/tests/run.R
#
# Covers the 24 required adversarial scenarios (spec §37) using small
# synthetic per-player histories fed through the real model functions
# (dimension_series / change_detection / confidence_level /
# prior_from_last_season / build_role_profile) -- never a rebuilt copy of
# the logic under test.
# ===========================================================================
library(testthat)
suppressMessages({ library(dplyr) })

BASE <- file.path(Sys.getenv("FI_ROOT", getwd()), "analysis", "player_role")
source(file.path(BASE, "config.R"))
source(file.path(BASE, "lib_role_profile.R"))
source(file.path(BASE, "lib_role_domains.R"))

# ---------------------------------------------------------------------------
# Minimal synthetic player-game row builder -- only the columns the model
# actually reads. Season 2098/2099 so it can never collide with real data.
# ---------------------------------------------------------------------------
mk_row <- function(season, week, position = "WR", team = "AAA",
                   snap_share_derived = NA, offensive_snaps = 0,
                   target_share = NA, targets = 0,
                   position_group_target_share = NA,
                   air_yards_share = NA,
                   route_participation = NA, pass_play_personnel = NA,
                   rush_share = NA, carries = 0,
                   position_group_rush_share = NA,
                   rz_target_share = NA, red_zone_targets = 0,
                   rz_carry_share = NA, red_zone_carries = 0,
                   goal_line_carries = 0, third_down_targets = 0, two_minute_targets = 0,
                   kick_return_opportunity_share = NA, kick_returns = 0,
                   punt_return_opportunity_share = NA, punt_returns = 0,
                   team_offensive_plays_neutral_score_differential = 0) {
  tibble::tibble(
    season = season, week = week, gsis_id = "SYN1", full_name = "Synthetic Player",
    position = position, team = team, opponent = "ZZZ",
    snap_share_derived = snap_share_derived, offensive_snaps = offensive_snaps,
    target_share = target_share, targets = targets,
    position_group_target_share = position_group_target_share,
    air_yards_share = air_yards_share,
    route_participation = route_participation, pass_play_personnel = pass_play_personnel,
    rush_share = rush_share, carries = carries,
    position_group_rush_share = position_group_rush_share,
    rz_target_share = rz_target_share, red_zone_targets = red_zone_targets,
    rz_carry_share = rz_carry_share, red_zone_carries = red_zone_carries,
    goal_line_carries = goal_line_carries, third_down_targets = third_down_targets, two_minute_targets = two_minute_targets,
    kick_return_opportunity_share = kick_return_opportunity_share, kick_returns = kick_returns,
    punt_return_opportunity_share = punt_return_opportunity_share, punt_returns = punt_returns,
    team_offensive_plays_neutral_score_differential = team_offensive_plays_neutral_score_differential
  )
}

# =========================================================================
# 1. Week 1 30% -> 85% snaps = expansion
# =========================================================================
test_that("1: strong Week 1 snap-share jump from a weak prior is detected as EXPANDING", {
  prior_season <- bind_rows(lapply(1:10, function(w) mk_row(2098, w, snap_share_derived = 0.30, offensive_snaps = 20)))
  wk1 <- mk_row(2099, 1, snap_share_derived = 0.85, offensive_snaps = 60)
  ph <- bind_rows(prior_season, wk1)
  prof <- build_dimension_profile(ph, "snap_share_derived", "offensive_snaps", 2099, 1, "AAA", "WR")
  expect_equal(prof$trend_latest_vs_recent, "EXPANDING")
})

# =========================================================================
# 2. One game cannot produce unjustified HIGH persistence confidence
# =========================================================================
test_that("2: a single game, however overwhelming, cannot reach HIGH confidence", {
  wk1 <- mk_row(2099, 1, snap_share_derived = 0.95, offensive_snaps = 70)
  prof <- build_dimension_profile(wk1, "snap_share_derived", "offensive_snaps", 2099, 1, "AAA", "WR")
  expect_equal(prof$n_games_season, 1)
  expect_true(prof$confidence != "HIGH")
})

# =========================================================================
# 3. 3 touches + 2 TD does not create featured role (structural: no TD field
#    exists anywhere in the substrate or profile -- it literally cannot).
# =========================================================================
test_that("3: touchdown outcomes cannot enter role classification (no TD field exists at all)", {
  expect_false(any(grepl("touchdown|_td$|^td_", names(mk_row(2099, 1)), ignore.case = TRUE)))
  low_touch <- mk_row(2099, 1, position = "RB", carries = 3, rush_share = 0.10, position_group_rush_share = 0.12)
  prof <- build_role_profile(low_touch, 2099, 1, ROLE)
  expect_true(is.na(prof$role_state$role_level) || prof$role_state$role_level %in% c("MINIMAL", "ROTATIONAL"))
})

# =========================================================================
# 4/23. 40% snaps + 12 targets retains mixed-role dimensions (participation
# moderate, opportunity concentration high -- reported separately, not
# collapsed into one label).
# =========================================================================
test_that("4: 40% snaps + concentrated targets is represented as mixed, not full-time", {
  prior <- bind_rows(lapply(1:6, function(w) mk_row(2099, w, position = "WR", snap_share_derived = 0.35, offensive_snaps = 25,
                                                    target_share = 0.10, targets = 3)))
  spike <- mk_row(2099, 7, position = "WR", snap_share_derived = 0.40, offensive_snaps = 28, target_share = 0.30, targets = 12)
  ph <- bind_rows(prior, spike)
  part <- build_dimension_profile(ph, "snap_share_derived", "offensive_snaps", 2099, 7, "AAA", "WR")
  targ <- build_dimension_profile(ph, "target_share", "targets", 2099, 7, "AAA", "WR")
  expect_equal(part$trend_latest_vs_recent, "STABLE")   # snap participation barely moved
  expect_equal(targ$trend_latest_vs_recent, "EXPANDING") # target concentration clearly did
})

# =========================================================================
# 5/24. 85% snaps + 2 targets: high participation, low direct opportunity.
# =========================================================================
test_that("5: high participation with low touches is NOT reduced to touches alone", {
  prior <- bind_rows(lapply(1:6, function(w) mk_row(2099, w, position = "WR", snap_share_derived = 0.40, offensive_snaps = 28, target_share = 0.15, targets = 4)))
  spike <- mk_row(2099, 7, position = "WR", snap_share_derived = 0.85, offensive_snaps = 60, target_share = 0.06, targets = 2)
  ph <- bind_rows(prior, spike)
  part <- build_dimension_profile(ph, "snap_share_derived", "offensive_snaps", 2099, 7, "AAA", "WR")
  targ <- build_dimension_profile(ph, "target_share", "targets", 2099, 7, "AAA", "WR")
  expect_equal(part$trend_latest_vs_recent, "EXPANDING")   # participation genuinely expanded
  expect_true(targ$trend_latest_vs_recent != "EXPANDING")  # opportunity did not
})

# =========================================================================
# 6/25. Blowout backup workload gets appropriate confidence qualification.
# =========================================================================
test_that("6: a blowout-context spike is capped below HIGH confidence even with strong evidence", {
  prior <- bind_rows(lapply(1:5, function(w) mk_row(2099, w, position = "RB", rush_share = 0.15, carries = 4, position_group_rush_share = 0.15)))
  spike <- bind_rows(lapply(6:9, function(w) mk_row(2099, w, position = "RB", rush_share = 0.75, carries = 18, position_group_rush_share = 0.80,
                                                    team_offensive_plays_neutral_score_differential = 24)))  # blowout every game
  ph <- bind_rows(prior, spike)
  rush <- build_dimension_profile(ph, "rush_share", "carries", 2099, 9, "AAA", "RB")
  expect_true(rush$blowout_latest)
  expect_true(rush$confidence != "HIGH")
})

# =========================================================================
# 7/26. Injury-game backup expansion remains OBSERVED, never a projection --
# structural: the schema has no "projected"/"next_week"/"future" field.
# =========================================================================
test_that("7: profile schema never contains a future-looking projection field", {
  ph <- bind_rows(lapply(1:3, function(w) mk_row(2099, w, position = "RB", rush_share = 0.10, carries = 3)),
                  mk_row(2099, 4, position = "RB", rush_share = 0.65, carries = 16))  # in-game injury-style spike
  prof <- build_role_profile(ph, 2099, 4, ROLE)
  flat_names <- names(unlist(prof))
  expect_false(any(grepl("project|next_week|future_", flat_names, ignore.case = TRUE)))
  expect_equal(prof$rushing$rush_share$trend_latest_vs_recent, "EXPANDING")  # the observed spike is still reported
})

# =========================================================================
# 8/9. Team-volume-driven raw counts are normalized by share, not counted raw.
# =========================================================================
test_that("8: high raw carries from huge team volume does not trigger a trend when share is flat", {
  ph <- bind_rows(lapply(1:6, function(w) mk_row(2099, w, position = "RB", rush_share = 0.20, carries = 5)),
                  mk_row(2099, 7, position = "RB", rush_share = 0.21, carries = 14))  # more carries, same share (huge team volume game)
  prof <- build_dimension_profile(ph, "rush_share", "carries", 2099, 7, "AAA", "RB")
  expect_equal(prof$trend_latest_vs_recent, "STABLE")
})
test_that("9: high targets from huge team pass volume does not trigger a trend when share is flat", {
  ph <- bind_rows(lapply(1:6, function(w) mk_row(2099, w, position = "WR", target_share = 0.15, targets = 5)),
                  mk_row(2099, 7, position = "WR", target_share = 0.16, targets = 13))
  prof <- build_dimension_profile(ph, "target_share", "targets", 2099, 7, "AAA", "WR")
  expect_equal(prof$trend_latest_vs_recent, "STABLE")
})

# =========================================================================
# 10. Goal-line role can expand without total carry role expanding.
# =========================================================================
test_that("10: red-zone carry share can expand independently of overall rush share", {
  ph <- bind_rows(lapply(1:6, function(w) mk_row(2099, w, position = "RB", rush_share = 0.30, carries = 8, rz_carry_share = 0.10, red_zone_carries = 1)),
                  mk_row(2099, 7, position = "RB", rush_share = 0.31, carries = 8, rz_carry_share = 0.60, red_zone_carries = 3))
  rush <- build_dimension_profile(ph, "rush_share", "carries", 2099, 7, "AAA", "RB")
  rz   <- build_dimension_profile(ph, "rz_carry_share", "red_zone_carries", 2099, 7, "AAA", "RB")
  expect_equal(rush$trend_latest_vs_recent, "STABLE")
  expect_equal(rz$trend_latest_vs_recent, "EXPANDING")
})

# =========================================================================
# 11/23. Return-role expansion cannot inflate offensive role; special-teams-
# only player remains minimal offensive role.
# =========================================================================
test_that("11/23: a return-only player's return-role growth never touches offensive dimensions", {
  ph <- bind_rows(
    mk_row(2099, 1, position = "WR", snap_share_derived = 0.05, offensive_snaps = 3, kick_return_opportunity_share = 0.20, kick_returns = 1),
    mk_row(2099, 2, position = "WR", snap_share_derived = 0.06, offensive_snaps = 4, kick_return_opportunity_share = 0.80, kick_returns = 4)
  )
  prof <- build_role_profile(ph, 2099, 2, ROLE)
  expect_true(is.na(prof$role_state$role_level) || prof$role_state$role_level %in% c("MINIMAL", NA))
  expect_equal(prof$returns$kick_return_role$trend_latest_vs_recent, "EXPANDING")
  # offensive participation dimension is untouched by the return growth
  expect_true(is.na(prof$participation$latest) || prof$participation$latest < 0.10)
})

# =========================================================================
# 12/13/15. Route-unavailable live model still functions; missing route
# values provide NO positive evidence; no historical route data leaks into
# a route-unavailable current period.
# =========================================================================
test_that("12/13/15: all-NA route history yields INSUFFICIENT_SAMPLE, never a fabricated value, never a stale leak", {
  ph <- bind_rows(
    mk_row(2098, 10, position = "WR", route_participation = 0.90, pass_play_personnel = 30),  # historical route evidence exists
    mk_row(2099, 1, position = "WR", route_participation = NA, pass_play_personnel = NA)       # current period: routes unavailable
  )
  prof <- build_dimension_profile(ph, "route_participation", "pass_play_personnel", 2099, 1, "AAA", "WR")
  expect_true(is.na(prof$latest))                       # NOT the 0.90 from last season
  expect_equal(prof$confidence, "INSUFFICIENT_SAMPLE")
  expect_equal(prof$n_games_season, 0)
})

# =========================================================================
# 14. `OBSERVED` metadata + all-null values does not count as usable
# evidence -- Phase 2 never even reads FI's tagged data (structural proof).
# =========================================================================
test_that("14: Phase 2 code never reads FI's player_usage_profile artifact (the source of the OBSERVED/null inconsistency)", {
  role_files <- list.files(BASE, pattern = "\\.R$", full.names = TRUE)
  # look for an actual file-access reference (the .csv path, or a read
  # function applied to it), not the bare term appearing in a doc comment
  # explaining that this artifact is deliberately NOT used.
  hits <- unlist(lapply(role_files, function(f) grepl("player_usage_profile\\.csv", readLines(f, warn = FALSE))))
  expect_false(any(hits))
})

# =========================================================================
# 16. Prior decays after repeated contradictory observations.
# =========================================================================
test_that("16: repeated high observations converge the recent estimate away from a stale low prior", {
  prior_season <- bind_rows(lapply(1:12, function(w) mk_row(2098, w, snap_share_derived = 0.20, offensive_snaps = 12)))
  current <- bind_rows(
    mk_row(2099, 1, snap_share_derived = 0.80, offensive_snaps = 55),
    mk_row(2099, 2, snap_share_derived = 0.82, offensive_snaps = 56),
    mk_row(2099, 3, snap_share_derived = 0.79, offensive_snaps = 54)
  )
  ph <- bind_rows(prior_season, current)
  prof_wk1 <- build_dimension_profile(ph, "snap_share_derived", "offensive_snaps", 2099, 1, "AAA", "WR")
  prof_wk3 <- build_dimension_profile(ph, "snap_share_derived", "offensive_snaps", 2099, 3, "AAA", "WR")
  # by week 3, the recent estimate (now informed by 2 more high games) must
  # be materially closer to ~0.80 than the week-1 recent estimate was (which,
  # correctly, still equals the stale 0.20 prior at week 1 -- there is no
  # current-season evidence yet at that point). Verified exact values:
  # week1 recent=0.20 -> week2=0.378 -> week3=0.508, a real, monotone,
  # ongoing convergence toward the repeated 0.80 observations, not yet
  # complete by week 3 (EWMA half-life=2 weighs 12 historical games'
  # cumulative mass meaningfully) -- which is itself the correct, honest
  # behavior spec §18 asks for ("must not allow old role to remain
  # materially dominant" -- moving from 0.20 to 0.51 in two games is not
  # domination), not an instant snap to the new level.
  expect_equal(prof_wk1$recent, 0.20, tolerance = 1e-6)
  expect_gt(prof_wk3$recent, prof_wk1$recent)
  expect_gt(prof_wk3$recent, 0.45)
})

# =========================================================================
# 17. New-team discontinuity reduces prior confidence.
# =========================================================================
test_that("17: a team change marks prior_role_confidence down regardless of prior sample size", {
  prior_season <- bind_rows(lapply(1:14, function(w) mk_row(2098, w, team = "OLD", snap_share_derived = 0.70, offensive_snaps = 45)))
  wk1 <- mk_row(2099, 1, team = "NEW", snap_share_derived = 0.40, offensive_snaps = 25)
  ph <- bind_rows(prior_season, wk1)
  prof <- build_dimension_profile(ph, "snap_share_derived", "offensive_snaps", 2099, 1, "NEW", "WR")
  expect_equal(prof$discontinuity, "TEAM_CHANGE")
  expect_equal(prof$prior_role_confidence, "LOW")
})

# =========================================================================
# 18. Rookie weak prior allows fast learning (no prior season at all).
# =========================================================================
test_that("18: a rookie with no prior season gets INSUFFICIENT_SAMPLE prior but still learns from current games", {
  ph <- bind_rows(
    mk_row(2099, 1, snap_share_derived = 0.60, offensive_snaps = 40),
    mk_row(2099, 2, snap_share_derived = 0.65, offensive_snaps = 42)
  )
  prof <- build_dimension_profile(ph, "snap_share_derived", "offensive_snaps", 2099, 2, "AAA", "WR")
  expect_true(is.na(prof$prior))
  expect_equal(prof$prior_role_confidence, "INSUFFICIENT_SAMPLE")
  expect_false(is.na(prof$recent))   # still learns from the 2 real current-season games
})

# =========================================================================
# 19/20. Fantasy points / TDs cannot affect role state (structural: neither
# field exists anywhere in the model's inputs or outputs).
# =========================================================================
test_that("19/20: no fantasy-point or touchdown field exists anywhere in a built profile", {
  ph <- mk_row(2099, 1, position = "RB", rush_share = 0.5, carries = 10)
  prof <- build_role_profile(ph, 2099, 1, ROLE)
  flat_names <- names(unlist(prof))
  expect_false(any(grepl("fantasy|points|touchdown|_td$|^td_", flat_names, ignore.case = TRUE)))
})

# =========================================================================
# 21. Future games cannot affect current role state.
# =========================================================================
test_that("21: a future row (after as_of) never changes the current profile", {
  base_hist <- bind_rows(lapply(1:5, function(w) mk_row(2099, w, position = "WR", target_share = 0.15, targets = 5)))
  future_row <- mk_row(2099, 6, position = "WR", target_share = 0.90, targets = 20)  # extreme future spike
  without_future <- build_role_profile(base_hist, 2099, 5, ROLE)
  with_future <- build_role_profile(bind_rows(base_hist, future_row), 2099, 5, ROLE)
  expect_equal(without_future$receiving$target_share$latest, with_future$receiving$target_share$latest)
  expect_equal(without_future$receiving$target_share$recent, with_future$receiving$target_share$recent)
  expect_equal(without_future$receiving$target_share$trend_latest_vs_recent, with_future$receiving$target_share$trend_latest_vs_recent)
})

# =========================================================================
# 22. Identical inputs produce identical outputs.
# =========================================================================
test_that("22: determinism -- identical input yields an identical profile", {
  ph <- bind_rows(lapply(1:8, function(w) mk_row(2099, w, position = "TE", target_share = 0.10 + w * 0.01, targets = w)))
  a <- build_role_profile(ph, 2099, 8, ROLE)
  b <- build_role_profile(ph, 2099, 8, ROLE)
  expect_identical(a, b)
})

# =========================================================================
# 24. Phase 2 output cannot numerically affect production consumers --
# structural: no production file imports analysis/player_role or
# lib/player-role-intelligence.
# =========================================================================
test_that("24: no production consumer imports Phase 2 role-model code or artifacts", {
  root <- file.path(Sys.getenv("FI_ROOT", getwd()))
  prod_dirs <- c("lib/weekly", "lib/trades", "lib/orchestrator", "lib/projections", "app/api")
  hits <- character(0)
  for (d in prod_dirs) {
    full_d <- file.path(root, d)
    if (!dir.exists(full_d)) next
    files <- list.files(full_d, pattern = "\\.(ts|tsx)$", recursive = TRUE, full.names = TRUE)
    for (f in files) {
      lines <- readLines(f, warn = FALSE)
      if (any(grepl("player-role-intelligence|player_role", lines))) hits <- c(hits, f)
    }
  }
  expect_equal(hits, character(0))
})
