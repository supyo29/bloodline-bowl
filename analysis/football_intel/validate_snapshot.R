#!/usr/bin/env Rscript
# ===========================================================================
# Football Intelligence — candidate snapshot validation gate (weekly refresh).
#
#   Rscript analysis/football_intel/validate_snapshot.R <candidate_dir> <published_dir|NONE> [--force]
#
# Runs entirely against two directories of already-built served files (each
# holding football_intelligence_manifest.json + the 5 served CSVs). Never
# rebuilds anything and never writes into either directory except the result
# file <candidate_dir>/validation_result.json.
#
# Exit 0  -> candidate is safe to promote (result.overall == "PASS")
# Exit 1  -> candidate must NOT be promoted (result.overall == "FAIL")
#
# This is the "validate" + "compare" stages of the weekly refresh pipeline.
# It does not decide UPDATED vs NO_CHANGE (that's a version-hash string
# comparison, done by the workflow) — only whether the candidate is valid
# and non-regressive relative to what's currently published.
# ===========================================================================

suppressWarnings(suppressMessages({ library(dplyr); library(jsonlite) }))

args_all <- commandArgs(TRUE)
FORCE <- "--force" %in% args_all
args <- args_all[!grepl("^--", args_all)]
if (length(args) < 2) stop("usage: validate_snapshot.R <candidate_dir> <published_dir|NONE> [--force]")
CAND <- args[[1]]
PUB  <- if (args[[2]] == "NONE") NA_character_ else args[[2]]

.here <- sub("^--file=", "", grep("^--file=", commandArgs(FALSE), value = TRUE))
BASE <- if (length(.here)) dirname(.here) else file.path(getwd(), "analysis", "football_intel")
source(file.path(BASE, "config.R"))

results <- list()
add <- function(name, status, detail = "") {
  cat(sprintf("[%s] %s%s\n", status, name, if (nzchar(detail)) paste0("  -- ", detail) else ""))
  results[[length(results) + 1]] <<- list(name = name, status = status, detail = detail)
}
PASS <- "PASS"; FAIL <- "FAIL"; WARN <- "WARN"

read_manifest <- function(dir) {
  p <- file.path(dir, "football_intelligence_manifest.json")
  if (!file.exists(p)) return(NULL)
  tryCatch(jsonlite::fromJSON(p, simplifyVector = TRUE), error = function(e) NULL)
}
read_csv_safe <- function(dir, name) {
  p <- file.path(dir, name)
  if (!file.exists(p)) return(NULL)
  tryCatch(utils::read.csv(p, stringsAsFactors = FALSE), error = function(e) NULL)
}

SERVED_FILES <- c("team_profile.csv", "player_usage_profile.csv", "unit_coverage_profile.csv",
                   "contextual_matchup_feature.csv", "ftn_descriptive.csv")
REQUIRED_NONEMPTY <- c("team_profile.csv", "player_usage_profile.csv",
                        "unit_coverage_profile.csv", "contextual_matchup_feature.csv")

cand_manifest <- read_manifest(CAND)
pub_manifest  <- if (!is.na(PUB)) read_manifest(PUB) else NULL

# ---------------------------------------------------------------------------
# GATE 1 — manifest structural validity
# ---------------------------------------------------------------------------
if (is.null(cand_manifest)) {
  add("manifest is valid JSON and present", FAIL, "manifest missing or unparseable")
} else {
  add("manifest is valid JSON and present", PASS)
  req_keys <- c("football_intelligence_version", "model_tag", "feature_schema_version",
                "season", "through_week", "generated_at", "data_cutoff", "files")
  missing_keys <- setdiff(req_keys, names(cand_manifest))
  add("manifest has all required keys", if (length(missing_keys) == 0) PASS else FAIL,
      if (length(missing_keys)) paste("missing:", paste(missing_keys, collapse = ", ")) else "")

  listed <- unlist(cand_manifest$files)
  missing_files <- setdiff(listed, list.files(CAND))
  add("every file the manifest lists exists in the candidate dir",
      if (length(missing_files) == 0) PASS else FAIL,
      if (length(missing_files)) paste("missing:", paste(missing_files, collapse = ", ")) else "")

  season <- suppressWarnings(as.integer(cand_manifest$season))
  week   <- suppressWarnings(as.integer(cand_manifest$through_week))
  add("season is a plausible NFL season", if (isTRUE(season >= 2000 && season <= FI$SEASON_CURRENT + 1)) PASS else FAIL,
      sprintf("season=%s", season))
  add("through_week is a plausible NFL week", if (isTRUE(week >= 1 && week <= 22)) PASS else FAIL,
      sprintf("through_week=%s", week))
}

