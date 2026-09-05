/**
 * Trade Engine — Phase 5C: leverage analysis.
 *
 * Leverage here means exactly one thing: structural evidence that a
 * particular offer solves more of the OTHER roster's problems than
 * alternative offers would — never "I can force them to accept." Every
 * component is read from already-computed Phase 1/2/4 mechanics
 * (`TradeSearchProfile.needs/surpluses`, `PlayerDependency`) — nothing here
 * is a new valuation signal, and the resulting score is a SEARCH/NEGOTIATION
 * heuristic, never trade value.
 */

import type { TradeAnalysisContext } from "../context";
import type { TradeSearchProfile } from "../discovery/types";
import type { PlayerDependency, LeverageAnalysis, LeverageLevel } from "./types";

const NEED_WEIGHT: Record<string, number> = { CRITICAL: 3, HIGH: 2, MODERATE: 1, LOW: 0, NONE: 0 };

export interface LeverageInput {
  requester: TradeSearchProfile;
  partner: TradeSearchProfile;
  targetPosition: string;
  targetDependency: PlayerDependency;
  /** how many OTHER managers (besides the partner) roster a comparable-or-better asset at targetPosition — a cheap count, not a re-ranking of the whole league */
  alternativePartnerCount: number;
}

export function computeLeverage(input: LeverageInput): LeverageAnalysis {
  const { requester, partner, targetPosition, targetDependency, alternativePartnerCount } = input;
  const reasons: string[] = [];

  // need_match: does the REQUESTER'S offer plausibly fill a real partner need?
  const partnerNeedAtGivenPositions = requester.surpluses.length > 0
    ? partner.needs.filter((n) => requester.surpluses.some((s) => s.position === n.position) && (NEED_WEIGHT[n.severity] ?? 0) > 0)
    : [];
  const need_match = partnerNeedAtGivenPositions.reduce((s, n) => s + (NEED_WEIGHT[n.severity] ?? 0), 0);
  if (need_match > 0) reasons.push(`partner has real need at position(s) the requester has surplus in: ${partnerNeedAtGivenPositions.map((n) => n.position).join(", ")}`);

  // surplus_match: does the partner have declared surplus at the TARGET position (i.e., are they parting with genuine excess, not their only piece)?
  const partnerSurplusAtTarget = partner.surpluses.find((s) => s.position === targetPosition);
  const surplus_match = partnerSurplusAtTarget ? Math.min(2, partnerSurplusAtTarget.surplus_count) : 0;
  if (surplus_match > 0) reasons.push(`partner has declared surplus at ${targetPosition} (${partnerSurplusAtTarget!.surplus_count} beyond a safe backup)`);
  else reasons.push(`partner has NO declared surplus at ${targetPosition} — this is a real cost to them, not spare depth`);

  // replacement_pressure: inverse of target dependency — a CORE/IMPORTANT target gives the requester LESS leverage (owner needs them more)
  const replacement_pressure = targetDependency.dependency === "SURPLUS" ? 2 : targetDependency.dependency === "REPLACEABLE" ? 1 : 0;
  reasons.push(`target is ${targetDependency.dependency} to their current owner (${targetDependency.reasons[0] ?? ""})`);

  // alternative_partner_count: more substitutes -> more requester leverage (walk-away power), capped
  const alt = Math.min(2, alternativePartnerCount);
  if (alternativePartnerCount > 0) reasons.push(`${alternativePartnerCount} other manager(s) roster a comparable asset at ${targetPosition} — the requester is not dependent on this one partner`);

  const target_owner_depth = targetDependency.dependency === "CORE" ? 0 : targetDependency.dependency === "IMPORTANT" ? 1 : 2;

  const score = need_match + surplus_match + replacement_pressure + alt + target_owner_depth;
  const level: LeverageLevel = score >= 7 ? "HIGH" : score >= 4 ? "MODERATE" : score >= 1 ? "LOW" : "NONE";

  return {
    level,
    score,
    components: { need_match, surplus_match, replacement_pressure, alternative_partner_count: alt, target_owner_depth },
    reasons,
  };
}

/** Convenience: how many OTHER managers (excluding `excludeManagerId` and the owner) roster ANY active player at `position` — a cheap, real substitute count, not a value ranking. */
export function countAlternativePartners(ctx: TradeAnalysisContext, position: string, excludeManagerIds: string[]): number {
  let count = 0;
  for (const [managerId, roster] of ctx.rosters_by_manager) {
    if (excludeManagerIds.includes(managerId)) continue;
    const hasPosition = roster.all_players.some((id) => ctx.players_by_id.get(id)?.position === position);
    if (hasPosition) count += 1;
  }
  return count;
}
