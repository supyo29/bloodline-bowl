/**
 * Competitive Trade Intelligence — negotiation frontier & envelope (Checkpoint E).
 *
 * Given a certified base trade and a set of ranked extraction targets, build a
 * bounded, dominance-pruned negotiation frontier, then read off four distinct
 * recommendation levels:
 *
 *   opening_offer     — the most aggressive credible offer (room to negotiate down)
 *   target_settlement — the preferred outcome (best strategic balance)
 *   acceptable_deal   — the least favourable deal we would still choose (often the base)
 *   walk_away         — the explicit boundary beyond which we reject
 *
 * `evaluateProposal` is supplied by the orchestrator — it runs a FULL
 * re-evaluation (permanent utility, perceived surplus, acceptance, opponent
 * impact, competitive externality) for each proposal (§33–§35). This module is
 * pure selection logic over those results.
 */

import type { NegotiationConfig } from "./config";
import type {
  AcceptanceLikelihood,
  CounterofferAssessment,
  NegotiationEnvelope,
  NegotiationProposal,
  NegotiationReasonCode,
  ValueConfidence,
  ValueExtraction,
} from "./schema";

const ACC_LEVEL: Record<AcceptanceLikelihood, number> = { VERY_LOW: 0, LOW: 1, MODERATE: 2, HIGH: 3 };
const CONF_LEVEL: Record<ValueConfidence, number> = { HIGH: 3, MEDIUM: 2, LOW: 1, VERY_LOW: 0 };

/** Proposal A dominates B (§44): ≥ on every axis, strictly better on ≥ 1. */
export function dominates(a: NegotiationProposal, b: NegotiationProposal): boolean {
  const au = a.our_permanent_utility ?? -Infinity;
  const bu = b.our_permanent_utility ?? -Infinity;
  const aa = a.acceptance_likelihood ? ACC_LEVEL[a.acceptance_likelihood] : -1;
  const ba = b.acceptance_likelihood ? ACC_LEVEL[b.acceptance_likelihood] : -1;
  const ae = a.competitive_externality ?? Infinity;
  const be = b.competitive_externality ?? Infinity;
  const ac = CONF_LEVEL[a.confidence];
  const bc = CONF_LEVEL[b.confidence];
  const atLeast = au >= bu - 1e-9 && aa >= ba && ae <= be + 1e-9 && ac >= bc;
  const strict = au > bu + 1e-9 || aa > ba || ae < be - 1e-9 || ac > bc;
  return atLeast && strict;
}

export interface FrontierInput {
  base: NegotiationProposal;
  extraction: ValueExtraction;
  /** FULLY re-evaluates one proposal — the orchestrator wires this to evaluateCompetitiveTrade */
  evaluateProposal: (ourAssets: string[], theirAssets: string[], label: string) => NegotiationProposal | null;
  config: NegotiationConfig;
}

export interface FrontierOutput {
  frontier: NegotiationProposal[];
  opening: NegotiationProposal | null;
  target: NegotiationProposal | null;
  acceptable: NegotiationProposal | null;
  walk_away: NegotiationEnvelope["walk_away"];
  reason_codes: NegotiationReasonCode[];
  reasons: string[];
  why_stops: string[];
}

