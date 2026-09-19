# Phase 3.5A Checkpoint F (D9): a Week-W feature row must be invariant to ANY data from week W .. end of
# season (and later seasons). Real cached data is mutated; a positive control proves the legacy
# whole-season construction DOES change under the same mutation (so the test can detect leakage).
suppressWarnings(suppressMessages({ library(dplyr); library(tidyr) }))
ROOT <- Sys.getenv("FI_ROOT")
FI_BASE <- file.path(ROOT, "analysis", "football_intel")
cache <- function(n) file.path(FI_BASE, "cache", paste0(n, ".rds"))
skip_if_no_cache <- function() skip_if_not(all(file.exists(cache(c("pbp", "schedules", "snap_counts", "rosters_weekly")))),
                                           "FI caches not present")
for (f in c("config.R", "lib_features.R", "lib_opponent_adj.R", "lib_priors.R", "lib_recency.R", "lib_continuity.R", "lib_profiles.R"))
  source(file.path(FI_BASE, f))
source(file.path(ROOT, "analysis", "football_intel_startsit", "discontinuity_asof.R"))

S <- 2024L; W <- 6L
world <- local({
  if (!all(file.exists(cache(c("pbp", "schedules", "snap_counts", "rosters_weekly"))))) return(NULL)
  list(
    pbp = readRDS(cache("pbp")) %>% filter(season %in% c(S - 1L, S, S + 1L)) %>%
      select(season, week, qb_dropback, passer_player_id, posteam),
    schedules = readRDS(cache("schedules")) %>% filter(season %in% c(S - 1L, S, S + 1L)),
    snap_counts = readRDS(cache("snap_counts")) %>% filter(season %in% c(S - 1L, S, S + 1L)),
    rosters_weekly = readRDS(cache("rosters_weekly")) %>% filter(season %in% c(S - 1L, S, S + 1L)))
})

# mutate EVERYTHING at/after the decision point: week >= W of season S, and all of season S+1
mutate_future <- function(w) {
  fut <- function(df) df$season > S | (df$season == S & df$week >= W)
  p <- w$pbp; i <- fut(p) & !is.na(p$passer_player_id); p$passer_player_id[i] <- paste0("FAKE_QB_", p$posteam[i])
  p$qb_dropback[fut(p)] <- 1
  s <- w$schedules; i <- fut(s); s$home_coach[i] <- "Fake Home Coach"; s$away_coach[i] <- "Fake Away Coach"
  n <- w$snap_counts; i <- fut(n)
  for (col in intersect(c("player", "pfr_player_id"), names(n))) n[[col]][i] <- paste0("FAKE_", seq_len(sum(i)))
  list(pbp = p, schedules = s, snap_counts = n, rosters_weekly = w$rosters_weekly)
}

test_that("as-of discontinuity table for Week W is invariant to all week >= W / later-season data", {
  skip_if_no_cache()
  w2 <- mutate_future(world)
  a <- build_discontinuity_table_asof(S, W, world$schedules, world$pbp, world$snap_counts, world$rosters_weekly, FI)
  b <- build_discontinuity_table_asof(S, W, w2$schedules, w2$pbp, w2$snap_counts, w2$rosters_weekly, FI)
  expect_identical(a, b)
  expect_true(nrow(a) > 0)
})

test_that("positive control: the LEGACY whole-season construction leaks (changes under the same mutation)", {
  skip_if_no_cache()
  w2 <- mutate_future(world)
  a <- build_discontinuity_table(S, world$schedules, world$pbp, world$snap_counts, world$rosters_weekly, tempfile(), FI)
  b <- build_discontinuity_table(S, w2$schedules, w2$pbp, w2$snap_counts, w2$rosters_weekly, tempfile(), FI)
  expect_false(isTRUE(all.equal(a, b)))
})

test_that("prior-discount tables inherit the isolation", {
  skip_if_no_cache()
  w2 <- mutate_future(world)
  a <- build_prior_discounts(build_discontinuity_table_asof(S, W, world$schedules, world$pbp, world$snap_counts, world$rosters_weekly, FI), FI)
  b <- build_prior_discounts(build_discontinuity_table_asof(S, W, w2$schedules, w2$pbp, w2$snap_counts, w2$rosters_weekly, FI), FI)
  expect_identical(a, b)
})

