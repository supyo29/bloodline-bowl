/**
 * Phase 8 §12 — candidate generation.
 *
 * Concrete `ACTION` candidates originate ONLY from certified production
 * specialists:
 *   LINEUP            → `wi.lineup` (the frozen optimiser) + `wi.start_sit`
 *   WAIVER            → `wi.waivers` (the frozen waiver engine)
 *   TRADE_EXPLORATION → the trade discovery / search-profile / partner-fit layer
 *                       (a PATH to investigate, never an executable trade)
 *
 * The Orchestrator does NOT generate lineup math, re-rank the FA pool, or invent
 * a trade package / value model. Shadow (Phase 4/5) outputs are NEVER a source
 * here — they only ever feed `conditions.ts` as `SHADOW_DIAGNOSTIC_ONLY`.
 */

import type { ManagerAnalysisSlice, ManagementAnalysisContext } from "./context";
import {
  assembleDimensions,
  buildEvidenceConfidence,
  categorical,
  classifyUrgency,
  irreversibilityOf,
  lineupCost,
  pointsEffect,
  tradeExplorationCost,
  waiverCost,
} from "./dimensions";
import type { EvidenceRef, OrchestratorAction, OrchestratorCondition } from "./schema";
import { discoverTrades } from "@/lib/trades/discovery/discover";
import { buildTradeSearchProfile } from "@/lib/trades/discovery/profiles";

const round2 = (v: number | null | undefined) => (v == null ? null : Math.round(v * 100) / 100);

function evref(specialist: EvidenceRef["specialist"], fact: string, data: EvidenceRef["data"] = {}): EvidenceRef {
  return { specialist, fact, data };
}

