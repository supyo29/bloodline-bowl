/**
 * Phase 8 §6 / §11 / §32 — derive CONDITIONS (specialist-detected facts) for one
 * manager, then aggregate compatible observations into a single condition
 * without losing source evidence.
 *
 * A condition is NEVER a remedy. Roster Health / Schedule Planning
 * (`SHARED_CONTEXT`) contribute condition + materiality + urgency + horizon;
 * a concrete remedy is generated separately (`candidates.ts`) and only from a
 * production specialist. Shadow (`SHADOW_ONLY`) outputs may produce a
 * `SHADOW_DIAGNOSTIC_ONLY` condition — never anything that a remedy attaches to.
 */

import type { ManagerAnalysisSlice, ManagementAnalysisContext } from "./context";
import { URGENCY_RANK, classifyUrgency } from "./dimensions";
import type {
  ConditionMateriality,
  EvidenceRef,
  OrchestratorCondition,
  OrchestratorHorizon,
} from "./schema";

const round2 = (v: number | null | undefined) => (v == null ? null : Math.round(v * 100) / 100);

function ev(specialist: EvidenceRef["specialist"], fact: string, data: EvidenceRef["data"] = {}): EvidenceRef {
  return { specialist, fact, data };
}

/**
 * Raw (pre-aggregation) conditions. `disposition` is a provisional guess here;
 * `policy.ts` finalises it after candidate generation + gating.
 */
