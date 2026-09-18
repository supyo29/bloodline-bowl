# ===========================================================================
# Injury -> Opportunity Propagation Intelligence -- Checkpoint C predictive
# model.
#
# Given a chronology-safe TRAINING slice of Checkpoint B's domain_accounting
# + beneficiary_observations (never the event being predicted, never a
# later week -- spec §30/§60), fit a small set of interpretable, decomposable
# allocators and apply each to a VALIDATION slice's events. No black-box
# model is fit here (see Checkpoint C report's "model candidates" section
# for the documented reason this checkpoint did not test a regularized/GBM
# candidate). No fantasy points, no TD outcomes, anywhere in this file --
# every input column traces back to Checkpoint B's opportunity-only fields.
#
# All five candidates share the same OUTPUT contract per
# (absence_event_id, domain, dimension, beneficiary_gsis_id):
#   pre_event_role, predicted_role, predicted_delta
# plus one team-level STRUCTURAL_RESIDUAL per (absence_event_id, domain,
# dimension) — vacated_opportunity minus the sum of predicted positive
# deltas (never forced to zero, spec §17).
# ===========================================================================

suppressWarnings(suppressMessages({ library(dplyr); library(data.table) }))

OPP$INHERITANCE_SHRINKAGE_K_TEAM <- 3    # team-specific evidence count at which team_rate gets ~half weight
OPP$INHERITANCE_SHRINKAGE_K_POSITION <- 6

.safe_div <- function(a, b) ifelse(is.na(a) | is.na(b) | b == 0, NA_real_, a / b)
.shrink <- function(specific_rate, n, prior, k) {
  ifelse(is.na(specific_rate) | n <= 0, prior, (n / (n + k)) * specific_rate + (k / (n + k)) * prior)
}

# ---------------------------------------------------------------------------
# fit_inheritance_priors(): hierarchical league -> position -> team
# inheritance rate per dimension, i.e. what fraction of the vacated share
# has historically been absorbed by IDENTIFIED beneficiaries (as opposed to
# structural residual) -- spec §26. Rows with a near-zero vacated_
# opportunity are excluded from FITTING this ratio (division noise -- a
# domain the absent player barely touched anyway), documented, never used
# for scoring at prediction time (the model still runs on every event).
# ---------------------------------------------------------------------------
fit_inheritance_priors <- function(domain_accounting_train, events_meta_train, min_vacated_for_rate = 0.02) {
  d <- as.data.table(domain_accounting_train)[as.data.table(events_meta_train), on = "absence_event_id",
        .(absence_event_id, domain, dimension, vacated_opportunity, identified_beneficiary_gain,
          team = i.team, position = i.position), nomatch = 0]
  d <- d[!is.na(vacated_opportunity) & abs(vacated_opportunity) >= min_vacated_for_rate]
  d[, ratio := pmin(pmax(.safe_div(identified_beneficiary_gain, vacated_opportunity), 0), 1.5)]

  league <- d[, .(league_rate = mean(ratio, na.rm = TRUE), n_league = .N), by = dimension]
  pos <- d[, .(position_rate = mean(ratio, na.rm = TRUE), n_position = .N), by = .(dimension, position)]
  pos <- merge(pos, league, by = "dimension", all.x = TRUE)
  pos[, position_rate_blended := .shrink(position_rate, n_position, league_rate, OPP$INHERITANCE_SHRINKAGE_K_POSITION)]

  team <- d[, .(team_rate = mean(ratio, na.rm = TRUE), n_team = .N), by = .(dimension, team, position)]
  team <- merge(team, pos[, .(dimension, position, position_rate_blended)], by = c("dimension", "position"), all.x = TRUE)
  team[, team_rate_blended := .shrink(team_rate, n_team, position_rate_blended, OPP$INHERITANCE_SHRINKAGE_K_TEAM)]

  list(league = league, position = pos[, .(dimension, position, position_rate_blended)],
       team = team[, .(dimension, team, position, team_rate_blended, n_team)])
}

