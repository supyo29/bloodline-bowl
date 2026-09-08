/**
 * Phase 4 — Football Intelligence Start/Sit translation (SHADOW_ONLY).
 *
 * Deployment status is SHADOW_ONLY: the certified FI layer did not add
 * out-of-sample start/sit decision value over the production (RotoWire-backed)
 * baseline for any position — see docs/TEAM_MANAGEMENT_PHASE_4.md. This module
 * computes the comparison; it does not alter any production recommendation.
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
