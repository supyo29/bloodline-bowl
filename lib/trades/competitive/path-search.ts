/**
 * Competitive Trade Intelligence — BOUNDED MULTI-STEP TRADE PATHS
 * (Checkpoint F, §20–§54, §77).
 *
 * Compares, for improving OUR roster:
 *   - DIRECT_ACQUISITION   A → C            (one completed trade)
 *   - TWO_STEP_UPGRADE     A → B, then B → C (two completed trades)
 *   - BUY_AND_HOLD         acquire B and stop (a legitimate terminal decision)
 *   - HOLD_CURRENT_ASSET   keep A, do nothing
 *   - NO_ACTION            do nothing at all
 *
 * HARD BOUND: `max_completed_trades = 2`. This is NOT arbitrary-depth graph
 * search — it is a staged beam search (§48–§49):
 *   1. seed with our top market-SELL assets
 *   2. structurally-plausible + competitively-certified first trades
 *   3. retain the top K first-step states
 *   4. score liquidity / appreciation of the acquired asset
 *   5. second trades ONLY from the retained states, few targets each
 *   6. prune dominated final states; block circular (A→B→A) and duplicate states
 *   7. always compare against DIRECT, NO_ACTION and HOLD_CURRENT_ASSET
 *
 * §38 — path-level private utility is the FINAL roster's permanent value
 * relative to the INITIAL roster (final-state comparison is authoritative); the
 * two-step final delta is evaluated as the synthetic net swap (give A / receive
 * C) because the intermediary nets out for us.
 * §30 — future market correction is NEVER counted as guaranteed value.
 * §40–§42 — path feasibility is qualitative (weakest edge), never a multiplied
 * probability.
 */

import type { TradeAnalysisContext } from "../context";
import { resolveTradeConfig } from "../config";
import { evaluateCandidate } from "../discovery/candidate-eval";
import type { CompetitiveTradeEvaluationContext } from "./eval-context";
import { evaluateCompetitiveTrade } from "./evaluate";
import { buildTradeLiquidity } from "./liquidity";
import { buildMarketAppreciation, appreciationIsTrustworthy } from "./appreciation";
import { buildHoldEvaluation } from "./hold";
import { resolveCompetitiveFConfig, type CompetitiveFConfig, type PartialCompetitiveFConfig } from "./config";
import type {
  AcceptanceLikelihood,
  PathStep,
  StrategyPath,
  StrategyPathComparison,
  ValueConfidence,
} from "./schema";

const ACC_RANK: Record<AcceptanceLikelihood, number> = { VERY_LOW: 0, LOW: 1, MODERATE: 2, HIGH: 3 };
const CONF_RANK: Record<ValueConfidence, number> = { VERY_LOW: 0, LOW: 1, MEDIUM: 2, HIGH: 3 };
const CONF_ORDER: ValueConfidence[] = ["VERY_LOW", "LOW", "MEDIUM", "HIGH"];

function minAcc(a: AcceptanceLikelihood, b: AcceptanceLikelihood): AcceptanceLikelihood {
  return ACC_RANK[a] <= ACC_RANK[b] ? a : b;
}
function minConf(a: ValueConfidence, b: ValueConfidence): ValueConfidence {
  return CONF_RANK[a] <= CONF_RANK[b] ? a : b;
}

export interface BuildStrategyPathsInput {
  ec: CompetitiveTradeEvaluationContext;
  my_manager_id: string;
  config?: PartialCompetitiveFConfig;
}

interface FirstStep {
  give: string; // our asset id
  receive: string; // acquired asset id
  counterparty_id: string;
  counterparty_slug: string;
  our_permanent: number;
  acceptance: AcceptanceLikelihood;
  externality: number;
  friction: number;
  confidence: ValueConfidence;
  reasons: string[];
}

