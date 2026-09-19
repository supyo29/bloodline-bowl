# Phase 3.5A Checkpoint F (D10 + re-evaluation safety). Pure / synthetic.
suppressWarnings(suppressMessages({ library(dplyr) }))
ROOT <- Sys.getenv("FI_ROOT"); SSDIR <- file.path(ROOT, "analysis", "football_intel_startsit")
source(file.path(SSDIR, "candidate_gate.R")); source(file.path(SSDIR, "candidate_frame.R"))

mk_frame <- function(weeks = 1:6, n = 8, seed = 1, adj_skill = 0) {
  set.seed(seed)
  do.call(rbind, lapply(weeks, function(w) data.frame(
    week = w, position = "RB", scoring_fp = "scoring:v1:a", player_id = paste0("p", seq_len(n)),
    base = runif(n, 5, 15), stringsAsFactors = FALSE))) %>%
    mutate(actual = base + rnorm(n(), 0, 4), fi_adj = adj_skill * (actual - base) + rnorm(n(), 0, .5))
}
pairs <- function(f) gate_pairs(f) %>% mutate(bucket = "x")

test_that("gate_apply equals the frozen backtest.R apply_gate (same math, no drift)", {
  src <- parse(file.path(SSDIR, "backtest.R"))
  def <- Filter(function(e) is.call(e) && identical(as.character(e[[1]]), "<-") && identical(as.character(e[[2]]), "apply_gate"), src)[[1]]
  frozen <- eval(def[[3]])
  p <- pairs(mk_frame())
  for (g in list(c(0, .08), c(1, .12), c(3, .25))) {
    a <- frozen(p, g[1], g[2]); b <- gate_apply(p, g[1], g[2])
    expect_equal(a$fi_pick, b$fi_pick); expect_equal(a$delta_points, b$delta_points)
  }
})

test_that("selection uses PRODUCTION pairs only; the same (tau,cap) is evaluated; identity is asserted", {
  f <- mk_frame(adj_skill = 0.8); p <- gate_pairs(f)
  r <- candidate_gate_report(p, NULL, tune_weeks = 1:3, eval_weeks = 4:6, tau_grid = c(.5, 1, 3), cap_grid = c(.08, .25))
  id <- r$gate_identity
  expect_equal(id$tuned_on_baseline, "PRODUCTION_CAPTURED"); expect_equal(id$evaluated_baseline, "PRODUCTION_CAPTURED")
  expect_equal(id$tuned_tau, id$evaluated_tau); expect_equal(id$tuned_cap, id$evaluated_cap)
  expect_false(id$control_used_for_selection)
  # the evaluated row really is the identical gate applied to eval weeks
  manual <- gate_summ(gate_apply(p[p$week %in% 4:6, ], id$evaluated_tau, id$evaluated_cap))
  expect_equal(r$production_eval, manual)
})

test_that("the trailing control cannot select the gate: selection ignores control pairs entirely", {
  f <- mk_frame(adj_skill = 0.8); p <- gate_pairs(f)
  ctl_good <- p; ctl_good$adj_a <- ctl_good$adj_b <- 0   # wildly different control data
  a <- candidate_gate_report(p, NULL, 1:3, 4:6, c(.5, 1, 3), c(.08, .25))
  b <- candidate_gate_report(p, ctl_good, 1:3, 4:6, c(.5, 1, 3), c(.08, .25))
  expect_equal(a$gate_identity$tuned_tau, b$gate_identity$tuned_tau); expect_equal(a$gate_identity$tuned_cap, b$gate_identity$tuned_cap)
  expect_equal(b$gate_identity$control_evaluated_at_tau, b$gate_identity$tuned_tau)   # control shown at the SERVED gate
})

test_that("a harmful FI signal yields the no-reversal gate (tau=0), never a spuriously 'useful' one", {
  f <- mk_frame(adj_skill = -1.5, seed = 4)              # adjustments anti-predict the outcome
  r <- candidate_gate_report(gate_pairs(f), NULL, 1:3, 4:6, c(.5, 1, 3), c(.08, .25))
  expect_equal(r$gate_identity$tuned_tau, 0); expect_equal(r$production_eval$n_reversals, 0L)
})

