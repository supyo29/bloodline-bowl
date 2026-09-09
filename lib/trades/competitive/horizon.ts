/**
 * Competitive Trade Intelligence — horizon-aware permanent-trade utility
 * (Checkpoint D.5).
 *
 * `evaluateTrade`'s `roster_utility_delta` measures the CURRENT WEEK's optimal
 * lineup (Phase 1). For a PERMANENT trade that over-weights one matchup. This
 * module reads the ROS horizon (already computed by Phase 2's `ros.ts`, just
 * never folded in — all Phase 2 weights default to 0) and blends an
 * ROS-dominant `permanent_trade_utility`, keeping the immediate delta visible.
 *
 * It does NOT touch `evaluateTrade` (legacy path unchanged, §29/§31). The
 * competitive path consumes `permanent_trade_utility`; legacy discovery keeps
 * the immediate value.
 *
 * ROS absolute arithmetic uses the EXTERNAL (Sleeper) prorated projection —
 * `ros.ts`'s documented basis. RI's independent season model is consumed
 * ORDINALLY as a disagreement / confidence signal (`ri_ordinal`): when RI's
 * VOR direction contradicts the external ROS direction the classification is
 * `REVIEW_REQUIRED`.
 */

import type { TradeAnalysisContext } from "../context";
import type { TradeEvaluationOutput } from "../evaluate";
import type { HorizonConfig } from "./config";
import { resolveHorizonConfig, type PartialHorizonConfig } from "./config";
import type {
  HorizonClassification,
  HorizonReadiness,
  RiOrdinalReconciliation,
  TradeHorizonEvaluation,
  ValueConfidence,
} from "./schema";

const CONF_LEVEL: Record<ValueConfidence, number> = { HIGH: 3, MEDIUM: 2, LOW: 1, VERY_LOW: 0 };
const LEVEL_CONF: ValueConfidence[] = ["VERY_LOW", "LOW", "MEDIUM", "HIGH"];

export interface HorizonEvalInput {
  baseline: TradeEvaluationOutput;
  ctx: TradeAnalysisContext;
  manager_slug: string;
  /** ids this manager RECEIVES */
  incoming_ids: string[];
  /** ids this manager GIVES UP */
  outgoing_ids: string[];
  config?: PartialHorizonConfig;
}

