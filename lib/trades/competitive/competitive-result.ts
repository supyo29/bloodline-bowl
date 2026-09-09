/**
 * Competitive Trade Intelligence — final competitive desirability (Checkpoint D).
 *
 * A STAGED decision flow (§18), not one opaque equation:
 *   1. structurally valid + readiness
 *   2. our private gain clears the minimum
 *   3. acceptance clears the feasibility threshold   → `actionable` (§19, §33)
 *   4. score = our_private_gain + market_edge_bonus − capped_externality − uncertainty
 *   5. classification from score bands + gates
 *
 * Our own roster improvement is the DOMINANT objective (§2, §15, §30): a
 * positive externality (helping a rival) is capped relative to |our gain| so it
 * can never swamp an overwhelming improvement. A NEGATIVE externality (we
 * weakened them) is never capped — it can only help (§14).
 */

import type { CompetitiveDConfig } from "./config";
import type {
  AcceptanceLikelihood,
  CompetitiveClassification,
  CompetitiveExternality,
  CompetitiveReadinessState,
  CompetitiveReasonCode,
  CompetitiveResult,
  OpponentThreat,
  ValueConfidence,
} from "./schema";

const ACC_RANK: Record<AcceptanceLikelihood, number> = { VERY_LOW: 0, LOW: 1, MODERATE: 2, HIGH: 3 };
const CONF_LEVEL: Record<ValueConfidence, number> = { HIGH: 3, MEDIUM: 2, LOW: 1, VERY_LOW: 0 };
const LEVEL_CONF: ValueConfidence[] = ["VERY_LOW", "LOW", "MEDIUM", "HIGH"];

export interface BuildCompetitiveResultInput {
  /** our authoritative roster utility delta from evaluateTrade (weekly pts) */
  our_private_gain: number | null;
  /** competitive block's aggregate net actionable market edge (z) */
  market_net_actionable_edge: number | null;
  acceptance_likelihood: AcceptanceLikelihood | null;
  acceptance_confidence: ValueConfidence | null;
  externality: CompetitiveExternality;
  threat: OpponentThreat;
  owner_perception_confidence: ValueConfidence | null;
  readiness: CompetitiveReadinessState;
  config: CompetitiveDConfig;
}

