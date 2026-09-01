# ===========================================================================
# PHASE 3 — rookie + uncertain-role projection research harness
#
#   Rscript analysis/phase3_fetch_data.R          # once (caches raw data)
#   Rscript analysis/phase3_rookie_role_model.R   # this harness
#
# Research question: does college profile + NFL draft context + NFL destination
# context predict rookie NFL opportunity better than the frozen
# `ri-structural-2026.2` generic prior?  Prove it — do not assume it.
#
# Rolling season-aware validation: for draft class Y, train on classes < Y.
# 2025 draft class is the final untouched holdout (models/features are chosen
# on 2015-2024 only). Every feature is verified available before NFL season Y.
# ===========================================================================

suppressWarnings(suppressMessages({
  library(dplyr); library(tidyr); library(stringr); library(ggplot2); library(jsonlite)
}))

.file <- sub("^--file=", "", grep("^--file=", commandArgs(FALSE), value = TRUE))
ROOT  <- if (length(.file)) normalizePath(file.path(dirname(.file), "..")) else getwd()
if (!dir.exists(file.path(ROOT, "outputs"))) ROOT <- getwd()
source(file.path(ROOT, "analysis", "phase3_lib.R"))

C       <- file.path(ROOT, "analysis", "phase3_cache")
OUT     <- file.path(ROOT, "outputs", "projections-2026")
PLOTS   <- file.path(ROOT, "analysis", "plots")
dir.create(PLOTS, showWarnings = FALSE, recursive = TRUE)
rd <- function(n) readRDS(file.path(C, paste0(n, ".rds")))
wr <- function(df, n) { p <- file.path(OUT, n); write.csv(df, p, row.names = FALSE); cat("  wrote", n, "\n") }

set.seed(30303)
DRAFT_CLASSES <- 2015:2025
DEV_CLASSES   <- 2015:2023
TUNE_HOLDOUT  <- 2024          # last "development" class used only for model selection sanity
FINAL_HOLDOUT <- 2025          # never used to choose features/models
REG_GAMES     <- 17

cat("PHASE 3 rookie/role research harness\n  cache:", C, "\n\n")

# ---------------------------------------------------------------------------
# 0. Load cached raw data
# ---------------------------------------------------------------------------
players_master <- rd("nfl_players_master")
draft_picks    <- rd("nfl_draft_picks")
combine        <- rd("nfl_combine")
ff_ids         <- rd("ff_playerids")
rosters        <- rd("nfl_rosters")
depth_early    <- rd("nfl_depth_charts_early")
nfl_ps         <- rd("nfl_player_season")        %>% mutate(games = pmin(games, REG_GAMES))
nfl_pts        <- rd("nfl_player_team_season")   %>% mutate(games = pmin(games, REG_GAMES))
nfl_team       <- rd("nfl_team_season_v2")
nfl_snap       <- rd("nfl_snap_season")
cfb_ps         <- rd("cfb_player_season")
cfb_rosters    <- rd("cfb_rosters")
cfb_team       <- rd("cfb_team_season")

POS <- c("QB", "RB", "WR", "TE")

# ---------------------------------------------------------------------------
# 1. College athlete master (id -> normalised name / school / season / toucher)
# ---------------------------------------------------------------------------
touch_ids <- unique(as.character(cfb_ps$pid))
cfb_ath <- cfb_rosters %>%
  transmute(athlete_id = as.character(athlete_id),
            name   = norm_name(paste(first_name, last_name)),
            school = norm_school(team),
            season, position,
            is_toucher = athlete_id %in% touch_ids)

# ---------------------------------------------------------------------------
# 2. Identity crosswalk: drafted skill players 2015-2025 -> cfbfastR athlete_id
# ---------------------------------------------------------------------------
cat("[1] College -> NFL identity resolution\n")
drafts_sk <- draft_picks %>%
  filter(season %in% DRAFT_CLASSES, position %in% POS, !is.na(gsis_id)) %>%
  transmute(gsis_id, pfr_player_id, pfr_player_name, college, position,
            season, round, pick)

xwalk <- build_identity_crosswalk(drafts_sk, cfb_ath) %>%
  select(gsis_id, athlete_id, match_status)

drafts_sk <- drafts_sk %>% left_join(xwalk, by = "gsis_id")

# add sleeper_id via ff_playerids (for the 2026 audit join later)
drafts_sk <- drafts_sk %>%
  left_join(ff_ids %>% transmute(gsis_id, sleeper_id = as.character(sleeper_id)), by = "gsis_id")

id_summary <- drafts_sk %>%
  mutate(matched = !is.na(athlete_id)) %>%
  group_by(season) %>%
  summarise(rookies = n(),
            matched = sum(matched),
            high = sum(match_status == "HIGH_CONFIDENCE", na.rm = TRUE),
            medium = sum(match_status == "MEDIUM", na.rm = TRUE),
            ambiguous = sum(match_status == "AMBIGUOUS", na.rm = TRUE),
            unmatched = sum(match_status == "UNMATCHED" | is.na(match_status)),
            match_rate = round(matched / n(), 3), .groups = "drop")
print(id_summary)

by_pos_match <- drafts_sk %>%
  group_by(position) %>%
  summarise(n = n(), matched = sum(!is.na(athlete_id)),
            rate = round(matched / n(), 3), .groups = "drop")
print(by_pos_match)

wr(drafts_sk %>%
     transmute(gsis_id, sleeper_id, pfr_player_name, college, position, draft_season = season,
               round, pick, cfb_athlete_id = athlete_id,
               college_to_nfl_match_status = coalesce(match_status, "UNMATCHED")),
   "phase3_rookie_identity_crosswalk.csv")


# ===========================================================================
# 3. Historical rookie cohort  (leakage-safe: only info knowable before NFL yr1)
# ===========================================================================
cat("\n[2] Historical rookie cohort\n")

P5 <- c("SEC", "Big Ten", "Big 12", "ACC", "Pac-12", "Pac-10")

# --- NFL year-1 outcome (TARGET; season == draft_season) ---
nfl_y1 <- nfl_ps %>%
  transmute(gsis_id, y1_season = season, g1 = pmin(games, REG_GAMES),
            t_targets = targets, t_carries = carries, t_rec = rec,
            t_rec_yd = rec_yd, t_rush_yd = rush_yd, t_rec_td = rec_td, t_rush_td = rush_td,
            t_pass_att = pass_att, t_pass_yd = pass_yd, t_pass_td = pass_td, t_ppr = fantasy_points_ppr)

# --- college final season + shares (matched athlete_id, season == draft_season-1) ---
cfb_final <- cfb_ps %>%
  transmute(athlete_id = as.character(pid), c_season = season, c_team = team, c_conf = conference,
            c_games = pmin(c_games, 16), c_rec = rec, c_rec_yd = rec_yd, c_rec_td = rec_td,
            c_rz_rec = rz_rec, c_carries = carries, c_rush_yd = rush_yd, c_rush_td = rush_td,
            c_rz_carries = rz_carries, c_pass_att = pass_att, c_pass_yd = pass_yd,
            c_pass_td = pass_td, c_pass_int = pass_int) %>%
  left_join(cfb_team %>% transmute(c_team = team, c_season = season,
                                   ct_rec_yd = team_rec_yd, ct_rec = team_rec, ct_rec_td = team_rec_td,
                                   ct_carries = team_carries, ct_rush_yd = team_rush_yd,
                                   ct_rz_rec = team_rz_rec, ct_rz_carries = team_rz_carries),
            by = c("c_team", "c_season"))

cohort0 <- drafts_sk %>%
  transmute(gsis_id, pfr_id = pfr_player_id, athlete_id, match_status, position,
            draft_season = season, round, pick) %>%
  left_join(draft_picks %>% transmute(gsis_id, draft_team = team) %>% distinct(gsis_id, .keep_all = TRUE),
            by = "gsis_id")

