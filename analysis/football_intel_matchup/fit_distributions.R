#!/usr/bin/env Rscript
# ===========================================================================
# Phase 5 — per-position residual DISTRIBUTION model (spec §2, §3, §4, §5, §24).
#
#   Rscript analysis/football_intel_matchup/fit_distributions.R
#
# Chronology-safe walk-forward: for each outer test season s in 2023..2025,
# fit on seasons < s, evaluate calibration on s. NEVER tune on the test year.
#
# Compares:
#   sd model     : const | cv (weeklyBand control) | bucket | linear | sqrt
#   marginal     : normal_clamp (control) | empirical (standardized-resid resample)
#                  | mixture (bust-inflated empirical)
# by OUT-OF-SAMPLE calibration:
#   pit_ks       : Kolmogorov-Smirnov distance of the PIT to Uniform(0,1)  (0 = perfect)
#   pi80_cov     : empirical coverage of the nominal 80% prediction interval (target 0.80)
#   pi50_cov     : nominal 50%  (target 0.50)
#   crps         : mean continuous ranked probability score (lower better)
#
# Choose the SIMPLEST model within noise of the best (spec §3, §4).
#
# Output: lib/weekly/data/matchup_distribution_model.json  (+ diagnostics CSV)
# ===========================================================================

suppressWarnings(suppressMessages({ library(dplyr); library(tidyr); library(jsonlite) }))
.here <- sub("^--file=", "", grep("^--file=", commandArgs(FALSE), value = TRUE))
BASE <- if (length(.here)) dirname(.here) else file.path(getwd(), "analysis", "football_intel_matchup")
source(file.path(BASE, "config.R"))
set.seed(MI$SEED)

d0 <- readRDS(file.path(MI$OUT_DIR, "residual_dataset.rds")) %>%
  filter(arch == MI$PRIMARY_ARCHETYPE, is.finite(baseline_sleeper), is.finite(actual), position %in% MI$ALL_POS) %>%
  mutate(qd = ifelse(injury_status %in% MI$INJURY_WIDEN_STATES, 1L, 0L))

# ---- sd models -----------------------------------------------------------
# per-position mean-bias correction (spec §23) — estimated ONLY from the
# least-polluted provenance rows (sleeper_in_season_possibly_revised), applied
# chronology-safe (trained on prior seasons). The RotoWire-backed Sleeper QB
# projection runs systematically optimistic even for clean-provenance rows
# (~-2 pts); other positions have small biases. Pre-2023 evaluation is flagged
# DEGRADED_BASELINE_PROVENANCE.
fit_bias <- function(tr) {
  cl <- tr %>% filter(provenance_sublabel == "sleeper_in_season_possibly_revised")
  if (nrow(cl) < 100) cl <- tr
  round(mean(cl$actual - cl$baseline_sleeper, na.rm = TRUE), 3)
}

fit_sd <- function(tr, model) {
  # returns a function proj -> sd, fitted on tr (residuals resid = actual - proj)
  r <- tr$actual - tr$baseline_sleeper; p <- tr$baseline_sleeper
  if (model == "const")  { s <- sd(r, na.rm = TRUE); return(function(px) rep(s, length(px))) }
  if (model == "cv")     { cvv <- MI$WEEKLYBAND_CV[[tr$position[1]]]; return(function(px) pmax(2, abs(px) * cvv)) }
  if (model == "bucket") {
    b <- cut(p, MI$PROJ_BUCKETS); tab <- tapply(r, b, sd)
    return(function(px) { bx <- cut(px, MI$PROJ_BUCKETS); v <- tab[as.character(bx)]; v[!is.finite(v)] <- median(tab, na.rm = TRUE); as.numeric(v) })
  }
  if (model == "linear") {
    # sd ~ a + b*proj  via regression of |resid|*sqrt(pi/2) on proj (abs-resid is a scaled sd estimate)
    fit <- lm(I(abs(r) * sqrt(pi/2)) ~ p)
    a <- coef(fit)[1]; b <- coef(fit)[2]
    return(function(px) pmax(2, a + b * px))
  }
  if (model == "sqrt") {
    fit <- lm(I(abs(r) * sqrt(pi/2)) ~ sqrt(pmax(p, 0)))
    a <- coef(fit)[1]; b <- coef(fit)[2]
    return(function(px) pmax(2, a + b * sqrt(pmax(px, 0))))
  }
  stop("bad sd model")
}