# NOTE: parameters are named .dim/.team/.pos, NOT dimension/team/position --
# priors$team/$position/$league are data.table objects whose OWN columns
# are literally named dimension/team/position. `priors$team[priors$team$
# dimension == dimension, ]` looks safe (fully qualified on the left) but
# is NOT: data.table's `[.data.table` evaluates the `i` condition with the
# table's own columns in scope for EVERY bare symbol, including the
# right-hand `dimension` -- so the comparison silently became `priors$
# team$dimension == priors$team$dimension` (always TRUE, self-referential),
# exactly the Checkpoint B NSE bug recurring in a new file. Measured
# effect: this function always fell through to the 0.5 default for every
# call, so Baseline 3 / Candidate 4's backtest runs before this fix were
# unknowingly using a flat 0.5 inheritance rate rather than the fitted
# hierarchical rate -- caught by test-checkpoint-c-invariants.R's
# team-changing-candidate test and a direct comparison against
# attach_inheritance_rate()'s data.table merge() (which has no such
# ambiguity). Renaming the parameters away from the column names removes
# the ambiguity entirely.
inheritance_rate_lookup <- function(priors, .dim, .team, .pos) {
  # Deliberately coerced to plain data.frame before filtering: a boolean
  # `[` filter on a data.table can build/cache a secondary index on the
  # filtered columns (datatable.auto.index), and a real, reproduced defect
  # was found where running many such filters (e.g. inside a scalar
  # per-row loop) before a LATER merge() against the SAME priors$team/
  # position/league data.table objects caused that merge() to silently
  # return wrong values for some rows -- despite the underlying tables
  # never changing (verified: identical content before/after). Root cause
  # not fully isolated within the time available; the safe, verified fix
  # is to never let this scalar lookup path and attach_inheritance_rate()'s
  # merge() path touch the same live data.table object. This function is
  # for single-value / test use only -- attach_inheritance_rate() (used in
  # every real model call) does not call this function or share its risk.
  team_df <- as.data.frame(priors$team); position_df <- as.data.frame(priors$position); league_df <- as.data.frame(priors$league)
  row <- team_df[team_df$dimension == .dim & team_df$team == .team & team_df$position == .pos, ]
  if (nrow(row) == 1) return(row$team_rate_blended[1])
  row <- position_df[position_df$dimension == .dim & position_df$position == .pos, ]
  if (nrow(row) == 1) return(row$position_rate_blended[1])
  row <- league_df[league_df$dimension == .dim, ]
  if (nrow(row) == 1) return(row$league_rate[1])
  0.5
}

# ---------------------------------------------------------------------------
# attach_inheritance_rate(): VECTORIZED batch version of
# inheritance_rate_lookup() -- three data.table joins (team -> position ->
# league) covering every row of `bv` at once, instead of one filter-scan
# per row via mapply(). A per-row mapply calling inheritance_rate_lookup()
# was measured to hang (>10 minutes, killed) on a several-thousand-row
# beneficiary table -- the exact O(rows x priors_size) mistake Checkpoint B
# already made and fixed once with data.table joins; the same fix applies
# here. `bv` must have columns dimension/team/absent_position.
# ---------------------------------------------------------------------------
attach_inheritance_rate <- function(bv, priors) {
  bv <- merge(bv, priors$team[, .(dimension, team, position, team_rate_blended)],
             by.x = c("dimension", "team", "absent_position"), by.y = c("dimension", "team", "position"), all.x = TRUE)
  bv <- merge(bv, priors$position[, .(dimension, position, position_rate_blended)],
             by.x = c("dimension", "absent_position"), by.y = c("dimension", "position"), all.x = TRUE)
  bv <- merge(bv, priors$league[, .(dimension, league_rate)], by = "dimension", all.x = TRUE)
  bv[, rate := fcoalesce(team_rate_blended, position_rate_blended, league_rate, 0.5)]
  bv[, c("team_rate_blended", "position_rate_blended", "league_rate") := NULL]
  bv
}

# ---------------------------------------------------------------------------
# fit_position_relationship_weights(): from TRAINING beneficiary
# observations, how much MORE (or less) positive delta per candidate does a
# same-absent-position beneficiary receive versus a cross-position one, by
# dimension -- spec §21/§23 (cross-position must be POSSIBLE, same-position
# affinity may be predictive but never a hard constraint). Returned as a
# bounded multiplier, never a gate.
# ---------------------------------------------------------------------------
fit_position_relationship_weights <- function(beneficiary_observations_train, events_meta_train) {
  bo <- as.data.table(beneficiary_observations_train)
  em <- as.data.table(events_meta_train)[, .(absence_event_id, absent_position = position)]
  bo <- bo[em, on = "absence_event_id", nomatch = 0]
  bo <- bo[!is.na(delta)]
  bo[, same_position := beneficiary_position == absent_position]
  agg <- bo[, .(mean_positive_delta = mean(pmax(delta, 0), na.rm = TRUE), n = .N), by = .(dimension, same_position)]
  wide <- dcast(agg, dimension ~ same_position, value.var = "mean_positive_delta")
  if (!"TRUE" %in% names(wide)) wide[, `TRUE` := NA_real_]
  if (!"FALSE" %in% names(wide)) wide[, `FALSE` := NA_real_]
  wide[, same_position_multiplier := pmin(pmax(.safe_div(`TRUE`, `FALSE`), 0.5), 4)]
  wide[is.na(same_position_multiplier), same_position_multiplier := 1.5]  # no cross-position evidence at all: mild same-position lean, never absolute
  wide[, .(dimension, same_position_multiplier)]
}