/** LINEUP candidates from the frozen optimiser + start/sit. */
export function lineupCandidates(mac: ManagementAnalysisContext, slice: ManagerAnalysisSlice, conditions: OrchestratorCondition[]): OrchestratorAction[] {
  const wi = slice.weekly;
  if (!wi?.lineup) return [];
  const lu = wi.lineup;
  const out: OrchestratorAction[] = [];
  const nameOf = (id: string | null): string => {
    if (!id) return "(empty)";
    return slice.teamState?.roster.players.find((p) => p.canonical_player_id === id)?.full_name ?? id;
  };

  const dq = wi.data_quality?.projections ?? "READY";
  const provisional = lu.optimality_status === "PROVISIONAL";

  // ---- structural defect: empty / illegal slot
  const structuralCond = conditions.find((c) => c.code === "LINEUP_STRUCTURAL_DEFECT" || c.code === "STARTER_ON_BYE");
  if (lu.empty_slots.length > 0 || lu.illegal_situations.length > 0 || lu.bye_problems.length > 0) {
    const changes = lu.changes_recommended
      .filter((c) => c.gain != null)
      .map((c) => ({
        slot: c.slot,
        start_player_id: c.in,
        start_player_name: nameOf(c.in),
        sit_player_id: c.out,
        sit_player_name: c.out ? nameOf(c.out) : null,
      }));
    const ec = buildEvidenceConfidence({
      projectionBasis: "WEEKLY",
      dataQuality: dq,
      specialistConfidence: provisional ? "PROVISIONAL" : "COMPLETE",
      horizon: "CURRENT_WEEK",
    });
    out.push({
      action_class: "LINEUP",
      target_condition: structuralCond?.code ?? "LINEUP_STRUCTURAL_DEFECT",
      target_problem: lu.illegal_situations[0] ?? (lu.empty_slots.length ? `Empty starter slot(s): ${lu.empty_slots.join(", ")}` : "A starter is on a bye"),
      originating_specialist: "lineup",
      remedy: { kind: "LINEUP", changes, is_reshuffle: false, ir_move: null },
      dimensions: assembleDimensions({
        expected_weekly_effect: pointsEffect(lu.projected_points_gained, "lineup.projected_points_gained", { basis: "WEEKLY", horizon: "CURRENT_WEEK" }),
        risk_reduction: categorical("POSITIVE", "MAJOR", "lineup.illegal_situations/empty_slots"),
        ...classifyUrgency({ isCurrentStructuralDefect: true }),
        evidence_confidence: ec,
        cost: lineupCost(true),
        irreversibility: irreversibilityOf("LINEUP", false),
      }),
      priority: "HIGH",
      reason_codes: ["FIX_STRUCTURAL_LINEUP_DEFECT"],
      negative_evidence: provisional ? ["SPECIALIST_CONFIDENCE_DEGRADED"] : [],
      explanation_chain: [
        evref("lineup", "current lineup has an empty/illegal slot or a starter on bye", {
          empty_slots: lu.empty_slots,
          illegal: lu.illegal_situations.slice(0, 2),
          bye_problems: lu.bye_problems.map((b) => b.slot),
        }),
      ],
      expires_when: ["player_lock_this_week", "roster_change", "new_projections"],
    });
    return out; // a structural fix supersedes marginal-swap candidates for this run
  }

  // ---- optimisation swaps
  const gain = lu.projected_points_gained;
  if (lu.changes_recommended.length > 0 && (gain ?? 0) > 0) {
    const reshuffle = lu.changes_recommended.some((c) => c.part_of_reshuffle);
    const changes = lu.changes_recommended
      .filter((c) => (c.gain ?? 0) !== 0 || c.part_of_reshuffle)
      .map((c) => ({
        slot: c.slot,
        start_player_id: c.in,
        start_player_name: nameOf(c.in),
        sit_player_id: c.out,
        sit_player_name: c.out ? nameOf(c.out) : null,
      }));
    const ec = buildEvidenceConfidence({
      projectionBasis: "WEEKLY",
      dataQuality: dq,
      specialistConfidence: provisional ? "PROVISIONAL" : "COMPLETE",
      horizon: "CURRENT_WEEK",
    });
    out.push({
      action_class: "LINEUP",
      target_condition: "LINEUP_SUBOPTIMAL",
      target_problem: reshuffle ? "Lineup can be reshuffled for more projected points" : "A bench player outprojects a starter",
      originating_specialist: "lineup",
      remedy: { kind: "LINEUP", changes, is_reshuffle: reshuffle, ir_move: null },
      dimensions: assembleDimensions({
        expected_weekly_effect: pointsEffect(gain, "lineup.projected_points_gained", { basis: "WEEKLY", horizon: "CURRENT_WEEK" }),
        risk_reduction: null,
        ...classifyUrgency({ futureWeeksAway: 0 }),
        evidence_confidence: ec,
        cost: lineupCost(true),
        irreversibility: irreversibilityOf("LINEUP", false),
      }),
      priority: (gain ?? 0) >= 3 ? "HIGH" : (gain ?? 0) >= 1.25 ? "MEDIUM" : "LOW",
      reason_codes: ["LINEUP_POINTS_GAIN"],
      negative_evidence: (gain ?? 0) < 1.25 ? ["IMPROVEMENT_BELOW_MATERIALITY"] : provisional ? ["SPECIALIST_CONFIDENCE_DEGRADED"] : [],
      explanation_chain: [
        evref("lineup", "best legal lineup beats current by projected points", {
          projected_points_gained: round2(gain),
          change_count: changes.length,
          optimality_status: lu.optimality_status,
        }),
        ...(wi.start_sit ?? []).slice(0, 2).map((ss) =>
          evref("start_sit", `${ss.recommendation} (edge ${ss.projection_edge ?? "n/a"}, ${ss.confidence})`, {
            projection_edge: ss.projection_edge,
            confidence: ss.confidence,
            recommendation: ss.recommendation,
          }),
        ),
      ],
      expires_when: ["player_lock_this_week", "roster_change", "new_projections"],
    });
  }

  // ---- IR move opportunity
  const irCond = conditions.find((c) => c.code === "IR_MOVE_OPPORTUNITY");
  if (irCond) {
    const cand = (irCond.evidence[0]?.data.candidates as string[] | undefined)?.[0] ?? null;
    const player = slice.teamState?.roster.players.find((p) => p.full_name === cand);
    if (player) {
      out.push({
        action_class: "LINEUP",
        target_condition: "IR_MOVE_OPPORTUNITY",
        target_problem: `${player.full_name} (injured) occupies an active seat with a free IR slot`,
        originating_specialist: "team_state",
        remedy: {
          kind: "LINEUP",
          changes: [],
          is_reshuffle: false,
          ir_move: { player_id: player.canonical_player_id, player_name: player.full_name, frees_slot: true },
        },
        dimensions: assembleDimensions({
          expected_weekly_effect: pointsEffect(null, "team_state.ir_capacity", { horizon: "CURRENT_WEEK" }),
          risk_reduction: categorical("POSITIVE", "MINOR", "team_state.free_ir_slot"),
          ...classifyUrgency({ futureWeeksAway: 0 }),
          evidence_confidence: buildEvidenceConfidence({ projectionBasis: "NONE", dataQuality: "READY", specialistConfidence: "HIGH", horizon: "CURRENT_WEEK" }),
          cost: { band: "ZERO", consumes: null, reasons: ["moving an injured player to a free IR slot costs nothing and frees an active seat"] },
          irreversibility: irreversibilityOf("LINEUP", false),
        }),
        priority: "LOW",
        reason_codes: ["IR_MOVE_FREES_ACTIVE_SLOT"],
        negative_evidence: [],
        explanation_chain: [evref("team_state", "injured active player + free IR capacity", { player: player.full_name, injury_status: player.injury_status ?? "" })],
        expires_when: ["injury_status_change", "roster_change"],
      });
    }
  }

  return out;
}

