/**
 * Phase 8 §16 / §24 / §27 — the decision policy.
 *
 *   hard gates  →  lexicographic priority  →  pairwise-dominance suppression  →  verdict
 *
 * No learned model, no single opaque weighted sum. Every ranked candidate keeps
 * its component dimensions. Cross-domain raw specialist scores are never
 * compared — only the normalised `DecisionDimensions` from `dimensions.ts`.
 */

import type { ManagerAnalysisSlice, ManagementAnalysisContext } from "./context";
import { applyHardGates } from "./gates";
import { COST_RANK, CONF_RANK, MAGNITUDE_RANK, URGENCY_RANK } from "./dimensions";
import type {
  NegativeEvidenceCode,
  OrchestratorAction,
  OrchestratorCondition,
  OrchestratorVerdict,
} from "./schema";

const MAX_SECONDARY = 3;

interface Scored {
  action: OrchestratorAction;
  key: number[];
}

/** magnitude of an action's expected effect, comparable within one action only. */
function effectMagnitude(a: OrchestratorAction): number {
  const e = a.dimensions.expected_weekly_effect;
  if (e && e.value != null) return e.value;
  const rr = a.dimensions.risk_reduction;
  if (rr && "magnitude_class" in rr) return MAGNITUDE_RANK[rr.magnitude_class] * 1.5; // categorical → rough points-equivalent band
  if (rr && "value" in rr && rr.value != null) return rr.value;
  return 0;
}

/**
 * Lexicographic sort key (all ascending = better first):
 *   1. urgency rank              (NOW < THIS_WEEK < …)
 *   2. materiality               (−effectMagnitude, so bigger first)
 *   3. confidence                (−CONF_RANK, so HIGH first)
 *   4. cost                      (COST_RANK, cheaper first)
 *   5. irreversibility tiebreak  (REVERSIBLE first)
 *   6. class order               (LINEUP < WAIVER < TRADE_EXPLORATION)
 */
function sortKey(a: OrchestratorAction): number[] {
  const irr = { REVERSIBLE: 0, PARTLY_REVERSIBLE: 1, IRREVERSIBLE: 2 }[a.dimensions.irreversibility];
  const cls = { LINEUP: 0, WAIVER: 1, TRADE_EXPLORATION: 2 }[a.action_class];
  return [
    URGENCY_RANK[a.dimensions.urgency],
    -effectMagnitude(a),
    -CONF_RANK[a.dimensions.confidence],
    COST_RANK[a.dimensions.cost.band],
    irr,
    cls,
  ];
}

function cmpKey(x: number[], y: number[]): number {
  for (let i = 0; i < x.length; i += 1) {
    if (x[i]! !== y[i]!) return x[i]! - y[i]!;
  }
  return 0;
}

/**
 * §24 — A dominates B (both addressing the SAME condition) iff A is at least as
 * good on effect AND confidence AND cost, with no downside B lacks.
 */
function dominates(a: OrchestratorAction, b: OrchestratorAction): boolean {
  if (a.target_condition !== b.target_condition) return false;
  const effOk = effectMagnitude(a) + 1e-9 >= effectMagnitude(b);
  const confOk = CONF_RANK[a.dimensions.confidence] >= CONF_RANK[b.dimensions.confidence];
  const costOk = COST_RANK[a.dimensions.cost.band] <= COST_RANK[b.dimensions.cost.band];
  const irrOk =
    ({ REVERSIBLE: 0, PARTLY_REVERSIBLE: 1, IRREVERSIBLE: 2 }[a.dimensions.irreversibility]) <=
    ({ REVERSIBLE: 0, PARTLY_REVERSIBLE: 1, IRREVERSIBLE: 2 }[b.dimensions.irreversibility]);
  return effOk && confOk && costOk && irrOk && cmpKey(sortKey(a), sortKey(b)) <= 0;
}

export interface PolicyOutcome {
  verdict: OrchestratorVerdict;
  primary_action: OrchestratorAction | null;
  secondary_actions: OrchestratorAction[];
  suppressed_actions: Array<{ action: OrchestratorAction; reasons: NegativeEvidenceCode[] }>;
  conditions: OrchestratorCondition[];
  watch_items: OrchestratorCondition[];
  hold_rationale: string[];
  confidence: "HIGH" | "MEDIUM" | "LOW";
}

