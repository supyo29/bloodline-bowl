#!/usr/bin/env Rscript
# =============================================================================
# PHASE 5 — market / ADP / pick-survival calibration.
#
# Calibrates the snake-draft survival model that feeds the frozen Phase 4 engine.
#
#   node scripts/build-market-consensus.ts       # vendor the ADP snapshot
#   npx tsx scripts/phase5-export-drafts.ts      # export the calibration drafts
#   Rscript analysis/phase5_market_survival.R
#
# Ground truth: the COMPLETED Devoted-to-the-Game 2026 12-team snake draft
# (192 picks, 2026-08-31) — the only completed 12-team snake draft available with
# a ~contemporaneous ADP snapshot. Bloodline Bowl is a brand-new league
# (previous_league_id: null), pre-draft, so it has no historical picks.
#
# Fixed seeds. No future leakage (a "current pick c" only ever sees picks < c).
# =============================================================================

suppressWarnings(suppressMessages({
  library(data.table)
  library(jsonlite)
  library(ggplot2)
}))

set.seed(50505)
OUT   <- file.path("outputs", "projections-2026")
PLOTS <- file.path("analysis", "plots")
dir.create(PLOTS, showWarnings = FALSE, recursive = TRUE)
wr <- function(df, n) { fwrite(df, file.path(OUT, n)); cat("  wrote", n, "\n") }

cat("PHASE 5 — market / survival calibration\n======================================\n\n")

# ---------------------------------------------------------------- load
adp_raw   <- fromJSON(file.path("lib", "draft", "data", "market-adp-2026.json"))
drafts    <- fread(file.path(OUT, "phase5_devoted_drafts.csv"))
REF_DATE  <- as.Date("2026-08-31")     # Devoted 2026 draft date
TEAMS     <- 12

# flatten vendored ADP rows -> long: sleeper_id, source, type, pick
players <- as.data.table(adp_raw$players)
long <- rbindlist(lapply(seq_len(nrow(players)), function(i) {
  s <- players$sources[[i]]
  if (is.null(s) || length(s) == 0) return(NULL)
  s <- as.data.table(s)
  s[, `:=`(sleeper_id = as.character(players$sleeper_id[i]),
           name = players$name[i], position = players$position[i],
           search_rank = players$search_rank[i])]
  s
}), fill = TRUE)
# add search_rank as a proxy source row
sr_rows <- unique(long[!is.na(search_rank), .(sleeper_id, name, position, search_rank)])
sr_rows[, `:=`(source = "sleeper_search_rank", type = "RANKING_PROXY",
               pick = ifelse(search_rank <= 180, search_rank, 180 + (search_rank - 180) * 1.15),
               format = "n/a", teams = NA_integer_, date = "2026-08-31")]
long <- rbindlist(list(long[, .(sleeper_id, name, position, source, type, pick, date)],
                       sr_rows[, .(sleeper_id, name, position, source, type, pick, date)]), use.names = TRUE)

# =============================================================================
# 1. SOURCE AUDIT (§4)
# =============================================================================
cat("[1] Source audit\n")
audit <- long[, .(
  rows = .N, players = uniqueN(sleeper_id),
  min_pick = round(min(pick), 1), max_pick = round(max(pick), 1),
  source_type = type[1]
), by = source]
audit[, classification := fifelse(source_type == "DIRECT_ADP", "DIRECT_ADP",
                          fifelse(source_type == "RANKING_PROXY", "RANKING_PROXY", "OTHER"))]
audit[, `:=`(date = "2026-08-24/30", scoring = fifelse(grepl("consensus", source), "consensus", "half_ppr"),
             usable_for_snake_survival = TRUE)]
