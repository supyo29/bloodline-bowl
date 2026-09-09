/**
 * Competitive Trade Intelligence — BUY-AND-HOLD strategy (Checkpoint F,
 * §17–§19, §34).
 *
 * A hold is NOT a passive failure. `ACQUIRE_AND_HOLD` and `DO_NOTHING` are
 * legitimate terminal decisions. This module scores the hold case with a
 * DECOMPOSED value — there are NO fabricated expected-dollar figures:
 *
 *   hold value ≈  current permanent roster gain
 *              +  expected optionality (future downstream trade flexibility)
 *              +  appreciation potential (SPECULATIVE, discounted)
 *              −  injury risk
 *              −  market uncertainty
 *              −  time risk
 *
 * §34 — `future_optionality` is DISTINCT from current permanent roster utility.
 * It is a function of how many/quality of future buyers, appreciation, and
 * positional scarcity — i.e. how many good things we could later DO with the
 * asset, not how much it helps our Week-N lineup.
 */

import { resolveCompetitiveFConfig, type CompetitiveFConfig, type PartialCompetitiveFConfig } from "./config";
import { liquidityRank } from "./liquidity";
import { appreciationIsTrustworthy } from "./appreciation";
import type {
  AppreciationClassification,
  FutureOptionality,
  HoldDecision,
  HoldEvaluation,
  LiquidityClassification,
  MarketAppreciation,
  TradeLiquidity,
  ValueConfidence,
} from "./schema";

const CONF_RANK: Record<ValueConfidence, number> = { VERY_LOW: 0, LOW: 1, MEDIUM: 2, HIGH: 3 };
const APPREC_VALUE: Record<AppreciationClassification, number> = {
  HIGH_APPRECIATION_POTENTIAL: 1.0,
  MODERATE_APPRECIATION_POTENTIAL: 0.5,
  LIMITED_APPRECIATION_POTENTIAL: 0.1,
  MARKET_ALREADY_CORRECTED: 0,
  DEPRECIATION_RISK: -0.6,
  REVIEW_REQUIRED: 0,
  UNKNOWN: 0,
};

export interface BuildHoldInput {
  /** which acquired assets the hold case is about */
  acquire_ids: string[];
  /** blended permanent (rest-of-season) roster gain from acquiring them — from D.5 horizon */
  permanent_gain: number | null;
  /** confidence in that permanent gain */
  permanent_confidence: ValueConfidence;
  liquidity: TradeLiquidity[];
  appreciation: MarketAppreciation[];
  /** weeks remaining in the fantasy regular season (time-risk input) */
  weeks_remaining: number;
  config?: PartialCompetitiveFConfig;
}

