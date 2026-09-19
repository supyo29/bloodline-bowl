# Adversarial matrix, eligibility items 1-10 (Phase 3.5A). Pure: no I/O.
source(file.path(Sys.getenv("FI_ROOT"), "analysis", "football_intel_startsit", "evidence_gate.R"))

TEAMS <- c("AAA", "BBB", "CCC", "DDD")
mk_week <- function(week, scheduled = 2L, completed = scheduled, teams = TEAMS) {
  state <- if (completed == 0) "NOT_STARTED" else if (completed == scheduled) "COMPLETE" else "PARTIAL"
  list(week = week, scheduled = scheduled, completed = completed, state = state, teams = as.list(teams))
}
mk_reality <- function(...) list(available = TRUE, weeks = list(...))
mk_nflverse <- function(sched, pbp) list(sched_games = sched, pbp_games = pbp)
mk_fi <- function(season = 2026L, through = 3L, latest_done = 2L, current = season) list(
  season = season, through_week = through, seasons_used = list(current = current),
  week_completion = list(games_completed_in_latest_week = latest_done))
act <- function(week, teams = TEAMS) data.frame(week = week, team = teams, act_ppr = 10)
base <- function(w) list(live_captured_by_week = setNames(list(3L), as.character(w)))

# a fully valid W=4 world: weeks 1-4 complete, FI through 3 (wk3 complete, 2 games), actuals + live baseline
full_reality <- function() mk_reality(mk_week(1), mk_week(2), mk_week(3), mk_week(4))
full_nfl <- function() mk_nflverse(list(`1` = 2L, `2` = 2L, `3` = 2L, `4` = 2L), list(`1` = 2L, `2` = 2L, `3` = 2L, `4` = 2L))
ev <- function(week = 4L, reality = full_reality(), nflverse = full_nfl(), fi = mk_fi(through = 3L, latest_done = 2L),
               actuals = act(4L), baseline = base(4L))
  evaluate_week_evidence(week, 2026L, reality, nflverse, fi, actuals, baseline)

test_that("4. entire week complete + valid FI + actuals + baseline -> counts", {
  e <- ev(); expect_true(e$counts); expect_length(e$reasons, 0)
  expect_true(all(unlist(e$predicates)))
})

test_that("1. no PBP -> week does not count", {
  e <- ev(nflverse = mk_nflverse(list(`4` = 2L), list()))
  expect_false(e$counts); expect_false(e$predicates$NFL_WEEK_COMPLETE)
  expect_true(any(grepl("^PBP_INCOMPLETE_0_OF_2", e$reasons)))
})

test_that("2. one Thursday game complete -> does not count", {
  r <- mk_reality(mk_week(1), mk_week(2), mk_week(3), mk_week(4, scheduled = 16L, completed = 1L))
  e <- ev(reality = r, nflverse = mk_nflverse(list(`4` = 16L), list(`4` = 1L)))
  expect_false(e$counts); expect_false(e$predicates$NFL_WEEK_COMPLETE)
  expect_true("WEEK_PARTIAL_1_OF_16_GAMES" %in% e$reasons)
  expect_false(e$predicates$ACTUALS_AVAILABLE)  # actuals are not final for a partial week
})

test_that("3. 15/16 games complete -> does not count", {
  r <- mk_reality(mk_week(1), mk_week(2), mk_week(3), mk_week(4, scheduled = 16L, completed = 15L))
  e <- ev(reality = r, nflverse = mk_nflverse(list(`4` = 16L), list(`4` = 15L)))
  expect_false(e$counts); expect_true("WEEK_PARTIAL_15_OF_16_GAMES" %in% e$reasons)
})

test_that("5. week complete but baseline missing -> does not count", {
  e <- ev(baseline = list(live_captured_by_week = list()))
  expect_false(e$counts); expect_false(e$predicates$PRODUCTION_BASELINE_AVAILABLE)
  expect_true(e$predicates$NFL_WEEK_COMPLETE)
})

test_that("6. week complete but actuals missing -> does not count", {
  e <- ev(actuals = NULL)
  expect_false(e$counts); expect_false(e$predicates$ACTUALS_AVAILABLE); expect_true("ACTUALS_MISSING" %in% e$reasons)
  e2 <- ev(actuals = act(4L, teams = c("AAA", "BBB")))   # only some teams have actuals
  expect_false(e2$counts); expect_true(any(grepl("ACTUALS_TEAM_COVERAGE_MISSING_2", e2$reasons)))
})

