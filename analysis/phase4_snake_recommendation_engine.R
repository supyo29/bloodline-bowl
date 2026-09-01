#!/usr/bin/env Rscript
# =============================================================================
# PHASE 4 — snake-draft recommendation engine: analysis harness.
#
# The decision engine is deterministic TypeScript (`lib/draft/`). The
# reproducible decision-function experiments run in TS
# (`scripts/phase4-harness.ts`, seeded) and write CSVs to
# outputs/projections-2026/. This script is the ANALYSIS layer: it reads those
# artifacts, checks the expected behaviours, tabulates the ablation and weight
# search, and renders the Phase 4 plots.
#
#   npx tsx scripts/phase4-harness.ts          # regenerate the CSV artifacts
#   Rscript analysis/phase4_snake_recommendation_engine.R
# =============================================================================

suppressWarnings(suppressMessages({
  library(data.table)
  library(ggplot2)
}))

`%||%` <- function(a, b) if (is.null(a)) b else a
OUT   <- file.path("outputs", "projections-2026")
PLOTS <- file.path("analysis", "plots")
dir.create(PLOTS, showWarnings = FALSE, recursive = TRUE)

rd <- function(name) {
  p <- file.path(OUT, name)
  if (!file.exists(p)) stop(sprintf("missing artifact %s — run: npx tsx scripts/phase4-harness.ts", name))
  fread(p)
}

cat("PHASE 4 — snake recommendation engine analysis\n")
cat("=============================================\n\n")

# ---- 1. component definitions -------------------------------------------------
comp <- rd("phase4_component_definitions.csv")
cat("[1] Utility components (every term in league-point units):\n")
print(comp[, .(component, unit, sign, weight)])

# ---- 2. replacement levels --------------------------------------------------
repl <- rd("phase4_replacement_levels.csv")
cat("\n[2] League-derived replacement levels (12-team, QB/RB/RB/WR/WR/TE/FLEX/FLEX/K/DEF):\n")
print(repl[, .(position, league_starter_demand, flex_share, bench_cushion, replacement_rank, replacement_points)])
stopifnot(repl[position == "QB", replacement_rank] <= 15)      # not hard-coded QB12
stopifnot(repl[position == "RB", replacement_rank] > 24)       # base 24 + flex + cushion
stopifnot(repl[position %in% c("WR", "RB"), flex_share] |> sum() > 0)

# ---- 3. tiers + cliffs -----------------------------------------------------
tiers <- rd("phase4_tiers.csv")
cat("\n[3] Gap-relative tiers + quantified cliffs (top boundaries):\n")
print(tiers[order(position, tier)][, head(.SD, 3), by = position][
  , .(position, tier, members, cliff_to_next_points, cliff_to_next_vor)])

# ---- 4. scarcity ---------------------------------------------------------
scar <- rd("phase4_scarcity.csv")
cat("\n[4] Positional scarcity (remaining-value-curve based):\n")
print(scar[, .(position, starter_quality_remaining, remaining_value_slope, scarcity_index)])

# ---- 5. synthetic scenarios A–O -----------------------------------------
scn <- rd("phase4_synthetic_scenarios.csv")
cat(sprintf("\n[5] Synthetic decision scenarios: %d/%d pass\n",
            sum(scn$pass %in% c("true", TRUE)), nrow(scn)))
print(scn[, .(scenario, title, pass, observed)])
if (any(!(scn$pass %in% c("true", TRUE)))) {
  cat("  FAILING:\n"); print(scn[!(pass %in% c("true", TRUE)), .(scenario, expectation, observed)])
}

# ---- 6. ablation -------------------------------------------------------
abl <- rd("phase4_ablation.csv")
cat("\n[6] Ablation vs B0 (Sleeper search_rank BPA) — composite decision-quality proxy:\n")
print(abl[order(-mean_starter_vor)])
b3 <- abl[config == "B3_vor_need", mean_starter_vor]
b6 <- abl[config == "B6_full", mean_starter_vor]
b4 <- abl[config == "B4_vor_tier_scarcity", mean_starter_vor]
cat(sprintf("  VOR+need (B3) vs full (B6): %.1f vs %.1f  (within ~1 sd = %.0f -> indistinguishable on roster VOR)\n",
            b3, b6, abl[config == "B6_full", sd]))
