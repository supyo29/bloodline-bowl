#!/usr/bin/env Rscript
# =============================================================================
# PHASE 6 — multi-round snake roster construction & trajectory validation.
#
# Does the frozen Phase 4/5 recommendation engine (D3) build strong MULTI-ROUND
# rosters, and does a bounded roster-need-gated trajectory adjustment (D4)
# materially improve them? The burden of proof is on the added complexity (§32).
#
#   npx tsx scripts/phase6-simulation.ts --n 500          # D0..D4 x slots 1/7/12
#   npx tsx scripts/phase6-manager-trajectory.ts --n 150  # BijiMac + Supyo29 audits
#   npx tsx scripts/phase6-timing.ts --n 120              # QB/TE/sequence/FLEX timing
#   npx tsx scripts/phase6-diagnostics.ts                 # failure modes + adversarial
#   Rscript analysis/phase6_roster_trajectory.R
#
# Ground-truth opponent behaviour: Phase 5 market consensus + softmax draws.
# Paired seeds (§31): all 5 strategies see identical opponent draws at each
# (slot, sim index), so the D3-vs-D4 comparison is a valid paired bootstrap.
#
# Fixed seeds. Outcome A (promote D4) / B (research pass, keep D3) / C (reject).
# =============================================================================

suppressWarnings(suppressMessages({
  library(data.table)
  library(ggplot2)
}))

set.seed(60606)
OUT   <- file.path("outputs", "projections-2026")
PLOTS <- file.path("analysis", "plots")
dir.create(PLOTS, showWarnings = FALSE, recursive = TRUE)
wr <- function(df, n) { fwrite(df, file.path(OUT, n)); cat("  wrote", n, "\n") }
rd <- function(n) {
  p <- file.path(OUT, n)
  if (!file.exists(p)) { cat("  MISSING", n, "- skipping\n"); return(NULL) }
  fread(p)
}

B <- 10000  # bootstrap resamples

# ---------------------------------------------------------------- load
raw  <- rd("phase6_simulation_raw.csv")
conv <- rd("phase6_convergence.csv")
stopifnot(!is.null(raw))

cat("\n=== PHASE 6 roster-trajectory analysis ===\n")
cat("strategies:", paste(sort(unique(raw$strategy)), collapse = ", "), "\n")
cat("slots:", paste(sort(unique(raw$slot)), collapse = ", "), "\n")
cat("sims per (slot,strategy):", raw[, .N, by = .(slot, strategy)][, unique(N)], "\n\n")

# ---------------------------------------------------------------- §5 utility sanity
# A "viable" roster fills every starter slot (open_starter_slots == 0).
raw[, viable := as.integer(open_starter_slots == 0)]

# ---------------------------------------------------------------- strategy comparison (§29)
strat_cmp <- raw[, .(
  n              = .N,
  util_p20       = round(quantile(utility, 0.20), 2),
  util_p50       = round(quantile(utility, 0.50), 2),
  util_p80       = round(quantile(utility, 0.80), 2),
  util_mean      = round(mean(utility), 2),
  util_sd        = round(sd(utility), 2),
  viable_rate    = round(mean(viable), 4),
  mean_open_slot = round(mean(open_starter_slots), 3),
  mean_QB        = round(mean(QB), 2),
  mean_RB        = round(mean(RB), 2),
  mean_WR        = round(mean(WR), 2),
  mean_TE        = round(mean(TE), 2),
  mean_K         = round(mean(K), 2),
  mean_DEF       = round(mean(DEF), 2)
), by = strategy][order(strategy)]
print(strat_cmp)
wr(strat_cmp, "phase6_strategy_comparison.csv")

# ---------------------------------------------------------------- slot comparison (§39/§40)
slot_cmp <- raw[, .(
  n           = .N,
  util_p50    = round(quantile(utility, 0.50), 2),
  util_mean   = round(mean(utility), 2),
  viable_rate = round(mean(viable), 4)
), by = .(slot, strategy)][order(slot, strategy)]
print(slot_cmp)
wr(slot_cmp, "phase6_slot_comparison.csv")

