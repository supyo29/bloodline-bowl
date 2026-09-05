/**
 * Trade Engine — Phase 4C: bounded, deterministic package generation.
 *
 * Generates CANDIDATE transfer sets only — every candidate is later validated
 * and scored by the real canonical evaluator (`candidate-eval.ts`). Nothing
 * here decides whether a trade is good; it only decides what's worth trying.
 *
 * Bounded by construction: every pool this module reads from a profile is
 * already capped (`profiles.ts` caps `premium_assets`/`expendable_assets` at
 * 8), and every nested loop below is additionally capped by `limits.max_assets_per_pool`.
 * No powerset enumeration of a full roster ever occurs.
 *
 * Package shapes implemented this phase: ONE_FOR_ONE, TWO_FOR_ONE,
 * ONE_FOR_TWO. 2-for-2 / 3-for-1 / 1-for-3 are explicitly deferred — see
 * docs/TRADE_ENGINE_PHASE4.md "Remaining limitations" — rather than
 * half-implemented.
 */

import type { AssetValue, CandidatePackage, TradeSearchConstraints, TradeSearchProfile } from "./types";
import type { TradeSearchLimits } from "./config";

function sortDesc(a: AssetValue, b: AssetValue): number {
  return (b.starter_vor ?? -Infinity) - (a.starter_vor ?? -Infinity) || a.canonical_player_id.localeCompare(b.canonical_player_id);
}

function applyUntouchables(assets: AssetValue[], constraints?: TradeSearchConstraints): AssetValue[] {
  const untouchable = new Set(constraints?.untouchable_player_ids ?? []);
  return assets.filter((a) => !untouchable.has(a.canonical_player_id));
}

/** Every asset a manager holds, position-indexed, used to source incoming candidates from a partner regardless of their own surplus/premium split. */
function allAssetsByPosition(profile: TradeSearchProfile, allAssets: AssetValue[]): Map<string, AssetValue[]> {
  const byPos = new Map<string, AssetValue[]>();
  for (const a of allAssets) {
    if (!byPos.has(a.position)) byPos.set(a.position, []);
    byPos.get(a.position)!.push(a);
  }
  for (const arr of byPos.values()) arr.sort(sortDesc);
  return byPos;
}

export interface PackageGenInput {
  me: TradeSearchProfile;
  partner: TradeSearchProfile;
  /** every roster player for `me`/`partner`, not just the profile's capped pools — needed so a position-targeted search isn't limited to the top-8 global list */
  meAllAssets: AssetValue[];
  partnerAllAssets: AssetValue[];
  constraints?: TradeSearchConstraints;
  limits: TradeSearchLimits;
  /** restrict need positions considered (e.g. POSITIONAL_NEED mode); undefined = use every need position from `me`'s profile */
  targetPositions?: string[];
}

