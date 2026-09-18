/**
 * Injury -> Opportunity Propagation Intelligence — public surface (Phase 3,
 * Checkpoint D). Deployment state: SHADOW_ONLY,
 * eligible_to_influence_production: false. Predictive/analytical
 * consumption only -- never eligible to influence a production numeric
 * recommendation (waivers, Start/Sit, matchup, trades, projections).
 */
export * from "./schema";
export { loadOpportunityPropagationModel, validateOpportunityPropagationModel, __resetOpportunityPropagationCache } from "./read";
export { allocateHierarchical, lookupInheritanceRate, trendMultiplier, MUTUALLY_EXHAUSTIVE_DIMENSIONS, type CandidateInput, type CandidatePrediction } from "./model";
export { evaluateOpportunityPropagationScenario } from "./scenario";
export { buildOpportunityPropagationIntelligenceLineage } from "./lineage";
export { formatOpportunityPropagationScenario } from "./format";
