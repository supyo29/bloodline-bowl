/**
 * Phase 4 (Checkpoint G) — the EVALUATION SUITE, defined BEFORE any weight is fit (spec §28), plus the audit of which
 * historical evidence is usable. It scores DECISIONS (add + drop + cost vs alternatives), not fantasy points alone.
 * Nothing here fits or tunes a parameter. Only records whose evidence class is TRUE_AS_OF_HISTORY (a LIVE_CAPTURED
 * capture with an attached outcome) may be scored; every other class is refused with the reason.
 */
export type HistoricalEvidenceClass = "TRUE_AS_OF_HISTORY" | "RECONSTRUCTABLE_AS_OF" | "RETROSPECTIVE_ONLY" | "UNSAFE_FOR_BACKTEST";
export interface EvidenceAudit { input: string; class: HistoricalEvidenceClass; reason: string; usable_for_backtest: boolean }

/** The audit of what actually exists today (Phase 4 finding). */
export function auditHistoricalEvidence(): EvidenceAudit[] {
  const a = (input: string, c: HistoricalEvidenceClass, reason: string): EvidenceAudit => ({ input, class: c, reason, usable_for_backtest: c === "TRUE_AS_OF_HISTORY" });
  return [
    a("free-agent pool at decision time", "UNSAFE_FOR_BACKTEST", "the pool has never been preserved and is not materialized today; alternatives and regret would have to be fabricated"),
    a("candidate ranking at decision time", "UNSAFE_FOR_BACKTEST", "Waiver 2.0 did not exist at those times; recomputing it now on today's evidence is retrospective, not as-of"),
    a("manager roster at decision time", "RECONSTRUCTABLE_AS_OF", "replayable from canonical transactions only inside the visible window; not a captured state"),
    a("FAAB budgets / waiver priority at decision time", "RECONSTRUCTABLE_AS_OF", "derivable from transactions only where every bid is visible"),
    a("Role / OPP / FI evidence at decision time", "RECONSTRUCTABLE_AS_OF", "only the preserved immutable history snapshots (2026 week 1) — one week for Role and FI"),
    a("realized claims (who was actually added/dropped, winning bids)", "RETROSPECTIVE_ONLY", "visible in recent transactions but says nothing about the alternatives that were available"),
    a("subsequent player production / role", "RETROSPECTIVE_ONLY", "observed later; valid only as an OUTCOME attached to a pristine capture"),
    a("Waiver 2.0 LIVE_CAPTURED weekly records with attached outcomes", "TRUE_AS_OF_HISTORY", "captured before the outcome, content-addressed and immutable — the only backtest-grade evidence (none exists yet)"),
  ];
}

export interface DecisionOutcome {
  decision_id: string; evidence_class: HistoricalEvidenceClass; archetype: string | null; role_persisted_points_at_decision: number;
  chosen_points_started: number; drop_points_lost: number; best_alternative_points_started: number | null; role_share_change: number | null;
  faab_spent: number | null; starter_slot_improvement: number; replacement_level_points: number; weeks_held: number; drop_regret_points: number | null;
}
export interface SuiteResult { scored: number; refused: Array<{ decision_id: string; reason: string }>; metrics: Record<string, number | null>; definitions: Record<string, string> }
export const METRIC_DEFINITIONS: Record<string, string> = {
  net_roster_value: "mean(chosen points started − dropped player's points lost)",
  starter_improvement: "mean weekly lineup improvement attributable to the add",
  replacement_value_gain: "mean(chosen points started − replacement-level points × weeks held)",
  breakout_identification: "share of ROLE_GROWTH_BREAKOUT decisions whose role share rose afterwards",
  false_breakout_avoidance: "share of role-unsupported (FLUKE_RISK) decisions that were NOT taken, or whose role share did not rise (lower is worse)",
  drop_regret: "mean(points the dropped player later produced that the roster could have used) — lower is better",
  faab_efficiency: "mean(net roster value per FAAB dollar) over paid claims",
  opportunity_per_faab: "mean(role-share change per FAAB dollar) over paid claims",
  alternative_regret: "mean(best alternative's points started − chosen points started) — lower is better",
};
const mean = (a: number[]): number | null => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
export function scoreDecisions(d: DecisionOutcome[]): SuiteResult {
  const refused = d.filter((x) => x.evidence_class !== "TRUE_AS_OF_HISTORY").map((x) => ({ decision_id: x.decision_id, reason: `${x.evidence_class}: not backtest-grade evidence` })); const ok = d.filter((x) => x.evidence_class === "TRUE_AS_OF_HISTORY");
  const paid = ok.filter((x) => (x.faab_spent ?? 0) > 0); const brk = ok.filter((x) => x.archetype === "ROLE_GROWTH_BREAKOUT"); const fl = ok.filter((x) => x.archetype === "FLUKE_RISK");
  const nrv = (x: DecisionOutcome) => x.chosen_points_started - x.drop_points_lost;
  return { scored: ok.length, refused, definitions: METRIC_DEFINITIONS, metrics: {
    net_roster_value: mean(ok.map(nrv)), starter_improvement: mean(ok.map((x) => x.starter_slot_improvement)), replacement_value_gain: mean(ok.map((x) => x.chosen_points_started - x.replacement_level_points * x.weeks_held)),
    breakout_identification: brk.length ? brk.filter((x) => (x.role_share_change ?? 0) > 0).length / brk.length : null, false_breakout_avoidance: fl.length ? fl.filter((x) => (x.role_share_change ?? 0) <= 0).length / fl.length : null,
    drop_regret: mean(ok.map((x) => x.drop_regret_points).filter((x): x is number => x != null)), faab_efficiency: mean(paid.map((x) => nrv(x) / x.faab_spent!)), opportunity_per_faab: mean(paid.filter((x) => x.role_share_change != null).map((x) => x.role_share_change! / x.faab_spent!)),
    alternative_regret: mean(ok.map((x) => (x.best_alternative_points_started == null ? null : x.best_alternative_points_started - x.chosen_points_started)).filter((x): x is number => x != null)),
  } };
}