export function deriveConditions(mac: ManagementAnalysisContext, slice: ManagerAnalysisSlice): OrchestratorCondition[] {
  const out: OrchestratorCondition[] = [];
  const week = mac.week;
  const ts = slice.teamState;
  const rh = slice.rosterHealth;
  const sp = slice.schedulePlanning;
  const wi = slice.weekly;
  const waiverDayKnown = Boolean(mac.snapshot.league.waiver_settings?.waiver_day);

  /* ---------------------------------------------------------------- LINEUP */
  if (wi?.lineup) {
    const lu = wi.lineup;
    const hasRealChange = lu.changes_recommended.length > 0 && (lu.projected_points_gained ?? 0) > 0;
    if (lu.empty_slots.length > 0 || lu.illegal_situations.length > 0) {
      out.push({
        code: "LINEUP_STRUCTURAL_DEFECT",
        title: lu.illegal_situations.length ? "Current lineup is illegal" : "Empty starter slot(s)",
        sources: ["lineup"],
        evidence: [
          ev("lineup", "empty_slots / illegal_situations", {
            empty_slots: lu.empty_slots,
            illegal: lu.illegal_situations.slice(0, 3),
          }),
        ],
        materiality: "MATERIAL",
        ...classifyUrgency({ isCurrentStructuralDefect: true }),
        horizon: "CURRENT_WEEK",
        has_available_remedy: true,
        disposition: "ACTIONED",
        suppression_reasons: [],
      } as OrchestratorCondition);
    } else if (hasRealChange) {
      const gain = round2(lu.projected_points_gained);
      out.push({
        code: "LINEUP_SUBOPTIMAL",
        title: "Best legal lineup is not the current lineup",
        sources: ["lineup"],
        evidence: [
          ev("lineup", "projected_points_gained + changes_recommended", {
            projected_points_gained: gain,
            change_count: lu.changes_recommended.length,
            optimality_status: lu.optimality_status,
          }),
        ],
        materiality: (gain ?? 0) >= 1.25 ? "MATERIAL" : "MINOR",
        ...classifyUrgency({ futureWeeksAway: 0 }),
        horizon: "CURRENT_WEEK",
        has_available_remedy: true,
        disposition: (gain ?? 0) >= 1.25 ? "ACTIONED" : "NOT_MATERIAL",
        suppression_reasons: (gain ?? 0) >= 1.25 ? [] : ["IMPROVEMENT_BELOW_MATERIALITY"],
      });
    }
    for (const bp of wi.lineup.bye_problems) {
      out.push({
        code: "STARTER_ON_BYE",
        title: "A currently-starting player is on a bye",
        sources: ["lineup", "team_state"],
        evidence: [ev("lineup", "bye_problems", { player_id: bp.canonical_player_id, slot: bp.slot })],
        materiality: "MATERIAL",
        ...classifyUrgency({ isCurrentStructuralDefect: true }),
        horizon: "CURRENT_WEEK",
        has_available_remedy: true,
        disposition: "ACTIONED",
        suppression_reasons: [],
      } as OrchestratorCondition);
    }
    // IR-move opportunity: an injured player occupying an active seat with a free IR slot
    if (ts) {
      const irCap = mac.snapshot.league.roster_settings?.ir_slots ?? 0;
      const freeIr = irCap - ts.roster.ir.length;
      const injuredActive = ts.roster.players.filter(
        (p) => p.roster_slot !== "ir" && p.roster_slot !== "taxi" && (p.injury_status === "IR" || p.injury_status === "Out" || p.injury_status === "Doubtful"),
      );
      if (freeIr > 0 && injuredActive.length > 0) {
        out.push({
          code: "IR_MOVE_OPPORTUNITY",
          title: "An injured player can be moved to a free IR slot",
          sources: ["team_state"],
          evidence: [
            ev("team_state", "injured active players + free IR capacity", {
              free_ir_slots: freeIr,
              candidates: injuredActive.map((p) => p.full_name),
            }),
          ],
          materiality: "MINOR",
          ...classifyUrgency({ futureWeeksAway: 0 }),
          horizon: "CURRENT_WEEK",
          has_available_remedy: true,
          disposition: "ACTIONED",
          suppression_reasons: [],
        });
      }
    }
  }

  /* ---------------------------------------------------- TEAM-STATE structural */
  for (const flag of ts?.structural_flags ?? []) {
    if (flag.code === "CURRENT_WEEK_BYE_GAP" || flag.code === "UNFILLED_STARTER_SLOT" || flag.code === "ILLEGAL_CURRENT_LINEUP") {
      // already covered by the lineup conditions above — skip the duplicate.
      continue;
    }
    if (flag.code === "NO_ACTIVE_BACKUP" || flag.code === "SINGLE_POINT_OF_FAILURE") {
      // Phase 6 Roster Health OWNS depth / dependency evaluation (it already
      // consumes these raw Team-State facts). The Orchestrator reads the
      // evaluated `player_dependency` / `fragility` conditions below, not the
      // raw structural flag, so it does not double-count (§11, §16, §32).
      continue;
    }
    const mat: ConditionMateriality =
      flag.severity === "critical" ? "MATERIAL" : flag.severity === "warning" ? "MINOR" : "INFORMATIONAL";
    out.push({
      code: `TEAM_STATE_${flag.code}`,
      title: flag.message,
      sources: ["team_state"],
      evidence: [ev("team_state", flag.message, { positions: flag.positions, player_ids: flag.player_ids, ...toEvData(flag.facts) })],
      materiality: mat,
      ...classifyUrgency({ futureWeeksAway: null, informationalOnly: flag.severity === "info" }),
      horizon: "CURRENT_WEEK",
      has_available_remedy: false,
      disposition: flag.severity === "info" ? "NOT_MATERIAL" : "WATCH",
      suppression_reasons: [],
    });
  }

  /* -------------------------------------------------------- ROSTER HEALTH */
  if (rh) {
    const wk = rh.weekly;
    if (wk.fragility.profile !== "RESILIENT") {
      const spofNames = wk.fragility.single_points_of_failure
        .map((id) => ts?.roster.players.find((p) => p.canonical_player_id === id)?.full_name ?? id);
      out.push({
        code: "ROSTER_FRAGILITY",
        title: `Roster fragility: ${wk.fragility.profile}`,
        sources: ["roster_health"],
        evidence: [
          ev("roster_health", "weekly fragility profile + worst dependency + SPOFs", {
            profile: wk.fragility.profile,
            worst_starter_dependency: round2(wk.fragility.worst_starter_dependency),
            expected_one_loss_damage: round2(wk.fragility.expected_one_loss_damage),
            single_points_of_failure: spofNames,
          }),
        ],
        materiality: wk.fragility.single_points_of_failure.length > 0 || (wk.fragility.worst_starter_dependency ?? 0) > 8 ? "MATERIAL" : "MINOR",
        ...classifyUrgency({ futureWeeksAway: null }),
        horizon: "REST_OF_REGULAR_SEASON",
        has_available_remedy: false,
        disposition: "WATCH",
        suppression_reasons: [],
      });
    }
    // top single-player dependency worth naming
    const topDep = [...wk.player_dependency].filter((d) => d.starting_slot_label != null).sort((a, b) => (b.raw_point_loss ?? 0) - (a.raw_point_loss ?? 0))[0];
    if (topDep && topDep.single_point_of_failure) {
      out.push({
        code: `DEPENDENCY_${topDep.position}`,
        title: `${topDep.full_name ?? topDep.position} is a single point of failure`,
        sources: ["roster_health"],
        evidence: [
          ev("roster_health", "player_dependency: single_point_of_failure", {
            position: topDep.position,
            player: topDep.full_name,
            raw_point_loss: round2(topDep.raw_point_loss),
            pct_lineup_loss: round2(topDep.pct_lineup_loss),
            league_percentile: topDep.league_percentile,
          }),
        ],
        materiality: (topDep.raw_point_loss ?? 0) > 6 ? "MATERIAL" : "MINOR",
        ...classifyUrgency({ futureWeeksAway: null }),
        horizon: "REST_OF_REGULAR_SEASON",
        has_available_remedy: false,
        disposition: "WATCH",
        suppression_reasons: [],
      });
    }
    if (rh.degradation.overall !== "OK") {
      out.push({
        code: "ROSTER_HEALTH_DEGRADED",
        title: "Roster Health evidence is degraded",
        sources: ["roster_health"],
        evidence: [ev("roster_health", "degradation", { overall: rh.degradation.overall, reasons: rh.degradation.reasons })],
        materiality: "INFORMATIONAL",
        urgency: "INFORMATIONAL",
        timing_degradation: [],
        horizon: "REST_OF_REGULAR_SEASON",
        has_available_remedy: false,
        disposition: "DEGRADED_EVIDENCE",
        suppression_reasons: ["SPECIALIST_CONFIDENCE_DEGRADED"],
      });
    }
  }

  /* ---------------------------------------------------- SCHEDULE PLANNING */
  if (sp) {
    for (const wp of sp.week_timeline) {
      if (wp.is_current) continue;
      if (wp.uncovered_slot_labels.length === 0) continue;
      const away = wp.week - week;
      const loss = round2(wp.estimated_bye_loss);
      const material =
        wp.structure_confidence === "HIGH" &&
        (wp.estimated_bye_loss == null || wp.estimated_bye_loss >= 2) &&
        away <= 4;
      out.push({
        code: `WEEK_${wp.week}_UNCOVERED_SLOT`,
        title: `Week ${wp.week}: ${wp.uncovered_slot_labels.join(", ")} uncovered (bye)`,
        sources: ["schedule_planning"],
        evidence: [
          ev("schedule_planning", "WeekPlan: uncovered slots + estimated bye loss", {
            week: wp.week,
            uncovered_slot_labels: wp.uncovered_slot_labels,
            starters_on_bye: wp.starters_on_bye.length,
            structure_confidence: wp.structure_confidence,
            estimated_bye_loss: loss,
            value_confidence: wp.value_confidence,
            weeks_away: away,
            is_playoff_week: wp.is_playoff_week,
          }),
        ],
        materiality: material ? "MATERIAL" : away <= 6 ? "MINOR" : "INFORMATIONAL",
        ...classifyUrgency({ futureWeeksAway: away, isPlayoffWindow: wp.is_playoff_week }),
        horizon: away <= 3 ? "NEXT_2_3_WEEKS" : wp.is_playoff_week ? "FANTASY_PLAYOFFS" : "REST_OF_REGULAR_SEASON",
        has_available_remedy: false,
        disposition: material ? "WATCH" : away > 6 ? "NOT_URGENT" : "WATCH",
        suppression_reasons: material ? [] : away > 6 ? ["FUTURE_CONCERN_TOO_DISTANT"] : [],
      });
    }
    if (sp.degradation.value === "INSUFFICIENT" || sp.degradation.structure === "INSUFFICIENT") {
      out.push({
        code: "SCHEDULE_PLANNING_DEGRADED",
        title: "Schedule Planning evidence is degraded",
        sources: ["schedule_planning"],
        evidence: [ev("schedule_planning", "degradation", { structure: sp.degradation.structure, value: sp.degradation.value, reasons: sp.degradation.reasons })],
        materiality: "INFORMATIONAL",
        urgency: "INFORMATIONAL",
        timing_degradation: [],
        horizon: "REST_OF_REGULAR_SEASON",
        has_available_remedy: false,
        disposition: "DEGRADED_EVIDENCE",
        suppression_reasons: ["SPECIALIST_CONFIDENCE_DEGRADED"],
      });
    }
  }

  /* ----------------------------------------------------------- WAIVER */
  if (wi?.waivers) {
    const top = wi.waivers.recommendations.find((r) => r.priority === "HIGH" || r.priority === "MEDIUM");
    if (top) {
      out.push({
        code: "WAIVER_UPGRADE_AVAILABLE",
        title: `Waiver upgrade available: ${top.add_name}`,
        sources: ["waiver"],
        evidence: [
          ev("waiver", "waiver recommendation", {
            add_name: top.add_name,
            position: top.position,
            priority: top.priority,
            net_roster_gain: round2(top.net_roster_gain),
            starter_impact: round2(top.starter_impact),
            immediate_role: top.immediate_role,
          }),
        ],
        materiality: top.priority === "HIGH" ? "MATERIAL" : "MINOR",
        ...classifyUrgency({ needsWaiverClaim: true, waiverDayKnown }),
        horizon: "CURRENT_WEEK",
        has_available_remedy: true,
        disposition: "ACTIONED",
        suppression_reasons: [],
      } as OrchestratorCondition);
    }
  }

  /* ----------------------------------------------- SHADOW DISAGREEMENTS (§11) */
  if (wi?.start_sit_shadow) {
    const disagreements = extractShadowDisagreements(wi.start_sit_shadow);
    if (disagreements > 0) {
      out.push({
        code: "SHADOW_STARTSIT_DISAGREEMENT",
        title: "The shadow Start/Sit FI model disagrees with the production lineup",
        sources: ["start_sit_shadow"],
        evidence: [
          ev("start_sit_shadow", "SHADOW_ONLY — not production-certified; diagnostic only", {
            disagreement_count: disagreements,
            deployment: "SHADOW_ONLY",
          }),
        ],
        materiality: "INFORMATIONAL",
        urgency: "INFORMATIONAL",
        timing_degradation: [],
        horizon: "CURRENT_WEEK",
        has_available_remedy: false,
        disposition: "SHADOW_DIAGNOSTIC_ONLY",
        suppression_reasons: ["SHADOW_ONLY_EVIDENCE"],
      });
    }
  }
  if (wi?.matchup_intelligence && wi.matchup) {
    const prodWp = wi.matchup.win_probability;
    const shadowWp = (wi.matchup_intelligence as { win_probability?: number | null }).win_probability ?? null;
    if (prodWp != null && shadowWp != null && Math.abs(prodWp - shadowWp) >= 0.03) {
      out.push({
        code: "SHADOW_MATCHUP_WP_DISAGREEMENT",
        title: "Shadow Matchup Intelligence win probability differs from production",
        sources: ["matchup_shadow"],
        evidence: [
          ev("matchup_shadow", "SHADOW_ONLY — production matchup.win_probability is unchanged", {
            production_win_probability: round2(prodWp),
            shadow_win_probability: round2(shadowWp),
            deployment: "SHADOW_ONLY",
          }),
        ],
        materiality: "INFORMATIONAL",
        urgency: "INFORMATIONAL",
        timing_degradation: [],
        horizon: "CURRENT_WEEK",
        has_available_remedy: false,
        disposition: "SHADOW_DIAGNOSTIC_ONLY",
        suppression_reasons: ["SHADOW_ONLY_EVIDENCE"],
      });
    }
  }

  return out;
}