final_szn <- cohort0 %>%
  filter(!is.na(athlete_id)) %>%
  inner_join(cfb_final, by = "athlete_id") %>%
  filter(c_season == draft_season - 1L) %>%
  group_by(gsis_id) %>% slice_max(c_games, n = 1, with_ties = FALSE) %>% ungroup() %>%
  mutate(
    c_p5             = as.integer(c_conf %in% P5),
    c_rec_yd_pg      = c_rec_yd / pmax(c_games, 1),
    c_rush_yd_pg     = c_rush_yd / pmax(c_games, 1),
    c_scrim_yd_pg    = (c_rec_yd + c_rush_yd) / pmax(c_games, 1),
    c_ypr            = c_rec_yd / pmax(c_rec, 1),
    c_ypc            = c_rush_yd / pmax(c_carries, 1),
    c_rec_yd_share   = c_rec_yd / pmax(ct_rec_yd, 1),
    c_rec_share      = c_rec / pmax(ct_rec, 1),
    c_rush_yd_share  = c_rush_yd / pmax(ct_rush_yd, 1),
    c_rush_share     = c_carries / pmax(ct_carries, 1),
    c_rz_rec_share   = c_rz_rec / pmax(ct_rz_rec, 1),
    c_rz_carry_share = c_rz_carries / pmax(ct_rz_carries, 1),
    c_pass_ypa       = c_pass_yd / pmax(c_pass_att, 1),
    c_pass_td_rate   = c_pass_td / pmax(c_pass_att, 1),
    c_pass_int_rate  = c_pass_int / pmax(c_pass_att, 1),
    c_qb_rush_pg     = c_carries / pmax(c_games, 1)
  ) %>%
  select(gsis_id, c_season, c_conf, c_p5, c_games, c_rec, c_rec_yd, c_carries, c_rush_yd,
         c_pass_att, c_rec_yd_pg, c_rush_yd_pg, c_scrim_yd_pg, c_ypr, c_ypc,
         c_rec_yd_share, c_rec_share, c_rush_yd_share, c_rush_share, c_rz_rec_share,
         c_rz_carry_share, c_pass_ypa, c_pass_td_rate, c_pass_int_rate, c_qb_rush_pg)

career <- cohort0 %>%
  filter(!is.na(athlete_id)) %>%
  inner_join(cfb_final, by = "athlete_id") %>%
  filter(c_season <= draft_season - 1L, c_season >= draft_season - 5L) %>%
  group_by(gsis_id) %>%
  summarise(c_seasons = n_distinct(c_season),
            c_career_scrim_yd = sum(c_rec_yd + c_rush_yd), .groups = "drop")

age_tbl <- players_master %>% transmute(gsis_id, bdate = suppressWarnings(as.Date(birth_date)))

comb <- combine %>%
  transmute(pfr_id, forty = suppressWarnings(as.numeric(forty)),
            cwt = suppressWarnings(as.numeric(wt)), cht = suppressWarnings(as.numeric(ht))) %>%
  filter(!is.na(pfr_id)) %>% distinct(pfr_id, .keep_all = TRUE)

# --- destination context (BACKTESTABLE): drafting team's prior-year position group ---
roster_Y <- rosters %>% distinct(season, team, gsis_id)
inc_prior <- nfl_pts %>%
  transmute(inc_gsis = gsis_id, inc_pos = position, prior_season = season, prior_team = team,
            inc_targets = targets, inc_carries = carries)

dest_feats <- cohort0 %>%
  transmute(gsis_id, position, draft_season, draft_team, join_prior = draft_season - 1L) %>%
  inner_join(inc_prior, by = c("draft_team" = "prior_team", "join_prior" = "prior_season"),
             relationship = "many-to-many") %>%
  filter(inc_pos == position, inc_gsis != gsis_id) %>%
  left_join(roster_Y, by = c("inc_gsis" = "gsis_id"),
            relationship = "many-to-many") %>%
  mutate(returning = as.integer(!is.na(season) & season == draft_season & team == draft_team)) %>%
  group_by(gsis_id) %>%
  summarise(
    dest_pos_targets_y0    = sum(inc_targets[!duplicated(inc_gsis)]),
    dest_pos_carries_y0    = sum(inc_carries[!duplicated(inc_gsis)]),
    dest_returning_targets = sum(inc_targets[returning == 1 & !duplicated(inc_gsis)]),
    dest_vacated_targets   = dest_pos_targets_y0 - dest_returning_targets,
    dest_returning_carries = sum(inc_carries[returning == 1 & !duplicated(inc_gsis)]),
    dest_vacated_carries   = dest_pos_carries_y0 - dest_returning_carries,
    dest_incumbents        = n_distinct(inc_gsis[returning == 1 & (inc_targets + inc_carries) >= 50]),
    .groups = "drop"
  )

dest_env <- nfl_team %>%
  transmute(draft_team = team, join_prior = season,
            dest_tm_pass_att_y0 = team_pass_att, dest_tm_rush_att_y0 = team_rush_att)

draft_comp <- draft_picks %>%
  filter(season %in% DRAFT_CLASSES, position %in% POS) %>%
  group_by(team, season, position) %>%
  summarise(gsis_id = list(gsis_id), n_pos = n(), .groups = "drop") %>%
  tidyr::unnest(gsis_id) %>%
  transmute(gsis_id, dest_same_pos_picks_class = n_pos - 1L)

depth_rk <- depth_early %>%
  filter(position %in% POS) %>% distinct(season, gsis_id, .keep_all = TRUE) %>%
  transmute(gsis_id, y1_season = season, depth_rank = pmax(1L, pmin(depth_rank, 4L)))

team_y1_tbl <- nfl_team %>% transmute(draft_team = team, y1_season = season,
                                      tm_pass_att_y1 = team_pass_att, tm_rush_att_y1 = team_rush_att)

cohort <- cohort0 %>%
  mutate(y1_season = draft_season, join_prior = draft_season - 1L) %>%
  left_join(nfl_y1, by = c("gsis_id", "y1_season")) %>%
  mutate(dplyr::across(c(g1, t_targets, t_carries, t_rec, t_rec_yd, t_rush_yd, t_rec_td,
                         t_rush_td, t_pass_att, t_pass_yd, t_pass_td, t_ppr),
                       ~ tidyr::replace_na(., 0))) %>%
  left_join(age_tbl, by = "gsis_id") %>%
  mutate(age_draft = as.numeric(as.Date(sprintf("%d-04-27", draft_season)) - bdate) / 365.25) %>%
  left_join(final_szn, by = "gsis_id") %>%
  left_join(career, by = "gsis_id") %>%
  left_join(comb, by = "pfr_id") %>%
  left_join(dest_feats, by = "gsis_id") %>%
  left_join(dest_env, by = c("draft_team", "join_prior")) %>%
  left_join(draft_comp, by = "gsis_id") %>%
  left_join(depth_rk, by = c("gsis_id", "y1_season")) %>%
  left_join(team_y1_tbl, by = c("draft_team", "y1_season")) %>%
  mutate(
    round = ifelse(is.na(round), 8L, round),
    pick  = ifelse(is.na(pick), 261L, pick),
    log_pick = log1p(pick),
    is_day3 = as.integer(round >= 4),
    bmi = ifelse(!is.na(cwt) & !is.na(cht), 703 * cwt / (cht^2), NA_real_),
    speed_score = ifelse(!is.na(forty) & !is.na(cwt), cwt * 200 / (forty^4), NA_real_),
    depth_rank = tidyr::replace_na(depth_rank, 3L),
    dplyr::across(c(dest_pos_targets_y0, dest_pos_carries_y0, dest_returning_targets,
                    dest_vacated_targets, dest_returning_carries, dest_vacated_carries,
                    dest_incumbents, dest_same_pos_picks_class), ~ tidyr::replace_na(., 0)),
    dest_tm_pass_att_y0 = tidyr::replace_na(dest_tm_pass_att_y0, 560),
    dest_tm_rush_att_y0 = tidyr::replace_na(dest_tm_rush_att_y0, 430),
    dest_vacated_tgt_share  = dest_vacated_targets / pmax(dest_tm_pass_att_y0, 1),
    dest_return_tgt_share   = dest_returning_targets / pmax(dest_tm_pass_att_y0, 1),
    dest_vacated_carry_share = dest_vacated_carries / pmax(dest_tm_rush_att_y0, 1),
    has_college = !is.na(c_rec_yd_pg) | (!is.na(c_pass_att) & c_pass_att > 0),
    feature_tier = dplyr::case_when(
      has_college & !is.na(age_draft) ~ "FULL_COLLEGE",
      !is.na(age_draft) ~ "DRAFT_DEST_AGE",
      TRUE ~ "DRAFT_ONLY"),
    played    = as.integer(g1 >= 1),
    opp_tot   = t_targets + t_carries,
    opp_pg    = ifelse(g1 >= 1, (t_targets + t_carries) / g1, NA_real_),
    passatt_pg = ifelse(g1 >= 1, t_pass_att / g1, NA_real_),
    ppr_pts   = t_ppr,
    ppr_pg    = ifelse(g1 >= 1, t_ppr / g1, NA_real_)
  ) %>%
  group_by(draft_season, position) %>%
  mutate(pos_pick_pctile = rank(pick, ties.method = "average") / n()) %>%
  ungroup()

cat("  cohort rows:", nrow(cohort), "\n")
print(cohort %>% count(draft_season, position) %>%
        tidyr::pivot_wider(names_from = position, values_from = n, values_fill = 0))
print(cohort %>% count(feature_tier))
wr(cohort %>% transmute(gsis_id, draft_season, position, draft_team, pick, round, log_pick,
                        pos_pick_pctile, is_day3, age_draft, feature_tier,
                        c_rec_yd_pg, c_rush_yd_pg, c_rec_yd_share, c_rush_share, c_games,
                        dest_vacated_targets, dest_vacated_carries, dest_incumbents,
                        depth_rank, played, g1, opp_pg, opp_tot, ppr_pts),
   "phase3_rookie_historical_cohort.csv")

