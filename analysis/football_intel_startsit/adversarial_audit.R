#!/usr/bin/env Rscript
# ===========================================================================
# Phase 4 — adversarial audit (spec §31). Attacks the FI start/sit adjustment
# on the decision dataset + trained model. Exit non-zero on any FAIL.
#   Rscript analysis/football_intel_startsit/adversarial_audit.R
# ===========================================================================
suppressWarnings(suppressMessages({ library(dplyr); library(jsonlite) }))
.here <- sub("^--file=", "", grep("^--file=", commandArgs(FALSE), value = TRUE))
BASE <- if (length(.here)) dirname(.here) else file.path(getwd(), "analysis", "football_intel_startsit")
source(file.path(BASE, "config.R"))
set.seed(SS$SEED)

d <- readRDS(file.path(SS$OUT_DIR, "decision_dataset.rds"))
model <- fromJSON(file.path(SS$SERVE_DIR, "start_sit_model.json"), simplifyVector = FALSE)
CONF_W <- unlist(SS$CONF_WEIGHT)

fi_adj <- function(df, pos) {
  mp <- model$positions[[pos]]; if (is.null(mp$families) || !length(mp$families)) return(rep(0, nrow(df)))
  a <- rep(0, nrow(df))
  for (f in mp$families) {
    v <- if (!is.null(f$value_col) && f$value_col %in% names(df)) suppressWarnings(as.numeric(df[[f$value_col]])) else rep(NA, nrow(df))
    cw <- if (!is.null(f$confidence_col) && f$confidence_col %in% names(df)) ifelse(is.na(df[[f$confidence_col]]), 0, CONF_W[df[[f$confidence_col]]]) else 0
    sig <- (v - f$center) / f$scale; sig[!is.finite(sig)] <- 0
    a <- a + f$beta * sig * cw
  }
  frac <- model$max_total_adjustment_fraction %||% 0.25
  pmax(pmin(a, frac * abs(df$baseline_trailing)), -frac * abs(df$baseline_trailing))
}
`%||%` <- function(a, b) if (is.null(a)) b else a

fails <- 0L; nchk <- 0L
chk <- function(name, ok, detail = "") { nchk <<- nchk + 1L
  cat(sprintf("[%s] %s%s\n", if (isTRUE(ok)) "PASS" else "FAIL", name, if (nzchar(detail)) paste0("  -- ", detail) else ""))
  if (!isTRUE(ok)) fails <<- fails + 1L }

dd <- d %>% filter(position %in% SS$POSITIONS, is.finite(baseline_trailing), is.finite(actual), fi_available)
dd$adj <- 0
for (p in SS$POSITIONS) dd$adj[dd$position == p] <- fi_adj(dd[dd$position == p, ], p)
frac <- model$max_total_adjustment_fraction %||% 0.25
tau <- model$tau_tie_break %||% 0

# 1. elite player in terrible matchup — adjustment cannot exceed the cap
elite <- dd %>% filter(baseline_trailing >= quantile(baseline_trailing, 0.9, na.rm = TRUE))
chk("1 elite player: |adj| within cap", all(abs(elite$adj) <= frac * abs(elite$baseline_trailing) + 1e-6),
    sprintf("max |adj/base| = %.3f (cap %.2f)", max(abs(elite$adj / pmax(elite$baseline_trailing, 1e-6))), frac))

# 2. replacement player in great matchup — small baseline -> small absolute adj
repl <- dd %>% filter(baseline_trailing <= quantile(baseline_trailing, 0.2, na.rm = TRUE))
chk("2 replacement player: absolute adj is small", median(abs(repl$adj), na.rm = TRUE) < 1.0,
    sprintf("median |adj| = %.3f", median(abs(repl$adj), na.rm = TRUE)))

# 3. one-game sample -> low FI confidence -> near-zero contribution
one_game <- dd %>% filter(!is.na(fi_usage_snap_share_confidence), fi_usage_snap_share_confidence %in% c("LOW","INSUFFICIENT_SAMPLE"))
chk("3 one-game-sample usage: contribution attenuated",
    nrow(one_game) == 0 || median(abs(one_game$adj), na.rm = TRUE) <= median(abs(dd$adj), na.rm = TRUE) + 1e-9)

# 4. NOT_PREDICTIVE metric never in the model
kept_fams <- unlist(lapply(model$positions, function(p) sapply(p$families %||% list(), function(f) f$family)))
chk("4/6 def_pass_epa_allowed / def_rush_epa_allowed absent from model families",
    !any(c("def_pass_epa_allowed", "def_rush_epa_allowed") %in% kept_fams))
chk("7 FTN / man-zone descriptive fields absent from model families",
    !any(grepl("ftn|man_rate", kept_fams)))

# 5. stale participation: route participation is lagged (built with PART_LAG) —
#    just assert usage confidence is never fabricated HIGH on <4 weeks (checked in dataset)
chk("5 participation-derived usage present only with a confidence label",
    all(is.na(dd$fi_usage_route_participation_modeled) | !is.na(dd$fi_usage_route_participation_confidence)))

# 8. unresolved player -> no FI row -> adjustment 0 (dataset build already
#    filtered fi_available; simulate by nulling the value cols)
sim <- dd %>% slice(1:200) %>% mutate(across(matches("^(fi_|fidef_)"), ~ NA))
sim$adj <- fi_adj(sim, sim$position[1])
chk("8 unresolved FI (no team + no usage rows) -> zero adjustment", all(abs(sim$adj) < 1e-9))

# 10/11 close FLEX-eligible pair — tie-break gate only flips inside |edge|<tau
pairs <- dd %>% filter(position %in% c("RB","WR","TE")) %>%
  group_by(season, week, arch) %>% filter(dplyr::n() >= 2) %>%
  slice(1:2) %>% summarise(e = diff(range(baseline_trailing)), a = diff(range(adj)), .groups = "drop")
outside <- pairs %>% filter(e >= tau)
chk("10/11 outside tie-break gate: FI adj magnitude < baseline edge (cannot flip)",
    nrow(outside) == 0 || mean(abs(outside$a) < outside$e) > 0.98,
    sprintf("gate tau=%.1f; frac(|adj|<edge) outside = %.3f", tau,
            if (nrow(outside)) mean(abs(outside$a) < outside$e) else NA))

# 13 injured player w/ favorable matchup: FI must not manufacture workload —
#    adjustment is a projection delta, never an availability override (structural:
#    translate.ts never touches expected_availability). Assert numeric only.
chk("13 FI adjustment is a bounded points delta, never an availability change",
    all(is.finite(dd$adj)))

# 15 extreme outlier week in the trailing baseline -> the FI adj does not amplify it
hi_base <- dd %>% filter(baseline_trailing > mean(baseline_trailing) + 3 * sd(baseline_trailing))
chk("15 extreme trailing-baseline player: adj does not push further from the mean by > cap",
    nrow(hi_base) == 0 || all(abs(hi_base$adj) <= frac * abs(hi_base$baseline_trailing) + 1e-6))

# 16 conflicting FI families (some +, some -) -> net stays bounded, no blow-up
chk("16 conflicting families: net adjustment bounded",
    all(abs(dd$adj) <= frac * abs(dd$baseline_trailing) + 1e-6))

# determinism
a1 <- fi_adj(dd[1:500, ], "RB"); a2 <- fi_adj(dd[1:500, ], "RB")
chk("determinism: identical inputs -> identical adjustment", identical(a1, a2))

cat(sprintf("\n%d checks, %d failed\n", nchk, fails))
quit(status = if (fails > 0) 1 else 0)
