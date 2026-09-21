/**
 * Phase 8 — feature-family x position gate for numeric Football-Intelligence influence on START/SIT.
 *
 *   production baseline
 *     + certified family contribution
 *     x position/decision eligibility x freshness/readiness gate x deployment gate
 *   = final value;   ANY gate fails -> the exact production baseline.
 *
 * This module is the ONLY place that decides whether a family may numerically influence a recommendation.
 * It CONSULTS the Phase 1 freshness evaluator's output (`assessIntelligenceFreshness`) -- it never recomputes
 * freshness. Numeric use is deliberately STRICTER than the evaluator's own START_SIT policy: the evaluator
 * treats START_SIT as low-materiality because FI had no numeric influence when it was written; once a family can
 * move a number, a non-CURRENT evidence state must not.
 *
 * Nothing calls this in production. Nothing is PRODUCTION_ACTIVE. Research results never mutate deployment state.
 */
import type { IntelligenceFreshnessAssessment, IntelligenceFeatureFamily, IntelligenceOperation } from "@/lib/canonical/intelligence-freshness";
import { deploymentContract, fiMayInfluenceProduction, type DeploymentState } from "./deployment";
import type { StartSitModel } from "./translate";
import { certificationAllowsActivation, fiCertifiedState, loadFiCertification, type FiCertification } from "./certification";

export const FI_FAMILY_GATE_VERSION = "fi-family-gate-2026.1";
/** The single consumer a certified family may influence. Waiver/Trade/Matchup/FAAB/roster valuation are different decisions. */
export const FI_NUMERIC_CONSUMER = "START_SIT" as const;

/** Evaluated-state policy: numeric influence requires a CURRENT FI (never PARTIAL_CURRENT/DEGRADED/STALE/INCOMPATIBLE) -- the evaluated lane used complete weeks only. */
export const NUMERIC_USE_ALLOWED_OVERALL_STATUSES = ["CURRENT"] as const;

/** Which independently-tracked freshness families a model family depends on. An unknown family is BLOCKED (fail closed). */
export const FI_FAMILY_FRESHNESS_DEPENDENCIES: Readonly<Record<string, readonly IntelligenceFeatureFamily[]>> = {
  off_pass_epa: ["PBP_TEAM_EFFICIENCY"], off_rush_epa: ["PBP_TEAM_EFFICIENCY"], off_success_rate: ["PBP_TEAM_EFFICIENCY"],
  off_proe: ["PBP_TEAM_EFFICIENCY"], off_pace_sec_play: ["PBP_TEAM_EFFICIENCY"], off_explosive_pass_rate: ["PBP_TEAM_EFFICIENCY"],
  def_success_allowed: ["PBP_TEAM_EFFICIENCY"],
  usage_snap_share: ["SNAP_COUNTS", "PLAYER_USAGE"], usage_target_share: ["PLAYER_USAGE"], usage_rush_share: ["PLAYER_USAGE"],
  usage_route_participation: ["ROUTE_PARTICIPATION", "PLAYER_USAGE"],
  interaction_pass_epa_vs_pass_defense: ["PBP_TEAM_EFFICIENCY", "CONTEXTUAL_MATCHUP"], interaction_rush_epa_vs_rush_defense: ["PBP_TEAM_EFFICIENCY", "CONTEXTUAL_MATCHUP"],
};

/** What a family may do once certified. A certified translation is explicit, deterministic and reversible. */
export interface CertifiedTranslation {
  kind: "TIE_BREAK_ONLY" | "RESIDUAL_ADJUSTMENT";
  unit: "fantasy_points";
  beta: number;
  /** cap on |adjustment| as a fraction of |baseline| */
  cap_fraction: number;
  /** TIE_BREAK_ONLY: FI may reorder two players only when their baseline projections differ by LESS than this. */
  tau: number | null;
  certified_scoring_fingerprints: string[];
  certification_version: string;
  criteria_version: string;
  missing_data: "ZERO_ADJUSTMENT";
}