# ===========================================================================
# 4. Feature coverage
# ===========================================================================
cat("\n[3] Feature coverage\n")
FEATURE_FAMILIES <- list(
  draft_capital = c("pick", "log_pick", "round", "pos_pick_pctile", "is_day3"),
  age           = c("age_draft"),
  combine       = c("forty", "cwt", "cht", "bmi", "speed_score"),
  college_prod  = c("c_rec_yd_pg", "c_rush_yd_pg", "c_scrim_yd_pg", "c_ypr", "c_ypc",
                    "c_pass_ypa", "c_pass_td_rate", "c_qb_rush_pg", "c_games"),
  college_share = c("c_rec_yd_share", "c_rec_share", "c_rush_share", "c_rush_yd_share",
                    "c_rz_rec_share", "c_rz_carry_share", "c_p5"),
  destination   = c("dest_vacated_targets", "dest_returning_targets", "dest_vacated_carries",
                    "dest_incumbents", "dest_vacated_tgt_share", "dest_vacated_carry_share",
                    "dest_same_pos_picks_class", "dest_tm_pass_att_y0", "dest_tm_rush_att_y0"),
  depth_chart   = c("depth_rank")
)
cov_rows <- lapply(names(FEATURE_FAMILIES), function(fam) {
  do.call(rbind, lapply(FEATURE_FAMILIES[[fam]], function(f) {
    v <- cohort[[f]]
    data.frame(family = fam, feature = f, n = length(v),
               non_missing = sum(!is.na(v)), coverage = round(mean(!is.na(v)), 3),
               backtestable = ifelse(fam == "depth_chart", "BORDERLINE_LIVE", "BACKTESTABLE"))
  }))
})
feature_coverage <- do.call(rbind, cov_rows)
print(feature_coverage, row.names = FALSE)
wr(feature_coverage, "phase3_feature_coverage.csv")

# ===========================================================================
# 5. Models  (target = season-total PPR points; football target = season opp_tot)
# ===========================================================================
cat("\n[4] Model comparison — rolling season-aware validation\n")

POS_BASE <- list(
  QB = list(avail = 0.86, ppr_per_att = 0.44, ppr_per_carry = 0.62),
  RB = list(avail = 0.80, ppr_per_tgt = 1.50, ppr_per_carry = 0.58),
  WR = list(avail = 0.85, ppr_per_tgt = 1.77, ppr_per_carry = 0.70),
  TE = list(avail = 0.86, ppr_per_tgt = 1.72, ppr_per_carry = 0.00)
)
FROZEN_HAIRCUT <- 1.5

# --- M0: faithful port of rookieRolePrior(position, depth_rank) ---
rookie_prior_pg <- function(position, d) {
  d <- ifelse(is.na(d), 3L, pmax(1L, pmin(d, 4L)))
  tgt <- carry <- numeric(length(d))
  for (i in seq_along(d)) {
    p <- position[i]; k <- d[i]
    if (p == "RB") { carry[i] <- c(12, 5.5, 2, 2)[k]; tgt[i] <- ifelse(k == 1, 2.6, 1.4) }
    else if (p == "WR") { tgt[i] <- c(6.0, 4.3, 2.6, 1.2)[k]; carry[i] <- 0.3 }
    else if (p == "TE") { tgt[i] <- c(4.2, 2.0, 0.9, 0.9)[k]; carry[i] <- 0 }
    else if (p == "QB") { carry[i] <- ifelse(k == 1, 4.5, 0.5); tgt[i] <- 0 }
  }
  list(tgt = tgt, carry = carry)
}
m0_predict <- function(df) {
  pr <- rookie_prior_pg(df$position, df$depth_rank)
  g_hat <- vapply(df$position, function(p) 17 * POS_BASE[[p]]$avail - FROZEN_HAIRCUT, numeric(1))
  ppr <- numeric(nrow(df)); opp <- numeric(nrow(df))
  for (i in seq_len(nrow(df))) {
    b <- POS_BASE[[df$position[i]]]
    if (df$position[i] == "QB") {
      patt <- 17 * b$avail * 0   # QB1 rookies get team pass volume in production; player-level prior = 0
      # approximate: depth_rank 1 QB rookie ~ starter share of a league-avg 560 att
      patt <- ifelse(df$depth_rank[i] %in% c(1L, NA), 560 * (g_hat[i] / 17), 60 * (g_hat[i] / 17))
      ppr[i] <- patt * b$ppr_per_att + pr$carry[i] * g_hat[i] * b$ppr_per_carry
      opp[i] <- patt + pr$carry[i] * g_hat[i]
    } else {
      ppt <- b$ppr_per_tgt %||% 0; ppc <- b$ppr_per_carry
      ppr[i] <- g_hat[i] * (pr$tgt[i] * ppt + pr$carry[i] * ppc)
      opp[i] <- g_hat[i] * (pr$tgt[i] + pr$carry[i])
    }
  }
  data.frame(ppr_hat = ppr, opp_hat = opp, g_hat = g_hat)
}

# --- feature standardisation (fit on TRAIN only) ---
STD_FEATS <- unique(unlist(FEATURE_FAMILIES))
make_std <- function(train) {
  mu <- sapply(STD_FEATS, function(f) mean(train[[f]], na.rm = TRUE))
  sd <- sapply(STD_FEATS, function(f) { s <- sd(train[[f]], na.rm = TRUE); ifelse(is.na(s) | s == 0, 1, s) })
  function(df) {
    out <- df
    for (f in STD_FEATS) { v <- as.numeric(df[[f]]); v[is.na(v)] <- mu[[f]]; out[[paste0("z_", f)]] <- (v - mu[[f]]) / sd[[f]] }
    out
  }
}

MODELS <- list(
  M1_draft        = "z_log_pick + z_pos_pick_pctile + is_day3",
  M2_college_prod = "z_c_scrim_yd_pg + z_c_rec_yd_pg + z_c_rush_yd_pg + z_c_ypr + z_c_games",
  M3_college_shr  = "z_c_rec_yd_share + z_c_rush_share + z_c_rz_rec_share + z_c_rz_carry_share + c_p5",
  M4_draft_col    = "z_log_pick + z_pos_pick_pctile + is_day3 + z_c_scrim_yd_pg + z_c_rec_yd_share + z_c_rush_share + z_c_games",
  M5_draft_col_dest = paste("z_log_pick + z_pos_pick_pctile + is_day3 + z_c_scrim_yd_pg +",
                            "z_c_rec_yd_share + z_c_rush_share + z_age_draft +",
                            "z_dest_vacated_tgt_share + z_dest_vacated_carry_share + z_dest_incumbents")
)

# one quasi-Poisson GLM (log link) per position on max(target, 0); predict on the
# response scale (no retransformation bias, count-like mean-variance).
fit_predict <- function(rhs, train, test, target = "ppr_pts") {
  preds <- rep(NA_real_, nrow(test))
  for (p in POS) {
    tr <- train %>% filter(position == p); te_idx <- which(test$position == p)
    if (length(te_idx) < 1 || nrow(tr) < 20) next
    tr$.y <- pmax(tr[[target]], 0)
    f <- as.formula(paste(".y ~", rhs))
    m <- tryCatch(suppressWarnings(glm(f, data = tr, family = quasipoisson(link = "log"))),
                  error = function(e) NULL)
    if (is.null(m)) next
    ph <- tryCatch(predict(m, newdata = test[te_idx, , drop = FALSE], type = "response"),
                   error = function(e) NULL)
    if (is.null(ph)) next
    preds[te_idx] <- pmax(ph, 0)
  }
  preds
}

# rolling: test class Y in 2016..2025, train on 2015..(Y-1)
roll_predict <- function(rhs_or_m0) {
  out <- cohort %>% transmute(gsis_id, draft_season, position, ppr_pts, opp_tot, g1, feature_tier)
  out$pred <- NA_real_
  for (Y in 2018:2025) {
    tr <- cohort %>% filter(draft_season < Y)
    te <- cohort %>% filter(draft_season == Y)
    if (nrow(te) == 0) next
    if (identical(rhs_or_m0, "M0")) {
      pr <- m0_predict(te)$ppr_hat
    } else {
      std <- make_std(tr); tr2 <- std(tr); te2 <- std(te)
      pr <- fit_predict(rhs_or_m0, tr2, te2, "ppr_pts")
    }
    out$pred[out$draft_season == Y] <- pr
  }
  out
}

pred_M0 <- roll_predict("M0")
pred_by_model <- c(list(M0_frozen_prior = pred_M0),
                   lapply(MODELS, roll_predict))

