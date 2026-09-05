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
 * Selects the 4 named tiers from a Pareto frontier. `my_gain` IS the
 * requester's benefit — "cheapest for the requester" means the HIGHEST
 * `my_gain`, not the lowest. (Audit fix, §4/§15/§18/§19: the original
 * implementation had OPENING and MAXIMUM_RATIONAL EXACTLY BACKWARDS — it
 * picked the LOWEST `my_gain` for "OPENING" and the HIGHEST for "MAXIMUM_RATIONAL,"
 * the reverse of both terms' meaning. Verified against the audit's own worked
 * example: offers at my_gain = 5, 2, 0.1, -0.1 — the requester should open
 * with the +5 package (least generous, cheapest for them) and treat +0.1 as
 * the maximum they'd rationally still extend (the least-generous candidate
 * REMAINING once cost has climbed as high as still makes sense) — the -0.1
 * offer never even reaches this stage, since it fails the requester's own
 * positive-utility floor upstream in `evaluateCandidate`/`buildDiscoveryResult`.)
 *
 *   OPENING          — HIGHEST my_gain on the frontier (the package that costs the
 *                       requester the LEAST while still clearing the partner's floor —
 *                       the correct thing to offer FIRST).
 *   BALANCED         — closest to equal requester/partner utility.
 *   STRONG_ACCEPT    — highest partner utility while requester utility stays positive.
 *   MAXIMUM_RATIONAL — LOWEST my_gain on the frontier (the most the requester should
 *                       give up while their own utility is still positive — the
 *                       far, expensive end of what's still rational for them).
 * All four may collapse to fewer distinct entries on a thin frontier — never fabricated.
 */
export function selectOfferTiers(frontier: TradeDiscoveryResult[], myManagerSlug: string): Partial<Record<OfferTier, TradeDiscoveryResult>> {
  if (frontier.length === 0) return {};
  const withPartner = frontier.map((r) => ({ r, partner: partnerUtility(r, myManagerSlug) }));

  const opening = [...withPartner].sort((a, b) => b.r.my_gain - a.r.my_gain || a.r.transfers.length - b.r.transfers.length)[0]!.r;
  const balanced = [...withPartner].sort((a, b) => Math.abs(a.r.my_gain - a.partner) - Math.abs(b.r.my_gain - b.partner))[0]!.r;
  const strongAcceptCandidates = withPartner.filter((x) => x.r.my_gain > 0);
  const strong_accept = (strongAcceptCandidates.length > 0 ? strongAcceptCandidates : withPartner).sort((a, b) => b.partner - a.partner)[0]!.r;
  const maximum_rational = [...withPartner].sort((a, b) => a.r.my_gain - b.r.my_gain)[0]!.r;

  const out: Partial<Record<OfferTier, TradeDiscoveryResult>> = {};
  out.OPENING = opening;
  if (balanced !== opening) out.BALANCED = balanced;
  if (strong_accept !== opening && strong_accept !== balanced) out.STRONG_ACCEPT = strong_accept;
  if (maximum_rational !== opening && maximum_rational !== balanced && maximum_rational !== strong_accept) out.MAXIMUM_RATIONAL = maximum_rational;
  return out;
}
