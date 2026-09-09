/**
 * Competitive Trade Intelligence — the discovery BOUNDARY (Checkpoint B).
 *
 * The legacy discovery funnel has two conceptually different stages that were
 * only ever run back-to-back:
 *
 *   A. STRUCTURAL  — real managers? real ownership? structurally valid? legal
 *                    roster states? private roster economics computable?
 *                    ⇒ `evaluateCandidate` (`discovery/candidate-eval.ts`)
 *
 *   B. LEGACY MUTUAL-BENEFIT VIABILITY — does EVERY participant improve /
 *                    clear the partner acceptance floor / fairness imbalance?
 *                    ⇒ `buildDiscoveryResult` (`discovery/rank.ts`) +
 *                      `classifyViability` (`evaluate.ts`)
 *
 * The competitive engine must consume candidates AFTER (A) but BEFORE (B) —
 * otherwise it silently inherits "opponent private gain ≥ threshold" as a
 * prerequisite and can never see the asymmetric trades it exists to find.
 *
 * This module reuses the EXACT legacy structural machinery — no funnel is
 * duplicated: `buildTradeSearchProfile`, `allAssetsFor`, `generateBilateralPackages`
 * and `evaluateCandidate` are all imported from `discovery/*`. It simply stops
 * before stage (B).
 */

import type { TradeAnalysisContext } from "../context";
import type { TradeConfig } from "../config";
import { buildTradeSearchProfile } from "../discovery/profiles";
import { allAssetsFor } from "../discovery/bilateral";
import { generateBilateralPackages } from "../discovery/packages";
import {
  buildDiscoveryEvalContext,
  evaluateCandidate,
  type DiscoveryEvalContext,
} from "../discovery/candidate-eval";
import { DEFAULT_SEARCH_LIMITS } from "../discovery/config";
import { partnerAcceptanceFloor, acceptanceAtLeast } from "../discovery/config";
import type { TradeEvaluationOutput } from "../evaluate";
import type { CandidatePackage } from "../discovery/types";

export interface StructuralCandidate {
  package: CandidatePackage;
  evaluation: TradeEvaluationOutput;
  /** requester's authoritative (Phase 2 when present, else Phase 1) utility delta */
  my_utility_delta: number;
  /** worst non-requester participant's authoritative utility delta */
  min_opponent_utility_delta: number;
}

export interface GenerateStructuralCandidatesInput {
  ctx: TradeAnalysisContext;
  config: TradeConfig;
  my_manager_id: string;
  /** limit which partners to search (defaults to all other managers) */
  partner_manager_ids?: string[];
  /** POSITIONAL_NEED-style position restriction */
  target_positions?: string[];
  max_assets_per_side?: number;
  /** hard cap on candidates evaluated (perf) — defaults to the legacy search budget */
  max_evaluated?: number;
}

export interface GenerateStructuralCandidatesResult {
  candidates: StructuralCandidate[];
  evaluated: number;
  pruned_structural: number;
}

function authoritativeUtility(r: {
  roster_utility_delta: number;
  phase2?: { contextual_utility_delta: number };
}): number {
  return r.phase2 ? r.phase2.contextual_utility_delta : r.roster_utility_delta;
}

/**
 * Generate every STRUCTURALLY valid, privately-evaluated bilateral candidate
 * for `my_manager_id` — with NO mutual-benefit / partner-acceptance / fairness
 * filter. The only rejection here is structural: `evaluateCandidate` returning
 * `ok: false` (illegal ownership, duplicate asset, roster-size violation, …).
 */
export function generateStructuralTradeCandidates(
  input: GenerateStructuralCandidatesInput,
): GenerateStructuralCandidatesResult {
  const { ctx, config, my_manager_id } = input;
  const evalCtx: DiscoveryEvalContext = buildDiscoveryEvalContext(ctx);
  const limits = DEFAULT_SEARCH_LIMITS;
  const maxEvaluated = input.max_evaluated ?? limits.max_evaluated_candidates;

  const me = buildTradeSearchProfile(
    my_manager_id,
    ctx.snapshot.managers.find((m) => m.canonical_manager_id === my_manager_id)?.manager_slug ?? my_manager_id,
    ctx,
  );
  const meAllAssets = allAssetsFor(me, ctx);

  const partnerIds = (
    input.partner_manager_ids ?? [...ctx.rosters_by_manager.keys()].filter((id) => id !== my_manager_id)
  ).filter((id) => id !== my_manager_id);

  const candidates: StructuralCandidate[] = [];
  let evaluated = 0;
  let prunedStructural = 0;

  for (const partnerId of partnerIds) {
    if (evaluated >= maxEvaluated) break;
    const partner = buildTradeSearchProfile(
      partnerId,
      ctx.snapshot.managers.find((m) => m.canonical_manager_id === partnerId)?.manager_slug ?? partnerId,
      ctx,
    );
    const partnerAllAssets = allAssetsFor(partner, ctx);

    const packages = generateBilateralPackages({
      me,
      partner,
      meAllAssets,
      partnerAllAssets,
      constraints: undefined,
      limits,
      targetPositions: input.target_positions,
      maxAssetsPerSide: input.max_assets_per_side,
    });

    for (const pkg of packages) {
      if (evaluated >= maxEvaluated) break;
      const res = evaluateCandidate(pkg.participant_manager_ids, pkg.transfers, ctx, evalCtx, config);
      evaluated += 1;
      if (!res.ok || !res.evaluation) {
        prunedStructural += 1;
        continue;
      }
      const entries = Object.values(res.evaluation.participants);
      const mine = entries.find((r) => r.manager_slug === me.manager_slug);
      if (!mine) {
        prunedStructural += 1;
        continue;
      }
      const others = entries.filter((r) => r !== mine);
      candidates.push({
        package: pkg,
        evaluation: res.evaluation,
        my_utility_delta: authoritativeUtility(mine),
        min_opponent_utility_delta:
          others.length > 0 ? Math.min(...others.map(authoritativeUtility)) : authoritativeUtility(mine),
      });
    }
  }

  return { candidates, evaluated, pruned_structural: prunedStructural };
}

/**
 * Pure predicate mirroring exactly what the LEGACY gate (`buildDiscoveryResult`)
 * would decide for a candidate under a given search mode. Used by the
 * discovery-boundary regression to prove: legacy REJECTS an asymmetric
 * "we gain / opponent loses" candidate that the structural stage RETAINS.
 *
 * Returns `true` when the legacy mutual-benefit path would KEEP the candidate.
 */
export function legacyMutualBenefitWouldKeep(
  evaluation: TradeEvaluationOutput,
  myManagerSlug: string,
  mode: string,
  opts: { minimum_my_utility?: number; minimum_partner_utility?: number } = {},
): boolean {
  const entries = Object.values(evaluation.participants);
  const mine = entries.find((r) => r.manager_slug === myManagerSlug);
  if (!mine) return false;
  const others = entries.filter((r) => r !== mine);
  const myU = authoritativeUtility(mine);
  if (opts.minimum_my_utility != null && myU < opts.minimum_my_utility) return false;

  const floor = partnerAcceptanceFloor(mode);
  for (const o of others) {
    const acc = o.phase2 ? o.phase2.contextual_acceptance : o.acceptance;
    if (!acceptanceAtLeast(acc, floor)) return false;
    if (opts.minimum_partner_utility != null && authoritativeUtility(o) < opts.minimum_partner_utility) return false;
  }
  return true;
}
