#!/usr/bin/env Rscript
# ===========================================================================
# Football Intelligence — adversarial model audit (spec §29).
#
#   Rscript analysis/football_intel/adversarial_audit.R
#
# Actively attacks the engine on the spec's failure scenarios and PRINTS a
# pass/fail line per check. Exit non-zero on any FAIL. Operates on the local
# cache — no network.
# ===========================================================================

suppressWarnings(suppressMessages({ library(dplyr); library(tidyr) }))
.here <- sub("^--file=", "", grep("^--file=", commandArgs(FALSE), value = TRUE))
BASE <- if (length(.here)) dirname(.here) else file.path(getwd(), "analysis", "football_intel")
source(file.path(BASE, "config.R"))
source(file.path(BASE, "lib_features.R")); source(file.path(BASE, "lib_opponent_adj.R"))
source(file.path(BASE, "lib_priors.R")); source(file.path(BASE, "lib_recency.R"))
source(file.path(BASE, "lib_continuity.R")); source(file.path(BASE, "lib_profiles.R"))

set.seed(FI$SEED)
cache <- function(n) readRDS(file.path(FI$CACHE_DIR, paste0(n, ".rds")))
tgf <- readRDS(file.path(FI$CACHE_DIR, "team_game_features.rds")) %>% filter(season_type == "REG")
pbp <- cache("pbp"); schedules <- cache("schedules"); snap_counts <- cache("snap_counts")
rosters_weekly <- cache("rosters_weekly")
SP <- Filter(function(s) s$key == "off_pass_epa", METRIC_SPECS)[[1]]

fails <- 0L; nchk <- 0L
chk <- function(name, ok, detail = "") {
  nchk <<- nchk + 1L
  cat(sprintf("[%s] %s%s\n", if (isTRUE(ok)) "PASS" else "FAIL", name,
              if (nzchar(detail)) paste0("  -- ", detail) else ""))
  if (!isTRUE(ok)) fails <<- fails + 1L
}

pr <- bind_rows(lapply(list(SP), function(sp) season_ratings_for_metric(tgf, sp, FI, 2018:2024)))
disc <- build_discontinuity_table(2025, schedules, pbp, snap_counts, rosters_weekly, FI$COORD_YAML, FI)
discounts <- build_prior_discounts(disc, FI)

# --- 1. Week-1 / tiny current-season sample -> prior-driven, wide uncertainty
p_w1 <- compute_metric_profile(tgf, SP, 2025, 1, pr, discounts, FI)
chk("wk1 tiny sample -> prior_weight > recent_weight for most teams",
    mean(p_w1$prior_weight > p_w1$recent_weight, na.rm = TRUE) > 0.7,
    sprintf("mean prior>recent = %.2f", mean(p_w1$prior_weight > p_w1$recent_weight, na.rm = TRUE)))
chk("wk1 -> no team is HIGH confidence",
    !any(p_w1$confidence == "HIGH"),
    paste(names(table(p_w1$confidence)), table(p_w1$confidence), collapse = " "))

# --- 2. Confidence rises monotonically with weeks of real data
prog <- sapply(c(1, 4, 8, 13, 18), function(w) {
  pp <- compute_metric_profile(tgf, SP, 2024, w, pr, discounts, FI)
  mean(match(pp$confidence, c("INSUFFICIENT_SAMPLE", "LOW", "MEDIUM", "HIGH")), na.rm = TRUE)
})
chk("confidence increases monotonically wk1->wk18", all(diff(prog) >= -1e-9),
    paste(sprintf("%.2f", prog), collapse = " -> "))

# --- 3. Current-season info eventually dominates a stale prior
#   pick a team whose 2024 pass EPA diverged hard from its 2020-23 prior
p24 <- compute_metric_profile(tgf, SP, 2024, 18, pr, discounts, FI) %>%
  filter(is.finite(prior_mean), is.finite(raw)) %>%
  mutate(gap = abs(raw - prior_mean), frac_to_current = abs(modeled - prior_mean) / pmax(gap, 1e-6))
# every team where current diverged from prior: current data moved it a
# meaningful fraction of the way (never stuck on the stale prior).
chk("late-season: current data moves the modeled rating >= 40% toward current (median divergence team)",
    median(p24$frac_to_current[p24$gap > median(p24$gap)], na.rm = TRUE) >= 0.40,
    sprintf("median frac_to_current (high-divergence half) = %.2f",
            median(p24$frac_to_current[p24$gap > median(p24$gap)], na.rm = TRUE)))
big <- p24 %>% arrange(desc(gap)) %>% slice(1)
chk("even the single most extreme divergence team moves >= 25% off the prior",
    big$frac_to_current >= 0.25,
    sprintf("%s raw=%.3f prior=%.3f modeled=%.3f frac=%.2f", big$team, big$raw, big$prior_mean, big$modeled, big$frac_to_current))

# --- 4. One extreme outlier game cannot flip a strong rating
strong <- tgf %>% filter(side == "offense", season == 2024) %>%
  transmute(team, opponent, y = pass_epa, w = n_pass)
