#!/usr/bin/env Rscript
# Phase 5 — REAL_HISTORICAL_MATCHUPS cross-check (devoted league chain) +
# simulation convergence audit (spec §12, §14, §15). Reported SEPARATELY from
# the synthetic calibration — never merged (spec §10, §14).
#
#   Rscript analysis/football_intel_matchup/real_crosscheck_and_convergence.R

suppressWarnings(suppressMessages({ library(dplyr); library(jsonlite) }))
.here <- sub("^--file=", "", grep("^--file=", commandArgs(FALSE), value = TRUE))
BASE <- if (length(.here)) dirname(.here) else file.path(getwd(), "analysis", "football_intel_matchup")
source(file.path(BASE, "config.R"))
set.seed(MI$SEED)
dist_m <- fromJSON(file.path(MI$SERVE_DIR, "matchup_distribution_model.json"), simplifyVector = FALSE)

sdN <- function(x) as.numeric(unlist(x))
sd_fn_of <- function(sp) switch(as.character(sp$kind),
  const = { s<-sdN(sp$s); function(px) rep(s,length(px)) },
  cv = { c0<-sdN(sp$cv); function(px) pmax(2, abs(px)*c0) },
  bucket = { br<-sdN(sp$breaks); sv<-sdN(sp$sd); function(px){i<-as.integer(cut(px,br));i[is.na(i)]<-1L;v<-sv[i];v[!is.finite(v)]<-median(sv,na.rm=TRUE);as.numeric(v)} },
  linear = { a<-sdN(sp$a);b<-sdN(sp$b); function(px) pmax(2,a+b*px) },
  sqrt = { a<-sdN(sp$a);b<-sdN(sp$b); function(px) pmax(2,a+b*sqrt(pmax(px,0))) })
samp_pos <- function(pos, proj, n) {
  pm <- dist_m$positions[[pos]]; if (is.null(pm)) return(pmax(0, rnorm(n, proj, max(2, proj*0.45))))
  bias <- as.numeric(pm$mean_bias_correction %||% 0); mu <- proj + bias
  s <- sd_fn_of(pm$sd_params)(rep(mu, n))
  zg <- if (!is.null(pm$z_grid)) sdN(pm$z_grid) else NULL
  if (is.null(zg) || pm$marginal == "normal_clamp") return(pmax(0, rnorm(n, mu, s)))
  z <- approx(seq(0,1,length.out=length(zg)), zg, xout=runif(n), rule=2)$y
  pmax(0, mu + s*z)
}
`%||%` <- function(a,b) if (is.null(a)) b else a

# ---- REAL: devoted league chain -----------------------------------------
message("fetching devoted-to-the-game league chain ...")
lg <- function(id) tryCatch(fromJSON(sprintf("https://api.sleeper.app/v1/league/%s", id)), error=function(e) NULL)
chain <- list(); id <- "1389735763649761280"
for (i in 1:6) { L <- lg(id); if (is.null(L)) break; chain[[length(chain)+1]] <- L
  id <- L$previous_league_id; if (is.null(id) || is.na(id)) break }
message("  chain length: ", length(chain), " seasons: ", paste(sapply(chain, function(x) x$season), collapse=","))