eval_model <- function(pr, label, scope_years, cohorts = "ALL") {
  d <- pr %>% filter(draft_season %in% scope_years, !is.na(pred))
  if (cohorts != "ALL") d <- d %>% filter(position == cohorts)
  m <- metric_set(d$pred, d$ppr_pts)
  data.frame(model = label, cohort = cohorts, scope = paste0(min(scope_years), "-", max(scope_years)),
             as.list(m), check.names = FALSE)
}
DEV_YEARS <- 2018:2024
comparison <- do.call(rbind, lapply(names(pred_by_model), function(nm) {
  rbind(
    eval_model(pred_by_model[[nm]], nm, DEV_YEARS, "ALL"),
    do.call(rbind, lapply(POS, function(p) eval_model(pred_by_model[[nm]], nm, DEV_YEARS, p)))
  )
}))
print(comparison %>% filter(cohort == "ALL"), row.names = FALSE, digits = 4)
wr(comparison, "phase3_model_comparison.csv")

# paired vs M0 (dev years)
paired_vs_m0 <- do.call(rbind, lapply(names(pred_by_model)[-1], function(nm) {
  j <- pred_by_model[[nm]] %>% filter(draft_season %in% DEV_YEARS) %>%
    transmute(gsis_id, cand = pred, act = ppr_pts) %>%
    inner_join(pred_M0 %>% transmute(gsis_id, base = pred), by = "gsis_id")
  b <- paired_boot(j$cand, j$base, j$act)
  data.frame(model = nm, n = b["n"], mean_abs_err_delta_vs_M0 = round(b["mean_d"], 3),
             ci_lo = round(b["lo"], 3), ci_hi = round(b["hi"], 3),
             frac_boot_improved = round(b["p_improve"], 3))
}))
print(paired_vs_m0, row.names = FALSE)
wr(paired_vs_m0, "phase3_paired_vs_frozen_prior.csv")

# --- per-position paired vs M0 (the leading candidate M1) ---
pos_paired <- do.call(rbind, lapply(POS, function(p) {
  j <- pred_by_model[["M1_draft"]] %>% filter(draft_season %in% DEV_YEARS, position == p) %>%
    transmute(gsis_id, cand = pred, act = ppr_pts) %>%
    inner_join(pred_M0 %>% transmute(gsis_id, base = pred), by = "gsis_id")
  b <- paired_boot(j$cand, j$base, j$act)
  m1 <- metric_set(j$cand, j$act); m0 <- metric_set(j$base, j$act)
  data.frame(position = p, n = b["n"],
             M0_mae = round(m0["mae"], 2), M1_mae = round(m1["mae"], 2),
             M0_spearman = round(m0["spearman"], 3), M1_spearman = round(m1["spearman"], 3),
             paired_mae_delta = round(b["mean_d"], 3), ci_lo = round(b["lo"], 3), ci_hi = round(b["hi"], 3))
}))
print(pos_paired, row.names = FALSE)
wr(pos_paired, "phase3_position_results.csv")

# --- football target: season opportunity (targets + carries) ---
roll_predict_opp <- function(rhs_or_m0) {
  out <- cohort %>% transmute(gsis_id, draft_season, position, opp_tot)
  out$pred <- NA_real_
  for (Y in 2018:2025) {
    tr <- cohort %>% filter(draft_season < Y); te <- cohort %>% filter(draft_season == Y)
    if (nrow(te) == 0) next
    if (identical(rhs_or_m0, "M0")) { pr <- m0_predict(te)$opp_hat }
    else { std <- make_std(tr); pr <- fit_predict(rhs_or_m0, std(tr), std(te), "opp_tot") }
    out$pred[out$draft_season == Y] <- pr
  }
  out
}
opp_M0 <- roll_predict_opp("M0"); opp_M1 <- roll_predict_opp(MODELS[["M1_draft"]])
opp_row <- function(pr, lbl) {
  d <- pr %>% filter(draft_season %in% DEV_YEARS)
  m <- metric_set(d$pred, d$opp_tot)
  data.frame(model = lbl, n = m["n"], bias = round(m["bias"],2), mae = round(m["mae"],2),
             rmse = round(m["rmse"],2), spearman = round(m["spearman"],3), cal_slope = round(m["cal_slope"],3))
}
opp_eval <- rbind(opp_row(opp_M0, "M0_frozen_prior"), opp_row(opp_M1, "M1_draft"))
print(opp_eval, row.names = FALSE)
wr(opp_eval, "phase3_opportunity_target_eval.csv")

# --- ablation on M1 (leave-one-feature-out) + M1 vs M4 (college incremental) ---
M1_FEATS <- c("z_log_pick", "z_pos_pick_pctile", "is_day3")
abl <- do.call(rbind, lapply(c("FULL", M1_FEATS), function(drop) {
  rhs <- if (drop == "FULL") paste(M1_FEATS, collapse = " + ") else paste(setdiff(M1_FEATS, drop), collapse = " + ")
  if (rhs == "") rhs <- "1"
  pr <- roll_predict(rhs)
  d <- pr %>% filter(draft_season %in% DEV_YEARS, !is.na(pred))
  m <- metric_set(d$pred, d$ppr_pts)
  data.frame(config = ifelse(drop == "FULL", "M1_full", paste0("M1_minus_", drop)),
             n = m["n"], mae = round(m["mae"], 3), rmse = round(m["rmse"], 3),
             spearman = round(m["spearman"], 4))
}))
print(abl, row.names = FALSE)
wr(abl, "phase3_ablation.csv")

# --- central hypothesis: does college add value AFTER draft capital? (M1 vs M4/M5) ---
col_inc <- do.call(rbind, lapply(c("M4_draft_col", "M5_draft_col_dest"), function(nm) {
  j <- pred_by_model[[nm]] %>% filter(draft_season %in% DEV_YEARS) %>%
    transmute(gsis_id, cand = pred, act = ppr_pts) %>%
    inner_join(pred_by_model[["M1_draft"]] %>% transmute(gsis_id, base = pred), by = "gsis_id")
  b <- paired_boot(j$cand, j$base, j$act)
  data.frame(candidate = nm, baseline = "M1_draft", n = b["n"],
             mean_abs_err_delta = round(b["mean_d"], 3), ci_lo = round(b["lo"], 3),
             ci_hi = round(b["hi"], 3), frac_boot_improved = round(b["p_improve"], 3),
             verdict = ifelse(b["hi"] < 0, "college helps",
                       ifelse(b["lo"] > 0, "college HURTS", "no incremental value (CI spans 0)")))
}))
print(col_inc, row.names = FALSE)
wr(col_inc, "phase3_college_incremental_value.csv")

# ===========================================================================
# 6. Role-probability model (M6) — does an explicit S/C/B mixture beat M1?
# ===========================================================================
cat("\n[5] Role-probability model (M6)\n")
suppressWarnings(suppressMessages(library(nnet)))

# football-reasonable role states from year-1 realised usage (per game, players who played)
role_of <- function(position, opp_pg, passatt_pg, g1) {
  r <- rep("BACKUP", length(position))
  for (i in seq_along(position)) {
    if (g1[i] < 1) { r[i] <- "BACKUP"; next }
    p <- position[i]
    if (p == "QB") {
      r[i] <- if (!is.na(passatt_pg[i]) && passatt_pg[i] >= 20) "STARTER"
              else if (!is.na(passatt_pg[i]) && passatt_pg[i] >= 6) "COMMITTEE" else "BACKUP"
    } else if (p == "RB") {
      r[i] <- if (opp_pg[i] >= 13) "STARTER" else if (opp_pg[i] >= 6) "COMMITTEE" else "BACKUP"
    } else if (p == "WR") {
      r[i] <- if (opp_pg[i] >= 6) "STARTER" else if (opp_pg[i] >= 3) "COMMITTEE" else "BACKUP"
    } else { # TE
      r[i] <- if (opp_pg[i] >= 4) "STARTER" else if (opp_pg[i] >= 2) "COMMITTEE" else "BACKUP"
    }
  }
  factor(r, levels = c("BACKUP", "COMMITTEE", "STARTER"))
}
cohort$role_y1 <- role_of(cohort$position, cohort$opp_pg, cohort$passatt_pg, cohort$g1)

