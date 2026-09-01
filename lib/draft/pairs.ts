/**
 * PHASE 4 §21A — snake turn-pair optimisation.
 *
 * A manager on the snake turn (slot 1 or slot N) owns two consecutive overall
 * picks with NO opponent selection between them. Recommending each pick
 * independently is wrong: the manager is making a two-player decision and the
 * combination has interaction value.
 *
 * This is STRUCTURAL, not hard-coded to BijiMac — it fires for any consecutive
 * turn. BijiMac (Bloodline slot 12, picks 12/13, 36/37, 60/61) is the immediate
 * use case.
 *
 *   PairUtility(i,j) = U_i + U_j
 *                    + TierCaptureValue      (cliffs both picks lock in that would vanish by the next turn)
 *                    + StarterTrajectoryValue(pair completes/《de-risks》 the startable lineup)
 *                    + PositionalDiversificationValue (mild; NOT a diversification mandate)
 *                    − RedundancyPenalty     (two of the same tier where one would have survived)
 *                    − CombinedReachCost
 *                    − ConstructionRisk
 *
 * Order within the turn does not change survival, so Pair(A,B) === Pair(B,A):
 * pairs are canonicalised by sorted player_id (§21A.3).
 */

import type { FantasyPosition } from "@/lib/projections/schema";
import { canonicalPairKey, nextTurnPickPair } from "./geometry";
import type {
  DraftPairRecommendation,
  DraftRecommendation,
  NextTurnLandscape,
  ReasonCode,
  RecommendationProvenance,
  SnakeTurnState,
  TierBoundary,
} from "./schema";
import type { PositionOutlook } from "./lookahead";

const FLEX_ELIGIBLE = new Set<FantasyPosition>(["RB", "WR", "TE"]);

export interface PairInput {
  turn: SnakeTurnState;
  /** the already-scored single-pick candidates, best-first */
  candidates: DraftRecommendation[];
  /** per-position outlook forecast for the manager's NEXT turn (picks 3rd/4th) */
  nextTurnOutlooks: Map<FantasyPosition, PositionOutlook>;
  tierBoundaries: TierBoundary[];
  /** open starter slots per position from the roster trajectory */
  openStarters: Record<string, number>;
  openFlex: number;
  provenance: RecommendationProvenance;
  /** how many candidates to consider for pairing (top-K by single-pick score) */
  topK?: number;
  /** how many alternate pairs to return */
  alternates?: number;
}

function buildNextTurnLandscape(
  turn: SnakeTurnState,
  outlooks: Map<FantasyPosition, PositionOutlook>,
  boundaries: TierBoundary[],
): NextTurnLandscape {
  const pair = nextTurnPickPair(turn);
  const atPicks: [number, number] = pair
    ? [pair[0].overall, pair[1].overall]
    : [turn.second_next_manager_pick?.overall ?? 0, (turn.second_next_manager_pick?.overall ?? 0) + 1];

  const by_position = (["QB", "RB", "WR", "TE"] as FantasyPosition[]).map((pos) => {
    const ol = outlooks.get(pos);
    const posBoundaries = boundaries.filter((b) => b.position === pos);
    const bestTier = posBoundaries.length ? Math.min(...posBoundaries.map((b) => b.tier)) : 0;
    return {
      position: pos,
      best_tier_available: bestTier,
      expected_points_range: ol?.expected_alt_points ?? ([0, 0] as [number, number]),
      expected_vor_range: ol?.expected_alt_vor ?? ([0, 0] as [number, number]),
      p_target_tier_survives: ol ? clamp01(1 - ol.expected_taken / Math.max(1, ol.expected_taken + 2)) : 0.5,
      projected_cliff_before: posBoundaries.some((b) => b.cliff_to_next_points >= 10 && b.tier <= 3),
    };
  });

  return { at_picks: atPicks, by_position };
}