# ---------------------------------------------------------------------------
# trend_multiplier(): a candidate's OWN pre-event trend, reusing Checkpoint
# B's already-computed pre_event_recent/pre_event_season (no new Phase 2
# formula, spec §22/§24) -- an already-expanding candidate (recent >
# season) is upweighted; a contracting one is downweighted. Bounded,
# interpretable, decomposable (never a black-box adjustment).
# ---------------------------------------------------------------------------
trend_multiplier <- function(pre_event_recent, pre_event_season) {
  delta <- pre_event_recent - pre_event_season
  ifelse(is.na(delta), 1.0, ifelse(delta > 0.03, 1.25, ifelse(delta < -0.03, 0.85, 1.0)))
}

# ===========================================================================
# The five allocators. Each takes:
#   events_meta: absence_event_id, team, position (absent player's)
#   domain_accounting_val: absence_event_id, domain, dimension, vacated_opportunity
#   beneficiary_val: absence_event_id, beneficiary_gsis_id, beneficiary_position,
#                     domain, dimension, pre_event_recent, pre_event_season
# and any fitted priors, and return a data.table with one row per
# (absence_event_id, domain, dimension, beneficiary_gsis_id):
#   pre_event_role, predicted_role, predicted_delta
# ===========================================================================

# Baseline 0 -- no propagation: retained pre-event role, zero redistribution.
allocate_baseline0 <- function(beneficiary_val, ...) {
  bv <- as.data.table(beneficiary_val)
  bv[, .(absence_event_id, domain, dimension, beneficiary_gsis_id, beneficiary_position,
         pre_event_role = pre_event_recent, predicted_role = pre_event_recent, predicted_delta = 0)]
}

# Baseline 1 -- deterministic same-position next-man-up: within each
# (event, domain), the SAME-POSITION candidate with the largest pre-event
# share (nonzero) absorbs the ENTIRE vacated share; every other same-
# position candidate and every cross-position candidate gets zero.
allocate_baseline1_next_man_up <- function(beneficiary_val, domain_accounting_val, events_meta, ...) {
  bv <- as.data.table(beneficiary_val)
  em <- as.data.table(events_meta)[, .(absence_event_id, absent_position = position)]
  bv <- bv[em, on = "absence_event_id", nomatch = 0]
  bv <- bv[beneficiary_position == absent_position]
  vac <- as.data.table(domain_accounting_val)[, .(absence_event_id, domain, dimension, vacated_opportunity)]
  bv <- merge(bv, vac, by = c("absence_event_id", "domain", "dimension"), all.x = TRUE)
  bv[is.na(pre_event_recent), pre_event_recent := 0]
  bv[, rank := frank(-pre_event_recent, ties.method = "first"), by = .(absence_event_id, domain, dimension)]
  bv[, predicted_delta := if_else(rank == 1 & pre_event_recent > 0, coalesce(vacated_opportunity, 0), 0)]
  bv[, .(absence_event_id, domain, dimension, beneficiary_gsis_id, beneficiary_position,
         pre_event_role = pre_event_recent, predicted_role = pre_event_recent + predicted_delta, predicted_delta)]
}

# Baseline 2 -- proportional existing-role redistribution across ALL
# eligible candidates (any position in OPP$BENEFICIARY_POSITIONS), weighted
# purely by pre-event share -- the full vacated share IS assumed inherited
# (100% inheritance, no shrinkage, no residual concept baked into the
# allocator itself -- residual is still reported afterward as whatever the
# accounting layer computes, spec §18's "do not force beneficiary deltas to
# sum to the vacated role" is honored by NOT clamping the allocator's own
# assumption elsewhere, but this simplest baseline's own assumption IS full
# inheritance, by design, as a contrast point against the calibrated models).
allocate_baseline2_proportional <- function(beneficiary_val, domain_accounting_val, ...) {
  bv <- as.data.table(beneficiary_val)
  vac <- as.data.table(domain_accounting_val)[, .(absence_event_id, domain, dimension, vacated_opportunity)]
  bv <- merge(bv, vac, by = c("absence_event_id", "domain", "dimension"), all.x = TRUE)
  bv[is.na(pre_event_recent) | pre_event_recent < 0, pre_event_recent := 0]
  bv[, total_share := sum(pre_event_recent, na.rm = TRUE), by = .(absence_event_id, domain, dimension)]
  bv[, weight := ifelse(total_share > 0, pre_event_recent / total_share, 0)]
  bv[, predicted_delta := weight * coalesce(vacated_opportunity, 0)]
  bv[, .(absence_event_id, domain, dimension, beneficiary_gsis_id, beneficiary_position,
         pre_event_role = pre_event_recent, predicted_role = pre_event_recent + predicted_delta, predicted_delta)]
}