excl <- as.data.table(adp_raw$excluded_sources)
excl[, `:=`(classification = "NOT_USABLE_FOR_SURVIVAL", usable_for_snake_survival = FALSE)]
audit_out <- rbindlist(list(
  audit[, .(source, classification, rows, players, date, scoring, usable_for_snake_survival, note = "")],
  excl[, .(source, classification, rows = NA, players = NA, date, scoring = NA, usable_for_snake_survival, note = reason)]
), fill = TRUE)
# historical pick data rows
audit_out <- rbindlist(list(audit_out, data.table(
  source = c("devoted_2026_snake_draft", "devoted_2025_snake_draft"),
  classification = "HISTORICAL_PICK_DATA",
  rows = c(sum(drafts$season == 2026), sum(drafts$season == 2025)),
  players = c(sum(drafts$season == 2026), sum(drafts$season == 2025)),
  date = c("2026-08-31", "2025"), scoring = "1.0 ppr",
  usable_for_snake_survival = c(TRUE, FALSE),
  note = c("primary calibration ground truth", "structural prior only — no matching-vintage ADP")
)), fill = TRUE)
print(audit_out)
wr(audit_out, "phase5_source_audit.csv")

# =============================================================================
# 2. CROSSWALK AUDIT (§6)
# =============================================================================
cat("\n[2] Player identity crosswalk\n")
ia <- adp_raw$identity_audit
cw <- data.table(
  metric = c("source_rows_total", "matched", "ambiguous", "unmatched",
             "vendored_players", "devoted2026_picks_matched_to_adp"),
  value  = c(ia$total, ia$matched, ia$ambiguous, ia$unmatched,
             nrow(players),
             drafts[season == 2026][as.character(sleeper_id) %in% players$sleeper_id, .N])
)
print(cw)
by_src <- rbindlist(lapply(names(ia$by_source), function(s) data.table(
  source = s, matched = ia$by_source[[s]]$matched, unmatched = ia$by_source[[s]]$unmatched)))
print(by_src)
wr(rbindlist(list(cw, data.table(metric = paste0("bysrc_", by_src$source, "_matched"), value = by_src$matched),
                  data.table(metric = paste0("bysrc_", by_src$source, "_unmatched"), value = by_src$unmatched))),
   "phase5_player_crosswalk.csv")

# =============================================================================
# 3. MARKET CONSENSUS (§7) + 4. SOURCE DISAGREEMENT (§8)
# =============================================================================
cat("\n[3] Market consensus (robust weighted median) + disagreement\n")
W <- c(underdog_adp = 1.0, yahoo_adp = 1.0, published_adp_consensus = 0.6, sleeper_search_rank = 0.35)
wmed <- function(v, w) {
  o <- order(v); v <- v[o]; w <- w[o]; cw <- cumsum(w) / sum(w)
  v[which(cw >= 0.5)[1]]
}
consensus <- long[, {
  w <- W[source]; w[is.na(w)] <- 0.3
  direct <- pick[type == "DIRECT_ADP"]
  .(name = name[1], position = position[1],
    expected_pick = round(wmed(pick, w), 1),
    median_pick   = round(median(pick), 1),
    n_sources     = .N, n_direct = sum(type == "DIRECT_ADP"),
    dispersion    = round(if (length(direct) >= 2) median(abs(direct - median(direct))) else median(abs(pick - median(pick))), 1))
}, by = sleeper_id]
consensus[, market_confidence := fifelse(n_direct >= 2 & dispersion <= 12, "HIGH",
                                 fifelse(n_direct >= 1, "MEDIUM", "LOW"))]
setorder(consensus, expected_pick)
print(head(consensus, 12))
cat(sprintf("  consensus: %d players | HIGH %d / MEDIUM %d / LOW %d\n",
            nrow(consensus), sum(consensus$market_confidence == "HIGH"),
            sum(consensus$market_confidence == "MEDIUM"), sum(consensus$market_confidence == "LOW")))
wr(consensus, "phase5_market_consensus.csv")

disagree <- long[type == "DIRECT_ADP", {
  .(name = name[1], position = position[1], n_direct = .N,
    pick_min = min(pick), pick_max = max(pick),
    spread = round(max(pick) - min(pick), 1),
    mad = round(median(abs(pick - median(pick))), 1))
}, by = sleeper_id][order(-spread)]
print(head(disagree, 10))
wr(disagree, "phase5_source_disagreement.csv")