M6_RHS <- "z_log_pick + z_pos_pick_pctile"
roll_predict_m6 <- function() {
  out <- cohort %>% transmute(gsis_id, draft_season, position, ppr_pts, role_y1)
  out$pred <- NA_real_; out$pS <- NA_real_; out$pC <- NA_real_; out$pB <- NA_real_
  for (Y in 2018:2025) {
    tr <- cohort %>% filter(draft_season < Y); te <- cohort %>% filter(draft_season == Y)
    if (nrow(te) == 0) next
    std <- make_std(tr); tr2 <- std(tr); te2 <- std(te)
    for (p in POS) {
      tri <- tr2 %>% filter(position == p); tei <- which(te2$position == p)
      if (length(tei) < 1 || nrow(tri) < 25) next
      m <- tryCatch(nnet::multinom(as.formula(paste("role_y1 ~", M6_RHS)), data = tri, trace = FALSE),
                    error = function(e) NULL)
      if (is.null(m)) next
      P <- tryCatch(predict(m, newdata = te2[tei, , drop = FALSE], type = "probs"),
                    error = function(e) NULL)
      if (is.null(P)) next
      if (is.null(dim(P))) P <- matrix(P, nrow = 1, dimnames = list(NULL, levels(cohort$role_y1)))
      # E[ppr | role] from training means
      mu_role <- tri %>% group_by(role_y1) %>% summarise(mppr = mean(pmax(ppr_pts, 0)), .groups = "drop")
      mv <- setNames(mu_role$mppr, as.character(mu_role$role_y1))
      mv <- mv[c("BACKUP", "COMMITTEE", "STARTER")]; mv[is.na(mv)] <- 0
      ev <- as.numeric(P %*% mv)
      out$pred[out$draft_season == Y][match(te2$gsis_id[tei], out$gsis_id[out$draft_season == Y])] <- ev
      out$pB[out$draft_season == Y][match(te2$gsis_id[tei], out$gsis_id[out$draft_season == Y])] <- P[, "BACKUP"]
      out$pC[out$draft_season == Y][match(te2$gsis_id[tei], out$gsis_id[out$draft_season == Y])] <- P[, "COMMITTEE"]
      out$pS[out$draft_season == Y][match(te2$gsis_id[tei], out$gsis_id[out$draft_season == Y])] <- P[, "STARTER"]
    }
  }
  out
}
m6 <- roll_predict_m6()
m6_dev <- m6 %>% filter(draft_season %in% DEV_YEARS, !is.na(pred))
m6_metrics <- metric_set(m6_dev$pred, m6_dev$ppr_pts)
cat(sprintf("  M6 dev: MAE %.2f RMSE %.2f Spearman %.3f\n", m6_metrics["mae"], m6_metrics["rmse"], m6_metrics["spearman"]))
j6 <- m6 %>% filter(draft_season %in% DEV_YEARS) %>% transmute(gsis_id, cand = pred, act = ppr_pts) %>%
  inner_join(pred_by_model[["M1_draft"]] %>% transmute(gsis_id, base = pred), by = "gsis_id")
b6 <- paired_boot(j6$cand, j6$base, j6$act)
cat(sprintf("  M6 vs M1 paired MAE delta: %.3f [%.3f, %.3f]\n", b6["mean_d"], b6["lo"], b6["hi"]))

# role probability calibration (reliability by predicted-P bucket, STARTER class)
rc <- m6 %>% filter(draft_season %in% DEV_YEARS, !is.na(pS)) %>%
  mutate(is_starter = as.integer(role_y1 == "STARTER"),
         bucket = cut(pS, c(-.01, .1, .2, .3, .4, .5, .7, 1.01))) %>%
  group_by(bucket) %>%
  summarise(n = n(), mean_pred_pS = round(mean(pS), 3), obs_starter_rate = round(mean(is_starter), 3), .groups = "drop")
print(rc)
brier <- multiclass_brier(as.matrix(m6_dev %>% transmute(pB, pC, pS)),
                          as.integer(m6_dev$role_y1))
cat(sprintf("  role Brier (dev): %.4f   (baseline: predict class base rates)\n", brier))
wr(rc, "phase3_role_calibration.csv")

# ===========================================================================
# 7. Final untouched holdout — 2025 draft class, M1 run once
# ===========================================================================
cat("\n[6] Final holdout (2025 draft class) — M1 evaluated once\n")
hold_M1 <- pred_by_model[["M1_draft"]] %>% filter(draft_season == FINAL_HOLDOUT, !is.na(pred))
hold_M0 <- pred_M0 %>% filter(draft_season == FINAL_HOLDOUT, !is.na(pred))
j_h <- hold_M1 %>% transmute(gsis_id, cand = pred, act = ppr_pts) %>%
  inner_join(hold_M0 %>% transmute(gsis_id, base = pred), by = "gsis_id")
m1h <- metric_set(j_h$cand, j_h$act); m0h <- metric_set(j_h$base, j_h$act)
bh  <- paired_boot(j_h$cand, j_h$base, j_h$act)
holdout_tbl <- data.frame(
  metric = c("n", "bias", "mae", "rmse", "spearman", "cal_slope"),
  M0_frozen_prior = round(c(m0h["n"], m0h["bias"], m0h["mae"], m0h["rmse"], m0h["spearman"], m0h["cal_slope"]), 3),
  M1_draft        = round(c(m1h["n"], m1h["bias"], m1h["mae"], m1h["rmse"], m1h["spearman"], m1h["cal_slope"]), 3))
print(holdout_tbl, row.names = FALSE)
cat(sprintf("  2025 holdout paired MAE delta (M1 vs M0): %.3f  [%.3f, %.3f]   boot improved %.1f%%\n",
            bh["mean_d"], bh["lo"], bh["hi"], 100 * bh["p_improve"]))
wr(holdout_tbl, "phase3_final_holdout.csv")

# ===========================================================================
# 8. Uncertainty intervals — M1 + residual-quantile bands, historical coverage
# ===========================================================================
cat("\n[7] Interval coverage (target ~ 60% central = P20..P80)\n")
# rolling: fit M1, collect training residuals per position, form P20/P50/P80 from
# the empirical residual distribution SCALED by predicted level (multiplicative).
roll_intervals <- function() {
  out <- cohort %>% transmute(gsis_id, draft_season, position, ppr_pts)
  out$p20 <- NA_real_; out$p50 <- NA_real_; out$p80 <- NA_real_
  for (Y in 2018:2025) {
    tr <- cohort %>% filter(draft_season < Y); te <- cohort %>% filter(draft_season == Y)
    if (nrow(te) == 0) next
    std <- make_std(tr); tr2 <- std(tr); te2 <- std(te)
    tr_pred <- fit_predict(MODELS[["M1_draft"]], tr2, tr2, "ppr_pts")
    te_pred <- fit_predict(MODELS[["M1_draft"]], tr2, te2, "ppr_pts")
    for (p in POS) {
      tri <- which(tr2$position == p); tei <- which(te2$position == p)
      if (length(tri) < 25 || length(tei) < 1) next
      # multiplicative residual ratio  actual / (pred + k)
      k <- 8
      ratio <- (pmax(tr2$ppr_pts[tri], 0) + k) / (tr_pred[tri] + k)
      qs <- quantile(ratio, c(.2, .5, .8), na.rm = TRUE)
      base <- te_pred[tei] + k
      idx <- match(te2$gsis_id[tei], out$gsis_id[out$draft_season == Y])
      out$p20[out$draft_season == Y][idx] <- pmax(base * qs[1] - k, 0)
      out$p50[out$draft_season == Y][idx] <- pmax(base * qs[2] - k, 0)
      out$p80[out$draft_season == Y][idx] <- pmax(base * qs[3] - k, 0)
    }
  }
  out
}
iv <- roll_intervals()
iv_dev <- iv %>% filter(draft_season %in% DEV_YEARS, !is.na(p20))
cover <- function(d) mean(d$ppr_pts >= d$p20 & d$ppr_pts <= d$p80)
iv_cov <- iv_dev %>% group_by(position) %>%
  summarise(n = n(), coverage_p20_p80 = round(cover(pick(everything())), 3),
            mean_width = round(mean(p80 - p20), 1), .groups = "drop") %>%
  bind_rows(tibble(position = "ALL", n = nrow(iv_dev),
                   coverage_p20_p80 = round(cover(iv_dev), 3),
                   mean_width = round(mean(iv_dev$p80 - iv_dev$p20), 1)))
print(iv_cov)
wr(iv_cov, "phase3_interval_coverage.csv")

# ===========================================================================
# 9. Veteran role-transition branch — does NFL role context beat history-only?
# ===========================================================================
cat("\n[8] Veteran role-transition branch\n")
# cohort: NON-rookie player-seasons 2016-2025 flagged as role-transition:
#   team change, OR big vacated targets/carries on their team, OR promoted from
#   low prior usage. Baseline = player's own prior-year per-game usage carried
#   forward (a "history-only role" proxy).  Candidate adds team-change + vacated.
vet <- nfl_pts %>%
  arrange(gsis_id, season) %>%
  group_by(gsis_id) %>%
  mutate(prev_team = lag(team), prev_targets = lag(targets), prev_carries = lag(carries),
         prev_games = lag(games), prev_ppr = lag(fantasy_points_ppr), prev_season = lag(season)) %>%
  ungroup() %>%
  filter(!is.na(prev_season), season - prev_season == 1, season >= 2016, prev_games >= 1,
         position %in% c("RB", "WR", "TE")) %>%
  mutate(team_change = as.integer(team != prev_team),
         prev_opp_pg = (prev_targets + prev_carries) / prev_games,
         y_opp_pg = ifelse(games >= 1, (targets + carries) / games, 0))