export function buildHoldEvaluation(input: BuildHoldInput): HoldEvaluation {
  const cfg: CompetitiveFConfig = resolveCompetitiveFConfig(input.config);
  const w = cfg.hold.weights;
  const reasons: string[] = [];

  const bestLiquidity: LiquidityClassification =
    input.liquidity.length > 0
      ? input.liquidity.reduce<LiquidityClassification>((acc, l) => (liquidityRank(l.classification) > liquidityRank(acc) ? l.classification : acc), "VERY_LOW")
      : "VERY_LOW";
  const totalBuyers = input.liquidity.reduce((s, l) => s + l.buyer_count, 0);
  const bestScarcity = input.liquidity.reduce<number | null>((acc, l) => {
    if (l.positional_scarcity_ratio == null) return acc;
    return acc == null ? l.positional_scarcity_ratio : Math.min(acc, l.positional_scarcity_ratio);
  }, null);

  const bestAppr: MarketAppreciation | null =
    input.appreciation.length > 0
      ? input.appreciation.reduce((a, b) => (APPREC_VALUE[b.classification] > APPREC_VALUE[a.classification] ? b : a))
      : null;
  const apprClass: AppreciationClassification = bestAppr?.classification ?? "UNKNOWN";

  // ---- future optionality (§34) — distinct from permanent roster utility ----
  const apprComponent = bestAppr && appreciationIsTrustworthy(bestAppr) ? APPREC_VALUE[apprClass] : APPREC_VALUE[apprClass] * 0.25;
  const scarcityComponent = bestScarcity == null ? 0 : Math.max(0, (1.0 - bestScarcity)) * 0.8;
  const optConf: ValueConfidence =
    input.liquidity.some((l) => l.readiness === "FULL_LIQUIDITY_CONTEXT") ? (bestAppr?.confidence ?? "LOW") : "VERY_LOW";
  const optScore =
    Math.round(
      (Math.min(2, totalBuyers * 0.2) + liquidityRank(bestLiquidity) * 0.25 + Math.max(0, apprComponent) + scarcityComponent) * 1000,
    ) / 1000;

  const future_optionality: FutureOptionality = {
    score: optScore,
    buyer_count: totalBuyers,
    buyer_quality: bestLiquidity,
    appreciation: apprClass,
    positional_scarcity_ratio: bestScarcity,
    confidence: optConf,
    reasons: [
      `${totalBuyers} future buyer(s) across the traded assets, best liquidity ${bestLiquidity}, appreciation ${apprClass}. Optionality is downstream trade flexibility, NOT current lineup help (§34).`,
    ],
  };

  // ---- risk terms (all ≥ 0, subtracted) ----
  const anyReviewAppr = input.appreciation.some((a) => a.classification === "REVIEW_REQUIRED");
  const injuryRisk = 0.3 + 0.1 * input.acquire_ids.length;
  const marketUncertainty =
    0.2 +
    (3 - CONF_RANK[input.permanent_confidence]) * 0.15 +
    (anyReviewAppr ? 0.3 : 0) +
    (bestAppr?.classification === "DEPRECIATION_RISK" ? 0.3 : 0);
  const timeRisk = input.weeks_remaining <= 4 ? 0.5 : input.weeks_remaining <= 8 ? 0.3 : 0.15;

  const gain = input.permanent_gain;
  const components = {
    current_permanent_roster_gain: gain,
    expected_optionality: optScore,
    appreciation_potential: Math.round(Math.max(0, apprComponent) * 1000) / 1000,
    injury_risk: Math.round(injuryRisk * 1000) / 1000,
    market_uncertainty: Math.round(marketUncertainty * 1000) / 1000,
    time_risk: Math.round(timeRisk * 1000) / 1000,
  };

  const holdScore =
    gain == null
      ? null
      : Math.round(
          (w.permanent_roster_gain * gain +
            w.future_optionality * components.expected_optionality +
            w.appreciation_potential * components.appreciation_potential -
            w.injury_risk * components.injury_risk -
            w.market_uncertainty * components.market_uncertainty -
            w.time_risk * components.time_risk) *
            1000,
        ) / 1000;

  // ---- decision ----
  let decision: HoldDecision;
  const minGain = cfg.hold.min_hold_permanent_gain;
  if (gain == null || (input.permanent_confidence === "VERY_LOW" && anyReviewAppr)) {
    decision = "REVIEW_REQUIRED";
    reasons.push("permanent gain unavailable or unsupported and appreciation is REVIEW_REQUIRED — no hold call");
  } else if (gain <= 0) {
    // A negative permanent roster gain can NEVER be a buy-and-hold or a flip —
    // acquiring the player makes our roster worse this season (§17, §57).
    decision = input.permanent_confidence === "VERY_LOW" ? "REVIEW_REQUIRED" : "DO_NOTHING";
    reasons.push(
      `acquiring these assets REDUCES our permanent rest-of-season roster value by ${Math.abs(gain).toFixed(2)} weekly-equivalent — neither a hold nor a flip is justified; ${decision === "REVIEW_REQUIRED" ? "the model disagreement is extreme (REVIEW_REQUIRED)" : "do nothing"} (§57).`,
    );
  } else if (gain < minGain && optScore < 0.6 && APPREC_VALUE[apprClass] <= 0.1) {
    decision = "DO_NOTHING";
    reasons.push(`acquiring adds only ${gain.toFixed(2)} weekly-equivalent permanent value with weak optionality and no trustworthy appreciation — doing nothing is the correct terminal decision, not a failure (§17).`);
  } else if (
    liquidityRank(bestLiquidity) >= liquidityRank("HIGH") &&
    APPREC_VALUE[apprClass] <= 0.1 &&
    gain < minGain * 2
  ) {
    decision = "ACQUIRE_AND_FLIP";
    reasons.push("the asset is highly liquid but adds limited permanent value and limited appreciation — its value is as a trade chip, not a hold.");
  } else if (holdScore != null && holdScore > 0 && gain >= minGain) {
    decision = "ACQUIRE_AND_HOLD";
    reasons.push(`holding is justified: permanent gain ${gain.toFixed(2)} + optionality ${optScore.toFixed(2)} + appreciation ${components.appreciation_potential.toFixed(2)} net of injury/uncertainty/time risk (hold score ${holdScore.toFixed(2)}).`);
  } else {
    decision = "DO_NOTHING";
    reasons.push(`the decomposed hold score (${holdScore?.toFixed(2) ?? "n/a"}) does not clear zero once risk is netted out.`);
  }

  const confidence: ValueConfidence =
    (["VERY_LOW", "LOW", "MEDIUM", "HIGH"] as ValueConfidence[])[
      Math.max(0, Math.min(3, Math.min(CONF_RANK[input.permanent_confidence], CONF_RANK[future_optionality.confidence] + 1)))
    ]!;

  // ---- hold-until / reassess-if (§53–§54) — no fabricated dates ----
  const holdUntil: string[] = [];
  const reassessIf: string[] = [];
  if (decision === "ACQUIRE_AND_HOLD") {
    holdUntil.push("a materially better direct upgrade at the same position becomes available");
    holdUntil.push("appreciation catalysts are confirmed by additional games of evidence");
    if (bestAppr) reassessIf.push(...bestAppr.invalidation_conditions.map((c) => `appreciation invalidation: ${c}`));
    reassessIf.push("the player's role or health changes");
  } else if (decision === "ACQUIRE_AND_FLIP") {
    holdUntil.push("a buyer meeting our reservation price emerges (liquidity is currently " + bestLiquidity + ")");
  }

  return {
    decision,
    components,
    hold_score: holdScore,
    future_optionality,
    hold_until_conditions: holdUntil,
    reassess_if_conditions: [...new Set(reassessIf)],
    confidence,
    reasons,
  };
}
