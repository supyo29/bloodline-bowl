/**
 * Phase 5 — Matchup Intelligence (SHADOW_ONLY, Scope 2).
 *
 * Calibrated score distributions + win probability + degradation vector +
 * scenario explanations + shadow decision-leverage diagnostics, computed
 * alongside the untouched production `buildMatchup`. NO production
 * recommendation, lineup, or objective is changed. There is no
 * `MAX_WIN_PROBABILITY` objective. See docs/TEAM_MANAGEMENT_PHASE_5.md.
 */
export * from "./schema";
export { buildMatchupIntelligence } from "./build";
export {
  loadDistributionModel,
  __resetDistributionModelCache,
  playerSampler,
  type DistributionModel,
} from "./distributions";
export {
  loadCorrelationModel,
  __resetCorrelationModelCache,
  type CorrelationModel,
} from "./correlations";
export { simulateMatchup, type SimPlayer, type SimOutput, type SimInput } from "./simulator";
export {
  MATCHUP_LIFECYCLE,
  matchupDeploymentContract,
  matchupMayInfluenceProduction,
  isValidMatchupTransition,
  type MatchupDeploymentContract,
} from "./deployment";
export { buildDegradation } from "./confidence";
