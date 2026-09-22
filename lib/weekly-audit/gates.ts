/**
 * Phase 9 Steps 38-41 — prospective-gate MONITORING. Phase 9 is a READER of each system's own certified gate; it
 * never introduces a new threshold and never performs a promotion. `matchup2EvidenceGate` / `waiver2EvidenceGate`
 * are the real Phase 5/Waiver2 functions, called verbatim. The FI re-certification trigger below reads Phase 8's
 * committed certification artifact and the Phase 8 prospective-gate numbers that were pre-registered THERE
 * (`analysis/football_intel_phase8/certification_criteria.json`: >= 4 qualifying weeks, >= 150 live decisions per
 * candidate across >= 3 weeks) — reproduced here as read-only constants, never redefined.
 */
import type { FiRetestProgress } from "./contract";
import type { FiCertification } from "@/lib/weekly/start-sit-fi/certification";

/** Reproduced verbatim from Phase 8's pre-registered criteria (`fi-recert-criteria-2026.1`, `prospective_gate`). Read-only; Phase 9 does not alter it. */
export const FI_PROSPECTIVE_GATE = { required_qualifying_weeks: 4, required_decisions_per_candidate: 150, required_distinct_weeks_represented: 3 } as const;

/**
 * For each certified candidate (all 30 are CERTIFICATION_FAILED — Phase 8's verdict is preserved, never
 * reinterpreted here), reports prospective-evidence progress toward the FI_PROSPECTIVE_GATE. `RETEST_READY` is
 * only ever a SIGNAL for a future, separately-scoped re-certification task — this function cannot and does not
 * change `evaluated_state`.
 */
export function fiRetestProgress(cert: FiCertification | null, qualifyingWeeks: number, liveDecisionsByFamilyPosition: ReadonlyMap<string, { count: number; weeks: Set<number> }>): FiRetestProgress[] {
  if (!cert) return [];
  return cert.candidates.map((c) => {
    const key = `${c.position}|${c.family}`;
    const d = liveDecisionsByFamilyPosition.get(key) ?? { count: 0, weeks: new Set<number>() };
    const met = qualifyingWeeks >= FI_PROSPECTIVE_GATE.required_qualifying_weeks && d.count >= FI_PROSPECTIVE_GATE.required_decisions_per_candidate && d.weeks.size >= FI_PROSPECTIVE_GATE.required_distinct_weeks_represented;
    return { family: c.family, position: c.position, certification_state: c.evaluated_state, qualifying_weeks: qualifyingWeeks, live_decisions: d.count,
      required_weeks: FI_PROSPECTIVE_GATE.required_qualifying_weeks, required_decisions: FI_PROSPECTIVE_GATE.required_decisions_per_candidate,
      retest_signal: met ? "RETEST_READY" : "RETEST_NOT_READY" };
  });
}

/** Phase 9 never promotes: this is the explicit negative-result-durability test surface (Step 10, gate 12). */
export function assertNoAutoPromotion(progress: readonly FiRetestProgress[]): void {
  for (const p of progress) if (p.certification_state !== "CERTIFICATION_FAILED" && p.certification_state !== "SHADOW_ONLY") throw new Error(`unexpected certification_state ${p.certification_state} for ${p.position}/${p.family} — Phase 9 must never write this field`);
}

export { matchup2EvidenceGate, MATCHUP2_EVIDENCE_THRESHOLDS } from "@/lib/matchup2/capture";
export { waiver2EvidenceGate, WAIVER2_EVIDENCE_THRESHOLDS } from "@/lib/waiver2/capture";