/** WAIVER candidates straight from the frozen waiver engine's recommendations. */
export function waiverCandidates(mac: ManagementAnalysisContext, slice: ManagerAnalysisSlice, conditions: OrchestratorCondition[]): OrchestratorAction[] {
  const wi = slice.weekly;
  if (!wi?.waivers) return [];
  const waiverType = (mac.snapshot.league.waiver_settings?.type ?? "unknown") as "faab" | "rolling" | "reverse_standings" | "unknown";
  const waiverDayKnown = Boolean(mac.snapshot.league.waiver_settings?.waiver_day);
  const openSlot = wi.waivers.roster_has_open_spot;
  const out: OrchestratorAction[] = [];

  for (const rec of wi.waivers.recommendations) {
    if (rec.priority === "DO_NOT_ADD") continue;
    // Which condition does this address? Prefer a matching depth/position condition.
    const posCond =
      conditions.find((c) => c.code === `${rec.position}_DEPTH_VULNERABILITY`) ??
      conditions.find((c) => c.code.startsWith("DEPENDENCY_") && c.code.includes(rec.position)) ??
      conditions.find((c) => c.code === "WAIVER_UPGRADE_AVAILABLE");
    const effect = rec.starter_impact_status === "RESOLVED" ? rec.starter_impact : rec.net_roster_gain;
    const ec = buildEvidenceConfidence({
      projectionBasis: rec.rest_of_season_role && rec.starter_impact_status !== "RESOLVED" ? "ROS_PROJECTION" : "WEEKLY",
      dataQuality: wi.data_quality?.projections ?? "READY",
      specialistConfidence: `${rec.confidence}${rec.starter_impact_status === "UNRESOLVED" ? " UNRESOLVED" : ""}`,
      horizon: "CURRENT_WEEK",
    });
    out.push({
      action_class: "WAIVER",
      target_condition: posCond?.code ?? "WAIVER_UPGRADE_AVAILABLE",
      target_problem: posCond ? posCond.title : `Roster upgrade at ${rec.position}`,
      originating_specialist: "waiver",
      remedy: {
        kind: "WAIVER",
        add_player_id: rec.add_player_id,
        add_player_name: rec.add_name,
        add_position: rec.position,
        drop_player_id: rec.drop_player_id,
        drop_player_name: rec.drop_name,
        immediate_role: rec.immediate_role,
        waiver_engine_priority: rec.priority as "HIGH" | "MEDIUM" | "LOW",
      },
      dimensions: assembleDimensions({
        expected_weekly_effect: pointsEffect(effect, rec.starter_impact_status === "RESOLVED" ? "waiver.starter_impact" : "waiver.net_roster_gain", {
          basis: ec.projection_basis === "NONE" ? "NONE" : ec.projection_basis,
          horizon: "CURRENT_WEEK",
        }),
        risk_reduction:
          rec.bye_coverage_impact > 0 || rec.injury_hedge_impact > 0
            ? categorical("POSITIVE", rec.bye_coverage_impact + rec.injury_hedge_impact > 3 ? "MATERIAL" : "MINOR", "waiver.bye_coverage_impact/injury_hedge_impact")
            : null,
        ...classifyUrgency({ needsWaiverClaim: true, waiverDayKnown }),
        evidence_confidence: ec,
        cost: waiverCost({ requiresDrop: Boolean(rec.drop_player_id), dropName: rec.drop_name, waiverType, openSlot }),
        irreversibility: irreversibilityOf("WAIVER", Boolean(rec.drop_player_id)),
      }),
      priority: rec.priority === "HIGH" ? "HIGH" : rec.priority === "MEDIUM" ? "MEDIUM" : "LOW",
      reason_codes: ["WAIVER_NET_IMPROVEMENT"],
      negative_evidence: rec.drop_player_id ? ["DROP_COST_EXCEEDS_BENEFIT"].filter(() => rec.net_roster_gain < 1) as never[] : [],
      explanation_chain: [
        evref("waiver", "waiver engine recommendation (add/drop pair optimised, DO_NOT_ADD gate cleared)", {
          add: rec.add_name,
          drop: rec.drop_name,
          priority: rec.priority,
          net_roster_gain: round2(rec.net_roster_gain),
          starter_impact: round2(rec.starter_impact),
          immediate_role: rec.immediate_role,
        }),
        ...(posCond ? posCond.evidence.slice(0, 3) : []),
      ],
      expires_when: ["candidate_rostered_elsewhere", "waiver_clears", "roster_change", "new_projections"],
    });
  }
  return out;
}

