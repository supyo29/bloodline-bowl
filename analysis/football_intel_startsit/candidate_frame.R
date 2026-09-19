# ===========================================================================
# Phase 3.5A Checkpoint F — candidate evidence frame + admissibility assertions.
#
# A candidate (ri-startsit-2026.2+) is evaluated ONLY on genuine pre-kickoff evidence:
#   baseline = the production projection CAPTURED before kickoff (LIVE_CAPTURED),
#   actual   = the outcome enrichment recorded later, in the SAME scoring fingerprint.
# Sleeper history baselines (revised / post-hoc) and the trailing control never enter the frame.
# ===========================================================================

suppressWarnings(suppressMessages({ library(jsonlite) }))
`%||%` <- function(a, b) if (is.null(a) || length(a) == 0) b else a

#' @param records list of capture records (as parsed from the store)
#' @param outcomes list of outcome records: capture_id, scoring_fingerprint, actual_fantasy_points (named)
build_candidate_frame <- function(records, outcomes) {
  excluded <- list(not_live_captured = 0L, no_outcome = 0L, scoring_mismatch = 0L, no_baseline = 0L)
  by_cap <- setNames(outcomes, vapply(outcomes, function(o) o$capture_id, ""))
  rows <- list(); kinds_seen <- character(0)
  for (r in records) {
    kinds_seen <- c(kinds_seen, r$capture_kind)
    if (!identical(r$capture_kind, "LIVE_CAPTURED")) { excluded$not_live_captured <- excluded$not_live_captured + 1L; next }
    o <- by_cap[[r$capture_id]]
    if (is.null(o)) { excluded$no_outcome <- excluded$no_outcome + 1L; next }
    if (!identical(o$scoring_fingerprint, r$scoring_fingerprint) || is.null(r$scoring_fingerprint)) {
      excluded$scoring_mismatch <- excluded$scoring_mismatch + 1L; next }
    for (a in r$adjustments) {
      act <- o$actual_fantasy_points[[a$canonical_player_id]]
      if (is.null(act) || is.null(a$baseline_projection) || is.na(a$baseline_projection)) {
        excluded$no_baseline <- excluded$no_baseline + 1L; next }
      rows[[length(rows) + 1]] <- data.frame(
        capture_id = r$capture_id, decision_timestamp = r$decision_timestamp, week = as.integer(r$week),
        scoring_fp = r$scoring_fingerprint, model_version = r$start_sit_model_version,
        baseline_version = r$baseline_projection_version, position = a$position, player_id = a$canonical_player_id,
        base = as.numeric(a$baseline_projection), fi_adj = as.numeric(a$expected_adjustment),
        actual = as.numeric(act), stringsAsFactors = FALSE)
    }
  }
  frame <- if (length(rows)) do.call(rbind, rows) else data.frame()
  if (nrow(frame)) {  # one row per (scoring, week, player): the EARLIEST captured decision
    frame <- frame[order(frame$decision_timestamp), ]
    frame <- frame[!duplicated(paste(frame$scoring_fp, frame$week, frame$player_id)), ]
  }
  list(frame = frame, provenance = list(
    baseline_source = "LIVE_CAPTURED_PRE_KICKOFF", capture_kinds_used = "LIVE_CAPTURED",
    target = CANDIDATE_TARGET, scoring_fingerprint_match = TRUE,
    weeks = sort(unique(frame$week)), model_versions = sort(unique(frame$model_version)),
    baseline_versions = sort(unique(frame$baseline_version)),
    kinds_in_input = as.list(table(kinds_seen)), excluded = excluded,
    discontinuity_mode = "AS_OF", unsafe_features_excluded = list("offensive_coord_change", "defensive_coord_change")))
}

#' Every reason a candidate run must be refused. Empty character vector => admissible.
candidate_admissibility_failures <- function(prov, manifest, registry_path = NULL, design_families = character(0),
                                             reality_weeks = NULL) {
  bad <- character(0)
  if (!identical(prov$baseline_source, "LIVE_CAPTURED_PRE_KICKOFF"))
    bad <- c(bad, "baseline is not a captured pre-kickoff production baseline (post-hoc/revised projections are refused)")
  if (!identical(prov$capture_kinds_used, "LIVE_CAPTURED")) bad <- c(bad, "evidence includes non-LIVE_CAPTURED classes")
  if (!identical(prov$target, CANDIDATE_TARGET)) bad <- c(bad, "residual target is not actual - captured production baseline")
  if (!isTRUE(prov$scoring_fingerprint_match)) bad <- c(bad, "capture/outcome scoring fingerprints not matched")
  if (!identical(prov$discontinuity_mode, "AS_OF")) bad <- c(bad, "discontinuity flags are not chronology-safe (AS_OF)")
  if (!all(c("offensive_coord_change", "defensive_coord_change") %in% unlist(prov$unsafe_features_excluded)))
    bad <- c(bad, "UNSAFE_FOR_BACKTEST discontinuity features were not excluded")
  if (length(prov$model_versions) != 1) bad <- c(bad, "evidence mixes (or lacks) shadow model versions")
  if (length(prov$baseline_versions) != 1) bad <- c(bad, "evidence mixes (or lacks) production baseline versions")
  # evidence gate
  if (is.null(manifest) || !isTRUE(manifest$reevaluation_eligible) || is.null(manifest$evidence_gate_version))
    bad <- c(bad, "evidence gate is not ELIGIBLE with per-week evidence")
  else {
    listed <- unlist(manifest$completed_fi_week_list)
    if (length(listed) < manifest$minimum_weeks_required) bad <- c(bad, "insufficient current-season evidence weeks")
    if (!all(prov$weeks %in% listed)) bad <- c(bad, "frame uses weeks that did not pass the evidence gate")
    for (w in prov$weeks) {
      e <- Filter(function(x) identical(as.integer(x$week), as.integer(w)), manifest$week_evidence)
      if (!length(e) || !isTRUE(e[[1]]$counts) || !all(unlist(e[[1]]$predicates))) bad <- c(bad, sprintf("week %d lacks full per-week evidence", w))
    }
  }
  if (!is.null(reality_weeks)) for (w in prov$weeks) {
    r <- Filter(function(x) identical(as.integer(x$week), as.integer(w)), reality_weeks)
    if (!length(r) || !identical(r[[1]]$state, "COMPLETE")) bad <- c(bad, sprintf("week %d is not a COMPLETE NFL week", w))
  }
  if (!is.null(registry_path) && file.exists(registry_path)) {
    reg <- fromJSON(registry_path, simplifyVector = FALSE)
    banned <- unlist(lapply(Filter(function(f) !isTRUE(f$historical_backtest_allowed), reg$features), function(f) f$family))
    hit <- intersect(design_families, banned)
    if (length(hit)) bad <- c(bad, paste("design uses features barred from backtests:", paste(hit, collapse = ", ")))
  }
  bad
}

assert_candidate_admissible <- function(...) {
  bad <- candidate_admissibility_failures(...)
  if (length(bad)) stop("CANDIDATE REFUSED (fail closed): ", paste(bad, collapse = " | "))
  invisible(TRUE)
}
