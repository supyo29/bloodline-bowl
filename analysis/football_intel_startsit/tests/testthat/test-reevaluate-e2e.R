# Phase 3.5A Checkpoint F: run the REAL reevaluate.R end-to-end in a throwaway sandbox (no .git) with synthetic
# evidence, proving the future re-evaluation path (a) uses the corrected gate semantics and (b) fails closed.
suppressWarnings(suppressMessages({ library(jsonlite) }))
ROOT <- Sys.getenv("FI_ROOT")
run_sandbox <- function(manifest, records, outcomes, reality = NULL) {
  sb <- tempfile("ssbox"); dir.create(file.path(sb, "analysis"), recursive = TRUE)
  file.copy(file.path(ROOT, "analysis", "football_intel_startsit"), file.path(sb, "analysis"), recursive = TRUE)
  unlink(file.path(sb, "analysis", "football_intel_startsit", "cache"), recursive = TRUE)
  unlink(file.path(sb, "analysis", "football_intel_startsit", "tests"), recursive = TRUE)
  dir.create(file.path(sb, "lib", "weekly", "data"), recursive = TRUE); dir.create(file.path(sb, "outputs", "startsit-2026"), recursive = TRUE)
  model_before <- '{"start_sit_model_version":"ri-startsit-2026.1"}'
  writeLines(model_before, file.path(sb, "lib", "weekly", "data", "start_sit_model.json"))
  write(toJSON(manifest, auto_unbox = TRUE, null = "null"), file.path(sb, "lib", "weekly", "data", "start_sit_reevaluation_manifest.json"))
  write(toJSON(records, auto_unbox = TRUE, null = "null"), file.path(sb, "outputs", "startsit-2026", "captured_records.json"))
  write(toJSON(outcomes, auto_unbox = TRUE, null = "null"), file.path(sb, "outputs", "startsit-2026", "captured_outcomes.json"))
  if (!is.null(reality)) write(toJSON(list(available = TRUE, weeks = reality), auto_unbox = TRUE), file.path(sb, "outputs", "startsit-2026", "nfl_week_completion.json"))
  Sys.setenv(FI_ROOT = sb, SS_TEST_MANIFEST_AS_IS = "1")
  on.exit(Sys.setenv(FI_ROOT = ROOT), add = TRUE); on.exit(Sys.unsetenv("SS_TEST_MANIFEST_AS_IS"), add = TRUE)
  log <- suppressWarnings(system2("Rscript", shQuote(file.path(sb, "analysis", "football_intel_startsit", "reevaluate.R")), stdout = TRUE, stderr = TRUE))
  list(sb = sb, log = paste(log, collapse = "\n"),
       man = fromJSON(file.path(sb, "lib", "weekly", "data", "start_sit_reevaluation_manifest.json"), simplifyVector = FALSE),
       model_after = readLines(file.path(sb, "lib", "weekly", "data", "start_sit_model.json")), model_before = model_before,
       report = file.path(sb, "outputs", "startsit-2026", "candidate_gate_report.json"))
}
manifest <- function(weeks = 3:6, eligible = TRUE) list(season = 2026, reevaluation_eligible = eligible, reevaluation_status = if (eligible) "ELIGIBLE" else "NOT_ELIGIBLE",
  evidence_gate_version = "evidence-gate-2026.2", minimum_weeks_required = 4, cadence = list(first_check_week = 4, second_check_week = 6, thereafter_every_weeks = 3),
  completed_fi_week_list = as.list(weeks), next_candidate_version = "ri-startsit-2026.2", not_eligible_reason = "n/a",
  week_evidence = lapply(weeks, function(w) list(week = w, counts = TRUE, predicates = list(NFL_WEEK_COMPLETE = TRUE, ACTUALS_AVAILABLE = TRUE))))