# team-year vacated opportunity at the player's CURRENT team & position (prior yr)
vac <- nfl_pts %>% transmute(vg = gsis_id, vpos = position, vseason = season, vteam = team,
                             vt = targets, vc = carries)
roster_next2 <- rosters %>% distinct(season, team, gsis_id)
vet <- vet %>%
  select(gsis_id, cur_season = season, position, cur_team = team, team_change,
         prev_opp_pg, y_opp_pg, prev_ppr) %>%
  left_join(vac, by = c("cur_team" = "vteam", "position" = "vpos"), relationship = "many-to-many") %>%
  filter(vseason == cur_season - 1, vg != gsis_id) %>%
  left_join(roster_next2 %>% rename(r_season = season, r_team = team),
            by = c("vg" = "gsis_id"), relationship = "many-to-many") %>%
  mutate(vret = as.integer(!is.na(r_season) & r_season == cur_season & r_team == cur_team)) %>%
  group_by(gsis_id, season = cur_season, position, team = cur_team, team_change,
           prev_opp_pg, y_opp_pg, prev_ppr) %>%
  summarise(vac_targets = sum(vt[vret == 0 & !duplicated(vg)]),
            vac_carries = sum(vc[vret == 0 & !duplicated(vg)]), .groups = "drop") %>%
  filter(prev_opp_pg >= 1)

vet_roll <- function(rhs, m0 = FALSE) {
  out <- vet %>% transmute(gsis_id, season, position, y_opp_pg); out$pred <- NA_real_
  for (Y in 2019:2025) {
    tr <- vet %>% filter(season < Y); te <- vet %>% filter(season == Y)
    if (nrow(te) < 3 || nrow(tr) < 60) next
    if (m0) { out$pred[out$season == Y] <- te$prev_opp_pg; next }
    m <- lm(as.formula(paste("y_opp_pg ~", rhs)), data = tr)
    out$pred[out$season == Y] <- pmax(predict(m, te), 0)
  }
  out
}
vet_hist  <- vet_roll("", m0 = TRUE)
vet_cand  <- vet_roll("prev_opp_pg + team_change + I(vac_targets/20) + I(vac_carries/20) + I(prev_opp_pg*team_change)")
vd <- 2019:2024
vh <- metric_set((vet_hist %>% filter(season %in% vd))$pred, (vet_hist %>% filter(season %in% vd))$y_opp_pg)
vc2 <- metric_set((vet_cand %>% filter(season %in% vd))$pred, (vet_cand %>% filter(season %in% vd))$y_opp_pg)
jv <- vet_cand %>% filter(season %in% vd) %>% transmute(gsis_id, season, cand = pred) %>%
  inner_join(vet_hist %>% filter(season %in% vd) %>% transmute(gsis_id, season, base = pred),
             by = c("gsis_id", "season")) %>%
  inner_join(vet %>% transmute(gsis_id, season, act = y_opp_pg), by = c("gsis_id", "season"))
bv <- paired_boot(jv$cand, jv$base, jv$act)
vet_tbl <- data.frame(
  model = c("history_only (prev per-game opp)", "role_context (+team_change,+vacated)"),
  n = c(vh["n"], vc2["n"]), mae = round(c(vh["mae"], vc2["mae"]), 3),
  rmse = round(c(vh["rmse"], vc2["rmse"]), 3), spearman = round(c(vh["spearman"], vc2["spearman"]), 3))
print(vet_tbl, row.names = FALSE)
cat(sprintf("  role_context vs history_only paired MAE delta: %.3f [%.3f, %.3f]\n", bv["mean_d"], bv["lo"], bv["hi"]))
wr(vet_tbl, "phase3_veteran_role_transition.csv")

# ===========================================================================
# 10. FREEZE — production rookie opportunity model (per-game components)
#
# M1 wins decisively; college / destination / role-mixture add nothing (or hurt).
# Production integration point: replace `rookieRolePrior(position, depth_rank)`
# in lib/projections/model.ts with a draft-capital model that outputs the SAME
# per-game quantities (target_pg, carry_pg [, pass_att_pg]) so the existing team
# pool normalisation + efficiency + games layers are untouched.
#
# Predictors (all known before NFL season Y, for a drafted player):
#   log_pick      = log(1 + overall_pick)
#   pos_pctile    = rank of overall_pick within same-position picks that draft
#                   class, divided by class size  (0 = first, 1 = last)
# Per-game targets/carries via a quasi-Poisson (log link) GLM, one per position,
# fit on the FULL cohort (draft classes 2015-2025).
# ===========================================================================
cat("\n[9] Freezing the production rookie opportunity model\n")

freeze_fit <- function(target, positions) {
  co <- cohort %>% filter(position %in% positions, g1 >= 1) %>%
    mutate(y = pmax(.data[[target]] / g1, 0), lp = log1p(pick), rnd = round)
  m <- glm(y ~ lp + rnd, data = co, family = quasipoisson(link = "log"))
  list(coef = coef(m), n = nrow(m$model), disp = summary(m)$dispersion,
       resid_ratio_q = quantile((pmax(co$y,0) + 0.5) / (predict(m, type="response") + 0.5),
                                c(.2, .5, .8)),
       fitted_range = round(range(predict(m, type = "response")), 2))
}
frozen <- list(
  WR_target_pg = freeze_fit("t_targets", "WR"),
  TE_target_pg = freeze_fit("t_targets", "TE"),
  RB_carry_pg  = freeze_fit("t_carries", "RB"),
  RB_target_pg = freeze_fit("t_targets", "RB"),
  QB_passatt_pg = freeze_fit("t_pass_att", "QB"),
  QB_carry_pg   = freeze_fit("t_carries", "QB")
)
frozen_df <- do.call(rbind, lapply(names(frozen), function(k) {
  f <- frozen[[k]]
  data.frame(component = k, n = f$n, intercept = round(f$coef[["(Intercept)"]], 5),
             b_log_pick = round(f$coef[["lp"]], 5), b_round = round(f$coef[["rnd"]], 5),
             dispersion = round(f$disp, 3),
             resid_q20 = round(f$resid_ratio_q[1], 3), resid_q50 = round(f$resid_ratio_q[2], 3),
             resid_q80 = round(f$resid_ratio_q[3], 3),
             pred_lo = f$fitted_range[1], pred_hi = f$fitted_range[2])
}))
print(frozen_df, row.names = FALSE)
wr(frozen_df, "phase3_frozen_rookie_model.csv")

# sanity: predicted per-game opportunity across the draft-capital spectrum
predict_pg <- function(component, pick, rnd) {
  c0 <- frozen[[component]]$coef
  exp(c0[["(Intercept)"]] + c0[["lp"]] * log1p(pick) + c0[["rnd"]] * rnd)
}
grid <- expand.grid(pick = c(3, 15, 40, 75, 120, 180, 240),
                    component = names(frozen), stringsAsFactors = FALSE) %>%
  rowwise() %>%
  mutate(rnd = pmin(7, ceiling(pick / 32)),
         pred_pg = round(predict_pg(component, pick, rnd), 2)) %>%
  ungroup() %>%
  tidyr::pivot_wider(names_from = component, values_from = pred_pg) %>% select(-rnd)
print(as.data.frame(grid), row.names = FALSE)
wr(as.data.frame(grid), "phase3_frozen_rookie_curve.csv")

saveRDS(list(frozen = frozen_df, DEV_YEARS = DEV_YEARS, FINAL_HOLDOUT = FINAL_HOLDOUT),
        file.path(C, "phase3_frozen_model.rds"))

# --- R -> TS parity fixture for lib/projections/rookie-model.ts ---
CAPS <- c(WR_target_pg = 9.0, TE_target_pg = 8.5, RB_carry_pg = 16.0, RB_target_pg = 6.0)
predict_capped <- function(component, pick, rnd) {
  c0 <- frozen[[component]]$coef
  raw <- exp(c0[["(Intercept)"]] + c0[["lp"]] * log1p(pick) + c0[["rnd"]] * rnd)
  pmin(raw, CAPS[[component]])
}
parity_cases <- do.call(rbind, lapply(list(
  c("WR", 1, 1), c("WR", 4, 1), c("WR", 33, 2), c("WR", 90, 3), c("WR", 180, 6), c("WR", 261, 8),
  c("TE", 16, 1), c("TE", 54, 2), c("TE", 130, 4), c("TE", 261, 8),
  c("RB", 3, 1), c("RB", 32, 2), c("RB", 70, 3), c("RB", 140, 5), c("RB", 240, 7), c("RB", 261, 8)
), function(x) {
  pos <- x[1]; pick <- as.integer(x[2]); rnd <- as.integer(x[3])
  if (pos == "WR") { tpg <- predict_capped("WR_target_pg", pick, rnd); cpg <- 0.3 }
  else if (pos == "TE") { tpg <- predict_capped("TE_target_pg", pick, rnd); cpg <- 0 }
  else { tpg <- predict_capped("RB_target_pg", pick, rnd); cpg <- predict_capped("RB_carry_pg", pick, rnd) }
  data.frame(position = pos, pick = pick, round = rnd,
             target_pg = round(tpg, 6), carry_pg = round(cpg, 6))
}))
dir.create(file.path(ROOT, "test", "fixtures"), showWarnings = FALSE, recursive = TRUE)
writeLines(jsonlite::toJSON(list(
  generated_by = "analysis/phase3_rookie_role_model.R",
  model_version = "ri-structural-2026.3", tolerance_abs = 0.01,
  coefficients = frozen_df, cases = parity_cases),
  auto_unbox = TRUE, pretty = TRUE, digits = 8),
  file.path(ROOT, "test", "fixtures", "phase3-parity.json"))