export function buildStrategyPathComparison(input: BuildStrategyPathsInput): StrategyPathComparison {
  const t0 = performance.now();
  const { ec, my_manager_id } = input;
  const ctx = ec.ctx;
  const cfg: CompetitiveFConfig = resolveCompetitiveFConfig(input.config);
  const P = cfg.path;
  const tradeConfig = ec.trade_config ?? resolveTradeConfig();
  const evalCtx = ec.discovery_eval_context;

  const me = ec.owner_context(my_manager_id);
  const reasons: string[] = [];
  const stats = {
    first_step_states_evaluated: 0,
    second_step_paths_evaluated: 0,
    dominated_paths_pruned: 0,
    circular_paths_blocked: 0,
    elapsed_ms: 0,
  };

  if (!me.available || !me.roster) {
    stats.elapsed_ms = round2(performance.now() - t0);
    return {
      readiness: "UNAVAILABLE",
      paths: [noActionPath(), holdCurrentPath(null)],
      recommended: "NO_ACTION",
      direct_path_preferred: true,
      search_stats: stats,
      reasons: ["our roster context is unavailable — only NO_ACTION can be evaluated"],
    };
  }

  const ownership = new Map<string, string>();
  for (const r of ctx.snapshot.rosters) for (const id of r.all_players) ownership.set(id, r.canonical_team_id);
  const managerByTeam = new Map<string, string>();
  for (const team of ctx.snapshot.teams) if (team.canonical_manager_ids[0]) managerByTeam.set(team.canonical_team_id, team.canonical_manager_ids[0]);
  const ownerOf = (pid: string): string | null => {
    const tid = ownership.get(pid);
    return tid ? managerByTeam.get(tid) ?? null : null;
  };

  // ---- §48 seed: our top market-SELL assets ----
  const sellSeeds = [...me.by_player.values()]
    .map((pc) => {
      const edge = ec.dynamic_edges.get(pc.canonical_player_id) ?? ec.market_table.edges.by_player.get(pc.canonical_player_id) ?? null;
      return { pc, edge, sell_pressure: edge && (edge.actionable_edge ?? 0) < 0 ? Math.abs(edge.actionable_edge ?? 0) : 0 };
    })
    .filter((s) => s.pc.starter_importance !== "IR")
    .sort((a, b) => b.sell_pressure - a.sell_pressure || a.pc.canonical_player_id.localeCompare(b.pc.canonical_player_id))
    .slice(0, P.max_first_step_states);

  const evalTrade = (give: string[], receive: string[], cpId: string) => {
    const transfers = [
      ...give.map((id) => ({ from_manager_id: my_manager_id, to_manager_id: cpId, canonical_player_id: id })),
      ...receive.map((id) => ({ from_manager_id: cpId, to_manager_id: my_manager_id, canonical_player_id: id })),
    ];
    const cand = evaluateCandidate([my_manager_id, cpId], transfers, ctx, evalCtx, tradeConfig);
    if (!cand.ok || !cand.evaluation) return null;
    const comp = evaluateCompetitiveTrade({
      baseline: cand.evaluation,
      ctx,
      my_manager_id,
      incoming_player_ids: receive,
      outgoing_player_ids: give,
      counterparty_manager_id: cpId,
      eval_context: ec,
    });
    return comp.competitive;
  };

  const frictionFor = (acceptance: AcceptanceLikelihood, externality: number, optionalityLoss: number): number => {
    const f = P.friction;
    const rejectionRisk = (3 - ACC_RANK[acceptance]) / 3;
    return round2(
      f.base_per_trade +
        f.rejection_risk_weight * rejectionRisk +
        f.time_delay_weight +
        f.news_exposure_weight +
        f.opponent_strengthening_weight * Math.max(0, externality) +
        f.optionality_loss_weight * Math.max(0, optionalityLoss) +
        f.roster_churn_weight,
    );
  };

  // ---- §49 first trades ----
  const firstSteps: FirstStep[] = [];
  for (const seed of sellSeeds) {
    const give = seed.pc.canonical_player_id;
    let best: FirstStep | null = null;
    for (const m of ctx.snapshot.managers) {
      if (m.canonical_manager_id === my_manager_id) continue;
      const oc = ec.owner_context(m.canonical_manager_id);
      if (!oc.available || !oc.roster) continue;
      // single best target on THIS manager for us: highest our-private normalized value we don't roster
      let target: string | null = null;
      let targetVal = -Infinity;
      for (const pid of oc.roster.all_players) {
        if (me.by_player.has(pid)) continue;
        const edge = ec.market_table.edges.by_player.get(pid);
        const v = edge?.private_value?.normalized_value ?? null;
        if (v == null) continue;
        if (v > targetVal) {
          targetVal = v;
          target = pid;
        }
      }
      if (!target) continue;
      stats.first_step_states_evaluated += 1;
      const comp = evalTrade([give], [target], m.canonical_manager_id);
      if (!comp) continue;
      const perm = comp.our_trade_horizons?.permanent_trade_utility ?? null;
      const acc = comp.acceptance?.overall_acceptance_likelihood ?? comp.acceptance?.likelihood ?? "VERY_LOW";
      const ext = comp.competitive_externality?.score ?? 0;
      const cls = comp.competitive_result?.classification ?? null;
      const conf = comp.competitive_result?.confidence ?? comp.acceptance?.confidence ?? "VERY_LOW";
      // §49 competitive certification
      const certified =
        perm != null &&
        perm >= (ec.d_config.result?.min_our_gain ?? 0.25) &&
        acc !== "VERY_LOW" &&
        cls !== "REJECT" &&
        cls !== "AVOID_COMPETITIVE_COST" &&
        (comp.competitive_result?.actionable ?? false);
      if (!certified) continue;
      const fr = frictionFor(acc, ext, 0);
      const step: FirstStep = {
        give,
        receive: target,
        counterparty_id: m.canonical_manager_id,
        counterparty_slug: oc.manager_slug,
        our_permanent: perm!,
        acceptance: acc,
        externality: ext,
        friction: fr,
        confidence: conf,
        reasons: [
          `${me.manager_slug} sends ${nameOf(ctx, give)} → ${oc.manager_slug} for ${nameOf(ctx, target)}: permanent utility ${perm!.toFixed(2)}, acceptance ${acc}, externality ${ext.toFixed(2)}, result ${cls}`,
        ],
      };
      if (!best || step.our_permanent > best.our_permanent) best = step;
    }
    if (best) firstSteps.push(best);
  }

  firstSteps.sort((a, b) => b.our_permanent - a.our_permanent || a.receive.localeCompare(b.receive));
  const retained = firstSteps.slice(0, P.max_first_step_states);

  const paths: StrategyPath[] = [];

  // ---- DIRECT (§45) ----
  const direct = retained[0] ?? null;
  let bestDirectImprovement = 0;
  if (direct) {
    bestDirectImprovement = direct.our_permanent;
    paths.push({
      strategy: "DIRECT_ACQUISITION",
      readiness: "FULL_PATH_CONTEXT",
      confidence: direct.confidence,
      starting_state: rosterId(me.roster.all_players),
      steps: [firstStepToPathStep(direct)],
      final_state: finalStateFor(ec, my_manager_id, direct.receive, direct.our_permanent, input.config),
      aggregate: {
        transactions: 1,
        competitive_externality: direct.externality,
        externality_trade_1: direct.externality,
        externality_trade_2: null,
        friction: direct.friction,
        feasibility: direct.acceptance,
        edge_feasibility: [direct.acceptance],
        score: 0,
      },
      reasons: [`best certified direct upgrade: ${direct.reasons[0]}`],
    });
  }

  // ---- BUY_AND_HOLD + second trades from retained states ----
  const weeksRemaining = Math.max(1, ctx.ros.weeks.length);
  let bestTwoStepImprovement = 0;

  for (const fs of retained) {
    const liq = buildTradeLiquidity({ ec, canonical_player_id: fs.receive, current_owner_manager_id: my_manager_id, my_manager_id, config: input.config });
    const appr = buildMarketAppreciation({ ec, canonical_player_id: fs.receive, config: input.config });
    const hold = buildHoldEvaluation({
      acquire_ids: [fs.receive],
      permanent_gain: fs.our_permanent,
      permanent_confidence: fs.confidence,
      liquidity: [liq],
      appreciation: [appr],
      weeks_remaining: weeksRemaining,
      config: input.config,
    });

    if (hold.decision === "ACQUIRE_AND_HOLD" || hold.decision === "DO_NOTHING") {
      // BUY_AND_HOLD is only a distinct recommended path when holding is affirmatively justified
      if (hold.decision === "ACQUIRE_AND_HOLD") {
        paths.push({
          strategy: "BUY_AND_HOLD",
          readiness: "FULL_PATH_CONTEXT",
          confidence: minConf(fs.confidence, hold.confidence),
          starting_state: rosterId(me.roster.all_players),
          steps: [firstStepToPathStep(fs)],
          final_state: {
            permanent_roster_delta: fs.our_permanent,
            liquidity: liq.classification,
            appreciation: appr.classification,
            future_optionality: hold.future_optionality.score,
          },
          aggregate: {
            transactions: 1,
            competitive_externality: fs.externality,
            externality_trade_1: fs.externality,
            externality_trade_2: null,
            friction: fs.friction,
            feasibility: fs.acceptance,
            edge_feasibility: [fs.acceptance],
            score: 0,
          },
          reasons: [`acquire ${nameOf(ctx, fs.receive)} and hold — ${hold.reasons[0]}`, ...hold.hold_until_conditions.map((c) => `HOLD UNTIL: ${c}`)],
        });
      }
    }

    // ---- second trades: flip the acquired asset ----
    const secondTargets: Array<{ cpId: string; slug: string; upId: string; comp: ReturnType<typeof evalTrade> }> = [];
    for (const m2 of ctx.snapshot.managers) {
      if (m2.canonical_manager_id === my_manager_id) continue;
      const oc2 = ec.owner_context(m2.canonical_manager_id);
      if (!oc2.available || !oc2.roster) continue;
      let upId: string | null = null;
      let upVal = -Infinity;
      for (const pid of oc2.roster.all_players) {
        if (me.by_player.has(pid)) continue;
        if (pid === fs.give) {
          stats.circular_paths_blocked += 1;
          continue; // §51 — no A→B→A
        }
        const edge = ec.market_table.edges.by_player.get(pid);
        const v = edge?.private_value?.normalized_value ?? null;
        if (v == null) continue;
        const seedEdge = ec.market_table.edges.by_player.get(fs.receive);
        if (v <= (seedEdge?.private_value?.normalized_value ?? -Infinity)) continue; // must be an upgrade
        if (v > upVal) {
          upVal = v;
          upId = pid;
        }
      }
      if (!upId) continue;
      secondTargets.push({ cpId: m2.canonical_manager_id, slug: oc2.manager_slug, upId, comp: null });
    }
    secondTargets.sort((a, b) => (ec.market_table.edges.by_player.get(b.upId)?.private_value?.normalized_value ?? 0) - (ec.market_table.edges.by_player.get(a.upId)?.private_value?.normalized_value ?? 0));
    const seenFinal = new Set<string>();

    for (const st of secondTargets.slice(0, P.max_second_step_targets_per_state)) {
      stats.second_step_paths_evaluated += 1;
      // edge 2: we give fs.receive, receive st.upId, counterparty st.cpId
      const comp2 = evalTrade([fs.receive], [st.upId], st.cpId);
      if (!comp2) continue;
      const acc2 = comp2.acceptance?.overall_acceptance_likelihood ?? comp2.acceptance?.likelihood ?? "VERY_LOW";
      const ext2 = comp2.competitive_externality?.score ?? 0;
      const cls2 = comp2.competitive_result?.classification ?? null;
      const conf2 = comp2.competitive_result?.confidence ?? comp2.acceptance?.confidence ?? "VERY_LOW";
      if (acc2 === "VERY_LOW" || cls2 === "REJECT") continue;

      // §38 final-state authoritative: synthetic net swap give fs.give / receive st.upId
      const synth = evalTrade([fs.give], [st.upId], st.cpId);
      const finalPerm = synth?.our_trade_horizons?.permanent_trade_utility ?? null;
      if (finalPerm == null) continue;

      // §52 duplicate-equivalent state guard
      const finalKey = `${fs.give}|${st.upId}`;
      if (seenFinal.has(finalKey)) {
        stats.dominated_paths_pruned += 1;
        continue;
      }
      seenFinal.add(finalKey);

      const fr2 = frictionFor(acc2, ext2, /*optionality loss of flipping*/ liq.classification === "HIGH" || liq.classification === "VERY_HIGH" ? 0.5 : 0.2);
      const aggFriction = round2(fs.friction + fr2);
      const aggExt = round2(fs.externality + ext2);
      const feas = minAcc(fs.acceptance, acc2);
      const conf = minConf(minConf(fs.confidence, conf2), CONF_ORDER[Math.max(0, CONF_RANK[fs.confidence] - 1)]!); // §42 path ≤ weakest critical edge, and never above a one-step lower bound

      const upLiq = buildTradeLiquidity({ ec, canonical_player_id: st.upId, current_owner_manager_id: my_manager_id, my_manager_id, config: input.config });
      const upAppr = buildMarketAppreciation({ ec, canonical_player_id: st.upId, config: input.config });

      bestTwoStepImprovement = Math.max(bestTwoStepImprovement, finalPerm);

      paths.push({
        strategy: "TWO_STEP_UPGRADE",
        readiness: "FULL_PATH_CONTEXT",
        confidence: conf,
        starting_state: rosterId(me.roster.all_players),
        steps: [
          firstStepToPathStep(fs),
          {
            counterparty_manager_id: st.cpId,
            counterparty_slug: st.slug,
            give: [fs.receive],
            receive: [st.upId],
            permanent_trade_utility: comp2.our_trade_horizons?.permanent_trade_utility ?? null,
            acceptance: acc2,
            opponent_externality: ext2,
            transaction_friction: fr2,
            reasons: [`then flip ${nameOf(ctx, fs.receive)} → ${st.slug} for ${nameOf(ctx, st.upId)} (acceptance ${acc2}, externality ${ext2.toFixed(2)})`],
          },
        ],
        final_state: {
          permanent_roster_delta: round2(finalPerm),
          liquidity: upLiq.classification,
          appreciation: upAppr.classification,
          future_optionality: null,
        },
        aggregate: {
          transactions: 2,
          competitive_externality: aggExt,
          externality_trade_1: fs.externality,
          externality_trade_2: ext2,
          friction: aggFriction,
          feasibility: feas,
          edge_feasibility: [fs.acceptance, acc2],
          score: 0,
        },
        reasons: [
          `two-step: ${nameOf(ctx, fs.give)} → ${nameOf(ctx, fs.receive)} → ${nameOf(ctx, st.upId)}. Final permanent roster improvement vs today ${finalPerm.toFixed(2)} (final-state comparison, §38). Path feasibility ${feas} (weakest edge; NOT a multiplied probability, §41).`,
          appreciationIsTrustworthy(upAppr) ? `final asset appreciation ${upAppr.classification}` : "final-asset appreciation not counted as guaranteed value (§30)",
        ],
      });
    }
  }

  // ---- always-present terminal options (§45–§47) ----
  paths.push(noActionPath());
  paths.push(holdCurrentPath(retained[0]?.give ? nameOf(ctx, sellSeeds[0]?.pc.canonical_player_id ?? "") : null));

  // ---- §50 dominance pruning ----
  const kept: StrategyPath[] = [];
  for (const p of paths) {
    const dominated = paths.some(
      (q) =>
        q !== p &&
        (q.final_state.permanent_roster_delta ?? 0) >= (p.final_state.permanent_roster_delta ?? 0) &&
        q.aggregate.competitive_externality <= p.aggregate.competitive_externality &&
        q.aggregate.friction <= p.aggregate.friction &&
        ACC_RANK[q.aggregate.feasibility] >= ACC_RANK[p.aggregate.feasibility] &&
        ((q.final_state.permanent_roster_delta ?? 0) > (p.final_state.permanent_roster_delta ?? 0) ||
          q.aggregate.friction < p.aggregate.friction),
    );
    if (dominated) {
      stats.dominated_paths_pruned += 1;
      continue;
    }
    kept.push(p);
  }

  // ---- §44 ranking ----
  for (const p of kept) {
    const r = P.ranking;
    const improvement = p.final_state.permanent_roster_delta ?? 0;
    const inefficiency =
      p.final_state.appreciation === "HIGH_APPRECIATION_POTENTIAL"
        ? 0.5
        : p.final_state.appreciation === "MODERATE_APPRECIATION_POTENTIAL"
          ? 0.25
          : 0;
    const optionality = p.final_state.future_optionality ?? 0;
    const uncertainty = (3 - CONF_RANK[p.confidence]) * 0.2;
    p.aggregate.score = round2(
      r.final_permanent_improvement * improvement +
        r.trustworthy_market_inefficiency * inefficiency +
        r.future_optionality * optionality -
        r.aggregate_externality * Math.max(0, p.aggregate.competitive_externality) -
        r.transaction_friction * p.aggregate.friction -
        r.uncertainty * uncertainty,
    );
  }

  kept.sort((a, b) => b.aggregate.score - a.aggregate.score);

  // ---- §26/§27 direct-path preference ----
  let recommended = kept[0]?.strategy ?? "NO_ACTION";
  let directPreferred = false;
  const bestDirect = kept.find((p) => p.strategy === "DIRECT_ACQUISITION");
  const bestTwoStep = kept.find((p) => p.strategy === "TWO_STEP_UPGRADE");
  if (bestDirect && bestTwoStep) {
    const twoStepEdge =
      (bestTwoStep.final_state.permanent_roster_delta ?? 0) - (bestDirect.final_state.permanent_roster_delta ?? 0);
    if (twoStepEdge < P.min_two_step_improvement) {
      directPreferred = true;
      recommended = "DIRECT_ACQUISITION";
      reasons.push(
        `two-step best final improvement exceeds the best direct path by only ${twoStepEdge.toFixed(2)} (< ${P.min_two_step_improvement} threshold, §26) — DIRECT_PATH_PREFERRED (§27).`,
      );
    } else {
      reasons.push(
        `INTERMEDIATE_ASSET_CREATES_OPTIONALITY (§28): the two-step final improvement beats the best direct path by ${twoStepEdge.toFixed(2)} weekly-equivalent.`,
      );
    }
  }
  void bestDirectImprovement;
  void bestTwoStepImprovement;
  void ownerOf;

  stats.elapsed_ms = round2(performance.now() - t0);
  reasons.unshift(
    `staged beam search: ${stats.first_step_states_evaluated} first-step evaluations, ${retained.length} retained, ${stats.second_step_paths_evaluated} two-step evaluations, ${stats.dominated_paths_pruned} dominated pruned, ${stats.circular_paths_blocked} circular blocked. Max completed trades ${P.max_completed_trades}. (timing in search_stats.elapsed_ms)`,
  );

  return {
    readiness: retained.length > 0 ? "FULL_PATH_CONTEXT" : "DIRECT_ONLY",
    paths: kept,
    recommended,
    direct_path_preferred: directPreferred,
    search_stats: stats,
    reasons,
  };
}

