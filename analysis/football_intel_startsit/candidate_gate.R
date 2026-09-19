# ===========================================================================
# Phase 3.5A Checkpoint F (D10) — candidate gate methodology for ri-startsit-2026.2+.
#
# ROOT CAUSE (D10). backtest.R tuned (tau, cap) on the naive trailing-PPG control, folded THOSE into
# the served model, then reported "vs Sleeper" using a second, separately tuned gate (tau .5, cap .08).
# The gate that ships (3 / .25) was never the gate evaluated against a production-like baseline, and a gate
# tuned on a control was implicitly offered as evidence of production value.
#
# CORRECTED SEMANTICS (one unambiguous answer). For a candidate:
#   * (tau, cap) are SELECTED on PRODUCTION_CAPTURED pairs only, from the EARLIER eligible weeks;
#   * they are EVALUATED, with the IDENTICAL (tau, cap), on the LATER held-out weeks, against the SAME baseline;
#   * the trailing-PPG control is REPORTED at that same served gate; it never selects or certifies anything;
#   * the two baselines are never blended; identity is recorded in `gate_identity` and asserted.
# `tau = 0` (never reverse) is always in the grid, so "no gate helps" is a legal, honest outcome.
#
# The pair/gate math is the frozen backtest.R apply_gate (a test proves equivalence); it is repeated here
# only because backtest.R runs on source.
# ===========================================================================

suppressWarnings(suppressMessages({ library(dplyr) }))

GATE_METHOD_VERSION <- "candidate-gate-method-2026.1"
PRODUCTION_BASELINE <- "PRODUCTION_CAPTURED"
CONTROL_BASELINE    <- "TRAILING_PPG"
CANDIDATE_TARGET    <- "actual_points - production_baseline_captured_pre_kickoff"

gate_apply <- function(pairs, tau, max_frac) {
  pairs %>% mutate(
    adj_a_c = pmax(pmin(adj_a, max_frac * abs(base_a)), -max_frac * abs(base_a)),
    adj_b_c = pmax(pmin(adj_b, max_frac * abs(base_b)), -max_frac * abs(base_b)),
    cand_edge_g = base_edge + (adj_a_c - adj_b_c),
    fi_pick = ifelse(abs_edge < tau, ifelse(cand_edge_g >= 0, "a", "b"), base_pick),
    reversal = fi_pick != base_pick,
    base_correct = base_pick == act_winner,
    fi_correct = fi_pick == act_winner,
    base_points = ifelse(base_pick == "a", act_a, act_b),
    fi_points = ifelse(fi_pick == "a", act_a, act_b),
    delta_points = fi_points - base_points)
}

gate_summ <- function(g) {
  rev <- g[g$reversal, , drop = FALSE]
  data.frame(
    n = nrow(g), n_reversals = nrow(rev),
    rev_win_rate = if (nrow(rev)) mean(rev$fi_correct) else NA_real_,
    rev_mean_delta = if (nrow(rev)) mean(rev$delta_points) else NA_real_,
    total_delta_points = sum(g$delta_points),
    rev_large_loss_rate = if (nrow(rev)) mean(rev$delta_points <= -5) else NA_real_,
    rev_large_win_rate = if (nrow(rev)) mean(rev$delta_points >= 5) else NA_real_)
}

# pairs from a frame with columns week, position, player_id, base (baseline), fi_adj, actual
gate_pairs <- function(frame) {
  frame <- frame[is.finite(frame$base) & is.finite(frame$actual), , drop = FALSE]
  # pairs are only formed within one (week, position, scoring fingerprint): points under different scoring are incomparable
  grp <- paste(frame$week, frame$position, if ("scoring_fp" %in% names(frame)) frame$scoring_fp else "")
  out <- list()
  for (key in unique(grp)) {
    g <- frame[grp == key, , drop = FALSE]
    if (nrow(g) < 2) next
    idx <- t(combn(nrow(g), 2))
    out[[length(out) + 1]] <- data.frame(
      week = g$week[1], position = g$position[1], a = g$player_id[idx[, 1]], b = g$player_id[idx[, 2]],
      base_a = g$base[idx[, 1]], base_b = g$base[idx[, 2]], adj_a = g$fi_adj[idx[, 1]], adj_b = g$fi_adj[idx[, 2]],
      act_a = g$actual[idx[, 1]], act_b = g$actual[idx[, 2]], stringsAsFactors = FALSE)
  }
  if (!length(out)) return(NULL)
  p <- do.call(rbind, out)
  p$base_edge <- p$base_a - p$base_b
  p$base_pick <- ifelse(p$base_edge >= 0, "a", "b")
  p$act_winner <- ifelse(p$act_a >= p$act_b, "a", "b")
  p$abs_edge <- abs(p$base_edge)
  p
}

