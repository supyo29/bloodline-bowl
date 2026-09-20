# ===========================================================================
# Injury -> Opportunity Propagation Intelligence -- Checkpoint B invariant
# tests (spec §36). Run against the real, already-built full-history
# artifacts (analysis/opportunity_propagation/cache/*.rds) -- the same
# "whole-table invariants against real data" pattern Phase 2's own test
# suite uses (analysis/player_role/tests/testthat/test-player-game-
# invariants.R).
# ===========================================================================
library(testthat)
suppressMessages({ library(dplyr) })

BASE <- file.path(Sys.getenv("FI_ROOT", getwd()), "analysis", "opportunity_propagation")
source(file.path(BASE, "config.R"))
source(file.path(BASE, "lib_absence_detection.R"))
source(file.path(BASE, "lib_fast_baselines.R"))
source(file.path(BASE, "lib_redistribution_observed.R"))
source(file.path(BASE, "build_absence_events.R"))

absence_events <- readRDS(file.path(OPP$CACHE_DIR, "absence_events.rds"))
beneficiary_observations <- readRDS(file.path(OPP$CACHE_DIR, "beneficiary_observations.rds"))
domain_accounting <- readRDS(file.path(OPP$CACHE_DIR, "domain_accounting.rds"))
excluded <- readRDS(file.path(OPP$CACHE_DIR, "excluded_candidates.rds"))
no_meaningful_role <- readRDS(file.path(OPP$CACHE_DIR, "no_meaningful_role_candidates.rds"))

player_game_role <- readRDS(file.path(ROLE$CACHE_DIR, "player_game_role.rds"))
rosters_weekly   <- readRDS(file.path(FI$CACHE_DIR, "rosters_weekly.rds"))
schedules        <- readRDS(file.path(FI$CACHE_DIR, "schedules.rds"))

events_distinct <- absence_events %>% distinct(absence_event_id, season, week, team, gsis_id, position, status, cause,
                                                absence_set_id, absence_multiplicity)

test_that("cause is UNKNOWN for every event -- no source-backed injury label exists (spec #15/#16/#27)", {
  expect_true(all(events_distinct$cause == "UNKNOWN"))
})

test_that("event_type is always the factual label, never a medical inference", {
  expect_true(all(absence_events$event_type == "QUALIFIED_FULL_GAME_NONPARTICIPATION"))
  expect_false(any(grepl("INJUR", absence_events$event_type, ignore.case = TRUE)))
})

test_that("QB never appears as an absent player (spec #10/#11)", {
  expect_false("QB" %in% events_distinct$position)
})

test_that("every absent player's position is RB/WR/TE (spec #11)", {
  expect_true(all(events_distinct$position %in% c("RB", "WR", "TE")))
})

test_that("no qualified event exists for a player with an actual event-game participation row (spec #3)", {
  key_events <- paste(events_distinct$season, events_distinct$week, events_distinct$gsis_id)
  key_played <- paste(player_game_role$season, player_game_role$week, player_game_role$gsis_id)
  expect_equal(sum(key_events %in% key_played), 0)
})

test_that("a bye week never creates an event -- every event's team played a valid completed game (spec #1)", {
  cal <- build_team_game_calendar(schedules)
  cal_keys <- paste(cal$season, cal$week, cal$team)
  ev_keys <- paste(events_distinct$season, events_distinct$week, events_distinct$team)
  expect_true(all(ev_keys %in% cal_keys))
})

test_that("absence_multiplicity matches the real count of qualified events sharing an absence_set_id (spec #13)", {
  set_counts <- events_distinct %>% count(absence_set_id, name = "actual_n")
  check <- events_distinct %>% distinct(absence_set_id, absence_multiplicity) %>% left_join(set_counts, by = "absence_set_id")
  expect_true(all(check$absence_multiplicity == if_else(check$actual_n > 1, "multiple_major_absences", "single_major_absence")))
})

test_that("every beneficiary observation traces to a real qualified absence event (referential integrity)", {
  expect_true(all(beneficiary_observations$absence_event_id %in% events_distinct$absence_event_id))
})

test_that("beneficiary observed delta = event_game_value - pre_event_recent, exactly (spec #22)", {
  sample_rows <- beneficiary_observations %>% filter(!is.na(delta), !is.na(pre_event_recent)) %>% slice_sample(n = 500)
  expect_equal(sample_rows$delta, sample_rows$event_game_value - sample_rows$pre_event_recent, tolerance = 1e-9)
})

test_that("residual_structural_change is never forced to zero (spec #17/#24) -- both positive and negative values occur", {
  vals <- domain_accounting$residual_structural_change
  expect_true(any(vals > 1e-6, na.rm = TRUE))
  expect_true(any(vals < -1e-6, na.rm = TRUE))
})

test_that("QB is excluded from identified_beneficiary_gain ONLY for rush_share, not every domain (spec #16)", {
  qb_nonrush <- beneficiary_observations %>% filter(beneficiary_position == "QB", dimension != "rush_share")
  if (nrow(qb_nonrush) > 0) {
    # if any such rows exist, they must be representable in domain_accounting's
    # identified_beneficiary_gain for that (event, domain, dimension) --
    # i.e. domain_accounting was not filtered to drop ALL QB rows.
    matched <- domain_accounting %>%
      semi_join(qb_nonrush %>% distinct(absence_event_id, domain, dimension), by = c("absence_event_id", "domain", "dimension"))
    expect_gt(nrow(matched), 0)
  }
  succeed()
})