# ---- marginal CDF given (proj, sd) -------------------------------------
make_marginal <- function(tr, sd_fn, family) {
  r <- tr$actual - tr$baseline_sleeper; p <- tr$baseline_sleeper
  z <- r / sd_fn(p)                                   # standardized residuals
  z <- z[is.finite(z)]
  bust_w <- mean(tr$actual <= 1, na.rm = TRUE)
  # returns list(cdf(actual, proj), sample(proj, n))
  if (family == "normal_clamp") {
    cdf <- function(a, px) {
      s <- sd_fn(px); mu <- px
      # P(max(0,N(mu,s)) <= a): for a>0 it's Phi((a-mu)/s); for a==0 it's Phi(-mu/s)
      ifelse(a <= 0, pnorm(-mu / s), pnorm((a - mu) / s))
    }
    samp <- function(px, n) pmax(0, rnorm(n, px, sd_fn(px)))
    return(list(cdf = cdf, samp = samp, meta = list(family = "normal_clamp")))
  }
  zq <- quantile(z, probs = seq(0, 1, 0.02), na.rm = TRUE, names = FALSE)   # 51-point standardized grid
  ecdf_z <- function(zz) {
    # linear-interpolated empirical CDF of z
    approx(zq, seq(0, 1, length.out = length(zq)), xout = zz, rule = 2)$y
  }
  if (family == "empirical") {
    cdf <- function(a, px) { s <- sd_fn(px); pmax(0, pmin(1, ecdf_z((a - px) / s))) }
    samp <- function(px, n) pmax(0, px + sd_fn(px) * sample(z, n, replace = TRUE))
    return(list(cdf = cdf, samp = samp, meta = list(family = "empirical", z_grid = zq, bust_w = bust_w)))
  }
  if (family == "mixture") {
    # w * (near-0 bust) + (1-w) * empirical body (on the non-bust residuals)
    nb <- tr$actual > 1
    zb <- (r[nb] / sd_fn(p[nb])); zb <- zb[is.finite(zb)]
    zqb <- quantile(zb, probs = seq(0, 1, 0.02), na.rm = TRUE, names = FALSE)
    ecdf_b <- function(zz) approx(zqb, seq(0, 1, length.out = length(zqb)), xout = zz, rule = 2)$y
    cdf <- function(a, px) {
      s <- sd_fn(px)
      body <- pmax(0, pmin(1, ecdf_b((a - px) / s)))
      ifelse(a <= 1, bust_w + (1 - bust_w) * body, bust_w + (1 - bust_w) * body)
    }
    samp <- function(px, n) {
      is_bust <- runif(n) < bust_w
      out <- numeric(n)
      out[is_bust] <- pmax(0, rnorm(sum(is_bust), 0.3, 0.4))
      k <- sum(!is_bust)
      out[!is_bust] <- pmax(0, px + sd_fn(px) * sample(zb, k, replace = TRUE))
      out
    }
    return(list(cdf = cdf, samp = samp, meta = list(family = "mixture", z_grid = zqb, bust_w = bust_w)))
  }
  stop("bad family")
}

crps_sample <- function(samples, y) {
  # CRPS via the empirical form: E|X-y| - 0.5 E|X-X'|
  s <- sort(samples); n <- length(s)
  e1 <- mean(abs(s - y))
  # E|X-X'| for empirical = (2/n^2) * sum_i (2i-n-1) s_i
  e2 <- (2 / n^2) * sum((2 * seq_len(n) - n - 1) * s)
  e1 - 0.5 * e2
}