test_that("7. prior-only FI never counts as current-season FI", {
  e <- ev(fi = mk_fi(season = 2025L, through = 18L, current = 2025L))
  expect_false(e$predicates$CURRENT_SEASON_FI_AVAILABLE); expect_false(e$predicates$FI_ASOF_AVAILABLE)
  expect_true("FI_PRIOR_SEASON_ONLY" %in% e$reasons); expect_false(e$counts)
  # a 2026-labelled manifest whose `seasons_used$current` is not 2026 is also prior-only
  e2 <- ev(fi = mk_fi(season = 2026L, current = 2025L)); expect_false(e2$counts)
  # and no FI at all
  e3 <- ev(fi = NULL); expect_false(e3$counts); expect_true("FI_MANIFEST_MISSING" %in% e3$reasons)
})

test_that("8. FI ahead of NFL reality -> fail closed", {
  # FI says through week 4 but reality has only completed weeks 1-3
  r <- mk_reality(mk_week(1), mk_week(2), mk_week(3), mk_week(4, completed = 0L))
  e <- ev(week = 3L, reality = r, fi = mk_fi(through = 4L, latest_done = 2L), actuals = act(3L), baseline = base(3L))
  expect_true("FI_AHEAD_OF_REALITY" %in% e$reasons); expect_false(e$counts)
  # FI claims more completed games in the latest week than reality has
  r2 <- mk_reality(mk_week(1), mk_week(2), mk_week(3), mk_week(4, scheduled = 16L, completed = 1L))
  e2 <- ev(reality = r2, fi = mk_fi(through = 4L, latest_done = 9L)); expect_true("FI_AHEAD_OF_REALITY" %in% e2$reasons)
})

test_that("9. schedule-source disagreement -> fail closed", {
  e <- ev(nflverse = mk_nflverse(list(`1` = 2L, `2` = 2L, `3` = 2L, `4` = 3L), list(`4` = 2L)))
  expect_false(e$counts); expect_false(e$predicates$NFL_WEEK_COMPLETE)
  expect_true(any(grepl("^SCHEDULE_SOURCE_DISAGREEMENT", e$reasons)))
})

test_that("10. postponed/rescheduled game -> not prematurely complete", {
  # 1 of 2 games 'complete'; the other postponed -> state PARTIAL, never COMPLETE
  r <- mk_reality(mk_week(1), mk_week(2), mk_week(3), mk_week(4, scheduled = 2L, completed = 1L))
  e <- ev(reality = r); expect_false(e$counts); expect_true("WEEK_PARTIAL_1_OF_2_GAMES" %in% e$reasons)
  # game rescheduled out of the week: reality shows 1 scheduled/1 complete but nflverse still lists 2
  r2 <- mk_reality(mk_week(1), mk_week(2), mk_week(3), mk_week(4, scheduled = 1L, completed = 1L))
  e2 <- ev(reality = r2); expect_false(e2$counts); expect_true(any(grepl("SCHEDULE_SOURCE_DISAGREEMENT_2_VS_1", e2$reasons)))
})

test_that("reality unavailable -> every week fails closed", {
  e <- ev(reality = list(available = FALSE, weeks = list())); expect_false(e$counts)
  expect_true("REALITY_UNAVAILABLE" %in% e$reasons)
})

test_that("current data: week 1 and 2 cannot qualify (no prior FI period / partial week)", {
  r <- mk_reality(mk_week(1, 16L), mk_week(2, 16L, 1L))
  n <- mk_nflverse(list(`1` = 16L, `2` = 16L), list(`1` = 16L, `2` = 1L))
  fi <- mk_fi(through = 2L, latest_done = 1L)
  for (w in 1:2) {
    e <- evaluate_week_evidence(w, 2026L, r, n, fi, act(w), base(w)); expect_false(e$counts)
  }
})

test_that("gate count is derived from per-week evidence and respects the minimum", {
  g <- evaluate_evidence_gate(c(3L, 4L), 2026L, full_reality(), full_nfl(), mk_fi(through = 3L, latest_done = 2L),
                              act(4L), base(4L), min_weeks = 4L)
  # wk3 lacks actuals+baseline, wk4 is fully valid -> exactly one qualifying week, below the 4-week minimum
  expect_equal(g$completed_weeks, 4L); expect_false(g$eligible)
  g1 <- evaluate_evidence_gate(c(3L, 4L), 2026L, full_reality(), full_nfl(), mk_fi(through = 3L, latest_done = 2L),
                               act(4L), base(4L), min_weeks = 1L)
  expect_true(g1$eligible)
})