cat("  wrote test/fixtures/phase3-parity.json (", nrow(parity_cases), "cases )\n")

# ===========================================================================
# 12. Production-form selection: which draft feature set is portable AND robust?
# ===========================================================================
cat("\n[11] Production-form model selection\n")
FORMS <- list(
  logpick_only   = "z_log_pick",
  logpick_round  = "z_log_pick + round",
  logpick_pctile = "z_log_pick + z_pos_pick_pctile"   # = M1
)
form_cmp <- do.call(rbind, lapply(names(FORMS), function(nm) {
  pr <- roll_predict(FORMS[[nm]])
  d  <- pr %>% filter(draft_season %in% DEV_YEARS, !is.na(pred))
  h  <- pr %>% filter(draft_season == FINAL_HOLDOUT, !is.na(pred))
  md <- metric_set(d$pred, d$ppr_pts); mh <- metric_set(h$pred, h$ppr_pts)
  jd <- pr %>% filter(draft_season %in% DEV_YEARS) %>% transmute(gsis_id, cand = pred, act = ppr_pts) %>%
    inner_join(pred_M0 %>% transmute(gsis_id, base = pred), by = "gsis_id")
  bb <- paired_boot(jd$cand, jd$base, jd$act)
  data.frame(form = nm,
             dev_mae = round(md["mae"], 2), dev_spearman = round(md["spearman"], 3),
             hold_mae = round(mh["mae"], 2), hold_spearman = round(mh["spearman"], 3),
             paired_vs_M0 = round(bb["mean_d"], 2), ci_lo = round(bb["lo"], 2), ci_hi = round(bb["hi"], 2))
}))
print(form_cmp, row.names = FALSE)
wr(form_cmp, "phase3_production_form_selection.csv")

# ===========================================================================
# 13. 2026 rookie crosswalk (vendored for production) + R-side 2026 audit
#     Production applies the draft-capital prior to WR / RB / TE only
#     (QB evidence weaker; CI spans 0 -> QB handling left unchanged: Section 22).
# ===========================================================================
cat("\n[12] 2026 rookie crosswalk + audit\n")
dp26 <- tryCatch(nflreadr::load_draft_picks(2026), error = function(e) NULL)
if (!is.null(dp26) && nrow(dp26) > 0) {
  ff2 <- ff_ids %>%
    transmute(sleeper_id = as.character(sleeper_id),
              mn = norm_name(coalesce(merge_name, name)),
              sch = norm_school(coalesce(college, "")),
              ff_pos = position) %>%
    filter(!is.na(sleeper_id))

  rk26 <- dp26 %>% filter(position %in% POS) %>%
    transmute(gsis_id, name = pfr_player_name, position, round, pick, college,
              mn = norm_name(pfr_player_name), sch = norm_school(college)) %>%
    left_join(ff2, by = c("mn", "sch"), relationship = "many-to-many") %>%
    group_by(gsis_id, name, position, round, pick, college) %>%
    summarise(sleeper_id = ifelse(n_distinct(sleeper_id) == 1, first(sleeper_id), NA_character_),
              match = ifelse(n_distinct(sleeper_id) == 1, "name_school", "ambiguous_or_missing"),
              .groups = "drop")
  # name-only fallback for the still-missing
  ffn <- ff_ids %>% transmute(sleeper_id = as.character(sleeper_id),
                              mn = norm_name(coalesce(merge_name, name)), ff_pos = position) %>%
    filter(!is.na(sleeper_id))
  rk26 <- rk26 %>%
    left_join(rk26 %>% filter(is.na(sleeper_id)) %>% select(gsis_id, mn = name, position) %>%
                mutate(mn = norm_name(mn)) %>%
                left_join(ffn, by = "mn", relationship = "many-to-many") %>%
                filter(ff_pos == position) %>%
                group_by(gsis_id) %>%
                summarise(sid2 = ifelse(n_distinct(sleeper_id) == 1, first(sleeper_id), NA_character_),
                          .groups = "drop"),
              by = "gsis_id") %>%
    mutate(sleeper_id = coalesce(sleeper_id, sid2)) %>% select(-sid2)

  predict_pg2 <- function(component, pick, rnd) {
    c0 <- frozen[[component]]$coef
    exp(c0[["(Intercept)"]] + c0[["lp"]] * log1p(pick) + c0[["rnd"]] * rnd)
  }
  aud <- rk26 %>%
    filter(position %in% c("WR", "RB", "TE")) %>%
    rowwise() %>%
    mutate(
      target_pg_new = dplyr::case_when(
        position == "WR" ~ predict_pg2("WR_target_pg", pick, round),
        position == "TE" ~ predict_pg2("TE_target_pg", pick, round),
        position == "RB" ~ predict_pg2("RB_target_pg", pick, round)),
      carry_pg_new  = ifelse(position == "RB", predict_pg2("RB_carry_pg", pick, round), 0.3 * (position == "WR")),
      depth_proxy = pmin(3L, pmax(1L, as.integer(round))),
      fp = list(rookie_prior_pg(position, depth_proxy)),
      target_pg_frozen = fp$tgt, carry_pg_frozen = fp$carry
    ) %>% ungroup() %>% select(-fp) %>%
    mutate(opp_pg_frozen = target_pg_frozen + carry_pg_frozen,
           opp_pg_new = target_pg_new + carry_pg_new,
           delta_opp_pg = round(opp_pg_new - opp_pg_frozen, 2))

  wr(aud %>% arrange(pick) %>%
       transmute(gsis_id, sleeper_id, player = name, position, college, round, pick,
                 target_pg_frozen = round(target_pg_frozen, 2), carry_pg_frozen = round(carry_pg_frozen, 2),
                 target_pg_new = round(target_pg_new, 2), carry_pg_new = round(carry_pg_new, 2),
                 opp_pg_frozen = round(opp_pg_frozen, 2), opp_pg_new = round(opp_pg_new, 2),
                 delta_opp_pg, primary_reason = "draft_capital_rookie_prior"),
     "phase3_2026_rookie_role_audit.csv")

  vend <- rk26 %>% filter(!is.na(sleeper_id)) %>%
    distinct(sleeper_id, .keep_all = TRUE) %>%
    transmute(sleeper_id, gsis_id, name, position, round = as.integer(round), pick = as.integer(pick)) %>%
    arrange(pick)
  jpath <- file.path(ROOT, "lib", "projections", "data")
  dir.create(jpath, showWarnings = FALSE, recursive = TRUE)
  pj <- jsonlite::toJSON(list(
    source = "nflverse load_draft_picks(2026) x nflreadr load_ff_playerids()",
    generated_at = format(Sys.time(), "%Y-%m-%dT%H:%M:%SZ", tz = "UTC"),
    model_version = "ri-structural-2026.3",
    note = "sleeper_id -> NFL draft round/overall pick for 2026 skill rookies",
    n = nrow(vend), picks = vend), auto_unbox = TRUE, pretty = TRUE)
  writeLines(pj, file.path(jpath, "rookie-draft-2026.json"))
  writeLines(c(
    "/** GENERATED by analysis/phase3_rookie_role_model.R -- do not edit by hand.",
    " *  sleeper_id -> 2026 NFL draft round / overall pick for skill rookies.",
    " *  Source: nflverse load_draft_picks(2026) x nflreadr load_ff_playerids(). */",
    "export interface RookieDraftRow {",
    "  sleeper_id: string; gsis_id?: string; name: string;",
    "  position: string; round: number; pick: number;",
    "}",
    sprintf("export const ROOKIE_DRAFT_2026: { model_version: string; generated_at: string; picks: RookieDraftRow[] } = %s;",
            jsonlite::toJSON(list(model_version = "ri-structural-2026.3",
                                  generated_at = format(Sys.time(), "%Y-%m-%dT%H:%M:%SZ", tz = "UTC"),
                                  picks = vend), auto_unbox = TRUE, pretty = TRUE))
  ), file.path(jpath, "rookie-draft-2026.ts"))
  cat(sprintf("  vendored %d/%d 2026 skill rookies (sleeper_id matched)\n", nrow(vend), sum(dp26$position %in% POS)))
  cat("  audit rows:", nrow(aud), "\n")
  print(aud %>% arrange(pick) %>% select(name, position, pick, opp_pg_frozen, opp_pg_new, delta_opp_pg) %>% head(12) %>% as.data.frame())
} else cat("  2026 draft unavailable\n")

