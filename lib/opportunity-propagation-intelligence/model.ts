/**
 * Injury -> Opportunity Propagation Intelligence — the CANDIDATE_4_HIERARCHICAL
 * allocator, ported from `analysis/opportunity_propagation/
 * lib_propagation_model.R` (Checkpoint C's selected model, frozen for
 * Checkpoint D -- do not retune here). This is the ONLY place the formula
 * is implemented in TypeScript; `analysis/opportunity_propagation/tests/
 * testthat/test-r-ts-parity.R` and `test/opportunity-propagation-r-ts-
 * parity.test.ts` prove this port matches the R implementation numerically
 * (spec §40).
 *
 * MUTUALLY_EXHAUSTIVE_DIMENSIONS / trend thresholds / shrinkage constants
 * below are copied VALUES, not independently chosen -- they must always
 * equal `analysis/opportunity_propagation/{lib_propagation_model.R,
 * backtest.R}`'s constants. A change to either side without the other is a
 * parity regression the tests above are designed to catch.
 */

import type { OpportunityPropagationModel, EvidenceInfo } from "./schema";

/** Domains where the resource is genuinely scarce and one-recipient-per-play -- mirrors backtest.R's clip_predicted_shares(). snap_share is deliberately excluded (eleven players share the field). */
export const MUTUALLY_EXHAUSTIVE_DIMENSIONS = new Set([
  "target_share", "position_group_target_share", "rush_share", "position_group_rush_share",
  "rz_target_share", "rz_carry_share", "kick_return_role", "punt_return_role",
]);

/** air_yards_share is not [0,1]-bounded by construction (individual plays can have negative air yards) -- mirrors clip_predicted_shares(). */
const UNBOUNDED_DIMENSIONS = new Set(["air_yards_share"]);

const TREND_UP_THRESHOLD = 0.03;
const TREND_DOWN_THRESHOLD = -0.03;
const TREND_UP_MULTIPLIER = 1.25;
const TREND_DOWN_MULTIPLIER = 0.85;
const TREND_STABLE_MULTIPLIER = 1.0;

/** Mirrors lib_propagation_model.R's trend_multiplier(). */
export function trendMultiplier(preEventRecent: number | null, preEventSeason: number | null): number {
  if (preEventRecent == null || preEventSeason == null) return TREND_STABLE_MULTIPLIER;
  const delta = preEventRecent - preEventSeason;
  if (delta > TREND_UP_THRESHOLD) return TREND_UP_MULTIPLIER;
  if (delta < TREND_DOWN_THRESHOLD) return TREND_DOWN_MULTIPLIER;
  return TREND_STABLE_MULTIPLIER;
}

/**
 * Mirrors attach_inheritance_rate()'s team -> position -> league hierarchy
 * exactly, including the fallback-to-0.5 default when NOTHING in the
 * hierarchy has evidence for this dimension at all (never silently
 * disguised as team-specific -- the returned `source` says which tier
 * actually backed the number, spec §25).
 */
export function lookupInheritanceRate(
  model: OpportunityPropagationModel,
  dimension: string,
  team: string,
  absentPosition: string,
): EvidenceInfo {
  const teamRow = model.team.find((r) => r.dimension === dimension && r.team === team && r.position === absentPosition);
  if (teamRow) {
    return { source: "TEAM_POSITION_HISTORY", evidence_count: teamRow.n_team, inheritance_rate: teamRow.team_rate_blended };
  }
  const positionRow = model.position.find((r) => r.dimension === dimension && r.position === absentPosition);
  if (positionRow) {
    const leagueRow = model.league.find((r) => r.dimension === dimension);
    return { source: "POSITION_PRIOR", evidence_count: leagueRow?.n_league ?? 0, inheritance_rate: positionRow.position_rate_blended };
  }
  const leagueRow = model.league.find((r) => r.dimension === dimension);
  if (leagueRow) {
    return { source: "LEAGUE_PRIOR", evidence_count: leagueRow.n_league, inheritance_rate: leagueRow.league_rate };
  }
  return { source: "GLOBAL_DEFAULT", evidence_count: 0, inheritance_rate: 0.5 };
}

export interface CandidateInput {
  gsis_id: string;
  position: string;
  pre_event_recent: number | null;
  pre_event_season: number | null;
}

export interface CandidatePrediction {
  gsis_id: string;
  position: string;
  pre_event_role: number;
  predicted_role: number;
  predicted_delta: number;
  trace: {
    pre_event_share_weight: number;
    trend_multiplier: number;
    position_affinity_multiplier: number;
    normalized_weight: number;
  };
  evidence: EvidenceInfo;
}

function samePositionMultiplier(model: OpportunityPropagationModel, dimension: string): number {
  return model.positionWeights.find((r) => r.dimension === dimension)?.same_position_multiplier ?? 1.0;
}

/**
 * Mirrors allocate_candidate4_hierarchical() + clip_predicted_shares()
 * for ONE (team, absentPosition, dimension, vacatedOpportunity) scenario.
 * Deterministic: identical inputs -> identical outputs, byte-for-byte
 * (spec §25 in Checkpoint C, re-asserted for the served product here).
 */
export function allocateHierarchical(
  model: OpportunityPropagationModel,
  team: string,
  absentPosition: string,
  dimension: string,
  vacatedOpportunity: number | null,
  candidates: CandidateInput[],
): CandidatePrediction[] {
  const evidence = lookupInheritanceRate(model, dimension, team, absentPosition);
  const samePosMult = samePositionMultiplier(model, dimension);
  const vacated = vacatedOpportunity ?? 0;

  const rows = candidates.map((c) => {
    const pre = c.pre_event_recent != null && c.pre_event_recent >= 0 ? c.pre_event_recent : 0;
    const trend = trendMultiplier(c.pre_event_recent, c.pre_event_season);
    const posMult = c.position === absentPosition ? samePosMult : 1.0;
    const rawWeight = pre * trend * posMult;
    return { gsis_id: c.gsis_id, position: c.position, pre, trend, posMult, rawWeight };
  });
  const totalWeight = rows.reduce((s, r) => s + r.rawWeight, 0);

  let predictions: CandidatePrediction[] = rows.map((r) => {
    const normalizedWeight = totalWeight > 0 ? r.rawWeight / totalWeight : 0;
    const predictedDelta = normalizedWeight * evidence.inheritance_rate * vacated;
    let predictedRole = r.pre + predictedDelta;
    if (!UNBOUNDED_DIMENSIONS.has(dimension)) predictedRole = Math.min(Math.max(predictedRole, 0), 1);
    return {
      gsis_id: r.gsis_id, position: r.position, pre_event_role: r.pre, predicted_role: predictedRole,
      predicted_delta: predictedRole - r.pre,
      trace: { pre_event_share_weight: r.pre, trend_multiplier: r.trend, position_affinity_multiplier: r.posMult, normalized_weight: normalizedWeight },
      evidence,
    };
  });

  // group-sum renormalization for mutually-exhaustive domains -- mirrors
  // clip_predicted_shares() exactly, including the snap_share exclusion.
  if (MUTUALLY_EXHAUSTIVE_DIMENSIONS.has(dimension)) {
    const groupTotal = predictions.reduce((s, p) => s + Math.max(p.predicted_role, 0), 0);
    if (groupTotal > 1) {
      predictions = predictions.map((p) => {
        const rescaled = p.predicted_role / groupTotal;
        return { ...p, predicted_role: rescaled, predicted_delta: rescaled - p.pre_event_role };
      });
    }
  }
  return predictions;
}