# ---------------------------------------------------------------- paired bootstrap (§31/§32)
# Pair on (slot, sim): D4 vs D3, and each simple strategy vs D3.
paired_boot <- function(dt, a, b) {
  wide <- dcast(dt[strategy %in% c(a, b)], slot + sim ~ strategy, value.var = "utility")
  setnames(wide, c(a, b), c("A", "B"))
  wide <- wide[!is.na(A) & !is.na(B)]
  d <- wide$A - wide$B
  bs <- replicate(B, mean(sample(d, length(d), replace = TRUE)))
  data.table(
    contrast      = paste0(a, " - ", b),
    n_pairs       = length(d),
    mean_diff     = round(mean(d), 2),
    median_diff   = round(median(d), 2),
    ci_lo         = round(quantile(bs, 0.025), 2),
    ci_hi         = round(quantile(bs, 0.975), 2),
    p_A_gt_B      = round(mean(d > 0), 4),
    win_margin_p50= round(median(d[d != 0]), 2),
    material      = as.character(abs(mean(d)) > 15 & sign(quantile(bs,0.025)) == sign(quantile(bs,0.975)))
  )
}

strategies <- sort(unique(raw$strategy))
contrasts <- list()
if (all(c("D4_trajectory","D3_frozen_engine") %in% strategies))
  contrasts[["D4_vs_D3_all"]] <- paired_boot(raw, "D4_trajectory", "D3_frozen_engine")
for (s in setdiff(strategies, "D3_frozen_engine"))
  if ("D3_frozen_engine" %in% strategies)
    contrasts[[paste0(s,"_vs_D3")]] <- paired_boot(raw, s, "D3_frozen_engine")

# D4 vs D3 per slot — the material question is whether D4 helps at ANY slot
for (sl in sort(unique(raw$slot)))
  if (all(c("D4_trajectory","D3_frozen_engine") %in% strategies))
    contrasts[[paste0("D4_vs_D3_slot",sl)]] <-
      cbind(slot = sl, paired_boot(raw[slot == sl], "D4_trajectory", "D3_frozen_engine"))

pb <- rbindlist(contrasts, fill = TRUE, idcol = "key")
print(pb)
wr(pb, "phase6_paired_bootstrap.csv")

# ---------------------------------------------------------------- ablation (§29 ladder)
# Each strategy's utility improvement over the naive D0 search-rank BPA baseline.
d0 <- raw[strategy == "D0_search_rank_bpa", .(slot, sim, d0 = utility)]
abl <- merge(raw, d0, by = c("slot","sim"))
abl <- abl[, .(
  mean_util          = round(mean(utility), 2),
  mean_gain_over_D0  = round(mean(utility - d0), 2),
  viable_rate        = round(mean(viable), 4)
), by = strategy][order(mean_util)]
print(abl)
wr(abl, "phase6_ablation.csv")

# ---------------------------------------------------------------- convergence (§25)
if (!is.null(conv)) {
  # last-half vs full running mean, per (slot,strategy): stable if within 2%.
  conv_chk <- conv[, {
    m_final <- running_mean_utility[.N]
    m_half  <- running_mean_utility[which.min(abs(n - max(n)/2))]
    .(n_max = max(n),
      mean_at_half = round(m_half, 2),
      mean_final   = round(m_final, 2),
      rel_drift    = round(abs(m_final - m_half) / pmax(1, abs(m_final)), 4))
  }, by = .(slot, strategy)]
  conv_chk[, converged := as.character(rel_drift < 0.02)]
  print(conv_chk)
  wr(conv_chk, "phase6_convergence_check.csv")

  p <- ggplot(conv, aes(n, running_mean_utility, colour = strategy)) +
    geom_line() + facet_wrap(~ slot, scales = "free_y", labeller = label_both) +
    labs(title = "Phase 6 — running-mean roster utility vs sim count",
         x = "simulations", y = "running mean utility") +
    theme_minimal(base_size = 10)
  ggsave(file.path(PLOTS, "phase6_convergence.png"), p, width = 10, height = 4, dpi = 120)
  cat("  wrote analysis/plots/phase6_convergence.png\n")
}

# ---------------------------------------------------------------- utility distribution plot
p <- ggplot(raw, aes(strategy, utility, fill = strategy)) +
  geom_violin(scale = "width", alpha = 0.6) +
  geom_boxplot(width = 0.15, outlier.size = 0.5) +
  facet_wrap(~ slot, labeller = label_both) +
  coord_flip() +
  labs(title = "Phase 6 — final roster utility by strategy and draft slot",
       subtitle = "D3 = frozen engine, D4 = D3 + bounded trajectory adjustment") +
  theme_minimal(base_size = 10) + theme(legend.position = "none")