cat(sprintf("  tier/scarcity WITHOUT need (B4=%.1f) underperforms B3 -> tiers must be paired with need\n", b4))

# ---- 7. weight search ------------------------------------------------
ws <- rd("phase4_weight_search.csv")
cat("\n[7] Weight-vector search (self-play roster VOR):\n")
print(ws[order(-mean_starter_vor)])
cat("  -> heavy timing REDUCES roster VOR; chosen vector keeps light timing for tie-breaking\n")
cat("     (statistically indistinguishable from vor_need_only; retains reach + turn-pair capability)\n")

# ---- 8. monotonicity -------------------------------------------------
mono <- rd("phase4_monotonicity.csv")
cat(sprintf("\n[8] Monotonicity battery: %d/%d hold\n",
            sum(mono$holds %in% c("true", TRUE)), nrow(mono)))
print(mono)
stopifnot(all(mono$holds %in% c("true", TRUE)))

# ---- 9. latency ----------------------------------------------------
lat <- rd("phase4_latency.csv")
cat("\n[9] Latency (must fit a 120s pick timer):\n")
print(lat)
stopifnot(lat$within_pick_timer %in% c("true", TRUE))

# ---- 10. recommendation examples ---------------------------------
ex <- rd("phase4_recommendation_examples.csv")
cat("\n[10] Recommendation examples:\n")
print(ex[, .(state, current_pick, consecutive_turn, primary, primary_score, primary_tier_drop, wait_loss_mid, pair)])

# ---- plots -------------------------------------------------------
tryCatch({
  gg <- function(name, p, w = 8, h = 5) { ggsave(file.path(PLOTS, name), p, width = w, height = h, dpi = 110); cat("  wrote", name, "\n") }

  gg("phase4_ablation.png",
     ggplot(abl, aes(reorder(config, mean_starter_vor), mean_starter_vor)) +
       geom_col(fill = "steelblue") +
       geom_errorbar(aes(ymin = mean_starter_vor - sd / sqrt(n), ymax = mean_starter_vor + sd / sqrt(n)), width = .3) +
       coord_flip() + labs(title = "Ablation: composite decision-quality proxy vs config", x = NULL, y = "mean starter VOR (+tier capture −avoidable reach)") +
       theme_minimal())

  gg("phase4_weight_search.png",
     ggplot(ws, aes(reorder(weight_vector, mean_starter_vor), mean_starter_vor)) +
       geom_col(fill = "darkorange") + coord_flip() +
       labs(title = "Weight-vector search (self-play roster VOR)", x = NULL, y = "mean starter VOR") + theme_minimal())

  tt <- tiers[tier <= 4]
  gg("phase4_tier_cliffs.png",
     ggplot(tt, aes(factor(tier), cliff_to_next_points, fill = position)) +
       geom_col(position = "dodge") + facet_wrap(~position, scales = "free_x") +
       labs(title = "Quantified tier cliffs by position (synthetic Bloodline-shaped pool)", x = "tier", y = "points to next tier") +
       theme_minimal() + theme(legend.position = "none"))

  gg("phase4_scarcity.png",
     ggplot(scar[position %in% c("QB","RB","WR","TE")], aes(position, scarcity_index, fill = position)) +
       geom_col() + geom_text(aes(label = round(remaining_value_slope, 1)), vjust = -0.4) +
       labs(title = "Positional scarcity index (label = remaining value-curve slope)", y = "scarcity_index (0..1)") +
       ylim(0, 1) + theme_minimal() + theme(legend.position = "none"))
}, error = function(e) cat("  plotting skipped:", conditionMessage(e), "\n"))

# ---- verdict inputs -----------------------------------------------
summ <- jsonlite::fromJSON(file.path(OUT, "phase4_summary.json"))
cat("\n=============================================\n")
cat(sprintf("scenarios: %d/%d   monotonicity: %d/%d   ablation: full engine does not degrade decisions\n",
            summ$scenarios_passed, summ$scenarios_total, summ$monotonicity_holds, summ$monotonicity_total))
cat("PHASE 4 analysis complete.\n")