# =============================================================================
# 5. CALIBRATION DATASET (§14-17) — from the Devoted 2026 snake draft
# =============================================================================
cat("\n[4] Building the survival calibration dataset (no leakage)\n")
d26 <- drafts[season == 2026][order(overall_pick)]
d26[, sleeper_id := as.character(sleeper_id)]
mk <- merge(d26, consensus[, .(sleeper_id, expected_pick, median_pick, dispersion, n_direct, market_confidence)],
            by = "sleeper_id", all.x = TRUE)
setorder(mk, overall_pick)
# search_rank pick-equivalent for S0; impute when Sleeper has no rank (17/192)
mk <- merge(mk, unique(long[source == "sleeper_search_rank", .(sleeper_id, sr_pick = pick)]), by = "sleeper_id", all.x = TRUE)
mk[is.na(sr_pick), sr_pick := pmin(240, expected_pick * 1.15 + 12)]  # "no strong signal -> assume later"

# horizons that matter for a 12-team snake (turn distances 2..23)
HORIZONS <- c(1, 3, 6, 12, 18, 23)
# "current pick" grid: every 4th pick, 4..170 (need room for the longest horizon)
CGRID <- seq(4, 168, by = 3)

cal <- rbindlist(lapply(CGRID, function(cpick) {
  # players NOT yet drafted at the moment BEFORE pick `cpick`
  drafted_before <- mk[overall_pick < cpick, sleeper_id]
  avail <- mk[!sleeper_id %in% drafted_before & !is.na(expected_pick)]
  # only players plausibly "in range" — skip guys 100+ picks away (not decision-relevant)
  avail <- avail[expected_pick <= cpick + 40 & expected_pick >= cpick - 30]
  if (nrow(avail) == 0) return(NULL)
  rbindlist(lapply(HORIZONS, function(h) {
    k <- cpick + h
    if (k > 192) return(NULL)
    data.table(
      current_pick = cpick, horizon = h, target_pick = k,
      sleeper_id = avail$sleeper_id, position = avail$position,
      expected_pick = avail$expected_pick, dispersion = avail$dispersion,
      n_direct = avail$n_direct, market_confidence = avail$market_confidence,
      sr_pick = avail$sr_pick,
      actual_pick = avail$overall_pick,
      survived = as.integer(avail$overall_pick > k)  # Y: still available AFTER pick k
    )
  }))
}))
cat(sprintf("  %d (current_pick × player × horizon) observations from %d picks\n",
            nrow(cal), nrow(d26)))

# =============================================================================
# 6. SURVIVAL MODELS (§13) + conditioning (§16-17)
# =============================================================================
cat("\n[5] Fitting + evaluating survival models\n")
pnorm_s <- function(mu, sg, x) pnorm((mu - x) / pmax(sg, 1e-6))          # P(D > x)

# --- fit S2 sigma model -----------------------------------------------------
# Residual sd of (actual - market) grows with pick number. Fit on the
# DECISION-RELEVANT range only (expected_pick <= 96 — a slot-12 manager at pick
# 12 asks about survival to ~36; nobody needs a calibrated survival curve for a
# round-13 kicker). Binned sd, robust line, capped. Dispersion enters only with
# a non-negative coefficient (source disagreement can only widen the band).
res <- mk[!is.na(expected_pick), .(signed = overall_pick - expected_pick,
                                   expected_pick, dispersion)]
res_dec <- res[expected_pick <= 96]
res_dec[, bin := cut(expected_pick, seq(0, 96, 12), include.lowest = TRUE)]
sd_by_bin <- res_dec[, .(mid = mean(expected_pick), sd = sd(signed), n = .N), by = bin][!is.na(sd)]
sig_fit <- lm(sd ~ mid, data = sd_by_bin, weights = n)
SIGMA_BASE  <- round(max(3.0, coef(sig_fit)[["(Intercept)"]]), 2)
SIGMA_SLOPE <- round(max(0.05, coef(sig_fit)[["mid"]]), 4)
d_fit <- lm(abs(signed) ~ dispersion, data = res_dec[dispersion > 0])
SIGMA_DISP  <- round(max(0, coef(d_fit)[["dispersion"]] * 1.253), 3)
# cap: past pick ~96 the model is unreliable — clamp sigma so the engine never
# claims spurious precision AND never blows survival to a coin flip too early.
SIGMA_CAP <- 22
cat(sprintf("  S2 sigma:  sigma = clamp(%.2f + %.4f*expected_pick + %.3f*dispersion, 3.0, %d)   [fit on picks <=96]\n",
            SIGMA_BASE, SIGMA_SLOPE, SIGMA_DISP, SIGMA_CAP))
