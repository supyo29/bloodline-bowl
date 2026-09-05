/**
 * Trade Engine — Phase 5I: Pareto-frontier filtering and offer-tier selection.
 *
 * An offer is DOMINATED if another candidate is at least as good for the
 * requester, at least as good for the partner, and no more complex — with at
 * least one strict improvement. Dominated offers are removed from the
 * primary ladder (kept available as diagnostics, never silently discarded
 * from the response entirely). This gives each ladder tier an actual
 * mathematical basis instead of an arbitrary pick.
 */

import type { TradeDiscoveryResult, OfferTier } from "./types";

function partnerUtility(r: TradeDiscoveryResult, myManagerSlug: string): number {
  const partners = r.participants.filter((p) => p.manager_slug !== myManagerSlug);
  if (partners.length === 0) return r.my_gain;
  return Math.min(...partners.map((p) => p.utility_delta));
}

function dominates(a: TradeDiscoveryResult, b: TradeDiscoveryResult, myManagerSlug: string): boolean {
  const aMy = a.my_gain, bMy = b.my_gain;
  const aP = partnerUtility(a, myManagerSlug), bP = partnerUtility(b, myManagerSlug);
  const aC = a.search_metadata.complexity, bC = b.search_metadata.complexity;
  const atLeastAsGood = aMy >= bMy && aP >= bP && aC <= bC;
  const strictlyBetter = aMy > bMy || aP > bP || aC < bC;
  return atLeastAsGood && strictlyBetter;
}

/** Removes every dominated candidate — O(n²) over a small (already-bounded) candidate set. */
export function paretoFrontier(candidates: TradeDiscoveryResult[], myManagerSlug: string): TradeDiscoveryResult[] {
  return candidates.filter((c) => !candidates.some((other) => other !== c && dominates(other, c, myManagerSlug)));
}

/**
 * Selects the 4 named tiers from a Pareto frontier:
 *   OPENING          — lowest requester cost (lowest my_gain among frontier survivors — i.e. the
 *                       cheapest package that's STILL on the frontier, not the worst possible one)
 *   BALANCED         — closest to equal requester/partner utility
 *   STRONG_ACCEPT    — highest partner utility while requester utility stays positive
 *   MAXIMUM_RATIONAL — highest requester utility on the frontier (the most the requester
 *                      should consider paying without violating their own floor)
 * All four may collapse to fewer distinct entries on a thin frontier — never fabricated.
 */
export function selectOfferTiers(frontier: TradeDiscoveryResult[], myManagerSlug: string): Partial<Record<OfferTier, TradeDiscoveryResult>> {
  if (frontier.length === 0) return {};
  const withPartner = frontier.map((r) => ({ r, partner: partnerUtility(r, myManagerSlug) }));

  const opening = [...withPartner].sort((a, b) => a.r.my_gain - b.r.my_gain || a.r.transfers.length - b.r.transfers.length)[0]!.r;
  const balanced = [...withPartner].sort((a, b) => Math.abs(a.r.my_gain - a.partner) - Math.abs(b.r.my_gain - b.partner))[0]!.r;
  const strongAcceptCandidates = withPartner.filter((x) => x.r.my_gain > 0);
  const strong_accept = (strongAcceptCandidates.length > 0 ? strongAcceptCandidates : withPartner).sort((a, b) => b.partner - a.partner)[0]!.r;
  const maximum_rational = [...withPartner].sort((a, b) => b.r.my_gain - a.r.my_gain)[0]!.r;

  const out: Partial<Record<OfferTier, TradeDiscoveryResult>> = {};
  out.OPENING = opening;
  if (balanced !== opening) out.BALANCED = balanced;
  if (strong_accept !== opening && strong_accept !== balanced) out.STRONG_ACCEPT = strong_accept;
  if (maximum_rational !== opening && maximum_rational !== balanced && maximum_rational !== strong_accept) out.MAXIMUM_RATIONAL = maximum_rational;
  return out;
}
