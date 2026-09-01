/**
 * PHASE 4 §16 / §17 / §18 / §8 — the player utility function.
 *
 * DESIGN CHOICE: every component is expressed in LEAGUE-POINT-EQUIVALENT units
 * ("marginal value units", §17). VOR, tier drop, wait loss and positional
 * advantage are already points. Scarcity, roster need, reach cost and the
 * uncertainty / construction-risk penalties are converted to points before they
 * are combined. This avoids z-score instability on small candidate sets (§17)
 * and keeps the score interpretable: `recommendation_score` reads as "expected
 * marginal draft value, in this league's points".
 *
 *   Utility = w_vor·VOR
 *           + w_tier·TierDrop
 *           + w_scar·ScarcityValue
 *           + w_need·RosterNeed
 *           + w_adv·PositionalAdvantage
 *           + w_urg·Urgency
 *           − w_reach·ReachCost
 *           − w_unc·UncertaintyPenalty
 *           − w_risk·ConstructionRisk
 *
 * Weights are dimensionless and default to conservative values (mostly 1.0);
 * `analysis/phase4_snake_recommendation_engine.R` tunes them against synthetic
 * decision scenarios and ablation, never by hand-feel.
 */

import type { OutcomeBand } from "@/lib/projections/schema";
import type { SurvivalConfidence, UtilityComponents, UtilityWeights } from "./schema";

/**
 * Default weights (`ri-snake-decision-2026.1`).
 *
 * SELECTED BY SIMULATION, not hand-feel (§16). `analysis/phase4_*` sweeps a grid
 * of interpretable weight vectors over a self-play decision-quality proxy
 * (`phase4_weight_search.csv`). Result: VOR + roster-need dominate roster
 * quality; heavy timing weights *reduce* it (over-chasing cliffs at the cost of
 * balance). The chosen vector — `vor_need_light_timing` — is statistically
 * indistinguishable from pure VOR+need on roster VOR (Δ ≈ 2, sd ≈ 275) but
 * KEEPS the snake-timing signal as a tie-breaker and preserves the reach
 * classification and evidence. The penalties only shade; they never veto (§22).
 */
export const DEFAULT_WEIGHTS: UtilityWeights = {
  vor: 1.0,
  tier_drop: 0.6,
  scarcity_value: 0.3,
  roster_need: 0.85,
  positional_advantage: 0.45,
  urgency: 0.6,
  reach_cost: 0.8,
  uncertainty_penalty: 0.4,
  construction_risk: 0.7,
};

/* -------------------------------------------------------- reach cost (§8) */

export interface ReachInput {
  currentPickOverall: number;
  /** market expected pick (ADP or search_rank-implied); null when unknown */
  marketPickOverall: number | null;
  /** survival probability to the manager's NEXT pick */
  pSurvivesNextPick: number;
  /** local league-points drop per overall pick around here (board gradient) */
  pointsPerPick: number;
  survivalConfidence: SurvivalConfidence;
}

/**
 * Reaching = drafting well ahead of market for a player who would plausibly
 * still be there later. A 3-pick reach is noise; a 40-pick reach on someone
 * who'd fall to your next turn is a real cost. Never a hard veto.
 */
export function reachCost(input: ReachInput): number {
  if (input.marketPickOverall == null) return 0;
  const picksAhead = input.marketPickOverall - input.currentPickOverall;
  if (picksAhead <= 3) return 0; // within market noise

  // only the portion of the reach the player would actually have survived is a
  // cost; and a low-confidence market signal damps it.
  const confScale =
    input.survivalConfidence === "MEDIUM" ? 0.8 :
    input.survivalConfidence === "LOW" ? 0.5 :
    input.survivalConfidence === "HIGH" ? 1.0 : 0.3;

  const effectivePicks = (picksAhead - 3) * clamp01(input.pSurvivesNextPick);
  return round2(effectivePicks * Math.max(0.05, input.pointsPerPick) * confScale);
}

/* ---------------------------------------------- uncertainty penalty (§18) */

export interface UncertaintyInput {
  band: OutcomeBand;
  median: number;
  /** 0..1 — how far into the draft (round / total rounds) */
  draftProgress: number;
  /** 0..1 — current starter-completion risk (unstable roster → floor matters) */
  starterCompletionRisk: number;
}

/**
 * Conservative deterministic form (§18): penalise DOWNSIDE only, with a weight
 * that is small early (ceilings are fine when the roster is stable and picks
 * remain) and rises as the draft progresses and as starter-completion risk
 * climbs. Monotonic: lower spread → smaller (median − floor) → smaller penalty,
 * always. A high-ceiling rookie is NOT auto-penalised — early, the floor weight
 * is at its ~0.15 minimum.
 */
export function uncertaintyPenalty(input: UncertaintyInput): number {
  const downside = Math.max(0, input.median - input.band.floor);
  const floorWeight =
    0.15 + 0.25 * clamp01(input.draftProgress) + 0.2 * clamp01(input.starterCompletionRisk);
  return round2(downside * floorWeight);
}

/* --------------------------------------------------- assemble the score */

export function utilityScore(
  components: UtilityComponents,
  weights: UtilityWeights = DEFAULT_WEIGHTS,
): number {
  return round2(
    weights.vor * components.vor +
      weights.tier_drop * components.tier_drop +
      weights.scarcity_value * components.scarcity_value +
      weights.roster_need * components.roster_need +
      weights.positional_advantage * components.positional_advantage +
      weights.urgency * components.urgency -
      weights.reach_cost * components.reach_cost -
      weights.uncertainty_penalty * components.uncertainty_penalty -
      weights.construction_risk * components.construction_risk,
  );
}

/**
 * Construction-risk term in points: a pick that raises starter-completion risk
 * (piling onto a filled position while a starter slot rots) is penalised; a
 * pick that relieves an at-risk position contributes 0 here (the relief shows
 * up as roster_need + positional_advantage). Scale: the risk delta times a
 * fixed points-per-risk so a full 1.0 risk swing ≈ a replacement-level starter.
 */
export function constructionRiskValue(riskDelta: number, pointsPerRisk = 60): number {
  return round2(Math.max(0, riskDelta) * pointsPerRisk);
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