diag_rows <- list()
NSAMP <- 400L
for (pos in MI$ALL_POS) {
  dp <- d0 %>% filter(position == pos)
  if (nrow(dp) < 400) next
  for (s in MI$OUTER_TEST_SEASONS) {
    tr <- dp %>% filter(season < s); te <- dp %>% filter(season == s)
    if (nrow(tr) < 200 || nrow(te) < 60) next
    bias <- fit_bias(tr)
    tr <- tr %>% mutate(baseline_sleeper = baseline_sleeper + bias)
    te_proj <- te$baseline_sleeper + bias
    for (sdm in MI$DIST_CANDIDATES) {
      sd_fn <- tryCatch(fit_sd(tr, sdm), error = function(e) NULL); if (is.null(sd_fn)) next
      for (fam in MI$MARGINAL_CANDIDATES) {
        m <- tryCatch(make_marginal(tr, sd_fn, fam), error = function(e) NULL); if (is.null(m)) next
        pit <- m$cdf(te$actual, te_proj)
        pit <- pit[is.finite(pit)]
        ks <- max(abs(sort(pit) - (seq_along(pit) - 0.5) / length(pit)))
        pi80 <- mean(pit >= 0.1 & pit <= 0.9)
        pi50 <- mean(pit >= 0.25 & pit <= 0.75)
        # CRPS on a subsample
        idx <- sample(seq_len(nrow(te)), min(NSAMP, nrow(te)))
        crps <- mean(vapply(idx, function(i) crps_sample(m$samp(te_proj[i], 500), te$actual[i]), numeric(1)))
        diag_rows[[length(diag_rows) + 1]] <- data.frame(
          position = pos, test_season = s, sd_model = sdm, marginal = fam,
          n = nrow(te), pit_ks = ks, pi80_cov = pi80, pi50_cov = pi50, crps = crps)
      }
    }
  }
}
D <- bind_rows(diag_rows)
agg <- D %>% group_by(position, sd_model, marginal) %>%
  summarise(pit_ks = mean(pit_ks), pi80_cov = mean(pi80_cov), pi50_cov = mean(pi50_cov),
            crps = mean(crps), .groups = "drop") %>%
  mutate(pi80_err = abs(pi80_cov - 0.80), pi50_err = abs(pi50_cov - 0.50),
         cal_score = pit_ks + pi80_err + pi50_err)
write.csv(agg, file.path(MI$OUT_DIR, "distribution_family_comparison.csv"), row.names = FALSE)

# ---- model selection: simplest within 10% of best cal_score -----------
simplicity <- c(const = 1, cv = 2, bucket = 3, sqrt = 4, linear = 5)
fam_simpl  <- c(normal_clamp = 1, empirical = 2, mixture = 3)
chosen <- agg %>% group_by(position) %>%
  mutate(best = min(cal_score), within = cal_score <= best * 1.10 + 0.01) %>%
  filter(within) %>%
  mutate(simpl = simplicity[sd_model] + fam_simpl[marginal]) %>%
  arrange(position, simpl, cal_score) %>% slice(1) %>% ungroup()