export function evaluateTradeHorizons(input: HorizonEvalInput): TradeHorizonEvaluation {
  const cfg: HorizonConfig = resolveHorizonConfig(input.config);
  const { baseline, ctx, manager_slug } = input;
  const reasons: string[] = [];

  const r =
    baseline.participants[manager_slug] ??
    Object.values(baseline.participants).find((p) => p.manager_slug === manager_slug);

  if (!r) {
    return degenerate(manager_slug, "UNAVAILABLE", ["participant not found in the trade evaluation"]);
  }

  const remainingWeeks = Math.max(1, ctx.ros.weeks.length);

  // ---- immediate horizon (Phase 1, current week) ----
  const immediate = {
    starter_delta: r.starter_points_delta,
    depth_delta: round4(r.bench_value_delta),
    positional_need_delta: round4(r.roster_utility_components.positional_need),
    total_delta: round4(r.roster_utility_delta),
  };

  // ---- ROS horizon (Phase 2's ros.ts — already computed) ----
  const p2 = r.phase2 ?? null;
  let horizonReadiness: HorizonReadiness;
  if (!p2) {
    horizonReadiness = "CURRENT_WEEK_ONLY";
    reasons.push("Phase 2 ROS context not present — permanent utility falls back to the immediate week only");
  } else if (ctx.ros.schedule_status === "UNAVAILABLE") {
    horizonReadiness = "PARTIAL_ROS_CONTEXT";
    reasons.push("no verified remaining-week schedule — ROS bye effects not modeled");
  } else {
    horizonReadiness = "FULL_ROS_CONTEXT";
  }

  const rosStarterSeason = p2 ? p2.ros.ros_usable_value_delta : 0;
  const rosStarterWeekly = round4(rosStarterSeason / remainingWeeks);
  const rosDepthSeason = p2 ? p2.ros.after.stranded_ros_points - p2.ros.before.stranded_ros_points : 0;
  const rosDepthWeekly = round4(rosDepthSeason / remainingWeeks);
  const playoffWindow = p2?.components.playoff_window ?? null;
  const byeCoverage = p2?.components.bye_coverage ?? 0;

  // ---- availability adjustment (§9) — injury-discount the traded players' ROS rate ----
  const availDelta = availabilityAdjustment(ctx, input.incoming_ids, input.outgoing_ids, remainingWeeks);
  if (Math.abs(availDelta) > 0.1) {
    reasons.push(
      availDelta < 0
        ? `incoming player(s) carry more injury risk than outgoing — availability drag ${availDelta.toFixed(2)}/wk`
        : `incoming player(s) are healthier than outgoing — availability lift +${availDelta.toFixed(2)}/wk`,
    );
  }

  const w = cfg.ros_weights;
  const rosTotal = round4(
    w.starter * rosStarterWeekly +
      w.depth * rosDepthWeekly +
      w.availability * availDelta +
      w.playoff_window * (playoffWindow ?? 0) +
      w.bye_coverage * byeCoverage,
  );

  const ros = {
    starter_delta: rosStarterWeekly,
    depth_delta: rosDepthWeekly,
    availability_delta: round4(availDelta),
    playoff_window_delta: playoffWindow,
    bye_coverage_delta: round4(byeCoverage),
    total_delta: rosTotal,
    standalone_ros_swing: p2 ? round2(p2.ros.standalone_ros_swing) : 0,
    usable_ros_value_delta_season: round2(rosStarterSeason),
  };

  // ---- RI ordinal reconciliation ----
  const ri_ordinal = reconcileRiOrdinal(ctx, input.incoming_ids, input.outgoing_ids, rosStarterWeekly, cfg);
  if (ri_ordinal.sign_conflict) {
    reasons.push(`RI season model DISAGREES with the external ROS projection on direction (${ri_ordinal.note}) — permanent utility uses the external basis; treat as REVIEW_REQUIRED`);
  }

  // ---- permanent-trade utility: ROS-dominant blend ----
  const seasonProgress = clamp01((ctx.week - 1) / Math.max(1, (ctx.ros.championship_week ?? 17) - 1));
  const immediateWeight = Math.min(
    cfg.immediate_weight_cap,
    cfg.immediate_weight_base + cfg.immediate_weight_season_slope * seasonProgress,
  );
  const rosWeight = round4(1 - immediateWeight);
  const permanent = round4(rosWeight * rosTotal + immediateWeight * immediate.total_delta);

  if (immediate.total_delta != null) {
    reasons.push(
      `permanent utility = ${rosWeight.toFixed(2)}·ROS(${rosTotal.toFixed(2)}) + ${immediateWeight.toFixed(2)}·immediate(${immediate.total_delta.toFixed(2)}) = ${permanent.toFixed(2)}/wk`,
    );
  }

  // ---- classification ----
  const classification = classifyHorizon(immediate.total_delta, rosTotal, ri_ordinal, cfg);

  // ---- confidence ----
  const ceiling = cfg.readiness_confidence_ceiling[horizonReadiness];
  let level = CONF_LEVEL[ceiling as ValueConfidence];
  if (ri_ordinal.sign_conflict) level = Math.max(0, level - 1);
  if (classification === "REVIEW_REQUIRED") level = Math.max(0, level - 1);
  if ((p2?.ros.ros_usable_value_delta ?? null) == null) level = Math.max(0, level - 1);

  return {
    manager_slug,
    immediate,
    ros,
    ri_ordinal,
    permanent_trade_utility: permanent,
    ros_weight: rosWeight,
    immediate_weight: round4(immediateWeight),
    horizon_classification: classification,
    horizon_readiness: horizonReadiness,
    confidence: LEVEL_CONF[Math.max(0, Math.min(3, level))]!,
    reasons,
  };
}

function availabilityAdjustment(
  ctx: TradeAnalysisContext,
  incoming: string[],
  outgoing: string[],
  remainingWeeks: number,
): number {
  // per-player: (expected_availability − 1) · ros_weekly_rate.  A player at 0.78
  // availability loses ~22% of their ROS rate not captured by the bye-only
  // proration in ros.ts.
  const rate = (id: string): number => {
    const wp = ctx.projections.by_player.get(id);
    const rosPts = wp?.ros?.points ?? wp?.rest_of_season_points ?? null;
    if (rosPts == null) return 0;
    return rosPts / remainingWeeks;
  };
  const drag = (id: string): number => {
    const avail = ctx.projections.by_player.get(id)?.expected_availability ?? 1;
    return (Math.min(1, Math.max(0, avail)) - 1) * rate(id); // ≤ 0
  };
  const inDrag = incoming.reduce((s, id) => s + drag(id), 0);
  const outDrag = outgoing.reduce((s, id) => s + drag(id), 0);
  // we ACQUIRE the incoming drag and SHED the outgoing drag
  return round4(inDrag - outDrag);
}

