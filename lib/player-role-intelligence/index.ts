/**
 * Player Role & Opportunity Intelligence — public surface (Phase 2,
 * Checkpoint D). Deployment state: SHARED_CONTEXT. Descriptive/analytical
 * consumption only -- never eligible to influence a production numeric
 * recommendation (waivers, Start/Sit, matchup, trades, projections).
 */
export * from "./schema";
export { loadRoleOpportunitySnapshot, __resetRoleOpportunityCache, validateRoleOpportunitySnapshot, type RoleOpportunitySnapshot } from "./read";
export { buildRoleOpportunityIntelligenceLineage } from "./lineage";
export { formatPlayerRoleProfile, formatRoleChangeEvent, formatRoleOpportunityLineage } from "./format";