export function buildCompetitiveResult(input: BuildCompetitiveResultInput): CompetitiveResult {
  const cfg = input.config.result;
  const gate: CompetitiveResult["gate_trace"] = [];
  const codes = new Set<CompetitiveReasonCode>();
  const reasons: string[] = [];

  // ---- stage 1: readiness ----
  if (input.readiness === "UNAVAILABLE" || input.our_private_gain == null) {
    gate.push({ stage: "readiness", pass: false, note: "our private evaluation or threat context unavailable" });
    return degenerate("REJECT", gate, input.readiness, "VERY_LOW", ["competitive evaluation unavailable"]);
  }
  gate.push({ stage: "readiness", pass: true, note: input.readiness });
  if (input.readiness === "PARTIAL_COMPETITIVE_CONTEXT" || input.readiness === "NO_THREAT_CONTEXT") {
    codes.add("THREAT_CONTEXT_PARTIAL");
  }
  if (input.threat.components.results_weight === 0 && input.threat.components.results_strength_z == null) {
    codes.add("WEEK1_RECORD_IGNORED");
  }

  const ourGain = input.our_private_gain;

  // ---- stage 2: our gain ----
  const gainOk = ourGain >= cfg.min_our_gain;
  gate.push({ stage: "our_gain", pass: gainOk, note: `our private gain ${ourGain.toFixed(2)} vs min ${cfg.min_our_gain}` });
  if (!gainOk) {
    codes.add("OUR_GAIN_INSUFFICIENT");
    reasons.push(`our roster barely moves (${ourGain.toFixed(2)} pts/wk) — not worth doing regardless of how they feel`);
  }

  // ---- stage 3: acceptance feasibility (§19) ----
  const accRank = input.acceptance_likelihood ? ACC_RANK[input.acceptance_likelihood] : 0;
  const feasible = accRank >= ACC_RANK[cfg.min_acceptance];
  gate.push({ stage: "acceptance_feasibility", pass: feasible, note: `acceptance ${input.acceptance_likelihood ?? "UNKNOWN"} vs min ${cfg.min_acceptance}` });
  if (!feasible) {
    codes.add("ACCEPTANCE_BELOW_THRESHOLD");
    reasons.push(`acceptance likelihood ${input.acceptance_likelihood ?? "UNKNOWN"} is below the feasibility threshold — analytically attractive but not realistically actionable`);
  }

  // ---- stage 4: score ----
  const marketBonus =
    input.market_net_actionable_edge == null
      ? 0
      : Math.max(
          -cfg.market_edge_bonus_cap,
          Math.min(cfg.market_edge_bonus_cap, cfg.market_edge_bonus_weight * input.market_net_actionable_edge),
        );
  if (marketBonus > 0.1) codes.add("MARKET_EDGE_SUPPORTS");

  const ext = input.externality.score;
  let cappedExt = ext;
  if (ext > 0) {
    const threatExtra =
      input.threat.band === "ELITE" ? cfg.elite_threat_extra_cap : input.threat.band === "HIGH" ? cfg.high_threat_extra_cap : 0;
    const cap = Math.min(cfg.externality_abs_cap, cfg.externality_cap_fraction_of_our_gain * Math.abs(ourGain) + threatExtra);
    cappedExt = Math.min(ext, cap);
    if (cappedExt < ext - 1e-6) {
      codes.add("OUR_GAIN_DOMINATES_EXTERNALITY");
      reasons.push(`externality ${ext.toFixed(2)} capped at ${cappedExt.toFixed(2)} — our own gain (${ourGain.toFixed(2)}) is the dominant objective`);
    }
  } else {
    cappedExt = Math.max(ext, -cfg.externality_abs_cap); // favorable externality only bounded by the abs cap
  }

  // uncertainty penalty
  const confLevels = [input.acceptance_confidence, input.owner_perception_confidence, input.threat.readiness === "FULL_COMPETITIVE_CONTEXT" ? "MEDIUM" : "LOW"]
    .filter((c): c is ValueConfidence => Boolean(c))
    .map((c) => CONF_LEVEL[c]);
  const worstConf = confLevels.length > 0 ? Math.min(...confLevels) : 0;
  const uncertaintyPenalty = round4((3 - worstConf) * cfg.uncertainty_penalty_per_band);

  const score = round4(ourGain + marketBonus - cappedExt - uncertaintyPenalty);

  gate.push({ stage: "score", pass: true, note: `${ourGain.toFixed(2)} (our gain) + ${marketBonus.toFixed(2)} (edge) − ${cappedExt.toFixed(2)} (externality) − ${uncertaintyPenalty.toFixed(2)} (uncertainty) = ${score.toFixed(2)}` });

  // ---- externality reason codes on the result ----
  if (ext < -0.1) { codes.add("OPPONENT_ACTUALLY_WEAKENED"); reasons.push("the trade weakens the counterparty — a competitive plus"); }
  if (input.externality.reason_codes.includes("ELITE_RIVAL_STRENGTHENED")) codes.add("ELITE_RIVAL_STRENGTHENED");
  if (input.externality.reason_codes.includes("LOW_THREAT_COUNTERPARTY")) codes.add("LOW_THREAT_COUNTERPARTY");
  if (ext > Math.abs(ourGain) && (input.threat.band === "ELITE" || input.threat.band === "HIGH")) codes.add("EXTERNALITY_TOO_HIGH");
  if ((input.externality.score <= 0.1) && ourGain > 3) { codes.add("ASYMMETRIC_TRADE"); reasons.push("we gain materially while the counterparty barely improves (or loses) — asymmetric"); }

  // ---- stage 5: classification ----
  const t = cfg.classification_thresholds;
  let classification: CompetitiveClassification;
  if (!gainOk) classification = "REJECT";
  else if (codes.has("EXTERNALITY_TOO_HIGH") && score < t.acceptable) classification = "AVOID_COMPETITIVE_COST";
  else if (score >= t.strong_buy) classification = "STRONG_COMPETITIVE_BUY";
  else if (score >= t.buy) classification = "COMPETITIVE_BUY";
  else if (score >= t.acceptable) classification = "ACCEPTABLE";
  else if (score >= t.marginal) classification = "MARGINAL";
  else classification = codes.has("EXTERNALITY_TOO_HIGH") ? "AVOID_COMPETITIVE_COST" : "REJECT";

  // an un-actionable trade is capped at MARGINAL — attractive on paper, can't get done
  if (!feasible && (classification === "STRONG_COMPETITIVE_BUY" || classification === "COMPETITIVE_BUY" || classification === "ACCEPTABLE")) {
    classification = "MARGINAL";
    reasons.push("classification capped at MARGINAL — the counterparty is unlikely to accept");
  }

  if (score >= t.buy && input.externality.score <= 0) reasons.unshift("strong competitive profile: we improve and the counterparty does not meaningfully gain");

  const confidence = LEVEL_CONF[Math.max(0, Math.min(3, worstConf))]!;

  return {
    score,
    classification,
    actionable: feasible && gainOk,
    components: {
      our_private_gain: round4(ourGain),
      market_edge_bonus: round4(marketBonus),
      competitive_externality: round4(cappedExt),
      uncertainty_penalty: uncertaintyPenalty,
    },
    gate_trace: gate,
    confidence,
    readiness: input.readiness,
    reason_codes: [...codes],
    reasons,
  };
}

function degenerate(
  cls: CompetitiveClassification,
  gate: CompetitiveResult["gate_trace"],
  readiness: CompetitiveReadinessState,
  confidence: ValueConfidence,
  reasons: string[],
): CompetitiveResult {
  return {
    score: 0,
    classification: cls,
    actionable: false,
    components: { our_private_gain: 0, market_edge_bonus: 0, competitive_externality: 0, uncertainty_penalty: 0 },
    gate_trace: gate,
    confidence,
    readiness,
    reason_codes: [],
    reasons,
  };
}

function round4(v: number): number {
  const x = Math.round(v * 10000) / 10000;
  return x === 0 ? 0 : x;
}