good_id <- function() candidate_gate_report(gate_pairs(mk_frame(adj_skill = .8)), NULL, 1:3, 4:6, c(.5, 1, 3), c(.08, .25))$gate_identity
test_that("assert_gate_identity fails closed on every violation", {
  id <- good_id(); expect_true(assert_gate_identity(id))
  m <- function(...) { x <- id; for (k in names(list(...))) x[[k]] <- list(...)[[k]]; x }
  expect_error(assert_gate_identity(m(tuned_on_baseline = "TRAILING_PPG")), "production baseline")
  expect_error(assert_gate_identity(m(evaluated_baseline = "SLEEPER_HISTORY")), "evaluated baseline differs")
  expect_error(assert_gate_identity(m(evaluated_tau = 0.5, tuned_tau = 3)), "differs from tuned")
  expect_error(assert_gate_identity(m(evaluated_cap = 0.08, tuned_cap = 0.25)), "differs from tuned")
  expect_error(assert_gate_identity(m(control_evaluated_at_tau = 99)), "control not evaluated at the served gate")
  expect_error(assert_gate_identity(m(control_used_for_selection = TRUE)), "participated")
  expect_error(assert_gate_identity(m(tune_weeks = 1:4, eval_weeks = 4:6)), "overlap")
  expect_error(assert_gate_identity(m(tune_weeks = 3:4, eval_weeks = 1:2)), "chronology")
  expect_error(assert_gate_identity(m(eval_weeks = integer(0))), "empty")
})

# ----- candidate frame + admissibility -----
rec <- function(id, kind = "LIVE_CAPTURED", week = 3, fp = "scoring:v1:a", model = "ri-startsit-2026.1", base = "ri-structural-2026.3", ts = "2026-10-04T15:00:00Z")
  list(capture_id = id, capture_kind = kind, week = week, scoring_fingerprint = fp, start_sit_model_version = model,
       baseline_projection_version = base, decision_timestamp = ts,
       adjustments = list(list(canonical_player_id = "p1", position = "RB", baseline_projection = 12, expected_adjustment = 0.3),
                          list(canonical_player_id = "p2", position = "RB", baseline_projection = 11.5, expected_adjustment = 0.9)))
out <- function(id, fp = "scoring:v1:a") list(capture_id = id, scoring_fingerprint = fp, actual_fantasy_points = list(p1 = 10, p2 = 14))
manifest_ok <- function(weeks = 3:6) list(reevaluation_eligible = TRUE, evidence_gate_version = "evidence-gate-2026.2",
  minimum_weeks_required = 4, completed_fi_week_list = as.list(weeks),
  week_evidence = lapply(weeks, function(w) list(week = w, counts = TRUE, predicates = list(A = TRUE, B = TRUE))))
reality_ok <- function(weeks = 3:6) lapply(weeks, function(w) list(week = w, state = "COMPLETE"))
frame_for <- function(weeks = 3:6, ...) build_candidate_frame(lapply(weeks, function(w) rec(paste0("c", w), week = w, ...)),
                                                              lapply(weeks, function(w) out(paste0("c", w))))

test_that("frame keeps ONLY LIVE_CAPTURED with matching-scoring outcomes; everything else is excluded and counted", {
  recs <- list(rec("a"), rec("b", kind = "LIVE_POST_LOCK"), rec("c", kind = "HISTORICALLY_RECONSTRUCTED"),
               rec("d", kind = "LIVE_UNVERIFIED"), rec("e"), rec("f", fp = "scoring:v1:other"))
  outs <- list(out("a"), out("b"), out("c"), out("d"), out("f", fp = "scoring:v1:a"))   # e: no outcome; f: fp mismatch
  b <- build_candidate_frame(recs, outs)
  expect_equal(unique(b$frame$capture_id), "a")
  expect_equal(b$provenance$excluded$not_live_captured, 3L); expect_equal(b$provenance$excluded$no_outcome, 1L)
  expect_equal(b$provenance$excluded$scoring_mismatch, 1L)
})