export type FamilyBlockReason =
  | "MODEL_UNAVAILABLE" | "MODEL_CERTIFICATION_FAILED" | "CONSUMER_SCOPE_NOT_START_SIT"
  | "POSITION_NOT_PRODUCTION_ACTIVE" | "FAMILY_NOT_PRODUCTION_ACTIVE"
  | "NOT_CERTIFIED_PRODUCTION_ELIGIBLE" | "NO_CERTIFIED_TRANSLATION"
  | "FRESHNESS_NOT_PROVIDED" | "FRESHNESS_NOT_CURRENT" | "FRESHNESS_UNUSABLE" | "FRESHNESS_FALLBACK_REQUIRED"
  | "FAMILY_UNKNOWN_DEPENDENCY" | "FAMILY_SOURCE_UNAVAILABLE" | "FAMILY_SOURCE_BROKEN" | "FAMILY_DESCRIPTIVE_ONLY"
  | "SCORING_FINGERPRINT_UNKNOWN" | "SCORING_FINGERPRINT_INCOMPATIBLE" | "TEMPORAL_IDENTITY_UNRESOLVED"
  | "SOURCE_VINTAGE_UNKNOWN" | "SOURCE_VINTAGE_AFTER_DECISION";

export interface FamilyGateContext {
  operation: IntelligenceOperation;
  /** the canonical Phase 1 assessment for this request (built once per request and shared). */
  freshness: IntelligenceFreshnessAssessment | null;
  scoring_fingerprint: string | null;
  /** Phase 7: team/opponent for this player-game are chronology-safe (resolved, not ambiguous/conflicting/unknown). */
  temporal_membership_resolved: boolean;
  /** the week being decided and the FI snapshot's through-week. FI must not contain information from the decision week onward. */
  decision_week: number | null;
  fi_through_week: number | null;
}

export interface FamilyGateDecision {
  family: string; position: string; allowed: boolean; reasons: FamilyBlockReason[];
  family_state: DeploymentState; certified_state: DeploymentState;
  freshness_dependencies: Array<{ family: IntelligenceFeatureFamily; availability: string; lag_classification: string; ok: boolean }>;
  gate_version: typeof FI_FAMILY_GATE_VERSION;
}

/** family x position state. Unconfigured => SHADOW_ONLY. NEVER inherited from the whole-model or position state. */
export function familyDeploymentState(model: StartSitModel | null, family: string, position: string): DeploymentState {
  return deploymentContract(model).family_positions?.[position]?.[family] ?? "SHADOW_ONLY";
}
export function certifiedTranslationFor(model: StartSitModel | null, family: string, position: string): CertifiedTranslation | null {
  const t = deploymentContract(model).certified_translations?.[position]?.[family] as CertifiedTranslation | undefined;
  return t && typeof t.beta === "number" && typeof t.cap_fraction === "number" ? t : null;
}

