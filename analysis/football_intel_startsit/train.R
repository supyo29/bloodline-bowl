#!/usr/bin/env Rscript
# ===========================================================================
# Phase 4 — per-position FI-adjustment training (§5, §6, §15, §41.4).
#
#   Rscript analysis/football_intel_startsit/train.R
#
# Nested chronology-safe walk-forward. For each outer test season s in
# {2023,2024,2025}:
#   * train on seasons < s
#   * inner loop tunes ridge lambda on the LATEST inner season (< s)
#   * NOTHING from season >= s informs any coefficient / hyper-parameter
#
# Two formulations compared (§6):
#   residual : (actual - baseline_trailing) ~ FI          [preferred if ~equal]
#   full     : actual ~ baseline_trailing + FI
#
# Routing (§2): only PREDICTIVE (free) + WEAKLY_PREDICTIVE (capped) FI families
# may get a nonzero coefficient. NOT_PREDICTIVE / DESCRIPTIVE_ONLY are dropped
# from the design matrix entirely here (and re-proven zero in tests).
#
# FI inputs are confidence-weighted BEFORE the fit, so the learned beta is on
# confidence-weighted signal and the identical weighting is applied at serve.
#
# Output (served, immutable, versioned):
#   lib/weekly/data/start_sit_model.json
#   lib/weekly/data/start_sit_feature_status.csv
#   lib/weekly/data/start_sit_validation.csv
#   lib/weekly/data/start_sit_manifest.json
# ===========================================================================

suppressWarnings(suppressMessages({ library(dplyr); library(tidyr); library(jsonlite) }))
.here <- sub("^--file=", "", grep("^--file=", commandArgs(FALSE), value = TRUE))
BASE <- if (length(.here)) dirname(.here) else file.path(getwd(), "analysis", "football_intel_startsit")
source(file.path(BASE, "config.R"))
set.seed(SS$SEED)

d <- readRDS(file.path(SS$OUT_DIR, "decision_dataset.rds"))
manifest_fi <- jsonlite::fromJSON(file.path(SS$ROOT, "lib", "football-intel", "data", "football_intelligence_manifest.json"))

CONF_W <- function(x) ifelse(is.na(x), 0, unname(SS$CONF_WEIGHT[x]))

# resolve, per family, the modeled value + confidence columns in `d`
fam_cols <- function(fam) {
  routing <- SS$FI_FAMILIES$routing[SS$FI_FAMILIES$family == fam]
  kind    <- SS$FI_FAMILIES$kind[SS$FI_FAMILIES$family == fam]
  if (kind == "team_off")       list(v = paste0("fi_", fam, "_league_percentile"),      c = paste0("fi_", fam, "_confidence"), pd = paste0("fi_", fam, "_prior_dominated"))
  else if (kind == "opp_def")   list(v = paste0("fidef_", fam, "_league_percentile"),   c = paste0("fidef_", fam, "_confidence"), pd = NA)
  else if (kind == "player_usage") list(v = paste0("fi_", fam, "_modeled"),             c = paste0("fi_", fam, "_confidence"), pd = NA)
  else if (kind == "interaction") list(v = paste0("fi_", fam, "_modeled"),              c = paste0("fi_", fam, "_confidence"), pd = NA)
  else list(v = NA, c = NA, pd = NA)
}

# build the confidence-weighted, standardized design matrix for a family set
build_X <- function(df, fams, stats = NULL) {
  cols <- list(); meta <- list()
  for (fam in fams) {
    fc <- fam_cols(fam)
    if (is.na(fc$v) || !fc$v %in% names(df)) next
    raw <- suppressWarnings(as.numeric(df[[fc$v]]))
    cw  <- CONF_W(df[[fc$c]])
    if (!is.na(fc$pd) && fc$pd %in% names(df)) cw <- cw * ifelse(df[[fc$pd]] %in% TRUE, SS$PRIOR_DOMINATED_HAIRCUT, 1)
    # centering: team_off/opp_def percentiles centered at 0.5; usage/interaction centered at fold mean
    center <- if (is.null(stats)) {
      if (grepl("percentile", fc$v)) 0.5 else mean(raw, na.rm = TRUE)
    } else stats[[fam]]$center
    scale_ <- if (is.null(stats)) {
      s <- sd(raw, na.rm = TRUE); if (!is.finite(s) || s == 0) 1 else s
    } else stats[[fam]]$scale
    sig <- ((raw - center) / scale_)
    sig[!is.finite(sig)] <- 0
    cols[[fam]] <- sig * cw
    meta[[fam]] <- list(center = center, scale = scale_,
                        v_col = fc$v, c_col = fc$c, pd_col = fc$pd,
                        routing = SS$FI_FAMILIES$routing[SS$FI_FAMILIES$family == fam])
  }
  if (!length(cols)) return(NULL)
  list(X = do.call(cbind, cols), meta = meta)
}