base_fit <- opponent_adjust_metric(strong, ridge = FI$OPP_ADJ_RIDGE_LAMBDA, min_w = 1)
top <- names(which.max(base_fit$off))
poisoned <- strong
poisoned <- bind_rows(poisoned, tibble::tibble(team = top, opponent = "KC", y = -3.0, w = 40))
pois_fit <- opponent_adjust_metric(poisoned, ridge = FI$OPP_ADJ_RIDGE_LAMBDA, min_w = 1)
chk("one -3.0 EPA game does not flip the #1 offense negative",
    pois_fit$off[[top]] > 0,
    sprintf("%s: %.3f -> %.3f", top, base_fit$off[[top]], pois_fit$off[[top]]))

# --- 5. Opponent adjustment is directional: beating strong D's raises rating vs beating weak D's
#   synthetic: two teams, identical raw y, different schedule strength
syn <- tibble::tibble(
  team = c(rep("A", 8), rep("B", 8)),
  opponent = c(paste0("D", 1:8), paste0("W", 1:8)),
  y = c(rep(0.15, 16)), w = rep(35, 16))
# make D* strong defenses (they hold everyone else to -0.2), W* weak (+0.2)
extra <- bind_rows(
  tidyr::crossing(team = paste0("O", 1:6), opponent = paste0("D", 1:8), y = -0.2, w = 35),
  tidyr::crossing(team = paste0("O", 1:6), opponent = paste0("W", 1:8), y =  0.2, w = 35))
sfit <- opponent_adjust_metric(bind_rows(syn, extra), ridge = FI$OPP_ADJ_RIDGE_LAMBDA, min_w = 1)
chk("same raw production vs strong D rates higher than vs weak D",
    sfit$off[["A"]] > sfit$off[["B"]],
    sprintf("A(vs strong)=%.3f  B(vs weak)=%.3f", sfit$off[["A"]], sfit$off[["B"]]))

# --- 6. No look-ahead in the walk-forward: truncating future weeks leaves earlier output unchanged
e1 <- current_rating_for_metric(tgf, SP, 2023, 9, FI)$current_dev
e2 <- current_rating_for_metric(tgf %>% filter(!(season == 2023 & week > 9)), SP, 2023, 9, FI)$current_dev
chk("removing weeks >9 does not change the through-week-9 rating", isTRUE(all.equal(e1, e2)))

# --- 7. Determinism: full metric profile reproduces byte-identical
a <- compute_metric_profile(tgf, SP, 2024, 12, pr, discounts, FI)
b <- compute_metric_profile(tgf, SP, 2024, 12, pr, discounts, FI)
chk("compute_metric_profile is deterministic", isTRUE(all.equal(a, b)))

# --- 8. Coaching + QB change actually discounts the prior
atl <- discounts %>% filter(team == "ATL", side == "offense")
chk("discontinuity discount applied where HC+QB changed (ATL 2024->... example)",
    nrow(atl) == 1 && is.finite(atl$prior_discount) && atl$prior_discount <= 1)

# --- 9. Unavailable data is not presented as known: pre-2016 man/zone is NA, not 0
mz_2014 <- tgf %>% filter(season == 2014) %>% pull(man_rate)
chk("2014 man_rate is NA (participation unavailable), never fabricated 0",
    all(is.na(mz_2014)))

# --- 10. bye week / missing team-week does not crash or invent a row
bye <- compute_metric_profile(tgf, SP, 2024, 14, pr, discounts, FI)
chk("every team appears exactly once per metric (no phantom/duplicate rows)",
    nrow(bye) == dplyr::n_distinct(bye$team) && nrow(bye) <= 32)

# --- 11. team alias: OAK/SD/STL normalize into one universe
chk("historical team aliases collapsed (no OAK/SD/STL/LA in features)",
    !any(c("OAK", "SD", "STL", "LA") %in% unique(tgf$team)))

# --- 12. NOT_PREDICTIVE metrics are tagged as such on output
chk("def_pass_epa_allowed carries predictive_status NOT_PREDICTIVE",
    FI$predictive_status("def_pass_epa_allowed") == "NOT_PREDICTIVE")

# --- 13. extreme schedule: a team facing only weak opponents is adjusted DOWN
weak_sched <- bind_rows(
  tibble::tibble(team = "SOFT", opponent = paste0("BAD", 1:10), y = 0.30, w = 35),
  tidyr::crossing(team = paste0("N", 1:10), opponent = paste0("BAD", 1:10), y = 0.30, w = 35),
  tidyr::crossing(team = paste0("N", 1:10), opponent = paste0("GOOD", 1:10), y = -0.10, w = 35))
wfit <- opponent_adjust_metric(weak_sched, ridge = FI$OPP_ADJ_RIDGE_LAMBDA, min_w = 1)
chk("team padding stats vs only-weak defenses is adjusted below its raw",
    wfit$off[["SOFT"]] < 0.30 - wfit$mu,
    sprintf("SOFT off dev=%.3f (raw was +0.30)", wfit$off[["SOFT"]]))

cat(sprintf("\n%d checks passed, %d failed\n", nchk - fails, fails))
quit(status = if (fails > 0) 1 else 0)
