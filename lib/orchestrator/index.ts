/**
 * Phase 8 — Team Management Orchestrator (Scope 2, ADVISORY_ONLY).
 *
 * Coordinates and prioritises the frozen Phase 1–7 specialists into a
 * `HOLD` / `WATCH` / `ACTION` management assessment. Adds NO projection,
 * valuation, or simulation model. Executes NOTHING
 * (`orchestratorMayExecuteTransactions()` is always `false`) and mutates NO
 * specialist. See docs/TEAM_MANAGEMENT_PHASE_8_ORCHESTRATOR.md.
 */

export * from "./schema";
export {
  buildManagementAnalysisContext,
  managerSlugsOf,
  type ManagementAnalysisContext,
  type ManagementAnalysisOptions,
  type ManagerAnalysisSlice,
} from "./context";
export { orchestrateManager, buildManagerOrchestration, buildLeagueOrchestration } from "./build";
export { buildOrchestratorTrace, type OrchestratorTrace } from "./trace";
export { deriveConditions, aggregateConditions } from "./conditions";
export { lineupCandidates, waiverCandidates, tradeExplorationCandidates } from "./candidates";
export { applyHardGates } from "./gates";
export { runPolicy, type PolicyOutcome } from "./policy";
export {
  getOrchestratorCaptureStore,
  setOrchestratorCaptureStore,
  toDecisionRecord,
  MemoryCaptureStore,
} from "./capture";