ridge_fit <- function(X, y, lambda) {
  X <- as.matrix(X); p <- ncol(X)
  XtX <- crossprod(X) + diag(lambda, p)
  beta <- tryCatch(solve(XtX, crossprod(X, y)), error = function(e) MASS::ginv(XtX) %*% crossprod(X, y))
  as.numeric(beta)
}

results <- list(); validation <- list(); feature_status <- list()

for (pos in SS$POSITIONS) {
  fams0 <- SS$POSITION_FAMILIES[[pos]]
  # routing filter — NOT_PREDICTIVE / DESCRIPTIVE never enter the design matrix
  fams <- fams0[ SS$FI_FAMILIES$routing[match(fams0, SS$FI_FAMILIES$family)] %in% c("PREDICTIVE", "WEAKLY_PREDICTIVE") ]
  dp <- d %>% filter(position == pos, is.finite(actual), is.finite(baseline_trailing), fi_available)

  outer_seasons <- intersect(SS$SEASONS, 2023:2025)
  fold_betas <- list(); fold_rows <- list()
  for (s in outer_seasons) {
    tr <- dp %>% filter(season < s)
    te <- dp %>% filter(season == s)
    if (nrow(tr) < 300 || nrow(te) < 100) next
    inner_val_season <- max(tr$season)
    inner_tr <- tr %>% filter(season < inner_val_season)
    inner_va <- tr %>% filter(season == inner_val_season)
    if (nrow(inner_tr) < 200) { inner_tr <- tr; inner_va <- tr }  # tiny-history guard

    bx_itr <- build_X(inner_tr, fams); if (is.null(bx_itr)) next
    bx_iva <- build_X(inner_va, fams, stats = lapply(bx_itr$meta, function(m) list(center = m$center, scale = m$scale)))
    # tune lambda (residual formulation) on the inner validation season
    y_itr <- inner_tr$actual - inner_tr$baseline_trailing
    y_iva <- inner_va$actual - inner_va$baseline_trailing
    best <- NULL
    for (lam in SS$RIDGE_LAMBDA_GRID) {
      b <- ridge_fit(bx_itr$X, y_itr, lam)
      pred <- as.numeric(bx_iva$X %*% b)
      mae <- mean(abs((y_iva - pred)), na.rm = TRUE)
      if (is.null(best) || mae < best$mae) best <- list(lam = lam, mae = mae)
    }
    # refit on the full outer-train with the chosen lambda + full standardization
    bx_tr <- build_X(tr, fams)
    b_res <- ridge_fit(bx_tr$X, tr$actual - tr$baseline_trailing, best$lam)
    # full formulation for comparison
    Xf <- cbind(baseline = tr$baseline_trailing - mean(tr$baseline_trailing), bx_tr$X)
    b_full <- ridge_fit(Xf, tr$actual - mean(tr$actual), best$lam)

    bx_te <- build_X(te, fams, stats = lapply(bx_tr$meta, function(m) list(center = m$center, scale = m$scale)))
    adj_res  <- as.numeric(bx_te$X %*% b_res)
    adj_full <- as.numeric(bx_te$X %*% b_full[-1])   # FI part only

    fold_rows[[length(fold_rows) + 1]] <- te %>% transmute(
      season, week, sleeper_id, position = pos, arch, actual,
      baseline = baseline_trailing, baseline_sleeper,
      adj_residual = adj_res, adj_full = adj_full,
      lambda = best$lam)
    fold_betas[[as.character(s)]] <- list(lambda = best$lam, families = names(bx_tr$meta),
      beta_residual = setNames(b_res, names(bx_tr$meta)),
      beta_full_fi  = setNames(b_full[-1], names(bx_tr$meta)),
      beta_full_baseline = b_full[1],
      meta = bx_tr$meta)
  }
  if (!length(fold_rows)) { message("skip ", pos, " (insufficient folds)"); next }
  fr <- bind_rows(fold_rows)

  # out-of-sample projection metrics: baseline vs baseline+residual vs baseline+full
  mm <- function(pred) c(mae = mean(abs(pred - fr$actual)), rmse = sqrt(mean((pred - fr$actual)^2)))
  m_base <- mm(fr$baseline)
  m_res  <- mm(fr$baseline + fr$adj_residual)
  m_full <- mm(fr$baseline + fr$adj_full)
  validation[[pos]] <- tibble::tibble(position = pos,
    n = nrow(fr),
    mae_baseline = m_base["mae"], mae_residual = m_res["mae"], mae_full = m_full["mae"],
    rmse_baseline = m_base["rmse"], rmse_residual = m_res["rmse"], rmse_full = m_full["rmse"],
    formulation = if (m_res["mae"] <= m_full["mae"] + 1e-6) "residual" else "full")

  # drop-one ablation on the residual formulation (incremental projection value)
  for (fam in unique(unlist(lapply(fold_betas, function(x) x$families)))) {
    others <- setdiff(fams, fam)
    ab_rows <- list()
    for (s in outer_seasons) {
      tr <- dp %>% filter(season < s); te <- dp %>% filter(season == s)
      if (nrow(tr) < 300 || nrow(te) < 100 || !length(others)) next
      bx_tr <- build_X(tr, others); bx_te <- build_X(te, others, stats = lapply(bx_tr$meta, function(m) list(center=m$center, scale=m$scale)))
      if (is.null(bx_tr) || is.null(bx_te)) next
      b <- ridge_fit(bx_tr$X, tr$actual - tr$baseline_trailing, fold_betas[[as.character(s)]]$lambda %||% 5)
      ab_rows[[length(ab_rows)+1]] <- te %>% transmute(actual, baseline = baseline_trailing,
        pred = baseline_trailing + as.numeric(bx_te$X %*% b))
    }
    if (!length(ab_rows)) next
    ar <- bind_rows(ab_rows)
    mae_without <- mean(abs(ar$pred - ar$actual))
    incr <- mae_without - m_res["mae"]   # positive => family helps
    feature_status[[length(feature_status)+1]] <- tibble::tibble(
      position = pos, family = fam,
      routing = SS$FI_FAMILIES$routing[SS$FI_FAMILIES$family == fam],
      mae_full_model = m_res["mae"], mae_without_family = mae_without,
      incremental_mae_gain = incr)
  }

  results[[pos]] <- fold_betas
}

