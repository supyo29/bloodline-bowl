/**
 * Trade Engine — Phase 4C: the bilateral search funnel.
 *
 * Stage 1 partner selection -> Stage 2 asset pools (profiles, already built)
 * -> Stage 3 package generation (packages.ts) -> Stage 4 canonical evaluation
 * (candidate-eval.ts) -> Stage 5 ranking (rank.ts). This file is the funnel;
 * it contains no valuation logic of its own.
 */

import type { TradeAnalysisContext } from "../context";
import type { TradeConfig } from "../config";
import type { AssetValue, SearchMode, TradeDiscoveryResult, TradeSearchConstraints, TradeSearchProfile } from "./types";
import type { TradeSearchLimits } from "./config";
import { buildTradeSearchProfile } from "./profiles";
import { rankPartners } from "./fit";
import { generateBilateralPackages } from "./packages";
import { evaluateCandidate, type DiscoveryEvalContext } from "./candidate-eval";
import { buildDiscoveryResult, rankResults } from "./rank";
import { weeklyVOR } from "@/lib/weekly/replacement";

export interface FunnelCounters {
  partners_considered: number;
  assets_considered: number;
  packages_generated: number;
  packages_pruned: number;
  packages_evaluated: number;
  valid_results: number;
}

export function emptyCounters(): FunnelCounters {
  return { partners_considered: 0, assets_considered: 0, packages_generated: 0, packages_pruned: 0, packages_evaluated: 0, valid_results: 0 };
}

function allAssetsFor(profile: TradeSearchProfile, ctx: TradeAnalysisContext): AssetValue[] {
  const roster = ctx.rosters_by_manager.get(profile.manager_id);
  if (!roster) return [];
  const reserve = new Set([...roster.ir, ...roster.taxi]);
  const starterSet = new Set(roster.starters);
  const out: AssetValue[] = [];
  for (const id of roster.all_players) {
    if (reserve.has(id)) continue;
    const p = ctx.players_by_id.get(id);
    if (!p) continue;
    const pts = ctx.projections.by_player.get(id)?.projected_points ?? null;
    const v = weeklyVOR(id, p.position, pts, ctx.replacement);
    out.push({ canonical_player_id: id, position: p.position, starter_vor: v.vor, projected_points: pts, is_current_starter: starterSet.has(id) });
  }
  return out;
}

export function isAllowedPartner(partnerId: string, constraints?: TradeSearchConstraints): boolean {
  if (constraints?.allowed_trade_partner_ids && constraints.allowed_trade_partner_ids.length > 0) {
    if (!constraints.allowed_trade_partner_ids.includes(partnerId)) return false;
  }
  if (constraints?.excluded_trade_partner_ids?.includes(partnerId)) return false;
  return true;
}

export interface BilateralSearchOptions {
  ctx: TradeAnalysisContext;
  evalCtx: DiscoveryEvalContext;
  config: TradeConfig;
  mode: SearchMode;
  myManagerId: string;
  myManagerSlug: string;
  limits: TradeSearchLimits;
  constraints?: TradeSearchConstraints;
  maxResults: number;
  /** POSITIONAL_NEED: restrict search to this position only */
  targetPositions?: string[];
}

export function runBilateralSearch(opts: BilateralSearchOptions): { results: TradeDiscoveryResult[]; counters: FunnelCounters } {
  const counters = emptyCounters();
  const { ctx, evalCtx, config, mode, myManagerId, myManagerSlug, limits, constraints } = opts;

  const me = buildTradeSearchProfile(myManagerId, myManagerSlug, ctx);
  const otherManagerIds = [...ctx.rosters_by_manager.keys()].filter((id) => id !== myManagerId && isAllowedPartner(id, constraints));
  const others = otherManagerIds.map((id) => {
    const m = ctx.snapshot.managers.find((mm) => mm.canonical_manager_id === id);
    return buildTradeSearchProfile(id, m?.manager_slug ?? id, ctx);
  });

  const fits = rankPartners(me, others).slice(0, limits.max_partner_count);
  counters.partners_considered = fits.length;

  const meAllAssets = allAssetsFor(me, ctx);
  counters.assets_considered += meAllAssets.length;

  const results: TradeDiscoveryResult[] = [];
  for (const fit of fits) {
    const partner = others.find((o) => o.manager_id === fit.partner_manager_id)!;
    const partnerAllAssets = allAssetsFor(partner, ctx);
    counters.assets_considered += partnerAllAssets.length;

    const packages = generateBilateralPackages({
      me, partner, meAllAssets, partnerAllAssets, constraints, limits, targetPositions: opts.targetPositions,
    });
    counters.packages_generated += packages.length;

    for (const pkg of packages) {
      if (counters.packages_evaluated >= limits.max_evaluated_candidates) {
        counters.packages_pruned += 1;
        continue;
      }
      const evaluated = evaluateCandidate(pkg.participant_manager_ids, pkg.transfers, ctx, evalCtx, config);
      counters.packages_evaluated += 1;
      if (!evaluated.ok) {
        counters.packages_pruned += 1;
        continue;
      }
      const result = buildDiscoveryResult(myManagerSlug, pkg, evaluated, mode, fit.score, constraints?.minimum_my_utility_delta, constraints?.minimum_partner_utility_delta);
      if (!result) {
        counters.packages_pruned += 1;
        continue;
      }
      results.push(result);
    }
  }

  counters.valid_results = results.length;
  const ranked = rankResults(results).slice(0, opts.maxResults);
  return { results: ranked, counters };
}
