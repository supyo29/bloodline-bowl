/**
 * Trade Engine — Phase 4B: partner-fit matrix.
 *
 * A cheap, deterministic heuristic used ONLY to prioritize which partners are
 * worth generating packages for (Stage 1 of the bilateral funnel). It is
 * NEVER part of a trade's final value — that comes only from `evaluateTrade`.
 */

import type { PartnerFitLevel, PartnerFitScore, TradeSearchProfile } from "./types";

/** How much a need severity is "worth" satisfying, for the cheap fit heuristic only. */
const NEED_WEIGHT: Record<string, number> = { CRITICAL: 3, HIGH: 2, MODERATE: 1, LOW: 0, NONE: 0 };

export function computePartnerFit(me: TradeSearchProfile, partner: TradeSearchProfile): PartnerFitScore {
  const reasons: string[] = [];

  // need_complementarity: my needs that partner's surplus can fill
  const partnerSurplusPos = new Map(partner.surpluses.map((s) => [s.position, s.surplus_count]));
  let needComplementarity = 0;
  for (const n of me.needs) {
    const w = NEED_WEIGHT[n.severity] ?? 0;
    if (w === 0) continue;
    const surplus = partnerSurplusPos.get(n.position) ?? 0;
    if (surplus > 0) {
      needComplementarity += w;
      reasons.push(`partner has ${n.position} surplus while I have ${n.severity} need at ${n.position}`);
    }
  }

  // surplus_complementarity: partner's needs that MY surplus can fill (symmetric — makes the deal attractive to them too)
  const mySurplusPos = new Map(me.surpluses.map((s) => [s.position, s.surplus_count]));
  let surplusComplementarity = 0;
  for (const n of partner.needs) {
    const w = NEED_WEIGHT[n.severity] ?? 0;
    if (w === 0) continue;
    const surplus = mySurplusPos.get(n.position) ?? 0;
    if (surplus > 0) {
      surplusComplementarity += w;
      reasons.push(`I have ${n.position} surplus while partner has ${n.severity} need at ${n.position}`);
    }
  }

  const score = needComplementarity + surplusComplementarity;
  const level: PartnerFitLevel = score >= 4 ? "HIGH" : score >= 1 ? "MODERATE" : "LOW";
  return { partner_manager_id: partner.manager_id, score, level, need_complementarity: needComplementarity, surplus_complementarity: surplusComplementarity, reasons };
}

/** Ranks every other manager's fit vs. `me`, descending by score, deterministic tie-break by manager_id. */
export function rankPartners(me: TradeSearchProfile, others: TradeSearchProfile[]): PartnerFitScore[] {
  return others
    .map((p) => computePartnerFit(me, p))
    .sort((a, b) => b.score - a.score || a.partner_manager_id.localeCompare(b.partner_manager_id));
}
