/**
 * PHASE 4 — snake-draft recommendation engine orchestrator.
 *
 * Pure and deterministic (§23): given identical draft state + projection
 * version + market snapshot + league scoring + manager roster, it returns
 * identical recommendations. No RNG.
 *
 * It CONSUMES frozen projections (Layer 2 `LeagueProjection[]`) — it never
 * builds or mutates a projection. `buildRecommendationInputs` in `service.ts`
 * assembles the live inputs; this module is the decision logic and is unit
 * testable against synthetic pools.
 */

import type { FantasyPosition, LeagueProjection } from "@/lib/projections/schema";
import { draftablePositions } from "@/lib/sleeper/draft";
import type { NormalizedPlayer } from "@/lib/sleeper/types";

import {
  computeSnakeTurnState,
  interveningPickCount,
  type SnakeStateInput,
} from "./geometry";
import { computeReplacementLevels, vorOf, type ReplacementLevels } from "./replacement";
import { tierAllPositions, tierDropForPlayer, TIER_MODEL_VERSION, type PositionTiers } from "./tiers";
import { computeScarcity, scarcityValueForPlayer } from "./scarcity";
import {
  estimateSurvival,
  estimateTierSurvival,
  SURVIVAL_MODEL_VERSION,
  type MarketSnapshot,
} from "./survival";
import {
  baselinePickRates,
  detectRuns,
  runEffect,
  runExtraDemand,
  type RecentPick,
} from "./runs";
import { computeRosterNeedState, needWeight, positionalAdvantage, positionalAdvantageDamp, rosterNeedValue } from "./need";
import { computeRosterTrajectory, riskDeltaFromPick } from "./trajectory";
import { evaluateKdstGate, isKdst } from "./kdst";
import { positionOutlook, urgencyValue, waitComparisonForPlayer, type PositionOutlook } from "./lookahead";
import { optimiseTurnPair } from "./pairs";
import {
  DEFAULT_WEIGHTS,
  constructionRiskValue,
  reachCost,
  uncertaintyPenalty,
  utilityScore,
} from "./utility";
import { buildReason } from "./reason";
import {
  RECOMMENDATION_MODEL_VERSION,
  RECOMMENDATION_SCHEMA_VERSION,
  type DraftEngineReadiness,
  type DraftRecommendation,
  type ReasonCode,
  type RecommendationProvenance,
  type RecommendationResponse,
  type ScarcitySnapshot,
  type SoftWarningCode,
  type SupportedDraftType,
  type UtilityComponents,
  type UtilityWeights,
} from "./schema";

const SKILL: FantasyPosition[] = ["QB", "RB", "WR", "TE", "K", "DEF"];

export interface CompletedPick {
  overall: number;
  roster_id: number | null;
  player_id: string | null;
  position: FantasyPosition | null;
}

export interface EngineManager {
  roster_id: number;
  sleeper_user_id: string;
  manager_slug: string;
  draft_slot: number | null;
}

export interface EngineInput {
  leaguePool: LeagueProjection[];
  rosterPositions: string[];
  numTeams: number;
  draftType: string | null;
  rounds: number;
  completedPicks: CompletedPick[];
  manager: EngineManager;
  rosterPlayers: NormalizedPlayer[];
  market: MarketSnapshot;
  provenance: {
    projection_source: string;
    projection_version: string;
    projection_timestamp: string;
    league_scoring_hash: string;
    draft_state_timestamp: string;
  };
  weights?: UtilityWeights;
  /** how many players to return per bucket */
  limits?: { alternates?: number; wait?: number; doNotReach?: number };
}

function supportedOrder(draftType: string | null): SupportedDraftType | null {
  if (draftType === "snake") return "snake";
  if (draftType === "linear") return "linear";
  return null;
}

function provenanceOf(input: EngineInput, marketSource: MarketSnapshot["source"]): RecommendationProvenance {
  return {
    projection_source: input.provenance.projection_source,
    projection_version: input.provenance.projection_version,
    projection_timestamp: input.provenance.projection_timestamp,
    league_scoring_hash: input.provenance.league_scoring_hash,
    market_source: marketSource,
    market_timestamp: input.market.timestamp,
    survival_model_version: SURVIVAL_MODEL_VERSION,
    market_consensus_version: input.market.consensus_version,
    market_direct_adp_coverage:
      input.market.covered > 0 ? round2(input.market.direct_adp_covered / input.market.covered) : 0,
    market_degraded_reason: input.market.degraded_reason,
    tier_model_version: TIER_MODEL_VERSION,
    recommendation_model_version: RECOMMENDATION_MODEL_VERSION,
    recommendation_schema_version: RECOMMENDATION_SCHEMA_VERSION,
    draft_state_timestamp: input.provenance.draft_state_timestamp,
  };
}