export function generateBilateralPackages(input: PackageGenInput): CandidatePackage[] {
  const { me, partner, constraints, limits } = input;
  const K = limits.max_assets_per_pool;
  const meAssets = applyUntouchables(input.meAllAssets, constraints);
  const partnerAssets = applyUntouchables(input.partnerAllAssets, constraints);
  const partnerByPos = allAssetsByPosition(partner, partnerAssets);
  const meByPos = allAssetsByPosition(me, meAssets);

  const requiredIncoming = new Set(constraints?.required_incoming_player_ids ?? []);
  const requiredOutgoing = new Set(constraints?.required_outgoing_player_ids ?? []);

  const needPositions = (input.targetPositions ?? me.needs.filter((n) => n.severity === "CRITICAL" || n.severity === "HIGH" || n.severity === "MODERATE").map((n) => n.position)).slice(0, 3);

  const packages: CandidatePackage[] = [];
  const xfer = (from: string, to: string, id: string) => ({ from_manager_id: from, to_manager_id: to, canonical_player_id: id });

  // ---- ONE_FOR_ONE: partner's asset at my need position <-> my expendable asset ----
  // A required incoming/outgoing asset (BUY_PLAYER / SELL_PLAYER modes) is looked up
  // directly from the FULL asset pool and forced into the candidate list — it must
  // never be silently dropped just because it fell outside the top-K expendable/
  // by-position slice (e.g. a SELL_PLAYER target that isn't flagged "expendable").
  const myExpendable = applyUntouchables(me.expendable_assets, constraints);
  const requiredOutgoingAssets = [...requiredOutgoing].map((id) => meAssets.find((a) => a.canonical_player_id === id)).filter((a): a is AssetValue => Boolean(a));
  const requiredIncomingAssets = [...requiredIncoming].map((id) => partnerAssets.find((a) => a.canonical_player_id === id)).filter((a): a is AssetValue => Boolean(a));
  for (const pos of needPositions) {
    const incomingCandidates = requiredIncomingAssets.length > 0 ? requiredIncomingAssets : (partnerByPos.get(pos) ?? []).slice(0, K);
    const outgoingCandidates = requiredOutgoingAssets.length > 0 ? requiredOutgoingAssets : myExpendable.length > 0 ? myExpendable.slice(0, K) : (meByPos.get(pos) ?? []).slice(0, K);
    for (const inc of incomingCandidates) {
      for (const out of outgoingCandidates) {
        if (inc.canonical_player_id === out.canonical_player_id) continue;
        packages.push({
          shape: "ONE_FOR_ONE",
          transfers: [xfer(partner.manager_id, me.manager_id, inc.canonical_player_id), xfer(me.manager_id, partner.manager_id, out.canonical_player_id)],
          participant_manager_ids: [me.manager_id, partner.manager_id],
        });
      }
    }
  }

  // ---- TWO_FOR_ONE: I consolidate — 2 of my expendables for 1 partner premium at my need position ----
  if (me.consolidation_candidate) {
    for (const pos of needPositions) {
      const targets = applyUntouchables(partner.premium_assets.filter((a) => a.position === pos), constraints).slice(0, 2);
      const pool = myExpendable.slice(0, Math.min(K, 4));
      const pairs: Array<[AssetValue, AssetValue]> = [];
      for (let i = 0; i < pool.length; i += 1) for (let j = i + 1; j < pool.length; j += 1) pairs.push([pool[i]!, pool[j]!]);
      for (const target of targets) {
        if (requiredIncoming.size > 0 && !requiredIncoming.has(target.canonical_player_id)) continue;
        for (const [a, b] of pairs.slice(0, 3)) {
          packages.push({
            shape: "TWO_FOR_ONE",
            transfers: [
              xfer(partner.manager_id, me.manager_id, target.canonical_player_id),
              xfer(me.manager_id, partner.manager_id, a.canonical_player_id),
              xfer(me.manager_id, partner.manager_id, b.canonical_player_id),
            ],
            participant_manager_ids: [me.manager_id, partner.manager_id],
          });
        }
      }
    }
  }

  // ---- ONE_FOR_TWO: I deconsolidate — 1 of my premium (surplus-position) assets for 2 of partner's useful pieces ----
  if (me.fragility_sensitive) {
    const mySurplusPositions = new Set(me.surpluses.map((s) => s.position));
    const givable = me.premium_assets.filter((a) => mySurplusPositions.has(a.position));
    for (const give of applyUntouchables(givable, constraints).slice(0, 2)) {
      for (const pos of needPositions) {
        const pool = (partnerByPos.get(pos) ?? []).slice(0, Math.min(K, 3));
        for (let i = 0; i < pool.length; i += 1) {
          for (let j = i + 1; j < pool.length; j += 1) {
            const a = pool[i]!, b = pool[j]!;
            if (requiredOutgoing.size > 0 && !requiredOutgoing.has(give.canonical_player_id)) continue;
            packages.push({
              shape: "ONE_FOR_TWO",
              transfers: [
                xfer(me.manager_id, partner.manager_id, give.canonical_player_id),
                xfer(partner.manager_id, me.manager_id, a.canonical_player_id),
                xfer(partner.manager_id, me.manager_id, b.canonical_player_id),
              ],
              participant_manager_ids: [me.manager_id, partner.manager_id],
            });
          }
        }
      }
    }
  }

  return packages.slice(0, limits.max_generated_packages);
}