ggsave(file.path(PLOTS, "phase6_utility_by_strategy.png"), p, width = 10, height = 5, dpi = 120)
cat("  wrote analysis/plots/phase6_utility_by_strategy.png\n")

# ---------------------------------------------------------------- D4-vs-D3 paired-diff plot
if (all(c("D4_trajectory","D3_frozen_engine") %in% strategies)) {
  w <- dcast(raw[strategy %in% c("D4_trajectory","D3_frozen_engine")],
             slot + sim ~ strategy, value.var = "utility")
  w[, diff := D4_trajectory - D3_frozen_engine]
  p <- ggplot(w, aes(diff)) +
    geom_histogram(bins = 60, fill = "#4463b0") +
    geom_vline(xintercept = 0, colour = "red") +
    facet_wrap(~ slot, labeller = label_both, scales = "free_y") +
    labs(title = "Phase 6 — paired utility difference (D4 - D3)",
         subtitle = "mass at 0 = trajectory adjustment did not change the pick; burden of proof is on D4 (§32)",
         x = "D4 utility - D3 utility (same opponents, same seed)") +
    theme_minimal(base_size = 10)
  ggsave(file.path(PLOTS, "phase6_d4_vs_d3_paired.png"), p, width = 10, height = 4, dpi = 120)
  cat("  wrote analysis/plots/phase6_d4_vs_d3_paired.png\n")
}

# ---------------------------------------------------------------- slot comparison plot
p <- ggplot(slot_cmp, aes(factor(slot), util_p50, fill = strategy)) +
  geom_col(position = "dodge") +
  labs(title = "Phase 6 — median final roster utility by draft slot", x = "draft slot", y = "median utility") +
  theme_minimal(base_size = 10)
ggsave(file.path(PLOTS, "phase6_slot_comparison.png"), p, width = 9, height = 4, dpi = 120)
cat("  wrote analysis/plots/phase6_slot_comparison.png\n")

# ---------------------------------------------------------------- position sequencing plot
seq_dt <- rd("phase6_position_sequence.csv")
if (!is.null(seq_dt)) {
  ycol <- intersect(c("final_utility_p50","util_p50","median_utility","p50"), names(seq_dt))[1]
  xcol <- intersect(c("scenario","sequence","opening_sequence","first_picks","seq"), names(seq_dt))[1]
  if (!is.na(ycol) && !is.na(xcol)) {
    p <- ggplot(seq_dt, aes(reorder(get(xcol), get(ycol)), get(ycol))) +
      geom_col(fill = "#4463b0") + coord_flip() +
      labs(title = "Phase 6 — final roster utility by opening sequence", x = xcol, y = ycol) +
      theme_minimal(base_size = 10)
    ggsave(file.path(PLOTS, "phase6_position_sequence.png"), p, width = 9, height = 4, dpi = 120)
    cat("  wrote analysis/plots/phase6_position_sequence.png\n")
  }
}

# ---------------------------------------------------------------- recovery cost by round plot
rec <- rd("phase6_recovery_cost.csv")
if (!is.null(rec)) {
  p <- ggplot(rec, aes(round, recovery_cost_vor, colour = position)) +
    geom_line() + geom_point() +
    labs(title = "Phase 6 — positional recovery cost (VOR) by round",
         subtitle = "expected VOR lost by postponing the next needed player at each position",
         x = "round", y = "recovery cost (VOR)") +
    theme_minimal(base_size = 10)
  ggsave(file.path(PLOTS, "phase6_recovery_cost.png"), p, width = 9, height = 4, dpi = 120)
  cat("  wrote analysis/plots/phase6_recovery_cost.png\n")
}