/* ------------------------------------------------------------------ helpers */

function localPointsPerPick(sortedPoints: number[], nearRank: number, span = 24): number {
  const n = sortedPoints.length;
  if (n < 2) return 1;
  const lo = Math.max(0, Math.min(n - 2, nearRank - Math.floor(span / 2)));
  const hi = Math.min(n - 1, lo + span);
  const drop = (sortedPoints[lo] ?? 0) - (sortedPoints[hi] ?? 0);
  return Math.max(0.05, drop / Math.max(1, hi - lo));
}

function decisionConfidence(
  projectionConf: string,
  survivalConf: string,
  candidatePoolThin: boolean,
): DraftRecommendation["confidence"]["decision"] {
  const rank = (c: string) => (c === "HIGH" ? 3 : c === "MEDIUM" ? 2 : c === "LOW" ? 1 : 0);
  let score = Math.min(rank(projectionConf), rank(survivalConf) + 1);
  if (candidatePoolThin) score -= 1;
  return score >= 3 ? "HIGH" : score === 2 ? "MEDIUM" : score === 1 ? "LOW" : "VERY_LOW";
}

/* ------------------------------------------------------------------ engine */

export function recommendDraft(input: EngineInput): RecommendationResponse {
  const order = supportedOrder(input.draftType);
  const weights = input.weights ?? DEFAULT_WEIGHTS;
  const picksMade = input.completedPicks.length;

  const readiness: DraftEngineReadiness = {
    draft_engine_mode: "SNAKE_ONLY",
    snake_engine_status: "READY",
    auction_engine_status: "UNSUPPORTED_2026",
    degraded_reasons: [],
    blocked_reasons: [],
  };
  const warnings: string[] = [];

  // ---- geometry -------------------------------------------------------
  const slot = input.manager.draft_slot ?? 0;
  if (!order) {
    readiness.snake_engine_status = "BLOCKED";
    readiness.blocked_reasons.push(`draft type "${input.draftType}" is not snake/linear`);
  }
  if (slot < 1) {
    readiness.snake_engine_status = readiness.snake_engine_status === "BLOCKED" ? "BLOCKED" : "DEGRADED";
    readiness.degraded_reasons.push("manager draft slot unknown — snake geometry unavailable");
  }

  const turnInput: SnakeStateInput = {
    slot: Math.max(1, slot),
    teamCount: input.numTeams,
    rounds: input.rounds,
    overallPicksMade: picksMade,
    order: order ?? "snake",
  };
  const turn = computeSnakeTurnState(turnInput);

  // ---- taken players + draftability ---------------------------------
  const taken = new Set<string>();
  for (const p of input.completedPicks) if (p.player_id) taken.add(p.player_id);
  for (const p of input.rosterPlayers) taken.add(p.player_id);

  const draftable = draftablePositions(input.rosterPositions);

  // ---- roster state ------------------------------------------------
  const needState = computeRosterNeedState(input.rosterPlayers, input.rosterPositions);
  const openCore = (["QB", "RB", "WR", "TE"] as FantasyPosition[]).reduce(
    (a, p) => a + (needState.open_required[p] ?? 0),
    0,
  );
  const picksRemaining = Math.max(1, input.rounds - turn.own_picks_made);
  const currentRound = turn.current_round;

  const kdstGate = evaluateKdstGate({
    totalRounds: input.rounds,
    currentRound,
    openCoreStarters: openCore,
    openFlex: needState.open_flex,
    openBench: Math.max(
      0,
      (input.rosterPositions.filter((s) => s === "BN" || s === "IR" || s === "TAXI").length) -
        Math.max(0, input.rosterPlayers.length - (input.rosterPositions.length - input.rosterPositions.filter((s) => s === "BN" || s === "IR" || s === "TAXI").length)),
    ),
  });

  // ---- Layer 2 pool: available candidates ---------------------------
  const available = input.leaguePool.filter(
    (p) =>
      !taken.has(p.player_id) &&
      SKILL.includes(p.position) &&
      [...draftable].some((d) => d === p.position),
  );

  // Diagnostic (discovered Phase 6): the frozen Layer-1 projection pool can be
  // entirely missing a required position (e.g. K/DEF are outside the offensive
  // opportunity model's coverage) — this is a Layer-1/2 gap, not something this
  // engine can fix, but it must never fail silently. Surface it so a caller
  // knows to fall back to the candidate list (`.../draft`) for that position.
  for (const pos of ["K", "DEF"] as FantasyPosition[]) {
    if (draftable.has(pos) && !input.leaguePool.some((p) => p.position === pos)) {
      readiness.snake_engine_status = readiness.snake_engine_status === "BLOCKED" ? "BLOCKED" : "DEGRADED";
      readiness.degraded_reasons.push(
        `${pos} is absent from the projection pool — the recommendation engine cannot suggest a ${pos}; use the .../draft candidate list for that slot`,
      );
      warnings.push(`no ${pos} projections available — projection engine gap, not a draft-legality issue`);
    }
  }

  // replacement levels off the FULL league pool (structure, preseason)
  const levels: ReplacementLevels = computeReplacementLevels(
    input.rosterPositions,
    input.numTeams,
    input.leaguePool,
  );
  const vorFn = (p: LeagueProjection) => vorOf(p, levels);
  const tiers = tierAllPositions(input.leaguePool, vorFn);

  // ---- board gradient (points per pick) around the current pick ----
  const sortedAvailPoints = available
    .map((p) => p.league_points)
    .sort((a, b) => b - a);
  const nearRank = Math.max(0, (turn.current_pick?.overall ?? picksMade + 1) - picksMade - 1);
  const pointsPerPick = localPointsPerPick(sortedAvailPoints, nearRank);

  // ---- recent picks + runs --------------------------------------
  const recent: RecentPick[] = input.completedPicks
    .slice(-16)
    .map((p) => ({ overall: p.overall, position: p.position }));
  const baseline = baselinePickRates(
    Object.fromEntries(
      SKILL.map((p) => [p, levels.by_position[p]?.league_starter_demand ?? 0]),
    ) as Record<FantasyPosition, number>,
  );
  const runSignals = detectRuns(recent, baseline);
  const runEffects = new Map(runSignals.map((s) => [s.position, runEffect(s)]));

  // On a consecutive (snake-turn) pick the manager owns BOTH the current and the
  // "next" overall pick, so single-pick survival/urgency must look past the turn
  // to the pick that actually follows a wait — the manager's SECOND-next pick.
  // (The two consecutive picks are optimised jointly by the pair engine.)
  const singlePickHorizon = turn.is_consecutive_turn
    ? turn.second_next_manager_pick
    : turn.next_manager_pick;
  const nextPickOverall =
    singlePickHorizon?.overall ??
    (turn.current_pick?.overall ?? picksMade + 1) + input.numTeams;
  // intervening opponent picks before that horizon (excludes the manager's own
  // consecutive pick when on the turn).
  const interveningToNext = turn.is_consecutive_turn
    ? Math.max(0, interveningPickCount(turn, nextPickOverall) - 1)
    : interveningPickCount(turn, nextPickOverall);

  // ---- per-position outlook (lookahead) + scarcity + tier survival ----
  const availByPos = new Map<FantasyPosition, LeagueProjection[]>();
  for (const p of available) {
    if (!availByPos.has(p.position)) availByPos.set(p.position, []);
    availByPos.get(p.position)!.push(p);
  }

  const outlooks = new Map<FantasyPosition, PositionOutlook>();
  const scarcity = new Map<FantasyPosition, ScarcitySnapshot>();
  const survivalByPlayer = new Map<string, ReturnType<typeof estimateSurvival>>();
  const demandBeforeNextTurn: Record<FantasyPosition, number> = { QB: 0, RB: 0, WR: 0, TE: 0, K: 0, DEF: 0 };
  const startableRemaining: Record<FantasyPosition, number> = { QB: 0, RB: 0, WR: 0, TE: 0, K: 0, DEF: 0 };

  for (const pos of SKILL) {
    const list = (availByPos.get(pos) ?? []).slice().sort((a, b) => b.league_points - a.league_points);
    const eff = runEffects.get(pos);
    const baseRate = baseline[pos] ?? 0;
    const extra = eff ? runExtraDemand(eff, baseRate, interveningToNext) : 0;
    const expectedDemand = baseRate * interveningToNext + extra;
    demandBeforeNextTurn[pos] = round2(expectedDemand);

    // per-player survival — conditioned on availability at the current pick (§16)
    const currentOverall = turn.current_pick?.overall ?? picksMade + 1;
    const surv = list.map((p) =>
      estimateSurvival({
        playerId: p.player_id,
        position: pos,
        targetPickOverall: nextPickOverall,
        interveningPicks: interveningToNext,
        currentPickOverall: currentOverall,
        market: input.market,
        runExtraDemand: extra,
      }),
    );
    list.forEach((p, i) => survivalByPlayer.set(p.player_id, surv[i]!));

    outlooks.set(
      pos,
      positionOutlook(
        pos,
        list.map((p, i) => ({
          player_id: p.player_id,
          league_points: p.league_points,
          vor: vorFn(p),
          p_survives_next_pick: surv[i]!.p_survives_next_pick,
        })),
      ),
    );

    const startableVor = list.map(vorFn).filter((v) => v > 0);
    startableRemaining[pos] = startableVor.length;
    scarcity.set(
      pos,
      computeScarcity({
        position: pos,
        availableVor: list.map(vorFn),
        starterDemand: levels.by_position[pos]?.league_starter_demand ?? 0,
        expectedDemandBeforeNextPick: expectedDemand,
        replacementDrop: (list[0] ? vorFn(list[0]) : 0),
      }),
    );
  }

  const trajectory = computeRosterTrajectory({
    rosterPlayers: input.rosterPlayers,
    rosterPositions: input.rosterPositions,
    picksRemaining,
    startableRemaining,
    demandBeforeNextTurn,
  });

  // ---- score every candidate --------------------------------------
  const draftProgress = input.rounds > 0 ? (currentRound ?? 1) / input.rounds : 0;
  const poolThin = available.length < 12;

  // §defect fix (2026.2): required-slot desperation. `roster_need`'s open-slot
  // weight (0.9) is a FIXED bonus regardless of how many picks are actually
  // left to fill it — with exactly 15 rounds = 15 roster slots, that let a
  // redundant bench player at an already-full position outscore K/DEF on the
  // literal LAST pick, leaving mandatory starter slots permanently unfillable.
  // Once remaining picks are tight against remaining REQUIRED slots, escalate
  // the open-slot need weight so completing the legal roster dominates.
  const openRequiredTotal =
    Object.values(trajectory.open_starters).reduce((a, b) => a + b, 0) + trajectory.open_flex;
  const desperation =
    picksRemaining <= openRequiredTotal ? 4.5 : picksRemaining <= openRequiredTotal + 1 ? 2.0 : 1.0;

  const scored: DraftRecommendation[] = [];
  for (const p of available) {
    const pos = p.position;
    const posTiers = tiers.get(pos) as PositionTiers;
    const tp = posTiers.players.find((x) => x.player_id === p.player_id);
    const vor = vorFn(p);
    const outlook = outlooks.get(pos)!;
    const surv = survivalByPlayer.get(p.player_id)!;
    const sc = scarcity.get(pos)!;

    // hard gate: K/DST before release
    const hardBlocked = isKdst(pos) && !kdstGate.released;

    const tierDrop = tierDropForPlayer(posTiers, p.player_id);
    const altMid = (outlook.expected_alt_points[0] + outlook.expected_alt_points[1]) / 2;
    // §defect fix (2026.2): a positional edge only counts if the player could
    // plausibly start — damped once the roster already holds more at this
    // position than every slot it could ever occupy (see need.ts).
    const posDamp = positionalAdvantageDamp(needState, pos, input.rosterPositions);
    const posAdv = positionalAdvantage(p.league_points, altMid) * posDamp;

    const confScale =
      surv.confidence === "HIGH" ? 1 : surv.confidence === "MEDIUM" ? 0.8 : surv.confidence === "LOW" ? 0.55 : 0.3;
    // same defect fix: urgency ("cost of passing him") is only meaningful for a
    // position the roster could still start; a maxed-out position's "urgency"
    // is bench-shuffling, not a real decision cost.
    const urg = urgencyValue(p.league_points, surv.p_survives_next_pick, altMid, confScale) * posDamp;

    const needValBase = rosterNeedValue(needState, pos, levels.by_position[pos]?.replacement_points != null ? Math.max(0, vor) : 0);
    // escalate only genuine open-slot need (positive), never a redundancy penalty
    const needVal = needValBase > 0 ? round2(needValBase * desperation) : needValBase;
    const riskDelta = riskDeltaFromPick(trajectory, pos, {
      rosterPlayers: input.rosterPlayers,
      rosterPositions: input.rosterPositions,
      picksRemaining,
      startableRemaining,
      demandBeforeNextTurn,
    });

    const scarVal = scarcityValueForPlayer(sc, tp?.position_rank ?? 999);
    const reach = reachCost({
      currentPickOverall: turn.current_pick?.overall ?? picksMade + 1,
      marketPickOverall:
        input.market.by_player.get(p.player_id)?.adp ??
        input.market.by_player.get(p.player_id)?.search_rank ??
        null,
      pSurvivesNextPick: surv.p_survives_next_pick,
      pointsPerPick,
      survivalConfidence: surv.confidence,
    });
    const uncPen = uncertaintyPenalty({
      band: p.league_outcome,
      median: p.league_points,
      draftProgress,
      starterCompletionRisk: trajectory.starter_completion_risk,
    });
    const constRisk = constructionRiskValue(riskDelta);

    // same defect fix: once a position is roster-maxed, its raw VOR can no
    // longer justify the pick over a position that can still start (VOR alone,
    // weight 1.0, was enough to keep out-drafting `roster_need`'s penalty for a
    // position with a naturally wide points spread — e.g. a single-QB league).
    // `rec.vor` below stays the TRUE, undamped value for transparency/reporting;
    // only the score-facing component is damped.
    const components: UtilityComponents = {
      vor: round2(vor * posDamp),
      tier_drop: round2(tierDrop),
      scarcity_value: round2(scarVal),
      roster_need: round2(needVal),
      positional_advantage: round2(posAdv),
      urgency: round2(urg),
      reach_cost: round2(reach),
      uncertainty_penalty: round2(uncPen),
      construction_risk: round2(constRisk),
    };
    const score = hardBlocked ? -1e9 : utilityScore(components, weights);

    // tier survival for this player's tier
    const tierMembersAvail = (availByPos.get(pos) ?? [])
      .map((x) => tiers.get(pos)!.players.find((y) => y.player_id === x.player_id))
      .filter((x): x is NonNullable<typeof x> => !!x && x.tier === (tp?.tier ?? -1));
    const tierSurv = estimateTierSurvival({
      position: pos,
      tier: tp?.tier ?? 0,
      memberSurvival: tierMembersAvail.map((m) => survivalByPlayer.get(m.player_id)?.p_survives_next_pick ?? 0.5),
      expectedPositionDemand: demandBeforeNextTurn[pos],
      confidence: surv.confidence,
    });

    const wc = waitComparisonForPlayer(outlook, p.league_points, vor);

    const softWarnings: SoftWarningCode[] = [];
    if (p.confidence === "LOW" || p.confidence === "VERY_LOW") softWarnings.push("LOW_CONFIDENCE");
    if (p.vs_sleeper.delta_pct != null && p.vs_sleeper.delta_pct >= 18) softWarnings.push("MARKET_DIVERGENCE_RI_HIGH");
    if (p.vs_sleeper.delta_pct != null && p.vs_sleeper.delta_pct <= -18) softWarnings.push("MARKET_DIVERGENCE_RI_LOW");
    if (reach > 0 && reach <= 8) softWarnings.push("MILD_REACH");
    if (reach > 8) softWarnings.push("SEVERE_REACH");
    if (needWeight(needState, pos) < 0) softWarnings.push("ROSTER_REDUNDANT");
    if (surv.confidence === "LOW" || surv.confidence === "UNAVAILABLE") softWarnings.push("SURVIVAL_UNCERTAIN");
    if (poolThin) softWarnings.push("THIN_CANDIDATE_SET");
    if (surv.p_survives_next_pick >= 0.8) softWarnings.push("SURVIVES_EASILY");

    const rec: DraftRecommendation = {
      kind: "ALTERNATE",
      rank: 0,
      player_id: p.player_id,
      player_name: p.full_name,
      position: pos,
      team: p.team,
      recommendation_score: score,
      projected_points: round2(p.league_points),
      vor: round2(vor),
      position_rank: tp?.position_rank ?? 0,
      tier: tp?.tier ?? 0,
      tier_drop: round2(tierDrop),
      distance_to_next_in_tier: tp?.distance_to_next_in_tier ?? 0,
      distance_to_next_tier: tp?.distance_to_next_tier ?? 0,
      positional_scarcity: sc.scarcity_index,
      roster_need: round2(needVal),
      positional_advantage: round2(posAdv),
      current_pick: turn.current_pick?.overall ?? null,
      // decision-relevant horizon: the pick that actually follows a wait (past
      // the snake turn when the manager owns two consecutive picks).
      next_manager_pick: nextPickOverall,
      picks_until_next: turn.is_consecutive_turn ? interveningToNext : turn.picks_until_next,
      market_adp:
        input.market.by_player.get(p.player_id)?.adp ??
        input.market.by_player.get(p.player_id)?.search_rank ??
        null,
      reach_cost: round2(reach),
      survival: surv,
      tier_survival: tierSurv,
      wait_comparison: wc,
      cross_position_costs: [],
      confidence: {
        projection: p.confidence,
        survival: surv.confidence,
        decision: decisionConfidence(p.confidence, surv.confidence, poolThin),
      },
      construction_effect: {
        starter_completion_risk_before: trajectory.starter_completion_risk,
        starter_completion_risk_after: round2(
          Math.max(0, Math.min(1, trajectory.starter_completion_risk + riskDelta)),
        ),
        relieves_position: riskDelta < -0.02 ? pos : null,
      },
      utility_components: components,
      reason_codes: [],
      reason: "",
      warnings: dedupe(softWarnings),
      provenance: provenanceOf(input, input.market.source),
    };
    scored.push(rec);
  }

  // ---- classify + rank ------------------------------------------
  const legal = scored.filter((r) => r.recommendation_score > -1e8);
  legal.sort((a, b) => b.recommendation_score - a.recommendation_score);

  const altLimit = input.limits?.alternates ?? 6;
  const waitLimit = input.limits?.wait ?? 5;
  const dnrLimit = input.limits?.doNotReach ?? 5;

  const primary = legal[0] ?? null;
  const leadPositions = new Set<FantasyPosition>();
  if (primary) leadPositions.add(primary.position);

  // cross-position opportunity cost on the primary + close alternates (§21.3)
  const topForCross = legal.slice(0, 6);
  for (const r of topForCross) {
    r.cross_position_costs = topForCross
      .filter((o) => o.position !== r.position)
      .slice(0, 3)
      .map((o) => {
        const ol = outlooks.get(o.position)!;
        return waitComparisonForPlayer(ol, o.projected_points, o.vor);
      });
  }

  const alternates: DraftRecommendation[] = [];
  const waitCandidates: DraftRecommendation[] = [];
  const doNotReach: DraftRecommendation[] = [];

  for (const r of legal.slice(1)) {
    const survivesEasily = r.survival.p_survives_next_pick >= 0.75;
    const bigReach = r.reach_cost > 6;
    if (bigReach && survivesEasily && doNotReach.length < dnrLimit) {
      r.kind = "DO_NOT_REACH";
      doNotReach.push(r);
    } else if (survivesEasily && r.utility_components.urgency < 3 && waitCandidates.length < waitLimit) {
      r.kind = "WAIT_CANDIDATE";
      waitCandidates.push(r);
    } else if (alternates.length < altLimit) {
      r.kind = "ALTERNATE";
      alternates.push(r);
    }
  }
  if (primary) primary.kind = "PRIMARY_RECOMMENDATION";

  // ---- reasons -------------------------------------------------
  const allOut = [primary, ...alternates, ...waitCandidates, ...doNotReach].filter(
    (r): r is DraftRecommendation => !!r,
  );
  allOut.forEach((r, i) => {
    r.rank = i + 1;
    const { codes, text } = buildReason(r, {
      turn,
      kdstReleased: kdstGate.released,
      kdstReleaseRound: kdstGate.release_round,
      trajectory,
    });
    r.reason_codes = codes as ReasonCode[];
    r.reason = text;
  });

  // ---- turn-pair optimisation (§21A) --------------------------
  let primaryPair = null as RecommendationResponse["primary_pair"];
  let alternatePairs: RecommendationResponse["alternate_pairs"] = [];
  if (turn.is_consecutive_turn && legal.length >= 2) {
    // forecast each position's board at the manager's NEXT turn (3rd/4th picks):
    // horizon = second_next_manager_pick, with ~all intervening picks + the
    // manager's own two consecutive picks already spent.
    const secondNextOverall =
      turn.second_next_manager_pick?.overall ?? nextPickOverall + input.numTeams;
    const interveningToSecond = Math.max(0, secondNextOverall - (turn.current_pick?.overall ?? picksMade + 1) - 3);
    const nextTurnOutlooks = new Map<FantasyPosition, PositionOutlook>();
    for (const pos of SKILL) {
      const list = (availByPos.get(pos) ?? []).slice().sort((a, b) => b.league_points - a.league_points);
      const eff = runEffects.get(pos);
      const baseRate = baseline[pos] ?? 0;
      const extra = eff ? runExtraDemand(eff, baseRate, interveningToSecond) : 0;
      nextTurnOutlooks.set(
        pos,
        positionOutlook(
          pos,
          list.map((pl) => ({
            player_id: pl.player_id,
            league_points: pl.league_points,
            vor: vorFn(pl),
            p_survives_next_pick: estimateSurvival({
              playerId: pl.player_id,
              position: pos,
              targetPickOverall: secondNextOverall,
              interveningPicks: interveningToSecond,
              currentPickOverall: turn.current_pick?.overall ?? picksMade + 1,
              market: input.market,
              runExtraDemand: extra,
            }).p_survives_next_pick,
          })),
        ),
      );
    }
    // Pair candidacy is NOT single-pick urgency: a tier-cliff player who would
    // "survive" to the manager's 3rd pick has low single-pick urgency but is
    // exactly who the pair must lock in now (he is gone by the real next turn).
    // Rank the pair pool by value + cliff, not by the single-pick score.
    const pairPool = [...legal].sort(
      (a, b) =>
        b.vor + 1.2 * b.tier_drop + b.positional_advantage -
        (a.vor + 1.2 * a.tier_drop + a.positional_advantage),
    );
    const pairs = optimiseTurnPair({
      turn,
      candidates: pairPool,
      nextTurnOutlooks,
      tierBoundaries: SKILL.flatMap((p) => tiers.get(p)?.boundaries ?? []),
      openStarters: trajectory.open_starters,
      openFlex: trajectory.open_flex,
      provenance: provenanceOf(input, input.market.source),
    });
    primaryPair = pairs.primary_pair;
    alternatePairs = pairs.alternate_pairs;
  }

  // ---- assemble response -------------------------------------
  const replacementRows = SKILL.map((p) => levels.by_position[p]).filter(Boolean);
  const boundaryRows = SKILL.flatMap((p) => (tiers.get(p)?.boundaries ?? []));

  return {
    readiness,
    recommendation_model_version: RECOMMENDATION_MODEL_VERSION,
    recommendation_schema_version: RECOMMENDATION_SCHEMA_VERSION,
    provenance: provenanceOf(input, input.market.source),
    turn,
    primary_recommendation: primary,
    alternates,
    wait_candidates: waitCandidates,
    do_not_reach: doNotReach,
    primary_pair: primaryPair,
    alternate_pairs: alternatePairs,
    replacement_levels: replacementRows,
    tier_boundaries: boundaryRows,
    scarcity: SKILL.map((p) => scarcity.get(p)).filter((x): x is ScarcitySnapshot => !!x),
    runs: runSignals.map((s) => ({ signal: s, effect: runEffects.get(s.position)! })),
    roster_trajectory: trajectory,
    manager_context: {
      used_roster_id: input.manager.roster_id,
      used_sleeper_user_id: input.manager.sleeper_user_id,
      used_manager_slug: input.manager.manager_slug,
      used_draft_slot: input.manager.draft_slot,
      roster_player_count: input.rosterPlayers.length,
      roster_position_counts: countPositions(input.rosterPlayers),
      candidate_pool_size: available.length,
    },
    warnings,
  };
}

/* ------------------------------------------------------------------ utils */

function countPositions(players: NormalizedPlayer[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of players) {
    const pos = p.position ?? "?";
    out[pos] = (out[pos] ?? 0) + 1;
  }
  return out;
}
function dedupe<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}
function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