test_that("admissible only when every safety property holds; each violation fails closed", {
  b <- frame_for(); prov <- b$provenance
  reg <- file.path(SSDIR, "candidate_v2_feature_registry.json")
  ok <- function(p = prov, m = manifest_ok(), rw = reality_ok(), fam = character(0)) candidate_admissibility_failures(p, m, reg, fam, rw)
  expect_length(ok(), 0)
  mod <- function(...) { x <- prov; a <- list(...); for (k in names(a)) x[[k]] <- a[[k]]; x }
  expect_match(paste(ok(mod(baseline_source = "SLEEPER_HISTORY")), collapse = "|"), "post-hoc")            # revised projections
  expect_match(paste(ok(mod(capture_kinds_used = c("LIVE_CAPTURED", "LIVE_POST_LOCK"))), collapse = "|"), "non-LIVE")
  expect_match(paste(ok(mod(target = "actual - baseline_trailing")), collapse = "|"), "residual target")
  expect_match(paste(ok(mod(scoring_fingerprint_match = FALSE)), collapse = "|"), "fingerprints")
  expect_match(paste(ok(mod(discontinuity_mode = "LEGACY_FULL_SEASON_V1_REPRODUCTION")), collapse = "|"), "chronology-safe")
  expect_match(paste(ok(mod(unsafe_features_excluded = list())), collapse = "|"), "UNSAFE_FOR_BACKTEST")
  expect_match(paste(ok(mod(model_versions = c("a", "b"))), collapse = "|"), "mixes")
  expect_match(paste(ok(m = NULL), collapse = "|"), "not ELIGIBLE")
  m <- manifest_ok(); m$reevaluation_eligible <- FALSE; expect_match(paste(ok(m = m), collapse = "|"), "not ELIGIBLE")
  expect_match(paste(ok(m = manifest_ok(3:5)), collapse = "|"), "insufficient")                              # 3 < 4 weeks
  expect_match(paste(ok(m = manifest_ok(3:5)), collapse = "|"), "did not pass the evidence gate")
  rw <- reality_ok(); rw[[2]]$state <- "PARTIAL"; expect_match(paste(ok(rw = rw), collapse = "|"), "not a COMPLETE NFL week")   # incomplete week
  expect_match(paste(ok(fam = c("discontinuity_flags_coordinators (offensive_coord_change / defensive_coord_change)")), collapse = "|"), "barred")
  # the old whole-season (leaking) entry no longer exists; the allowed as-of entry is NOT barred
  expect_length(ok(fam = c("discontinuity_flags_asof (head-coach / starting-QB / OL / front / secondary continuity)")), 0)
  expect_error(assert_candidate_admissible(mod(baseline_source = "SLEEPER_HISTORY"), manifest_ok(), reg, character(0), reality_ok()), "CANDIDATE REFUSED")
})

test_that("legacy scripts cannot write a candidate or reproduce v1 in the real repo; legacy discontinuity refused for candidates", {
  cfg <- paste(readLines(file.path(SSDIR, "config.R")), collapse = "\n")
  expect_match(cfg, "legacy trailing-baseline pipeline cannot produce a candidate")
  bd <- paste(readLines(file.path(SSDIR, "build_decision_dataset.R")), collapse = "\n")
  expect_match(bd, "legacy whole-season discontinuity construction leaks")
  expect_match(bd, "never from Sleeper history baselines")
  ev <- paste(readLines(file.path(SSDIR, "reevaluate.R")), collapse = "\n")
  expect_false(grepl("build_decision_dataset|train\\.R|backtest\\.R|finalize_model", gsub("#[^\n]*", "", ev)))
  expect_match(ev, "assert_candidate_admissible"); expect_match(ev, "candidate_gate_report")
})