`%||%` <- function(a,b) if (is.null(a)) b else a
VAL <- bind_rows(validation)
FS  <- bind_rows(feature_status)

# ---- promotion status (§15, §37) --------------------------------------
FS <- FS %>% group_by(position, family) %>%
  summarise(incremental_mae_gain = mean(incremental_mae_gain),
            routing = dplyr::first(routing), .groups = "drop") %>%
  mutate(status = case_when(
    incremental_mae_gain >  0.02 ~ "KEEP",
    incremental_mae_gain >  0.00 ~ "KEEP_WEAK",
    incremental_mae_gain > -0.02 ~ "EXPLAIN",
    TRUE                         ~ "REMOVE"))
write.csv(FS, file.path(SS$SERVE_DIR, "start_sit_feature_status.csv"), row.names = FALSE)
write.csv(VAL, file.path(SS$SERVE_DIR, "start_sit_validation.csv"), row.names = FALSE)

# ---- final served model: average the kept-family betas across outer folds ----
model_positions <- list()
for (pos in names(results)) {
  fb <- results[[pos]]
  kept <- FS %>% filter(position == pos, status %in% c("KEEP", "KEEP_WEAK")) %>% pull(family)
  form <- VAL$formulation[VAL$position == pos]
  if (!length(kept)) { model_positions[[pos]] <- list(status = "SHADOW_ONLY_NO_KEPT_FAMILY", families = list()); next }
  meta0 <- fb[[1]]$meta
  betas <- sapply(kept, function(f) {
    mean(sapply(fb, function(x) {
      bb <- if (identical(form, "full")) x$beta_full_fi else x$beta_residual
      v <- bb[[f]]; if (is.null(v) || !is.finite(v)) 0 else v
    }))
  })
  # WEAKLY_PREDICTIVE cap: shrink its |beta| to <= median |PREDICTIVE beta|
  pred_betas <- abs(betas[ FS$routing[match(kept, FS$family)] == "PREDICTIVE" ])
  cap <- if (length(pred_betas)) stats::median(pred_betas) else Inf
  for (f in kept) if ((FS$routing[FS$position==pos & FS$family==f][1] %||% "") == "WEAKLY_PREDICTIVE")
    betas[f] <- sign(betas[f]) * min(abs(betas[f]), cap)

  model_positions[[pos]] <- list(
    status = "CANDIDATE",
    formulation = form,
    lambda = mean(sapply(fb, function(x) x$lambda)),
    families = lapply(kept, function(f) list(
      family = f, beta = unname(betas[f]),
      routing = FS$routing[FS$position == pos & FS$family == f][1],
      center = meta0[[f]]$center, scale = meta0[[f]]$scale,
      value_col = meta0[[f]]$v_col, confidence_col = meta0[[f]]$c_col,
      prior_dominated_col = meta0[[f]]$pd_col)),
    conf_weight = as.list(SS$CONF_WEIGHT),
    prior_dominated_haircut = SS$PRIOR_DOMINATED_HAIRCUT)
}

