# ---------------------------------------------------------------------------
# lib_ri_projection.R
#
# Faithful R port of the production RI "core" projection
# (lib/projections/backtest.ts :: projectCoreForSeason). Used by
# phase2_calibration.R to sweep shrinkage K and formula families over held-out
# seasons WITHOUT re-running the TypeScript engine. Parity with production is
# asserted against outputs/projections-2026/production_ri_core.csv.
#
# Scoring is PPR-neutral (Layer 1): matches lib/projections/model.ts :: pprPoints.
# ---------------------------------------------------------------------------

RECENCY_BY_GAP <- c(0.55, 0.30, 0.15, 0.06, 0.03) # gap 0 == target_season - 1

recency_weight <- function(gap) {
  ifelse(gap >= 0 & gap <= 4, RECENCY_BY_GAP[pmin(pmax(gap, 0), 4) + 1], 0)
}

# Production fixed position baselines (lib/projections/baselines.ts).
POSITION_BASELINE <- list(
  QB = list(ypa = 7.1, int_per_att = 0.024, availability = 0.86,
            pass_td_per_att = 0.045, rush_td_per_att = 0.03, rush_ypc = 4.4,
            fum_lost_per_touch = 0.011),
  RB = list(catch_rate = 0.76, ypt = 6.4, ypc = 4.3,
            rec_td_per_rz_target = 0.16, rush_td_per_rz_carry = 0.20,
            availability = 0.80, fum_lost_per_touch = 0.006),
  WR = list(catch_rate = 0.63, ypt = 8.4, ypc = 6.5,
            rec_td_per_rz_target = 0.20, rush_td_per_rz_carry = 0.25,
            availability = 0.85, fum_lost_per_touch = 0.004),
  TE = list(catch_rate = 0.66, ypt = 7.6, ypc = 3.5,
            rec_td_per_rz_target = 0.22, rush_td_per_rz_carry = 0.20,
            availability = 0.86, fum_lost_per_touch = 0.004)
)

# Production shrinkage strengths K (lib/projections/baselines.ts SHRINKAGE_K).
# QB pass-TD / rush-TD use hard-coded 120 / 80 in projectCoreForSeason.
DEFAULT_K <- list(
  catch_rate = 24, ypt = 40, ypc = 55, ypa = 60,
  rush_td_rate = 60, rec_td_rate = 55, int_rate = 90, availability = 6,
  qb_pass_td = 120, qb_rush_td = 80
)

REGULAR_SEASON_GAMES <- 17

.clamp <- function(v, lo, hi) pmax(lo, pmin(hi, v))

shrink <- function(observed, baseline, n_eff, k) {
  w <- n_eff / (n_eff + k)
  w * observed + (1 - w) * baseline
}

# Position-specific multiplicative age curve (lib/projections/baselines.ts).
age_multiplier <- function(position, age) {
  if (is.null(age) || is.na(age) || !is.finite(age)) return(1)
  cl <- function(v) max(0.7, min(1.06, v))
  if (position == "RB") {
    if (age <= 22) return(cl(0.95 + (age - 21) * 0.03))
    if (age <= 26) return(1.0)
    if (age <= 28) return(cl(1.0 - (age - 26) * 0.03))
    return(cl(0.94 - (age - 28) * 0.05))
  } else if (position == "WR") {
    if (age <= 23) return(cl(0.93 + (age - 21) * 0.035))
    if (age <= 28) return(1.0)
    if (age <= 31) return(cl(1.0 - (age - 28) * 0.025))
    return(cl(0.925 - (age - 31) * 0.04))
  } else if (position == "TE") {
    if (age <= 24) return(cl(0.88 + (age - 21) * 0.04))
    if (age <= 30) return(1.0)
    return(cl(1.0 - (age - 30) * 0.03))
  } else if (position == "QB") {
    if (age <= 24) return(cl(0.94 + (age - 22) * 0.03))
    if (age <= 36) return(1.0)
    return(cl(1.0 - (age - 36) * 0.03))
  }
  1
}

# Candidate: steeper post-peak decline for RB / WR (residuals show the
# production curve plateaus ~2-3 years too long; late-20s athletic decline is
# well documented). QB / TE unchanged.
age_multiplier_steep <- function(position, age) {
  if (is.null(age) || is.na(age) || !is.finite(age)) return(1)
  cl <- function(v) max(0.62, min(1.06, v))
  if (position == "RB") {
    if (age <= 22) return(cl(0.95 + (age - 21) * 0.03))
    if (age <= 25) return(1.0)
    if (age <= 28) return(cl(1.0 - (age - 25) * 0.04))
    return(cl(0.88 - (age - 28) * 0.06))
  } else if (position == "WR") {
    if (age <= 23) return(cl(0.93 + (age - 21) * 0.035))
    if (age <= 27) return(1.0)
    if (age <= 30) return(cl(1.0 - (age - 27) * 0.04))
    return(cl(0.88 - (age - 30) * 0.05))
  }
  age_multiplier(position, age)
}

