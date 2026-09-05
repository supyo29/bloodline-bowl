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
import { requesterUtilityFloor } from "./config";
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
  maxAssetsPerSide?: number;
}

export interface BilateralSearchDiagnostic {
  code: string;
  message: string;
  severity: "info" | "warning" | "error";
}

export function runBilateralSearch(opts: BilateralSearchOptions): { results: TradeDiscoveryResult[]; counters: FunnelCounters; diagnostics: BilateralSearchDiagnostic[] } {
  const counters = emptyCounters();
  const diagnostics: BilateralSearchDiagnostic[] = [];
  const { ctx, evalCtx, config, mode, myManagerId, myManagerSlug, limits, constraints } = opts;

  const me = buildTradeSearchProfile(myManagerId, myManagerSlug, ctx);
  const allOtherManagerIds = [...ctx.rosters_by_manager.keys()].filter((id) => id !== myManagerId && isAllowedPartner(id, constraints));
  const profileById = new Map(allOtherManagerIds.map((id) => {
    const m = ctx.snapshot.managers.find((mm) => mm.canonical_manager_id === id);
    return [id, buildTradeSearchProfile(id, m?.manager_slug ?? id, ctx)] as const;
  }));

  const requesterFloor = constraints?.minimum_my_utility_delta ?? requesterUtilityFloor();
  const meAllAssets = allAssetsFor(me, ctx);
  counters.assets_considered += meAllAssets.length;

  const results: TradeDiscoveryResult[] = [];

  const searchPartner = (partnerId: string, fitScore: number | null, evalBudget: number): void => {
    const partner = profileById.get(partnerId)!;
    const partnerAllAssets = allAssetsFor(partner, ctx);
    counters.assets_considered += partnerAllAssets.length;

    const packages = generateBilateralPackages({
      me, partner, meAllAssets, partnerAllAssets, constraints, limits, targetPositions: opts.targetPositions, maxAssetsPerSide: opts.maxAssetsPerSide,
    });
    counters.packages_generated += packages.length;

    for (const pkg of packages) {
      if (counters.packages_evaluated >= evalBudget) {
        counters.packages_pruned += 1;
        continue;
      }
      const evaluated = evaluateCandidate(pkg.participant_manager_ids, pkg.transfers, ctx, evalCtx, config, { requesterManagerId: myManagerId, constraints });
      counters.packages_evaluated += 1;
      if (!evaluated.ok) {
        counters.packages_pruned += 1;
        continue;
      }
      const result = buildDiscoveryResult(myManagerSlug, pkg, evaluated, mode, fitScore, requesterFloor, constraints?.minimum_partner_utility_delta);
      if (!result) {
        counters.packages_pruned += 1;
        continue;
      }
      results.push(result);
    }
  };

  // ---- Pass 1: top-fit partners only (the cheap heuristic prioritization) ----
  // Audit fix (§14/§16/§17): Pass 1 is capped at a FRACTION of the total
  // evaluation budget, not the whole thing — a handful of top-fit partners
  // each offering several package shapes can otherwise exhaust
  // `max_evaluated_candidates` before Pass 2 ever gets a chance to run,
  // silently defeating the fallback below even though "budget remained" in
  // name only. Reserving budget for Pass 2 up front is what actually
  // prevents top-K starvation, not just the existence of a fallback branch.
  const pass1Budget = Math.max(1, Math.floor(limits.max_evaluated_candidates * 0.75));
  const allFits = rankPartners(me, [...profileById.values()]);
  const topFits = allFits.slice(0, limits.max_partner_count);
  counters.partners_considered = topFits.length;
  for (const fit of topFits) searchPartner(fit.partner_manager_id, fit.score, pass1Budget);

  // ---- Pass 2 (audit fix §14): fallback to the REMAINING partners when Pass 1 found
  // nothing — a low partner-fit score must not silently starve the search when it's
  // the only manager with an actual workable deal. Bounded by the RESERVED remainder
  // of the evaluated-candidate budget; never a second unbounded pass.
  const searchedIds = new Set(topFits.map((f) => f.partner_manager_id));
  const remainingIds = allFits.filter((f) => !searchedIds.has(f.partner_manager_id)).map((f) => f.partner_manager_id);
  if (results.length === 0 && remainingIds.length > 0 && counters.packages_evaluated < limits.max_evaluated_candidates) {
    diagnostics.push({ code: "PARTNER_POOL_FALLBACK_USED", message: `No candidate survived the top ${limits.max_partner_count} fit-ranked partner(s) — expanded the search to the remaining ${remainingIds.length} manager(s).`, severity: "info" });
    counters.partners_considered += remainingIds.length;
    for (const id of remainingIds) {
      if (counters.packages_evaluated >= limits.max_evaluated_candidates) break;
      searchPartner(id, null, limits.max_evaluated_candidates);
    }
  } else if (remainingIds.length > 0) {
    diagnostics.push({ code: "PARTNER_POOL_TRUNCATED", message: `${remainingIds.length} lower-fit manager(s) were not searched (max_partner_count=${limits.max_partner_count}) — this is NOT a claim that no better deal exists with them.`, severity: "info" });
  }

  counters.valid_results = results.length;
  const ranked = rankResults(results).slice(0, opts.maxResults);
  return { results: ranked, counters, diagnostics };
}