real_rows <- list()
for (L in chain) {
  season <- as.integer(L$season)
  if (season >= 2026) next   # 2026 not played
  users <- tryCatch(fromJSON(sprintf("https://api.sleeper.app/v1/league/%s/rosters", L$league_id)), error=function(e) NULL)
  for (w in 1:17) {
    mus <- tryCatch(fromJSON(sprintf("https://api.sleeper.app/v1/league/%s/matchups/%d", L$league_id, w), simplifyVector=FALSE), error=function(e) NULL)
    if (is.null(mus) || !length(mus)) next
    by_mid <- split(mus, sapply(mus, function(m) m$matchup_id %||% NA))
    for (grp in by_mid) {
      if (length(grp) != 2) next
      a <- grp[[1]]; b <- grp[[2]]
      pa <- as.numeric(a$points %||% 0); pb <- as.numeric(b$points %||% 0)
      if (pa <= 0 || pb <= 0) next
      # projected: use starters_points is realized; we lack pregame proj for these
      # -> use the realized starter points as the "mean" is NOT allowed (lookahead).
      # Instead: this real check only validates that WP from PROJECTED-difference
      # tracks outcomes. We do not have pregame projections for devoted historically,
      # so we record the REALIZED margin only as a MODEL-FREE sanity anchor.
      real_rows[[length(real_rows)+1]] <- data.frame(season=season, week=w,
        margin = pa - pb, a_win = as.integer(pa > pb))
    }
  }
}
RR <- bind_rows(real_rows)
if (nrow(RR) > 20) {
  # model-free: does a logistic on realized margin calibrate? (this is a lower
  # bound sanity check, NOT a pregame evaluation — labelled as such)
  write.csv(RR, file.path(MI$OUT_DIR, "real_matchups_devoted.csv"), row.names = FALSE)
  message(sprintf("\nREAL_HISTORICAL_MATCHUPS (devoted chain): %d matchups, seasons %s",
                  nrow(RR), paste(sort(unique(RR$season)), collapse=",")))
  message("  NOTE: pregame projections are not retrievable for this historical chain ->")
  message("  this is a MODEL-FREE outcome-distribution anchor only, NOT a pregame WP eval (spec §14).")
  message(sprintf("  realized margin sd = %.1f  |  P(margin within +-10) = %.2f  |  home/first-listed win rate = %.3f",
                  sd(RR$margin), mean(abs(RR$margin) <= 10), mean(RR$a_win)))
} else {
  message("\nREAL_HISTORICAL_MATCHUPS: insufficient (", nrow(RR), ") — synthetic is the sole calibration vehicle.")
}

# ---- CONVERGENCE audit (spec §15) -------------------------------------
message("\nconvergence audit ...")
mk_lineup <- function() data.frame(
  position = c("QB","RB","RB","WR","WR","WR","TE","FLEX","K","DEF"),
  proj = c(21, 14, 9, 15, 11, 8, 10, 9, 8, 7))
conv <- list()
for (N in MI$SIM_N_GRID) {
  ps <- replicate(12, {
    A <- mk_lineup(); B <- mk_lineup(); B$proj <- B$proj * 0.97
    t0 <- Sys.time()
    ta <- rowSums(sapply(seq_len(nrow(A)), function(i) samp_pos(ifelse(A$position[i]=="FLEX","RB",A$position[i]), A$proj[i], N)))
    tb <- rowSums(sapply(seq_len(nrow(B)), function(i) samp_pos(ifelse(B$position[i]=="FLEX","RB",B$position[i]), B$proj[i], N)))
    list(wp = mean(ta > tb), ms = as.numeric(Sys.time()-t0)*1000)
  }, simplify = FALSE)
  wps <- sapply(ps, function(x) x$wp); mss <- sapply(ps, function(x) x$ms)
  conv[[length(conv)+1]] <- data.frame(N = N, wp_sd_across_seeds = sd(wps),
    theoretical_se = sqrt(0.25/N), ms_per_matchup = median(mss), ms_12_managers = sum(mss))
}
CV <- bind_rows(conv)
write.csv(CV, file.path(MI$OUT_DIR, "convergence.csv"), row.names = FALSE)
cat("\n=== simulation convergence ===\n"); print(as.data.frame(CV), row.names = FALSE, digits = 4)
best <- CV %>% filter(wp_sd_across_seeds <= 0.007) %>% slice_min(N, n = 1)
cat(sprintf("\nrecommended SIM_N = %d  (WP sd across seeds %.4f, %.0f ms for 12 managers)\n",
            best$N, best$wp_sd_across_seeds, best$ms_12_managers))