/**
 * §32 — merge compatible observations of the SAME underlying vulnerability into
 * one condition, preserving every source evidence ref. Aggregation is semantic
 * grouping; it never rescores.
 */
const CORE_POSITIONS = new Set(["QB", "RB", "WR", "TE"]);

export function aggregateConditions(conditions: OrchestratorCondition[]): OrchestratorCondition[] {
  const byPosition = new Map<string, OrchestratorCondition[]>();
  const passthrough: OrchestratorCondition[] = [];
  const seenPassthrough = new Set<string>();

  for (const c of conditions) {
    const posMatch =
      /^DEPENDENCY_([A-Z/]+)$/.exec(c.code)?.[1] ??
      (c.code === "ROSTER_FRAGILITY"
        ? "ROSTER"
        : /^TEAM_STATE_(NO_ACTIVE_BACKUP|SINGLE_POINT_OF_FAILURE)$/.test(c.code)
          ? (c.evidence[0]?.data.positions as string[] | undefined)?.[0] ?? "ROSTER"
          : null);
    if (posMatch && CORE_POSITIONS.has(posMatch)) {
      let group = byPosition.get(posMatch);
      if (!group) {
        group = [];
        byPosition.set(posMatch, group);
      }
      group.push(c);
    } else if (posMatch && posMatch !== "ROSTER") {
      // K / DEF backup gaps: Phase 6 excludes them from core fragility (§16) —
      // downgrade to INFORMATIONAL and dedupe.
      const key = `KDST_${posMatch}`;
      if (!seenPassthrough.has(key)) {
        seenPassthrough.add(key);
        passthrough.push({ ...c, materiality: "INFORMATIONAL", disposition: "NOT_MATERIAL", suppression_reasons: [...new Set([...c.suppression_reasons, "CONDITION_NOT_URGENT"])] });
      }
    } else {
      const key = `${c.code}|${c.title}`;
      if (seenPassthrough.has(key)) continue;
      seenPassthrough.add(key);
      passthrough.push(c);
    }
  }

  const merged: OrchestratorCondition[] = [];
  for (const [pos, group] of byPosition) {
    if (group.length === 1) {
      const g = group[0]!;
      merged.push({ ...g, code: `${pos}_DEPTH_VULNERABILITY`, title: g.title || `${pos} depth vulnerability` });
      continue;
    }
    const mat: ConditionMateriality = group.some((g) => g.materiality === "MATERIAL")
      ? "MATERIAL"
      : group.some((g) => g.materiality === "MINOR")
        ? "MINOR"
        : "INFORMATIONAL";
    const urgency = [...group].sort((a, b) => URGENCY_RANK[a.urgency] - URGENCY_RANK[b.urgency])[0]!.urgency;
    const horizon: OrchestratorHorizon = group.some((g) => g.horizon === "CURRENT_WEEK")
      ? "CURRENT_WEEK"
      : group.some((g) => g.horizon === "NEXT_2_3_WEEKS")
        ? "NEXT_2_3_WEEKS"
        : "REST_OF_REGULAR_SEASON";
    merged.push({
      code: `${pos}_DEPTH_VULNERABILITY`,
      title: `${pos} depth vulnerability`,
      sources: [...new Set(group.flatMap((g) => g.sources))],
      evidence: group.flatMap((g) => g.evidence),
      materiality: mat,
      urgency,
      timing_degradation: [...new Set(group.flatMap((g) => g.timing_degradation))],
      horizon,
      has_available_remedy: false,
      disposition: "WATCH",
      suppression_reasons: [...new Set(group.flatMap((g) => g.suppression_reasons))],
    });
  }
  return [...passthrough, ...merged];
}

function toEvData(facts: Record<string, unknown>): EvidenceRef["data"] {
  const out: EvidenceRef["data"] = {};
  for (const [k, v] of Object.entries(facts)) {
    if (typeof v === "number" || typeof v === "string" || typeof v === "boolean") out[k] = v;
    else if (Array.isArray(v) && v.every((x) => typeof x === "string")) out[k] = v as string[];
  }
  return out;
}

function extractShadowDisagreements(shadow: unknown): number {
  const s = shadow as { reversals?: unknown[]; disagreements?: unknown[]; summary?: { reversal_count?: number; disagreement_count?: number } };
  if (Array.isArray(s?.reversals)) return s.reversals.length;
  if (Array.isArray(s?.disagreements)) return s.disagreements.length;
  return s?.summary?.reversal_count ?? s?.summary?.disagreement_count ?? 0;
}
