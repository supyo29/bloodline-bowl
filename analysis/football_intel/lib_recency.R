# ===========================================================================
# Football Intelligence — recency weighting (spec §9) + uncertainty/shrinkage
# (spec §11) + trend (spec §12). Small, dependency-free, deterministic.
# ===========================================================================

suppressWarnings(suppressMessages({ library(dplyr) }))

# exponential recency weight for a game `h` weeks before the cutoff.
# half-life in games -> decay = 0.5^(1/halflife).
recency_weight <- function(weeks_ago, halflife) {
  d <- 0.5^(1 / halflife)
  ifelse(weeks_ago >= 0, d^weeks_ago, 0)
}

# In-season weighted mean of a game-level series with the single-game partial-
# pool guard (spec §9): the estimate may not move more than
# FI$RECENCY_SINGLE_GAME_CAP_SD pooled SDs due to any one game vs the estimate
# excluding it. `pooled_sd` is the league game-to-game SD of the metric.
recency_estimate <- function(values, weeks_ago, halflife, pooled_sd, cap_sd) {
  ok <- is.finite(values) & is.finite(weeks_ago)
  values <- values[ok]; weeks_ago <- weeks_ago[ok]
  if (length(values) == 0) return(list(estimate = NA_real_, n = 0, eff_n = 0))
  w <- recency_weight(weeks_ago, halflife)
  est <- sum(w * values) / sum(w)
  # leave-one-out cap
  if (length(values) >= 2 && is.finite(pooled_sd) && pooled_sd > 0) {
    for (i in seq_along(values)) {
      wi <- w[-i]; vi <- values[-i]
      loo <- sum(wi * vi) / sum(wi)
      lim <- cap_sd * pooled_sd
      if (is.finite(loo) && abs(est - loo) > lim) est <- loo + sign(est - loo) * lim
    }
  }
  eff_n <- sum(w)^2 / sum(w^2)      # Kish effective sample size
  list(estimate = est, n = length(values), eff_n = eff_n)
}

# --------------------------------------------------------------------------
# shrink an in-season estimate toward the prior, then the prior/estimate blend
# toward the league mean, by effective sample (spec §11).
#   obs      : in-season opponent-adjusted estimate (deviation scale)
#   eff_n    : effective in-season plays/games behind obs
#   prior    : prior_mean (deviation scale) or NA
#   prior_eff: discounted effective prior sample (plays/games)
#   league_mu: league mean on the same scale (usually 0 for deviation ratings)
#   k        : shrink strength (plays/games)
# returns list(estimate, prior_weight, recent_weight, shrunk_to_league)
# --------------------------------------------------------------------------
shrink_to <- function(obs, eff_n, prior, prior_eff, league_mu, k) {
  eff_n <- ifelse(is.finite(eff_n), eff_n, 0)
  has_prior <- is.finite(prior)
  has_obs <- is.finite(obs)
  if (!has_prior && !has_obs) return(list(estimate = league_mu, prior_weight = 0, recent_weight = 0, shrunk_to_league = 1))
  # step 1: blend obs and prior by their relative effective samples
  pe <- ifelse(has_prior && is.finite(prior_eff), max(prior_eff, 0), 0)
  wo <- ifelse(has_obs, eff_n, 0)
  denom <- wo + pe
  blend <- if (denom > 0) (wo * ifelse(has_obs, obs, 0) + pe * ifelse(has_prior, prior, 0)) / denom
           else league_mu
  # step 2: shrink the blend toward league mean by total effective sample vs k
  total_n <- denom
  wl <- total_n / (total_n + k)
  est <- wl * blend + (1 - wl) * league_mu
  list(estimate = est,
       prior_weight = if (denom > 0) pe / denom * wl else 0,
       recent_weight = if (denom > 0) wo / denom * wl else 0,
       shrunk_to_league = 1 - wl)
}

# confidence bucket from effective sample + discriminability. Vectorized.
#   discrim : the cross-team SD of the rating. If the estimate's SE exceeds it,
#             we cannot place the team within the league distribution -> knock
#             the bucket down one notch. (A team genuinely at league average is
#             still HIGH confidence when its SE is small — being average is a
#             confident conclusion, not an uncertain one.)
confidence_bucket <- function(eff_n, thresholds, se = NA_real_, discrim = NA_real_, obs_only = NULL) {
  eff_n <- as.numeric(eff_n)
  se <- rep_len(as.numeric(se), length(eff_n))
  discrim <- rep_len(as.numeric(discrim), length(eff_n))
  # HIGH requires real in-season corroboration, not prior alone (spec §20, §29).
  gate_high <- if (is.null(obs_only)) rep(TRUE, length(eff_n))
               else rep_len(as.numeric(obs_only), length(eff_n)) >= thresholds[["low"]]
  lvl <- ifelse(!is.finite(eff_n) | eff_n < thresholds[["insufficient"]], "INSUFFICIENT_SAMPLE",
         ifelse(eff_n >= thresholds[["medium"]] & gate_high, "HIGH",
         ifelse(eff_n >= thresholds[["low"]], "MEDIUM", "LOW")))
  knock <- is.finite(se) & is.finite(discrim) & discrim > 1e-9 & se > discrim
  lvl[knock & lvl == "HIGH"]   <- "MEDIUM"
  lvl[knock & lvl == "MEDIUM"] <- "LOW"
  lvl
}

# --------------------------------------------------------------------------
# trend (spec §12): modeled current level vs recent level, standardized.
#   current_level : full in-season posterior estimate
#   recent_est    : short-half-life estimate (recency_estimate w/ TREND halflife)
#   recent_eff_n  : its effective sample
#   pooled_sd     : league game-to-game SD
# --------------------------------------------------------------------------
trend_signal <- function(current_level, recent_est, recent_eff_n, pooled_sd, FI) {
  if (!is.finite(current_level) || !is.finite(recent_est) || !is.finite(pooled_sd) || pooled_sd <= 0)
    return(list(direction = "uncertain", magnitude = NA_real_, confidence = "INSUFFICIENT_SAMPLE",
                current_level = current_level, recent_level = recent_est))
  se <- pooled_sd / sqrt(max(recent_eff_n, 1))
  mag <- (recent_est - current_level)
  z <- mag / se
  dir <- if (!is.finite(z)) "uncertain"
         else if (se >= abs(mag) * FI$TREND_UNCERTAIN_SE_RATIO && abs(z) < 2) "uncertain"
         else if (abs(z) < FI$TREND_DEADBAND_SD) "stable"
         else if (z > 0) "improving" else "deteriorating"
  conf <- if (recent_eff_n < 1.5) "INSUFFICIENT_SAMPLE"
          else if (abs(z) >= 2) "HIGH" else if (abs(z) >= 1) "MEDIUM" else "LOW"
  list(direction = dir, magnitude = mag / pooled_sd, confidence = conf,
       current_level = current_level, recent_level = recent_est)
}
