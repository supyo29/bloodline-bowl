# ===========================================================================
# Football Intelligence — historical priors (spec §8, §13, §14, §22).
#
# A team unit's rating ENTERS a season as a decayed blend of its prior-season
# opponent-adjusted ratings, then moves toward the current season as in-season
# plays accumulate (the move itself is done in lib_uncertainty::shrink_to).
#
#   prior_mean_s = sum_k  w_k * rating_{s-k}   / sum_k w_k
#   w_k = lambda^(k-1),  k = 1..PRIOR_MAX_LOOKBACK   (k=1 is last season)
#
# The prior's EFFECTIVE SAMPLE is discounted by discontinuity (spec §13/§14):
# new HC/OC/DC, QB change, low OL continuity, high front/secondary turnover.
# Each active discontinuity MULTIPLIES the effective prior sample by its
# factor (< 1). Multiplicative, not additive; not a hand-tuned "score".
# ===========================================================================

suppressWarnings(suppressMessages({ library(dplyr) }))

# prior_ratings: tibble(season, team, side, metric, rating, n_eff_plays)
#   -- one row per completed season, the season-total opponent-adjusted rating.
# target_season: integer
# returns tibble(team, side, metric, prior_mean, prior_n_seasons, prior_weight_sum)
build_season_priors <- function(prior_ratings, target_season, FI) {
  lam <- FI$PRIOR_DECAY_LAMBDA
  maxlb <- FI$PRIOR_MAX_LOOKBACK
  prior_ratings %>%
    filter(season < target_season, season >= target_season - maxlb, is.finite(rating)) %>%
    mutate(k = target_season - season, w = lam^(k - 1)) %>%
    group_by(team, side, metric) %>%
    summarise(prior_mean = sum(w * rating) / sum(w),
              prior_n_seasons = dplyr::n(),
              prior_weight_sum = sum(w),
              .groups = "drop")
}

# discontinuity_table: tibble(team, side, head_coach_change, offensive_coord_change,
#   defensive_coord_change, starting_qb_change, ol_continuity, front_turnover,
#   secondary_turnover)  -- booleans / [0,1] continuity shares
# returns tibble(team, side, prior_discount)  in (0, 1]
build_prior_discounts <- function(discontinuity_table, FI) {
  f <- FI$DISCONTINUITY_FACTOR
  discontinuity_table %>%
    rowwise() %>%
    mutate(prior_discount = {
      d <- 1
      if (isTRUE(head_coach_change))                                   d <- d * f$head_coach_change
      if (side == "offense" && isTRUE(offensive_coord_change))         d <- d * f$offensive_coord_change
      if (side == "defense" && isTRUE(defensive_coord_change))         d <- d * f$defensive_coord_change
      if (side == "offense" && isTRUE(starting_qb_change))             d <- d * f$starting_qb_change
      if (side == "offense" && is.finite(ol_continuity) &&
          ol_continuity < FI$OL_CONTINUITY_LOW_THRESHOLD)              d <- d * f$ol_continuity_low
      if (side == "defense" && is.finite(front_turnover) &&
          front_turnover > FI$UNIT_TURNOVER_HIGH_THRESHOLD)            d <- d * f$front_turnover_high
      if (side == "defense" && is.finite(secondary_turnover) &&
          secondary_turnover > FI$UNIT_TURNOVER_HIGH_THRESHOLD)        d <- d * f$secondary_turnover_high
      d
    }) %>%
    ungroup() %>%
    select(team, side, prior_discount)
}