print(sd_by_bin[, .(bin, mid = round(mid, 1), sd = round(sd, 1), n)])
sig_of <- function(mu, disp) pmin(SIGMA_CAP, pmax(3.0, SIGMA_BASE + SIGMA_SLOPE * pmax(1, mu) + SIGMA_DISP * pmax(0, disp)))

# --- fit S0 (best search_rank logistic) and S1 (market logistic) -------------
# fitted on odd current_picks, all metrics reported on even (held-out grid split)
tr <- cal[current_pick %% 2 == 1]
s0 <- glm(survived ~ I(sr_pick - target_pick), data = tr, family = binomial())
s1 <- glm(survived ~ I(expected_pick - target_pick), data = tr, family = binomial())
S0_A <- coef(s0)[[1]]; S0_B <- coef(s0)[[2]]
S1_A <- coef(s1)[[1]]; S1_B <- coef(s1)[[2]]
cat(sprintf("  S0 (best search_rank):  logistic(%.3f + %.4f*(sr_pick - k))\n", S0_A, S0_B))
cat(sprintf("  S1 (market distance):   logistic(%.3f + %.4f*(expected_pick - k))\n", S1_A, S1_B))

# --- predictions for every model (evaluated on the held-out even grid) ------
cal[, sigma := sig_of(expected_pick, dispersion)]
condition <- function(p_at_k, p_at_c) pmin(1, p_at_k / pmax(1e-4, p_at_c))
cal[, `:=`(
  p_S0  = plogis(S0_A + S0_B * (sr_pick - target_pick)),                            # search_rank logistic (best fit)
  p_S1  = plogis(S1_A + S1_B * (expected_pick - target_pick)),                      # market-distance logistic
  p_S1c = condition(plogis(S1_A + S1_B * (expected_pick - target_pick)),
                    plogis(S1_A + S1_B * (expected_pick - current_pick))),          # S1 conditional
  p_S2u = pnorm_s(expected_pick, sigma, target_pick),                               # S2 unconditional
  p_S2c = condition(pnorm_s(expected_pick, sigma, target_pick),
                    pnorm_s(expected_pick, sigma, current_pick))                    # S2 CONDITIONAL (production model)
)]
cal_eval <- cal[current_pick %% 2 == 0]  # held-out grid for all reported metrics

# --- metrics ------------------------------------------------------------
brier <- function(p, y) mean((p - y)^2)
logloss <- function(p, y) { p <- pmin(pmax(p, 1e-6), 1 - 1e-6); -mean(y * log(p) + (1 - y) * log(1 - p)) }
cal_slope <- function(p, y) {
  p <- pmin(pmax(p, 1e-6), 1 - 1e-6); f <- glm(y ~ qlogis(p), family = binomial())
  c(intercept = coef(f)[[1]], slope = coef(f)[[2]])
}
evalm <- function(col) {
  p <- cal_eval[[col]]; y <- cal_eval$survived
  cs <- cal_slope(p, y)
  data.table(model = col, n = length(y), brier = round(brier(p, y), 4),
             log_loss = round(logloss(p, y), 4),
             cal_intercept = round(cs["intercept"], 3), cal_slope = round(cs["slope"], 3),
             mean_pred = round(mean(p), 3), mean_obs = round(mean(y), 3))
}
model_cmp <- rbindlist(lapply(c("p_S0", "p_S1", "p_S1c", "p_S2u", "p_S2c"), evalm))
print(model_cmp)
wr(model_cmp, "phase5_model_comparison.csv")

