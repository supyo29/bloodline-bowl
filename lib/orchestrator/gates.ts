/**
 * Phase 8 §17 — hard gates. A candidate action FAILS CLOSED here if it is
 * illegal, targets an unavailable player, rests on unresolved roster state,
 * derives solely from SHADOW_ONLY evidence, fails its domain materiality gate,
 * or the snapshot is stale / a required specialist failed.
 *
 * A gated-out candidate does not disappear silently — the caller records it in
 * `suppressed_actions` and may raise a `WATCH` condition instead.
 */

import type { ManagerAnalysisSlice, ManagementAnalysisContext } from "./context";
import type { NegativeEvidenceCode, OrchestratorAction } from "./schema";

export interface GateResult {
  pass: boolean;
  reasons: NegativeEvidenceCode[];
}

const PASS: GateResult = { pass: true, reasons: [] };

/** §18 materiality — reuse each specialist's OWN decision gate; no global +1.0 threshold. */
function materialityGate(action: OrchestratorAction): GateResult {
  const eff = action.dimensions.expected_weekly_effect?.value ?? null;
  switch (action.action_class) {
    case "LINEUP": {
      const r = action.remedy;
      if (r.kind === "LINEUP" && r.ir_move) return PASS; // IR move materiality is structural, not points
      if (r.kind === "LINEUP" && r.changes.length === 0 && !r.ir_move) return { pass: false, reasons: ["ROSTER_ALREADY_OPTIMAL"] };
      // structural defect fixes always pass; point-gain swaps use the lineup engine's own bands
      if (action.target_condition === "LINEUP_STRUCTURAL_DEFECT" || action.target_condition === "STARTER_ON_BYE") return PASS;
      if (eff == null) return { pass: false, reasons: ["SPECIALIST_CONFIDENCE_DEGRADED"] };
      if (eff < 1.25) return { pass: false, reasons: ["IMPROVEMENT_BELOW_MATERIALITY"] };
      return PASS;
    }
    case "WAIVER": {
      // the waiver engine already filtered DO_NOT_ADD (net < MIN_NET_TO_RECOMMEND)
      // and assigned HIGH / MEDIUM / LOW. HIGH/MEDIUM are engine-vetted as
      // material. A LOW-priority waiver is marginal — it only clears the
      // Orchestrator's action bar with a resolved effect of at least ~1.5 pts.
      const r = action.remedy;
      if (r.kind !== "WAIVER") return PASS;
      if (r.waiver_engine_priority === "HIGH" || r.waiver_engine_priority === "MEDIUM") return PASS;
      if (eff != null && eff >= 1.5) return PASS;
      return { pass: false, reasons: ["IMPROVEMENT_BELOW_MATERIALITY"] };
    }
    case "TRADE_EXPLORATION": {
      const r = action.remedy;
      if (r.kind === "TRADE_EXPLORATION" && r.trade_viability === "NON_VIABLE") return { pass: false, reasons: ["NO_VIABLE_TRADE_PATH"] };
      return PASS;
    }
    default:
      return PASS;
  }
}

/** §11 — a candidate whose ONLY evidence is a SHADOW_ONLY specialist cannot be an ACTION. */
function shadowGate(action: OrchestratorAction): GateResult {
  const sources = new Set(action.explanation_chain.map((e) => e.specialist));
  sources.add(action.originating_specialist);
  const nonShadow = [...sources].filter((s) => s !== "start_sit_shadow" && s !== "matchup_shadow");
  if (nonShadow.length === 0) return { pass: false, reasons: ["SHADOW_ONLY_EVIDENCE"] };
  return PASS;
}

