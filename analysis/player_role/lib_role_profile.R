# ===========================================================================
# Player Role & Opportunity Intelligence — Checkpoint C role-profile model.
#
# Converts Checkpoint B's player-game evidence into an uncertainty-aware
# description of role, role change, and confidence. NO shrinkage toward a
# league mean (unlike FI), NO fantasy points, NO role classification beyond
# a descriptive vector, NO production wiring. Every dimension exposes
# latest/recent/season/prior + trend + confidence, per spec §6/§35.
#
# Recency choice (backtested, not assumed -- see backtest.R / Checkpoint C
# report): EWMA half-life = 2 games wins or ties every candidate estimator
# (latest game, 2/3-game simple average, EWMA hl 1/2/3, season-to-date
# average) across every dimension tested, walk-forward, on 2012-2025. It is
# never more than ~3% worse than that dimension's individually-optimal
# half-life. One consistent half-life is used everywhere for auditability.
# ===========================================================================

suppressWarnings(suppressMessages({ library(dplyr); library(tidyr) }))

ROLE$RECENT_HALFLIFE_GAMES <- 2   # backtested; see docs/PLAYER_ROLE_OPPORTUNITY_PHASE_2_CHECKPOINT_C.md

# Explicit-weight EWMA -- identical function used by the backtest (no drift
# between what was validated and what runs live).
ewma_through <- function(x, halflife) {
  x <- x[!is.na(x)]
  n <- length(x)
  if (n == 0) return(NA_real_)
  k <- (n - 1):0
  w <- 0.5^(k / halflife)
  sum(w * x) / sum(w)
}

# ---------------------------------------------------------------------------
# role_level(): position/domain-specific band, from EMPIRICAL quantiles of
# the historical (2012-2025) distribution for players with any nonzero
# opportunity in that dimension (never an arbitrary guess -- see Checkpoint C
# report §"role level thresholds" for the exact quantiles measured).
# ---------------------------------------------------------------------------
ROLE$LEVEL_THRESHOLDS <- list(
  target_share_WR              = c(0.047, 0.114, 0.163, 0.243),
  target_share_TE              = c(0.029, 0.071, 0.115, 0.186),
  target_share_RB              = c(0.02, 0.06, 0.10, 0.18),
  rush_share_RB                = c(0.105, 0.318, 0.524, 0.742),
  snap_share_derived_skill     = c(0.153, 0.448, 0.677, 0.897),
  position_group_rush_share_RB = c(0.12, 0.36, 0.591, 0.833),
  position_group_target_share_WR = c(0.10, 0.235, 0.333, 0.48),
  position_group_target_share_TE = c(0.10, 0.235, 0.333, 0.48)  # WR thresholds reused for TE position-group (no separate TE-only quantile computed; documented approximation)
)
role_level <- function(value, thresholds) {
  if (is.na(value)) return(NA_character_)
  labels <- c("MINIMAL", "ROTATIONAL", "REGULAR", "FEATURED", "PRIMARY")
  idx <- sum(value > thresholds) + 1
  labels[min(idx, length(labels))]
}

# ---------------------------------------------------------------------------
# dimension_series(): the generic per-dimension builder. `df` is one
# player's rows, ordered chronologically, already filtered to season <=
# as_of_season & (season < as_of_season | week <= as_of_week).
# `opp_col` is the accompanying raw opportunity COUNT column (targets,
# carries, offensive_snaps, ...) used for magnitude+sample gating (spec
# §11: never percentage deltas alone).
# ---------------------------------------------------------------------------
dimension_series <- function(df, col, opp_col, as_of_season, as_of_week) {
  x <- df[[col]]
  opp <- if (!is.null(opp_col) && opp_col %in% names(df)) df[[opp_col]] else rep(NA_real_, length(x))
  valid <- !is.na(x)

  # `latest` is the AS-OF ROW'S OWN value -- never a stale carry-forward from
  # an earlier valid observation. This is the specific fix for a real bug
  # found while testing: route_participation is NA for every 2026 row (see
  # Checkpoint B / spec §2), but an earlier version of this function used
  # "most recent non-NA value in history," which silently reached back to
  # the player's LAST 2025 game and reported it as "latest" -- exactly the
  # "pretend routes were observed" failure mode spec §20/§14 (invariant
  # test) explicitly forbids. If the current game's own value for this
  # metric is NA, `latest` MUST be NA, full stop.
  as_of_idx <- which(df$season == as_of_season & df$week == as_of_week)
  latest <- if (length(as_of_idx) == 1) x[as_of_idx] else NA_real_
  opportunity_latest <- if (length(as_of_idx) == 1) opp[as_of_idx] else NA_real_

  # `recent`/`season` are BASELINES computed from history STRICTLY BEFORE
  # the as-of game -- deliberately excluding the very game `latest`
  # represents. This is a second real design fix made during testing: a
  # baseline that already contains today's game (heavily weighted, since
  # EWMA puts maximum weight on the most recent observation) is barely
  # distinguishable from `latest` itself, defeating the entire point of a
  # "latest vs recent baseline" change comparison (spec §10's own example:
  # "latest 0.82" vs "recent 0.69" are clearly two DIFFERENT observations,
  # not the same one echoed back). `season` therefore also only becomes
  # defined from a player's SECOND game of a season onward -- correct,
  # since "how does this game compare to what he'd shown already this
  # season" is undefined before a second data point exists.
  before <- (df$season < as_of_season) | (df$season == as_of_season & df$week < as_of_week)
  valid_before <- valid & before

  # confidence/evidence-volume figures use history THROUGH the as-of game
  # (including it) -- this is "how much do we know about this player's role
  # right now," which is a different question from "what was the baseline
  # BEFORE this game" used for the recent/season comparison values above.
  through <- (df$season < as_of_season) | (df$season == as_of_season & df$week <= as_of_week)
  valid_through <- valid & through
  season_rows_through <- df$season == as_of_season & valid_through
  n_games_season <- sum(season_rows_through)
  opportunity_total <- sum(opp[season_rows_through], na.rm = TRUE)

  if (!any(valid_before)) {
    return(list(latest = latest, recent = NA_real_, season = NA_real_,
               n_games_season = n_games_season, n_games_total = sum(valid_through),
               opportunity_total = opportunity_total, opportunity_latest = opportunity_latest))
  }
  x_valid <- x[valid_before]
  season_rows_before <- df$season == as_of_season & valid_before
  list(
    latest = latest,
    recent = ewma_through(x_valid, ROLE$RECENT_HALFLIFE_GAMES),
    season = if (any(season_rows_before)) mean(x[season_rows_before], na.rm = TRUE) else NA_real_,
    n_games_season = n_games_season,
    n_games_total = sum(valid_through),
    opportunity_total = opportunity_total,
    opportunity_latest = opportunity_latest
  )
}