export function optimiseTurnPair(input: PairInput): {
  primary_pair: DraftPairRecommendation | null;
  alternate_pairs: DraftPairRecommendation[];
} {
  if (!input.turn.is_consecutive_turn) return { primary_pair: null, alternate_pairs: [] };

  const topK = input.topK ?? 12;
  const pool = input.candidates
    .filter((c) => c.recommendation_score > -1e8)
    .slice(0, topK);
  if (pool.length < 2) return { primary_pair: null, alternate_pairs: [] };

  const landscape = buildNextTurnLandscape(input.turn, input.nextTurnOutlooks, input.tierBoundaries);
  const cliffBefore = new Map(
    landscape.by_position.map((p) => [p.position, p.projected_cliff_before]),
  );

  interface Scored {
    key: string;
    a: DraftRecommendation;
    b: DraftRecommendation;
    utility: number;
    tierCaptured: Array<{ position: FantasyPosition; tier: number; cliff_points: number }>;
    deferred: FantasyPosition[];
  }
  const seen = new Set<string>();
  const scoredPairs: Scored[] = [];

  for (let i = 0; i < pool.length; i++) {
    for (let j = i + 1; j < pool.length; j++) {
      const a = pool[i]!;
      const b = pool[j]!;
      const key = canonicalPairKey(a.player_id, b.player_id);
      if (seen.has(key)) continue;
      seen.add(key);

      const base = a.recommendation_score + b.recommendation_score;

      // --- tier capture: a tier-last pick whose tier likely vanishes by next turn
      const tierCaptured: Scored["tierCaptured"] = [];
      for (const r of [a, b]) {
        if (r.tier_drop >= 8 && (cliffBefore.get(r.position) || r.tier_survival.p_tier_survives_next_pick < 0.4)) {
          tierCaptured.push({ position: r.position, tier: r.tier, cliff_points: r.tier_drop });
        }
      }
      const tierCaptureValue = tierCaptured.reduce((s, t) => s + 0.5 * t.cliff_points, 0);

      // --- starter trajectory: does the pair fill/de-risk open starters?
      const posCount: Record<string, number> = {};
      for (const r of [a, b]) posCount[r.position] = (posCount[r.position] ?? 0) + 1;
      let starterFillValue = 0;
      let flexBudget = input.openFlex;
      for (const pos of Object.keys(posCount)) {
        const need = input.openStarters[pos] ?? 0;
        const got = posCount[pos]!;
        const towardStarter = Math.min(got, need);
        starterFillValue += towardStarter * 12;
        let leftover = got - towardStarter;
        if (FLEX_ELIGIBLE.has(pos as FantasyPosition) && flexBudget > 0 && leftover > 0) {
          const toFlex = Math.min(leftover, flexBudget);
          starterFillValue += toFlex * 6;
          flexBudget -= toFlex;
          leftover -= toFlex;
        }
      }

      // --- positional diversification: MILD. two different positions get a
      // small bonus; two of the same are allowed (§21A / scenarios M,N) and only
      // penalised if the second one would clearly have survived.
      const samePos = a.position === b.position;
      const diversificationValue = samePos ? 0 : 4;

      // --- redundancy penalty: same position AND the lower one would likely
      // survive to the next turn — pairing him now instead of diversifying
      // "spends" a turn pick on a player who would still be there. Costs ~half
      // his VOR in opportunity. Not applied when the second player is himself a
      // tier-cliff capture (scenarios M / N: WR+WR is allowed when value backs it).
      const redundancyPenalty =
        samePos && b.survival.p_survives_next_pick >= 0.55 && b.tier_drop < 8
          ? 0.5 * Math.max(0, b.vor)
          : 0;

      // --- combined reach + construction risk
      const combinedReach = a.reach_cost + b.reach_cost;
      const constructionRisk =
        (a.construction_effect.starter_completion_risk_after - a.construction_effect.starter_completion_risk_before > 0
          ? 20
          : 0) +
        (b.construction_effect.starter_completion_risk_after - b.construction_effect.starter_completion_risk_before > 0
          ? 20
          : 0);

      const utility = round2(
        base +
          tierCaptureValue +
          starterFillValue +
          diversificationValue -
          redundancyPenalty -
          combinedReach -
          constructionRisk,
      );

      // deferred positions: core positions neither pick addresses
      const deferred = (["QB", "RB", "WR", "TE"] as FantasyPosition[]).filter(
        (pos) => a.position !== pos && b.position !== pos,
      );

      // §21A.4 — PairWaitLoss: what the manager loses at each DEFERRED position
      // by not taking it now. A pair that defers a genuine cliff is penalised;
      // deferring a deep, flat position costs ~nothing. This is the term that
      // makes "RB + elite-TE" beat "RB + WR" when the WR board will hold.
      let deferredCliffPenalty = 0;
      for (const pos of deferred) {
        const ol = input.nextTurnOutlooks.get(pos);
        if (!ol) continue;
        const waitLossMid = Math.max(
          0,
          ol.best_now_points - (ol.expected_alt_points[0] + ol.expected_alt_points[1]) / 2,
        );
        // only meaningful losses (a real cliff) count, discounted
        deferredCliffPenalty += waitLossMid > 8 ? 0.6 * waitLossMid : 0;
      }

      scoredPairs.push({
        key,
        a,
        b,
        utility: round2(utility - deferredCliffPenalty),
        tierCaptured,
        deferred,
      });
    }
  }

  scoredPairs.sort((x, y) => y.utility - x.utility);
  if (scoredPairs.length === 0) return { primary_pair: null, alternate_pairs: [] };

  const toRec = (s: (typeof scoredPairs)[number], kind: DraftPairRecommendation["kind"], rank: number): DraftPairRecommendation => {
    const ordered = [s.a, s.b].sort((x, y) => x.player_id.localeCompare(y.player_id));
    const p1 = ordered[0]!;
    const p2 = ordered[1]!;
    const codes: ReasonCode[] = ["TURN_PAIR_OPTIMAL"];
    if (s.tierCaptured.length > 0) codes.push("TIER_CLIFF_CAPTURE");
    for (const r of [p1, p2]) {
      if (r.position === "RB" && r.tier_drop >= 8) codes.push("RB_VALUE_CAPTURE");
      if (r.position === "WR" && r.tier_drop >= 8) codes.push("WR_VALUE_CAPTURE");
      if (r.position === "RB" && Math.max(...r.wait_comparison.wait_projection_loss) >= 18) codes.push("RB_WAIT_LOSS_HIGH");
      if (r.position === "WR" && Math.max(...r.wait_comparison.wait_projection_loss) >= 18) codes.push("WR_WAIT_LOSS_HIGH");
    }

    const deferLoss = s.deferred.map((pos) => {
      const ol = input.nextTurnOutlooks.get(pos);
      const lo = ol ? Math.max(0, ol.best_now_points - ol.expected_alt_points[1]) : 0;
      const hi = ol ? Math.max(0, ol.best_now_points - ol.expected_alt_points[0]) : 0;
      return { position: pos, loss_range: [round2(lo), round2(hi)] as [number, number] };
    });
    const deferVorLoss = s.deferred.map((pos) => {
      const ol = input.nextTurnOutlooks.get(pos);
      const lo = ol ? Math.max(0, ol.best_now_vor - ol.expected_alt_vor[1]) : 0;
      const hi = ol ? Math.max(0, ol.best_now_vor - ol.expected_alt_vor[0]) : 0;
      return { position: pos, loss_range: [round2(lo), round2(hi)] as [number, number] };
    });

    const reason =
      `${kind === "BEST_PAIR" ? "Best" : "Alternate"} ${input.turn.current_pick?.overall ?? "?"}/${input.turn.next_manager_pick?.overall ?? "?"} pair: ${p1.player_name} + ${p2.player_name}. ` +
      (s.tierCaptured.length
        ? `Captures ${s.tierCaptured.map((t) => `${t.position} Tier ${t.tier} (cliff ${fmt(t.cliff_points)} pts)`).join(" and ")}. `
        : "") +
      (s.deferred.length
        ? `${s.deferred.join("/")} can wait — expected loss by picks ${landscape.at_picks.join("/")} is ` +
          `${deferLoss.map((d) => `${d.position} ${fmt(d.loss_range[0])}–${fmt(d.loss_range[1])}`).join(", ")} points.`
        : "");

    return {
      kind,
      rank,
      player_1: pickView(p1),
      player_2: pickView(p2),
      combined_projected_points: round2(p1.projected_points + p2.projected_points),
      combined_vor: round2(p1.vor + p2.vor),
      combined_recommendation_utility: s.utility,
      tier_cliffs_captured: s.tierCaptured,
      positions_deferred: s.deferred,
      anticipated_next_turn_alternatives: landscape,
      anticipated_projection_loss_if_deferred: deferLoss,
      anticipated_vor_loss_if_deferred: deferVorLoss,
      pair_reason_codes: [...new Set(codes)],
      reason,
      confidence:
        p1.confidence.decision === "HIGH" && p2.confidence.decision === "HIGH"
          ? "HIGH"
          : p1.confidence.decision === "VERY_LOW" || p2.confidence.decision === "VERY_LOW"
            ? "LOW"
            : "MEDIUM",
      provenance: input.provenance,
    };
  };

  const primary_pair = toRec(scoredPairs[0]!, "BEST_PAIR", 1);
  const alternate_pairs = scoredPairs
    .slice(1, 1 + (input.alternates ?? 2))
    .map((s, i) => toRec(s, "ALTERNATE_PAIR", i + 2));

  return { primary_pair, alternate_pairs };
}

function pickView(r: DraftRecommendation): DraftPairRecommendation["player_1"] {
  return {
    player_id: r.player_id,
    player_name: r.player_name,
    position: r.position,
    team: r.team,
    projected_points: r.projected_points,
    vor: r.vor,
    tier: r.tier,
    position_rank: r.position_rank,
  };
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}
function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