export function runPolicy(
  mac: ManagementAnalysisContext,
  slice: ManagerAnalysisSlice,
  conditionsIn: OrchestratorCondition[],
  candidates: OrchestratorAction[],
): PolicyOutcome {
  const conditions = conditionsIn.map((c) => ({ ...c, suppression_reasons: [...c.suppression_reasons] }));
  const suppressed: PolicyOutcome["suppressed_actions"] = [];

  // ---- 0. TRADE_EXPLORATION pointers (§27) — a bare pointer is NOT a concrete
  //         remedy, so it can never be an ACTION. It routes its target condition
  //         to WATCH with a "trade path worth investigating" note. Concrete
  //         discovered packages continue into the ACTION race below, but only
  //         when the condition is MATERIAL and reasonably timely.
  const raceable: OrchestratorAction[] = [];
  const tradePointerNotes: OrchestratorAction[] = [];
  for (const cand of candidates) {
    if (cand.action_class === "TRADE_EXPLORATION" && cand.remedy.kind === "TRADE_EXPLORATION") {
      const cond = conditions.find((c) => c.code === cand.target_condition);
      const concrete = !cand.remedy.pointer_only && (cand.remedy.trade_viability === "HIGH" || cand.remedy.trade_viability === "MODERATE");
      const timely = Boolean(
        cond && cond.materiality === "MATERIAL" && URGENCY_RANK[cond.urgency] <= URGENCY_RANK.NEAR_TERM,
      );
      if (!concrete || !timely) {
        tradePointerNotes.push(cand);
        if (cond) {
          cond.has_available_remedy = false;
          if (!cond.suppression_reasons.includes("NO_MATERIAL_WAIVER_REMEDY")) cond.suppression_reasons.push("NO_MATERIAL_WAIVER_REMEDY");
          if (cond.disposition !== "DEGRADED_EVIDENCE" && cond.disposition !== "SHADOW_DIAGNOSTIC_ONLY") cond.disposition = "WATCH";
          cond.evidence.push({
            specialist: "strategy",
            fact: cand.remedy.note,
            data: {
              suggested_search_mode: cand.remedy.suggested_search_mode,
              target_position: cand.remedy.target_position,
              trade_viability: cand.remedy.trade_viability,
            },
          });
        }
        continue;
      }
    }
    raceable.push(cand);
  }

  // ---- 1. hard gates
  const gated: OrchestratorAction[] = [];
  for (const cand of raceable) {
    const g = applyHardGates(cand, mac, slice);
    if (g.pass) gated.push(cand);
    else {
      suppressed.push({ action: cand, reasons: g.reasons });
      annotateCondition(conditions, cand.target_condition, g.reasons);
    }
  }

  // ---- 2. lexicographic priority
  const scored: Scored[] = gated.map((a) => ({ action: a, key: sortKey(a) }));
  scored.sort((x, y) => cmpKey(x.key, y.key));

  // ---- 3. dominance / suppression (keep at most one non-suppressed remedy per condition)
  const survivors: OrchestratorAction[] = [];
  const claimedConditions = new Set<string>();
  for (const { action } of scored) {
    const dominatedBy = survivors.find((s) => dominates(s, action) && !dominates(action, s));
    if (dominatedBy) {
      const reason: NegativeEvidenceCode =
        dominatedBy.action_class === "LINEUP" ? "DOMINATED_BY_LINEUP" : "DOMINATED_BY_CHEAPER_ACTION";
      suppressed.push({ action, reasons: [reason] });
      annotateCondition(conditions, action.target_condition, [reason]);
      continue;
    }
    if (claimedConditions.has(action.target_condition)) {
      suppressed.push({ action, reasons: ["ACTION_DUPLICATES_OTHER"] });
      continue;
    }
    survivors.push(action);
    claimedConditions.add(action.target_condition);
  }

  // ---- 4. finalise condition dispositions
  for (const c of conditions) {
    if (survivors.some((s) => s.target_condition === c.code)) {
      c.disposition = "ACTIONED";
      c.has_available_remedy = true;
      continue;
    }
    if (c.disposition === "SHADOW_DIAGNOSTIC_ONLY" || c.disposition === "DEGRADED_EVIDENCE") continue;
    if (c.disposition === "NOT_MATERIAL" || c.materiality === "INFORMATIONAL") {
      c.disposition = "NOT_MATERIAL";
      continue;
    }
    // material condition with no surviving remedy
    const hadCandidate = candidates.some((cand) => cand.target_condition === c.code);
    const wasGated = suppressed.some((s) => s.action.target_condition === c.code);
    if (c.materiality === "MATERIAL") {
      c.disposition = hadCandidate || wasGated ? "NO_MATERIAL_REMEDY" : "WATCH";
      if (!c.suppression_reasons.length) c.suppression_reasons.push(hadCandidate ? "NO_MATERIAL_WAIVER_REMEDY" : "CONDITION_NOT_URGENT");
    } else {
      c.disposition = c.urgency === "FUTURE" || c.urgency === "NEAR_TERM" ? "NOT_URGENT" : "WATCH";
    }
  }

  // ---- 5. verdict
  const degraded = requiredEvidenceMissing(mac, slice);
  let verdict: OrchestratorVerdict;
  if (survivors.length > 0) {
    verdict = "ACTION";
  } else if (degraded.insufficient) {
    verdict = "INSUFFICIENT_EVIDENCE";
  } else if (conditions.some((c) => c.disposition === "WATCH" || c.disposition === "NO_MATERIAL_REMEDY" || c.disposition === "NOT_URGENT" || c.disposition === "SHADOW_DIAGNOSTIC_ONLY")) {
    verdict = "WATCH";
  } else {
    verdict = "HOLD";
  }

  // ---- 6. primary + bounded secondary (independent, non-conflicting)
  const primary = survivors[0] ?? null;
  const secondary = survivors
    .slice(1)
    .filter((s) => s.target_condition !== primary?.target_condition)
    .slice(0, MAX_SECONDARY);
  // demote-to-suppressed anything beyond the secondary cap
  for (const extra of survivors.slice(1 + secondary.length)) {
    suppressed.push({ action: extra, reasons: ["ACTION_DUPLICATES_OTHER"] });
  }

  // trade-exploration pointers: record them as considered-but-not-surfaced so
  // "why not a trade?" is answerable (§44) without letting them drive a verdict.
  for (const p of tradePointerNotes) {
    suppressed.push({ action: p, reasons: ["NO_MATERIAL_WAIVER_REMEDY"] });
  }

  // ---- 7. hold rationale (negative evidence supporting HOLD/WATCH)
  const hold_rationale = buildHoldRationale(verdict, conditions, suppressed, slice);

  // ---- 8. result confidence — the primary action's confidence, or the
  //         strongest watch condition's, floored by degradation
  let confidence: PolicyOutcome["confidence"] = primary
    ? primary.dimensions.confidence
    : verdict === "WATCH"
      ? "MEDIUM"
      : "HIGH";
  if (degraded.reasons.length > 0 && confidence === "HIGH") confidence = "MEDIUM";

  const watch_items = conditions.filter(
    (c) => c.disposition === "WATCH" || c.disposition === "NO_MATERIAL_REMEDY" || c.disposition === "NOT_URGENT" || c.disposition === "SHADOW_DIAGNOSTIC_ONLY",
  );

  // dedupe / cap the diagnostics list (keep the first of each class×condition×reason)
  const seen = new Set<string>();
  const compactSuppressed = suppressed
    .filter((s) => {
      const k = `${s.action.action_class}|${s.action.target_condition}|${s.reasons.join(",")}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, 8);

  return {
    verdict,
    primary_action: primary,
    secondary_actions: secondary,
    suppressed_actions: compactSuppressed,
    conditions,
    watch_items,
    hold_rationale,
    confidence,
  };
}

function annotateCondition(conditions: OrchestratorCondition[], code: string, reasons: NegativeEvidenceCode[]): void {
  const c = conditions.find((x) => x.code === code);
  if (!c) return;
  for (const r of reasons) if (!c.suppression_reasons.includes(r)) c.suppression_reasons.push(r);
}

function requiredEvidenceMissing(mac: ManagementAnalysisContext, slice: ManagerAnalysisSlice): { insufficient: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!slice.weekly) reasons.push("weekly_intelligence_unavailable");
  if (!slice.teamState) reasons.push("team_state_unavailable");
  if (!mac.metrics.snapshot_coherent) reasons.push("snapshot_incoherent");
  // INSUFFICIENT only when we cannot even judge the current lineup
  const insufficient = !slice.weekly || !slice.teamState || !mac.metrics.snapshot_coherent;
  return { insufficient, reasons };
}

function buildHoldRationale(
  verdict: OrchestratorVerdict,
  conditions: OrchestratorCondition[],
  suppressed: PolicyOutcome["suppressed_actions"],
  slice: ManagerAnalysisSlice,
): string[] {
  const out: string[] = [];
  if (verdict === "ACTION") return out;

  const lu = slice.weekly?.lineup;
  if (lu && lu.changes_recommended.length === 0 && lu.empty_slots.length === 0 && lu.illegal_situations.length === 0) {
    out.push("ROSTER_ALREADY_OPTIMAL — the current lineup matches the best legal lineup.");
  }
  const waivers = slice.weekly?.waivers;
  if (waivers && waivers.recommendations.every((r) => r.priority === "DO_NOT_ADD") && waivers.considered > 0) {
    out.push("NO_MATERIAL_WAIVER_REMEDY — every waiver candidate fails its drop-cost / net-improvement gate.");
  }
  const rh = slice.rosterHealth;
  if (rh && rh.weekly.fragility.profile === "RESILIENT") {
    out.push("ROSTER_HEALTH_RESILIENT — no concentrated or distributed fragility.");
  }
  for (const s of suppressed) {
    for (const r of s.reasons) {
      const line = `${r} — ${s.action.action_class} for "${s.action.target_problem}" was not surfaced.`;
      if (!out.includes(line)) out.push(line);
    }
  }
  for (const c of conditions) {
    if (c.disposition === "NOT_URGENT" || c.disposition === "NO_MATERIAL_REMEDY") {
      out.push(`${c.code}: ${c.suppression_reasons.join(", ") || c.disposition} — real condition, not actionable now.`);
    }
  }
  if (out.length === 0 && verdict === "HOLD") {
    out.push("No material action or watch condition currently warrants manager attention beyond normal monitoring.");
  }
  return out;
}