mk_recs <- function(weeks, base_ver = "ri-structural-2026.3", n = 6) {
  set.seed(9)
  lapply(weeks, function(w) list(capture_id = paste0("c", w), capture_kind = "LIVE_CAPTURED", week = w, scoring_fingerprint = "scoring:v1:a",
    start_sit_model_version = "ri-startsit-2026.1", baseline_projection_version = if (w == max(weeks)) base_ver else "ri-structural-2026.3",
    decision_timestamp = sprintf("2026-10-%02dT15:00:00Z", w),
    adjustments = lapply(seq_len(n), function(i) list(canonical_player_id = paste0("p", i), position = "RB", baseline_projection = 8 + i, expected_adjustment = runif(1, -.5, .5)))))
}
mk_outs <- function(weeks, n = 6) lapply(weeks, function(w) list(capture_id = paste0("c", w), scoring_fingerprint = "scoring:v1:a",
  actual_fantasy_points = setNames(as.list(runif(n, 3, 25)), paste0("p", seq_len(n)))))
reality <- function(weeks = 3:6, state = "COMPLETE") lapply(weeks, function(w) list(week = w, state = state, scheduled = 16, completed = 16))

test_that("valid evidence: evaluates ONE gate identity on the production baseline; fits nothing, writes no model, never PASSED", {
  r <- run_sandbox(manifest(), mk_recs(3:6), mk_outs(3:6), reality())
  expect_true(file.exists(r$report), info = r$log)
  rep <- fromJSON(r$report, simplifyVector = FALSE); id <- rep$gate_identity
  expect_equal(id$tuned_on_baseline, "PRODUCTION_CAPTURED"); expect_equal(id$evaluated_baseline, "PRODUCTION_CAPTURED")
  expect_equal(id$tuned_tau, id$evaluated_tau); expect_equal(id$tuned_cap, id$evaluated_cap)
  expect_false(id$control_used_for_selection); expect_equal(unlist(id$tune_weeks), 3:4); expect_equal(unlist(id$eval_weeks), 5:6)
  expect_equal(r$man$reevaluation_status, "ELIGIBLE"); expect_match(r$man$candidate_fit, "NOT_PERFORMED")
  expect_identical(r$model_after, r$model_before)                      # served artifact untouched
  expect_null(r$man$per_position_verdict)
})

test_that("post-hoc / mixed production baseline versions are refused (fail closed)", {
  r <- run_sandbox(manifest(), mk_recs(3:6, base_ver = "sleeper-hist-revised"), mk_outs(3:6), reality())
  expect_equal(r$man$reevaluation_status, "FAILED"); expect_match(r$man$reevaluation_failure_reason, "mixes")
  expect_false(file.exists(r$report)); expect_identical(r$model_after, r$model_before)
})

test_that("an incomplete NFL week is refused even if the manifest claims it", {
  rw <- reality(); rw[[3]]$state <- "PARTIAL"
  r <- run_sandbox(manifest(), mk_recs(3:6), mk_outs(3:6), rw)
  expect_equal(r$man$reevaluation_status, "FAILED"); expect_match(r$man$reevaluation_failure_reason, "not a COMPLETE NFL week")
})

test_that("insufficient current-season evidence: dormant, nothing evaluated", {
  r <- run_sandbox(manifest(3:5, eligible = FALSE), mk_recs(3:5), mk_outs(3:5), reality(3:5))
  expect_match(r$log, "NOT_ELIGIBLE"); expect_false(file.exists(r$report)); expect_equal(r$man$reevaluation_status, "NOT_ELIGIBLE")
})

test_that("manifest claiming eligibility with too few evidenced weeks is refused", {
  r <- run_sandbox(manifest(3:5), mk_recs(3:5), mk_outs(3:5), reality(3:5))
  expect_equal(r$man$reevaluation_status, "FAILED"); expect_match(r$man$reevaluation_failure_reason, "insufficient")
})

test_that("missing captured evidence export fails closed", {
  r <- run_sandbox(manifest(), list(), list(), reality())
  expect_equal(r$man$reevaluation_status, "FAILED")
})
