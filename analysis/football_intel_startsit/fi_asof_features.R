# ===========================================================================
# Phase 4 — FI features AS OF the decision point for every (season, week) in
# the grid. Chronology-safe by construction: everything is computed from
# Phase 3 primitives restricted to weeks STRICTLY BEFORE the decision week,
# with per-source lag honored (participation-derived usage lags pbp, so its
# cutoff is `week - 1 - PART_LAG`).
#
# Produces:
#   team_asof   : season, week, team, side, family, modeled, league_percentile,
#                 confidence, predictive_status, prior_dominated
#   usage_asof  : season, week, gsis_id, family, modeled, confidence
#   interact_asof: season, week, off_team, def_team, family, interaction_signal, confidence
# ===========================================================================

suppressWarnings(suppressMessages({ library(dplyr); library(tidyr) }))

# PART_LAG: participation/scheme sources publish ~1-2 wk behind pbp (Phase 3
# P3-A4). Route participation is participation-derived -> lag it.
PART_LAG <- 2L

fi_asof_bundle <- function(FI, SS, tgf, pgu, prior_ratings_by_season, discounts_by_season) {
  grid <- expand.grid(season = SS$SEASONS, week = SS$MIN_WEEK:(SS$MAX_WEEK + 1L))
  team_rows <- list(); usage_rows <- list(); interact_rows <- list()

  fam_specs <- Filter(function(s) s$key %in% unique(SS$FI_FAMILIES$family[SS$FI_FAMILIES$kind %in% c("team_off","opp_def")]),
                      METRIC_SPECS)

  for (i in seq_len(nrow(grid))) {
    S <- grid$season[i]; W <- grid$week[i]
    thr <- W - 1L                       # only completed weeks before the decision
    if (thr < 2L) next
    pr <- prior_ratings_by_season[[as.character(S)]]
    dc <- discounts_by_season[[as.character(S)]]
    if (is.null(pr) || is.null(dc)) next

    for (sp in fam_specs) {
      prof <- tryCatch(compute_metric_profile(tgf, sp, S, thr, pr %>% filter(metric == sp$key), dc, FI),
                       error = function(e) NULL)
      if (is.null(prof) || nrow(prof) == 0) next
      team_rows[[length(team_rows) + 1]] <- prof %>%
        transmute(season = S, week = W, team, side,
                  family = sp$key, modeled, league_percentile, confidence,
                  predictive_status = FI$predictive_status(sp$key),
                  prior_dominated = coalesce(prior_weight, 0) > coalesce(recent_weight, 0))
    }

    # lean player usage as-of: EW mean of prior weeks, participation-lagged for routes
    u <- pgu %>% filter(season == S)
    if (nrow(u) > 0) {
      pbp_cut <- thr
      part_cut <- thr - PART_LAG
      ew <- function(x, wk, cut, hl) {
        ok <- is.finite(x) & wk <= cut
        if (!any(ok)) return(NA_real_)
        wts <- 0.5^((cut - wk[ok]) / hl)
        sum(wts * x[ok]) / sum(wts)
      }
      us <- u %>% group_by(gsis_id) %>% summarise(
        usage_snap_share     = ew(snap_share,          week, pbp_cut,  SS$TRAILING_HALFLIFE),
        usage_target_share   = ew(target_share,        week, pbp_cut,  SS$TRAILING_HALFLIFE),
        usage_rush_share     = ew(rush_share,          week, pbp_cut,  SS$TRAILING_HALFLIFE),
        usage_route_participation = ew(route_participation, week, part_cut, SS$TRAILING_HALFLIFE),
        n_wk = sum(week <= pbp_cut), .groups = "drop") %>%
        mutate(season = S, week = W,
               confidence = ifelse(n_wk >= 4, "HIGH", ifelse(n_wk >= 2, "MEDIUM",
                             ifelse(n_wk >= 1, "LOW", "INSUFFICIENT_SAMPLE"))))
      usage_rows[[length(usage_rows) + 1]] <- us %>%
        pivot_longer(starts_with("usage_"), names_to = "family", values_to = "modeled") %>%
        transmute(season, week, gsis_id, family, modeled, confidence)
    }
  }

  team_asof <- bind_rows(team_rows)
  # interaction signals from the team percentiles (percentile-diff, [-1,1]) —
  # mirrors Phase 3 build_contextual_matchups orientation, off vs def.
  mk_interaction <- function(off_key, def_key, name) {
    o <- team_asof %>% filter(family == off_key, side == "offense") %>%
      transmute(season, week, off_team = team, off_pct = league_percentile, off_conf = confidence)
    d <- team_asof %>% filter(family == def_key, side == "defense") %>%
      transmute(season, week, def_team = team, def_pct = league_percentile, def_conf = confidence)
    inner_join(o, d, by = c("season", "week"), relationship = "many-to-many") %>%
      filter(off_team != def_team) %>%
      transmute(season, week, off_team, def_team, family = name,
                interaction_signal = round(off_pct - (1 - def_pct), 4),
                confidence = c("INSUFFICIENT_SAMPLE","LOW","MEDIUM","HIGH")[pmin(
                  match(off_conf, c("INSUFFICIENT_SAMPLE","LOW","MEDIUM","HIGH")),
                  match(def_conf, c("INSUFFICIENT_SAMPLE","LOW","MEDIUM","HIGH")))])
  }
  interact_asof <- bind_rows(
    mk_interaction("off_pass_epa", "def_success_allowed", "interaction_pass_epa_vs_pass_defense"),
    mk_interaction("off_rush_epa", "def_success_allowed", "interaction_rush_epa_vs_rush_defense")
  )

  list(team_asof = team_asof, usage_asof = bind_rows(usage_rows), interact_asof = interact_asof)
}