test_that("each week uses only its own past: W and W+1 tables may differ, W's never depends on W+1", {
  skip_if_no_cache()
  t6 <- build_discontinuity_table_asof(S, 6L, world$schedules, world$pbp, world$snap_counts, world$rosters_weekly, FI)
  # mutate only week 7+ : week 6 must not move
  w7 <- world
  i <- w7$pbp$season == S & w7$pbp$week >= 7L & !is.na(w7$pbp$passer_player_id)
  w7$pbp$passer_player_id[i] <- "X"
  t6b <- build_discontinuity_table_asof(S, 6L, w7$schedules, w7$pbp, w7$snap_counts, w7$rosters_weekly, FI)
  expect_identical(t6, t6b)
})

test_that("OC/DC change flags are UNSAFE_FOR_BACKTEST: always UNKNOWN in the as-of table", {
  skip_if_no_cache()
  a <- build_discontinuity_table_asof(S, W, world$schedules, world$pbp, world$snap_counts, world$rosters_weekly, FI)
  for (col in DISCONTINUITY_UNSAFE_FEATURES) expect_true(all(is.na(a[[col]])), info = col)
  expect_setequal(DISCONTINUITY_UNSAFE_FEATURES, c("offensive_coord_change", "defensive_coord_change"))
})

test_that("nothing from a later season or later week is visible (asof_visible)", {
  df <- data.frame(season = c(2023, 2024, 2024, 2024, 2025), week = c(18, 5, 6, 7, 1))
  v <- asof_visible(df, 2024L, 6L)
  expect_equal(nrow(v), 2L); expect_true(all(v$season < 2024 | v$week < 6))
})

test_that("full FI as-of feature row for (S,W) is invariant to week >= W data (team ratings + usage)", {
  skip_if_no_cache()
  skip_if_not(file.exists(cache("team_game_features")) && file.exists(cache("player_game_usage")), "FI feature caches missing")
  source(file.path(ROOT, "analysis", "football_intel_startsit", "fi_asof_features.R"))
  tgf <- readRDS(cache("team_game_features")) %>% filter(season_type == "REG")
  pgu <- readRDS(cache("player_game_usage"))
  SS <- new.env(); SS$SEASONS <- S; SS$MIN_WEEK <- W; SS$MAX_WEEK <- W - 1L; SS$TRAILING_HALFLIFE <- 4
  SS$FI_FAMILIES <- tibble::tribble(~family, ~kind, ~routing,
    "off_pass_epa", "team_off", "PREDICTIVE", "off_rush_epa", "team_off", "PREDICTIVE",
    "off_success_rate", "team_off", "PREDICTIVE", "def_success_allowed", "opp_def", "PREDICTIVE",
    "usage_snap_share", "player_usage", "PREDICTIVE", "usage_target_share", "player_usage", "PREDICTIVE",
    "usage_rush_share", "player_usage", "PREDICTIVE", "usage_route_participation", "player_usage", "PREDICTIVE")
  ps <- (S - FI$PRIOR_MAX_LOOKBACK):(S - 1); ps <- ps[ps >= min(FI$PBP_SEASONS)]
  pr <- list(); pr[[as.character(S)]] <- bind_rows(lapply(METRIC_SPECS, function(sp) season_ratings_for_metric(tgf, sp, FI, ps)))
  dc <- list(); dc[[as.character(S)]] <- tibble::tibble(team = character(), side = character(), prior_discount = numeric())
  asof <- list(); asof[[paste0(S, "|", W)]] <- tibble::tibble(team = character(), side = character(), prior_discount = numeric())
  run <- function(tgf_, pgu_) fi_asof_bundle(FI, SS, tgf_, pgu_, pr, dc, asof)

  # scramble every numeric metric for season S, week >= W
  scr <- function(df) {
    i <- df$season == S & df$week >= W
    for (col in names(df)[vapply(df, is.numeric, TRUE)]) if (!col %in% c("season", "week")) df[[col]][i] <- rev(df[[col]][i]) * 3 + 1
    df
  }
  a <- run(tgf, pgu); b <- run(scr(tgf), scr(pgu))
  expect_identical(a$team_asof, b$team_asof)
  expect_identical(a$usage_asof, b$usage_asof)
  expect_identical(a$interact_asof, b$interact_asof)
  expect_true(nrow(a$team_asof) > 0 && nrow(a$usage_asof) > 0)
  # positive control (D9b): without as-of truncation the pooled game SD leaks future weeks into confidence
  a0 <- fi_asof_bundle(FI, SS, tgf, pgu, pr, dc, NULL); b0 <- fi_asof_bundle(FI, SS, scr(tgf), scr(pgu), pr, dc, NULL)
  expect_false(identical(a0$team_asof$confidence, b0$team_asof$confidence))
})