# ---------------------------------------------------------------------------
# GATE 2 — monotonicity / no silent downgrade vs currently published
# ---------------------------------------------------------------------------
if (!is.null(cand_manifest) && !is.null(pub_manifest)) {
  cs <- as.integer(cand_manifest$season); cw <- as.integer(cand_manifest$through_week)
  ps <- as.integer(pub_manifest$season);  pw <- as.integer(pub_manifest$through_week)
  regresses <- (cs < ps) || (cs == ps && cw < pw)
  if (regresses && FORCE) {
    add("season/week does not regress vs published", WARN,
        sprintf("regression %d w%d -> %d w%d ALLOWED by --force (manual rebuild)", ps, pw, cs, cw))
  } else {
    add("season/week does not regress vs published", if (!regresses) PASS else FAIL,
        sprintf("published %d w%d, candidate %d w%d", ps, pw, cs, cw))
  }
  # current-season regression guard: once a season has been published as
  # current, an unattended run must never fall back to an older season.
  if (ps >= FI$SEASON_CURRENT && cs < ps && !FORCE) {
    add("no un-forced regression away from an already-reached current season", FAIL,
        sprintf("published season %d already reached; candidate resolved to %d", ps, cs))
  }
} else if (!is.null(cand_manifest) && is.null(pub_manifest)) {
  add("season/week does not regress vs published", PASS, "no published snapshot yet (first publish)")
}

# ---------------------------------------------------------------------------
# GATE 3 — current-season-availability regression bug guard (uses raw cache,
# independent of what any manifest claims)
# ---------------------------------------------------------------------------
pbp_path <- file.path(FI$CACHE_DIR, "pbp.rds")
if (file.exists(pbp_path) && !is.null(cand_manifest)) {
  pbp <- readRDS(pbp_path)
  has_current <- any(pbp$season == FI$SEASON_CURRENT & pbp$season_type == "REG", na.rm = TRUE)
  cs <- as.integer(cand_manifest$season)
  if (has_current) {
    add("candidate uses the current season when current-season data exists",
        if (cs == FI$SEASON_CURRENT) PASS else FAIL,
        sprintf("cache has %d REG data; candidate resolved season=%d", FI$SEASON_CURRENT, cs))
  } else {
    add("candidate uses the current season when current-season data exists", PASS,
        sprintf("no %d REG data in cache yet -- prior-season candidate is correct", FI$SEASON_CURRENT))
  }
} else {
  add("candidate uses the current season when current-season data exists", WARN, "pbp cache not found; skipped")
}

# ---------------------------------------------------------------------------
# GATE 4 — per-source lag classification: EXPECTED_SOURCE_LAG vs BROKEN
# ---------------------------------------------------------------------------
if (!is.null(cand_manifest)) {
  cc <- cand_manifest$data_cutoff
  pc <- if (!is.null(pub_manifest)) pub_manifest$data_cutoff else list()
  same_season <- !is.null(pub_manifest) && identical(as.integer(pub_manifest$season), as.integer(cand_manifest$season))
  broken <- character(0)
  lagging <- character(0)
  for (src in names(cc)) {
    cval <- suppressWarnings(as.integer(cc[[src]]))
    pval <- if (same_season && !is.null(pc[[src]])) suppressWarnings(as.integer(pc[[src]])) else NA_integer_
    if (!is.na(pval) && (is.na(cval) || cval < pval)) {
      broken <- c(broken, sprintf("%s (was w%d, now %s)", src, pval, if (is.na(cval)) "MISSING" else paste0("w", cval)))
    } else if (!is.na(cval) && cval < as.integer(cand_manifest$through_week)) {
      lagging <- c(lagging, sprintf("%s (w%d, through_week w%d)", src, cval, as.integer(cand_manifest$through_week)))
    }
  }
  # a source present in the previously published manifest that vanished
  # entirely from the candidate for the same season is also a regression.
  if (same_season) {
    vanished <- setdiff(names(pc), names(cc))
    if (length(vanished)) broken <- c(broken, sprintf("%s (vanished from data_cutoff)", vanished))
  }
  add("no source regressed vs a previously-achieved cutoff (BROKEN_OR_MISSING_DATA)",
      if (length(broken) == 0) PASS else FAIL,
      if (length(broken)) paste(broken, collapse = "; ") else "")
  add("sources behind through_week are flagged EXPECTED_SOURCE_LAG (informational)",
      PASS, if (length(lagging)) paste(lagging, collapse = "; ") else "all sources at through_week")
}

# ---------------------------------------------------------------------------
# GATE 5 — output integrity per served file
# ---------------------------------------------------------------------------
cand_csv <- setNames(lapply(SERVED_FILES, function(f) read_csv_safe(CAND, f)), SERVED_FILES)

for (f in REQUIRED_NONEMPTY) {
  d <- cand_csv[[f]]
  add(sprintf("%s is present and non-empty", f), if (!is.null(d) && nrow(d) > 0) PASS else FAIL,
      if (is.null(d)) "file missing" else sprintf("%d rows", nrow(d)))
}

