/**
 * Phase 6 — Roster Health Intelligence (Scope 3, SHARED_CONTEXT).
 *
 * A shared evaluative context: roster fragility / depth quality / player
 * dependency / quality surplus / snapshot health-deltas, derived from Phase 2
 * Team-State facts + production projections + the existing replacement
 * framework + the frozen `buildOptimalLineup`. It is NOT a recommendation and
 * NOT wired into any trade / waiver / lineup / start-sit / matchup score.
 * See docs/TEAM_MANAGEMENT_PHASE_6.md.
 */
export * from "./schema";
export { buildRosterHealthContext } from "./build";
export { rosterHealthDelta } from "./delta";
export { buildRosterHealthInputs, type RosterHealthInputs, type RosterHealthInputOptions } from "./inputs";
export { evaluateHorizon } from "./evaluate";
export {
  bestLegalLineup,
  contingency,
  horizonBatch,
  rosterWithout,
  type LineupValue,
  type ContingencyResult,
} from "./contingency";