.or_base <- function(x, base) ifelse(is.finite(x) & x > 0, x, base)

# ---------------------------------------------------------------------------
# project_core_row()
#
#   prior : data.frame of that player's seasons with season < target_season,
#           gp > 0 (already filtered). Columns match backtest_seasons.csv.
#   target_season : integer
#   position : "QB"/"RB"/"WR"/"TE"
#   age : numeric age at the target season (may be NA)
#   K : list of shrinkage strengths (defaults to DEFAULT_K)
#   opts : list of formula toggles:
#            baseline       = "fixed" (production) | "empirical" (rolling pop mean, supplied via `pop`)
#            age_opportunity = FALSE (production applies age only to efficiency, plus a
#                              small RB opportunity term inside model.ts but NOT in the
#                              core backtest); TRUE also shades RB carry/target volume.
#   pop : optional named list of empirical population baselines for opts$baseline == "empirical"
#
# Returns a one-row data.frame: predicted points + every projected component.
# ---------------------------------------------------------------------------
project_core_row <- function(prior, target_season, position, age,
                             K = DEFAULT_K, opts = list(), pop = NULL) {
  opts <- modifyList(list(
    baseline = "fixed",        # "fixed" | "empirical"
    age_opportunity = FALSE,   # legacy RB volume age shade
    avail_floor = 0.45,        # production
    avail_anchor = NULL,       # override the position availability baseline the shrink pulls toward
    games_haircut = 0,         # subtract this many games from expected_games (preseason attrition)
    age_curve = "prod",        # "prod" | "steep"
    age_opp_from = Inf         # shade opportunity for age >= this (multiplicatively, by am)
  ), opts)
  prior <- prior[order(-prior$season), , drop = FALSE]
  if (nrow(prior) > 4) prior <- prior[1:4, , drop = FALSE]
  if (nrow(prior) == 0) return(NULL)

  as_of <- target_season - 1L
  w <- recency_weight(as_of - prior$season)
  g <- pmin(prior$gp, REGULAR_SEASON_GAMES)
  n_eff <- sum(w * g)

  wsum <- function(x) sum(w * x)
  pg   <- function(x) wsum(x) / wsum(g)             # per-game rate (recency weighted)
  eff  <- function(num, den) wsum(num) / wsum(den)  # weighted efficiency ratio (yards, catch rate, cmp%)
  # TD rates and INT rate use UNWEIGHTED career sums over the <=4 season window
  # (matches lib/projections/backtest.ts :: projectCoreForSeason `sum()` helper).
  ueff <- function(num, den) sum(num) / max(sum(den), 1)

  b <- POSITION_BASELINE[[position]]
  if (identical(opts$baseline, "empirical") && !is.null(pop)) {
    for (nm in names(pop)) b[[nm]] <- pop[[nm]]
  }
  am <- if (identical(opts$age_curve, "steep")) age_multiplier_steep(position, age)
        else age_multiplier(position, age)
  # opportunity age-shade: for aging players, decline shows up in usage too.
  opp_am <- 1
  if (!is.null(age) && !is.na(age) && is.finite(age) && age >= opts$age_opp_from) {
    opp_am <- 0.5 + 0.5 * am
  }
  if (opts$age_opportunity && position == "RB") opp_am <- opp_am * (0.6 + 0.4 * am)

  avail_anchor <- if (!is.null(opts$avail_anchor)) opts$avail_anchor else b$availability
  games_ratio <- eff(g, rep(REGULAR_SEASON_GAMES, nrow(prior)))
  availability <- .clamp(
    shrink(.or_base(games_ratio, avail_anchor), avail_anchor, n_eff, K$availability),
    opts$avail_floor, 0.985
  )
  games <- max(1, REGULAR_SEASON_GAMES * availability - opts$games_haircut)

  out <- list(position = position, target_season = target_season,
              n_eff = n_eff, availability = availability, expected_games = games)

  if (position == "QB") {
    patt <- pg(prior$pass_att)
    ypa  <- .clamp(shrink(.or_base(eff(prior$pass_yd, prior$pass_att), b$ypa),
                          b$ypa, n_eff, K$ypa), 5.6, 8.6) * am
    td_rate  <- .clamp(shrink(ueff(prior$pass_td, prior$pass_att), b$pass_td_per_att,
                              n_eff, K$qb_pass_td), 0.028, 0.07)
    int_rate <- .clamp(shrink(.or_base(ueff(prior$pass_int, prior$pass_att), b$int_per_att),
                              b$int_per_att, n_eff, K$int_rate), 0.014, 0.04)
    ratt <- pg(prior$rush_att)
    rypc <- .clamp(shrink(.or_base(eff(prior$rush_yd, prior$rush_att), b$rush_ypc),
                          b$rush_ypc, n_eff, K$ypc), 2, 8)
    rtd  <- .clamp(shrink(ueff(prior$rush_td, prior$rush_att), b$rush_td_per_att,
                          n_eff, K$qb_rush_td), 0, 0.12)

    out$proj_pass_att <- patt * games
    out$proj_pass_yd  <- patt * ypa * games
    out$proj_pass_td  <- patt * td_rate * games
    out$proj_pass_int <- patt * int_rate * games
    out$proj_rush_att <- ratt * games
    out$proj_rush_yd  <- ratt * rypc * games
    out$proj_rush_td  <- ratt * rtd * games
    out$proj_targets <- 0; out$proj_rec <- 0; out$proj_rec_yd <- 0; out$proj_rec_td <- 0
    pts <- games * (patt * ypa * 0.04 + patt * td_rate * 4 - patt * int_rate +
                    ratt * rypc * 0.1 + ratt * rtd * 6)
  } else {
    tgt <- pg(prior$targets)
    cr  <- .clamp(shrink(.or_base(eff(prior$rec, prior$targets), b$catch_rate),
                         b$catch_rate, n_eff, K$catch_rate), 0.4, 0.85)
    ypt <- .clamp(shrink(.or_base(eff(prior$rec_yd, prior$targets), b$ypt),
                         b$ypt, n_eff, K$ypt), 3, 13) * am
    rec_td_rate <- .clamp(shrink(.or_base(ueff(prior$rec_td, prior$rec_rz_tgt),
                                          b$rec_td_per_rz_target),
                                 b$rec_td_per_rz_target, n_eff, K$rec_td_rate), 0.05, 0.45)
    rz_tgt <- pg(prior$rec_rz_tgt)
    carr <- pg(prior$rush_att)
    ypc  <- .clamp(shrink(.or_base(eff(prior$rush_yd, prior$rush_att), b$ypc),
                          b$ypc, n_eff, K$ypc), 2.5, 6) * (if (position == "RB") am else 1)
    rush_td_rate <- .clamp(shrink(.or_base(ueff(prior$rush_td, prior$rush_rz_att),
                                           b$rush_td_per_rz_carry),
                                  b$rush_td_per_rz_carry, n_eff, K$rush_td_rate), 0.04, 0.35)
    rz_car <- pg(prior$rush_rz_att)

    tgt    <- tgt    * opp_am
    carr   <- carr   * opp_am
    rz_tgt <- rz_tgt * opp_am
    rz_car <- rz_car * opp_am

    out$proj_targets <- tgt * games
    out$proj_rec     <- tgt * cr * games
    out$proj_rec_yd  <- tgt * ypt * games
    out$proj_rec_td  <- rz_tgt * rec_td_rate * games
    out$proj_rush_att <- carr * games
    out$proj_rush_yd  <- carr * ypc * games
    out$proj_rush_td  <- rz_car * rush_td_rate * games
    out$proj_pass_att <- 0; out$proj_pass_yd <- 0; out$proj_pass_td <- 0; out$proj_pass_int <- 0
    pts <- games * (tgt * cr + tgt * ypt * 0.1 + rz_tgt * rec_td_rate * 6 +
                    carr * ypc * 0.1 + rz_car * rush_td_rate * 6 -
                    (tgt * cr + carr) * b$fum_lost_per_touch * 2)
  }

  out$predicted_points <- round(max(0, pts), 2)
  as.data.frame(out, stringsAsFactors = FALSE)
}

# PPR-neutral points from a component vector (matches model.ts :: pprPoints).
ppr_points <- function(rec = 0, pass_yd = 0, rush_yd = 0, rec_yd = 0,
                       pass_td = 0, rush_td = 0, rec_td = 0,
                       pass_int = 0, fum_lost = 0) {
  rec + pass_yd * 0.04 + rush_yd * 0.1 + rec_yd * 0.1 +
    pass_td * 4 + rush_td * 6 + rec_td * 6 + pass_int * -1 + fum_lost * -2
}
