/**
 * Phase 4 — Football Intelligence Start/Sit translation (SHADOW_ONLY).
 *
 * Deployment status is SHADOW_ONLY: the certified FI layer did not add
 * out-of-sample start/sit decision value over the production (RotoWire-backed)
 * baseline for any position — see docs/TEAM_MANAGEMENT_PHASE_4.md. This module
 * computes the comparison; it does not alter any production recommendation.
 *
 * Part A (remediation): `deployment.ts` is the explicit deployment-state
 * contract; `production-gate.ts` is the single gated integration point.
 * Part C: `reevaluation.ts` is the dormant, evidence-gated 2026 re-cert reader.
 */
export * from "./schema";
export {
  loadStartSitModel,
  translateFiAdjustment,
  __resetStartSitModelCache,
  type StartSitModel,
  type TranslateInput,
} from "./translate";
export { buildStartSitShadow } from "./shadow";
export {
  DEPLOYMENT_LIFECYCLE,
  PRODUCTION_INFLUENCE_STATE,
  deploymentContract,
  positionDeploymentState,
  fiMayInfluenceProduction,
  anyFiProductionInfluence,
  isValidTransition,
  type DeploymentState,
  type DeploymentContract,
} from "./deployment";
export { applyFiToProductionBatch, type ProductionGateResult } from "./production-gate";
export {
  loadReevaluationManifest,
  reevaluationStatus,
  isEligible as reevaluationEligible,
  nextCandidateVersion,
  __resetReevaluationCache,
  type ReevaluationManifest,
  type ReevaluationStatus,
} from "./reevaluation";
export {
  NullCaptureStore,
  FileCaptureStore,
  setShadowCaptureStore,
  getShadowCaptureStore,
  captureShadowDecision,
  type ShadowCaptureStore,
  type ShadowDecisionRecord,
  type CaptureKind,
} from "./capture";