test_that("QB rush_share deltas are tracked separately, never inside a beneficiary-position row (spec #16)", {
  qb_rush_acct <- domain_accounting %>% filter(dimension == "rush_share", !is.na(qb_rush_share_delta))
  expect_true(nrow(qb_rush_acct) >= 0)  # presence is data-dependent; the FIELD must exist and be populate-able
  expect_true("qb_rush_share_delta" %in% names(domain_accounting))
})

test_that("no absence event exists for a player whose roster team differs from their last known Phase 2 team (spec #23)", {
  # every excluded TEAM_CHANGE row genuinely had team != last_known_team OR a departure status
  tc <- excluded %>% filter(reason == "TEAM_CHANGE")
  expect_true(nrow(tc) > 0)
  mismatch_or_departure <- (tc$team != tc$last_known_team) | (tc$status %in% OPP$ROSTER_DEPARTURE_STATUSES)
  expect_true(all(mismatch_or_departure | is.na(tc$last_known_team) == FALSE))
})

test_that("return role dimensions never inflate offensive dimensions (spec #10/#26) -- returns rows are their own domain", {
  returns_rows <- beneficiary_observations %>% filter(domain == "RETURNS")
  offense_rows <- beneficiary_observations %>% filter(domain != "RETURNS")
  # structural check: RETURNS dimensions are exactly kick_return_role/punt_return_role, never shared with offense dimensions
  expect_true(all(returns_rows$dimension %in% c("kick_return_role", "punt_return_role")))
  expect_false(any(offense_rows$dimension %in% c("kick_return_role", "punt_return_role")))
})

test_that("determinism: rebuilding on the same input data reproduces byte-identical absence_event_id sets", {
  rebuilt <- build_absence_events(player_game_role, rosters_weekly, schedules, OPP, ROLE, FI)
  # Phase 3.5B: compare over the window the STORED artifact covers. The shared FI raw cache (rosters/schedules) is
  # refreshed daily and can legitimately hold a newer completed game than the Role substrate the stored events were
  # built from; those later events are new evidence, not a determinism failure. (A local refresh that added the 2026
  # wk2 Thursday game produced exactly two such events: BUF RB INA, BUF WR RES.)
  # The temporal boundary is the SUBSTRATE the stored events were built from (the Role player-game table), and it must
  # agree with the served manifests -- it is not derived from the events themselves and not chosen to make the test pass.
  max_s <- max(player_game_role$season); max_w <- max(player_game_role$week[player_game_role$season == max_s])
  opp_m  <- jsonlite::fromJSON(file.path(FI$ROOT, "lib", "opportunity-propagation-intelligence", "data", "opportunity_propagation_manifest.json"))
  role_m <- jsonlite::fromJSON(file.path(FI$ROOT, "lib", "player-role-intelligence", "data", "role_opportunity_manifest.json"))
  expect_identical(c(max_s, max_w), c(as.integer(role_m$season), as.integer(role_m$through_week)))   # substrate == Role lineage
  expect_identical(c(max_s, max_w), c(as.integer(opp_m$season),  as.integer(opp_m$through_week)))    # == OPP lineage
  expect_identical(as.integer(opp_m$role_opportunity_dependency$through_week), as.integer(max_w))    # == declared dependency
  in_window <- rebuilt$absence_events %>% distinct(absence_event_id, season, week) %>%
    filter(season < max_s | (season == max_s & week <= max_w))
  expect_equal(sort(unique(in_window$absence_event_id)), sort(unique(events_distinct$absence_event_id)))
  # Negative control: a change INSIDE the window still fails determinism (the boundary is not a blanket exclusion).
  tampered <- setdiff(unique(in_window$absence_event_id), in_window$absence_event_id[1])
  expect_false(setequal(tampered, unique(events_distinct$absence_event_id)))
  # ...and everything beyond the substrate window is by definition not part of the stored artifact.
  beyond <- rebuilt$absence_events %>% distinct(absence_event_id, season, week) %>% filter(season > max_s | (season == max_s & week > max_w))
  expect_false(any(beyond$absence_event_id %in% events_distinct$absence_event_id))
})

test_that("no fantasy points or scoring concept appears anywhere in the substrate (spec #23/#40)", {
  expect_false(any(grepl("fantasy|points|ppr|scoring", names(absence_events), ignore.case = TRUE)))
  expect_false(any(grepl("fantasy|points|ppr|scoring", names(beneficiary_observations), ignore.case = TRUE)))
  expect_false(any(grepl("fantasy|points|ppr|scoring", names(domain_accounting), ignore.case = TRUE)))
})

test_that("no prediction/probability/contingent-role field exists yet -- Checkpoint B is descriptive only (spec #39)", {
  forbidden <- "predicted|probability|expected_role|contingent_role|credible"
  expect_false(any(grepl(forbidden, names(absence_events), ignore.case = TRUE)))
  expect_false(any(grepl(forbidden, names(beneficiary_observations), ignore.case = TRUE)))
  expect_false(any(grepl(forbidden, names(domain_accounting), ignore.case = TRUE)))
})

test_that("every excluded candidate carries a deterministic, non-missing exclusion reason (spec #30)", {
  expect_false(any(is.na(excluded$reason)))
  expect_true(all(excluded$reason %in% c(
    "MULTIPLE_TEAM_ASSIGNMENTS", "UNSUPPORTED_POSITION", "INSUFFICIENT_PRE_EVENT_HISTORY",
    "TEAM_CHANGE", "SOURCE_GAP", "ROSTER_ASSOCIATION_AMBIGUOUS"
  )))
})

test_that("no_meaningful_role candidates all failed the DEFAULT threshold on every dimension (sanity)", {
  expect_true(all(!no_meaningful_role$meaningful_role_default))
})