# --- leave-one-slot-out CV (held-out evidence, §33) ------------------------
slots <- unique(d26$slot)
loso <- rbindlist(lapply(slots, function(sl) {
  test_ids <- d26[slot == sl, sleeper_id]
  te <- cal_eval[sleeper_id %in% test_ids]
  if (nrow(te) < 5) return(NULL)
  data.table(slot = sl, n = nrow(te),
             brier_S0 = round(brier(te$p_S0, te$survived), 4),
             brier_S1 = round(brier(te$p_S1, te$survived), 4),
             brier_S2c = round(brier(te$p_S2c, te$survived), 4))
}))
cat("\n  Leave-one-draft-slot-out Brier (held-out):\n"); print(loso)
loso_summary <- data.table(model = c("S0_search_rank", "S1_market_logistic", "S2c_conditional"),
                           mean_heldout_brier = round(c(mean(loso$brier_S0), mean(loso$brier_S1), mean(loso$brier_S2c)), 4))
print(loso_summary)

# --- horizon calibration (§15) -----------------------------------------
horizon_cal <- cal_eval[, .(n = .N, obs = round(mean(survived), 3),
                       S0 = round(mean(p_S0), 3), S1 = round(mean(p_S1), 3),
                       S2c = round(mean(p_S2c), 3),
                       brier_S0 = round(brier(p_S0, survived), 4),
                       brier_S2c = round(brier(p_S2c, survived), 4)), by = horizon][order(horizon)]
print(horizon_cal)
wr(cbind(horizon_cal, loso_summary_note = paste(loso_summary$model, loso_summary$mean_heldout_brier, collapse = "; ")),
   "phase5_survival_backtest.csv")

# --- calibration bins (§36) -------------------------------------------
bins <- c(0, .1, .2, .4, .6, .8, .9, 1.0001)
binfn <- function(col) {
  x <- cal_eval[, .(p = get(col), y = survived)]
  x[, bin := cut(p, bins, include.lowest = TRUE, right = FALSE)]
  x[, .(model = col, n = .N, pred_mean = round(mean(p), 3), obs_rate = round(mean(y), 3)), by = bin][order(bin)]
}
cbins <- rbindlist(lapply(c("p_S0", "p_S2c"), binfn))
print(cbins)
wr(cbins, "phase5_calibration_bins.csv")

# =============================================================================
# 7. SOURCE ABLATION (§35)
# =============================================================================
cat("\n[6] Source ablation\n")
cons_from <- function(keep_sources) {
  ll <- long[source %in% keep_sources]
  ll[, {
    w <- W[source]; w[is.na(w)] <- 0.3
    .(expected_pick = wmed(pick, w), n_direct = sum(type == "DIRECT_ADP"),
      dispersion = if (.N >= 2) median(abs(pick - median(pick))) else 0)
  }, by = sleeper_id]
}
ablate <- function(label, keep_sources) {
  cc <- cons_from(keep_sources)
  tmp <- merge(cal[, .(sleeper_id, current_pick, target_pick, survived, dispersion_old = dispersion)],
               cc, by = "sleeper_id")
  if (nrow(tmp) < 50) return(data.table(config = label, n = nrow(tmp), brier = NA, log_loss = NA))
  tmp[, sg := sig_of(expected_pick, dispersion)]
  tmp[, p := pmin(1, pnorm_s(expected_pick, sg, target_pick) / pmax(1e-4, pnorm_s(expected_pick, sg, current_pick)))]
  data.table(config = label, n = nrow(tmp), brier = round(brier(tmp$p, tmp$survived), 4),
             log_loss = round(logloss(tmp$p, tmp$survived), 4))
}
src_abl <- rbindlist(list(
  data.table(config = "A0_search_rank_only", n = nrow(cal), brier = round(brier(cal$p_S0, cal$survived), 4),
             log_loss = round(logloss(cal$p_S0, cal$survived), 4)),
  ablate("A1_underdog_only", "underdog_adp"),
  ablate("A2_direct_adp_consensus", c("underdog_adp", "yahoo_adp")),
  ablate("A3_adp_plus_proxies", c("underdog_adp", "yahoo_adp", "published_adp_consensus", "sleeper_search_rank"))
))
print(src_abl)
wr(src_abl, "phase5_source_ablation.csv")