model <- list(
  start_sit_model_version = SS$MODEL_VERSION,
  generated_at = format(Sys.time(), "%Y-%m-%dT%H:%M:%S%z"),
  football_intelligence_version = manifest_fi$football_intelligence_version,
  baseline = list(primary = "trailing_ppg_ew", control_note = "Sleeper historical projection is research-only; 2021 has no timestamp, 2022 bulk-backfilled, 2023-25 possible through-week revision (§3)."),
  trained_on = list(seasons = paste0(min(SS$SEASONS), "-2022+"), outer_test_seasons = c(2023, 2024, 2025),
                    weeks = paste0(SS$MIN_WEEK, "-", SS$MAX_WEEK), archetypes = names(SS$ARCHETYPES)),
  routing = list(
    PREDICTIVE = "eligible (free coefficient)",
    WEAKLY_PREDICTIVE = "eligible, |beta| capped at median |PREDICTIVE beta|",
    NOT_PREDICTIVE = "excluded from design matrix; contribution forced 0",
    DESCRIPTIVE_ONLY = "excluded; explanation-only",
    UNVALIDATED = "deferred; not in v1"),
  max_total_adjustment_fraction = NA,  # set by backtest.R after tie-break/cap tuning
  tau_tie_break = NA,
  positions = model_positions
)
write(jsonlite::toJSON(model, auto_unbox = TRUE, pretty = TRUE, null = "null"),
      file.path(SS$SERVE_DIR, "start_sit_model.json"))

manifest <- list(
  start_sit_model_version = SS$MODEL_VERSION,
  football_intelligence_version = manifest_fi$football_intelligence_version,
  generated_at = model$generated_at,
  files = c("start_sit_model.json", "start_sit_feature_status.csv", "start_sit_validation.csv"),
  determinism = "seeded ridge, closed form; identical dataset -> identical model")
write(jsonlite::toJSON(manifest, auto_unbox = TRUE, pretty = TRUE), file.path(SS$SERVE_DIR, "start_sit_manifest.json"))

cat("\n=== projection validation (out-of-sample, vs clean trailing baseline) ===\n")
print(as.data.frame(VAL), row.names = FALSE)
cat("\n=== feature status ===\n")
print(as.data.frame(FS), row.names = FALSE)
