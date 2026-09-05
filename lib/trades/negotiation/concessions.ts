/**
 * Trade Engine — Phase 5D: concession and sweetener intelligence.
 *
 * Every candidate variant here is a REAL package run through the same
 * `evaluateCandidate` (`lib/trades/discovery/candidate-eval.ts`) every other
 * phase uses. `concession_efficiency` is a transparent ratio over two
 * already-canonical numbers — never a new valuation model.
 */

import type { TradeAnalysisContext } from "../context";
import type { TradeConfig } from "../config";
import { evaluateCandidate, type DiscoveryEvalContext } from "../discovery/candidate-eval";
import { buildDiscoveryResult } from "../discovery/rank";
import { buildTradeSearchProfile } from "../discovery/profiles";
import type { TradeDiscoveryResult } from "../discovery/types";
import type { SweetenerCandidate, SweetenerClass } from "./types";
import { SWEETENER_THRESHOLDS } from "./config";

/**
 * Audit fix (§24/§25): a requester cost of exactly (or near) zero previously
 * still computed `gain / cost`, which either divides by zero or, for a small
 * positive cost like 0.001, produces an "exploded" ratio (e.g. 1000) that is
 * not a stable or meaningful number even though it happens to be finite.
 * `MIN_MEANINGFUL_COST` treats anything at or below it (INCLUDING a negative
 * cost — a genuine win-win addition, §25) as a case where a ratio isn't
 * computed at all; `classifySweetener` checks `cost <= cheap_max_cost` BEFORE
 * looking at `efficiency`, so these cases are still correctly classified
 * `CHEAP` regardless of the (now `null`) efficiency value.
 */
export const MIN_MEANINGFUL_COST = 0.05;

/**
 * Given a requester cost, computes the (possibly null) efficiency ratio using
 * the same near-zero-denominator guard `findSweeteners` applies internally.
 * Exported so the audit's exact boundary numbers (§24) can be unit-tested
 * directly, without depending on a full canonical-evaluation fixture hitting
 * a razor-thin cost value by chance.
 */
export function computeSweetenerEfficiency(requester_utility_cost: number, partner_utility_gain: number): number | null {
  return partner_utility_gain > 0 && requester_utility_cost > MIN_MEANINGFUL_COST ? Math.round((partner_utility_gain / requester_utility_cost) * 100) / 100 : null;
}

export function classifySweetener(cost: number, gain: number, efficiency: number | null): SweetenerClass {
  if (gain <= 0) return "DO_NOT_ADD";
  if (cost <= SWEETENER_THRESHOLDS.cheap_max_cost) return "CHEAP"; // covers cost <= 0 (win-win / free) too — checked before efficiency
  if (efficiency != null && efficiency >= SWEETENER_THRESHOLDS.efficient_min_ratio) return "EFFICIENT";
  if (efficiency != null && efficiency >= SWEETENER_THRESHOLDS.meaningful_min_ratio) return "MEANINGFUL";
  return "EXPENSIVE";
}

export interface SweetenerSearchInput {
  ctx: TradeAnalysisContext;
  evalCtx: DiscoveryEvalContext;
  config: TradeConfig;
  myManagerId: string;
  myManagerSlug: string;
  baseTransfers: Array<{ from_manager_id: string; to_manager_id: string; canonical_player_id: string }>;
  partnerManagerId: string;
  maxCandidates: number;
}

/**
 * Finds candidate sweeteners: one additional asset from the requester's
 * expendable pool, added to `baseTransfers`, evaluated for real. Never
 * assumes the highest-value bench player is best — every candidate is
 * measured by concession_efficiency, not raw value.
 */