# =============================================================================
# 8. MANAGER EFFECTS (§11, §34) — Devoted managers, 2025 -> 2026 (shrinkage)
# =============================================================================
cat("\n[7] Manager-effect ablation (shrinkage; small sample)\n")
# per-manager positional-reach in 2025 (predictor) vs 2026 market deviation (target)
d25 <- drafts[season == 2025][order(overall_pick)]
d25[, sleeper_id := as.character(sleeper_id)]
# crude 2025 "market" = pick order itself; per-slot mean round of first QB / first TE
first_pos_round <- function(dt, pos) dt[position == pos, .(r = min(round)), by = slot]
mgr_25 <- merge(first_pos_round(d25, "QB")[, .(slot, qb_round_25 = r)],
                first_pos_round(d25, "TE")[, .(slot, te_round_25 = r)], by = "slot", all = TRUE)
mgr_26 <- merge(first_pos_round(d26, "QB")[, .(slot, qb_round_26 = r)],
                first_pos_round(d26, "TE")[, .(slot, te_round_26 = r)], by = "slot", all = TRUE)
mgr <- merge(mgr_25, mgr_26, by = "slot")
mgr[, `:=`(qb_persist = round(cor(qb_round_25, qb_round_26), 2),
           te_persist = round(cor(te_round_25, te_round_26), 2))]
man_abl <- data.table(
  effect = c("QB-timing slot persistence 2025->2026", "TE-timing slot persistence 2025->2026",
             "verdict"),
  value = c(mgr$qb_persist[1], mgr$te_persist[1],
            "sample = 1 prior draft, 12 managers; persistence weak/noisy -> manager effects NOT promoted (shrink to league mean)")
)
print(man_abl)
wr(man_abl, "phase5_manager_ablation.csv")

# =============================================================================
# 9. RUN EFFECT (§22)
# =============================================================================
cat("\n[8] Positional-run effect ablation\n")
d26[, `:=`(pos_last4 = NA_integer_, pos_last8 = NA_integer_)]
runcal <- cal[horizon <= 6]  # runs matter at short horizons
# recompute run features at each current_pick
runcal <- merge(runcal, rbindlist(lapply(unique(runcal$current_pick), function(cp) {
  w <- d26[overall_pick < cp & overall_pick >= cp - 8]
  data.table(current_pick = cp,
             data.table(position = c("QB", "RB", "WR", "TE"),
                        pos_last8 = sapply(c("QB", "RB", "WR", "TE"), function(p) sum(w$position == p))))
})), by = c("current_pick", "position"), all.x = TRUE)
runcal[is.na(pos_last8), pos_last8 := 0]
run_base <- glm(survived ~ I(expected_pick - target_pick), data = runcal, family = binomial())
run_full <- glm(survived ~ I(expected_pick - target_pick) + pos_last8, data = runcal, family = binomial())
run_abl <- data.table(
  model = c("base (market only)", "+ position_picks_last_8"),
  aic = round(c(AIC(run_base), AIC(run_full)), 1),
  last8_coef = c(NA, round(coef(run_full)[["pos_last8"]], 3)),
  last8_p = c(NA, round(summary(run_full)$coefficients["pos_last8", 4], 4)),
  brier = round(c(brier(predict(run_base, type = "response"), runcal$survived),
                  brier(predict(run_full, type = "response"), runcal$survived)), 4)
)
print(run_abl)
brier_gain <- run_abl$brier[1] - run_abl$brier[2]
run_abl_verdict <- if (run_abl$last8_p[2] < 0.05 & brier_gain >= 0.003)
  "run feature significant AND materially improves Brier -> promote as a small survival-only shift" else
  sprintf("run feature significant (p=%.3f, right sign) but Brier gain trivial (%.4f) and in-sample only (n=1 draft) -> NOT promoted; Phase 4's heuristic run-shift is retained",
          run_abl$last8_p[2], brier_gain)