#' Select (tau, cap) on PRODUCTION pairs from the tune weeks only.
gate_select <- function(prod_tune_pairs, tau_grid, cap_grid) {
  stopifnot(!is.null(prod_tune_pairs), nrow(prod_tune_pairs) > 0)
  grid <- expand.grid(tau = unique(c(0, tau_grid)), cap = cap_grid)
  grid$obj <- vapply(seq_len(nrow(grid)), function(i)
    gate_summ(gate_apply(prod_tune_pairs, grid$tau[i], grid$cap[i]))$total_delta_points, 0)
  # maximise production point gain; ties -> the most conservative gate (smallest tau, then smallest cap)
  best <- grid[order(-grid$obj, grid$tau, grid$cap), ][1, ]
  list(tau = best$tau, cap = best$cap, objective_total_delta_points = best$obj, grid = grid)
}

#' The single record answering: what gate was tuned, on what baseline, and what exact gate was evaluated?
candidate_gate_report <- function(prod_pairs, control_pairs, tune_weeks, eval_weeks, tau_grid, cap_grid) {
  pt <- prod_pairs[prod_pairs$week %in% tune_weeks, , drop = FALSE]
  pe <- prod_pairs[prod_pairs$week %in% eval_weeks, , drop = FALSE]
  sel <- gate_select(pt, tau_grid, cap_grid)
  ev_prod <- gate_summ(gate_apply(pe, sel$tau, sel$cap))
  ctl <- if (!is.null(control_pairs))
    gate_summ(gate_apply(control_pairs[control_pairs$week %in% eval_weeks, , drop = FALSE], sel$tau, sel$cap)) else NULL
  id <- list(
    method_version = GATE_METHOD_VERSION,
    tuned_on_baseline = PRODUCTION_BASELINE, tune_weeks = sort(tune_weeks),
    tuned_tau = sel$tau, tuned_cap = sel$cap,
    evaluated_baseline = PRODUCTION_BASELINE, eval_weeks = sort(eval_weeks),
    evaluated_tau = sel$tau, evaluated_cap = sel$cap,
    control_baseline = CONTROL_BASELINE, control_evaluated_at_tau = sel$tau, control_evaluated_at_cap = sel$cap,
    control_used_for_selection = FALSE, target = CANDIDATE_TARGET)
  assert_gate_identity(id)
  list(gate_identity = id, production_eval = ev_prod, control_eval_at_same_gate = ctl,
       selection_objective_total_delta_points = sel$objective_total_delta_points)
}

#' Hard assertions; stops on any violation. Returns TRUE invisibly.
assert_gate_identity <- function(id) {
  bad <- character(0)
  if (!identical(id$tuned_on_baseline, PRODUCTION_BASELINE)) bad <- c(bad, "gate not tuned on the production baseline")
  if (!identical(id$evaluated_baseline, id$tuned_on_baseline)) bad <- c(bad, "evaluated baseline differs from tuned baseline")
  if (!isTRUE(all.equal(id$tuned_tau, id$evaluated_tau)) || !isTRUE(all.equal(id$tuned_cap, id$evaluated_cap)))
    bad <- c(bad, "evaluated (tau, cap) differs from tuned (tau, cap)")
  if (!isTRUE(all.equal(id$tuned_tau, id$control_evaluated_at_tau)) || !isTRUE(all.equal(id$tuned_cap, id$control_evaluated_at_cap)))
    bad <- c(bad, "control not evaluated at the served gate")
  if (!identical(id$control_used_for_selection, FALSE)) bad <- c(bad, "control baseline participated in gate selection")
  if (length(intersect(id$tune_weeks, id$eval_weeks)) > 0) bad <- c(bad, "tune and eval weeks overlap")
  if (length(id$tune_weeks) == 0 || length(id$eval_weeks) == 0) bad <- c(bad, "empty tune or eval weeks")
  else if (max(id$tune_weeks) >= min(id$eval_weeks)) bad <- c(bad, "eval weeks are not strictly after tune weeks (chronology)")
  if (length(bad)) stop("GATE IDENTITY VIOLATION: ", paste(bad, collapse = "; "))
  invisible(TRUE)
}

#' Chronological split of the eligible weeks: earlier half tunes, later half evaluates (>=1 each).
split_weeks <- function(weeks) {
  w <- sort(unique(weeks)); n <- length(w)
  if (n < 2) stop("need >= 2 eligible weeks to split tune/eval")
  k <- max(1L, floor(n / 2))
  list(tune = w[seq_len(k)], eval = w[(k + 1L):n])
}