# ---------------------------------------------------------------- BijiMac audit (§39)
bij <- rd("phase6_bijimac_trajectory.csv")
if (!is.null(bij)) {
  bij_rank <- bij[order(-final_utility_p50), .(
    pair, source,
    p20 = final_utility_p20, p50 = final_utility_p50, p80 = final_utility_p80,
    viable = viable_roster_rate, mean_open_final = mean_open_starter_slots_final
  )]
  cat("\n[BijiMac Slot-12 pairs, ranked by median final roster utility]\n")
  print(bij_rank)
  wr(bij_rank, "phase6_bijimac_ranked.csv")

  bl <- melt(bij_rank, id.vars = "pair", measure.vars = c("p20","p50","p80"))
  p <- ggplot(bl, aes(reorder(pair, value), value, colour = variable, group = pair)) +
    geom_line(colour = "grey70") + geom_point(size = 2) + coord_flip() +
    labs(title = "Phase 6 — BijiMac slot-12 opening pair: final roster utility (P20/P50/P80)",
         x = NULL, y = "final roster utility", colour = NULL) +
    theme_minimal(base_size = 9)
  ggsave(file.path(PLOTS, "phase6_bijimac_trajectory.png"), p, width = 10, height = 4.5, dpi = 120)
  cat("  wrote analysis/plots/phase6_bijimac_trajectory.png\n")

  snap <- rd("phase6_bijimac_snapshots.csv")
  if (!is.null(snap)) {
    p <- ggplot(snap, aes(turn, p50, colour = pair, group = pair)) +
      geom_line() + geom_ribbon(aes(ymin = p20, ymax = p80, fill = pair), alpha = 0.12, colour = NA) +
      labs(title = "Phase 6 — BijiMac roster-utility trajectory across her turns",
           x = "turn (overall picks)", y = "roster utility (P20–P80 band, P50 line)") +
      theme_minimal(base_size = 9) + theme(legend.position = "bottom")
    ggsave(file.path(PLOTS, "phase6_bijimac_snapshots.png"), p, width = 10, height = 5, dpi = 120)
    cat("  wrote analysis/plots/phase6_bijimac_snapshots.png\n")
  }
}

# ---------------------------------------------------------------- Supyo29 audit (§40)
sup <- rd("phase6_supyo29_utility.csv")
supt <- rd("phase6_supyo29_trajectory.csv")
if (!is.null(supt)) { cat("\n[Supyo29 turn-by-turn]\n"); print(supt) }
if (!is.null(sup))  { cat("\n[Supyo29 final roster utility]\n"); print(sup) }

supp <- rd("phase6_supyo29_paths.csv")
if (!is.null(supp)) {
  sc <- intersect(c("share","frequency","freq","rate"), names(supp))[1]
  xc <- intersect(c("first_3_picks_by_position","path","sequence"), names(supp))[1]
  if (!is.na(sc) && !is.na(xc)) {
    p <- ggplot(supp, aes(reorder(get(xc), get(sc)), get(sc))) +
      geom_col(fill = "#3f7d54") + coord_flip() +
      labs(title = "Phase 6 — Supyo29 (slot 7): frequency of first-3-turn positional paths",
           x = NULL, y = "share of simulated drafts") +
      theme_minimal(base_size = 10)
    ggsave(file.path(PLOTS, "phase6_supyo29_trajectory.png"), p, width = 9, height = 4, dpi = 120)
    cat("  wrote analysis/plots/phase6_supyo29_trajectory.png\n")
  }
}

# ---------------------------------------------------------------- decision (§51)
cat("\n=== DECISION INPUTS (§51) ===\n")
if (!is.null(pb)) {
  d4row <- pb[key == "D4_vs_D3_all"]
  if (nrow(d4row)) {
    cat(sprintf("D4 - D3 overall: mean %.2f, 95%% CI [%.2f, %.2f], P(D4>D3)=%.3f, material=%s\n",
                d4row$mean_diff, d4row$ci_lo, d4row$ci_hi, d4row$p_A_gt_B, d4row$material))
    anyslot <- pb[grepl("D4_vs_D3_slot", key) & material == "TRUE"]
    cat(sprintf("slots where D4 materially beats D3: %s\n",
                if (nrow(anyslot)) paste(anyslot$slot, collapse = ", ") else "NONE"))
  }
}
d3v <- strat_cmp[strategy == "D3_frozen_engine"]
if (nrow(d3v))
  cat(sprintf("D3 viable-roster rate: %.3f ; D3 median utility: %.1f ; mean open starter slots: %.3f\n",
              d3v$viable_rate, d3v$util_p50, d3v$mean_open_slot))

cat("\nRule: promote D4 (Outcome A) only if it materially and reliably beats D3\n")
cat("      (|mean diff| > ~15 utility AND bootstrap CI excludes 0) at >=1 slot,\n")
cat("      with no slot made materially worse. Otherwise Outcome B (research pass).\n")
cat("\nDone.\n")