# ---- refit chosen models on ALL data + injury widen factor -----------
positions_out <- list()
for (i in seq_len(nrow(chosen))) {
  pos <- chosen$position[i]; sdm <- chosen$sd_model[i]; fam <- chosen$marginal[i]
  dp0 <- d0 %>% filter(position == pos)
  bias <- fit_bias(dp0)
  dp <- dp0 %>% mutate(baseline_sleeper = baseline_sleeper + bias)
  sd_fn <- fit_sd(dp, sdm); m <- make_marginal(dp, sd_fn, fam)
  # injury widen factor: ratio of Q/D residual sd to overall (validated §24)
  qd_sd <- sd((dp$actual - dp$baseline_sleeper)[dp$qd == 1], na.rm = TRUE)
  all_sd <- sd(dp$actual - dp$baseline_sleeper, na.rm = TRUE)
  widen <- if (is.finite(qd_sd) && is.finite(all_sd) && all_sd > 0) round(max(1, qd_sd / all_sd), 3) else 1
  qd_n <- sum(dp$qd == 1, na.rm = TRUE)
  # serialize sd model params
  r <- dp$actual - dp$baseline_sleeper; p <- dp$baseline_sleeper
  sd_params <- switch(sdm,
    const  = list(kind = "const", s = round(sd(r, na.rm = TRUE), 4)),
    cv     = list(kind = "cv", cv = MI$WEEKLYBAND_CV[[pos]]),
    bucket = list(kind = "bucket", breaks = MI$PROJ_BUCKETS,
                  sd = round(as.numeric(tapply(r, cut(p, MI$PROJ_BUCKETS), sd)), 4)),
    linear = { f <- lm(I(abs(r)*sqrt(pi/2)) ~ p); list(kind = "linear", a = round(coef(f)[[1]],4), b = round(coef(f)[[2]],4)) },
    sqrt   = { f <- lm(I(abs(r)*sqrt(pi/2)) ~ sqrt(pmax(p,0))); list(kind = "sqrt", a = round(coef(f)[[1]],4), b = round(coef(f)[[2]],4)) })
  positions_out[[pos]] <- list(
    position = pos, sd_model = sdm, marginal = fam, sd_params = sd_params,
    mean_bias_correction = bias,
    bias_by_season = as.list(round(tapply(dp0$actual - dp0$baseline_sleeper, dp0$season, mean, na.rm = TRUE), 3)),
    z_grid = if (!is.null(m$meta$z_grid)) round(m$meta$z_grid, 4) else NULL,
    bust_weight = if (!is.null(m$meta$bust_w)) round(m$meta$bust_w, 4) else 0,
    injury_widen_factor = widen, injury_qd_n = qd_n,
    empirical_resid_sd = round(all_sd, 3),
    weeklyband_cv_sd_at_mean = round(mean(abs(p), na.rm = TRUE) * MI$WEEKLYBAND_CV[[pos]], 3),
    calibration = list(pit_ks = round(chosen$pit_ks[i], 4), pi80_cov = round(chosen$pi80_cov[i], 4),
                       pi50_cov = round(chosen$pi50_cov[i], 4)))
}

model <- list(
  distribution_model_version = MI$DISTRIBUTION_MODEL_VERSION,
  matchup_model_version = MI$MATCHUP_MODEL_VERSION,
  generated_at = format(Sys.time(), "%Y-%m-%dT%H:%M:%S%z"),
  archetype = MI$PRIMARY_ARCHETYPE,
  trained_on_seasons = paste0(min(MI$SEASONS), "-2022+"),
  outer_test_seasons = MI$OUTER_TEST_SEASONS,
  baseline_projection = "sleeper_weekly_rotowire (HISTORICALLY_RECONSTRUCTED)",
  control_baseline = "weeklyBand CV heuristic + max(0,Normal) (sd_model=cv, marginal=normal_clamp)",
  selection_rule = "simplest sd_model + marginal within 10% of best OOS calibration score (pit_ks + |pi80-.8| + |pi50-.5|)",
  positions = positions_out,
  deployment = "SHADOW_ONLY")
write(toJSON(model, auto_unbox = TRUE, pretty = TRUE, null = "null"),
      file.path(MI$SERVE_DIR, "matchup_distribution_model.json"))

cat("\n=== distribution family comparison (OOS mean) ===\n")
print(as.data.frame(agg %>% arrange(position, cal_score)), row.names = FALSE, digits = 3)
cat("\n=== chosen per position ===\n")
print(as.data.frame(chosen %>% select(position, sd_model, marginal, pit_ks, pi80_cov, pi50_cov)), row.names = FALSE, digits = 3)
