/**
 * Phase 4 — the Waiver Intelligence 2.0 LIFECYCLE contract. One explicit state; ONLY `PRODUCTION_ACTIVE` may ever influence
 * production waiver ranking. The state is a reviewed constant in this file — no evaluation result, evidence gate, capture,
 * count or threshold can change it. A transition is a pure function that demands a recorded HUMAN approval and moves at most
 * one step; nothing in the runtime calls it. The current model is below production: SHADOW_ONLY.
 */
export type Waiver2LifecycleState = "SHADOW_ONLY" | "RESEARCH_ELIGIBLE" | "CERTIFICATION_PASSED" | "PRODUCTION_ELIGIBLE" | "PRODUCTION_ACTIVE" | "SUSPENDED_ROLLED_BACK";
export const LIFECYCLE_ORDER: Waiver2LifecycleState[] = ["SHADOW_ONLY", "RESEARCH_ELIGIBLE", "CERTIFICATION_PASSED", "PRODUCTION_ELIGIBLE", "PRODUCTION_ACTIVE"];

/** THE state of the shipped model. Changing it is a reviewed code change plus an explicit deployment decision. */
export const WAIVER2_LIFECYCLE_STATE = "SHADOW_ONLY" as Waiver2LifecycleState;
export const mayInfluenceProduction = (s: Waiver2LifecycleState = WAIVER2_LIFECYCLE_STATE): boolean => s === "PRODUCTION_ACTIVE";
/** the deployment vocabulary Book-Ready understands; every non-active state is SHADOW_ONLY there */
export const bookReadyDeploymentState = (s: Waiver2LifecycleState = WAIVER2_LIFECYCLE_STATE): "SHADOW_ONLY" | "PRODUCTION_ACTIVE" => (s === "PRODUCTION_ACTIVE" ? "PRODUCTION_ACTIVE" : "SHADOW_ONLY");

export interface HumanApproval { approved_by: string; approved_at: string; review_document: string; evidence_gate_status: string; notes: string }
export type TransitionResult = { ok: true; from: Waiver2LifecycleState; to: Waiver2LifecycleState } | { ok: false; refused: string };

/** Pure and unused by the runtime. One step forward at most, always with a human approval; rollback to SUSPENDED is always allowed. */
export function requestTransition(from: Waiver2LifecycleState, to: Waiver2LifecycleState, approval: HumanApproval | null): TransitionResult {
  if (to === "SUSPENDED_ROLLED_BACK") return { ok: true, from, to };
  if (!approval || !approval.approved_by.trim() || !approval.review_document.trim()) return { ok: false, refused: "a promotion requires a recorded human approval with a review document; no automatic promotion exists" };
  const a = LIFECYCLE_ORDER.indexOf(from === "SUSPENDED_ROLLED_BACK" ? "SHADOW_ONLY" : from), b = LIFECYCLE_ORDER.indexOf(to);
  if (b < 0 || a < 0) return { ok: false, refused: `unknown state ${to}` };
  if (b !== a + 1) return { ok: false, refused: `transitions move exactly one step (${from} -> ${LIFECYCLE_ORDER[a + 1] ?? "none"}); ${to} is not allowed` };
  if (to === "RESEARCH_ELIGIBLE" && !/^(MINIMUM|PREFERRED)_/.test(approval.evidence_gate_status)) return { ok: false, refused: "RESEARCH_ELIGIBLE requires the prospective evidence gate to have met at least its MINIMUM threshold" };
  if (to === "PRODUCTION_ACTIVE" && from !== "PRODUCTION_ELIGIBLE") return { ok: false, refused: "PRODUCTION_ACTIVE is only reachable from PRODUCTION_ELIGIBLE" };
  return { ok: true, from, to };
}

/** Documented, NOT executable: what must be true before anyone may even propose PRODUCTION_ELIGIBLE. */
export const ACTIVATION_REQUIREMENTS: string[] = [
  "a certified free-agent pool (a canonical market-state snapshot with no BLOCKING readiness reason; see lib/market-state)",
  "a sufficient pristine prospective sample (evidence gate at its PREFERRED threshold), not the minimum",
  "completed outcomes for the counted decisions",
  "validated manager-specific gain over the production waiver engine on those outcomes",
  "validated drop-cost behavior (drop regret bounded)",
  "FAAB calibration against real winning bids (the priors are currently uncalibrated)",
  "false-positive / false-breakout control on the archetypes",
  "regret analysis versus the alternatives that were actually available",
  "position-level stability (no position carrying the result)",
  "scoring-format robustness across the leagues' fingerprints",
  "acceptable large-loss behavior",
  "an explicit, human-reviewed deployment transition through requestTransition with a written review document",
];