export function evaluateFamilyGate(model: StartSitModel | null, family: string, position: string, ctx: FamilyGateContext, cert: FiCertification | null = loadFiCertification()): FamilyGateDecision {
  const reasons: FamilyBlockReason[] = [];
  const contract = deploymentContract(model);
  const family_state = familyDeploymentState(model, family, position);
  const certified_state = fiCertifiedState(family, position, cert);
  const deps: FamilyGateDecision["freshness_dependencies"] = [];

  if (!model) reasons.push("MODEL_UNAVAILABLE");
  if (contract.deployment === "CERTIFICATION_FAILED") reasons.push("MODEL_CERTIFICATION_FAILED");
  if (ctx.operation !== FI_NUMERIC_CONSUMER) reasons.push("CONSUMER_SCOPE_NOT_START_SIT");
  if (!fiMayInfluenceProduction(model, position)) reasons.push("POSITION_NOT_PRODUCTION_ACTIVE");
  if (family_state !== "PRODUCTION_ACTIVE") reasons.push("FAMILY_NOT_PRODUCTION_ACTIVE");
  if (!certificationAllowsActivation(certified_state)) reasons.push("NOT_CERTIFIED_PRODUCTION_ELIGIBLE");
  const translation = certifiedTranslationFor(model, family, position);
  if (!translation) reasons.push("NO_CERTIFIED_TRANSLATION");

  // ---- freshness: consult the canonical assessment; never recompute -------------------------------------------
  const fr = ctx.freshness;
  if (!fr) reasons.push("FRESHNESS_NOT_PROVIDED");
  else {
    if (!(NUMERIC_USE_ALLOWED_OVERALL_STATUSES as readonly string[]).includes(fr.overall_status)) reasons.push("FRESHNESS_NOT_CURRENT");
    if (!fr.usable) reasons.push("FRESHNESS_UNUSABLE");
    if (fr.fallback_required) reasons.push("FRESHNESS_FALLBACK_REQUIRED");
    const need = FI_FAMILY_FRESHNESS_DEPENDENCIES[family];
    if (!need) reasons.push("FAMILY_UNKNOWN_DEPENDENCY");
    else for (const dep of need) {
      const s = fr.feature_families.find((f) => f.family === dep);
      const ok = !!s && s.availability === "AVAILABLE" && (s.lag_classification === "AT_CUTOFF" || s.lag_classification === "EXPECTED_SOURCE_LAG") && s.predictive_eligibility !== "DESCRIPTIVE_ONLY" && s.predictive_eligibility !== "NOT_ELIGIBLE";
      deps.push({ family: dep, availability: s?.availability ?? "MISSING", lag_classification: s?.lag_classification ?? "MISSING", ok });
      if (!s || s.availability !== "AVAILABLE") reasons.push("FAMILY_SOURCE_UNAVAILABLE");
      else if (s.lag_classification === "BROKEN_OR_MISSING_DATA" || s.lag_classification === "UNAVAILABLE") reasons.push("FAMILY_SOURCE_BROKEN");
      else if (s.predictive_eligibility === "DESCRIPTIVE_ONLY" || s.predictive_eligibility === "NOT_ELIGIBLE") reasons.push("FAMILY_DESCRIPTIVE_ONLY");
    }
  }

  // ---- scoring contract (Phase 6), temporal identity (Phase 7), source vintage ---------------------------------
  if (!ctx.scoring_fingerprint) reasons.push("SCORING_FINGERPRINT_UNKNOWN");
  else if (translation && !translation.certified_scoring_fingerprints.includes(ctx.scoring_fingerprint)) reasons.push("SCORING_FINGERPRINT_INCOMPATIBLE");
  if (!ctx.temporal_membership_resolved) reasons.push("TEMPORAL_IDENTITY_UNRESOLVED");
  if (ctx.decision_week == null || ctx.fi_through_week == null) reasons.push("SOURCE_VINTAGE_UNKNOWN");
  else if (ctx.fi_through_week > ctx.decision_week - 1) reasons.push("SOURCE_VINTAGE_AFTER_DECISION");

  const uniq = [...new Set(reasons)];
  return { family, position, allowed: uniq.length === 0, reasons: uniq, family_state, certified_state, freshness_dependencies: deps, gate_version: FI_FAMILY_GATE_VERSION };
}

/** true only when NO gate blocks. The single answer to "may this family numerically influence this recommendation?". */
export function fiFamilyMayInfluenceProduction(model: StartSitModel | null, family: string, position: string, ctx: FamilyGateContext, cert?: FiCertification | null): boolean {
  return evaluateFamilyGate(model, family, position, ctx, cert).allowed;
}

/* ------------------------------ bounded, deterministic translation ------------------------------ */

const fin = (x: number): number => (Number.isFinite(x) ? x : 0);

/** Bounded adjustment for one player. Any non-finite/missing input yields 0 (baseline-equivalent) -- never NaN/Infinity, never a silent full adjustment. */
export function boundedAdjustment(baseline: number | null, signal: number | null, t: CertifiedTranslation): number {
  if (baseline == null || !Number.isFinite(baseline) || signal == null || !Number.isFinite(signal) || !Number.isFinite(t.beta) || !Number.isFinite(t.cap_fraction)) return 0;
  const cap = Math.abs(t.cap_fraction) * Math.abs(baseline);
  const adj = fin(t.beta * signal);
  return Math.max(-cap, Math.min(cap, adj));
}

/**
 * TIE_BREAK_ONLY comparator: FI may reorder two players ONLY when their baseline projections differ by less than tau.
 * Returns which player to start ("A" | "B" | "TIE"). A huge FI signal can never overturn a baseline edge >= tau.
 */
export function startSitPick(baselineA: number, adjA: number, baselineB: number, adjB: number, t: Pick<CertifiedTranslation, "tau">): "A" | "B" | "TIE" {
  const edge = baselineA - baselineB;
  const useFi = t.tau != null && Number.isFinite(t.tau) && Math.abs(edge) < t.tau;
  const a = baselineA + (useFi ? fin(adjA) : 0), b = baselineB + (useFi ? fin(adjB) : 0);
  return a > b ? "A" : a < b ? "B" : "TIE";
}