tp <- cand_csv[["team_profile.csv"]]
if (!is.null(tp) && nrow(tp) > 0) {
  need_cols <- c("team", "side", "metric", "output_class", "raw", "modeled", "confidence")
  add("team_profile.csv has the required columns", if (all(need_cols %in% names(tp))) PASS else FAIL,
      paste("missing:", paste(setdiff(need_cols, names(tp)), collapse = ", ")))

  expected_teams <- if (!is.null(pub_manifest)) {
    pt <- read_csv_safe(PUB, "team_profile.csv")
    if (!is.null(pt)) sort(unique(pt$team)) else NULL
  } else NULL
  cand_teams <- sort(unique(tp$team))
  if (!is.null(expected_teams)) {
    missing_teams <- setdiff(expected_teams, cand_teams)
    add("no expected NFL team disappeared from team_profile.csv",
        if (length(missing_teams) == 0) PASS else FAIL,
        if (length(missing_teams)) paste(missing_teams, collapse = ", ") else sprintf("%d teams", length(cand_teams)))
  } else {
    add("team_profile.csv team-count sanity (first publish)",
        if (length(cand_teams) == 32) PASS else FAIL, sprintf("%d teams", length(cand_teams)))
  }

  dupe_key <- tp %>% count(team, side, metric) %>% filter(n > 1)
  add("team_profile.csv has no duplicate (team, side, metric) rows",
      if (nrow(dupe_key) == 0) PASS else FAIL,
      if (nrow(dupe_key)) sprintf("%d duplicate keys, e.g. %s/%s/%s", nrow(dupe_key), dupe_key$team[1], dupe_key$side[1], dupe_key$metric[1]) else "")

  non_finite <- tp %>% filter(!is.na(modeled) & !is.finite(modeled))
  add("team_profile.csv has no non-finite modeled values", if (nrow(non_finite) == 0) PASS else FAIL,
      if (nrow(non_finite)) sprintf("%d rows", nrow(non_finite)) else "")

  na_by_metric <- tp %>% group_by(metric) %>% summarise(frac_na = mean(is.na(modeled)), .groups = "drop") %>%
    filter(frac_na >= 1)
  add("no metric is all-NA across every team (fabricated-empty guard)",
      if (nrow(na_by_metric) == 0) PASS else FAIL,
      if (nrow(na_by_metric)) paste(na_by_metric$metric, collapse = ", ") else "")
}

pu <- cand_csv[["player_usage_profile.csv"]]
if (!is.null(pu) && nrow(pu) > 0) {
  dupe_key <- pu %>% count(gsis_id, metric) %>% filter(n > 1)
  add("player_usage_profile.csv has no duplicate (gsis_id, metric) rows",
      if (nrow(dupe_key) == 0) PASS else FAIL, if (nrow(dupe_key)) sprintf("%d duplicate keys", nrow(dupe_key)) else "")
}

ctx <- cand_csv[["contextual_matchup_feature.csv"]]
if (!is.null(ctx) && nrow(ctx) > 0) {
  dupe_key <- ctx %>% count(feature, offense_team, defense_team) %>% filter(n > 1)
  add("contextual_matchup_feature.csv has no duplicate (feature, offense, defense) rows",
      if (nrow(dupe_key) == 0) PASS else FAIL, if (nrow(dupe_key)) sprintf("%d duplicate keys", nrow(dupe_key)) else "")
}

# ---------------------------------------------------------------------------
# GATE 6 — catastrophic structural-change guard vs currently published
# ---------------------------------------------------------------------------
if (!is.na(PUB) && dir.exists(PUB)) {
  for (f in REQUIRED_NONEMPTY) {
    cd <- cand_csv[[f]]
    pd <- read_csv_safe(PUB, f)
    if (is.null(cd) || is.null(pd) || nrow(pd) == 0) next
    ratio <- nrow(cd) / nrow(pd)
    ok <- ratio >= 0.5 && ratio <= 2.0
    add(sprintf("%s row count within sane bounds of published (0.5x-2.0x)", f),
        if (ok) PASS else FAIL, sprintf("published=%d candidate=%d ratio=%.2f", nrow(pd), nrow(cd), ratio))
  }
}

# ---------------------------------------------------------------------------
# summarize
# ---------------------------------------------------------------------------
overall <- if (any(vapply(results, function(r) r$status == FAIL, logical(1)))) "FAIL" else "PASS"
summary_obj <- list(
  overall = overall,
  candidate = list(season = cand_manifest$season, through_week = cand_manifest$through_week,
                    version = cand_manifest$football_intelligence_version),
  published = if (!is.null(pub_manifest))
    list(season = pub_manifest$season, through_week = pub_manifest$through_week,
         version = pub_manifest$football_intelligence_version) else NULL,
  gates = results
)
write(jsonlite::toJSON(summary_obj, auto_unbox = TRUE, pretty = TRUE, null = "null"),
      file.path(CAND, "validation_result.json"))

cat(sprintf("\nvalidation: %s  (%d gates, %d failed)\n", overall,
            length(results), sum(vapply(results, function(r) r$status == FAIL, logical(1)))))
quit(status = if (overall == "FAIL") 1 else 0)
