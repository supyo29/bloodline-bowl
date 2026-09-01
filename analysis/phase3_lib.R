# ===========================================================================
# phase3_lib.R — shared helpers for the Phase 3 rookie / role research harness
# ===========================================================================

suppressWarnings(suppressMessages({
  library(dplyr); library(tidyr); library(stringr); library(purrr)
}))

norm_name <- function(x) {
  x |>
    tolower() |>
    str_replace_all("\\b(jr|sr|ii|iii|iv|v)\\b", " ") |>
    str_replace_all("[^a-z ]", "") |>
    str_squish()
}

# nflverse "college" strings vs cfbfastR "team" strings -> a common key.
SCHOOL_ALIASES <- c(
  "southern california" = "usc", "southern cal" = "usc",
  "mississippi" = "ole miss", "miss" = "ole miss",
  "pittsburgh" = "pitt",
  "central florida" = "ucf",
  "texas christian" = "tcu",
  "brigham young" = "byu",
  "louisiana state" = "lsu",
  "north carolina state" = "nc state", "north carolina st" = "nc state",
  "miami fl" = "miami", "miami florida" = "miami", "miami (fl)" = "miami",
  "louisiana lafayette" = "louisiana", "louisiana-lafayette" = "louisiana",
  "texas am" = "texas a&m", "texas a and m" = "texas a&m",
  "bowling green state" = "bowling green",
  "middle tennessee state" = "middle tennessee",
  "california" = "cal",
  "massachusetts" = "umass",
  "connecticut" = "uconn",
  "southern methodist" = "smu",
  "alabama birmingham" = "uab",
  "nevada las vegas" = "unlv",
  "san jose state" = "san jose st", "san jos state" = "san jose st"
)
norm_school <- function(x) {
  k <- x |> tolower() |> str_replace_all("[^a-z& ]", "") |> str_squish()
  out <- SCHOOL_ALIASES[k]
  ifelse(is.na(out), k, unname(out))
}

# ---------------------------------------------------------------------------
# build_identity_crosswalk()
#
#   drafts : nflverse draft_picks rows (skill, target classes), columns
#            gsis_id, pfr_player_name, college, position, season
#   cfb_ath: cfbfastR athlete master, columns athlete_id, name (normalised),
#            school (normalised), season, is_toucher (appeared in play data)
#
# Deterministic matching, most specific first:
#   EXACT_ID        (n/a here — nflverse cfb_player_id is a PFR slug, not the
#                    cfbfastR/ESPN athlete id; documented in the report)
#   HIGH_CONFIDENCE  unique name+school in the player's final-2 college seasons
#   MEDIUM           unique name+school in a wider [-5,-1] window
#   AMBIGUOUS        >1 candidate
#   UNMATCHED        0 candidates
# ---------------------------------------------------------------------------
build_identity_crosswalk <- function(drafts, cfb_ath) {
  d <- drafts |>
    transmute(gsis_id, position,
              draft_season = season,
              nm = norm_name(pfr_player_name),
              sch = norm_school(college),
              final_cfb = season - 1L)

  ath <- cfb_ath |>
    filter(is_toucher) |>
    transmute(athlete_id, nm = name, sch = school, cfb_season = season,
              ath_pos = position)

  cand <- d |>
    left_join(ath, by = c("nm", "sch"), relationship = "many-to-many") |>
    mutate(
      gap = draft_season - cfb_season,
      in_tight = !is.na(athlete_id) & gap >= 1 & gap <= 2,
      in_wide  = !is.na(athlete_id) & gap >= 1 & gap <= 5
    )

  per <- cand |>
    group_by(gsis_id, position, draft_season) |>
    summarise(
      tight_ids = list(unique(athlete_id[in_tight])),
      wide_ids  = list(unique(athlete_id[in_wide])),
      .groups = "drop"
    ) |>
    mutate(
      n_tight = lengths(tight_ids),
      n_wide  = lengths(wide_ids),
      match_status = dplyr::case_when(
        n_tight == 1 ~ "HIGH_CONFIDENCE",
        n_tight >  1 ~ "AMBIGUOUS",
        n_wide  == 1 ~ "MEDIUM",
        n_wide  >  1 ~ "AMBIGUOUS",
        TRUE ~ "UNMATCHED"
      ),
      athlete_id = dplyr::case_when(
        n_tight == 1 ~ vapply(tight_ids, function(x) x[1], character(1)),
        n_tight == 0 & n_wide == 1 ~ vapply(wide_ids, function(x) x[1], character(1)),
        TRUE ~ NA_character_
      )
    )
  per |> select(gsis_id, position, draft_season, athlete_id, match_status)
}

# ---------------------------------------------------------------------------
metric_set <- function(pred, act) {
  ok <- is.finite(pred) & is.finite(act)
  pred <- pred[ok]; act <- act[ok]; n <- length(pred)
  if (n < 3) return(c(n = n, bias = NA, mae = NA, rmse = NA, spearman = NA,
                      cal_intercept = NA, cal_slope = NA))
  e <- pred - act
  fit <- tryCatch(coef(lm(act ~ pred)), error = function(x) c(NA, NA))
  c(n = n, bias = mean(e), mae = mean(abs(e)), rmse = sqrt(mean(e^2)),
    spearman = suppressWarnings(cor(pred, act, method = "spearman")),
    cal_intercept = unname(fit[1]), cal_slope = unname(fit[2]))
}

paired_boot <- function(cand, base, act, R = 1000, seed = 30303) {
  ok <- is.finite(cand) & is.finite(base) & is.finite(act)
  cand <- cand[ok]; base <- base[ok]; act <- act[ok]; n <- length(act)
  if (n < 8) return(c(n = n, mean_d = NA, lo = NA, hi = NA, p_improve = NA))
  d <- abs(cand - act) - abs(base - act)
  set.seed(seed)
  stat <- replicate(R, mean(d[sample.int(n, n, replace = TRUE)]))
  c(n = n, mean_d = mean(d),
    lo = unname(quantile(stat, 0.025)), hi = unname(quantile(stat, 0.975)),
    p_improve = mean(stat < 0))
}

# Brier score for a K-class probability matrix P (rows sum to 1) vs integer y.
multiclass_brier <- function(P, y) {
  Y <- matrix(0, nrow(P), ncol(P)); Y[cbind(seq_along(y), y)] <- 1
  mean(rowSums((P - Y)^2))
}
multiclass_logloss <- function(P, y, eps = 1e-15) {
  p <- pmin(pmax(P[cbind(seq_along(y), y)], eps), 1 - eps)
  -mean(log(p))
}
`%||%` <- function(a,b) if (is.null(a) || length(a)==0) b else a