export function buildNegotiationFrontier(input: FrontierInput): FrontierOutput {
  const { base, extraction, evaluateProposal, config } = input;
  const codes = new Set<NegotiationReasonCode>();
  const reasons: string[] = [];
  const whyStops: string[] = [];

  const evaluated: NegotiationProposal[] = [base];

  if (extraction.band === "EXTRACTION_GATED") {
    codes.add("EXTRACTION_GATED");
    reasons.push("extraction is gated — the base trade is the only recommendation");
    return {
      frontier: [base],
      opening: base,
      target: base,
      acceptable: base,
      walk_away: walkAway(base, config, null),
      reason_codes: [...codes],
      reasons,
      why_stops: ["base trade does not clear the extraction gate"],
    };
  }

  // ---- additive extraction: base + one secondary asset, in efficiency order ----
  const added: string[] = [];
  for (const asset of extraction.ranked_secondary_assets) {
    if (evaluated.length >= config.max_frontier_points) break;
    if ((asset.efficiency ?? 0) < config.min_extraction_efficiency) {
      whyStops.push(`remaining add-ons fall below the minimum extraction efficiency (${config.min_extraction_efficiency})`);
      break;
    }
    const prop = evaluateProposal(base.our_assets, [...base.their_assets, asset.canonical_player_id], `base + ${asset.name}`);
    if (!prop) continue;
    prop.reason_codes.push(...asset.reason_codes);
    prop.extraction_efficiency = asset.efficiency;
    evaluated.push(prop);
    if (asset.reason_codes.includes("SECONDARY_ASSET_WEAKENS_RIVAL")) codes.add("SECONDARY_ASSET_WEAKENS_RIVAL");

    // acceptance collapsed?
    if ((prop.acceptance_likelihood ? ACC_LEVEL[prop.acceptance_likelihood] : 0) < ACC_LEVEL.LOW) {
      prop.reason_codes.push("ACCEPTANCE_COLLAPSES_BEYOND_HERE");
      whyStops.push(`adding ${asset.name} drops acceptance below LOW — beyond the negotiation frontier`);
      break;
    }
    // bundle reservation rising sharply?
    if (
      prop.counterparty_reservation_burden != null &&
      base.counterparty_reservation_burden != null &&
      prop.counterparty_reservation_burden > base.counterparty_reservation_burden + 1.5
    ) {
      prop.reason_codes.push("BUNDLE_RESERVATION_RISES_SHARPLY");
      whyStops.push(`the counterparty's bundle reservation jumps sharply when they also give up ${asset.name}`);
    }
    added.push(asset.canonical_player_id);
  }

  // ---- one bounded bundle probe: base + best two add-ons together ----
  if (added.length >= 2 && evaluated.length < config.max_frontier_points && config.max_bundle_size >= 3) {
    const names = extraction.ranked_secondary_assets
      .filter((a) => added.slice(0, 2).includes(a.canonical_player_id))
      .map((a) => a.name);
    const prop = evaluateProposal(base.our_assets, [...base.their_assets, ...added.slice(0, 2)], `base + ${names.join(" + ")}`);
    if (prop) {
      prop.reason_codes.push("STRAIGHT_SWAP_LEAVES_VALUE_UNCAPTURED");
      evaluated.push(prop);
      if ((prop.acceptance_likelihood ? ACC_LEVEL[prop.acceptance_likelihood] : 0) < ACC_LEVEL.LOW) {
        prop.reason_codes.push("ACCEPTANCE_COLLAPSES_BEYOND_HERE");
      }
    }
  }

  // ---- dominance pruning (§44) ----
  for (const p of evaluated) {
    p.dominated = evaluated.some((other) => other !== p && dominates(other, p));
  }
  const frontier = evaluated
    .filter((p) => !p.dominated)
    .sort((a, b) => (b.our_permanent_utility ?? -Infinity) - (a.our_permanent_utility ?? -Infinity));

  // ---- envelope selection ----
  const openingMin = ACC_LEVEL[config.opening_acceptance_by_aggressiveness[extraction.aggressiveness]];
  const targetMin = ACC_LEVEL[config.minimum_target_acceptance];

  const feasible = (p: NegotiationProposal, min: number): boolean =>
    (p.acceptance_likelihood ? ACC_LEVEL[p.acceptance_likelihood] : 0) >= min &&
    p.competitive_classification !== "REJECT" &&
    p.competitive_classification !== "AVOID_COMPETITIVE_COST" &&
    (p.our_permanent_utility ?? -Infinity) >= config.minimum_private_gain;

  const openingCands = frontier.filter((p) => feasible(p, openingMin));
  const opening = openingCands.length > 0 ? openingCands[0]! : base; // highest utility that still clears the opening floor
  if (opening !== base) reasons.push(`opening offer requests more than a straight swap (${opening.label}) while still clearing the ${config.opening_acceptance_by_aggressiveness[extraction.aggressiveness]} acceptance floor`);
  else if (extraction.band !== "NO_EXTRACTION_ROOM") {
    codes.add("DO_NOT_BID_AGAINST_SELF");
    reasons.push("no add-on cleared the opening acceptance floor — opening at the base deal");
  }

  const score = (p: NegotiationProposal): number =>
    (p.our_permanent_utility ?? -Infinity) - Math.max(0, p.competitive_externality ?? 0) - (3 - CONF_LEVEL[p.confidence]) * 0.3;
  const targetCands = frontier.filter((p) => feasible(p, targetMin));
  const target = targetCands.length > 0 ? [...targetCands].sort((a, b) => score(b) - score(a))[0]! : base;

  // acceptable = the least-favourable frontier point we would still affirmatively choose
  const acceptableCands = frontier
    .filter((p) => (p.our_permanent_utility ?? -Infinity) >= config.minimum_private_gain && p.competitive_classification !== "REJECT")
    .sort((a, b) => (a.our_permanent_utility ?? Infinity) - (b.our_permanent_utility ?? Infinity));
  const acceptable = acceptableCands.length > 0 ? acceptableCands[0]! : base;

  if (opening === target && target === acceptable && extraction.band !== "NO_EXTRACTION_ROOM") {
    codes.add("LIMITED_EXTRACTION_PROTECT_BASE");
    whyStops.push("the frontier collapses to a single credible point — protect the base trade rather than risk it");
  }
  if (whyStops.length === 0) whyStops.push("all evaluated add-ons were dominated or beyond the acceptance frontier");

  return {
    frontier,
    opening,
    target,
    acceptable,
    walk_away: walkAway(acceptable, config, null),
    reason_codes: [...codes],
    reasons,
    why_stops: whyStops,
  };
}