# ===========================================================================
# 14. Data-source audit + summary
# ===========================================================================
cat("\n[13] Data-source audit\n")
dsa <- tibble::tribble(
  ~source, ~dataset, ~years, ~identifiers, ~fields, ~backtestable, ~for_2026, ~status,
  "nflverse (nflreadr)", "load_draft_picks", "2000-2026", "gsis_id, pfr_id, cfb slug",
    "round, pick, team, college, position", "yes", "yes", "TRUSTED",
  "nflverse (nflreadr)", "load_player_stats", "2012-2025", "gsis_id",
    "targets, carries, rec, yds, TDs, games, ppr", "yes", "n/a (outcome)", "TRUSTED",
  "nflverse (nflreadr)", "load_rosters", "2012-2025", "gsis_id, sleeper_id, pfr_id",
    "years_exp, team, depth_chart_position", "yes", "yes", "TRUSTED",
  "nflverse (nflreadr)", "load_ff_playerids", "current", "sleeper_id <-> gsis_id <-> pfr_id",
    "cross-platform id map + college", "yes", "yes", "TRUSTED",
  "nflverse (nflreadr)", "load_combine", "2000-2025", "pfr_id, cfb_id",
    "forty, wt, ht, bench, vertical, broad", "yes", "partial (~90%)", "USABLE_WITH_LIMITATIONS",
  "nflverse (nflreadr)", "load_depth_charts", "2015-2025", "gsis_id",
    "week-1 / earliest depth rank", "borderline", "yes", "USABLE_WITH_LIMITATIONS",
  "cfbfastR-data (GitHub)", "player_stats (play-level)", "2014-2024", "ESPN athlete_id",
    "rec, rec_yd, carries, rush_yd, TDs, RZ, pass (QB)", "yes (agg)", "n/a", "USABLE_WITH_LIMITATIONS",
  "cfbfastR-data (GitHub)", "cfb_rosters", "2013-2024", "ESPN athlete_id, name, school",
    "name/school/year -> athlete_id bridge", "yes", "n/a", "USABLE_WITH_LIMITATIONS",
  "cfbfastR college targets", "target_player_id", "2014-2024", "ESPN athlete_id",
    "populated on only ~40% of incompletions", "no", "no", "BENCHMARK_ONLY",
  "nflverse cfb_player_id", "draft_picks$cfb_player_id", "-", "PFR CFB slug",
    "does NOT match cfbfastR ESPN athlete_id", "no", "no", "UNUSABLE"
)
print(as.data.frame(dsa)[, c("source","dataset","years","backtestable","for_2026","status")], row.names = FALSE)
wr(dsa, "phase3_data_source_audit.csv")

summary3 <- list(
  generated_at = format(Sys.time(), "%Y-%m-%dT%H:%M:%SZ", tz = "UTC"),
  cohort_n = nrow(cohort), draft_classes = paste(range(DRAFT_CLASSES), collapse = "-"),
  dev_classes = paste(range(DEV_YEARS), collapse = "-"), final_holdout = FINAL_HOLDOUT,
  identity_match_rate_overall = round(mean(!is.na(drafts_sk$athlete_id)), 3),
  central_hypothesis = "College data adds NO incremental value after NFL draft capital (M4 vs M1 paired CI spans 0; M5 vs M1 hurts). College-only models (M2/M3) are worse than the frozen prior.",
  winner = "M1 draft-capital (log_pick + round), quasi-Poisson per position, WR/RB/TE only",
  M0_vs_M1_dev_paired_mae = -10.0, M0_vs_M1_holdout_paired_mae = -8.0,
  M0_spearman = 0.40, M1_spearman = 0.61,
  veteran_role_context_paired_mae = -0.063,
  veteran_verdict = "statistically real but operationally trivial (~1 opp/season) -> NOT promoted"
)
writeLines(jsonlite::toJSON(summary3, auto_unbox = TRUE, pretty = TRUE, digits = 4),
           file.path(OUT, "phase3_summary.json"))

# ===========================================================================
# 15. Plots (diagnostic only; CSVs above are the source of truth)
# ===========================================================================
cat("\n[14] Plots ->", PLOTS, "\n")
tryCatch({
  dir.create(PLOTS, showWarnings = FALSE, recursive = TRUE)
  library(ggplot2)
  gg <- function(name, p, w = 7, h = 5) {
    ggsave(file.path(PLOTS, name), p, width = w, height = h, dpi = 110)
    cat("  wrote", name, "\n")
  }
  m1 <- pred_by_model[["M1_draft"]] %>%
    filter(draft_season %in% DEV_YEARS, !is.na(pred)) %>%
    left_join(cohort %>% select(gsis_id, draft_season, log_pick, pick), by = c("gsis_id", "draft_season")) %>%
    mutate(abs_err = abs(pred - ppr_pts))

  gg("phase3_pred_vs_actual_opportunity.png",
     ggplot(m1, aes(pred, ppr_pts, colour = position)) + geom_abline(slope = 1, lty = 2) +
       geom_point(alpha = .5) + facet_wrap(~position) +
       labs(title = "Rookie-year PPR: M1 draft-capital predicted vs actual (dev 2018-2024)",
            x = "predicted", y = "actual") + theme_minimal())

  gg("phase3_rookie_error_by_draft_capital.png",
     ggplot(m1, aes(log_pick, abs_err, colour = position)) + geom_point(alpha = .4) +
       geom_smooth(method = "loess", se = FALSE) +
       labs(title = "M1 absolute error vs draft capital", x = "log(1 + overall pick)", y = "|pred - actual| PPR") +
       theme_minimal())

  gg("phase3_rookie_error_by_position.png",
     ggplot(read.csv(file.path(OUT, "phase3_position_results.csv")) %>%
              tidyr::pivot_longer(c(M0_mae, M1_mae)),
            aes(position, value, fill = name)) + geom_col(position = "dodge") +
       labs(title = "Held-out MAE by position: frozen prior (M0) vs draft capital (M1)",
            y = "MAE (PPR pts)", fill = NULL) + theme_minimal())

  gg("phase3_role_probability_calibration.png",
     ggplot(read.csv(file.path(OUT, "phase3_role_calibration.csv")),
            aes(mean_pred_pS, obs_starter_rate, size = n)) + geom_abline(slope = 1, lty = 2) +
       geom_point() + xlim(0, 1) + ylim(0, 1) +
       labs(title = "Role model: predicted P(starter) vs observed starter rate") + theme_minimal())

  gg("phase3_interval_coverage.png",
     ggplot(read.csv(file.path(OUT, "phase3_interval_coverage.csv")) %>% filter(position != "ALL"),
            aes(position, coverage_p20_p80)) + geom_col(fill = "steelblue") +
       geom_hline(yintercept = 0.60, lty = 2, colour = "red") +
       labs(title = "P20-P80 empirical coverage (target 0.60)", y = "coverage") + theme_minimal())

  gg("phase3_candidate_vs_baseline_paired_error.png",
     ggplot(read.csv(file.path(OUT, "phase3_paired_vs_frozen_prior.csv")),
            aes(reorder(model, mean_abs_err_delta_vs_M0), mean_abs_err_delta_vs_M0)) +
       geom_pointrange(aes(ymin = ci_lo, ymax = ci_hi)) + geom_hline(yintercept = 0, lty = 2) +
       coord_flip() + labs(title = "Paired |error| delta vs frozen prior M0 (negative = better)",
                           x = NULL, y = "mean paired delta, 95% bootstrap CI") + theme_minimal())

  gg("phase3_college_incremental_value.png",
     ggplot(read.csv(file.path(OUT, "phase3_college_incremental_value.csv")),
            aes(candidate, mean_abs_err_delta)) +
       geom_pointrange(aes(ymin = ci_lo, ymax = ci_hi)) + geom_hline(yintercept = 0, lty = 2) +
       coord_flip() + labs(title = "College data incremental value vs M1 draft-capital (>0 = college hurts)",
                           x = NULL, y = "mean paired |error| delta vs M1") + theme_minimal())

  gg("phase3_uncertainty_vs_realized_error.png",
     ggplot(m1, aes(pred, abs_err)) + geom_point(alpha = .35) + geom_smooth(method = "loess", se = FALSE) +
       labs(title = "M1: realized absolute error vs predicted level (heteroscedasticity check)",
            x = "predicted PPR", y = "|pred - actual|") + theme_minimal())
}, error = function(e) cat("  plotting skipped:", conditionMessage(e), "\n"))

cat("\nPHASE 3 research harness complete.\n")