# Baseline 3 -- historical contingency, empirical, hierarchically shrunk:
# same proportional-share weighting as Baseline 2, but the FRACTION of the
# vacated share assumed inherited (vs. left as structural residual) is the
# team -> position -> league shrunk empirical rate from fit_inheritance_
# priors(), not an assumed 100%.
allocate_baseline3_contingency <- function(beneficiary_val, domain_accounting_val, events_meta, priors, ...) {
  bv <- as.data.table(beneficiary_val)
  em <- as.data.table(events_meta)[, .(absence_event_id, team, absent_position = position)]
  bv <- bv[em, on = "absence_event_id", nomatch = 0]
  vac <- as.data.table(domain_accounting_val)[, .(absence_event_id, domain, dimension, vacated_opportunity)]
  bv <- merge(bv, vac, by = c("absence_event_id", "domain", "dimension"), all.x = TRUE)
  bv[is.na(pre_event_recent) | pre_event_recent < 0, pre_event_recent := 0]
  bv[, total_share := sum(pre_event_recent, na.rm = TRUE), by = .(absence_event_id, domain, dimension)]
  bv[, weight := ifelse(total_share > 0, pre_event_recent / total_share, 0)]
  bv <- attach_inheritance_rate(bv, priors)
  bv[, predicted_delta := weight * rate * coalesce(vacated_opportunity, 0)]
  bv[, .(absence_event_id, domain, dimension, beneficiary_gsis_id, beneficiary_position,
         pre_event_role = pre_event_recent, predicted_role = pre_event_recent + predicted_delta, predicted_delta)]
}

# Candidate 4 -- hierarchical role-vector allocator: Baseline 3's
# hierarchical inheritance rate, but the WITHIN-EVENT weighting also uses
# the candidate's own pre-event TREND (spec §24) and a same-position
# affinity multiplier fitted from training data (spec §21/§23) -- never a
# hard same-position constraint, just a learned, bounded, inspectable lean.
allocate_candidate4_hierarchical <- function(beneficiary_val, domain_accounting_val, events_meta, priors, position_weights, ...) {
  bv <- as.data.table(beneficiary_val)
  em <- as.data.table(events_meta)[, .(absence_event_id, team, absent_position = position)]
  bv <- bv[em, on = "absence_event_id", nomatch = 0]
  vac <- as.data.table(domain_accounting_val)[, .(absence_event_id, domain, dimension, vacated_opportunity)]
  bv <- merge(bv, vac, by = c("absence_event_id", "domain", "dimension"), all.x = TRUE)
  bv <- merge(bv, position_weights, by = "dimension", all.x = TRUE)
  bv[is.na(same_position_multiplier), same_position_multiplier := 1.0]
  bv[is.na(pre_event_recent) | pre_event_recent < 0, pre_event_recent := 0]

  bv[, trend_mult := trend_multiplier(pre_event_recent, pre_event_season)]
  bv[, position_mult := ifelse(beneficiary_position == absent_position, same_position_multiplier, 1.0)]
  # a small role floor prevents a genuinely-zero-share candidate from ever
  # being weighted purely off trend/position multipliers alone (a 0 base
  # share stays a 0 weight regardless of multiplier -- multipliers REFINE
  # an existing role, they do not manufacture one from nothing).
  bv[, raw_weight := pre_event_recent * trend_mult * position_mult]
  bv[, total_weight := sum(raw_weight, na.rm = TRUE), by = .(absence_event_id, domain, dimension)]
  bv[, weight := ifelse(total_weight > 0, raw_weight / total_weight, 0)]
  bv <- attach_inheritance_rate(bv, priors)
  bv[, predicted_delta := weight * rate * coalesce(vacated_opportunity, 0)]
  bv[, .(absence_event_id, domain, dimension, beneficiary_gsis_id, beneficiary_position,
         pre_event_role = pre_event_recent, predicted_role = pre_event_recent + predicted_delta, predicted_delta)]
}

OPP$MODEL_REGISTRY <- list(
  BASELINE_0_NO_PROPAGATION = allocate_baseline0,
  BASELINE_1_NEXT_MAN_UP = allocate_baseline1_next_man_up,
  BASELINE_2_PROPORTIONAL = allocate_baseline2_proportional,
  BASELINE_3_CONTINGENCY_SHRUNK = allocate_baseline3_contingency,
  CANDIDATE_4_HIERARCHICAL = allocate_candidate4_hierarchical
)
