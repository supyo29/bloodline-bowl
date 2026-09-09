/**
 * Competitive Trade Intelligence — competitive externality (Checkpoint D).
 *
 *   externality_score =
 *     ( starter_gain_weight·max(0, opp_starter_delta) + depth_gain_weight·max(0, opp_depth_delta) )
 *       × threat_band_multiplier
 *       × weakness_repair_multiplier
 *       × relative_strength_multiplier
 *
 *   ≥ 0  ⇒ we helped a rival (a COST to us)
 *   < 0  ⇒ we WEAKENED them (FAVORABLE) — driven directly by a negative opponent
 *          private delta, NOT by the formula above (§14, §46).
 *
 * Not the literal §11 formula — decomposed, bounded, tested for scaling.
 */

import type { CompetitiveDConfig } from "./config";
import type {
  CompetitiveExternality,
  CompetitiveReasonCode,
  OpponentImpact,
  OpponentThreat,
} from "./schema";

export interface BuildExternalityInput {
  opponent_impact: OpponentImpact;
  threat: OpponentThreat;
  config: CompetitiveDConfig;
}

export function buildCompetitiveExternality(input: BuildExternalityInput): CompetitiveExternality {
  const { opponent_impact: oi, threat, config } = input;
  const e = config.externality;
  const codes = new Set<CompetitiveReasonCode>();
  const reasons: string[] = [];

  const privateDelta = oi.private_delta ?? 0;

  // ---- FAVORABLE: we actually weakened them ----
  if (privateDelta < -0.25) {
    // externality is negative — scaled by how strong they are (weakening a
    // contender is worth more than weakening a bottom team) but always ≤ 0.
    const threatFactor = e.threat_band_multiplier[threat.band];
    const score = round4(privateDelta * 0.5 * threatFactor);
    codes.add("OPPONENT_ACTUALLY_WEAKENED");
    reasons.push(`the trade weakens ${threat.owner_manager_id} by ${privateDelta.toFixed(2)} — a competitive BENEFIT (score ${score.toFixed(2)})`);
    return {
      score,
      components: {
        starter_cost: 0,
        depth_cost: 0,
        threat_multiplier: threatFactor,
        weakness_repair_multiplier: 1,
        relative_strength_multiplier: 1,
      },
      reason_codes: [...codes],
      reasons,
    };
  }

  // ---- COST: we helped them ----
  const starterGain = Math.max(0, oi.starter_delta ?? 0);
  const depthGain = Math.max(0, (oi.bench_delta ?? 0) + Math.max(0, oi.ros_delta ?? 0) * 0.5);
  const starterCost = round4(e.starter_gain_weight * starterGain);
  const depthCost = round4(e.depth_gain_weight * depthGain);

  const threatMult = e.threat_band_multiplier[threat.band];
  const repairMult = e.weakness_repair_multiplier[oi.weakness_repair];
  const relStrength = threat.relative_to_us ?? 0;
  const relMult = round4(1 + e.relative_strength_weight * Math.max(0, relStrength));

  const score = round4((starterCost + depthCost) * threatMult * repairMult * relMult);

  if (starterGain > 0.5) codes.add("OPPONENT_STARTER_GAIN");
  if (depthGain > 0.5 && starterGain <= 0.5) codes.add("OPPONENT_DEPTH_GAIN");
  if (oi.weakness_repair === "CRITICAL_WEAKNESS_REPAIRED") codes.add("CRITICAL_WEAKNESS_REPAIRED");
  else if (oi.weakness_repair === "HIGH_NEED_REPAIRED") codes.add("HIGH_NEED_REPAIRED");
  else if (oi.weakness_repair === "SURPLUS_REINFORCED") codes.add("SURPLUS_REINFORCED");
  if (threat.band === "ELITE" || threat.band === "HIGH") {
    if (score > 1) { codes.add("ELITE_RIVAL_STRENGTHENED"); reasons.push(`strengthening a ${threat.band}-threat rival (multiplier ${threatMult})`); }
  }
  if (threat.band === "LOW") { codes.add("LOW_THREAT_COUNTERPARTY"); reasons.push(`${threat.owner_manager_id} is a LOW-threat counterparty — limited competitive cost`); }
  if (relStrength > 0.3) { codes.add("STRONGER_THAN_US"); reasons.push(`counterparty is stronger than us (relative +${relStrength.toFixed(2)} z) → cost multiplier ${relMult}`); }
  else if (relStrength < -0.3) codes.add("WEAKER_THAN_US");

  reasons.unshift(
    `externality = (starter_cost ${starterCost.toFixed(2)} + depth_cost ${depthCost.toFixed(2)}) × threat ${threatMult} × repair ${repairMult} × relative ${relMult} = ${score.toFixed(2)}`,
  );

  return {
    score,
    components: {
      starter_cost: starterCost,
      depth_cost: depthCost,
      threat_multiplier: threatMult,
      weakness_repair_multiplier: repairMult,
      relative_strength_multiplier: relMult,
    },
    reason_codes: [...codes],
    reasons,
  };
}

function round4(v: number): number {
  const x = Math.round(v * 10000) / 10000;
  return x === 0 ? 0 : x;
}