export function findSweeteners(input: SweetenerSearchInput): SweetenerCandidate[] {
  const { ctx, evalCtx, config, myManagerId, myManagerSlug, baseTransfers, partnerManagerId, maxCandidates } = input;
  const baseline = evaluateCandidate([myManagerId, partnerManagerId], baseTransfers, ctx, evalCtx, config);
  if (!baseline.ok || !baseline.evaluation) return [];
  const baseMine = Object.values(baseline.evaluation.participants).find((p) => p.manager_slug === myManagerSlug);
  const basePartner = Object.values(baseline.evaluation.participants).find((p) => p.manager_slug !== myManagerSlug);
  if (!baseMine || !basePartner) return [];
  const baseMyUtility = baseMine.phase2 ? baseMine.phase2.contextual_utility_delta : baseMine.roster_utility_delta;
  const basePartnerUtility = basePartner.phase2 ? basePartner.phase2.contextual_utility_delta : basePartner.roster_utility_delta;

  const profile = buildTradeSearchProfile(myManagerId, myManagerSlug, ctx);
  const inDeal = new Set(baseTransfers.map((t) => t.canonical_player_id));
  const pool = profile.expendable_assets.filter((a) => !inDeal.has(a.canonical_player_id)).slice(0, maxCandidates);

  const out: SweetenerCandidate[] = [];
  for (const asset of pool) {
    const variant = [...baseTransfers, { from_manager_id: myManagerId, to_manager_id: partnerManagerId, canonical_player_id: asset.canonical_player_id }];
    const evaluated = evaluateCandidate([myManagerId, partnerManagerId], variant, ctx, evalCtx, config);
    if (!evaluated.ok || !evaluated.evaluation) continue;
    const mine = Object.values(evaluated.evaluation.participants).find((p) => p.manager_slug === myManagerSlug)!;
    const partnerR = Object.values(evaluated.evaluation.participants).find((p) => p.manager_slug !== myManagerSlug)!;
    const myUtility = mine.phase2 ? mine.phase2.contextual_utility_delta : mine.roster_utility_delta;
    const partnerUtility = partnerR.phase2 ? partnerR.phase2.contextual_utility_delta : partnerR.roster_utility_delta;
    // SIGNED, never clamped — a negative cost means this addition improved the
    // requester TOO (a genuine win-win), which is real information a Math.max(0, ...)
    // clamp would have silently destroyed (audit fix §25).
    const requester_utility_cost = Math.round((baseMyUtility - myUtility) * 100) / 100;
    const partner_utility_gain = Math.round((partnerUtility - basePartnerUtility) * 100) / 100;
    const efficiency = computeSweetenerEfficiency(requester_utility_cost, partner_utility_gain);
    const result = buildDiscoveryResult(myManagerSlug, { shape: "TWO_FOR_ONE", transfers: variant, participant_manager_ids: [myManagerId, partnerManagerId] }, evaluated, "BEST_AVAILABLE", null, undefined, undefined);
    out.push({
      canonical_player_id: asset.canonical_player_id,
      requester_utility_cost,
      partner_utility_gain,
      concession_efficiency: efficiency,
      sweetener_class: classifySweetener(requester_utility_cost, partner_utility_gain, efficiency),
      resulting_offer: result,
    });
  }
  // Audit fix: sorting purely by `concession_efficiency` sent every `null`-efficiency
  // sweetener (which includes the BEST case — free or win-win, cost <= MIN_MEANINGFUL_COST)
  // to the bottom, since `null` was treated as `-Infinity`. Rank by CLASS first
  // (CHEAP is always at least as good as EFFICIENT is at least as good as
  // MEANINGFUL...), then by efficiency within a class.
  const classRank: Record<SweetenerClass, number> = { CHEAP: 0, EFFICIENT: 1, MEANINGFUL: 2, EXPENSIVE: 3, DO_NOT_ADD: 4 };
  return out.sort((a, b) => classRank[a.sweetener_class] - classRank[b.sweetener_class] || (b.concession_efficiency ?? 0) - (a.concession_efficiency ?? 0));
}

/**
 * Overpay reduction (§21): tries removing each REQUESTER-outgoing asset from
 * a package, keeping the one removal (if any) that still clears the
 * partner's acceptance floor while improving requester utility. Returns the
 * single best legal reduction, or null if none exists (every asset is load-bearing).
 */
export function findOverpayReduction(
  ctx: TradeAnalysisContext,
  evalCtx: DiscoveryEvalContext,
  config: TradeConfig,
  myManagerId: string,
  myManagerSlug: string,
  partnerManagerId: string,
  transfers: Array<{ from_manager_id: string; to_manager_id: string; canonical_player_id: string }>,
): TradeDiscoveryResult | null {
  const outgoing = transfers.filter((t) => t.from_manager_id === myManagerId);
  if (outgoing.length <= 1) return null; // nothing to remove while keeping the deal meaningful

  const baseline = evaluateCandidate([myManagerId, partnerManagerId], transfers, ctx, evalCtx, config);
  if (!baseline.ok || !baseline.evaluation) return null;
  const baseMine = Object.values(baseline.evaluation.participants).find((p) => p.manager_slug === myManagerSlug);
  const baseMyUtility = baseMine ? (baseMine.phase2 ? baseMine.phase2.contextual_utility_delta : baseMine.roster_utility_delta) : -Infinity;

  let best: { result: TradeDiscoveryResult; myUtility: number } | null = null;
  for (const asset of outgoing) {
    const variant = transfers.filter((t) => t !== asset);
    const evaluated = evaluateCandidate([myManagerId, partnerManagerId], variant, ctx, evalCtx, config);
    if (!evaluated.ok || !evaluated.evaluation) continue;
    const result = buildDiscoveryResult(myManagerSlug, { shape: variant.length <= 2 ? "ONE_FOR_ONE" : "TWO_FOR_ONE", transfers: variant, participant_manager_ids: [myManagerId, partnerManagerId] }, evaluated, "BEST_AVAILABLE", null, undefined, undefined);
    if (!result) continue; // removal broke the partner's acceptance floor — not a legal reduction
    if (result.my_gain <= baseMyUtility) continue; // must actually IMPROVE the requester, not just be legal
    if (!best || result.my_gain > best.myUtility) best = { result, myUtility: result.my_gain };
  }
  return best?.result ?? null;
}
