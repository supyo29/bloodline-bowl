/**
 * Trade Engine — Phase 4G: three-team discovery.
 *
 * Searches for a complementary-need CYCLE (A -> B -> C -> A), not a brute
 * force over all triples. Uses the same profiles/fit heuristics as the
 * bilateral funnel; every surviving cycle is validated and scored by the
 * SAME canonical N-party evaluator the 2-team path uses (`evaluateTrade`
 * already supports arbitrary participant counts and routing — this module
 * does not fork a separate 3-team valuation path).
 *
 * `THREE_TEAM_HIDDEN_LOSER` is surfaced explicitly (not silently dropped)
 * when a cycle is globally attractive (positive total utility) but one
 * participant is materially negative; such a cycle still has to clear the
 * normal per-participant acceptance floor to appear in ranked results —
 * hidden-loser detection is about labeling, not a separate inclusion rule.
 */

import type { TradeAnalysisContext } from "../context";
import type { TradeConfig } from "../config";
import type { AssetValue, TradeDiscoveryResult, TradeSearchConstraints, TradeSearchProfile } from "./types";
import type { TradeSearchLimits } from "./config";
import { buildTradeSearchProfile } from "./profiles";
import { rankPartners } from "./fit";
import { evaluateCandidate, type DiscoveryEvalContext } from "./candidate-eval";
import { buildDiscoveryResult, rankResults } from "./rank";
import { isAllowedPartner, type FunnelCounters } from "./bilateral";
import { requesterUtilityFloor } from "./config";
import { weeklyVOR } from "@/lib/weekly/replacement";

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

/**
 * Audit fix (§31, candidate breadth): previously only the SINGLE best asset
 * per leg was ever tried — a cycle where a manager's second-best asset (not
 * their best) is the one that actually keeps every participant positive
 * could never be found. Returns up to `n` candidates FROM `giver`'s roster
 * AT one of `needPositions`, preferring `giver`'s own declared-surplus
 * positions, so the caller can try more than one option per leg within a
 * still-bounded total (`max_three_team_cycles`).
 */
function legAssetCandidates(giver: TradeSearchProfile, giverAssets: AssetValue[], needPositions: string[], untouchable: Set<string>, n: number): AssetValue[] {
  const surplusPos = new Set(giver.surpluses.map((s) => s.position));
  const candidates = giverAssets.filter((a) => needPositions.includes(a.position) && !untouchable.has(a.canonical_player_id));
  candidates.sort((a, b) => {
    const aSurplus = surplusPos.has(a.position) ? 1 : 0;
    const bSurplus = surplusPos.has(b.position) ? 1 : 0;
    if (aSurplus !== bSurplus) return bSurplus - aSurplus; // prefer their own surplus first
    return (b.starter_vor ?? -Infinity) - (a.starter_vor ?? -Infinity) || a.canonical_player_id.localeCompare(b.canonical_player_id);
  });
  return candidates.slice(0, n);
}

export interface ThreeTeamSearchOptions {
  ctx: TradeAnalysisContext;
  evalCtx: DiscoveryEvalContext;
  config: TradeConfig;
  myManagerId: string;
  myManagerSlug: string;
  limits: TradeSearchLimits;
  constraints?: TradeSearchConstraints;
  maxResults: number;
}