# ---------------------------------------------------------------------------
# change_detection(): magnitude AND sample-gated, per spec §10-11. Never
# declares a trend from a share movement alone -- also requires the
# opportunity count backing it to be non-trivial, and the movement to clear
# a minimum absolute-share threshold (relative/percentage deltas on tiny
# bases, e.g. 1%->3%, are deliberately NOT sufficient on their own).
# ---------------------------------------------------------------------------
ROLE$MIN_SHARE_DELTA <- 0.08     # 8 percentage points minimum to call a share move "material"
ROLE$MIN_OPPORTUNITY_FOR_TREND <- 3  # at least 3 opportunities (targets/carries/snaps) backing the move

change_detection <- function(latest, baseline, opportunity_latest) {
  if (is.na(latest) || is.na(baseline)) return(list(delta = NA_real_, trend = "UNCERTAIN"))
  delta <- latest - baseline
  material <- abs(delta) >= ROLE$MIN_SHARE_DELTA && !is.na(opportunity_latest) && opportunity_latest >= ROLE$MIN_OPPORTUNITY_FOR_TREND
  trend <- if (!material) "STABLE" else if (delta > 0) "EXPANDING" else "CONTRACTING"
  list(delta = delta, trend = trend)
}

# ---------------------------------------------------------------------------
# confidence(): dimension-level confidence. Deliberately cannot reach HIGH
# from a single game, from historical prior alone, or from an isolated
# spike with no corroboration -- these are hard caps, not just unlikely
# outcomes (spec §19, adversarial tests #2/#3/#19).
# ---------------------------------------------------------------------------
confidence_level <- function(n_games_season, opportunity_total, corroboration_count = 0, blowout_latest = FALSE) {
  tier <- .confidence_level_raw(n_games_season, opportunity_total, corroboration_count)
  # Blowout qualifier (spec §21/§25): a game whose average score differential
  # on this player's team's offensive snaps exceeds FI's own neutral-script
  # threshold (FI$NEUTRAL_MAX_ABS_SCORE_DIFF = 16 -- reused, not
  # reinvented) has its persistence confidence capped at MEDIUM even if raw
  # evidence volume would otherwise justify HIGH. The usage itself is never
  # erased -- only the confidence that it will PERSIST is qualified.
  if (blowout_latest && tier == "HIGH") return("MEDIUM")
  tier
}
.confidence_level_raw <- function(n_games_season, opportunity_total, corroboration_count) {
  if (n_games_season == 0 || opportunity_total == 0) return("INSUFFICIENT_SAMPLE")
  if (n_games_season == 1) {
    # one game can be MEDIUM if the participation evidence itself is
    # substantial, but never HIGH -- persistence is inherently unproven.
    return(if (opportunity_total >= 10) "MEDIUM" else "LOW")
  }
  if (n_games_season %in% c(2, 3)) {
    return(if (corroboration_count >= 2 && opportunity_total >= 15) "MEDIUM" else "LOW")
  }
  # n_games_season >= 4: HIGH requires real corroboration, not just games elapsed.
  if (corroboration_count >= 2 && opportunity_total >= 20) return("HIGH")
  "MEDIUM"
}