// ---- helpers ----

function firstStepToPathStep(fs: FirstStep): PathStep {
  return {
    counterparty_manager_id: fs.counterparty_id,
    counterparty_slug: fs.counterparty_slug,
    give: [fs.give],
    receive: [fs.receive],
    permanent_trade_utility: fs.our_permanent,
    acceptance: fs.acceptance,
    opponent_externality: fs.externality,
    transaction_friction: fs.friction,
    reasons: fs.reasons,
  };
}

function finalStateFor(
  ec: CompetitiveTradeEvaluationContext,
  myId: string,
  acquiredId: string,
  perm: number,
  cfg?: PartialCompetitiveFConfig,
) {
  const liq = buildTradeLiquidity({ ec, canonical_player_id: acquiredId, current_owner_manager_id: myId, my_manager_id: myId, config: cfg });
  const appr = buildMarketAppreciation({ ec, canonical_player_id: acquiredId, config: cfg });
  return {
    permanent_roster_delta: round2(perm),
    liquidity: liq.classification,
    appreciation: appr.classification,
    future_optionality: null as number | null,
  };
}

function noActionPath(): StrategyPath {
  return {
    strategy: "NO_ACTION",
    readiness: "FULL_PATH_CONTEXT",
    confidence: "HIGH",
    starting_state: "current",
    steps: [],
    final_state: { permanent_roster_delta: 0, liquidity: null, appreciation: null, future_optionality: null },
    aggregate: {
      transactions: 0,
      competitive_externality: 0,
      externality_trade_1: null,
      externality_trade_2: null,
      friction: 0,
      feasibility: "HIGH",
      edge_feasibility: [],
      score: 0,
    },
    reasons: ["do nothing — always evaluated as a legitimate baseline (§45). No roster change, no externality, no friction."],
  };
}

function holdCurrentPath(assetName: string | null): StrategyPath {
  return {
    strategy: "HOLD_CURRENT_ASSET",
    readiness: "FULL_PATH_CONTEXT",
    confidence: "MEDIUM",
    starting_state: "current",
    steps: [],
    final_state: { permanent_roster_delta: 0, liquidity: null, appreciation: null, future_optionality: null },
    aggregate: {
      transactions: 0,
      competitive_externality: 0,
      externality_trade_1: null,
      externality_trade_2: null,
      friction: 0,
      feasibility: "HIGH",
      edge_feasibility: [],
      score: 0,
    },
    reasons: [
      assetName
        ? `hold ${assetName} rather than sell into a thin market — keeping a current asset is a legitimate terminal decision (§46), not passive failure.`
        : "hold current assets — a legitimate terminal decision (§46).",
    ],
  };
}

function rosterId(ids: string[]): string {
  return [...ids].sort().join(",").slice(0, 64);
}
function nameOf(ctx: TradeAnalysisContext, id: string): string {
  return ctx.players_by_id.get(id)?.full_name ?? id;
}
function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