/**
 * TRADE_EXPLORATION candidates. By default a POINTER (search-profile need + a
 * suggested discovery mode). With `includeTradeSearch`, runs the real
 * `discoverTrades` for the top material need and attaches the best candidate —
 * still labelled "explore", never "execute".
 */
export async function tradeExplorationCandidates(
  mac: ManagementAnalysisContext,
  slice: ManagerAnalysisSlice,
  conditions: OrchestratorCondition[],
): Promise<OrchestratorAction[]> {
  if (!mac.tradeCtx) return [];
  const out: OrchestratorAction[] = [];

  // A material depth condition that lineup/waiver did NOT already resolve.
  const depthConds = conditions.filter(
    (c) =>
      (c.code.endsWith("_DEPTH_VULNERABILITY") || c.code === "ROSTER_FRAGILITY" || c.code.startsWith("DEPENDENCY_")) &&
      c.materiality === "MATERIAL",
  );
  if (depthConds.length === 0) return [];

  let profile;
  try {
    profile = buildTradeSearchProfile(slice.canonical_manager_id, slice.manager_slug, mac.tradeCtx);
  } catch {
    return [];
  }
  const topNeed = profile.needs.find((n) => n.severity === "CRITICAL" || n.severity === "HIGH") ?? profile.needs[0] ?? null;
  const targetPosition = topNeed?.position ?? depthConds[0]?.code.split("_")[0] ?? null;
  const targetCond = depthConds[0]!;

  const strat = slice.strategy;
  const seasonUrgency = strat?.urgency.score ?? null;
  const ec = buildEvidenceConfidence({
    projectionBasis: "ROS_PROJECTION",
    dataQuality: "READY",
    specialistConfidence: "MEDIUM",
    horizon: "REST_OF_REGULAR_SEASON",
  });

  const base: Omit<OrchestratorAction, "remedy"> = {
    action_class: "TRADE_EXPLORATION",
    target_condition: targetCond.code,
    target_problem: `${targetPosition ?? "roster"} depth vulnerability with no material lineup/waiver remedy`,
    originating_specialist: "strategy",
    dimensions: assembleDimensions({
      expected_weekly_effect: pointsEffect(null, "trade_search_profile (path only — no concrete package)", { basis: "ROS_PROJECTION", horizon: "REST_OF_REGULAR_SEASON" }),
      risk_reduction: categorical("POSITIVE", "MATERIAL", "roster_health depth vulnerability + trade_search_profile need"),
      ...classifyUrgency({ futureWeeksAway: null, seasonUrgency }),
      evidence_confidence: ec,
      cost: tradeExplorationCost(),
      irreversibility: irreversibilityOf("TRADE_EXPLORATION", false),
    }),
    priority: (seasonUrgency ?? 0) >= 0.5 ? "MEDIUM" : "LOW",
    reason_codes: ["MATERIAL_DEPTH_NEED_NO_CHEAPER_REMEDY"],
    negative_evidence: ["NO_MATERIAL_WAIVER_REMEDY"],
    explanation_chain: [
      ...targetCond.evidence.slice(0, 3),
      evref("strategy", `trade search profile: need at ${targetPosition ?? "?"} (${topNeed?.severity ?? "n/a"}); archetype ${strat?.archetype ?? "UNKNOWN"}, season urgency ${seasonUrgency ?? "n/a"}`, {
        need_position: targetPosition,
        need_severity: topNeed?.severity ?? null,
        archetype: strat?.archetype ?? "UNKNOWN",
        season_urgency: seasonUrgency,
        surpluses: profile.surpluses.map((s) => s.position),
      }),
    ],
    expires_when: ["partner_roster_change", "snapshot_change", "season_stage_change", "condition_resolved"],
  };

  if (mac.options.includeTradeSearch) {
    try {
      const disc = await discoverTrades({
        league: mac.league.league_slug,
        manager: slice.manager_slug,
        mode: targetPosition ? "POSITIONAL_NEED" : "BEST_AVAILABLE",
        target_position: targetPosition ?? undefined,
        max_results: 3,
        include_strategic: true,
      });
      const best = disc.results[0] ?? null;
      if (best) {
        const partner = best.participants.find((p) => p.manager_slug !== slice.manager_slug) ?? null;
        const myOut = best.transfers.filter((tr) => tr.from_manager_id === slice.canonical_manager_id).map((tr) => tr.canonical_player_id);
        const myIn = best.transfers.filter((tr) => tr.to_manager_id === slice.canonical_manager_id).map((tr) => tr.canonical_player_id);
        out.push({
          ...base,
          remedy: {
            kind: "TRADE_EXPLORATION",
            pointer_only: false,
            target_problem: base.target_problem,
            suggested_search_mode: targetPosition ? "POSITIONAL_NEED" : "BEST_AVAILABLE",
            target_position: targetPosition,
            discovered_partner_id: partner?.manager_id ?? null,
            discovered_partner_slug: partner?.manager_slug ?? null,
            discovered_assets_in: myIn,
            discovered_assets_out: myOut,
            partner_fit: (best.search_metadata.partner_fit != null
              ? best.search_metadata.partner_fit >= 0.66
                ? "HIGH"
                : best.search_metadata.partner_fit >= 0.4
                  ? "MODERATE"
                  : "LOW"
              : null),
            trade_viability: best.trade_viability,
            note: "Discovered by trade discovery and validated by the canonical evaluator. This is a path to explore — NOT a claim the partner will accept.",
          },
          explanation_chain: [
            ...base.explanation_chain,
            evref("strategy", `trade discovery: ${best.trade_viability} viability, my gain ${round2(best.my_gain)}, min partner gain ${round2(best.minimum_partner_gain)}`, {
              trade_viability: best.trade_viability,
              my_gain: round2(best.my_gain),
              minimum_partner_gain: round2(best.minimum_partner_gain),
              partner: partner?.manager_slug ?? null,
            }),
          ],
          negative_evidence: best.trade_viability === "NON_VIABLE" ? ["NO_VIABLE_TRADE_PATH"] : ["NO_MATERIAL_WAIVER_REMEDY"],
        });
        return out;
      }
      // discovery ran but found nothing viable
      out.push({
        ...base,
        remedy: {
          kind: "TRADE_EXPLORATION",
          pointer_only: false,
          target_problem: base.target_problem,
          suggested_search_mode: targetPosition ? "POSITIONAL_NEED" : "BEST_AVAILABLE",
          target_position: targetPosition,
          discovered_partner_id: null,
          discovered_partner_slug: null,
          discovered_assets_in: [],
          discovered_assets_out: [],
          partner_fit: null,
          trade_viability: "NON_VIABLE",
          note: "Trade discovery ran and found no rational path for this need right now.",
        },
        negative_evidence: ["NO_VIABLE_TRADE_PATH"],
      });
      return out;
    } catch {
      /* fall through to the pointer form */
    }
  }

  out.push({
    ...base,
    priority: "LOW",
    remedy: {
      kind: "TRADE_EXPLORATION",
      pointer_only: true,
      target_problem: base.target_problem,
      suggested_search_mode: targetPosition ? "POSITIONAL_NEED" : "BEST_AVAILABLE",
      target_position: targetPosition,
      discovered_partner_id: null,
      discovered_partner_slug: null,
      discovered_assets_in: [],
      discovered_assets_out: [],
      partner_fit: null,
      trade_viability: null,
      note: `Existing trade-search evidence indicates ${targetPosition ?? "a roster"} is a worthwhile trade path to investigate. Run trade discovery (mode ${targetPosition ? "POSITIONAL_NEED" : "BEST_AVAILABLE"}) with ?include_trade_search=1 for concrete packages.`,
    },
  });
  return out;
}