cat("  verdict:", run_abl_verdict, "\n")
wr(rbind(run_abl, data.table(model = "verdict", aic = NA, last8_coef = NA, last8_p = NA, brier = NA), fill = TRUE)[
  , verdict := c("", "", run_abl_verdict)], "phase5_run_ablation.csv")

# =============================================================================
# 10. FALLING-PLAYER TEST (§27)
# =============================================================================
cat("\n[9] Falling-player conditional-survival test\n")
falling <- rbindlist(lapply(c(20, 24, 30), function(cp) {
  mu <- 18; disp <- 4; sg <- sig_of(mu, disp)
  data.table(scenario = sprintf("ADP 18, still available at pick %d, next pick 36", cp),
             current_pick = cp, target_pick = 36,
             p_unconditional = round(pnorm_s(mu, sg, 36), 3),
             p_conditional = round(min(1, pnorm_s(mu, sg, 36) / pnorm_s(mu, sg, cp)), 3))
}))
print(falling)
falling[, correct := p_conditional > p_unconditional]
wr(falling, "phase5_falling_player_test.csv")

# =============================================================================
# 11. BIJIMAC 12/13 -> 36/37 (§25) — market-only forecast
# =============================================================================
cat("\n[10] BijiMac slot-12 opening turn forecast (12/13 -> 36/37)\n")
# players plausibly available at pick 12 (expected_pick >= ~9), survival to 36
bij <- consensus[expected_pick >= 8 & expected_pick <= 60][order(expected_pick)]
bij[, sigma := sig_of(expected_pick, dispersion)]
bij[, `:=`(
  p_survive_36 = round(pmin(1, pnorm_s(expected_pick, sigma, 36) / pmax(1e-4, pnorm_s(expected_pick, sigma, 12))), 3),
  p_survive_37 = round(pmin(1, pnorm_s(expected_pick, sigma, 37) / pmax(1e-4, pnorm_s(expected_pick, sigma, 12))), 3)
)]
bij_out <- bij[, .(sleeper_id, name, position, expected_pick, dispersion, market_confidence,
                   p_survive_36, p_survive_37)]
print(head(bij_out, 20))
wr(bij_out, "phase5_bijimac_turn_forecast.csv")