function reconcileRiOrdinal(
  ctx: TradeAnalysisContext,
  incoming: string[],
  outgoing: string[],
  externalRosWeekly: number,
  cfg: HorizonConfig,
): RiOrdinalReconciliation {
  const riVor = (id: string): number | null => ctx.projections.by_player.get(id)?.ros?.ri_vor ?? null;
  const rank = (id: string) => {
    const p = ctx.players_by_id.get(id);
    return { id, position: p?.position ?? "UNKNOWN", ri_position_rank: ctx.projections.by_player.get(id)?.ros?.ri_position_rank ?? null };
  };
  const inVor = incoming.map(riVor);
  const outVor = outgoing.map(riVor);
  const haveAll = [...inVor, ...outVor].every((v) => v != null);
  const riVorDelta = haveAll
    ? round2((inVor as number[]).reduce((s, v) => s + v, 0) - (outVor as number[]).reduce((s, v) => s + v, 0))
    : null;

  const disagreements = [...incoming, ...outgoing]
    .map((id) => ctx.projections.by_player.get(id)?.ros?.disagreement_pct ?? null)
    .filter((x): x is number => x != null)
    .map(Math.abs);
  const maxDisagreement = disagreements.length > 0 ? Math.max(...disagreements) : null;

  const signConflict =
    riVorDelta != null &&
    Math.abs(riVorDelta) > 3 &&
    Math.abs(externalRosWeekly) > 0.2 &&
    Math.sign(riVorDelta) !== Math.sign(externalRosWeekly) &&
    (maxDisagreement ?? 0) >= cfg.ri_external_disagreement_threshold;

  return {
    ri_vor_delta: riVorDelta,
    incoming_ri_ranks: incoming.map(rank),
    outgoing_ri_ranks: outgoing.map(rank),
    max_disagreement_pct: maxDisagreement,
    sign_conflict: signConflict,
    note: signConflict
      ? `RI VOR delta ${riVorDelta?.toFixed(1)} vs external ROS ${externalRosWeekly.toFixed(2)}/wk; worst RI/external season disagreement ${((maxDisagreement ?? 0) * 100).toFixed(0)}%`
      : "RI ordinal and external ROS agree on direction (or the disagreement is immaterial)",
  };
}

function classifyHorizon(
  immediate: number,
  ros: number,
  ri: RiOrdinalReconciliation,
  cfg: HorizonConfig,
): HorizonClassification {
  if (ri.sign_conflict) return "REVIEW_REQUIRED";
  const flat = cfg.horizon_flat_band;
  const mat = cfg.horizon_material_band;
  const iPos = immediate >= flat;
  const iNeg = immediate <= -flat;
  const rPos = ros >= flat;
  const rNeg = ros <= -flat;

  if (rPos && iPos) return "CONSISTENT_POSITIVE";
  if (rNeg && iNeg) return "CONSISTENT_NEGATIVE";
  if (iNeg && ros >= mat) return "SHORT_TERM_LOSS_LONG_TERM_GAIN";
  if (iPos && ros <= -mat) return "SHORT_TERM_GAIN_LONG_TERM_LOSS";
  // ROS dominates for a permanent trade — a flat immediate with a clear ROS sign
  if (!iPos && !iNeg && rPos) return "CONSISTENT_POSITIVE";
  if (!iPos && !iNeg && rNeg) return "CONSISTENT_NEGATIVE";
  return "MIXED";
}

function degenerate(slug: string, readiness: HorizonReadiness, reasons: string[]): TradeHorizonEvaluation {
  return {
    manager_slug: slug,
    immediate: { starter_delta: null, depth_delta: 0, positional_need_delta: 0, total_delta: 0 },
    ros: { starter_delta: 0, depth_delta: 0, availability_delta: 0, playoff_window_delta: null, bye_coverage_delta: 0, total_delta: 0, standalone_ros_swing: 0, usable_ros_value_delta_season: 0 },
    ri_ordinal: { ri_vor_delta: null, incoming_ri_ranks: [], outgoing_ri_ranks: [], max_disagreement_pct: null, sign_conflict: false, note: "unavailable" },
    permanent_trade_utility: 0,
    ros_weight: 0,
    immediate_weight: 1,
    horizon_classification: "MIXED",
    horizon_readiness: readiness,
    confidence: "VERY_LOW",
    reasons,
  };
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}
function round2(v: number): number {
  const x = Math.round(v * 100) / 100;
  return x === 0 ? 0 : x;
}
function round4(v: number): number {
  const x = Math.round(v * 10000) / 10000;
  return x === 0 ? 0 : x;
}