export function runThreeTeamSearch(opts: ThreeTeamSearchOptions, counters: FunnelCounters): TradeDiscoveryResult[] {
  const { ctx, evalCtx, config, myManagerId, myManagerSlug, limits, constraints } = opts;
  const untouchable = new Set(constraints?.untouchable_player_ids ?? []);

  const me = buildTradeSearchProfile(myManagerId, myManagerSlug, ctx);
  const meAssets = allAssetsFor(me, ctx);
  const otherIds = [...ctx.rosters_by_manager.keys()].filter((id) => id !== myManagerId && isAllowedPartner(id, constraints));
  const profileById = new Map<string, TradeSearchProfile>();
  const assetsById = new Map<string, AssetValue[]>();
  for (const id of otherIds) {
    const m = ctx.snapshot.managers.find((mm) => mm.canonical_manager_id === id);
    const p = buildTradeSearchProfile(id, m?.manager_slug ?? id, ctx);
    profileById.set(id, p);
    assetsById.set(id, allAssetsFor(p, ctx));
  }

  const fitB = rankPartners(me, [...profileById.values()]).slice(0, limits.max_partner_count);
  const requesterFloor = constraints?.minimum_my_utility_delta ?? requesterUtilityFloor();
  const LEG_CANDIDATES = 2; // bounded breadth per leg — see legAssetCandidates doc

  const myNeedPositions = me.needs.filter((n) => n.severity === "CRITICAL" || n.severity === "HIGH" || n.severity === "MODERATE").map((n) => n.position);

  const results: TradeDiscoveryResult[] = [];
  let cyclesEvaluated = 0;

  outer: for (const bFit of fitB) {
    const bId = bFit.partner_manager_id;
    const bProfile = profileById.get(bId)!;
    const bNeedPositions = bProfile.needs.filter((n) => n.severity === "CRITICAL" || n.severity === "HIGH" || n.severity === "MODERATE").map((n) => n.position);

    // leg 1: A -> B, filling B's need from A's assets (top-N candidates, not just the single best)
    const candidatesAB = legAssetCandidates(me, meAssets, bNeedPositions, untouchable, LEG_CANDIDATES);
    if (candidatesAB.length === 0) continue;

    for (const cId of otherIds) {
      if (cId === bId) continue;
      const cProfile = profileById.get(cId)!;
      const cNeedPositions = cProfile.needs.filter((n) => n.severity === "CRITICAL" || n.severity === "HIGH" || n.severity === "MODERATE").map((n) => n.position);
      const candidatesBC = legAssetCandidates(bProfile, assetsById.get(bId)!, cNeedPositions, untouchable, LEG_CANDIDATES);
      const candidatesCA = legAssetCandidates(cProfile, assetsById.get(cId)!, myNeedPositions, untouchable, LEG_CANDIDATES);

      for (const assetAB of candidatesAB) {
        for (const assetBC of candidatesBC) {
          if (assetBC.canonical_player_id === assetAB.canonical_player_id) continue;
          for (const assetCA of candidatesCA) {
            if (assetCA.canonical_player_id === assetAB.canonical_player_id || assetCA.canonical_player_id === assetBC.canonical_player_id) continue;
            if (cyclesEvaluated >= limits.max_three_team_cycles) break outer;

            const transfers = [
              { from_manager_id: myManagerId, to_manager_id: bId, canonical_player_id: assetAB.canonical_player_id },
              { from_manager_id: bId, to_manager_id: cId, canonical_player_id: assetBC.canonical_player_id },
              { from_manager_id: cId, to_manager_id: myManagerId, canonical_player_id: assetCA.canonical_player_id },
            ];
            const evaluated = evaluateCandidate([myManagerId, bId, cId], transfers, ctx, evalCtx, config, { requesterManagerId: myManagerId, constraints });
            cyclesEvaluated += 1;
            counters.packages_generated += 1;
            counters.packages_evaluated += 1;
            if (!evaluated.ok) {
              counters.packages_pruned += 1;
              continue;
            }
            // Audit fix (§18): a three-team cycle is never a bilateral "ONE_FOR_ONE" package —
            // it has 3 participants and 3 transfers; label it distinctly.
            const result = buildDiscoveryResult(myManagerSlug, { shape: "THREE_TEAM_CYCLE", transfers, participant_manager_ids: [myManagerId, bId, cId] }, evaluated, "THREE_TEAM", bFit.score, requesterFloor, constraints?.minimum_partner_utility_delta);
            if (!result) {
              counters.packages_pruned += 1;
              continue;
            }
            // hidden-loser surfacing: total positive but a participant materially negative
            const deltas = result.participants.map((p) => p.utility_delta);
            const total = deltas.reduce((s, v) => s + v, 0);
            if (total > 0 && Math.min(...deltas) < -1) {
              result.rationale.push("THREE_TEAM_HIDDEN_LOSER: total participant value is positive but one participant is materially worse off — verify every participant's acceptance before proposing.");
            }
            results.push(result);
          }
        }
      }
    }
  }

  counters.valid_results += results.length;
  return rankResults(results).slice(0, opts.maxResults);
}
