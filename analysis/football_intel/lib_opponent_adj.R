# ===========================================================================
# Football Intelligence — opponent adjustment (spec §10).
#
# Ridge-regularized two-way (offense / defense) effects on game-level team
# metrics. One weighted penalized least-squares solve per metric yields BOTH
# the opponent-adjusted offensive rating (off effect) and the opponent-
# adjusted defense-allowed rating (def effect) on the metric's native scale.
#
#   y_g = mu + off_effect[team_g] + def_effect[opp_g] + eps_g
#
# Ridge penalty (FI$OPP_ADJ_RIDGE_LAMBDA) partial-pools every team effect
# toward 0 (= league average). Games are weighted by play count * recency
# weight (passed in). Deterministic, closed-form — no RNG, converges by
# construction (single solve). Spec §30: identical input -> identical output;
# stronger adjusted performance -> not a worse rating (monotone in y).
# ===========================================================================

suppressWarnings(suppressMessages({ library(dplyr) }))

# --------------------------------------------------------------------------
# opponent_adjust_metric()
#   games : tibble with columns  team, opponent, y, w   (one row per team-game,
#           OFFENSE perspective: y = offense's value of the metric)
#   ridge : ridge penalty (default FI$OPP_ADJ_RIDGE_LAMBDA)
#   min_w : team effects with total weight < this are forced to 0 (league mean)
#
# returns list(mu, off = named vec, def = named vec, n_games, teams)
#   off[t] : opponent-adjusted OFFENSIVE rating (deviation from league mean mu)
#   def[o] : opponent-adjusted DEFENSE-ALLOWED rating (deviation; positive =
#            allowed more than average)
# --------------------------------------------------------------------------
opponent_adjust_metric <- function(games, ridge = 1.0, min_w = 50) {
  g <- games %>% filter(is.finite(y), is.finite(w), w > 0)
  if (nrow(g) < 10) return(NULL)
  teams <- sort(unique(c(g$team, g$opponent)))
  K <- length(teams)
  idx <- setNames(seq_len(K), teams)

  # design: [intercept | off dummies (K) | def dummies (K)]
  n <- nrow(g)
  p <- 1 + 2 * K
  # build X^T W X and X^T W y without materializing dense X
  XtWX <- matrix(0, p, p)
  XtWy <- numeric(p)
  oi <- 1L + idx[g$team]          # offense dummy columns 2..K+1
  di <- 1L + K + idx[g$opponent]  # defense dummy columns K+2..2K+1
  w <- g$w; y <- g$y

  add <- function(i, j, v) { XtWX[i, j] <<- XtWX[i, j] + v; if (i != j) XtWX[j, i] <<- XtWX[j, i] + v }
  # intercept row
  XtWX[1, 1] <- sum(w)
  XtWy[1] <- sum(w * y)
  # accumulate by group for speed
  off_w <- tapply(w, oi, sum); def_w <- tapply(w, di, sum)
  off_wy <- tapply(w * y, oi, sum); def_wy <- tapply(w * y, di, sum)
  for (c in names(off_w)) { ci <- as.integer(c); XtWX[1, ci] <- XtWX[ci, 1] <- off_w[[c]]; XtWX[ci, ci] <- XtWX[ci, ci] + off_w[[c]]; XtWy[ci] <- off_wy[[c]] }
  for (c in names(def_w)) { ci <- as.integer(c); XtWX[1, ci] <- XtWX[ci, 1] <- def_w[[c]]; XtWX[ci, ci] <- XtWX[ci, ci] + def_w[[c]]; XtWy[ci] <- def_wy[[c]] }
  # off x def cross terms
  cross <- g %>% mutate(oi = oi, di = di) %>% group_by(oi, di) %>% summarise(sw = sum(w), .groups = "drop")
  for (r in seq_len(nrow(cross))) { i <- cross$oi[r]; j <- cross$di[r]; XtWX[i, j] <- XtWX[i, j] + cross$sw[r]; XtWX[j, i] <- XtWX[j, i] + cross$sw[r] }

  # ridge on the 2K dummies only (not intercept); plus tiny jitter for identifiability
  pen <- rep(ridge, p); pen[1] <- 0
  diag(XtWX) <- diag(XtWX) + pen + 1e-8

  beta <- tryCatch(solve(XtWX, XtWy), error = function(e) MASS::ginv(XtWX) %*% XtWy)
  beta <- as.numeric(beta)

  mu <- beta[1]
  off <- setNames(beta[2:(K + 1)], teams)
  def <- setNames(beta[(K + 2):(2 * K + 1)], teams)

  # force low-support teams to league mean (0 deviation)
  tw <- g %>% group_by(team) %>% summarise(w = sum(w), .groups = "drop")
  low <- tw$team[tw$w < min_w]
  off[low] <- 0
  ow <- g %>% group_by(opponent) %>% summarise(w = sum(w), .groups = "drop")
  deflow <- ow$opponent[ow$w < min_w]
  def[deflow] <- 0

  list(mu = mu, off = off, def = def, n_games = n, teams = teams,
       ridge = ridge,
       raw_off = g %>% group_by(team) %>% summarise(raw = weighted.mean(y, w), .groups = "drop"),
       raw_def = g %>% group_by(opponent) %>% summarise(raw = weighted.mean(y, w), .groups = "drop"))
}

# --------------------------------------------------------------------------
# league percentile of a named rating vector (higher value -> higher pct).
# --------------------------------------------------------------------------
league_percentile <- function(v) {
  r <- rank(v, ties.method = "average", na.last = "keep")
  (r - 1) / (sum(is.finite(v)) - 1)
}