function walkAway(
  acceptable: NegotiationProposal,
  config: NegotiationConfig,
  breakingAsset: { canonical_player_id: string; name: string } | null,
): NegotiationEnvelope["walk_away"] {
  const floor = config.minimum_private_gain;
  return {
    min_permanent_utility: floor,
    breaking_asset: breakingAsset,
    explanation: breakingAsset
      ? `Walk away if we must add ${breakingAsset.name} — it pushes our permanent rest-of-season utility below +${floor.toFixed(2)} weekly-equivalent.`
      : `Walk away if any counter would leave our permanent rest-of-season roster gain below +${floor.toFixed(2)} weekly-equivalent, or turn the competitive result to REJECT / AVOID.`,
  };
}

/**
 * Evaluate a counteroffer the counterparty proposes (they ask for more).
 * ACCEPT above the target settlement's utility, COUNTER between target and
 * walk-away, WALK_AWAY below the floor.
 */
export function classifyCounteroffer(
  countered: NegotiationProposal,
  envelope: { target_settlement: NegotiationProposal | null; walk_away: NegotiationEnvelope["walk_away"] },
  config: NegotiationConfig,
): CounterofferAssessment {
  const reasons: string[] = [];
  const u = countered.our_permanent_utility;
  const targetU = envelope.target_settlement?.our_permanent_utility ?? config.minimum_private_gain;

  let verdict: CounterofferAssessment["verdict"];
  if (u == null || u < envelope.walk_away.min_permanent_utility || countered.competitive_classification === "REJECT" || countered.competitive_classification === "AVOID_COMPETITIVE_COST") {
    verdict = "WALK_AWAY";
    reasons.push(`countered permanent utility ${u?.toFixed(2) ?? "n/a"} is below the walk-away floor ${envelope.walk_away.min_permanent_utility.toFixed(2)}`);
  } else if (u >= targetU - 1e-9) {
    verdict = "ACCEPT";
    reasons.push(`countered permanent utility ${u.toFixed(2)} is at or above the target settlement (${targetU.toFixed(2)}) — accept`);
  } else {
    verdict = "COUNTER";
    reasons.push(`countered permanent utility ${u.toFixed(2)} sits between the target settlement (${targetU.toFixed(2)}) and the walk-away floor (${envelope.walk_away.min_permanent_utility.toFixed(2)}) — counter`);
  }

  return {
    our_assets: countered.our_assets,
    their_assets: countered.their_assets,
    our_permanent_utility: u,
    verdict,
    reasons,
  };
}