/** legality / availability. */
function legalityGate(action: OrchestratorAction, slice: ManagerAnalysisSlice): GateResult {
  const ts = slice.teamState;
  const r = action.remedy;
  if (r.kind === "LINEUP") {
    if (r.ir_move) {
      const p = ts?.roster.players.find((x) => x.canonical_player_id === r.ir_move!.player_id);
      if (!p) return { pass: false, reasons: ["ILLEGAL_OR_UNAVAILABLE"] };
      return PASS;
    }
    // the frozen optimiser already produced only legal changes; sanity-check ids resolve
    for (const c of r.changes) {
      if (c.start_player_id && ts && !ts.roster.all_players.includes(c.start_player_id)) {
        return { pass: false, reasons: ["ILLEGAL_OR_UNAVAILABLE"] };
      }
    }
    return PASS;
  }
  if (r.kind === "WAIVER") {
    // the waiver engine only offers players from ctx.availability; sanity-check
    // the add is not already on this roster and the drop is.
    if (ts) {
      if (ts.roster.all_players.includes(r.add_player_id)) return { pass: false, reasons: ["ILLEGAL_OR_UNAVAILABLE"] };
      if (r.drop_player_id && !ts.roster.all_players.includes(r.drop_player_id)) return { pass: false, reasons: ["ILLEGAL_OR_UNAVAILABLE"] };
    }
    return PASS;
  }
  return PASS; // TRADE_EXPLORATION is a pointer — no transaction to legality-check
}

/** unresolved roster state / degraded evidence beyond safe use. */
function evidenceGate(action: OrchestratorAction, slice: ManagerAnalysisSlice): GateResult {
  const ts = slice.teamState;
  if (ts) {
    // never recommend acting on an unresolved-identity player
    const unresolved = new Set(ts.roster.players.filter((p) => p.identity_unresolved).map((p) => p.canonical_player_id));
    const r = action.remedy;
    if (r.kind === "LINEUP") {
      if (r.changes.some((c) => unresolved.has(c.start_player_id) || (c.sit_player_id && unresolved.has(c.sit_player_id)))) {
        return { pass: false, reasons: ["ILLEGAL_OR_UNAVAILABLE"] };
      }
    }
    if (r.kind === "WAIVER" && r.drop_player_id && unresolved.has(r.drop_player_id)) {
      return { pass: false, reasons: ["ILLEGAL_OR_UNAVAILABLE"] };
    }
  }
  // an action whose evidence confidence floor is LOW is not blocked, but a
  // LINEUP point-gain swap that is PROVISIONAL and below 3 pts is too weak.
  if (
    action.action_class === "LINEUP" &&
    action.target_condition === "LINEUP_SUBOPTIMAL" &&
    action.dimensions.evidence_confidence.specialist_confidence.includes("PROVISIONAL") &&
    (action.dimensions.expected_weekly_effect?.value ?? 0) < 3
  ) {
    return { pass: false, reasons: ["SPECIALIST_CONFIDENCE_DEGRADED"] };
  }
  return PASS;
}

/** required-specialist / freshness gate. */
function requiredSpecialistGate(action: OrchestratorAction, mac: ManagementAnalysisContext, slice: ManagerAnalysisSlice): GateResult {
  if (!mac.metrics.snapshot_coherent) return { pass: false, reasons: ["STALE_SNAPSHOT"] };
  if (action.action_class === "LINEUP" && !slice.weekly?.lineup) return { pass: false, reasons: ["REQUIRED_SPECIALIST_UNAVAILABLE"] };
  if (action.action_class === "WAIVER" && !slice.weekly?.waivers) return { pass: false, reasons: ["REQUIRED_SPECIALIST_UNAVAILABLE"] };
  if (action.action_class === "TRADE_EXPLORATION" && !mac.tradeCtx) return { pass: false, reasons: ["REQUIRED_SPECIALIST_UNAVAILABLE"] };
  return PASS;
}

export function applyHardGates(action: OrchestratorAction, mac: ManagementAnalysisContext, slice: ManagerAnalysisSlice): GateResult {
  for (const gate of [
    () => requiredSpecialistGate(action, mac, slice),
    () => legalityGate(action, slice),
    () => evidenceGate(action, slice),
    () => shadowGate(action),
    () => materialityGate(action),
  ]) {
    const r = gate();
    if (!r.pass) return r;
  }
  return PASS;
}