# ---------------------------------------------------------------------------
# prior_from_last_season(): the pre-current-season expectation, with an
# explicit discontinuity discount for team/position changes (spec §16).
# Returns NULL role value (not 0, not carried at full strength) with
# `prior_role_confidence` separated from current confidence, per spec.
# ---------------------------------------------------------------------------
prior_from_last_season <- function(df_prior_season, col, current_team, current_position) {
  if (is.null(df_prior_season) || nrow(df_prior_season) == 0) {
    return(list(value = NA_real_, prior_role_confidence = "INSUFFICIENT_SAMPLE", discontinuity = "ROOKIE_OR_NO_PRIOR_SEASON"))
  }
  x <- df_prior_season[[col]]
  x <- x[!is.na(x)]
  if (length(x) == 0) return(list(value = NA_real_, prior_role_confidence = "INSUFFICIENT_SAMPLE", discontinuity = "NO_PRIOR_EVIDENCE_THIS_METRIC"))

  last_team <- tail(df_prior_season$team, 1)
  last_position <- tail(df_prior_season$position, 1)
  team_changed <- !is.na(last_team) && !is.na(current_team) && last_team != current_team
  position_changed <- !is.na(last_position) && !is.na(current_position) && last_position != current_position

  raw <- ewma_through(x, ROLE$RECENT_HALFLIFE_GAMES)  # prior = the player's OWN recent role at the end of last season
  discontinuity <- if (position_changed) "POSITION_CHANGE" else if (team_changed) "TEAM_CHANGE" else "NONE"

  # Discontinuity discount: prior VALUE is retained (it is still the best
  # available historical evidence -- spec §16 explicitly says historical
  # ability may inform uncertainty), but prior_role_confidence is marked
  # down hard. It is never silently carried as current-team truth.
  conf <- if (discontinuity == "NONE") {
    if (length(x) >= 4) "MEDIUM" else "LOW"
  } else "LOW"

  list(value = raw, prior_role_confidence = conf, discontinuity = discontinuity)
}

# ---------------------------------------------------------------------------
# build_dimension_profile(): assembles one full dimension's latest/recent/
# season/prior + delta + trend + confidence -- the unit every domain below
# is built from.
# ---------------------------------------------------------------------------
build_dimension_profile <- function(df_current_and_prior, col, opp_col, as_of_season, as_of_week,
                                    current_team, current_position, corroboration_count = 0) {
  df_through <- df_current_and_prior %>%
    filter(season < as_of_season | (season == as_of_season & week <= as_of_week)) %>%
    arrange(season, week)
  df_current_season <- df_through %>% filter(season == as_of_season)
  df_prior_season <- df_through %>% filter(season == as_of_season - 1)

  series <- dimension_series(df_through, col, opp_col, as_of_season, as_of_week)
  prior <- prior_from_last_season(df_prior_season, col, current_team, current_position)

  latest_vs_recent <- change_detection(series$latest, series$recent, series$opportunity_latest)
  latest_vs_season <- change_detection(series$latest, series$season, series$opportunity_latest)
  recent_vs_prior  <- change_detection(series$recent, prior$value, series$opportunity_total)

  as_of_row <- df_through %>% filter(season == as_of_season, week == as_of_week)
  score_ctx <- if (nrow(as_of_row) == 1) as_of_row$team_offensive_plays_neutral_score_differential[1] else NA_real_
  blowout_latest <- !is.na(score_ctx) && abs(score_ctx) > FI$NEUTRAL_MAX_ABS_SCORE_DIFF

  conf <- confidence_level(series$n_games_season, series$opportunity_total, corroboration_count, blowout_latest)

  list(
    latest = series$latest, recent = series$recent, season = series$season, prior = prior$value,
    prior_role_confidence = prior$prior_role_confidence, discontinuity = prior$discontinuity,
    n_games_season = series$n_games_season, opportunity_total = series$opportunity_total,
    blowout_latest = blowout_latest,
    delta_latest_vs_recent = latest_vs_recent$delta, trend_latest_vs_recent = latest_vs_recent$trend,
    delta_latest_vs_season = latest_vs_season$delta, trend_latest_vs_season = latest_vs_season$trend,
    delta_recent_vs_prior = recent_vs_prior$delta, trend_recent_vs_prior = recent_vs_prior$trend,
    evidence_state = if (series$n_games_season == 0) "INSUFFICIENT_SAMPLE" else if (series$n_games_season < 2) "TENTATIVE" else "OBSERVED",
    confidence = conf
  )
}

# ---------------------------------------------------------------------------
# corroboration_count(): how many of a set of dimension trend results agree
# in the same direction (spec §12). A single EXPANDING dimension alone is
# weak; several moving together is strong -- computed BEFORE confidence so
# confidence can use it (two-pass: rough trend first, then confidence).
# ---------------------------------------------------------------------------
corroboration_count <- function(trend_list) {
  trends <- unlist(trend_list)
  max(sum(trends == "EXPANDING"), sum(trends == "CONTRACTING"))
}