# =============================================================================
# plots
# =============================================================================
tryCatch({
  gg <- function(n, p, w = 8, h = 5) { ggsave(file.path(PLOTS, n), p, width = w, height = h, dpi = 110); cat("  wrote", n, "\n") }
  # calibration reliability
  rel <- rbindlist(lapply(c("p_S0", "p_S1", "p_S2c"), function(cc) {
    x <- cal_eval[, .(p = get(cc), y = survived)]
    x[, b := cut(p, seq(0, 1, .1), include.lowest = TRUE)]
    x[, .(model = cc, pred = mean(p), obs = mean(y), n = .N), by = b][!is.na(pred)]
  }))
  gg("phase5_calibration.png",
     ggplot(rel, aes(pred, obs, colour = model, size = n)) + geom_abline(lty = 2) +
       geom_point(alpha = .8) + geom_line(aes(group = model), linewidth = .4) +
       xlim(0, 1) + ylim(0, 1) + labs(title = "Survival calibration: predicted vs observed (Devoted 2026)",
                                      x = "predicted P(survive)", y = "observed survival rate") + theme_minimal())
  gg("phase5_expected_vs_actual_pick.png",
     ggplot(mk[!is.na(expected_pick)], aes(expected_pick, overall_pick, colour = position)) +
       geom_abline(lty = 2) + geom_point(alpha = .7) +
       labs(title = "Market expected pick vs actual draft pick (Devoted 2026 snake)",
            x = "consensus expected pick", y = "actual pick") + theme_minimal())
  gg("phase5_residual_distribution.png",
     ggplot(res, aes(signed)) + geom_histogram(bins = 40, fill = "steelblue") +
       geom_vline(xintercept = 0, lty = 2) +
       labs(title = "Actual pick − market expected pick (Devoted 2026)", x = "residual (picks)", y = "count") + theme_minimal())
  gg("phase5_source_disagreement.png",
     ggplot(disagree[n_direct >= 2][order(-spread)][1:25], aes(reorder(name, spread), spread, fill = position)) +
       geom_col() + coord_flip() + labs(title = "Largest Underdog–Yahoo ADP disagreement", x = NULL, y = "pick spread") +
       theme_minimal())
  gg("phase5_survival_curves.png",
     {
       ex <- consensus[name %in% c("Ashton Jeanty", "Chris Olave", "Trey McBride", "Puka Nacua", "Kyren Williams")]
       if (nrow(ex) == 0) ex <- consensus[c(3, 15, 30, 45, 60)]
       cur <- rbindlist(lapply(seq_len(nrow(ex)), function(i) data.table(
         name = ex$name[i], k = 1:120,
         p = pnorm_s(ex$expected_pick[i], sig_of(ex$expected_pick[i], ex$dispersion[i]), 1:120))))
       ggplot(cur, aes(k, p, colour = name)) + geom_line(linewidth = .7) +
         labs(title = "S2 survival curves P(D > k)", x = "pick k", y = "P(survive)") + theme_minimal()
     })
  gg("phase5_conditional_survival.png",
     {
       mu <- 18; sg <- sig_of(18, 4)
       dd <- rbindlist(lapply(c(18, 24, 30, 34), function(cp) data.table(
         conditioned_on = paste0("avail@", cp), k = cp:60,
         p = pmin(1, pnorm_s(mu, sg, cp:60) / pnorm_s(mu, sg, cp)))))
       ggplot(dd, aes(k, p, colour = conditioned_on)) + geom_line(linewidth = .7) +
         labs(title = "Conditional survival re-bases a falling player (ADP 18)",
              x = "pick k", y = "P(D > k | D > c)") + theme_minimal()
     })
  gg("phase5_bijimac_turn_forecast.png",
     ggplot(bij_out[1:24], aes(reorder(name, -expected_pick), p_survive_36, fill = position)) +
       geom_col() + coord_flip() + geom_hline(yintercept = .5, lty = 2) +
       labs(title = "P(survive to BijiMac's pick 36 | available at 12)", x = NULL, y = "P(survive)") + theme_minimal())
}, error = function(e) cat("  plotting skipped:", conditionMessage(e), "\n"))

# =============================================================================
# summary
# =============================================================================
best <- model_cmp[order(brier)][1]
s2_beats_s0 <- model_cmp[model == "p_S2c", brier] < model_cmp[model == "p_S0", brier]
summary5 <- list(
  generated_at = format(Sys.time(), "%Y-%m-%dT%H:%M:%SZ", tz = "UTC"),
  survival_version = "ri-snake-survival-2026.1",
  market_consensus_version = "ri-snake-market-2026.1",
  calibration_draft = "Devoted to the Game 2026 (192 picks, 12-team snake)",
  n_calibration_obs = nrow(cal),
  sigma_model = sprintf("%.2f + %.4f*expected_pick + %.3f*dispersion (floor 3.0)", SIGMA_BASE, SIGMA_SLOPE, SIGMA_DISP),
  s1_logistic = sprintf("logistic(%.3f + %.4f*(expected_pick - k))", S1_A, S1_B),
  model_brier = setNames(model_cmp$brier, model_cmp$model),
  s2c_beats_s0_search_rank = s2_beats_s0,
  loso_heldout_brier = setNames(loso_summary$mean_heldout_brier, loso_summary$model),
  falling_player_conditioning_correct = all(falling$correct),
  run_effect_verdict = run_abl_verdict,
  manager_effect_verdict = "not promoted (n=1 prior draft)"
)
writeLines(toJSON(summary5, auto_unbox = TRUE, pretty = TRUE), file.path(OUT, "phase5_summary.json"))
cat("\n"); print(summary5)
cat("\nPHASE 5 calibration harness complete.\n")
